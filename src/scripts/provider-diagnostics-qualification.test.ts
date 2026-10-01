import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ImportDiagnosticEvent,
  ImportDiagnosticExport,
} from '../server/import-diagnostics.ts';
import { gradeDiagnosticLifecycle } from './provider-diagnostics-qualification.ts';

function snapshot(): ImportDiagnosticExport {
  const names: ImportDiagnosticEvent['event'][] = [
    'import.phase.completed',
    'import.active.started',
    'model.request.started',
    'model.tool.completed',
    'model.request.completed',
    'import.active.completed',
    'import.phase.completed',
    'import.phase.completed',
    'import.phase.completed',
  ];
  const events: ImportDiagnosticEvent[] = names.map((event, index) => ({
    schemaVersion: 1,
    sequence: index + 1,
    timestamp: '2026-09-30T00:00:00.000Z',
    monotonicMs: index + 1,
    event,
    context: {
      importId: 'fictional-import',
      providerRequestId: 'fictional-request',
      runId: 'fictional-run',
      sliceId: 'fictional-slice',
    },
    fields: (event === 'import.phase.completed'
      ? {
          phase:
            index === 0
              ? 'upload_receive'
              : index === 6
                ? 'review_feed_query'
                : index === 7
                  ? 'review_acceptance_validation'
                  : 'review_acceptance_apply',
        }
      : event === 'model.tool.completed'
        ? { toolName: 'health_intake_read', page: 1, firstRead: true, pdfBytes: 123 }
        : {}) as ImportDiagnosticEvent['fields'],
  }));
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-30T00:00:00.000Z',
    exportId: 'fictional-export',
    consoleScopeId: 'fictional-scope',
    events,
    retainedEvents: events.length,
    droppedEvents: 0,
    coverage: 'bounded_metadata_only',
    recentPerformance: {
      droppedOperations: 0,
      readFailures: 0,
      writeFailures: 0,
      operations: [],
    } as unknown as NonNullable<ImportDiagnosticExport['recentPerformance']>,
  };
}

test('diagnostics reconstruct one correlated completed import without fixture content', () => {
  const grade = gradeDiagnosticLifecycle(snapshot(), 0, 1);
  assert.equal(grade.passed, true);
  assert.equal(grade.completedModelRequests, 1);
  assert.deepEqual(grade.pagesRead, [1]);
});

test('diagnostics reject missing requests, retention loss, truncation and clinical canaries', () => {
  const missing = snapshot();
  missing.events.splice(4, 1);
  missing.retainedEvents--;
  assert.ok(gradeDiagnosticLifecycle(missing, 0, 1).reasons.includes('unpaired_model_requests'));
  const reversed = snapshot();
  reversed.events[2]!.event = 'model.request.completed';
  reversed.events[4]!.event = 'model.request.started';
  assert.ok(gradeDiagnosticLifecycle(reversed, 0, 1).reasons.includes('unpaired_model_requests'));
  const dropped = snapshot();
  dropped.droppedEvents = 1;
  assert.ok(gradeDiagnosticLifecycle(dropped, 0, 1).reasons.includes('incomplete_event_retention'));
  const truncated = snapshot();
  truncated.events[2]!.fields = { requestTruncated: true };
  assert.ok(gradeDiagnosticLifecycle(truncated, 0, 1).reasons.includes('truncated_event'));
  const leaked = snapshot();
  leaked.events[3]!.fields = {
    toolName: 'health_intake_read',
    page: 1,
    firstRead: true,
    note: 'FXP1R02',
  };
  assert.ok(gradeDiagnosticLifecycle(leaked, 0, 1).reasons.includes('fictional_canary_in_export'));
});

test('diagnostics require source reads, upload and active lifecycle on one import correlation', () => {
  const noRead = snapshot();
  noRead.events.splice(3, 1);
  noRead.retainedEvents--;
  assert.ok(
    gradeDiagnosticLifecycle(noRead, 0, 1).reasons.includes('missing_completed_page_reads'),
  );
  const noUpload = snapshot();
  noUpload.events[0]!.fields = { phase: 'other' };
  assert.ok(gradeDiagnosticLifecycle(noUpload, 0, 1).reasons.includes('missing_upload_phase'));
  const noAcceptance = snapshot();
  noAcceptance.events[8]!.fields = { phase: 'other' };
  assert.ok(
    gradeDiagnosticLifecycle(noAcceptance, 0, 1).reasons.includes(
      'missing_review_acceptance_phases',
    ),
  );
  const unrelatedAcceptance = snapshot();
  unrelatedAcceptance.events[8]!.context.importId = 'other-import';
  assert.ok(
    gradeDiagnosticLifecycle(unrelatedAcceptance, 0, 1).reasons.includes(
      'missing_review_acceptance_phases',
    ),
  );
  const noActiveEnd = snapshot();
  noActiveEnd.events.splice(5, 1);
  noActiveEnd.retainedEvents--;
  assert.ok(
    gradeDiagnosticLifecycle(noActiveEnd, 0, 1).reasons.includes('incomplete_active_lifecycle'),
  );
  const mixed = snapshot();
  mixed.events[4]!.context = { importId: 'different', providerRequestId: 'fictional-request' };
  assert.ok(gradeDiagnosticLifecycle(mixed, 0, 1).reasons.includes('missing_import_correlation'));
  const unrelatedRead = snapshot();
  unrelatedRead.events[3]!.context.importId = 'different';
  assert.ok(
    gradeDiagnosticLifecycle(unrelatedRead, 0, 1).reasons.includes('missing_completed_page_reads'),
  );
  const swappedActive = snapshot();
  swappedActive.events[5]!.context.runId = 'another-run';
  assert.ok(
    gradeDiagnosticLifecycle(swappedActive, 0, 1).reasons.includes('incomplete_active_lifecycle'),
  );
  const truncatedSummary = snapshot();
  truncatedSummary.recentPerformance!.droppedOperations = 1;
  assert.ok(
    gradeDiagnosticLifecycle(truncatedSummary, 0, 1).reasons.includes('incomplete_recent_timeline'),
  );
  const missingSummary = snapshot();
  delete missingSummary.recentPerformance;
  assert.ok(
    gradeDiagnosticLifecycle(missingSummary, 0, 1).reasons.includes('missing_recent_timeline'),
  );
});
