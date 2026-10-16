import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverQualificationState } from './provider-qualification-acceptance.ts';

const baseline = {
  results: [{ id: 'fictional-accepted', valueText: '1.17' }],
  histories: [{ entries: [{ version: 'fictional-v1', valueText: '1.17', actor: 'profile-user' }] }],
};

function fixture(snapshots = [structuredClone(baseline), structuredClone(baseline)]) {
  const events: string[] = [];
  let originalUnchanged = true;
  return {
    events,
    changeOriginal: () => {
      originalUnchanged = false;
    },
    options: {
      snapshot: async () => {
        events.push('snapshot');
        return snapshots.shift()!;
      },
      originalUnchanged: async () => {
        events.push('original');
        return originalUnchanged;
      },
      lock: async () => {
        events.push('lock');
      },
      unlock: async () => {
        events.push('unlock');
      },
      removeCache: () => {
        events.push('remove-cache');
      },
      recreate: async (stage: 'accepted' | 'cache_removed') => {
        events.push('recreate-' + stage);
      },
    },
  };
}

test('deployment recovery verifies recreation before cache removal and verifies reconstruction separately', async () => {
  const run = fixture();
  assert.deepEqual(await recoverQualificationState(baseline, run.options), baseline);
  assert.deepEqual(run.events, [
    'lock',
    'recreate-accepted',
    'unlock',
    'snapshot',
    'original',
    'lock',
    'remove-cache',
    'recreate-cache_removed',
    'unlock',
    'snapshot',
    'original',
  ]);
});

test('changed versions and missing histories refuse before deleting the existing cache', async () => {
  const changed = structuredClone(baseline);
  changed.histories[0]!.entries[0]!.version = 'different-version';
  for (const before of [
    baseline,
    { ...baseline, histories: [] },
    { ...baseline, histories: [{ entries: [] }] },
  ]) {
    const run = fixture([changed]);
    await assert.rejects(
      recoverQualificationState(before, run.options),
      /version history|nonempty/,
    );
    assert.equal(run.events.includes('remove-cache'), false);
  }
});

test('cache-loss history or original corruption cannot pass the final check', async () => {
  const changed = structuredClone(baseline);
  changed.histories[0]!.entries[0]!.valueText = 'wrong historical value';
  const run = fixture([structuredClone(baseline), changed]);
  await assert.rejects(recoverQualificationState(baseline, run.options), /version history/);
  assert.equal(run.events.includes('remove-cache'), true);
  const original = fixture();
  original.changeOriginal();
  await assert.rejects(recoverQualificationState(baseline, original.options), /retained original/);
  assert.equal(original.events.includes('remove-cache'), false);
});
