import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createIntakeGraphScratch } from '../intake-state-graph-scratch.ts';
import { digest } from '../intake-state-evidence.ts';
import type { IntakeTreeRef } from '../intake-state-tree.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';

const identity = {
  profileId: 'fictional-graph-work',
  intakeId: 'fictional-intake',
  sourceHash: 'b'.repeat(64),
};
const ref = (n: number): IntakeTreeRef => ({
  hash: digest('fictional-node-' + n),
  count: 1,
  height: 1,
  first: 'fictional-key-' + n,
  last: 'fictional-key-' + n,
});

test('typed encrypted graph summaries, nested queue and stack preserve exact detached work', () => {
  const scratch = createIntakeGraphScratch(identity, 'fictional selected graph', () => {});
  try {
    for (let n = 0; n < 80; n++) {
      const node = ref(n);
      assert.equal(scratch.seen(node.hash, 'map'), undefined);
      scratch.remember(node, 'map', n, n + 2);
      scratch.enqueue(node, 'map', n);
      scratch.enqueue(node, 'map', n);
    }
    assert.equal(scratch.stats().nestedWrites, 80);
    for (let n = 0; n < 80; n++) {
      const node = ref(n),
        row = scratch.seen(node.hash, 'map');
      assert.deepEqual(row, { ref: node, bytes: n, maxSequence: n + 2 });
      row!.ref.hash = 'a'.repeat(64);
      assert.equal(scratch.seen(node.hash, 'map')!.ref.hash, node.hash);
    }
    let consumed = 0;
    for (;;) {
      const work = scratch.nextNested();
      if (!work) break;
      assert.deepEqual(scratch.nested(work.ref.hash, work.kind), work);
      scratch.finishNested(work.ref, work.kind);
      consumed++;
    }
    assert.equal(consumed, 80);
    scratch.enqueue(ref(0), 'map', 0);
    assert.equal(scratch.nextNested(), undefined, 'completed shared work is not enqueued again');
    for (let n = 0; n < 8; n++) scratch.push(ref(n), 'map', '');
    assert.throws(() => scratch.push(ref(3), 'map', ''), /cyclic referenced collection/);
    for (let n = 7; n >= 0; n--) {
      assert.deepEqual(scratch.top()!.ref, ref(n));
      scratch.pop();
    }
    assert.equal(scratch.top(), undefined);
    assert.ok(scratch.stats().peakCachePages <= 128);
    assert.ok(scratch.stats().filesRetained > 80, 'retention includes immutable COW pages');
  } finally {
    scratch.close();
  }
  assert.equal(existsSync(scratch.directory), false);
});

test('large typed summaries spill through encrypted scalar descriptors and copy contexts stay distinct', () => {
  const scratch = createIntakeGraphScratch(identity, 'fictional large graph', () => {}),
    node = ref(0);
  node.first = node.last = '\0'.repeat(1024);
  try {
    scratch.remember(node, 'map', 19, 8);
    assert.deepEqual(scratch.seen(node.hash, 'map'), { ref: node, bytes: 19, maxSequence: 8 });
    scratch.rememberCopy(node.hash, 'inventory', 'first-context', ref(1), 20);
    scratch.rememberCopy(node.hash, 'inventory', 'second-context', ref(2), 21);
    assert.equal(scratch.copied(node.hash, 'inventory', 'first-context')!.ref.hash, ref(1).hash);
    assert.equal(scratch.copied(node.hash, 'inventory', 'second-context')!.ref.hash, ref(2).hash);
    assert.equal(scratch.copied(node.hash, 'inventory', 'unknown'), undefined);
    assert.ok(scratch.stats().scalarChunkWrites > 0);
    for (const name of readdirSync(join(scratch.directory, 'cells'))) {
      const bytes = readFileSync(join(scratch.directory, 'cells', name));
      assert.equal(bytes.includes(Buffer.from('fictional-graph-work')), false);
      assert.equal(bytes.subarray(0, 8).toString(), 'CIRCUS01');
    }
  } finally {
    scratch.close();
  }
});

test('typed graph operation counters preserve underlying encrypted AVL work', () => {
  const db = new DatabaseSync(':memory:'),
    scratch = createIntakeGraphScratch(identity, 'fictional measured graph', () => {});
  try {
    withIntakeWork(db, 'reconstruction', () => {
      assert.equal(scratch.seen(ref(0).hash, 'map'), undefined);
      scratch.remember(ref(0), 'map', 12, 1);
      scratch.enqueue(ref(0), 'map', 12);
      scratch.rememberCopy(ref(0).hash, 'map', '', ref(1), 13);
    });
    const work = intakeWorkCounters(db).reconstruction;
    assert.equal(work.graphScratchSeenReads, 1);
    assert.equal(work.graphScratchSeenWrites, 1);
    assert.equal(work.graphScratchNestedWrites, 1);
    assert.equal(work.graphScratchCopyWrites, 1);
    assert.ok(work.collectionPreparedBytes > 0);
  } finally {
    scratch.close();
    db.close();
  }
});
