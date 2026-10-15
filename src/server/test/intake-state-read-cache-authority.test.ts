import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sqlLiteral = (text: string) => "'" + text.replaceAll("'", "''") + "'";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-read-cache-authority-'));
  const file = join(root, 'current.sqlite');
  const identity = {
    profileId: 'fictional-read-cache',
    intakeId: 'fictional-original',
    sourceHash: '7'.repeat(64),
  };
  const db = openDatabase(file, identity.profileId);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, 'fictional.txt', identity.sourceHash, 0, 'intake_original', '{}');
  const authority = memoryRecordAuthority(db);
  const store = createIntakeStateStorage(db, identity).collections;
  const operationId = randomUUID();
  const prepared = store.prepare(store.openView(), {
    operationId,
    requestDigest: digest(operationId),
    domainVersion: 1,
    changes: Array.from({ length: 31 }, (_, ordinal) => ({
      area: 'logical' as const,
      collection: 'values',
      op: 'put' as const,
      key: String(ordinal).padStart(3, '0'),
      value: 'fictional-' + ordinal,
    })),
  });
  transaction(db, () => store.stage(prepared));
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const prefix = intakeNamespace(identity);
  const read = () => store.get(store.openView(), 'logical', 'values', '000');
  const selected = store.collection(store.openView(), 'logical', 'values')!;
  const ancestors: { key: string; raw: string }[] = [];
  let ref = selected.root;
  while (ref) {
    const key = prefix + 'node:' + ref.hash;
    const raw = String(db.prepare('SELECT value FROM main.app_meta WHERE key=?').get(key)!.value);
    ancestors.push({ key, raw });
    ref = JSON.parse(raw).left;
  }
  assert.ok(ancestors.length > 1);
  assert.equal(read(), 'fictional-0');
  return { db, file, identity, prefix, store, read, ancestors, authority };
}
function restore(db: DatabaseSync, row: { key: string; raw: string }) {
  db.prepare('INSERT OR REPLACE INTO main.app_meta(key,value) VALUES(?,?)').run(row.key, row.raw);
}

// Mutate after at least one actual result item has been visited, not during
// input validation. The public call must refuse its complete mixed result.
function duringRange(f: ReturnType<typeof fixture>, mutate: () => void, scoped = false) {
  const before = intakeWorkCounters(f.db).warm.collectionItemsRead;
  let fired = false;
  const read = () =>
    f.store.range(f.store.openView(), 'logical', 'values', {
      ...(scoped ? { after: '0', prefix: '0' } : {}),
      get items() {
        if (!fired && intakeWorkCounters(f.db).warm.collectionItemsRead > before) {
          fired = true;
          mutate();
        }
        return 4;
      },
      bytes: 8192,
    });
  return { read, fired: () => fired };
}

test('warm selected descendant pages refuse tampering, deletion and transaction-only repairs', (t) => {
  const f = fixture(t);
  for (const row of [f.ancestors[0]!, f.ancestors.at(-1)!]) {
    for (const corrupt of ['{}', '🌿'.repeat(9000), null]) {
      assert.equal(f.read(), 'fictional-0');
      if (corrupt === null) f.db.prepare('DELETE FROM main.app_meta WHERE key=?').run(row.key);
      else f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(corrupt, row.key);
      assert.throws(f.read, /tree|schema|collection|stored row bytes|encoded bytes/);
      restore(f.db, row);
      assert.equal(f.read(), 'fictional-0');
    }
  }
  const leaf = f.ancestors.at(-1)!;
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
  f.db.exec('SAVEPOINT fictional_temporary_repair');
  try {
    restore(f.db, leaf);
    assert.equal(f.read(), 'fictional-0');
    const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
    f.db.exec('ROLLBACK TO fictional_temporary_repair; RELEASE fictional_temporary_repair');
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.throws(
      f.read,
      /tree|schema|collection/,
      'a savepoint read cannot certify repaired bytes',
    );
  } finally {
    if (f.db.isTransaction)
      f.db.exec('ROLLBACK TO fictional_temporary_repair; RELEASE fictional_temporary_repair');
    restore(f.db, leaf);
  }
  assert.equal(f.read(), 'fictional-0');
});

test('TEMP app_meta shadow invalidates warm pages and pre-existing prepared readers', (t) => {
  const f = fixture(t),
    leaf = f.ancestors.at(-1)!;
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.db.exec(
    `CREATE TEMP VIEW app_meta AS SELECT key, CASE WHEN key=${sqlLiteral(leaf.key)} THEN '{}' ELSE value END AS value FROM main.app_meta`,
  );
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(
    f.read,
    /tree|schema|collection/,
    'SQLite automatically rebinds the existing reader to the TEMP view',
  );
  f.db.exec('DROP VIEW temp.app_meta');
  assert.equal(f.read(), 'fictional-0');
});

test('cached collection nodes cannot outlive missing, corrupt or replaced accepted HEAD authority', (t) => {
  const f = fixture(t),
    other = fixture(t);
  const original = Buffer.from(f.authority.objects.get('head')!);
  const replacement = Buffer.from(other.authority.objects.get('head')!);
  assert.notDeepEqual(replacement, original);
  for (const changed of [null, Buffer.from('{}'), replacement]) {
    const hits = intakeWorkCounters(f.db).warm.collectionNodeCacheHits;
    assert.equal(f.read(), 'fictional-0');
    assert.ok(intakeWorkCounters(f.db).warm.collectionNodeCacheHits > hits);
    const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
    if (changed === null) f.authority.objects.delete('head');
    else f.authority.objects.set('head', changed);
    try {
      assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
      assert.throws(
        f.read,
        /invalid head|accepted authority requires configured current projection/,
      );
    } finally {
      f.authority.objects.set('head', Buffer.from(original));
    }
    assert.equal(f.read(), 'fictional-0');
  }
});

test('collection state returns detached selected logical and build descriptors, including absence', (t) => {
  const f = fixture(t);
  const selected = f.store.collection(f.store.openView(), 'logical', 'values');
  const initial = f.store.collectionState('logical', 'values', true);
  assert.deepEqual(initial.logical, f.store.binding(f.store.openView())!.logical);
  assert.deepEqual(initial.collection, selected);
  assert.equal(initial.buildCollection, undefined);
  assert.deepEqual(f.store.collectionState('logical', 'missing', true), {
    logical: initial.logical,
    collection: undefined,
    buildCollection: undefined,
  });

  const operationId = randomUUID();
  const prepared = f.store.prepare(f.store.openView(), {
    operationId,
    requestDigest: digest(operationId),
    domainVersion: 1,
    changes: [
      { area: 'builds', collection: 'values', op: 'put', key: 'only-build', value: 'draft' },
    ],
  });
  transaction(f.db, () => f.store.stage(prepared));
  const state = f.store.collectionState('logical', 'values', true);
  assert.deepEqual(
    state.logical,
    initial.logical,
    'auxiliary publication does not alter logical state',
  );
  assert.deepEqual(state.collection, selected);
  assert.deepEqual(
    state.buildCollection,
    f.store.collection(f.store.openView(), 'builds', 'values'),
  );
  assert.deepEqual(
    f.store.collectionState('builds', 'values', true).collection,
    state.buildCollection,
  );
  assert.deepEqual(
    f.store.collectionState('builds', 'values', true).buildCollection,
    state.buildCollection,
  );
  assert.equal(f.store.collectionState('logical', 'values').buildCollection, undefined);
  state.logical!.domainVersion = 999;
  state.collection!.root!.count = 999;
  state.buildCollection!.root!.count = 999;
  const fresh = f.store.collectionState('logical', 'values', true);
  assert.equal(fresh.logical!.domainVersion, 1);
  assert.notEqual(fresh.collection!.root!.count, 999);
  assert.notEqual(fresh.buildCollection!.root!.count, 999);
});

test('collection state rejects invalid primitives and transaction-only repairs cannot seed later reads', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.collectionState('other' as 'logical', 'values'), /collection area/);
  assert.throws(() => f.store.collectionState('logical', ''), /collection name/);
  assert.throws(
    () => f.store.collectionState('logical', 'values', 'yes' as unknown as boolean),
    /collection build selector/,
  );
  const directoryKey = f.prefix + 'node:' + f.store.binding(f.store.openView())!.logical.root!.hash;
  const directory = {
    key: directoryKey,
    raw: String(
      f.db.prepare('SELECT value FROM main.app_meta WHERE key=?').get(directoryKey)!.value,
    ),
  };
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', directory.key);
  f.db.exec('SAVEPOINT fictional_state_repair');
  try {
    restore(f.db, directory);
    assert.deepEqual(
      f.store.collectionState('logical', 'values').collection,
      f.store.collection(f.store.openView(), 'logical', 'values'),
      'transaction reads use current raw authority',
    );
    f.db.exec('ROLLBACK TO fictional_state_repair; RELEASE fictional_state_repair');
    assert.throws(() => f.store.collectionState('logical', 'values'), /tree|schema|collection/);
  } finally {
    if (f.db.isTransaction)
      f.db.exec('ROLLBACK TO fictional_state_repair; RELEASE fictional_state_repair');
    restore(f.db, directory);
  }
  assert.ok(f.store.collectionState('logical', 'values').collection);
});

function duringCollectionState(f: ReturnType<typeof fixture>, mutate: () => void) {
  const prior = f.authority.storage.read;
  const before = { ...intakeWorkCounters(f.db).warm };
  let fired = false;
  f.authority.storage.read = (name) => {
    const work = intakeWorkCounters(f.db).warm;
    if (
      name === 'head' &&
      !fired &&
      work.collectionNodeReads + work.collectionNodeCacheHits >
        before.collectionNodeReads + before.collectionNodeCacheHits
    ) {
      fired = true;
      mutate();
    }
    return prior(name);
  };
  return {
    read: () => f.store.collectionState('logical', 'values', true),
    fired: () => fired,
    restore: () => {
      f.authority.storage.read = prior;
    },
  };
}

for (const kind of [
  'physical-head',
  'local-restored',
  'peer-restored',
  'main-schema',
  'temp-schema',
  'registry',
] as const)
  test(`collection state refuses closing authority drift: ${kind}`, (t) => {
    const f = fixture(t);
    const originalHead = Buffer.from(f.authority.objects.get('head')!);
    const leaf = f.ancestors.at(-1)!;
    const peer = kind === 'peer-restored' ? new DatabaseSync(f.file) : undefined;
    const pending = duringCollectionState(f, () => {
      if (kind === 'physical-head') f.authority.objects.delete('head');
      else if (kind === 'registry') clearIntakeStateCache(f.db);
      else if (kind === 'main-schema') f.db.exec('CREATE TABLE fictional_state_drift(value TEXT)');
      else if (kind === 'temp-schema')
        f.db.exec('CREATE TEMP TABLE fictional_state_drift(value TEXT)');
      else {
        const writer = peer ?? f.db;
        writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
        restore(writer, leaf);
      }
    });
    try {
      assert.throws(pending.read, /head|authority|changed|stale|generation|collection|read/i);
      assert.equal(pending.fired(), true, 'the mutation follows actual selected node work');
    } finally {
      pending.restore();
      peer?.close();
      f.authority.objects.set('head', originalHead);
    }
    assert.ok(f.store.collectionState('logical', 'values').collection);
  });

for (const scoped of [false, true])
  for (const kind of [
    'local-restored',
    'peer-restored',
    'main-schema',
    'temp-schema',
    'registry',
  ] as const) {
    test(`a ${scoped ? 'prefix-scoped' : 'bounded'} range refuses whole-call generation drift: ${kind}`, (t) => {
      const f = fixture(t),
        leaf = f.ancestors.at(-1)!;
      const peer = kind === 'peer-restored' ? new DatabaseSync(f.file) : undefined;
      try {
        const pending = duringRange(
          f,
          () => {
            if (kind === 'registry') clearIntakeStateCache(f.db);
            else if (kind === 'main-schema')
              f.db.exec('CREATE TABLE fictional_read_drift(value TEXT)');
            else if (kind === 'temp-schema')
              f.db.exec('CREATE TEMP TABLE fictional_read_drift(value TEXT)');
            else {
              const writer = peer ?? f.db;
              writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
              restore(writer, leaf);
            }
          },
          scoped,
        );
        assert.throws(pending.read, /changed|stale|generation|collection|read/i);
        assert.equal(pending.fired(), true);
        assert.equal(f.read(), 'fictional-0', 'a new call may authenticate the final exact state');
      } finally {
        peer?.close();
      }
    });
  }

test('nested read and rolled-back mutation cannot rebase an outer range certificate', (t) => {
  const f = fixture(t);
  const pending = duringRange(f, () => {
    assert.equal(f.read(), 'fictional-0');
    f.db.exec('SAVEPOINT fictional_nested_mutation');
    try {
      f.db
        .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
        .run('fictional-nested', 'changed');
    } finally {
      f.db.exec('ROLLBACK TO fictional_nested_mutation; RELEASE fictional_nested_mutation');
    }
    assert.equal(f.read(), 'fictional-0');
  });
  assert.throws(pending.read, /changed|stale|generation|collection|read/i);
  assert.equal(pending.fired(), true);
  assert.equal(f.read(), 'fictional-0');
});

test('a preparation called by a range getter authenticates raw pages and revokes the outer certificate', (t) => {
  const f = fixture(t);
  const pending = duringRange(f, () => {
    const before = intakeWorkCounters(f.db).warm.collectionNodeReads;
    const operationId = randomUUID();
    const prepared = f.store.prepare(f.store.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 2,
      changes: [{ area: 'logical', collection: 'values', op: 'put', key: '000', value: 'changed' }],
    });
    try {
      assert.ok(
        intakeWorkCounters(f.db).warm.collectionNodeReads > before,
        'mutation preparation authenticates its own raw pages even when the outer read is warm',
      );
    } finally {
      f.store.disposePreparation(prepared);
    }
  });
  assert.throws(pending.read, /collection read authority changed/);
  assert.equal(pending.fired(), true);
  assert.equal(f.read(), 'fictional-0');
});

test('warm hashes do not authorize forged full tree references', (t) => {
  const f = fixture(t);
  const headKey = f.prefix + 'head';
  const originalHead = String(
    f.db.prepare('SELECT value FROM main.app_meta WHERE key=?').get(headKey)!.value,
  );
  const head = JSON.parse(originalHead);
  const directory = JSON.parse(
    String(
      f.db
        .prepare('SELECT value FROM main.app_meta WHERE key=?')
        .get(f.prefix + 'node:' + head.logical.root.hash)!.value,
    ),
  );
  assert.equal(directory.key, 'values');
  const descriptor = JSON.parse(directory.value);
  descriptor.root.count++;
  directory.value = JSON.stringify(descriptor);
  const forged = JSON.stringify(directory);
  const hash = digest(forged);
  f.db
    .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
    .run(f.prefix + 'node:' + hash, forged);
  head.logical.root.hash = hash;
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(JSON.stringify(head), headKey);
  assert.throws(f.read, /reference|descriptor|count/);
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(originalHead, headKey);
  assert.equal(f.read(), 'fictional-0');
});

test('throwing getters, registry invalidation and foreign handles cannot retain read authority', (t) => {
  const f = fixture(t);
  const cancellation = Error('Fictional read cancellation');
  const cancelled = duringRange(f, () => {
    throw cancellation;
  });
  assert.throws(cancelled.read, (error) => error === cancellation);
  assert.equal(cancelled.fired(), true);
  assert.equal(f.read(), 'fictional-0');
  const old = f.store.openView();
  clearIntakeStateCache(f.db);
  assert.throws(() => f.store.get(old, 'logical', 'values', '000'), /foreign|expired/);
  assert.equal(f.read(), 'fictional-0');
  for (const changed of [
    { profileId: 'foreign-profile' },
    { intakeId: 'foreign-source' },
    { sourceHash: '8'.repeat(64) },
  ]) {
    assert.throws(() => {
      const foreign = createIntakeStateStorage(f.db, { ...f.identity, ...changed }).collections;
      foreign.get(foreign.openView(), 'logical', 'values', '000');
    }, /owner|source|original/);
  }
  const other = fixture(t);
  assert.throws(
    () => other.store.get(f.store.openView(), 'logical', 'values', '000'),
    /foreign|expired/,
  );
  const closing = duringRange(f, () => f.db.close());
  assert.throws(closing.read, /closed|not open|authority changed/i);
  assert.equal(closing.fired(), true);
});

// Input callbacks follow retained-page authentication, including the selected
// collection directory. No callback may mint a preparation from a mixed basis.
function duringPreparation(f: ReturnType<typeof fixture>, mutate: () => void) {
  const operationId = randomUUID();
  const view = f.store.openView();
  const before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  let fired = false;
  return {
    operationId,
    fired: () => fired,
    prepare: () =>
      f.store.prepare(view, {
        operationId,
        requestDigest: digest(operationId),
        domainVersion: 2,
        changes: [
          { area: 'logical', collection: 'values', op: 'put', key: '000', value: 'changed-0' },
          {
            area: 'logical',
            collection: 'values',
            op: 'put',
            key: '001',
            get value() {
              if (!fired) {
                assert.ok(
                  intakeWorkCounters(f.db).warm.collectionNodeReads > before,
                  'the callback follows actual retained-page authentication',
                );
                fired = true;
                mutate();
              }
              return 'changed-1';
            },
          },
        ],
      }),
  };
}

for (const kind of [
  'local-restored',
  'peer-restored',
  'main-schema',
  'temp-schema',
  'registry',
] as const)
  test(`bounded preparation refuses whole-call authority drift: ${kind}`, (t) => {
    const f = fixture(t),
      leaf = f.ancestors.at(-1)!;
    const peer = kind === 'peer-restored' ? new DatabaseSync(f.file) : undefined;
    try {
      const pending = duringPreparation(f, () => {
        if (kind === 'registry') clearIntakeStateCache(f.db);
        else if (kind === 'main-schema')
          f.db.exec('CREATE TABLE fictional_prepare_drift(value TEXT)');
        else if (kind === 'temp-schema')
          f.db.exec('CREATE TEMP TABLE fictional_prepare_drift(value TEXT)');
        else {
          const writer = peer ?? f.db;
          writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
          restore(writer, leaf);
        }
      });
      assert.throws(pending.prepare, /changed|stale|generation|collection|read/i);
      assert.equal(pending.fired(), true);
      assert.equal(f.store.replay(pending.operationId, digest(pending.operationId)), undefined);
      assert.equal(f.read(), 'fictional-0', 'no prepared replacement was published');
      const fresh = duringPreparation(f, () => {});
      const prepared = fresh.prepare();
      if (kind === 'local-restored') {
        // Restoring raw bytes is not authorization to journal a direct SQL write.
        assert.throws(
          () => transaction(f.db, () => f.store.stage(prepared)),
          /uncommitted direct writes/,
        );
        f.store.disposePreparation(prepared);
        assert.equal(f.read(), 'fictional-0');
      } else {
        const result = transaction(f.db, () => f.store.stage(prepared));
        assert.equal(f.read(), 'changed-0');
        assert.deepEqual(f.store.replay(fresh.operationId, digest(fresh.operationId)), result);
      }
    } finally {
      peer?.close();
    }
  });

for (const kind of ['missing', 'corrupt', 'replaced'] as const)
  test(`bounded preparation refuses changed physical authority after page reads: ${kind}`, (t) => {
    const f = fixture(t),
      other = fixture(t);
    const original = Buffer.from(f.authority.objects.get('head')!);
    const pending = duringPreparation(f, () => {
      if (kind === 'missing') f.authority.objects.delete('head');
      else
        f.authority.objects.set(
          'head',
          kind === 'corrupt'
            ? Buffer.from('{}')
            : Buffer.from(other.authority.objects.get('head')!),
        );
    });
    try {
      assert.throws(
        pending.prepare,
        /invalid head|accepted authority requires configured current projection|collection/i,
      );
      assert.equal(pending.fired(), true);
    } finally {
      f.authority.objects.set('head', original);
    }
    assert.equal(f.read(), 'fictional-0');
    assert.equal(f.store.replay(pending.operationId, digest(pending.operationId)), undefined);
  });

test('nested preparation revokes its caller and cannot retain a provisional capability', (t) => {
  const f = fixture(t);
  let nested: ReturnType<typeof f.store.prepare> | undefined;
  const pending = duringPreparation(f, () => {
    nested = duringPreparation(f, () => {}).prepare();
  });
  assert.throws(pending.prepare, /collection read authority changed/);
  assert.equal(pending.fired(), true);
  assert.ok(nested);
  assert.throws(() => f.store.inspectPrepared(nested!), /expired|foreign|preparation/);
  assert.equal(f.read(), 'fictional-0');
});

test('cancelled preparation cannot certify retained pages or expose a partial result', (t) => {
  const f = fixture(t);
  const cancellation = Error('Fictional preparation cancellation');
  const pending = duringPreparation(f, () => {
    throw cancellation;
  });
  assert.throws(pending.prepare, (error) => error === cancellation);
  assert.equal(pending.fired(), true);
  assert.equal(f.store.replay(pending.operationId, digest(pending.operationId)), undefined);
  const leaf = f.ancestors.at(-1)!;
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
  assert.throws(f.read, /tree|schema|collection/);
  restore(f.db, leaf);
  assert.equal(f.read(), 'fictional-0');
});

test('transaction-only preparation cannot certify a rolled-back raw-page repair', (t) => {
  const f = fixture(t),
    leaf = f.ancestors.at(-1)!;
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', leaf.key);
  f.db.exec('SAVEPOINT fictional_preparation_repair');
  try {
    restore(f.db, leaf);
    const repaired = duringPreparation(f, () => {}).prepare();
    f.store.disposePreparation(repaired);
    const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
    f.db.exec('ROLLBACK TO fictional_preparation_repair; RELEASE fictional_preparation_repair');
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.throws(() => duringPreparation(f, () => {}).prepare(), /tree|schema|collection/);
  } finally {
    if (f.db.isTransaction)
      f.db.exec('ROLLBACK TO fictional_preparation_repair; RELEASE fictional_preparation_repair');
    restore(f.db, leaf);
  }
  assert.equal(f.read(), 'fictional-0');
});

for (const kind of ['registry', 'nested-preparation'] as const)
  test(`transaction-bound preparation refuses a completed-batch lifecycle change: ${kind}`, (t) => {
    const f = fixture(t);
    const operationId = randomUUID();
    const before = intakeWorkCounters(f.db).warm.collectionPreparedBytes;
    let fired = false;
    let outer: ReturnType<typeof f.store.prepare> | undefined;
    let nested: ReturnType<typeof f.store.prepare> | undefined;
    assert.throws(
      () =>
        transaction(f.db, () => {
          outer = f.store.prepare(f.store.openView(), {
            operationId,
            requestDigest: digest(operationId),
            domainVersion: 2,
            changes: [
              { area: 'logical', collection: 'values', op: 'put', key: '000', value: 'changed-0' },
              { area: 'logical', collection: 'values', op: 'put', key: '001', value: 'changed-1' },
              { area: 'logical', collection: 'values', op: 'delete', key: '099' },
              {
                area: 'logical',
                collection: 'values',
                op: 'put',
                key: '002',
                get value() {
                  assert.ok(
                    intakeWorkCounters(f.db).warm.collectionPreparedBytes > before,
                    'the getter follows an actual completed grouped batch',
                  );
                  assert.equal(fired, false);
                  fired = true;
                  if (kind === 'registry') clearIntakeStateCache(f.db);
                  else {
                    const nestedId = randomUUID();
                    nested = f.store.prepare(f.store.openView(), {
                      operationId: nestedId,
                      requestDigest: digest(nestedId),
                      domainVersion: 1,
                      changes: [
                        {
                          area: 'builds',
                          collection: 'fictional-nested',
                          op: 'put',
                          key: 'key',
                          value: 'value',
                        },
                      ],
                    });
                  }
                  return 'changed-2';
                },
              },
            ],
          });
          return f.store.stage(outer);
        }),
      /changed|stale|generation|collection|preparation/i,
    );
    assert.equal(fired, true);
    assert.equal(outer, undefined, 'the revoked preparation must not escape its call');
    if (kind === 'nested-preparation') {
      assert.ok(nested);
      assert.throws(() => f.store.inspectPrepared(nested!), /expired|foreign|preparation/);
    }
    assert.equal(f.store.replay(operationId, digest(operationId)), undefined);
    for (let n = 0; n < 3; n++)
      assert.equal(
        f.store.get(f.store.openView(), 'logical', 'values', String(n).padStart(3, '0')),
        `fictional-${n}`,
      );
    const fresh = duringPreparation(f, () => {});
    const result = transaction(f.db, () => f.store.stage(fresh.prepare()));
    assert.equal(f.read(), 'changed-0');
    assert.deepEqual(f.store.replay(fresh.operationId, digest(fresh.operationId)), result);
  });

for (const kind of ['peer-restored', 'registry'] as const)
  test(`completed map batches cannot rebase preparation authority across a barrier: ${kind}`, (t) => {
    const f = fixture(t);
    const peer = kind === 'peer-restored' ? new DatabaseSync(f.file) : undefined;
    const leaf = f.ancestors.at(-1)!;
    const operationId = randomUUID();
    const before = intakeWorkCounters(f.db).warm.collectionPreparedBytes;
    let fired = false;
    try {
      assert.throws(
        () =>
          f.store.prepare(f.store.openView(), {
            operationId,
            requestDigest: digest(operationId),
            domainVersion: 2,
            changes: [
              { area: 'logical', collection: 'values', op: 'put', key: '000', value: 'changed-0' },
              { area: 'logical', collection: 'values', op: 'put', key: '001', value: 'changed-1' },
              { area: 'logical', collection: 'values', op: 'delete', key: '099' },
              {
                area: 'logical',
                collection: 'values',
                op: 'put',
                key: '002',
                get value() {
                  assert.ok(
                    intakeWorkCounters(f.db).warm.collectionPreparedBytes > before,
                    'the first grouped batch has already prepared real tree nodes',
                  );
                  assert.equal(fired, false);
                  fired = true;
                  if (peer) {
                    peer
                      .prepare('UPDATE main.app_meta SET value=? WHERE key=?')
                      .run('{}', leaf.key);
                    restore(peer, leaf);
                  } else clearIntakeStateCache(f.db);
                  return 'changed-2';
                },
              },
            ],
          }),
        /changed|stale|generation|collection|preparation/i,
      );
      assert.equal(fired, true);
      assert.equal(f.store.replay(operationId, digest(operationId)), undefined);
      for (let n = 0; n < 3; n++)
        assert.equal(
          f.store.get(f.store.openView(), 'logical', 'values', String(n).padStart(3, '0')),
          `fictional-${n}`,
          'neither the earlier batch nor the later batch was published',
        );
      const fresh = duringPreparation(f, () => {});
      const result = transaction(f.db, () => f.store.stage(fresh.prepare()));
      assert.equal(f.read(), 'changed-0');
      assert.deepEqual(f.store.replay(fresh.operationId, digest(fresh.operationId)), result);
    } finally {
      peer?.close();
    }
  });
