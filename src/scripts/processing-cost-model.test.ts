import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_COST_PARAMS,
  STRATEGIES,
  parseArgs,
  scenario,
  summarize,
  type CostParams,
} from './processing-cost-model.ts';

const p: CostParams = { ...DEFAULT_COST_PARAMS };
const strategy = (id: string) => STRATEGIES.find((s) => s.id === id)!;
const run = (id: string, pages: number, shape: 'single' | 'multi' = 'single', params = p) =>
  summarize(strategy(id), scenario(pages, shape, params), params);
const near = (actual: number, expected: number, tolerance = 0.005) =>
  assert.ok(
    Math.abs(actual - expected) <= expected * tolerance,
    `${actual} is not within ${tolerance * 100}% of ${expected}`,
  );

test('reproduces the figures published in the processing proposal', () => {
  // docs/processing-context-proposal.md, "Model and calibration" results table.
  assert.equal(run('0', 800).requests, 1222);
  near(run('0', 800).inputTokens, 241e6);
  assert.equal(run('0b', 800).requests, 896);
  near(run('0b', 800).inputTokens, 90.6e6);
  near(run('B', 800).inputTokens, 36.0e6);
  near(run('B+H', 800).inputTokens, 25.7e6);
  assert.equal(run('G10', 800).requests, 80);
  near(run('G10', 800).inputTokens, 2.075e6);
  assert.equal(run('0b', 200).requests, 226);
  assert.equal(run('0', 1).requests, 5);
  assert.equal(run('G10', 1).requests, 1);
});

test('parallel workers never reduce tokens and never lengthen the critical path', () => {
  for (const pages of [1, 10, 200, 800])
    for (const [parallelId, baseId] of [
      ['E', '0'],
      ['F', 'G10'],
    ] as const) {
      const parallel = run(parallelId, pages, 'multi');
      const base = run(baseId, pages, 'multi');
      assert.ok(parallel.totalTokens >= base.totalTokens);
      assert.ok(parallel.criticalPath <= base.criticalPath + 1);
    }
});

test('a source that fits one unit is one host-pushed request', () => {
  for (const pages of [1, 5, 10]) assert.equal(run('J', pages, 'multi').requests, 1);
  assert.equal(run('J', 11).requests, 2);
});

test('the output cap adds publications for dense units', () => {
  const dense = { ...p, recordsPerPage: 30 };
  // 10 pages × 30 records = 300 records; 49 fit one publication at the default cap.
  assert.equal(run('G10', 10, 'multi', dense).requests, Math.ceil(300 / 49));
});

test('unattended continuation changes Resume clicks, not tokens', () => {
  const current = run('0', 800);
  const unattended = run('C', 800);
  assert.equal(unattended.totalTokens, current.totalTokens);
  assert.ok(current.resumes > 0);
  assert.equal(unattended.resumes, 0);
});

test('caching lowers effective input only when enabled', () => {
  const off = run('0', 200);
  assert.equal(off.effectiveInputTokens, off.inputTokens);
  const on = run('0', 200, 'single', { ...p, cachedTokenCost: 0.1 });
  assert.ok(on.effectiveInputTokens < on.inputTokens / 2);
  assert.equal(on.inputTokens, off.inputTokens);
});

test('re-export linking processes only unmatched and audited pages', () => {
  const none = run('L', 800, 'single', { ...p, duplicateShare: 0 });
  assert.equal(none.requests, run('G10', 800).requests);
  const all = run('L', 800, 'single', { ...p, duplicateShare: 1, auditShare: 0 });
  assert.equal(all.requests, 0);
});

test('a usage window turns tokens into hours only when modeled', () => {
  assert.equal(run('G10', 800).windowHours, null);
  const windowed = run('G10', 800, 'single', { ...p, usageTokensPerHour: 1e6 });
  near(windowed.windowHours!, windowed.effectiveInputTokens / 1e6 + windowed.outputTokens / 1e6);
});

test('command-line parsing rejects unknown flags, strategies and parameters', () => {
  assert.equal(parseArgs(['--set', 'charsPerToken=3.5']).params.charsPerToken, 3.5);
  assert.deepEqual(parseArgs(['--pages', '3,4']).pages, [3, 4]);
  assert.throws(() => parseArgs(['--set', 'nope=1']), /Unknown parameter/);
  assert.throws(() => parseArgs(['--strategies', 'Z']), /Unknown strategies/);
  assert.throws(() => parseArgs(['--pages', '0']), /positive integers/);
  assert.throws(() => parseArgs(['--bogus', '1']), /Unknown flag/);
});
