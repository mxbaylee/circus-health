import assert from 'node:assert/strict';
import test from 'node:test';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
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
