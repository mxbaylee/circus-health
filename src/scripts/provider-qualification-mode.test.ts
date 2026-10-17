import test from 'node:test';
import assert from 'node:assert/strict';
import { assertContinuingApprovalMode, captureContinuingReading } from './qualify-provider-pdf.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import type { SourceTextIssueList } from '../shared/intake-source-text.ts';

test('continuing approval refuses broader run settings before opening an installation', () => {
  const args = ['--run', '--continuing-approval'];
  assert.equal(assertContinuingApprovalMode(args, {}), true);
  assert.equal(assertContinuingApprovalMode(['--run'], {}), false);
  assert.throws(() => assertContinuingApprovalMode([...args, '--deployment'], {}));
  for (const [key, value] of Object.entries({
    CRS_QUALIFICATION_SCENARIO: 'long',
    CRS_QUALIFICATION_REPEAT: '2',
    CRS_QUALIFICATION_FORMAT: 'both',
    CRS_QUALIFICATION_CACHE: 'paired',
    CRS_QUALIFICATION_ACCEPT: '1',
    CRS_QUALIFICATION_DIAGNOSTICS: '1',
  }))
    assert.throws(() => assertContinuingApprovalMode(args, { [key]: value }), key);
  assert.equal(
    assertContinuingApprovalMode(args, {
      CRS_QUALIFICATION_SCENARIO: 'continuing',
      CRS_QUALIFICATION_REPEAT: '1',
      CRS_QUALIFICATION_FORMAT: 'auto',
      CRS_QUALIFICATION_CACHE: 'configured',
    }),
    true,
  );
});

test('stopped continuing reading is retained without becoming full-import qualification', async () => {
  const sourceHash = 'a'.repeat(64);
  const intake = {
    format: 'health-intake-summary-v3',
    version: 7,
    sha256: sourceHash,
    activePlan: {
      state: 'exact',
      plan: { id: 'fictional-plan', pins: { sourceHash }, unitCount: 2 },
    },
  } as unknown as IntakeRead;
  const page = {
    sourceHash,
    readerCoverage: {
      intakeVersion: 7,
      offset: 0,
      nextOffset: null,
      summary: { units: 2, pending: 1, partial: 1 },
      entries: [],
    },
  } as unknown as SourceTextIssueList;
  const captured: SourceTextIssueList[] = [];
  const result = await captureContinuingReading(
    async <T>() => page as T,
    '/fictional',
    intake,
    sourceHash,
    (p) => captured.push(p),
  );
  assert.equal(result.passed, false);
  assert.equal(result.scope, 'partial_continuing_reading_observation');
  assert.equal(result.summary.pending, 1);
  assert.deepEqual(captured, [page]);
  for (const coverage of [
    { ...page.readerCoverage, intakeVersion: 8 },
    { ...page.readerCoverage, nextOffset: 50 },
  ])
    await assert.rejects(
      captureContinuingReading(
        async <T>() => ({ ...page, readerCoverage: coverage }) as T,
        '/fictional',
        intake,
        sourceHash,
        () => {},
      ),
    );
  await assert.rejects(
    captureContinuingReading(
      async <T>() => page as T,
      '/fictional',
      intake,
      'b'.repeat(64),
      () => {},
    ),
  );
});
