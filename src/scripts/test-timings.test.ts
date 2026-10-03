import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestEvent } from 'node:test/reporters';
import timings from './test-timings.ts';

function event(
  name: string,
  error?: unknown,
  duration_ms = 1,
  type: 'test:fail' | 'test:pass' = 'test:fail',
): TestEvent {
  return {
    type,
    data: { name, file: 'fictional.test.ts', details: { duration_ms, error, type: 'test' } },
  } as TestEvent;
}

async function report(events: TestEvent[], ci: string | null = 'true') {
  const previous = process.env.GITHUB_ACTIONS;
  if (ci === null) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = ci;
  try {
    async function* source() {
      yield* events;
    }
    let output = '';
    for await (const chunk of timings(source())) output += chunk;
    return output;
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
}

test('CI annotates fast failures with their nested assertion reason', async () => {
  const output = await report([
    event(
      'fictional fast failure',
      new Error('test failed', { cause: new Error('Expected 2, got 1') }),
    ),
    event('fictional timeout', new Error('Timed out waiting for retained proposal')),
  ]);
  assert.equal(
    output,
    '\n::error::fictional fast failure: test failed — caused by: Expected 2, got 1\n' +
      '\n::error::fictional timeout: Timed out waiting for retained proposal\n',
  );
});

test('workflow commands cannot be injected through names or error messages', async () => {
  const output = await report([
    event('fictional%\r\n::notice::name', new Error('reason%\r\n::error::injected')),
  ]);
  assert.equal(
    output,
    '\n::error::fictional%25%0D%0A::notice::name: reason%25%0D%0A::error::injected\n',
  );
});

test('annotations require exact CI opt-in and never annotate passing tests', async () => {
  for (const ci of [null, 'false', 'TRUE', '1'])
    assert.equal(await report([event('fictional failure', new Error('reason'))], ci), '');
  assert.equal(await report([event('fictional passing test', undefined, 1, 'test:pass')]), '');
});

test('slow-test reporting retains passing tests, failures, order and duration', async () => {
  const output = await report(
    [
      event('fictional slow pass', undefined, 2500, 'test:pass'),
      event('fictional slower failure', new Error('reason'), 4000),
    ],
    'false',
  );
  assert.equal(
    output,
    '\nSlowest tests (including passes):\n' +
      '  4.00s fictional slower failure — fictional.test.ts\n' +
      '  2.50s fictional slow pass — fictional.test.ts\n',
  );
});

test('names, cause depth and messages are bounded without dumping arbitrary error data', async () => {
  const deep = new Error('excluded fifth cause');
  let error = deep;
  for (let level = 0; level < 4; level++)
    error = Object.assign(new Error(`fictional-${level}: ${'x'.repeat(2000)}`, { cause: error }), {
      fictionalPrivateField: 'excluded arbitrary field',
    });
  const output = await report([event('n'.repeat(1000), error)]);
  assert.ok(output.startsWith(`\n::error::${'n'.repeat(299)}…: fictional-3:`));
  assert.ok(output.length < 2400);
  assert.ok(output.includes('…'));
  assert.ok(!output.includes('excluded fifth cause'));
  assert.ok(!output.includes('excluded arbitrary field'));
  const cycle = { message: 'fictional cycle', cause: null as unknown };
  cycle.cause = cycle;
  assert.equal(
    await report([event('fictional cycle test', cycle)]),
    '\n::error::fictional cycle test: fictional cycle\n',
  );
  assert.equal(
    await report([event('fictional missing error')]),
    '\n::error::fictional missing error: Test failed without an error message\n',
  );
});

test('annotation volume is bounded and omitted failures are counted', async () => {
  const output = await report(
    Array.from({ length: 53 }, (_, index) =>
      event(`fictional failure ${index}`, new Error('reason')),
    ),
  );
  assert.equal(output.match(/::error::/g)?.length, 50);
  assert.ok(output.includes('fictional failure 49: reason'));
  assert.ok(!output.includes('fictional failure 50: reason'));
  assert.ok(
    output.endsWith(
      '\n::notice::3 additional test failure annotations omitted (limit 50); see test output.\n',
    ),
  );
});
