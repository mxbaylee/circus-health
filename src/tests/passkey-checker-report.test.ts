import assert from 'node:assert/strict';
import test from 'node:test';
import { isVerifiedReturnToA, reportMarkdown } from '../app/passkey-checker/report.ts';
import { inspectEnvironment } from '../app/passkey-checker/environment.ts';
import type { CheckerState } from '../app/passkey-checker/types.ts';
const build = { version: '1', revision: 'fictional', worktree: 'clean' };
const environment = inspectEnvironment('');
const state = (): CheckerState => ({
  run: {
    schemaVersion: 1,
    id: 'fictional',
    origin: 'https://example.test',
    secureContext: true,
    rpId: 'example.test',
    userId: 'never-export-user',
    createdAt: '2026-10-03',
    build,
    environment,
  },
  credentials: [
    {
      alias: 'A',
      id: 'cHVibGljLXJlZmVyZW5jZS1maWN0aW9uYWw',
      salt: 'never-export-salt',
      cipher: { iv: 'never-export-iv', data: 'never-export-cipher' },
    },
  ],
  attempts: [
    {
      id: 'never-export-attempt-id',
      alias: 'A',
      step: 'create',
      status: 'created',
      startedAt: '2026-10-03',
      build,
      environment,
    },
    {
      id: 'failed',
      alias: 'A',
      step: 'confirm',
      status: 'failed',
      error: 'not-allowed',
      startedAt: '2026-10-03',
      build: { ...build, revision: 'attempt-build' },
      environment,
    },
  ],
  observations: [
    {
      id: 'manual',
      alias: 'A',
      step: 'confirm',
      outcome: 'worked',
      note: 'fictional note',
      createdAt: '2026-10-03',
      build,
      environment,
    },
  ],
});
test('partial report separates manual worked from failure, creation from PRF and all remaining release gates', () => {
  const report = reportMarkdown(state());
  assert.match(report, /Report schema: 3/);
  assert.match(report, /created only; PRF not verified/);
  assert.match(report, /Confirm PRF and fictional encryption, attempt 1: failed/);
  assert.match(report, /cancelled, timed out, or refused/);
  assert.match(report, /Worked \(manual\)/);
  assert.match(report, /Fresh use 3: unfinished/);
  assert.match(report, /Credential B/);
  assert.match(report, /not a signed attestation/);
  for (const expected of [
    'localhost',
    'session authorization',
    'profile recovery',
    'while locked',
    'container recreation',
    'CRS-163',
    'CRS-088',
    'salt-migration',
  ])
    assert.ok(report.includes(expected));
  assert.match(report, /attempt\\-build/);
  assert.match(report, /Use A after B is created: unfinished; no automatic evidence/);
  assert.doesNotMatch(report.split('### Credential B')[1], /Use A after B is created/);
});

test('legacy PRF failures retain their combined meaning without invented diagnostics', () => {
  const model = state();
  model.attempts[1].error = 'missing-prf';
  const report = reportMarkdown(model);
  assert.match(report, /No valid 32-byte PRF result was returned/);
  assert.doesNotMatch(report, /Safe request diagnostics|output shape|input shape/);
  assert.doesNotMatch(report, /PRF result was absent|PRF representation was invalid/);
  assert.equal(model.attempts[1].diagnostics, undefined);
  assert.equal(model.run.build.version, '1');
  assert.equal(model.attempts[1].build.revision, 'attempt-build');
});

test('report independently projects diagnostic metadata without exporting unknown or native fields', () => {
  const model = state();
  model.attempts[1].diagnostics = {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'array',
    outputLength: 31,
    credentialMatched: true,
    secret: 'never-export-diagnostic-secret',
    rawId: new Uint8Array([8, 7, 6]),
    salts: { first: 'never-export-diagnostic-salt' },
    nativeResponse: { prf: 'never-export-native-response' },
  } as NonNullable<(typeof model.attempts)[number]['diagnostics']>;
  const report = reportMarkdown(model);
  assert.match(report, /Safe request diagnostics: request mode: eval; input shape: array-buffer/);
  assert.match(report, /output shape: array; output length: 31; returned credential matched: true/);
  for (const secret of ['never-export', 'rawId', 'nativeResponse'])
    assert.ok(!report.includes(secret));
  model.attempts[1].diagnostics = {
    ...model.attempts[1].diagnostics,
    outputShape: 'never-export-invalid-known-field',
  } as unknown as NonNullable<(typeof model.attempts)[number]['diagnostics']>;
  assert.doesNotMatch(reportMarkdown(model), /Safe request diagnostics|never-export/);
});

test('failure report retains exact validation expectations and safe native distinctions', () => {
  const model = state();
  model.attempts[1].error = 'prf-invalid';
  model.attempts[1].diagnostics = {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    operation: 'confirm',
    stage: 'prf-validation',
    applicationError: 'prf-invalid',
    validationRule: 'prf-output-array-bytes',
    allowCredentialCount: 1,
    requestCredentialMatched: true,
    requiredUserVerification: true,
    extensionPresent: true,
    extensionShape: 'object',
    resultsPresent: true,
    resultsShape: 'object',
    outputShape: 'array',
    outputLength: 32,
    arrayEntriesValid: false,
    credentialMatched: true,
  };
  const report = reportMarkdown(model);
  assert.match(
    report,
    /operation: confirm; stage: prf-validation; application error code: prf-invalid/,
  );
  assert.match(report, /allowed credential count: 1/);
  assert.match(report, /array entries are bytes: false/);
  assert.match(
    report,
    /validation rule: prf-output-array-bytes; expected: 32 integer byte entries between 0 and 255/,
  );
  assert.match(report, /output shape: array; output length: 32/);
  assert.match(
    report,
    /InvalidStateError with exclusions is consistent with duplicate exclusion but does not prove it/,
  );
  model.attempts[1].diagnostics.nativeErrorName = 'private-provider-message' as never;
  assert.doesNotMatch(reportMarkdown(model), /Safe request diagnostics|private-provider-message/);
});

test('failed-B recovery reports retain historical success and locate each newer unfinished failure without IDs', () => {
  const model = state();
  const failedB = {
    ...model.attempts[1],
    id: 'never-export-first-failed-b-id',
    alias: 'B' as const,
    step: 'create' as const,
    error: 'invalid-state' as const,
    startedAt: '2026-10-03T00:01:00.000Z',
    finishedAt: '2026-10-03T00:02:00.000Z',
  };
  const recovered = {
    ...model.attempts[1],
    id: 'never-export-a-recovery-id',
    step: 'use-after-b-failed' as const,
    status: 'verified' as const,
    error: undefined,
    afterAttemptId: failedB.id,
    startedAt: '2026-10-03T00:03:00.000Z',
    finishedAt: '2026-10-03T00:04:00.000Z',
  };
  const newerFailure = {
    ...failedB,
    id: 'never-export-newer-failed-b-id',
    error: 'unknown-error' as const,
    startedAt: '2026-10-03T00:05:00.000Z',
    finishedAt: '2026-10-03T00:06:00.000Z',
  };
  model.attempts.push(failedB, recovered, newerFailure);
  const report = reportMarkdown(model);
  assert.match(
    report,
    /Use A after B creation fails, attempt 1: verified PRF and fictional decryption/,
  );
  assert.match(report, /Recovery after the latest failed B creation: unfinished/);
  assert.match(report, /Linked failed B creation: attempt 1/);
  assert.match(report, /does not verify B or complete two-credential enrollment/);
  assert.doesNotMatch(report, /never-export|afterAttemptId/);
  recovered.afterAttemptId = 'never-export-orphan';
  const orphanReport = reportMarkdown(model);
  assert.match(orphanReport, /Use A after B creation fails, attempt 1: pending or unfinished/);
  assert.match(orphanReport, /Linked failed B creation: unavailable or invalid/);
  assert.doesNotMatch(orphanReport, /never-export|afterAttemptId/);
});

test('A return requires its own verified use after B creation even when B is unconfirmed', () => {
  const model = state();
  const returnAttempt = {
    ...model.attempts[1],
    id: 'return-to-a',
    step: 'use-after-b' as const,
    status: 'verified' as const,
    startedAt: '2026-10-03T00:01:00.000Z',
    finishedAt: '2026-10-03T00:02:00.000Z',
    error: undefined,
  };
  model.attempts.push(returnAttempt);
  let report = reportMarkdown(model);
  assert.equal(isVerifiedReturnToA(model, returnAttempt), false);
  assert.match(
    report,
    /Use A after B is created, attempt 1: pending or unfinished; no verified result/,
  );
  assert.match(report, /B need not be confirmed/);
  assert.match(report, /do not prove an independent authenticator/);
  model.credentials.push({ alias: 'B', id: 'Yg', salt: 'fictional' });
  const creation = {
    ...model.attempts[0],
    id: 'create-b',
    alias: 'B' as const,
    startedAt: '2026-10-03T00:00:30.000Z',
    finishedAt: '2026-10-03T00:03:00.000Z',
  };
  model.attempts.push(creation);
  assert.equal(isVerifiedReturnToA(model, returnAttempt), false);
  creation.finishedAt = returnAttempt.startedAt;
  assert.equal(isVerifiedReturnToA(model, returnAttempt), true);
  report = reportMarkdown(model);
  assert.match(
    report,
    /Use A after B is created, attempt 1: verified PRF and fictional decryption/,
  );
  assert.match(report, /Confirm PRF and fictional encryption: unfinished/);
  assert.doesNotMatch(report.split('### Credential B')[1], /Use A after B is created/);
  model.attempts = model.attempts.filter((attempt) => attempt.id !== returnAttempt.id);
  model.observations.push({
    ...model.observations[0],
    id: 'manual-return',
    step: 'use-after-b',
  });
  model.observations.push({
    ...model.observations[0],
    id: 'invalid-b-return',
    alias: 'B',
    step: 'use-after-b',
  });
  report = reportMarkdown(model);
  assert.match(report, /Use A after B is created: unfinished; no automatic evidence/);
  assert.match(report, /Use A after B is created: Worked \(manual\)/);
  assert.doesNotMatch(report, /Credential B, Use A after B is created/);
});
test('allowlisted report redacts credential IDs in supported representations and escapes bounded free text', () => {
  const model = state();
  const id = model.credentials[0].id;
  const buffer = Buffer.from(id, 'base64url');
  model.observations[0].note = [
    id,
    buffer.toString('base64'),
    buffer.toString('hex'),
    buffer.toString('hex').toUpperCase(),
    [...buffer].join(','),
    [...buffer].join(', '),
    buffer.toString(),
    '<script>alert(1)</script> **fake passed**',
    'z'.repeat(2000),
  ].join(' ');
  model.run.environment = {
    ...environment,
    provider: { value: id, source: 'operator', reportedValue: 'original hint' },
  };
  const report = reportMarkdown(model);
  for (const forbidden of [
    id,
    buffer.toString('hex'),
    buffer.toString(),
    'never-export',
    '<script>',
    '**fake passed**',
    'z'.repeat(2001),
  ])
    assert.ok(!report.includes(forbidden), `must omit ${forbidden.slice(0, 30)}`);
  assert.match(report, /credential reference redacted/);
  assert.match(report, /original browser report: original hint/);
  assert.match(report, /&lt;script&gt;/);
});

test('unsupported-origin partial reports do not claim HTTPS or silently truncate supported notes', () => {
  const model = state();
  model.run.origin = 'http://localhost:4173';
  model.run.rpId = 'localhost';
  model.attempts = [];
  model.run.secureContext = false;
  model.observations[0].note = `${'x'.repeat(1900)} end of bounded note`;
  const report = reportMarkdown(model);
  assert.match(report, /Recorded origin: http:/);
  assert.match(report, /Initial browser secure-context observation: false/);
  assert.match(report, /end of bounded note/);
  assert.doesNotMatch(report, /Tested HTTPS origin/);
  assert.match(report, /localhost development record/);
  assert.match(report, /does not establish application access or hosted physical qualification/);
  assert.doesNotMatch(report, /relying-party domain, not localhost/);
  assert.match(report, /browser: unknown \(unknown\)/);
  assert.match(report, /Confirm PRF and fictional encryption: unfinished/);
});
