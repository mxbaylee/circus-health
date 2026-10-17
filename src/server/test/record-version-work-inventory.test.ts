import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRecordPublicationDiagnostic } from './helpers/record-publication-callers.ts';
import {
  encodedRecordObjectInventory,
  recordVersionWorkInventory,
} from './helpers/record-version-work-inventory.ts';

test('diagnostic inventory retains exact fresh rows, repeated IDs and UTF8 byte totals', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE __record_versions(version_id TEXT PRIMARY KEY, entity TEXT,
      record_id TEXT, sequence INTEGER, previous_version TEXT, deleted INTEGER,
      contents_json TEXT, metadata_json TEXT)`);
    const put = db.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?)');
    const item = JSON.stringify({
      key: 'intake_partial_acceptance:v1:fictional:item:0',
      value: 'Fictional é',
    });
    const manifest = JSON.stringify({
      key: 'intake_partial_acceptance:v1:fictional',
      value: 'selected',
    });
    put.run('old', 'app_meta', 'item-id', 1, null, 0, item, '{}');
    put.run('new', 'app_meta', 'item-id', 2, 'old', 0, item, '{"label":"é"}');
    put.run('deleted', 'app_meta', 'item-id', 3, 'new', 1, item, '{}');
    put.run('manifest', 'app_meta', 'manifest-id', 2, null, 0, manifest, '{}');
    const inventory = recordVersionWorkInventory(db, 1, 2);
    assert.equal(inventory.buckets.length, 2);
    const row = inventory.buckets.find((value) => value.family === 'app_meta/partial-item')!;
    assert.equal(row.rows, 1);
    assert.equal(row.distinct_record_ids, 1);
    assert.equal(row.max_versions_per_record_id, 1);
    assert.equal(row.contents_bytes, Buffer.byteLength(item));
    assert.equal(row.metadata_bytes, Buffer.byteLength('{"label":"é"}'));
    assert.equal(row.unchanged_versions, 1);
    assert.equal(row.unchanged_contents_bytes, Buffer.byteLength(item));
    assert.equal(row.deleted_rows, 0);
    const both = recordVersionWorkInventory(db, 1).buckets.find(
      (value) => value.family === 'app_meta/partial-item',
    )!;
    assert.equal(both.rows, 2);
    assert.equal(both.distinct_record_ids, 1);
    assert.equal(both.max_versions_per_record_id, 2);
    assert.equal(both.deleted_rows, 1);
    assert.throws(() => recordVersionWorkInventory(db, 3, 2));
  } finally {
    db.close();
  }
});

test('diagnostic node inventory separates leaf values from taller ancestor references', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE __record_versions(version_id TEXT PRIMARY KEY, entity TEXT,
      record_id TEXT, sequence INTEGER, previous_version TEXT, deleted INTEGER,
      contents_json TEXT, metadata_json TEXT)`);
    const put = db.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?)');
    const payload = JSON.stringify({ kind: 'inline', text: 'Fictional é' });
    const leaf = {
      format: 'health-intake-node-v4',
      key: 'fictional-key',
      value: payload,
      left: null,
      right: null,
    };
    const ref = {
      hash: 'fictional-hash',
      count: 1,
      height: 1,
      first: 'fictional-key',
      last: 'fictional-key',
    };
    const branch = { ...leaf, left: ref };
    for (const [index, value] of [leaf, branch].entries())
      put.run(
        'node-' + index,
        'app_meta',
        'node-' + index,
        1,
        null,
        0,
        JSON.stringify({
          key: 'intake_state_v1:fictional:node:' + index,
          value: JSON.stringify(value),
        }),
        '{}',
      );
    put.run(
      'unclassified',
      'app_meta',
      'unclassified',
      1,
      null,
      0,
      JSON.stringify({
        key: 'intake_state_v1:fictional:node:unclassified',
        value: 'not a JSON node',
      }),
      '{}',
    );
    const result = recordVersionWorkInventory(db, 0);
    assert.equal(result.unclassifiedNodeRows, 1);
    assert.equal(result.buckets[0]!.rows, 3);
    const leafRow = result.nodes.find((row) => row.shape === 'leaf')!;
    const branchRow = result.nodes.find((row) => row.shape === 'branch')!;
    assert.equal(leafRow.height, 1);
    assert.equal(leafRow.value_kind, 'inline');
    assert.equal(branchRow.height, 2);
    assert.equal(branchRow.largest_subtree_count, 2);
    assert.equal(leafRow.value_bytes, Buffer.byteLength(payload));
    assert.equal(branchRow.value_bytes, leafRow.value_bytes);
    assert.equal(leafRow.reference_bytes, 8);
    assert.equal(branchRow.reference_bytes, Buffer.byteLength(JSON.stringify(ref)) + 4);
    assert.equal(leafRow.raw_node_bytes, Buffer.byteLength(JSON.stringify(leaf)));
    assert.equal(branchRow.raw_node_bytes, Buffer.byteLength(JSON.stringify(branch)));
  } finally {
    db.close();
  }
});

test('encoded inventory includes duplicate writes, unselected objects and unknown framing bytes', () => {
  const objects = new Map([
    [
      'commit',
      Buffer.from(
        JSON.stringify({ format: 'health-record-versions-v2', segments: [], sequence: 1 }),
      ),
    ],
    ['index', Buffer.from(JSON.stringify({ format: 'health-record-segment-page-v1' }))],
    ['orphan', Buffer.from('an unselected partial JSONL segment')],
    [
      'version',
      Buffer.from(
        JSON.stringify({
          format: 'health-record-versions-v1',
          versionId: 'fictional',
          entity: 'app_meta',
          contents: {},
        }),
      ),
    ],
  ]);
  const names = ['commit', 'index', 'orphan', 'orphan', 'version'];
  const events = names.map((name) => ({ name, bytes: objects.get(name)!.length }));
  const result = encodedRecordObjectInventory(objects, events, 1);
  assert.equal(
    Object.values(result.families).reduce((sum, value) => sum + value.writes, 0),
    4,
  );
  assert.equal(
    Object.values(result.families).reduce((sum, value) => sum + value.bytes, 0),
    events.slice(1).reduce((sum, value) => sum + value.bytes, 0),
  );
  assert.equal(result.families['segment-or-unclassified']!.writes, 2);
  assert.equal(result.families['segment-index-page']!.writes, 1);
  assert.equal(result.families['single-version-segment']!.writes, 1);
  assert.deepEqual(encodedRecordObjectInventory(objects, events, 0, 1).families, {
    'record-commit': { writes: 1, bytes: objects.get('commit')!.length },
  });
  assert.deepEqual(encodedRecordObjectInventory(objects, events, 1, 1).families, {});
  assert.throws(() => encodedRecordObjectInventory(objects, [{ name: 'absent', bytes: 1 }], 0));
  assert.throws(() => encodedRecordObjectInventory(objects, events, -1));
  assert.throws(() => encodedRecordObjectInventory(objects, events, 3, 2));
});

test('publication caller inventory retains duplicate HEAD calls, unknown rows and trailing objects', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE __record_versions(sequence INTEGER,operation_id TEXT,entity TEXT,contents_json TEXT,metadata_json TEXT)',
    );
    const insert = db.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?)');
    const contents = JSON.stringify({
      key: 'intake_state_v1:fictional:node:a',
      value: 'Fictional é',
    });
    insert.run(1, 'fictional-one', 'app_meta', contents, '{}');
    insert.run(2, 'fictional-two', 'observations', '{"value":"é"}', '{}');
    insert.run(3, 'fictional-unknown', 'evidence', '{}', '{}');
    const objects = new Map<string, Buffer>();
    const diagnostic = createRecordPublicationDiagnostic(objects);
    const publish = (sequence: number, operationId: string) => {
      const name = 'commit-' + sequence;
      const value = Buffer.from(
        JSON.stringify({
          format: 'health-record-versions-v2',
          sequence,
          operationId,
          segments: [],
        }),
      );
      objects.set(name, value);
      diagnostic.immutable(name, value.length);
      diagnostic.published(Buffer.from(JSON.stringify({ name, bytes: value.length })));
      return value;
    };
    diagnostic.phase('adoption');
    const first = publish(1, 'fictional-one');
    diagnostic.phase('save');
    const second = publish(2, 'fictional-two');
    diagnostic.published(Buffer.from(JSON.stringify({ name: 'commit-2', bytes: second.length })));
    const trailing = Buffer.from('unselected framing bytes');
    objects.set('trailing', trailing);
    diagnostic.immutable('trailing', trailing.length);
    const result = diagnostic.inventory(db);
    assert.equal(result.publications.length, 3);
    assert.equal(
      result.groups.reduce((sum, row) => sum + row.heads, 0),
      3,
    );
    assert.equal(
      result.groups.reduce((sum, row) => sum + row.rows, 0),
      2,
    );
    assert.equal(
      result.groups.reduce((sum, row) => sum + row.node_rows, 0),
      1,
    );
    assert.equal(
      result.groups.reduce((sum, row) => sum + row.immutable_bytes, 0),
      first.length + second.length,
    );
    assert.equal(result.groups[0]!.node_contents_bytes, Buffer.byteLength(contents));
    assert.equal(result.groups[0]!.caller, 'unknown');
    assert.equal(result.unknownSequences.length, 1);
    assert.equal(result.unknownSequences[0]!.sequence, 3);
    assert.equal(
      result.trailingObjects.families['segment-or-unclassified']!.bytes,
      trailing.length,
    );
    db.prepare('UPDATE __record_versions SET operation_id=? WHERE sequence=2').run(
      'fictional-mismatch',
    );
    assert.throws(() => diagnostic.inventory(db), /operation does not match/);
    db.prepare('UPDATE __record_versions SET operation_id=? WHERE sequence=2').run('fictional-two');
    insert.run(1, 'fictional-other', 'evidence', '{}', '{}');
    assert.throws(() => diagnostic.inventory(db), /operation does not match/);
    db.prepare('DELETE FROM __record_versions WHERE operation_id=?').run('fictional-other');
    const wrong = Buffer.from(JSON.stringify({ sequence: 2, operationId: 'fictional-wrong' }));
    objects.set('wrong-head-commit', wrong);
    diagnostic.immutable('wrong-head-commit', wrong.length);
    diagnostic.published(
      Buffer.from(JSON.stringify({ name: 'wrong-head-commit', bytes: wrong.length })),
    );
    assert.throws(() => diagnostic.inventory(db), /operation does not match/);
  } finally {
    db.close();
  }
});
