import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  transaction,
  registerTransactionDurability,
  observeTransactionOutcome,
  type Database,
} from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'intake-state-'));
  const dbs: Database[] = [];
  const objects = new Map<string, Buffer>();
  let failedHead = false;
  let failedImmutable = false;
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
      if (failedImmutable) {
        failedImmutable = false;
        throw Error('fictional immutable write failure');
      }
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      if (failedHead) throw Error('ambiguous publication');
    },
  };
  const identity = {
    profileId: 'fictional-primitive',
    intakeId: 'fictional-source',
    sourceHash: '1'.repeat(64),
  };
  const db = openDatabase(join(root, 'current.sqlite'), identity.profileId);
  dbs.push(db);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, 'fictional.txt', identity.sourceHash, 0, 'intake_original', '{}');
  attachRecordDurability(db, { profileId: identity.profileId, storage });
  const open = () => {
    const path = join(root, `${randomUUID()}.sqlite`);
    rebuildRecordDatabase(path, { profileId: identity.profileId, storage });
    const next = openDatabase(path, identity.profileId);
    attachRecordDurability(next, { profileId: identity.profileId, storage });
    dbs.push(next);
    return next;
  };
  t.after(() => {
    for (const item of dbs) {
      clearIntakeStateCache(item);
      item.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    identity,
    objects,
    open,
    failImmutable: () => {
      failedImmutable = true;
    },
    ambiguous: () => {
      failedHead = true;
    },
  };
}
test('exact JSON changes, operation replay, private snapshots, outer staged writes and rollback', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  assert.equal(store.read(), undefined);
  assert.throws(() => store.stage({}, randomUUID()), /requires application transaction/);
  const first = {
    rows: [{ name: 'fictional 😀', value: null }, { name: 'remove' }],
    text: 'A😀Z',
    gone: true,
  };
  const id = randomUUID();
  const result = store.mutate(first, id);
  first.text = 'caller changed';
  assert.deepEqual(store.read(), {
    rows: [{ name: 'fictional 😀', value: null }, { name: 'remove' }],
    text: 'A😀Z',
    gone: true,
  });
  const replay = store.mutate(
    { rows: [{ name: 'fictional 😀', value: null }, { name: 'remove' }], text: 'A😀Z', gone: true },
    id,
  );
  assert.deepEqual(replay, result);
  assert.throws(() => store.mutate({ text: 'conflict' }, id), /different request/);
  const next = { rows: [{ name: 'fictional 😀' }], text: 'A𝄞Z', added: null };
  transaction(db, () => {
    store.stage(next, randomUUID());
    assert.deepEqual(store.read(), next);
    store.stage({ final: [null, ''] }, randomUUID());
    assert.deepEqual(store.read(), { final: [null, ''] });
  });
  assert.deepEqual(store.read(), { final: [null, ''] });
  assert.throws(
    () =>
      transaction(db, () => {
        store.stage({ lost: true }, randomUUID());
        throw Error('outer rollback');
      }),
    /outer rollback/,
  );
  assert.deepEqual(store.read(), { final: [null, ''] });
  const alias = store.read() as { final: unknown[] };
  alias.final.push('mutable caller');
  assert.deepEqual(store.read(), { final: [null, ''] });
  clearIntakeStateCache(db);
  assert.deepEqual(store.read(), { final: [null, ''] });
});
test('failed staged SQL poisons caught outer transaction and retains the committed basis', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  store.mutate({ step: 0 }, randomUUID());
  db.exec(
    "CREATE TEMP TRIGGER reject_intake BEFORE INSERT ON app_meta WHEN NEW.key GLOB 'intake_state_v1:*:frame:*' BEGIN SELECT RAISE(ABORT,'fictional write failure'); END",
  );
  assert.throws(
    () =>
      transaction(db, () => {
        try {
          store.stage({ step: 1 }, randomUUID());
        } catch {}
        return { small: true };
      }),
    /fictional write failure/,
  );
  db.exec('DROP TRIGGER reject_intake');
  assert.deepEqual(store.read(), { step: 0 });
  store.mutate({ step: 2 }, randomUUID());
  assert.deepEqual(store.read(), { step: 2 });
});
test('scopes, missing or corrupt evidence and unsupported identities fail without reset', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  store.mutate({ test: 'Unicode😀' }, randomUUID());
  assert.throws(
    () => createIntakeStateStorage(db, { ...identity, sourceHash: '2'.repeat(64) }).read(),
    /original source/,
  );
  assert.throws(
    () => createIntakeStateStorage(db, { ...identity, profileId: 'other' }).read(),
    /database owner/,
  );
  assert.throws(
    () =>
      createIntakeStateStorage(db, {
        ...identity,
        sourceHash: ['1'.repeat(64)] as unknown as string,
      }),
    /hash/,
  );
  const row = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' LIMIT 1")
    .get()!;
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(String(row.value) + ' ', row.key!);
  clearIntakeStateCache(db);
  assert.throws(() => store.read(), /bytes\/hash/);
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(row.value!, row.key!);
  db.prepare("DELETE FROM app_meta WHERE key GLOB 'intake_state_v1:*:head'").run();
  assert.throws(() => store.read(), /missing head/);
});
test('warm cumulative bounds reject before staging and cold reconstruction uses identical limits', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity, { limits: { stringWork: 220 } });
  store.mutate({ text: 'x'.repeat(100) }, randomUUID());
  store.mutate({ text: 'x'.repeat(100) + 'a' }, randomUUID());
  store.mutate({ text: 'x'.repeat(100) + 'ab' }, randomUUID());
  const saved = new Map(
    db
      .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*'")
      .all()
      .map((r) => [r.key, r.value]),
  );
  assert.throws(
    () => store.mutate({ text: 'x'.repeat(100) + 'abc' }, randomUUID()),
    /decoded work limit/,
  );
  assert.deepEqual(
    new Map(
      db
        .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*'")
        .all()
        .map((r) => [r.key, r.value]),
    ),
    saved,
  );
  clearIntakeStateCache(db);
  assert.deepEqual(store.read(), { text: 'x'.repeat(100) + 'ab' });
  assert.throws(
    () => createIntakeStateStorage(db, identity, { limits: { stringWork: 200 } }).read(),
    /cumulative limit/,
  );
});
test('accepted publication followed by failure refuses stale projection and reopens actual accepted state', (t) => {
  const { db, identity, open, ambiguous } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  store.mutate({ step: 0 }, randomUUID());
  const operationId = randomUUID();
  ambiguous();
  assert.throws(() => store.mutate({ step: 1 }, operationId), /ambiguous publication/);
  assert.throws(() => store.read(), /accepted authority/);
  const recovered = createIntakeStateStorage(open(), identity);
  assert.deepEqual(recovered.read(), { step: 1 });
  assert.equal(recovered.mutate({ step: 1 }, operationId).version, 2);
});
test('transaction outcome is additive, late-registered, replay-aware and fails on release ambiguity', (t) => {
  const { db } = fixture(t);
  const events: string[] = [];
  registerTransactionDurability(db, {
    capture: () => {
      events.push('capture');
      return true;
    },
    prepare: () => {
      events.push('prepare');
    },
    flush: () => {
      events.push('flush');
    },
    release: () => {
      events.push('release');
    },
  });
  observeTransactionOutcome(db, () => {
    throw Error('observer fault');
  });
  transaction(db, () => {
    events.push('fn');
    observeTransactionOutcome(db, (o) => events.push(`outcome:${o.committed}:${o.succeeded}`));
    return { bounded: true };
  });
  assert.deepEqual(events, ['capture', 'fn', 'prepare', 'flush', 'release', 'outcome:true:true']);
  events.length = 0;
  registerTransactionDurability(db, {
    begin: () => ({ replayed: true, result: { replay: true } }),
    prepare: () => assert.fail('prepare replay'),
    release: () => {
      events.push('release');
    },
  });
  assert.deepEqual(
    transaction(db, () => assert.fail('fn replay')),
    { replay: true },
  );
  assert.deepEqual(events, ['release', 'outcome:true:true']);
  events.length = 0;
  registerTransactionDurability(db, {
    prepare: () => {},
    release: () => {
      throw Error('release fault');
    },
  });
  assert.throws(() => transaction(db, () => ({ bounded: true })), /release fault/);
  assert.deepEqual(events, ['outcome:true:false']);
});

test('noop receipt, staged replay after later mutation, caller close and frame head failure', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  const initial = randomUUID();
  store.mutate({ value: null }, initial);
  const noop = store.mutate({ value: null }, randomUUID());
  assert.equal(noop.changed, false);
  const operationId = randomUUID();
  const first = transaction(db, () => store.stage({ value: 'first' }, operationId));
  store.mutate({ value: 'later' }, randomUUID());
  assert.deepEqual(
    transaction(db, () => store.stage({ value: 'first' }, operationId)),
    first,
  );
  assert.deepEqual(store.read(), { value: 'later' });
  assert.throws(
    () => transaction(db, () => store.stage({ value: 'conflict' }, operationId)),
    /replay conflict/,
  );
  db.exec(
    "CREATE TEMP TRIGGER reject_intake_head BEFORE UPDATE ON app_meta WHEN NEW.key GLOB 'intake_state_v1:*:head' BEGIN SELECT RAISE(ABORT,'fictional head failure'); END",
  );
  assert.throws(() => store.mutate({ value: 'lost' }, randomUUID()), /fictional head failure/);
  db.exec('DROP TRIGGER reject_intake_head');
  clearIntakeStateCache(db);
  assert.deepEqual(store.read(), { value: 'later' });
  store.close();
  assert.throws(() => store.read(), /closed/);
  assert.deepEqual(createIntakeStateStorage(db, identity).read(), { value: 'later' });
});

test('immutable accepted write failure leaves prior authority and permits bounded retry', (t) => {
  const { db, identity, objects, failImmutable } = fixture(t);
  const store = createIntakeStateStorage(db, identity);
  store.mutate({ step: 0 }, randomUUID());
  const accepted = Buffer.from(objects.get('head')!);
  const operationId = randomUUID();
  failImmutable();
  assert.throws(() => store.mutate({ step: 1 }, operationId), /immutable write failure/);
  assert.deepEqual(objects.get('head'), accepted);
  assert.deepEqual(store.read(), { step: 0 });
  store.mutate({ step: 1 }, operationId);
  assert.deepEqual(store.read(), { step: 1 });
});

test('flush ambiguity emits committed failure without changing durability ordering', (t) => {
  const { db } = fixture(t);
  const events: string[] = [];
  registerTransactionDurability(db, {
    prepare: () => {
      events.push('prepare');
    },
    flush: () => {
      events.push('flush');
      throw Error('flush ambiguity');
    },
    release: () => {
      events.push('release');
    },
  });
  observeTransactionOutcome(db, (o) => events.push(`outcome:${o.committed}:${o.succeeded}`));
  assert.throws(
    () =>
      transaction(db, () => {
        events.push('fn');
        return { small: true };
      }),
    /flush ambiguity/,
  );
  assert.deepEqual(events, ['fn', 'prepare', 'flush', 'release', 'outcome:true:false']);
});
