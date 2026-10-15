import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controlledCoverageSpanKey,
  createControlledProgressWatchdog,
} from './helpers/controlled-progress-watchdog.ts';

function fixture(completionMs = 100, stallMs = 10) {
  let clock = 0;
  const guard = createControlledProgressWatchdog({ now: () => clock, completionMs, stallMs });
  return { guard, at: (value: number) => (clock = value) };
}

test('unique page or batch advances reset only the stall deadline', () => {
  const f = fixture();
  f.at(9);
  f.guard.observe({ pages: 1, batches: 0 });
  f.at(18);
  f.guard.observe({ pages: 1, batches: 1 });
  f.at(27.999);
  f.guard.check();
  f.at(28);
  assert.throws(() => f.guard.check(), /stalled/);
});

test('polls, heartbeats and duplicate progress do not postpone a stall', () => {
  const f = fixture();
  for (const now of [1, 4, 9.999]) {
    f.at(now);
    f.guard.check();
    f.guard.observe({ pages: 0, batches: 0 });
  }
  f.at(10);
  assert.throws(() => f.guard.observe({ pages: 1, batches: 0 }), /stalled/);
  assert.throws(() => f.guard.check(), /stalled/);
});

test('continued useful progress never extends the absolute completion deadline', () => {
  const f = fixture(25);
  for (const [now, pages] of [
    [9, 1],
    [18, 2],
    [24.999, 3],
  ] as const) {
    f.at(now);
    f.guard.observe({ pages, batches: 0 });
  }
  f.guard.check();
  f.at(25);
  assert.throws(() => f.guard.observe({ pages: 4, batches: 1 }), /completion deadline/);
  assert.throws(() => f.guard.check(), /completion deadline/);
});

test('final completion must check both exact deadlines instead of bypassing them', () => {
  const stalled = fixture();
  stalled.at(9.999);
  stalled.guard.check();
  stalled.at(10);
  assert.throws(() => stalled.guard.check(), /stalled/);
  const expired = fixture(10, 20);
  expired.at(9.999);
  expired.guard.check();
  expired.at(10);
  assert.throws(() => expired.guard.check(), /completion deadline/);
});

test('canonical coverage spans ignore order, duplicate pages and new operation IDs', () => {
  const f = fixture();
  const spans = new Set<string>();
  const acknowledge = (unit: string, pages: number[], _operationId: string) => {
    spans.add(controlledCoverageSpanKey(unit, pages));
    f.guard.observe({ pages: 0, batches: spans.size });
  };
  f.at(1);
  acknowledge('fictional-unit', [1, 2, 3], 'first');
  f.at(9);
  acknowledge('fictional-unit', [3, 2, 1, 1], 'different-operation-id');
  assert.equal(spans.size, 1);
  f.at(11);
  assert.throws(() => acknowledge('fictional-unit', [1, 2, 3], 'third'), /stalled/);
  const advancing = fixture();
  advancing.at(9);
  advancing.guard.observe({ pages: 0, batches: 1 });
  advancing.at(18);
  advancing.guard.observe({ pages: 0, batches: 2 });
  advancing.at(27.999);
  advancing.guard.check();
});

test('invalid or decreasing progress cannot reset liveness', () => {
  for (const invalid of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
    for (const field of ['pages', 'batches'] as const) {
      const f = fixture();
      assert.throws(() => f.guard.observe({ pages: 0, batches: 0, [field]: invalid }), /counters/);
      f.at(10);
      assert.throws(() => f.guard.check(), /stalled/);
    }
  }
  for (const field of ['pages', 'batches'] as const) {
    const f = fixture();
    f.guard.observe({ pages: 1, batches: 1 });
    f.at(1);
    assert.throws(() => f.guard.observe({ pages: 1, batches: 1, [field]: 0 }), /counters/);
  }
});

test('invalid clocks, clock rollback and invalid limits are refused', () => {
  for (const clock of [-1, NaN, Infinity])
    assert.throws(() => createControlledProgressWatchdog({ now: () => clock }), /clock/);
  for (const clock of [NaN, Infinity, -1]) {
    const f = fixture();
    f.at(clock);
    assert.throws(() => f.guard.check(), /clock/);
  }
  const f = fixture();
  f.at(2);
  f.guard.check();
  f.at(1);
  assert.throws(() => f.guard.observe({ pages: 1, batches: 0 }), /clock/);
  for (const invalid of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createControlledProgressWatchdog({ completionMs: invalid }), /duration/);
    assert.throws(() => createControlledProgressWatchdog({ stallMs: invalid }), /duration/);
  }
});

test('coverage identities require bounded fictional page coordinates', () => {
  for (const pages of [
    [],
    [0],
    [101],
    [NaN],
    [0.5],
    Array<number>(1),
    Array.from({ length: 101 }, () => 1),
  ])
    assert.throws(() => controlledCoverageSpanKey('fictional-unit', pages), /coverage span/);
  assert.throws(() => controlledCoverageSpanKey('', [1]), /coverage span/);
  assert.equal(controlledCoverageSpanKey('fictional-unit', [100, 1]), '["fictional-unit",[1,100]]');
});
