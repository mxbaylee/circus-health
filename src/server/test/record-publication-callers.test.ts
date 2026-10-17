import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createRecordPublicationDiagnostic,
  recordPublicationNodeInventory,
} from './helpers/record-publication-callers.ts';

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE __record_versions(sequence INTEGER,operation_id TEXT,entity TEXT,contents_json TEXT,metadata_json TEXT)',
  );
  const objects = new Map<string, Buffer>(),
    diagnostic = createRecordPublicationDiagnostic(objects);
  const insert = db.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?)');
  const immutable = (name: string, value = Buffer.from('fictional é')) => {
    const prior = objects.get(name);
    if (prior) assert.deepEqual(value, prior);
    objects.set(name, value);
    diagnostic.immutable(name, value.length);
    return value;
  };
  const head = (sequence: number, operationId = 'operation-' + sequence, write = true) => {
    const name = 'commit-' + sequence,
      value = Buffer.from(
        JSON.stringify({
          format: 'health-record-versions-v2',
          sequence,
          operationId,
          segments: [],
        }),
      );
    if (write) immutable(name, value);
    const bytes = Buffer.from(JSON.stringify({ name, bytes: value.length }));
    diagnostic.published(bytes);
    return bytes.length;
  };
  const node = (
    sequence: number,
    hash: string,
    key: string,
    value: string,
    identity = { profileId: 'fictional-one', intakeId: 'fictional-source' },
  ) => {
    const raw = JSON.stringify({
      format: 'health-intake-node-v4',
      identity,
      key,
      value,
      left: null,
      right: null,
    });
    insert.run(
      sequence,
      'operation-' + sequence,
      'app_meta',
      JSON.stringify({ key: 'intake_state_v1:fictional:node:' + hash.repeat(64), value: raw }),
      '{}',
    );
  };
  return { db, objects, diagnostic, insert, immutable, head, node };
}
const sumFamilies = (
  families: Record<string, { writes: number; bytes: number }>,
  key: 'writes' | 'bytes',
) => Object.values(families).reduce((sum, row) => sum + row[key], 0);

test('publication intervals intersect exact phase boundaries and retain orphan/trailing events', (t) => {
  const f = fixture(t);
  f.immutable('orphan-before-phase');
  f.diagnostic.phase('adoption');
  f.immutable('adoption-part');
  f.diagnostic.phase('save');
  f.insert.run(1, 'operation-1', 'evidence', '{}', '{}');
  const headBytes = f.head(1);
  f.head(1, undefined, false);
  f.immutable('trailing-before-phase');
  f.diagnostic.phase('later');
  f.immutable('trailing-after-phase');
  f.insert.run(2, 'operation-2', 'evidence', '{}', '{}');
  const r = f.diagnostic.inventory(f.db),
    publication = r.publications[0]!;
  assert.deepEqual(
    publication.eventFragments.map((row) => [row.phase, row.firstEvent, row.throughEvent]),
    [
      ['fixture', 0, 1],
      ['adoption', 1, 2],
      ['save', 2, 3],
    ],
  );
  assert.equal(publication.phase, 'save');
  assert.deepEqual(
    r.trailingFragments.map((row) => [row.phase, row.firstEvent, row.throughEvent]),
    [
      ['save', 3, 4],
      ['later', 4, 5],
    ],
  );
  assert.equal(r.publications.length, 2);
  assert.equal(r.publications[1]!.versions, undefined);
  assert.deepEqual(r.publications[1]!.eventFragments, []);
  assert.equal(
    r.groups.reduce((n, row) => n + row.heads, 0),
    2,
  );
  assert.equal(
    r.groups.reduce((n, row) => n + row.head_bytes, 0),
    2 * headBytes,
  );
  assert.equal(
    r.groups.reduce((n, row) => n + row.rows, 0),
    1,
  );
  assert.equal(r.unknownSequences[0]!.sequence, 2);
  assert.equal(r.groups.find((row) => row.phase === 'fixture')!.immutable_writes, 1);
  assert.equal(sumFamilies(r.trailingObjects.families, 'writes'), 2);
  assert.equal(
    r.groups.reduce((n, row) => n + row.immutable_bytes, 0) +
      sumFamilies(r.trailingObjects.families, 'bytes'),
    [...f.objects.values()].reduce((n, bytes) => n + bytes.length, 0),
  );
  assert.ok(publication.stack.some((row) => row.includes('record-publication-callers.test.ts')));
  assert.equal(publication.caller, 'unknown', 'test frames are not invented production ownership');
});

test('node attribution groups exact UTF8 identity/key/value, not equal byte lengths', (t) => {
  const f = fixture(t),
    valueA = JSON.stringify({ kind: 'inline', text: 'é' }),
    valueB = JSON.stringify({ kind: 'inline', text: 'è' }),
    size = Buffer.byteLength(valueA);
  assert.equal(size, Buffer.byteLength(valueB));
  f.node(1, 'a', 'c:private-key', valueA);
  f.node(1, 'b', 'c:private-key', valueA);
  f.node(1, 'c', 'c:private-key', valueB);
  f.node(1, 'd', 'c:private-key', valueA, {
    profileId: 'fictional-two',
    intakeId: 'fictional-source',
  });
  f.node(2, 'e', 'c:private-key', valueA);
  f.node(2, 'a', 'c:private-key', valueA);
  f.node(2, 'a', 'c:private-key', valueA);
  f.node(2, 'f', 'c:other-private-key', valueA);
  f.insert.run(
    3,
    'operation-3',
    'app_meta',
    JSON.stringify({
      key: 'intake_state_v1:fictional:node:' + '9'.repeat(64),
      value: '{malformed',
    }),
    '{}',
  );
  const rows = recordPublicationNodeInventory(f.db),
    one = rows.find((r) => r.sequence === 1)!,
    two = rows.find((r) => r.sequence === 2)!,
    invalid = rows.find((r) => r.sequence === 3)!;
  assert.equal(one.rows, 4);
  assert.equal(one.distinct_hashes, 4);
  assert.equal(one.exact_identity_key_value_groups, 3);
  assert.equal(one.exact_group_value_bytes, 3 * size);
  assert.equal(one.all_row_value_bytes, 4 * size);
  assert.equal(one.within_sequence_additional_hashes, 1);
  assert.equal(one.within_sequence_additional_value_bytes, size);
  assert.equal(one.earlier_sequence_new_hashes, 0);
  assert.equal(two.rows, 4);
  assert.equal(two.distinct_hashes, 3);
  assert.equal(two.duplicate_hash_rows, 1);
  assert.equal(two.exact_identity_key_value_groups, 2);
  assert.equal(two.exact_group_value_bytes, 2 * size);
  assert.equal(two.earlier_sequence_new_hashes, 1);
  assert.equal(two.earlier_sequence_same_hashes, 1);
  assert.equal(two.earlier_sequence_new_hash_value_bytes, size);
  assert.equal(two.within_sequence_additional_hashes, 1);
  assert.equal(invalid.value_kind, 'unclassified');
  assert.equal(invalid.rows, 1);
  assert.equal(
    rows.reduce((n, row) => n + Number(row.rows), 0),
    9,
  );
  assert.ok(!JSON.stringify(rows).includes('private-key'));
  assert.ok(!JSON.stringify(rows).includes('fictional-one'));
  assert.ok(!JSON.stringify(rows).includes('é'));
});

test('duplicate physical HEADs assign accepted node buckets once; unknown sequence nodes remain', (t) => {
  const f = fixture(t),
    value = JSON.stringify({ kind: 'inline', text: 'retained' });
  f.node(1, 'a', 'c:private-key', value);
  f.node(2, 'b', 'c:private-key', value);
  f.head(1);
  f.head(1, undefined, false);
  f.head(3);
  const r = f.diagnostic.inventory(f.db);
  assert.equal(r.publications[0]!.nodes.length, 1);
  assert.deepEqual(r.publications[1]!.nodes, []);
  assert.equal(
    r.nodeInventory.reduce((n, row) => n + Number(row.rows), 0),
    2,
  );
  assert.equal(r.unknownSequences[0]!.sequence, 2);
  assert.deepEqual(r.missingProjectionSequences, [3]);
  assert.equal(r.publications[0]!.nodes[0]!.earlier_sequence_new_hashes, 0);
  assert.equal(r.nodeInventory.find((row) => row.sequence === 2)!.earlier_sequence_new_hashes, 1);
});

test('mixed operation ids refuse before assigning sequence rows', (t) => {
  const f = fixture(t);
  f.insert.run(1, 'operation-1', 'evidence', '{}', '{}');
  f.insert.run(1, 'different', 'evidence', '{}', '{}');
  f.head(1);
  assert.throws(() => f.diagnostic.inventory(f.db), /operation does not match/);
});

test('malformed outer projection JSON retains its row and recognized node headers are descriptive only', (t) => {
  const f = fixture(t);
  f.insert.run(1, 'operation-1', 'app_meta', '{malformed outer', '{}');
  f.head(1);
  const raw = JSON.stringify({
    format: 'health-intake-node-v4',
    identity: { profileId: 'fictional' },
    key: 's:opaque',
    value: JSON.stringify({ kind: 'inline', text: 'fictional' }),
  });
  f.insert.run(
    2,
    'operation-2',
    'app_meta',
    JSON.stringify({ key: 'intake_state_v1:fictional:node:' + 'a'.repeat(64), value: raw }),
    '{}',
  );
  const result = f.diagnostic.inventory(f.db);
  assert.equal(result.publications[0]!.versions!.rows, 1);
  assert.equal(result.publications[0]!.versions!.malformed_contents_rows, 1);
  assert.equal(result.groups[0]!.malformed_contents_rows, 1);
  assert.equal(result.unknownSequences[0]!.sequence, 2);
  assert.equal(
    result.nodeInventory[0]!.value_kind,
    'inline',
    'header bucket does not claim edge/hash validation',
  );
  assert.equal(result.nodeInventory[0]!.key_prefix, 's:');
  assert.match(result.nodeLimits, /headers only/);
});
