import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';

const profileId = 'fictional-state-growth';
const intakeId = 'fictional-original';
const sourceHash = 'a'.repeat(64);
const scope = { profileId, intakeId, sourceHash };

test('large Unicode state and 300 tiny mutations retain bounded contributions and total authority growth', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'intake-state-growth-'));
  const opened: Database[] = [];
  const objects = new Map<string, Buffer>();
  const recordStorage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, value) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
    },
    publishHead: (value) => {
      objects.set('head', Buffer.from(value));
    },
  };
  const open = (name: string) => {
    const db = openDatabase(join(root, name), profileId);
    opened.push(db);
    return db;
  };
  const db = open('current.sqlite');
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(intakeId, 'independently-fictional-original.txt', sourceHash, 123, 'intake_original', '{}');
  attachRecordDurability(db, { profileId, storage: recordStorage });
  const originals = new Map(
    [...objects]
      .filter(([name]) => name !== 'head')
      .map(([name, value]) => [name, Buffer.from(value)]),
  );
  const originalRow = db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId);
  const state = createIntakeStateStorage(db, scope);
  t.after(() => {
    for (const database of opened) {
      clearIntakeStateCache(database);
      database.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const literal = 'Independently fictional Unicode Ω 🦊 café. '.repeat(2500);
  assert.ok(Buffer.byteLength(literal) > 100_000);
  const initial = {
    workflow: { step: 0, literal, nullable: null, nested: [{ label: 'fictional', enabled: true }] },
  };
  const initialized = state.mutate(initial, randomUUID());
  assert.equal(initialized.changed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(initialized)) < 512);
  assert.equal(Object.hasOwn(initialized, 'state'), false);
  assert.ok(
    state.counters.framesWritten >= 4,
    'initial Unicode value is linked across bounded frames',
  );
  const afterInitialCounters = { ...state.counters };
  const measure = () => {
    const primitive = db
      .prepare(
        "SELECT count(*) rows,sum(length(CAST(value AS BLOB))) bytes,max(length(CAST(value AS BLOB))) max_bytes FROM app_meta WHERE key LIKE 'intake_state_v1:%'",
      )
      .get()!;
    const versions = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(contents_json AS BLOB))) contents_bytes,sum(length(CAST(metadata_json AS BLOB))) metadata_bytes FROM __record_versions',
      )
      .get()!;
    const fields = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(field AS BLOB))+coalesce(length(CAST(before_version AS BLOB)),0)+2) reference_bytes FROM __record_fields',
      )
      .get()!;
    const receipts = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(result_json AS BLOB))) result_bytes,max(length(CAST(result_json AS BLOB))) max_result_bytes,sum(length(CAST(commit_json AS BLOB))) commit_bytes FROM __record_transactions',
      )
      .get()!;
    const allocation =
      Number(db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(db.prepare('PRAGMA page_size').get()!.page_size);
    const authority = [...objects.values()].reduce((sum, value) => sum + value.length, 0);
    return {
      primitive,
      versions,
      fields,
      receipts,
      allocatedBytes: allocation,
      authorityBytes: authority,
      authorityObjects: objects.size,
      counters: { ...state.counters },
    };
  };
  const initialMeasurement = measure();
  const samples: Array<ReturnType<typeof measure> & { edits: number }> = [];
  let latest = initial;
  let normalizedBytes = Buffer.byteLength(JSON.stringify(initial));
  for (let step = 1; step <= 300; step++) {
    latest = { workflow: { ...initial.workflow, step } };
    normalizedBytes += Buffer.byteLength(JSON.stringify(latest));
    const beforeFrames = state.counters.framesWritten;
    const beforeBytes = state.counters.frameBytesWritten;
    const result = state.mutate(latest, randomUUID());
    assert.equal(result.changed, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 512);
    assert.ok(state.counters.framesWritten - beforeFrames <= 2);
    assert.ok(
      state.counters.frameBytesWritten - beforeBytes < 4096,
      'tiny edit cannot copy the initial value into its contribution',
    );
    assert.equal(state.counters.ancestorReads, afterInitialCounters.ancestorReads);
    assert.equal(state.counters.normalizedStateBytes, normalizedBytes);
    assert.equal(state.counters.candidateCopyBytes, 0, 'warm replay uses private changed branches');
    assert.equal(state.counters.patchOperations, step + 1);
    if (step % 100 === 0) samples.push({ edits: step, ...measure() });
  }
  assert.deepEqual(state.read(), latest);
  assert.equal(
    db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intakeId)!.details_json,
    '{}',
    'primitive does not cut production intake over',
  );
  assert.deepEqual(db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId), originalRow);
  for (const [name, value] of originals) assert.deepEqual(objects.get(name), value);
  assert.ok(Number(samples[2]!.primitive.max_bytes) <= 64 * 1024);
  assert.ok(
    Number(samples[2]!.receipts.max_result_bytes) < 2048,
    'transaction result cannot contain operational state',
  );
  const authority100 = samples[0]!.authorityBytes - initialMeasurement.authorityBytes;
  const authority300 = samples[2]!.authorityBytes - initialMeasurement.authorityBytes;
  assert.ok(authority100 > 0);
  assert.ok(authority300 < authority100 * 3.2);
  const projectionBytes = (sample: ReturnType<typeof measure>) =>
    Number(sample.versions.contents_bytes) +
    Number(sample.versions.metadata_bytes) +
    Number(sample.fields.reference_bytes) +
    Number(sample.receipts.result_bytes) +
    Number(sample.receipts.commit_bytes);
  const projection100 = projectionBytes(samples[0]!) - projectionBytes(initialMeasurement);
  assert.ok(projection100 > 0);
  assert.ok(
    projectionBytes(samples[2]!) - projectionBytes(initialMeasurement) < projection100 * 3.2,
  );
  const qualification = JSON.stringify({
    initial: initialMeasurement,
    samples,
    scope:
      'Primitive only. Counts include all immutable records, commits, heads and SQLite history; no production intake cutover.',
  });
  t.diagnostic(qualification);

  clearIntakeStateCache(db);
  const cold = createIntakeStateStorage(db, scope);
  assert.deepEqual(cold.read(), latest);
  assert.equal(cold.counters.coldReconstructions, 1);
  const coldAncestorReads = cold.counters.ancestorReads;
  assert.deepEqual(cold.read(), latest);
  assert.equal(cold.counters.ancestorReads, coldAncestorReads);
  const beforeRebuild = new Map([...objects].map(([name, value]) => [name, Buffer.from(value)]));
  rebuildRecordDatabase(join(root, 'rebuilt.sqlite'), { profileId, storage: recordStorage });
  const rebuilt = open('rebuilt.sqlite');
  attachRecordDurability(rebuilt, { profileId, storage: recordStorage });
  const recovered = createIntakeStateStorage(rebuilt, scope);
  assert.deepEqual(recovered.read(), latest);
  assert.deepEqual(
    rebuilt.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId),
    originalRow,
  );
  assert.deepEqual(
    objects,
    beforeRebuild,
    'cache-loss reconstruction cannot rewrite accepted authority',
  );
});

type StateStorage = ReturnType<typeof createIntakeStateStorage>;
function orderFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'intake-order-growth-'));
  const dbs: Database[] = [];
  const objects = new Map<string, Buffer>();
  let acceptedReads = 0;
  const recordStorage: RecordStorage = {
    read(name) {
      acceptedReads++;
      return objects.has(name) ? Buffer.from(objects.get(name)!) : null;
    },
    writeImmutable(name, bytes) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => {
      objects.set('head', Buffer.from(bytes));
    },
  };
  const open = (name: string) => {
    const db = openDatabase(join(root, name), profileId);
    dbs.push(db);
    return db;
  };
  const db = open('current.sqlite');
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    intakeId,
    'independently-fictional-order.txt',
    sourceHash,
    77,
    'intake_original',
    '{"outside":"unchanged","intake":{"raw":"production"}}',
  );
  attachRecordDurability(db, { profileId, storage: recordStorage });
  const original = db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId);
  const store = createIntakeStateStorage(db, scope);
  t.after(() => {
    for (const database of dbs) {
      clearIntakeStateCache(database);
      database.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const measure = () => {
    const meta = (suffix: string) =>
      db
        .prepare(
          'SELECT count(*) rows,coalesce(sum(length(CAST(value AS BLOB))),0) bytes,coalesce(max(length(CAST(value AS BLOB))),0) max_bytes FROM app_meta WHERE key GLOB ?',
        )
        .get(`intake_state_v1:*:${suffix}`)!;
    const versions = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(contents_json AS BLOB))) contents_bytes,sum(length(CAST(metadata_json AS BLOB))) metadata_bytes FROM __record_versions',
      )
      .get()!;
    const fields = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(field AS BLOB))+coalesce(length(CAST(before_version AS BLOB)),0)+2) reference_bytes FROM __record_fields',
      )
      .get()!;
    const transactions = db
      .prepare(
        'SELECT count(*) rows,sum(length(CAST(result_json AS BLOB))) result_bytes,max(length(CAST(result_json AS BLOB))) max_result_bytes,sum(length(CAST(commit_json AS BLOB))) commit_bytes FROM __record_transactions',
      )
      .get()!;
    return {
      frames: meta('frame:*'),
      head: meta('head'),
      receipts: meta('operation:*'),
      versions,
      fields,
      transactions,
      allocatedBytes:
        Number(db.prepare('PRAGMA page_count').get()!.page_count) *
        Number(db.prepare('PRAGMA page_size').get()!.page_size),
      authorityBytes: [...objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      authorityObjects: objects.size,
      acceptedReads,
      counters: { ...store.counters },
    };
  };
  const rebuild = () => {
    const accepted = new Map([...objects].map(([name, bytes]) => [name, Buffer.from(bytes)]));
    rebuildRecordDatabase(join(root, 'rebuilt.sqlite'), { profileId, storage: recordStorage });
    const rebuilt = open('rebuilt.sqlite');
    attachRecordDurability(rebuilt, { profileId, storage: recordStorage });
    assert.deepEqual(objects, accepted, 'accepted rebuild must not write authority');
    assert.deepEqual(
      rebuilt.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId),
      original,
    );
    return createIntakeStateStorage(rebuilt, scope);
  };
  return { db, store, original, measure, rebuild };
}

function mutationWork(store: StateStorage) {
  return {
    frameBytes: store.counters.frameBytesWritten,
    frames: store.counters.framesWritten,
    copies: store.counters.candidateCopies,
    copiedBytes: store.counters.candidateCopyBytes,
    normalizedBytes: store.counters.normalizedStateBytes,
    reads: store.counters.ancestorReads,
  };
}

type OrderMeasurement = ReturnType<ReturnType<typeof orderFixture>['measure']>;
type OrderSample = OrderMeasurement & {
  edits: number;
  keyCount: number;
  mutationFrameBytes: number;
  mutationPayloadBytes: number;
};

test('small key moves stay bounded independently of unchanged payload and sibling count at 100/200/300 edits', (t) => {
  const results = [];
  for (const [label, literal, keyCount] of [
    ['small-payload', 'Fictional Ω 😀', 4],
    ['large-unchanged-payload', 'Fictional Ω 😀 '.repeat(8000), 4],
    ['many-equal-sibling-values', 'Fictional Ω 😀', 512],
  ] as const) {
    const f = orderFixture(t);
    const keys = Array.from(
      { length: keyCount },
      (_, index) => `key${String(index).padStart(4, '0')}`,
    );
    let latest: Record<string, unknown> = {
      literal,
      ...Object.fromEntries(keys.map((key) => [key, 'equal'])),
    };
    f.store.mutate(latest, randomUUID());
    const initial = f.measure();
    const samples: OrderSample[] = [];
    let maxPayloadBytes = 0;
    let maxMutationFrameBytes = 0;
    let normalizedBytes = f.store.counters.normalizedStateBytes;
    for (let edits = 1; edits <= 300; edits++) {
      const before = mutationWork(f.store);
      const fixed = keys.slice(0, -1);
      const ordered = edits % 2 === 1 ? [keys.at(-1)!, ...fixed] : [...fixed, keys.at(-1)!];
      latest = { literal, ...Object.fromEntries(ordered.map((key) => [key, 'equal'])) };
      normalizedBytes += Buffer.byteLength(JSON.stringify(latest));
      const result = f.store.mutate(latest, randomUUID());
      assert.equal(result.changed, true, 'a single key moves in both directions');
      const after = mutationWork(f.store);
      assert.equal(after.reads, before.reads, 'warm moves must not reread ancestors');
      assert.equal(
        after.copies - before.copies,
        0,
        'warm replay no longer clones the complete candidate',
      );
      assert.equal(after.normalizedBytes, normalizedBytes);
      assert.equal(after.copiedBytes, 0);
      assert.ok(after.frames - before.frames <= 2);
      const changedBytes = after.frameBytes - before.frameBytes;
      maxMutationFrameBytes = Math.max(maxMutationFrameBytes, changedBytes);
      assert.ok(changedBytes < 4096, 'moving a key cannot copy unchanged payload/key order');
      const contributions = f.db
        .prepare(
          "SELECT value FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' AND json_extract(value,'$.version')=?",
        )
        .all(result.version);
      const payload = Buffer.concat(
        contributions.map((row) =>
          Buffer.from((JSON.parse(String(row.value)) as { data: string }).data, 'base64'),
        ),
      );
      maxPayloadBytes = Math.max(maxPayloadBytes, payload.length);
      assert.ok(payload.length < 256, 'one key move cannot carry all sibling references');
      assert.equal(f.store.readSerialized(), JSON.stringify(latest));
      if (edits % 100 === 0)
        samples.push({
          edits,
          keyCount,
          ...f.measure(),
          mutationFrameBytes: changedBytes,
          mutationPayloadBytes: payload.length,
        });
    }
    const blockBytes = samples.map(
      (sample, index) =>
        sample.authorityBytes -
        (index ? samples[index - 1]!.authorityBytes : initial.authorityBytes),
    );
    assert.ok(
      Math.max(...blockBytes) < Math.min(...blockBytes) * 1.15,
      'each 100-move block has comparable accepted storage cost',
    );
    assert.ok(Number(samples.at(-1)!.head.max_bytes) <= 4096);
    assert.ok(Number(samples.at(-1)!.receipts.max_bytes) <= 4096);
    assert.ok(Number(samples.at(-1)!.transactions.max_result_bytes) < 2048);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId),
      f.original,
    );
    clearIntakeStateCache(f.db);
    const cold = createIntakeStateStorage(f.db, scope);
    assert.equal(cold.readSerialized(), JSON.stringify(latest));
    assert.equal(cold.counters.coldReconstructions, 1);
    assert.equal(f.rebuild().readSerialized(), JSON.stringify(latest));
    results.push({
      scenario: label,
      initial,
      samples,
      maxPayloadBytes,
      maxMutationFrameBytes,
      blockBytes,
    });
  }
  assert.ok(results[1]!.initial.authorityBytes > results[0]!.initial.authorityBytes + 100_000);
  assert.equal(
    results[1]!.maxPayloadBytes,
    results[0]!.maxPayloadBytes,
    'unchanged value size cannot affect order payload',
  );
  assert.equal(
    results[2]!.maxPayloadBytes,
    results[0]!.maxPayloadBytes,
    'sibling count cannot affect a single-key order payload',
  );
  t.diagnostic(
    JSON.stringify({
      scenarios: results,
      scope:
        'Intake primitive only. Single object key moves, including both directions; full input normalization and serialization remain host costs, while candidate replay copies changed containers. No array/string move or production activation claim.',
    }),
  );
});

test('middle-key insertions have bounded contributions despite growing order manifests at 100/200/300 edits', (t) => {
  const f = orderFixture(t);
  const literal = 'Independently fictional unchanged Ω 🦊. '.repeat(3000);
  let latest: Record<string, unknown> = { first: 'equal', literal, last: 'equal' };
  f.store.mutate(latest, randomUUID());
  const initial = f.measure();
  const inserted: string[] = [];
  const samples: OrderSample[] = [];
  let maxPayloadBytes = 0;
  for (let edits = 1; edits <= 300; edits++) {
    const before = mutationWork(f.store);
    inserted.unshift(`added${String(edits).padStart(4, '0')}`);
    latest = {
      first: 'equal',
      ...Object.fromEntries(inserted.map((key) => [key, 'equal'])),
      literal,
      last: 'equal',
    };
    const result = f.store.mutate(latest, randomUUID());
    assert.equal(result.changed, true);
    const after = mutationWork(f.store);
    const changedBytes = after.frameBytes - before.frameBytes;
    assert.ok(changedBytes < 4096, 'new middle key cannot rewrite the growing key manifest');
    assert.ok(after.frames - before.frames <= 2);
    assert.equal(after.reads, before.reads);
    assert.equal(after.copies - before.copies, 0);
    assert.equal(after.copiedBytes - before.copiedBytes, 0, 'no complete prior-object clone');
    const contributions = f.db
      .prepare(
        "SELECT value FROM app_meta WHERE key GLOB 'intake_state_v1:*:frame:*' AND json_extract(value,'$.version')=?",
      )
      .all(result.version);
    const payload = Buffer.concat(
      contributions.map((row) =>
        Buffer.from((JSON.parse(String(row.value)) as { data: string }).data, 'base64'),
      ),
    );
    maxPayloadBytes = Math.max(maxPayloadBytes, payload.length);
    assert.ok(payload.length < 512, 'new-key evidence stays independent of sibling count');
    assert.equal(f.store.readSerialized(), JSON.stringify(latest));
    if (edits % 100 === 0)
      samples.push({
        edits,
        keyCount: Object.keys(latest).length,
        ...f.measure(),
        mutationFrameBytes: changedBytes,
        mutationPayloadBytes: payload.length,
      });
  }
  const blockBytes = samples.map(
    (sample, index) =>
      sample.authorityBytes - (index ? samples[index - 1]!.authorityBytes : initial.authorityBytes),
  );
  assert.ok(
    Math.max(...blockBytes) < Math.min(...blockBytes) * 1.15,
    'growing sibling count cannot increase each 100-insertion block materially',
  );
  assert.ok(Number(samples.at(-1)!.frames.max_bytes) <= 64 * 1024);
  assert.ok(Number(samples.at(-1)!.head.max_bytes) <= 4096);
  assert.ok(Number(samples.at(-1)!.receipts.max_bytes) <= 4096);
  assert.ok(Number(samples.at(-1)!.transactions.max_result_bytes) < 2048);
  assert.deepEqual(f.db.prepare('SELECT * FROM source_files WHERE id=?').get(intakeId), f.original);
  clearIntakeStateCache(f.db);
  assert.equal(createIntakeStateStorage(f.db, scope).readSerialized(), JSON.stringify(latest));
  assert.equal(f.rebuild().readSerialized(), JSON.stringify(latest));
  t.diagnostic(
    JSON.stringify({
      scenario: 'growing-middle-key-order',
      initial,
      samples,
      maxPayloadBytes,
      blockBytes,
      scope:
        '300 individual object-key insertions only. Complete normalization/hash and shallow changed-container copying remain disclosed separately; source details and production persistence unchanged.',
    }),
  );
});
