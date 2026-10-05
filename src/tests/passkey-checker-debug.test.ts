import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { inspectErrorMetadata, validErrorMetadataField } from '../app/passkey-checker/debug.ts';
import {
  isPrfDiagnostics,
  nativeErrorEvidence,
  projectPrfDiagnostics,
} from '../app/passkey-checker/diagnostics.ts';
import type { PrfDiagnostics } from '../app/passkey-checker/diagnostics.ts';
import { createCredential } from '../app/passkey-checker/core.ts';
import { inspectEnvironment } from '../app/passkey-checker/environment.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import type { CheckerState, RunHeader } from '../app/passkey-checker/types.ts';

const run: RunHeader = {
  schemaVersion: 1,
  id: 'fictional-diagnostic-run',
  origin: 'https://example.test',
  secureContext: true,
  rpId: 'example.test',
  userId: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
  createdAt: '2026-10-05T00:00:00.000Z',
  build: { version: '3', revision: 'a'.repeat(40), worktree: 'clean' },
  environment: inspectEnvironment('Mozilla/5.0 (Android 17) Firefox/157.0'),
};

function evidence(error: unknown): PrfDiagnostics {
  return { requestMode: 'eval', inputShape: 'array-buffer', ...nativeErrorEvidence(error) };
}

test('error metadata observes text availability without retaining values or attached payloads', () => {
  let unrelatedReads = 0;
  const error = Object.assign(new Error('fictional message'), {
    stack: 'fictional browser stack',
    cause: new Error('fictional cause'),
    payload: new Uint8Array([7, 8, 9]),
  });
  Object.defineProperty(error, 'unrelated', {
    get() {
      unrelatedReads++;
      throw Error('must not inspect');
    },
  });
  const captured = inspectErrorMetadata(error);
  assert.deepEqual(captured, {
    nativeMessageState: 'text',
    nativeMessageLength: error.message.length,
    nativeStackState: 'text',
    nativeStackLength: error.stack.length,
    nativeCauseState: 'present',
  });
  assert.equal(unrelatedReads, 0);
  assert.doesNotMatch(JSON.stringify(captured), /fictional|payload|7,8,9/);
  const crossRealm = runInNewContext("new Error('fictional cross-realm failure')");
  assert.equal(inspectErrorMetadata(crossRealm).nativeStackState, 'text');
  assert.equal(inspectErrorMetadata('fictional thrown string').nativeMessageState, 'text');
});

test('absent, non-text and inaccessible error properties remain distinct', () => {
  const error = {
    message: undefined,
    stack: 42,
    get cause() {
      throw Error('inaccessible');
    },
  };
  assert.deepEqual(inspectErrorMetadata(error), {
    nativeMessageState: 'absent',
    nativeStackState: 'non-text',
    nativeCauseState: 'unavailable',
  });
  const inaccessible = Object.defineProperty({}, 'stack', {
    get() {
      throw Error('stack getter failed');
    },
  });
  assert.equal(inspectErrorMetadata(inaccessible).nativeStackState, 'unavailable');
  assert.equal(inspectErrorMetadata(null).nativeStackState, 'absent');
});

test('the store projection accepts only valid scalar metadata and survives JSON round trips', () => {
  const captured = evidence(new DOMException('fictional refusal', 'NotAllowedError'));
  assert.equal(isPrfDiagnostics(captured), true);
  assert.deepEqual(projectPrfDiagnostics(JSON.parse(JSON.stringify(captured))), captured);
  for (const value of [-1, NaN, Infinity, '12', {}])
    assert.equal(validErrorMetadataField('nativeStackLength', value), false);
  assert.equal(isPrfDiagnostics({ ...captured, nativeStackState: 'invented' }), false);
  assert.equal(isPrfDiagnostics({ ...captured, stack: 'raw stack' }), false);
  assert.equal(projectPrfDiagnostics({ ...captured, nativeMessageLength: -1 }), undefined);
});

for (const synchronous of [true, false])
  test(`native ${synchronous ? 'throw' : 'rejection'} retains identity and reports available evidence`, async () => {
    const original = Object.assign(new Error('fictional native failure'), { stack: 'fixture stack' });
    let calls = 0;
    let captured: PrfDiagnostics | undefined;
    const pending = createCredential(
      run,
      'A',
      [],
      {
        create() {
          calls++;
          if (synchronous) throw original;
          return Promise.reject(original);
        },
        get: () => Promise.resolve(null),
      },
      (value) => {
        captured = value;
      },
    );
    assert.equal(calls, 1, 'native invocation precedes the first await');
    await assert.rejects(pending, (error) => error === original);
    assert.equal(captured?.nativeOutcome, synchronous ? 'threw' : 'rejected');
    assert.equal(captured?.nativeStackState, 'text');
    assert.equal(captured?.nativeStackLength, 'fixture stack'.length);
    assert.equal(isPrfDiagnostics(captured), true);
  });

test('actual Markdown reports include availability and provider labels, not exception contents', () => {
  const diagnostics = evidence(Object.assign(new Error('FICTIONAL_ORIGINAL_MESSAGE'), {
    stack: 'FICTIONAL_ORIGINAL_STACK',
  }));
  const environment = structuredClone(run.environment);
  environment.provider = { value: 'Fictional Manager', source: 'operator' };
  environment.providerVersion = { value: '1.2.3', source: 'operator' };
  const state: CheckerState = {
    run,
    credentials: [],
    observations: [],
    attempts: [{
      id: 'attempt-one',
      alias: 'A',
      step: 'create',
      status: 'failed',
      error: 'unknown-error',
      startedAt: run.createdAt,
      finishedAt: run.createdAt,
      build: run.build,
      environment,
      diagnostics,
    }],
  };
  const report = reportMarkdown(JSON.parse(JSON.stringify(state)));
  assert.match(report, /native stack availability \(stack not exported\): text/);
  assert.match(report, /native message character count:/);
  assert.match(report, /Fictional Manager/);
  assert.doesNotMatch(report, /FICTIONAL_ORIGINAL_MESSAGE|FICTIONAL_ORIGINAL_STACK/);
});

test('OS releases are advertised hints, not inferred exact releases or provider identity', () => {
  for (const [ua, expected] of [
    ['Mozilla/5.0 (Android 17) Firefox/157.0', '17 (UA hint; may be frozen)'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) Version/18.3 Safari/1', '18.3 (UA hint; may be frozen)'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/1', '10.15.7 (UA hint; may be frozen)'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0', 'NT 10.0 (UA hint; may be frozen)'],
  ]) {
    const current = inspectEnvironment(ua);
    assert.deepEqual(current.osVersion, { value: expected, source: 'browser-reported' });
    assert.equal(current.provider.source, 'unknown');
    assert.equal(current.providerVersion.source, 'unknown');
  }
  assert.equal(inspectEnvironment('Mozilla/5.0 (Linux) Firefox/157.0').osVersion.source, 'unknown');
  assert.equal(inspectEnvironment(`Android ${'1'.repeat(100)}`).osVersion.source, 'unknown');
});
