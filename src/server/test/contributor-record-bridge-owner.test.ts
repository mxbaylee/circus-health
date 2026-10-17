import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openDatabase, transaction, currentTransactionToken } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  captureContributorLegacyBridgeRecordOwner,
  assertContributorLegacyBridgeRecordOwner,
  closeRecordReadOwner,
  type RecordReadOwner,
} from '../record-versions.ts';
import {
  openContributorRecordStorage,
  contributorAuthorityPath,
  captureContributorRecordReadOwner,
  contributorRecordReadOwnerHeadBytes,
  closeContributorRecordReadOwner,
  captureContributorLegacyBridgeBackingScopeForStorage,
  bindContributorLegacyBridgeBackingScope,
  contributorLegacyBridgeBackingScopeCurrent,
} from '../contributor-record-storage.ts';
import {
  captureIntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
} from '../intake-state-migration.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import { beginManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  mkdirSync,
  writeExclusiveJournalFileSync,
  linkExclusiveJournalFileSync,
} from '../journal-physical-write.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-bridge-owner-'))),
    profileId = 'fictional',
    paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId),
    storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  t.after(() => {
    storage.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const selected = readFileSync(join(contributorAuthorityPath(root, profileId), 'head'), 'utf8');
  return { root, db, storage, selected };
}

test('bridge backing scope is original, genuine, one-use and permits disjoint journal writes', (t) => {
  const f = fixture(t),
    foreign = fixture(t),
    original = captureContributorRecordReadOwner(f.storage)!,
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage)!;
  t.after(() => closeContributorRecordReadOwner(original));
  assert.ok(scope);
  assert.equal(bindContributorLegacyBridgeBackingScope(foreign.storage, original, scope), false);
  assert.equal(
    bindContributorLegacyBridgeBackingScope(f.storage, original, {} as typeof scope),
    false,
  );
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, original, scope), true);
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, original, scope), false);
  const journal = join(f.root, 'unrelated-journal');
  mkdirSync(journal);
  const staged = writeExclusiveJournalFileSync(join(journal, 'pending'), 'fictional journal');
  linkExclusiveJournalFileSync(staged, join(journal, 'selected'));
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, original, scope), true);
  const finish = beginManagedPhysicalMutation([
    join(contributorAuthorityPath(f.root, 'fictional'), 'objects', randomUUID()),
  ]);
  finish();
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, original, scope), false);
});

test('bridge backing scope refuses an actual immutable write before owner bind', (t) => {
  const f = fixture(t),
    original = captureContributorRecordReadOwner(f.storage)!,
    scope = captureContributorLegacyBridgeBackingScopeForStorage(f.storage)!;
  t.after(() => closeContributorRecordReadOwner(original));
  f.storage.writeImmutable('objects/' + randomUUID(), Buffer.from('fictional intervening object'));
  assert.equal(bindContributorLegacyBridgeBackingScope(f.storage, original, scope), false);
  assert.equal(contributorLegacyBridgeBackingScopeCurrent(f.storage, original, scope), false);
});

for (const idempotent of [false, true])
  test(`original bridge record owner refuses an ${idempotent ? 'idempotent' : 'additional'} immutable write attempt`, (t) => {
    const f = fixture(t),
      owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
    t.after(() => closeRecordReadOwner(owner));
    assertContributorLegacyBridgeRecordOwner(f.db, owner);
    const ref = JSON.parse(f.selected) as { name: string };
    f.storage.writeImmutable(
      idempotent ? ref.name : 'objects/' + randomUUID(),
      idempotent ? f.storage.read(ref.name)! : Buffer.from('fictional later object'),
    );
    assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
  });

test('original bridge record owner binds genuine database, methods and transaction token', (t) => {
  const f = fixture(t),
    foreign = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  assert.throws(
    () => assertContributorLegacyBridgeRecordOwner(foreign.db, owner),
    /authority changed/,
  );
  assert.throws(
    () => assertContributorLegacyBridgeRecordOwner(f.db, {} as RecordReadOwner),
    /authority changed/,
  );
  transaction(f.db, () => {
    const token = currentTransactionToken(f.db)!;
    assert.ok(token);
    assertContributorLegacyBridgeRecordOwner(f.db, owner, token);
    assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
    assert.throws(
      () => assertContributorLegacyBridgeRecordOwner(f.db, owner, {}),
      /authority changed/,
    );
  });
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
  const next = captureContributorLegacyBridgeRecordOwner(f.db)!;
  try {
    const read = f.storage.read;
    f.storage.read = (name) => read(name);
    assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, next), /authority changed/);
    f.storage.read = read;
  } finally {
    closeRecordReadOwner(next);
  }
});

test('one bridge assertion checks its physical entry and retains the HEAD read seals', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!,
    work = createRecordVersionWorkCounters();
  t.after(() => closeRecordReadOwner(owner));
  withRecordVersionWork(work, () => assertContributorLegacyBridgeRecordOwner(f.db, owner));
  // One explicit full owner check precedes the native status read; the fresh
  // retained HEAD read supplies its own physical checks before and after bytes.
  assert.equal(work.operation.contributorReadOwnerCurrentChecks, 1);
});

test('genuine owner rereads retained HEAD bytes and refuses method, HEAD and close changes', (t) => {
  const f = fixture(t),
    original = captureContributorRecordReadOwner(f.storage)!;
  t.after(() => closeContributorRecordReadOwner(original));
  assert.equal(contributorRecordReadOwnerHeadBytes(f.storage, original).toString(), f.selected);
  assert.equal(contributorRecordReadOwnerHeadBytes(f.storage, original).toString(), f.selected);
  const read = f.storage.read;
  f.storage.read = (name) => read(name);
  assert.throws(
    () => contributorRecordReadOwnerHeadBytes(f.storage, original),
    /record read owner changed/,
  );
  f.storage.read = read;
  const head = join(contributorAuthorityPath(f.root, 'fictional'), 'head');
  const bytes = readFileSync(head);
  writeFileSync(head, bytes);
  assert.throws(
    () => contributorRecordReadOwnerHeadBytes(f.storage, original),
    /changed before retained read/,
  );
  closeContributorRecordReadOwner(original);
  assert.throws(
    () => contributorRecordReadOwnerHeadBytes(f.storage, original),
    /record read owner changed/,
  );
});

test('retained owner HEAD reads avoid repeated factory canonical resolution', async (t) => {
  const native = fs.realpathSync.native;
  let canonical = 0;
  fs.realpathSync.native = new Proxy(native, {
    apply(target, receiver, args) {
      canonical++;
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  let storage: ReturnType<typeof openContributorRecordStorage> | undefined;
  const root = native(mkdtempSync(join(tmpdir(), 'fictional-retained-head-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  try {
    const module = '../contributor-record-storage.ts?fictional-retained-head';
    const factory = (await import(module)) as typeof import('../contributor-record-storage.ts');
    ensureProfileDirectories(root, 'fictional');
    storage = factory.openContributorRecordStorage(root, 'fictional', { initialize: true });
    storage.publishHead(Buffer.from('Fictional selected HEAD'));
    const owner = factory.captureContributorRecordReadOwner(storage)!;
    try {
      canonical = 0;
      assert.equal(storage.read('head')!.toString(), 'Fictional selected HEAD');
      assert.ok(canonical > 0, 'ordinary factory reads resolve the HEAD path');
      canonical = 0;
      assert.equal(
        factory.contributorRecordReadOwnerHeadBytes(storage, owner).toString(),
        'Fictional selected HEAD',
      );
      assert.equal(
        factory.contributorRecordReadOwnerHeadBytes(storage, owner).toString(),
        'Fictional selected HEAD',
      );
      assert.equal(canonical, 0, 'retained reads reuse the sealed physical path');
    } finally {
      factory.closeContributorRecordReadOwner(owner);
    }
  } finally {
    storage?.close();
    fs.realpathSync.native = native;
    syncBuiltinESMExports();
  }
});

test('original legacy bridge witness refuses a source write attempt', (t) => {
  const f = fixture(t);
  transaction(f.db, () => {
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run('fictional-source', 'fictional.txt', '0'.repeat(64), 0, 'intake_original', '{}');
  });
  ensureIntakeFrontierObserver(f.db);
  const witness = captureIntakeLegacyBridgeReadWitness(f.db, 'fictional-source');
  try {
    f.db
      .prepare('UPDATE source_files SET details_json=details_json WHERE id=?')
      .run('fictional-source');
    assert.throws(() => assertIntakeLegacyBridgeReadWitness(f.db, witness), /authority changed/);
  } finally {
    disposeIntakeLegacyBridgeReadWitness(witness);
  }
});

test('original legacy bridge capture refuses an installed-policy metadata write', (t) => {
  const f = fixture(t),
    update = f.db.prepare('UPDATE app_meta SET value=value WHERE key=?');
  let armed = false,
    changed = false;
  f.db.setAuthorizer((action, name) => {
    if (armed && action === constants.SQLITE_READ && name === '__record_state') {
      armed = false;
      changed = Number(update.run('owner_profile_id').changes) === 1;
    }
    return constants.SQLITE_OK;
  });
  ensureIntakeFrontierObserver(f.db);
  armed = true;
  assert.throws(
    () => captureIntakeLegacyBridgeReadWitness(f.db, 'fictional-source'),
    /legacy bridge original frontier unavailable|original contributor record authority changed|legacy bridge original authority unavailable/,
  );
  assert.equal(changed, true);
});

test('original bridge record owner fails closed when scoped event history overflows', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  for (let index = 0; index < 1025; index++) {
    const finish = beginManagedPhysicalMutation([join(f.root, 'unrelated', String(index))]);
    finish();
  }
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
});
