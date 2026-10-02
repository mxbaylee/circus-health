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
  let copiedBytes = 0;
  for (let step = 1; step <= 300; step++) {
    copiedBytes += Buffer.byteLength(JSON.stringify(latest));
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
    assert.equal(state.counters.candidateCopyBytes, copiedBytes);
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
  t.diagnostic(
    JSON.stringify({
      initial: initialMeasurement,
      samples,
      scope:
        'Primitive only. Counts include all immutable records, commits, heads and SQLite history; no production intake cutover.',
    }),
  );

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
