import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, StatementSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

// Keep captured native reads observable without replacing a storage factory.
const nativeGet = StatementSync.prototype.get;
let observeStatus: ((row: Record<string, unknown>) => Record<string, unknown>) | undefined;
StatementSync.prototype.get = function (this: StatementSync, ...args: unknown[]) {
  const row = Reflect.apply(nativeGet, this, args);
  return row && this.sourceSQL === 'SELECT * FROM main.__record_state WHERE singleton=1'
    ? (observeStatus?.(row) ?? row)
    : row;
} as typeof StatementSync.prototype.get;
test.after(() => {
  observeStatus = undefined;
  StatementSync.prototype.get = nativeGet;
});

const { openDatabase, transaction } = await import('../database.ts');
const { ensureProfileDirectories } = await import('../profile-storage.ts');
const { openContributorRecordStorage, contributorAuthorityPath } =
  await import('../contributor-record-storage.ts');
const {
  attachRecordDurability,
  captureContributorLegacyBridgeRecordOwner,
  assertContributorLegacyBridgeRecordOwner,
  closeRecordReadOwner,
} = await import('../record-versions.ts');
const { createRecordVersionWorkCounters, withRecordVersionWork } =
  await import('../record-version-work.ts');
const {
  captureIntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
} = await import('../intake-state-migration.ts');
const { ensureIntakeFrontierObserver } = await import('../intake-lookup-frontier-observer.ts');

function fixture(t: TestContext) {
  let root = fs.mkdtempSync(join(tmpdir(), 'fictional-fixed-legacy-proof-'));
  let db: ReturnType<typeof openDatabase> | undefined;
  let storage: ReturnType<typeof openContributorRecordStorage> | undefined;
  t.after(() => {
    observeStatus = undefined;
    try {
      if (db?.isOpen) db.close();
    } finally {
      try {
        storage?.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
  root = fs.realpathSync.native(root);
  const profileId = 'fictional';
  db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  return { db, storage, head: join(contributorAuthorityPath(root, profileId), 'head') };
}

test('fixed legacy proof uses three physical seals and one fresh HEAD read per boundary', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!,
    work = createRecordVersionWorkCounters();
  t.after(() => closeRecordReadOwner(owner));
  const nativeStat = fs.lstatSync,
    nativeRead = fs.readSync,
    nativeCanonical = fs.realpathSync.native;
  let headSeals = 0,
    reads = 0,
    scopeCanonical = 0;
  const canonicalMock = t.mock.method(
    fs.realpathSync,
    'native',
    (...args: Parameters<typeof nativeCanonical>) => {
      scopeCanonical++;
      return Reflect.apply(nativeCanonical, fs.realpathSync, args);
    },
  );
  const statMock = t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === f.head) headSeals++;
    return Reflect.apply(nativeStat, fs, args);
  }) as typeof fs.lstatSync);
  fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return Reflect.apply(nativeRead, fs, args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  const boundaries = 16;
  try {
    withRecordVersionWork(work, () => {
      for (let i = 0; i < boundaries; i++) assertContributorLegacyBridgeRecordOwner(f.db, owner);
    });
  } finally {
    statMock.mock.restore();
    canonicalMock.mock.restore();
    fs.readSync = nativeRead;
    syncBuiltinESMExports();
  }
  t.diagnostic(
    JSON.stringify({
      boundaries,
      headSeals,
      reads,
      scopeCanonical,
      headReadCalls: work.operation.headReadCalls,
      fullOwnerChecks: work.operation.contributorReadOwnerCurrentChecks,
      parses: work.operation.parseCalls,
      serializations: work.operation.serializationCalls,
    }),
  );
  assert.equal(headSeals, 3 * boundaries);
  assert.equal(reads, boundaries);
  assert.equal(scopeCanonical, 2 * boundaries);
  assert.equal(work.operation.headReadCalls, boundaries);
  assert.equal(work.operation.contributorReadOwnerCurrentChecks, boundaries);
  assert.equal(work.operation.parseCalls, 0);
  assert.equal(work.operation.serializationCalls, 0);
});

test('unsupported native status values retain the conservative legacy proof', (t) => {
  const f = fixture(t);
  f.db.exec('ALTER TABLE __record_state ADD COLUMN fictional_blob BLOB');
  f.db.prepare('UPDATE __record_state SET fictional_blob=?').run(Buffer.from('fictional value'));
  const owner = captureContributorLegacyBridgeRecordOwner(f.db)!,
    work = createRecordVersionWorkCounters();
  t.after(() => closeRecordReadOwner(owner));
  withRecordVersionWork(work, () => assertContributorLegacyBridgeRecordOwner(f.db, owner));
  assert.equal(work.operation.contributorReadOwnerCurrentChecks, 2);
  assert.equal(work.operation.headReadCalls, 1);
  assert.equal(work.operation.parseCalls, 1);
  assert.equal(work.operation.serializationCalls, 3);
});

test('fixed legacy status reprepare refuses before the installed authorizer policy', (t) => {
  const f = fixture(t);
  let armed = false,
    effects = 0;
  f.db.setAuthorizer((action, name) => {
    if (armed && action === constants.SQLITE_READ && name === '__record_state') effects++;
    return constants.SQLITE_OK;
  });
  const owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  f.db.exec('CREATE TABLE fictional_fixed_reprepare(value TEXT)');
  armed = true;
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner));
  assert.equal(effects, 0);
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
});

test('caught reentrant fixed legacy assertion permanently poisons its original owner', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  let fired = false;
  observeStatus = (row) => {
    if (!fired) {
      fired = true;
      assert.throws(
        () => assertContributorLegacyBridgeRecordOwner(f.db, owner),
        /authority changed/,
      );
    }
    return row;
  };
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
  observeStatus = undefined;
  assert.equal(fired, true);
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
});

for (const fault of ['singleton', 'extra', 'missing', 'type'] as const)
  test(`fixed legacy status compares every typed column: ${fault}`, (t) => {
    const f = fixture(t);
    f.db.exec("ALTER TABLE __record_state ADD COLUMN fictional_extra TEXT DEFAULT 'original'");
    const owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
    t.after(() => closeRecordReadOwner(owner));
    observeStatus = (row) => {
      if (fault === 'singleton') return { ...row, singleton: 2 };
      if (fault === 'extra') return { ...row, fictional_extra: 'changed' };
      if (fault === 'type') return { ...row, sequence: String(row.sequence) };
      const copy = { ...row };
      delete copy.fictional_extra;
      return copy;
    };
    assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
  });

test('fixed legacy proof reads changed HEAD bytes even under unchanged reported file stats', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  const lstat = fs.lstatSync,
    fstat = fs.fstatSync,
    headStat = lstat(f.head, { bigint: true });
  const statMock = t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) =>
    String(args[0]) === f.head ? headStat : Reflect.apply(lstat, fs, args)) as typeof fs.lstatSync);
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = Reflect.apply(fstat, fs, args);
    return stat.ino === headStat.ino ? headStat : stat;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try {
    const bytes = fs.readFileSync(f.head);
    const changed = Buffer.from(bytes);
    const hash = (JSON.parse(bytes.toString()) as { sha256: string }).sha256;
    const at = changed.indexOf(Buffer.from(hash));
    assert.ok(at >= 0);
    changed[at] = changed[at] === 97 ? 98 : 97;
    fs.writeFileSync(f.head, changed);
    assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
  } finally {
    statMock.mock.restore();
    fs.fstatSync = fstat;
    syncBuiltinESMExports();
  }
});

test('fixed legacy proof refuses a failed immutable overwrite attempt', (t) => {
  const f = fixture(t),
    owner = captureContributorLegacyBridgeRecordOwner(f.db)!;
  t.after(() => closeRecordReadOwner(owner));
  const { name } = JSON.parse(fs.readFileSync(f.head, 'utf8')) as { name: string };
  assert.throws(() => f.storage.writeImmutable(name, Buffer.from('fictional conflicting bytes')));
  assert.throws(() => assertContributorLegacyBridgeRecordOwner(f.db, owner), /authority changed/);
});

test('fixed legacy leaf retains the enclosing source SQL attempt seal', (t) => {
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
  t.after(() => disposeIntakeLegacyBridgeReadWitness(witness));
  const update = f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?');
  update.run('{"fictional":true}', 'fictional-source');
  update.run('{}', 'fictional-source');
  assert.throws(() => assertIntakeLegacyBridgeReadWitness(f.db, witness), /authority changed/);
});
