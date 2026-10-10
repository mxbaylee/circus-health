import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordPreparedPriors } from '../record-prepared-priors.ts';

const prior = {
  entity: 'notes',
  recordId: 'fictional-record',
  previousVersion: 'fictional-version',
  deleted: false,
  preimage: { hash: 'a'.repeat(64), bytes: 31 },
};
const actual = {
  versionId: prior.previousVersion,
  deleted: prior.deleted,
  preimage: prior.preimage,
};

test('prepared predecessors authenticate latest versions without retaining contents', (t) => {
  const rows = createRecordPreparedPriors();
  t.after(() => rows.close());
  const input = structuredClone(prior);
  rows.append(input);
  rows.append({ ...prior, entity: 'attachments', deleted: true });
  input.preimage.hash = 'b'.repeat(64);
  rows.seal();
  const found = rows.find(prior.entity, prior.recordId)!;
  assert.deepEqual(found, { ...prior, matched: false });
  assert.ok(Object.isFrozen(found));
  assert.ok(Object.isFrozen(found.preimage));
  assert.equal(rows.find('unrelated', prior.recordId), undefined);
  rows.match(prior.entity, prior.recordId, actual);
  assert.equal(rows.find(prior.entity, prior.recordId)!.matched, true);
  rows.match('attachments', prior.recordId, { ...actual, deleted: true });
  rows.finish({ reachedRoot: false });
  assert.throws(() => rows.find(prior.entity, prior.recordId));
});

for (const kind of ['version', 'deleted', 'hash', 'bytes'] as const)
  test('prepared predecessor mismatch poisons older fallback: ' + kind, (t) => {
    const rows = createRecordPreparedPriors();
    t.after(() => rows.close());
    rows.append(prior);
    rows.seal();
    const changed = structuredClone(actual);
    if (kind === 'version') changed.versionId = 'fictional-newer-version';
    if (kind === 'deleted') changed.deleted = true;
    if (kind === 'hash') changed.preimage.hash = 'b'.repeat(64);
    if (kind === 'bytes') changed.preimage.bytes++;
    assert.throws(() => rows.match(prior.entity, prior.recordId, changed));
    assert.throws(() => rows.match(prior.entity, prior.recordId, actual));
    assert.throws(() => rows.finish({ reachedRoot: true }));
  });

test('absence requires authenticated root and rejects a found durable predecessor', (t) => {
  for (const outcome of ['root', 'early', 'found'] as const) {
    const rows = createRecordPreparedPriors();
    t.after(() => rows.close());
    rows.append({ ...prior, previousVersion: null, preimage: null });
    rows.seal();
    if (outcome === 'root') rows.finish({ reachedRoot: true });
    else if (outcome === 'early') assert.throws(() => rows.finish({ reachedRoot: false }));
    else assert.throws(() => rows.match(prior.entity, prior.recordId, actual));
  }
});

test('duplicate enrollment, repeated matches and missing predecessors refuse', (t) => {
  for (const outcome of ['duplicate', 'repeat', 'missing'] as const) {
    const rows = createRecordPreparedPriors();
    t.after(() => rows.close());
    rows.append(prior);
    if (outcome === 'duplicate') assert.throws(() => rows.append(prior));
    else {
      rows.seal();
      if (outcome === 'repeat') {
        rows.match(prior.entity, prior.recordId, actual);
        assert.throws(() => rows.match(prior.entity, prior.recordId, actual));
      } else assert.throws(() => rows.finish({ reachedRoot: true }));
    }
  }
});

test('empty predecessor selection completes and close is idempotent', () => {
  const rows = createRecordPreparedPriors();
  rows.seal();
  rows.finish({ reachedRoot: false });
  rows.close();
  rows.close();
  assert.throws(() => rows.find(prior.entity, prior.recordId));
});

for (const change of ['replace', 'delete', 'schema'] as const)
  test('foreign scratch ' + change + ' cannot change predecessor membership', (t) => {
    const before = new Set(readdirSync(tmpdir()));
    const rows = createRecordPreparedPriors();
    t.after(() => rows.close());
    rows.append(prior);
    rows.seal();
    const directory = readdirSync(tmpdir()).find(
      (name) => !before.has(name) && name.startsWith('circus-record-prepared-priors-'),
    );
    assert.ok(directory);
    const peer = new DatabaseSync(join(tmpdir(), directory, 'scratch.sqlite'));
    try {
      if (change === 'replace') peer.exec('UPDATE priors SET matched=1');
      if (change === 'delete') peer.exec('DELETE FROM priors');
      if (change === 'schema') peer.exec('CREATE TABLE fictional_extra(value TEXT)');
    } finally {
      peer.close();
    }
    assert.throws(() => rows.find(prior.entity, prior.recordId));
    assert.throws(() => rows.finish({ reachedRoot: true }));
  });
