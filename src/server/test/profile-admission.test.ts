import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { createProfilePasskeys } from '../profile-passkeys.ts';
import { createNote } from '../notes.ts';
import { createImportDiagnostics } from '../import-diagnostics.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';

const origin = 'http://localhost:3001',
  session = 'fictional-admission-session';
const credential = {
  id: 'ZmljdGlvbmFs',
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 0,
  transports: ['internal'],
};
async function enrolled(t: Parameters<typeof vaultFixture>[0]) {
  const f = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(f.manager);
  let verificationCalls = 0;
  const passkeys = createProfilePasskeys(f.manager, {
    async verifyRegistrationResponse() {
      return { verified: true, registrationInfo: { credential } };
    },
    async verifyAuthenticationResponse() {
      verificationCalls++;
      return { verified: true, authenticationInfo: { newCounter: verificationCalls } };
    },
  });
  const prf = randomBytes(32).toString('base64url');
  const registration = await passkeys.registrationOptions(profile.id, session, origin);
  const confirmation = await passkeys.register(profile.id, session, {
    challengeId: registration.challengeId,
    response: { id: credential.id },
  });
  await passkeys.confirm(profile.id, session, {
    challengeId: confirmation.challengeId,
    response: { id: credential.id },
    prf,
  });
  f.manager.lock(profile.id);
  const options = await passkeys.authenticationOptions(profile.id, session, origin);
  const input = { challengeId: options.challengeId, response: { id: credential.id }, prf };
  return {
    ...f,
    profile,
    recoveryKit,
    passkeys,
    input,
    verificationCalls: () => verificationCalls,
  };
}

test('a queued authentication owns one detached assertion, no key or worker, and survives its clock', async (t) => {
  const f = await enrolled(t),
    before = readFileSync(resolve(f.manager.pathFor(f.profile.id), 'keyring.json'));
  const now = Date.now;
  let elapsed = 0,
    unlocks = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const original = f.manager.unlockWithKeyAsync;
  t.mock.method(f.manager, 'unlockWithKeyAsync', (...args: Parameters<typeof original>) => {
    unlocks++;
    return original(...args);
  });
  const claim = f.passkeys.admitAuthentication(f.profile.id, session, f.input);
  t.after(claim.release);
  f.input.prf = 'changed-after-admission';
  assert.throws(() => f.passkeys.admitAuthentication(f.profile.id, session, f.input), {
    code: 'PASSKEY_CHALLENGE',
  });
  assert.equal(f.verificationCalls(), 1);
  assert.equal(unlocks, 0);
  assert.deepEqual(readFileSync(resolve(f.manager.pathFor(f.profile.id), 'keyring.json')), before);
  assert.deepEqual(readdirSync(f.runtimeDirectory), []);
  elapsed = 6 * 60 * 1000;
  await f.passkeys.authenticationOptions(f.profile.id, session, origin);
  assert.equal((await claim.authenticate()).locked, false);
  assert.equal(unlocks, 1);
  await assert.rejects(claim.authenticate(), /already consumed/);
});

test('authentication expired before admission never enters verification or unlock', async (t) => {
  const f = await enrolled(t),
    now = Date.now;
  t.mock.method(Date, 'now', () => now() + 6 * 60 * 1000);
  assert.throws(() => f.passkeys.admitAuthentication(f.profile.id, session, f.input), {
    code: 'PASSKEY_CHALLENGE',
  });
  assert.equal(f.verificationCalls(), 1);
  assert.equal(f.manager.opened.size, 0);
});

test('owned expired authentication remains bounded and cancellation releases its challenge slot', async (t) => {
  const f = await enrolled(t),
    now = Date.now;
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const claims: ReturnType<typeof f.passkeys.admitAuthentication>[] = [];
  t.after(() => claims.forEach((claim) => claim.release()));
  claims.push(f.passkeys.admitAuthentication(f.profile.id, session, f.input));
  for (let i = 1; i < 1000; i++) {
    const options = await f.passkeys.authenticationOptions(f.profile.id, session, origin);
    claims.push(
      f.passkeys.admitAuthentication(f.profile.id, session, {
        ...f.input,
        challengeId: options.challengeId,
      }),
    );
  }
  elapsed = 6 * 60 * 1000;
  await assert.rejects(f.passkeys.authenticationOptions(f.profile.id, session, origin), {
    code: 'TOO_MANY_CHALLENGES',
  });
  f.passkeys.cancel(f.profile.id, session, f.input);
  assert.ok((await f.passkeys.authenticationOptions(f.profile.id, session, origin)).challengeId);
  assert.equal(f.verificationCalls(), 1);
  assert.equal(f.manager.opened.size, 0);
});

for (const change of [
  'cancel',
  'lock',
  'keyring',
  'generation',
  'abort',
  'release',
  'close',
] as const)
  test(`queued authentication refuses ${change} before verification`, async (t) => {
    const f = await enrolled(t),
      controller = new AbortController();
    const claim = f.passkeys.admitAuthentication(f.profile.id, session, f.input, {
      signal: controller.signal,
    });
    t.after(claim.release);
    if (change === 'cancel') f.passkeys.cancel(f.profile.id, session, f.input);
    if (change === 'lock') f.manager.lock(f.profile.id);
    if (change === 'keyring') f.manager.writeKeyring(f.profile.id, f.manager.keyring(f.profile.id));
    if (change === 'generation') f.passkeys.invalidate(f.profile.id);
    if (change === 'abort') controller.abort(Error('Fictional disconnected request'));
    if (change === 'release') claim.release();
    if (change === 'close') f.manager.close();
    await assert.rejects(claim.authenticate());
    assert.equal(f.verificationCalls(), 1);
    assert.equal(f.manager.opened.size, 0);
  });

test('queued setup detaches its proof, rejects double claim, and accepts after the clock advances', async (t) => {
  const { manager } = vaultFixture(t),
    now = Date.now;
  let elapsed = 0;
  t.mock.method(Date, 'now', () => now() + elapsed);
  const target = manager.begin({
    name: 'Fictional queued setup',
    fullName: 'Fictional queued setup',
    birthDate: '1982-04-17',
  });
  const input = { acknowledged: true, recovery: target.recoveryKit };
  const claim = manager.admitSetup(target.setupId, input);
  t.after(claim.release);
  assert.throws(() => manager.admitSetup(target.setupId, input), { code: 'PROFILE_PREPARING' });
  input.recovery = { ...input.recovery, phrase: 'changed-after-admission' };
  elapsed = 31 * 60 * 1000;
  assert.equal((await claim.verify()).id, target.profileId);
  await assert.rejects(claim.verify(), /already consumed/);
});

test('setup expired before admission never starts target preparation', async (t) => {
  const { manager, runtimeDirectory } = vaultFixture(t);
  const target = manager.begin({
    name: 'Fictional expired setup',
    fullName: 'Fictional expired setup',
    birthDate: '1982-04-17',
  });
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + 31 * 60 * 1000);
  assert.throws(
    () => manager.admitSetup(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    { code: 'SETUP_EXPIRED' },
  );
  assert.deepEqual(readdirSync(runtimeDirectory), []);
  assert.equal(manager.keyring(target.profileId).active, false);
});

for (const change of [
  'target-lock',
  'target-keyring',
  'source-lock',
  'source-write',
  'abort',
  'close',
] as const)
  test(`queued private copy refuses ${change} without activation`, async (t) => {
    const { manager } = vaultFixture(t),
      source = await newProfile(manager);
    const target = manager.begin({ name: 'Fictional queued copy', copyFrom: source.profileId });
    const controller = new AbortController();
    const claim = manager.admitSetup(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      { signal: controller.signal },
    );
    t.after(claim.release);
    if (change === 'target-lock')
      assert.throws(() => manager.lock(target.profileId), { code: 'PROFILE_NOT_FOUND' });
    if (change === 'target-keyring')
      manager.writeKeyring(target.profileId, manager.keyring(target.profileId));
    if (change === 'source-lock') manager.lock(source.profileId);
    if (change === 'source-write')
      createNote(manager.opened.get(source.profileId)!.db, {
        kind: 'note',
        title: 'Fictional changed source',
      });
    if (change === 'abort') controller.abort(Error('Fictional disconnect'));
    if (change === 'close') manager.close();
    await assert.rejects(claim.verify());
    assert.equal(manager.opened.has(target.profileId), false);
    assert.equal(manager.keyring(target.profileId).active, false);
  });

test('only a successfully inspected replacement revokes an older queued setup', async (t) => {
  const { manager } = vaultFixture(t);
  const target = manager.begin({
    name: 'Fictional replaced setup',
    fullName: 'Fictional replaced setup',
    birthDate: '1982-04-17',
  });
  const input = { acknowledged: true, recovery: target.recoveryKit };
  const old = manager.admitSetup(target.setupId, input);
  t.after(old.release);
  await assert.rejects(manager.resumeAsync({ ...target.recoveryKit, phrase: 'wrong' }));
  assert.throws(() => manager.admitSetup(target.setupId, input), { code: 'PROFILE_PREPARING' });
  const replacement = await manager.resumeAsync(target.recoveryKit);
  assert.ok(replacement.setupId);
  const current = manager.admitSetup(replacement.setupId!, input);
  t.after(current.release);
  await assert.rejects(old.verify());
  old.release();
  assert.throws(() => manager.admitSetup(replacement.setupId!, input), {
    code: 'PROFILE_PREPARING',
  });
  assert.equal((await current.verify()).id, target.profileId);
});

for (const change of ['manifest', 'keyring'] as const)
  test(`own counter publication refuses ${change} changed by another admission's revocation`, async (t) => {
    const f = await enrolled(t),
      claim = f.passkeys.admitAuthentication(f.profile.id, session, f.input);
    const other = f.manager.admitPasskeyAuthentication(f.profile.id);
    t.after(claim.release);
    t.after(other.release);
    const path = resolve(
      f.manager.pathFor(f.profile.id),
      change === 'manifest' ? 'vault/manifest.enc' : 'keyring.json',
    );
    let changed = false;
    other.signal.addEventListener(
      'abort',
      () => {
        changed = true;
        if (change === 'manifest') writeFileSync(path, readFileSync(path));
        else {
          const ring = f.manager.keyring(f.profile.id);
          ring.passkeys[0]!.counter = 77;
          writeFileSync(path, JSON.stringify(ring));
        }
      },
      { once: true },
    );
    await assert.rejects(claim.authenticate(), /preparation changed|access changed/i);
    assert.equal(changed, true);
    assert.equal(f.manager.opened.size, 0);
    assert.equal(
      f.manager.keyring(f.profile.id).passkeys[0]!.counter,
      change === 'keyring' ? 77 : 1,
      'refused counter publication must not overwrite the competing keyring',
    );
  });

test('a source edit after asynchronous setup inspection cannot renew the admitted source head', async (t) => {
  const { manager } = vaultFixture(t),
    source = await newProfile(manager);
  const target = manager.begin({ name: 'Fictional inspected copy', copyFrom: source.profileId });
  const emit = Worker.prototype.emit;
  let changed = false;
  t.mock.method(
    Worker.prototype,
    'emit',
    function (this: Worker, event: string | symbol, ...args: unknown[]) {
      const prepared = (args[0] as { prepared?: { details?: { profileId?: string } } } | undefined)
        ?.prepared;
      if (!changed && event === 'message' && prepared?.details?.profileId === target.profileId) {
        changed = true;
        createNote(manager.opened.get(source.profileId)!.db, {
          kind: 'note',
          title: 'Fictional edit during inspect',
        });
      }
      return emit.call(this, event, ...args);
    },
  );
  const before = readFileSync(resolve(manager.pathFor(target.profileId), 'vault/manifest.enc'));
  await assert.rejects(
    manager.verifyAsync(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /Copy source changed|preparation changed/,
  );
  assert.equal(
    changed,
    true,
    'the source changed after the real inspection worker returned its result',
  );
  assert.deepEqual(
    readFileSync(resolve(manager.pathFor(target.profileId), 'vault/manifest.enc')),
    before,
  );
  assert.equal(manager.opened.has(target.profileId), false);
  assert.equal(manager.keyring(target.profileId).active, false);
});

test('direct setup verification refuses target revocation inside source authorization', async (t) => {
  const { manager } = vaultFixture(t),
    source = await newProfile(manager);
  const target = manager.begin({
    name: 'Fictional synchronous revoked copy',
    copyFrom: source.profileId,
  });
  const before = readFileSync(resolve(manager.pathFor(target.profileId), 'vault/manifest.enc'));
  let calls = 0;
  await assert.rejects(
    manager.verify(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      {
        authorizeCopySource() {
          if (++calls === 3)
            assert.throws(() => manager.lock(target.profileId), { code: 'PROFILE_NOT_FOUND' });
        },
      },
    ),
    /access changed|admission released/i,
  );
  assert.equal(calls, 3);
  assert.equal(manager.opened.has(target.profileId), false);
  assert.equal(manager.keyring(target.profileId).active, false);
  assert.deepEqual(
    readFileSync(resolve(manager.pathFor(target.profileId), 'vault/manifest.enc')),
    before,
  );
});

test('authentication preserves its admitted target through the pre-unlock authorization callback', async (t) => {
  const f = await enrolled(t),
    path = resolve(f.manager.pathFor(f.profile.id), 'vault/manifest.enc');
  let calls = 0,
    changed = false;
  const claim = f.passkeys.admitAuthentication(f.profile.id, session, f.input, {
    assertAuthorized() {
      if (++calls === 4) {
        writeFileSync(path, readFileSync(path));
        changed = true;
      }
    },
  });
  t.after(claim.release);
  await assert.rejects(claim.authenticate(), /preparation changed|access changed/i);
  assert.equal(changed, true);
  assert.equal(f.manager.opened.size, 0);
});

test('direct setup preserves its admitted target through the pre-open authorization callback', async (t) => {
  const { manager } = vaultFixture(t),
    target = manager.begin({
      name: 'Fictional unchanged target authority',
      fullName: 'Fictional unchanged target authority',
      birthDate: '1982-04-17',
    }),
    path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc');
  let calls = 0,
    changed = false;
  await assert.rejects(
    manager.verify(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      {
        assertAuthorized() {
          if (++calls === 3) {
            writeFileSync(path, readFileSync(path));
            changed = true;
          }
        },
      },
    ),
    /preparation changed|access changed/i,
  );
  assert.equal(changed, true);
  assert.equal(manager.opened.has(target.profileId), false);
  assert.equal(manager.keyring(target.profileId).active, false);
});

test('already-open authentication retains admitted authority across its asynchronous storage check', async (t) => {
  const f = await enrolled(t);
  await f.manager.unlockAsync(f.profile.id, f.recoveryKit);
  const path = resolve(f.manager.pathFor(f.profile.id), 'vault/manifest.enc');
  let calls = 0,
    changed = false;
  const claim = f.passkeys.admitAuthentication(f.profile.id, session, f.input, {
    assertAuthorized() {
      if (++calls === 6) {
        writeFileSync(path, readFileSync(path));
        changed = true;
      }
    },
  });
  t.after(claim.release);
  await assert.rejects(claim.authenticate(), /preparation changed|access changed/i);
  assert.equal(changed, true);
  assert.equal(calls, 6);
});

for (const change of ['lock', 'manifest'] as const)
  test(`direct setup refuses ${change} during final diagnostic installation without erasing its accepted head`, async (t) => {
    const diagnostics = createImportDiagnostics({ enabled: false });
    t.after(() => diagnostics.close());
    const { manager } = vaultFixture(t, { diagnostics }),
      target = manager.begin({
        name: 'Fictional locked installation',
        fullName: 'Fictional locked installation',
        birthDate: '1982-04-17',
      });
    const attach = diagnostics.attachEventStore;
    let locked = false;
    t.mock.method(diagnostics, 'attachEventStore', (...args: Parameters<typeof attach>) => {
      attach(...args);
      if (args[0] === target.profileId) {
        if (change === 'lock') manager.lock(target.profileId);
        else {
          const path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc');
          writeFileSync(path, readFileSync(path));
        }
        locked = true;
      }
    });
    await assert.rejects(
      manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
      /access changed|admission released|locked|preparation changed/i,
    );
    assert.equal(locked, true);
    assert.equal(manager.opened.has(target.profileId), false);
    t.mock.restoreAll();
    assert.equal(
      (await manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }))
        .id,
      target.profileId,
    );
  });

test('a reentrant setup claim cannot be overwritten by its outer admission', async (t) => {
  const { manager } = vaultFixture(t),
    target = manager.begin({
      name: 'Fictional single setup owner',
      fullName: 'Fictional single setup owner',
      birthDate: '1982-04-17',
    }),
    input = { acknowledged: true, recovery: target.recoveryKit };
  let inner: ReturnType<typeof manager.admitSetup> | undefined;
  assert.throws(
    () =>
      manager.admitSetup(target.setupId, input, {
        assertAuthorized() {
          inner = manager.admitSetup(target.setupId, input);
        },
      }),
    { code: 'PROFILE_PREPARING' },
  );
  assert.ok(inner);
  t.after(inner.release);
  assert.throws(() => manager.admitSetup(target.setupId, input), { code: 'PROFILE_PREPARING' });
  assert.equal((await inner.verify()).id, target.profileId);
});

test('direct setup pins its own first manifest before completion diagnostics can replace it', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const { manager } = vaultFixture(t, { diagnostics }),
    source = await newProfile(manager),
    target = manager.begin({ name: 'Fictional publication callback', copyFrom: source.profileId });
  const record = diagnostics.record.bind(diagnostics);
  let changed = false;
  t.mock.method(diagnostics, 'record', (...args: Parameters<typeof record>) => {
    record(...args);
    if (
      !changed &&
      args[0] === 'import.phase.completed' &&
      args[1]?.phase === 'profile_durability_attach' &&
      args[2]?.profileId === target.profileId
    ) {
      const path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc');
      writeFileSync(path, readFileSync(path));
      changed = true;
    }
  });
  await assert.rejects(
    manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    /preparation changed|access changed/i,
  );
  assert.equal(changed, true);
  assert.equal(manager.opened.has(target.profileId), false);
  t.mock.restoreAll();
  manager.lock(source.profileId);
  const resumed = await manager.resumeAsync(target.recoveryKit);
  assert.equal(
    (await manager.verify(resumed.setupId!, { acknowledged: true, recovery: target.recoveryKit }))
      .id,
    target.profileId,
  );
});

test('already-open setup retry retains its admitted target across authorization callbacks', async (t) => {
  const { manager } = vaultFixture(t),
    target = await newProfile(manager),
    path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc');
  let calls = 0,
    changed = false;
  await assert.rejects(
    manager.verifyAsync(
      target.setupId,
      { acknowledged: true, recovery: target.recoveryKit },
      {
        assertAuthorized() {
          if (++calls === 3) {
            writeFileSync(path, readFileSync(path));
            changed = true;
          }
        },
      },
    ),
    /preparation changed|access changed/i,
  );
  assert.equal(changed, true);
});

test('queued abort immediately releases the same setup without letting old cleanup release its replacement', async (t) => {
  const { manager } = vaultFixture(t),
    target = manager.begin({
      name: 'Fictional disconnected setup',
      fullName: 'Fictional disconnected setup',
      birthDate: '1982-04-17',
    }),
    input = { acknowledged: true, recovery: target.recoveryKit },
    controller = new AbortController(),
    old = manager.admitSetup(target.setupId, input, { signal: controller.signal });
  controller.abort(Error('Fictional queued disconnect'));
  const current = manager.admitSetup(target.setupId, input);
  t.after(current.release);
  old.release();
  await assert.rejects(old.verify());
  assert.throws(() => manager.admitSetup(target.setupId, input), { code: 'PROFILE_PREPARING' });
  assert.equal((await current.verify()).id, target.profileId);
});

for (const replacement of ['previous-head', 'same-byte-head'] as const)
  test(`direct setup refuses nested publication diagnostics replacing ${replacement}`, async (t) => {
    const diagnostics = createImportDiagnostics({ enabled: false });
    t.after(() => diagnostics.close());
    const { manager } = vaultFixture(t, { diagnostics }),
      source = await newProfile(manager),
      target = manager.begin({ name: 'Fictional nested publication', copyFrom: source.profileId }),
      path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc'),
      original = readFileSync(path),
      record = diagnostics.record.bind(diagnostics);
    let changed = false,
      committed: Buffer | undefined;
    t.mock.method(diagnostics, 'record', (...args: Parameters<typeof record>) => {
      record(...args);
      if (
        !changed &&
        args[0] === 'import.phase.completed' &&
        args[1]?.phase === 'vault_publish_manifest' &&
        args[2]?.profileId === target.profileId
      ) {
        committed = readFileSync(path);
        writeFileSync(path, replacement === 'previous-head' ? original : committed);
        changed = true;
      }
    });
    await assert.rejects(
      diagnostics.run({ profileId: target.profileId }, () =>
        manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
      ),
      /preparation changed|access changed/i,
    );
    assert.equal(changed, true);
    assert.ok(committed);
    assert.notDeepEqual(committed, original);
    assert.equal(manager.opened.has(target.profileId), false);
    assert.equal(manager.keyring(target.profileId).active, false);
    t.mock.restoreAll();
    assert.throws(
      () =>
        manager.admitSetup(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
      /preparation changed|access changed/i,
    );
    // Restore the independently retained committed witness after the deliberately
    // injected external replacement; refusal itself must not roll it back.
    writeFileSync(path, committed);
    manager.lock(source.profileId);
    const resumed = await manager.resumeAsync(target.recoveryKit);
    assert.equal(
      (await manager.verify(resumed.setupId!, { acknowledged: true, recovery: target.recoveryKit }))
        .id,
      target.profileId,
    );
  });

test('direct setup seals its original manifest after nested publication-start diagnostics', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const { manager } = vaultFixture(t, { diagnostics }),
    target = manager.begin({
      name: 'Fictional start callback',
      fullName: 'Fictional start callback',
      birthDate: '1982-04-17',
    }),
    path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc'),
    original = readFileSync(path),
    record = diagnostics.record.bind(diagnostics);
  let changed = false;
  t.mock.method(diagnostics, 'record', (...args: Parameters<typeof record>) => {
    record(...args);
    if (
      !changed &&
      args[0] === 'import.phase.started' &&
      args[1]?.phase === 'vault_publish_manifest' &&
      args[2]?.profileId === target.profileId
    ) {
      changed = true;
      writeFileSync(path, original);
    }
  });
  await assert.rejects(
    diagnostics.run({ profileId: target.profileId }, () =>
      manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    ),
    /preparation changed|access changed/i,
  );
  assert.equal(changed, true);
  assert.deepEqual(readFileSync(path), original);
  assert.equal(manager.opened.has(target.profileId), false);
  assert.equal(manager.keyring(target.profileId).active, false);
});

test('clean nested setup publication releases its one-shot proof before ordinary accepted writes', async (t) => {
  const diagnostics = createImportDiagnostics({ enabled: false });
  t.after(() => diagnostics.close());
  const { manager } = vaultFixture(t, { diagnostics }),
    target = manager.begin({
      name: 'Fictional publication control',
      fullName: 'Fictional publication control',
      birthDate: '1982-04-17',
    }),
    record = diagnostics.record.bind(diagnostics);
  let publications = 0;
  t.mock.method(diagnostics, 'record', (...args: Parameters<typeof record>) => {
    record(...args);
    if (
      args[0] === 'import.phase.completed' &&
      args[1]?.phase === 'vault_publish_manifest' &&
      args[2]?.profileId === target.profileId
    )
      publications++;
  });
  await diagnostics.run({ profileId: target.profileId }, () =>
    manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
  );
  const opened = manager.opened.get(target.profileId)!;
  const before = opened.recordStorage.read('head');
  assert.equal(publications, 1);
  const note = diagnostics.run({ profileId: target.profileId }, () =>
    createNote(opened.db, {
      kind: 'note',
      title: 'Fictional post-activation save',
      content: 'Owned ordinary changed write after setup admission released.',
    }),
  );
  assert.equal(publications, 2);
  assert.notDeepEqual(opened.recordStorage.read('head'), before);
  manager.lock(target.profileId);
  await manager.unlockAsync(target.profileId, target.recoveryKit);
  assert.equal(
    manager.opened.get(target.profileId)!.db.prepare('SELECT id FROM notes WHERE id=?').get(note.id)
      ?.id,
    note.id,
  );
});

for (const resume of ['sync', 'async'] as const)
  test(`${resume} recovered setup refuses a rollback before its new admission`, async (t) => {
    const diagnostics = createImportDiagnostics({ enabled: false });
    t.after(() => diagnostics.close());
    const { manager } = vaultFixture(t, { diagnostics }),
      source = await newProfile(manager),
      target = manager.begin({ name: 'Fictional recovered receipt', copyFrom: source.profileId }),
      path = resolve(manager.pathFor(target.profileId), 'vault/manifest.enc'),
      original = readFileSync(path),
      record = diagnostics.record.bind(diagnostics);
    let interrupted = false;
    t.mock.method(diagnostics, 'record', (...args: Parameters<typeof record>) => {
      record(...args);
      if (
        !interrupted &&
        args[0] === 'import.phase.completed' &&
        args[1]?.phase === 'profile_durability_attach' &&
        args[2]?.profileId === target.profileId
      ) {
        interrupted = true;
        assert.throws(() => manager.lock(target.profileId), { code: 'PROFILE_NOT_FOUND' });
      }
    });
    await assert.rejects(
      manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit }),
    );
    assert.equal(interrupted, true);
    assert.notDeepEqual(readFileSync(path), original);
    t.mock.restoreAll();
    const resumed =
      resume === 'sync'
        ? manager.resume(target.recoveryKit)
        : await manager.resumeAsync(target.recoveryKit);
    writeFileSync(path, original);
    createNote(manager.opened.get(source.profileId)!.db, {
      kind: 'note',
      title: 'Fictional source changed after recovery inspection',
    });
    assert.throws(
      () =>
        manager.admitSetup(resumed.setupId!, { acknowledged: true, recovery: target.recoveryKit }),
      /preparation changed|access changed/i,
    );
    assert.deepEqual(readFileSync(path), original);
    assert.equal(manager.opened.has(target.profileId), false);
  });
