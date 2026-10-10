import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { unlockPhysicalIdentity } from '../encrypted-unlock-physical.ts';
import { vaultSessionUnlockAuthorized } from '../vault-app.ts';
import { passkeyUnlockAuthorized } from '../profile-passkeys.ts';
import { authorizationSignalAborted } from '../authorization-signal.ts';

test('closing authorization reads genuine cancellation without invoking own accessors', () => {
  const controller = new AbortController();
  let callbacks = 0;
  Object.defineProperty(controller.signal, 'aborted', {
    get() {
      callbacks++;
      return false;
    },
  });
  assert.equal(authorizationSignalAborted(controller.signal), false);
  controller.abort();
  assert.equal(authorizationSignalAborted(controller.signal), true);
  assert.equal(callbacks, 0);
  assert.throws(() => authorizationSignalAborted({ aborted: false } as AbortSignal));
});

test('foreign authorization tokens cannot assert session or passkey ownership', () => {
  const token = Object.freeze({}),
    manager = {};
  assert.equal(vaultSessionUnlockAuthorized(token, manager, 'profile:fictional'), false);
  assert.equal(passkeyUnlockAuthorized(token, manager, 'fictional'), false);
});

test(
  'late generic authorization effects precede original physical proof and cannot activate changed ciphertext',
  { timeout: 30_000 },
  async (t) => {
    const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'fictional-unlock-authorization-'))),
      dataDirectory = resolve(base, 'data'),
      runtimeDirectory = resolve(base, 'runtime');
    mkdirSync(dataDirectory);
    const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
    t.after(() => {
      manager.close();
      rmSync(base, { recursive: true, force: true });
    });
    const target = manager.begin({
      name: 'Fictional Authorization',
      fullName: 'Fictional Authorization',
      birthDate: '1982-04-17',
    });
    manager.verify(target.setupId, { acknowledged: true, recovery: target.recoveryKit });
    const opened = manager.opened.get(target.profileId)!;
    opened.vault.storeFile(
      'sources/fictional-proof.txt',
      Buffer.from('Independently fictional original proof'),
    );
    opened.vault.publish();
    const key = Buffer.from(opened.key),
      object = opened.vault.metadata().files['sources/fictional-proof.txt']!,
      path = resolve(dataDirectory, 'profiles', target.profileId, 'vault/objects', object + '.enc'),
      original = readFileSync(path),
      originalIdentity = unlockPhysicalIdentity(path).value,
      manifestPath = resolve(dataDirectory, 'profiles', target.profileId, 'vault/manifest.enc'),
      manifest = readFileSync(manifestPath);
    manager.lock(target.profileId);
    let rewritten = false;
    await assert.rejects(
      manager.unlockWithKeyAsync(target.profileId, key, {
        assertAuthorized() {
          const stack = new Error().stack ?? '';
          if (!rewritten && stack.includes('unlockWithKeyAsync') && !stack.includes('checkpoint')) {
            rewritten = true;
            writeFileSync(path, original);
            assert.notEqual(unlockPhysicalIdentity(path).value, originalIdentity);
          }
        },
      }),
    );
    assert.equal(rewritten, true, 'the actual late callback ran before the closing roster');
    assert.equal(manager.opened.has(target.profileId), false);
    assert.deepEqual(readFileSync(manifestPath), manifest);
    let checks = 0;
    await manager.unlockAsync(target.profileId, target.recoveryKit, {
      assertAuthorized() {
        checks++;
      },
    });
    assert.ok(checks > 0, 'side-effect-free generic preparation checks remain supported');
    manager.lock(target.profileId);
    await assert.rejects(
      manager.unlockAsync(target.profileId, target.recoveryKit, {
        authorization: Object.freeze({}),
      }),
      /authorization changed/,
    );
    assert.equal(manager.opened.has(target.profileId), false);
  },
);

test(
  'copy-source authorization effects precede both original closing rosters',
  { timeout: 30_000 },
  async (t) => {
    const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'fictional-copy-authorization-'))),
      dataDirectory = resolve(base, 'data'),
      runtimeDirectory = resolve(base, 'runtime');
    mkdirSync(dataDirectory);
    const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
    t.after(() => {
      manager.close();
      rmSync(base, { recursive: true, force: true });
    });
    const original = manager.begin({
      name: 'Fictional Original',
      fullName: 'Fictional Original',
      birthDate: '1983-05-19',
    });
    manager.verify(original.setupId, { acknowledged: true, recovery: original.recoveryKit });
    const source = manager.opened.get(original.profileId)!;
    source.vault.storeFile(
      'sources/fictional-copy-proof.txt',
      Buffer.from('Independently fictional copy evidence'),
    );
    source.vault.publish();
    const object = source.vault.metadata().files['sources/fictional-copy-proof.txt']!,
      path = resolve(
        dataDirectory,
        'profiles',
        original.profileId,
        'vault/objects',
        object + '.enc',
      ),
      ciphertext = readFileSync(path),
      identity = unlockPhysicalIdentity(path).value,
      manifestPath = resolve(dataDirectory, 'profiles', original.profileId, 'vault/manifest.enc'),
      manifest = readFileSync(manifestPath);
    const target = manager.begin({ name: 'Fictional Copy', copyFrom: original.profileId });
    let rewritten = false;
    await assert.rejects(
      manager.verifyAsync(
        target.setupId,
        {
          acknowledged: true,
          recovery: target.recoveryKit,
        },
        {
          authorizeCopySource(id) {
            assert.equal(id, original.profileId);
            const stack = new Error().stack ?? '';
            if (
              !rewritten &&
              stack.includes('unlockWithKeyAsync') &&
              !stack.includes('checkpoint')
            ) {
              rewritten = true;
              writeFileSync(path, ciphertext);
              assert.notEqual(unlockPhysicalIdentity(path).value, identity);
            }
          },
        },
      ),
    );
    assert.equal(rewritten, true, 'the source callback ran at the actual final unlock boundary');
    assert.equal(manager.opened.has(target.profileId), false);
    assert.equal(manager.opened.get(original.profileId), source);
    assert.deepEqual(readFileSync(manifestPath), manifest);
    assert.throws(() => manager.assertProfileExists(target.profileId), /Profile not found/);
  },
);

test(
  'copy publication caller effects cannot select a target manifest from changed originals',
  { timeout: 30_000 },
  async (t) => {
    const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'fictional-copy-publication-'))),
      dataDirectory = resolve(base, 'data'),
      runtimeDirectory = resolve(base, 'runtime');
    mkdirSync(dataDirectory);
    const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
    t.after(() => {
      manager.close();
      rmSync(base, { recursive: true, force: true });
    });
    const original = manager.begin({
      name: 'Fictional Publish Original',
      fullName: 'Fictional Publish Original',
      birthDate: '1984-06-21',
    });
    manager.verify(original.setupId, { acknowledged: true, recovery: original.recoveryKit });
    const source = manager.opened.get(original.profileId)!;
    source.vault.storeFile(
      'sources/fictional-publish-proof.txt',
      Buffer.from('Independently fictional publication evidence'),
    );
    source.vault.publish();
    const object = source.vault.metadata().files['sources/fictional-publish-proof.txt']!,
      path = resolve(
        dataDirectory,
        'profiles',
        original.profileId,
        'vault/objects',
        object + '.enc',
      ),
      ciphertext = readFileSync(path),
      identity = unlockPhysicalIdentity(path).value;
    const target = manager.begin({ name: 'Fictional Publish Copy', copyFrom: original.profileId }),
      targetManifest = resolve(dataDirectory, 'profiles', target.profileId, 'vault/manifest.enc'),
      before = readFileSync(targetManifest);
    let rewritten = false;
    await assert.rejects(
      manager.verifyAsync(
        target.setupId,
        { acknowledged: true, recovery: target.recoveryKit },
        {
          authorizeCopySource(id) {
            assert.equal(id, original.profileId);
            if (!rewritten && new Error().stack?.includes('checkPublication')) {
              rewritten = true;
              writeFileSync(path, ciphertext);
              assert.notEqual(unlockPhysicalIdentity(path).value, identity);
            }
          },
        },
      ),
    );
    assert.equal(rewritten, true, 'the actual last publication caller-effect gate executed');
    assert.deepEqual(
      readFileSync(targetManifest),
      before,
      'refusal must precede target durable selection, not only activation',
    );
    assert.equal(manager.opened.has(target.profileId), false);
    assert.throws(() => manager.assertProfileExists(target.profileId), /Profile not found/);
    assert.equal(manager.opened.get(original.profileId), source);
    assert.equal(manager.keyring(target.profileId).active, false);
    assert.equal(
      readdirSync(manager.pathFor(target.profileId)).some((name) =>
        name.startsWith('.setup-stage-'),
      ),
      false,
    );
  },
);
