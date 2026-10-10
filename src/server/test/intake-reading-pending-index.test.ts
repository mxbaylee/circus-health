import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  prepareReadingPendingIndex,
  advanceReadingPendingIndex,
  beginReadingPendingIndexUpdate,
} from '../intake-reading-pending-index.ts';
import type { ReadWindow } from '../intake-continuation.ts';

test('child coverage selects exact pending pages and text ranges, advances changed windows, and rebuilds after cache loss', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let binding = 'first',
    visits = 0;
  const windows = new Map<string, ReadWindow>([
    ['child-page', { tool: 'health_intake_read', args: { id: 'child', page: 2, offset: 12 } }],
    [
      'parent-page',
      { tool: 'health_intake_package', args: { id: 'parent', memberId: 'member', page: 2 } },
    ],
    [
      'unit',
      { tool: 'health_intake_plan', args: { id: 'child', unitId: 'unit', action: 'read_unit' } },
    ],
    ['text', { tool: 'health_intake_read', args: { id: 'text', offset: 80 } }],
  ]);
  const prepare = () => {
    const selected = binding;
    return prepareReadingPendingIndex(
      db,
      'session',
      selected,
      function* () {
        for (const [key, window] of windows) {
          visits++;
          yield { key, window };
        }
      },
      () => assert.equal(binding, selected),
    );
  };
  const first = await prepare();
  assert.equal(first.page('child', 2), true);
  assert.equal(first.page('child', 3), false);
  assert.equal(first.unit('child', 'other-unit'), false);
  assert.equal(first.text('text', 80), false);
  assert.equal(first.text('text', 81), true);
  assert.equal(first.text('text'), true);
  assert.equal(visits, 4);
  windows.delete('child-page');
  binding = 'second';
  const before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  advanceReadingPendingIndex(db, 'session', 'first', binding, [['child-page', null]]);
  const changes = Number(db.prepare('SELECT total_changes() AS n').get()!.n) - before;
  assert.equal(
    changes,
    3,
    'one changed window and two readiness markers; unrelated windows are not rewritten',
  );
  assert.throws(() => first.page('child', 2));
  const second = await prepare();
  assert.equal(visits, 4, 'warm coverage does not revisit unchanged pending windows');
  assert.equal(second.page('child', 2), false);
  assert.equal(
    second.page('parent', 2),
    true,
    'a child read does not acknowledge its parent member',
  );
  assert.equal(second.unit('child', 'unit'), true);
  db.exec('DROP TABLE temp.reading_pending_heads; DROP TABLE temp.reading_pending_windows');
  const recovered = await prepare();
  assert.equal(visits, 7);
  assert.equal(recovered.page('parent', 2), true);
  assert.equal(recovered.unit('child', 'unit'), true);
  const interrupted = beginReadingPendingIndexUpdate(db, 'session', binding)!;
  interrupted.change('parent-page', null);
  assert.throws(() => recovered.page('parent', 2), /Pending reading index changed/);
  // No durable transition selected this removal. Rebuilding restores the
  // original pending parent window and supersedes the unfinished update.
  const rebuilt = await prepare();
  assert.equal(rebuilt.page('parent', 2), true);
  interrupted.finish('unpublished');
  assert.equal(rebuilt.page('parent', 2), true);
});

test('cancelled pending preparation never proves an empty child scope', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let checks = 0;
  const entries = function* () {
    for (let page = 1; page <= 100; page++)
      yield {
        key: String(page),
        window: { tool: 'health_intake_read', args: { id: 'child', page } },
      };
  };
  await assert.rejects(
    prepareReadingPendingIndex(db, 'session', 'head', entries, () => {
      if (++checks === 35) throw Error('Stopped');
    }),
    /Stopped/,
  );
  const complete = await prepareReadingPendingIndex(db, 'session', 'head', entries, () => {});
  assert.equal(complete.page('child', 100), true);
  assert.equal(complete.page('child', 101), false);
});

test('stale pending cleanup yields and an overlapping rebuild cannot publish or erase another preparation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const entries = function* () {
    for (let page = 1; page <= 100; page++)
      yield {
        key: String(page),
        window: { tool: 'health_intake_read', args: { id: 'child', page } },
      };
  };
  await prepareReadingPendingIndex(db, 'session', 'old', entries, () => {});
  let deleted = false;
  const interrupted = prepareReadingPendingIndex(db, 'session', 'interrupted', entries, () => {
    if (deleted) throw Error('Profile changed during stale cleanup');
  });
  deleted = true;
  await assert.rejects(interrupted, /Profile changed during stale cleanup/);
  assert.equal(
    Number(db.prepare('SELECT count(*) AS n FROM temp.reading_pending_windows').get()!.n),
    68,
    'only one bounded deletion batch ran before cancellation',
  );
  const older = prepareReadingPendingIndex(db, 'session', 'older', entries, () => {});
  const newer = prepareReadingPendingIndex(db, 'session', 'newer', entries, () => {});
  const [oldResult, newResult] = await Promise.allSettled([older, newer]);
  assert.equal(oldResult.status, 'rejected');
  assert.equal(newResult.status, 'fulfilled');
  assert.equal(newResult.value.page('child', 100), true);
  assert.equal(newResult.value.page('child', 101), false);
});
