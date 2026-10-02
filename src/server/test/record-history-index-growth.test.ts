import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  queryRecordHistory,
  type RecordStorage,
} from '../record-versions.ts';

const profileId = 'fictional-index-growth';
const sourceId = 'fictional-source';
const bytes = (value: string) => Buffer.byteLength(value);

test('300 growing source edits retain one content copy and bounded history references after cache loss', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'record-index-growth-'));
  const opened: Database[] = [];
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
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
  t.after(() => {
    for (const db of opened) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = open('current.sqlite');
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(
    sourceId,
    'fictional.txt',
    '0'.repeat(64),
    0,
    'intake_original',
    JSON.stringify({ workflow: { text: '', step: 0 } }),
  );
  attachRecordDurability(db, { profileId, storage });
  const expected = new Map<number, { text: string; step: number }>();
  expected.set(0, { text: '', step: 0 });
  const samples: Array<{
    edits: number;
    versions: number;
    contents: number;
    metadata: number;
    references: number;
    referenceBytes: number;
    allocated: number;
  }> = [];
  const initialFieldCount = Number(
    db.prepare("SELECT count(*) n FROM __record_fields WHERE entity='source_files'").get()!.n,
  );
  let text = '';
  for (let step = 1; step <= 300; step++) {
    text += `Fictional finding ${step}: ${'x'.repeat(80)}.\n`;
    const workflow = { text, step };
    expected.set(step, workflow);
    transaction(db, () =>
      db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run(JSON.stringify({ workflow }), sourceId),
    );
    if (step % 100 === 0) {
      const rows = db
        .prepare(
          "SELECT contents_json,metadata_json FROM __record_versions WHERE entity='source_files' ORDER BY sequence",
        )
        .all();
      assert.equal(rows.length, step + 1);
      let contents = 0,
        metadata = 0;
      for (const [index, row] of rows.entries()) {
        const content = JSON.parse(String(row.contents_json));
        assert.deepEqual(JSON.parse(content.details_json).workflow, expected.get(index));
        const envelope = JSON.parse(String(row.metadata_json));
        assert.equal(Object.hasOwn(envelope, 'contents'), false);
        assert.ok(bytes(String(row.metadata_json)) < 1000);
        contents += bytes(String(row.contents_json));
        metadata += bytes(String(row.metadata_json));
      }
      const fields = db
        .prepare(
          "SELECT field,before_version,before_present,after_present FROM __record_fields WHERE entity='source_files'",
        )
        .all();
      const fieldBytes = fields.reduce((sum, field) => sum + bytes(JSON.stringify(field)), 0);
      assert.ok(fields.length <= step * 4 + initialFieldCount);
      assert.ok(fieldBytes < fields.length * 250);
      const pageCount = Number(db.prepare('PRAGMA page_count').get()!.page_count);
      const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
      samples.push({
        edits: step,
        versions: rows.length,
        contents,
        metadata,
        references: fields.length,
        referenceBytes: fieldBytes,
        allocated: pageCount * pageSize,
      });
    }
  }
  const versionColumns = db
    .prepare('PRAGMA table_info(__record_versions)')
    .all()
    .map((row) => row.name);
  const fieldColumns = db
    .prepare('PRAGMA table_info(__record_fields)')
    .all()
    .map((row) => row.name);
  assert.equal(versionColumns.includes('version_json'), false);
  assert.equal(fieldColumns.includes('before_json'), false);
  assert.equal(fieldColumns.includes('after_json'), false);
  assert.ok(
    samples[2]!.contents > samples[0]!.contents * 7,
    'required growing immutable contents are explicitly not linear in edit count',
  );
  assert.ok(samples[2]!.metadata < samples[0]!.metadata * 3.1);
  assert.ok(samples[2]!.referenceBytes < samples[0]!.referenceBytes * 3.1);
  assert.ok(samples.every((sample) => sample.allocated > sample.contents));
  t.diagnostic(
    JSON.stringify({
      projectionSamples: samples,
      scope:
        'One required content copy per version; durable growing source contents remain separate work.',
    }),
  );

  const originalPrepare = db.prepare.bind(db);
  let selectedRows = 0,
    versionLookups = 0;
  Object.defineProperty(db, 'prepare', {
    configurable: true,
    value: (sql: string) => {
      const statement = originalPrepare(sql);
      return new Proxy(statement, {
        get(target, key) {
          const method = Reflect.get(target, key);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            const result = Reflect.apply(method, target, args);
            if (key === 'all' && sql.startsWith('SELECT v.version_id')) {
              assert.ok(Array.isArray(result));
              selectedRows += result.length;
            }
            if (key === 'get' && sql === 'SELECT * FROM __record_versions WHERE version_id=?')
              versionLookups++;
            return result;
          };
        },
      });
    },
  });
  const read = storage.read;
  storage.read = () => {
    throw Error('History pagination must use only the indexed selected page');
  };
  const first = queryRecordHistory(db, {
    profileId,
    entity: 'source_files',
    recordId: sourceId,
    field: 'details_json.workflow.step',
    limit: 7,
  });
  assert.equal(selectedRows, 8);
  assert.equal(versionLookups, 14);
  assert.deepEqual(
    first.entries.map((row) => JSON.parse(String(row.contents.details_json)).workflow.step),
    [300, 299, 298, 297, 296, 295, 294],
  );
  assert.deepEqual(
    first.entries[0]!.changes.find((change) => change.field === 'details_json.workflow.step'),
    {
      field: 'details_json.workflow.step',
      before: { present: true, value: 299 },
      after: { present: true, value: 300 },
    },
  );
  const second = queryRecordHistory(db, {
    profileId,
    entity: 'source_files',
    recordId: sourceId,
    field: 'details_json.workflow.step',
    limit: 7,
    beforeSequence: first.nextSequence!,
  });
  assert.deepEqual(
    second.entries.map((row) => JSON.parse(String(row.contents.details_json)).workflow.step),
    [293, 292, 291, 290, 289, 288, 287],
  );
  storage.read = read;
  Object.defineProperty(db, 'prepare', { configurable: true, value: originalPrepare });

  const authorityBefore = new Map([...objects].map(([name, value]) => [name, Buffer.from(value)]));
  rebuildRecordDatabase(join(root, 'rebuilt.sqlite'), { profileId, storage });
  const rebuilt = open('rebuilt.sqlite');
  attachRecordDurability(rebuilt, { profileId, storage });
  assert.deepEqual(
    objects,
    authorityBefore,
    'cache reconstruction does not rewrite immutable authority',
  );
  assert.deepEqual(
    rebuilt.prepare('SELECT * FROM source_files').all(),
    db.prepare('SELECT * FROM source_files').all(),
  );
  for (const page of [first, second]) {
    const beforeSequence = page === first ? undefined : first.nextSequence!;
    assert.deepEqual(
      queryRecordHistory(rebuilt, {
        profileId,
        entity: 'source_files',
        recordId: sourceId,
        field: 'details_json.workflow.step',
        limit: 7,
        beforeSequence,
      }),
      page,
    );
  }
});
