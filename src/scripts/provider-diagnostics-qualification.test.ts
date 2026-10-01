import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ImportDiagnosticEvent,
  ImportDiagnosticExport,
} from '../server/import-diagnostics.ts';
import { gradeDiagnosticLifecycle } from './provider-diagnostics-qualification.ts';

const importId = 'fictional-import';
const runId = 'fictional-run';
const sliceId = 'fictional-slice';
const turnId = 'fictional-turn';
const providerRequestId = 'fictional-provider-request';
const uploadClientRequestId = '00000000-0000-4000-8000-000000000001';
const reviewClientRequestId = '00000000-0000-4000-8000-000000000002';
const expected = {
  uploadClientRequestId,
  reviewFeedClientRequestIds: [reviewClientRequestId],
};
const runContext = { importId, runId, sliceId };
const modelContext = { ...runContext, turnId, providerRequestId };

function snapshot(): ImportDiagnosticExport {
  const events: ImportDiagnosticEvent[] = [];
  const add = (
    event: ImportDiagnosticEvent['event'],
    context: ImportDiagnosticEvent['context'],
    fields: ImportDiagnosticEvent['fields'] = {},
  ) => {
    const sequence = events.length + 1;
    events.push({
      schemaVersion: 1,
      sequence,
      timestamp: '2026-09-30T00:00:00.000Z',
      monotonicMs: sequence,
      event,
      context: { ...context },
      fields: { ...fields },
    });
  };
  add(
    'import.phase.started',
    { requestId: 'upload-request', clientRequestId: uploadClientRequestId },
    { phase: 'upload_receive' },
  );
  add(
    'import.phase.started',
    {
      requestId: 'upload-request',
      clientRequestId: uploadClientRequestId,
      spanId: 'curation-span',
    },
    { phase: 'upload_curation_publish' },
  );
  add(
    'import.phase.completed',
    {
      requestId: 'upload-request',
      clientRequestId: uploadClientRequestId,
      spanId: 'original-publish-span',
      parentSpanId: 'curation-span',
    },
    { phase: 'upload_original_publish' },
  );
  add(
    'import.progress',
    {
      requestId: 'upload-request',
      clientRequestId: uploadClientRequestId,
      parentSpanId: 'curation-span',
      importId,
    },
    { phase: 'upload_retained' },
  );
  add(
    'import.phase.completed',
    {
      requestId: 'upload-request',
      clientRequestId: uploadClientRequestId,
      spanId: 'curation-span',
    },
    { phase: 'upload_curation_publish' },
  );
  add(
    'import.phase.completed',
    { requestId: 'upload-request', clientRequestId: uploadClientRequestId },
    { phase: 'upload_receive' },
  );
  add(
    'import.phase.completed',
    { importId, batchId: 'fictional-batch' },
    { phase: 'processing_queue' },
  );
  add('import.active.started', runContext);
  add('model.request.started', modelContext);
  add('model.request.completed', modelContext);
  add(
    'model.tool.completed',
    { ...runContext, turnId },
    { toolName: 'health_intake_read', page: 1, firstRead: true, pdfBytes: 123 },
  );
  add('import.active.completed', runContext);
  add(
    'import.phase.completed',
    { requestId: 'review-request', clientRequestId: reviewClientRequestId },
    { phase: 'review_feed_query' },
  );
  add('import.phase.completed', { importId }, { phase: 'review_acceptance_validation' });
  add('import.phase.completed', { importId }, { phase: 'review_acceptance_apply' });
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
      operations: [
        {
          relatedImportIds: [importId],
          context: runContext,
          status: 'completed',
          spans: ['processing_active', 'provider_request', 'tool_execution'].map((phase) => ({
            phase,
            durationMs: 1,
          })),
          droppedEvents: 0,
          relatedImportIdsTruncated: false,
          lifecycleIncomplete: false,
          phaseTotalsTruncated: false,
          recoverySequenceDropped: 0,
        },
      ],
    } as unknown as NonNullable<ImportDiagnosticExport['recentPerformance']>,
  };
}

const grade = (value: ImportDiagnosticExport) => gradeDiagnosticLifecycle(value, 0, 1, expected);
const resequence = (value: ImportDiagnosticExport) => {
  value.events.forEach((event, index) => {
    event.sequence = index + 1;
    event.monotonicMs = index + 1;
  });
};

test('realistic returned-tool ordering and correlated lifecycle pass the bounded oracle', () => {
  const result = grade(snapshot());
  assert.equal(result.passed, true, result.reasons.join(','));
  assert.deepEqual(result.pagesRead, [1]);
  assert.equal(result.completedModelRequests, 1);
});

test('missing, reversed, or unrelated provider responses and source reads fail closed', () => {
  const missing = snapshot();
  missing.events.splice(9, 1);
  missing.retainedEvents--;
  assert.ok(grade(missing).reasons.includes('unpaired_model_requests'));
  const beforeResponse = snapshot();
  const read = beforeResponse.events.splice(10, 1)[0]!;
  beforeResponse.events.splice(9, 0, read);
  resequence(beforeResponse);
  assert.ok(grade(beforeResponse).reasons.includes('missing_completed_page_reads'));
  const otherRun = snapshot();
  otherRun.events[10]!.context.runId = 'unrelated-run';
  assert.ok(grade(otherRun).reasons.includes('missing_completed_page_reads'));
  const otherImport = snapshot();
  otherImport.events[9]!.context.importId = 'unrelated-import';
  assert.ok(grade(otherImport).reasons.includes('missing_import_correlation'));
});

test('active run must enclose the model requests and read with the same run and slice', () => {
  const swappedEnd = snapshot();
  swappedEnd.events[11]!.context.runId = 'unrelated-run';
  assert.ok(grade(swappedEnd).reasons.includes('incomplete_active_lifecycle'));
  const earlyEnd = snapshot();
  const end = earlyEnd.events.splice(11, 1)[0]!;
  earlyEnd.events.splice(8, 0, end);
  resequence(earlyEnd);
  assert.ok(grade(earlyEnd).reasons.includes('unpaired_model_requests'));
  const otherModelRun = snapshot();
  otherModelRun.events[8]!.context.runId = 'unrelated-run';
  assert.ok(grade(otherModelRun).reasons.includes('unpaired_model_requests'));
});

test('upload publication must be joined to this import; tagged review and acceptance must follow reading', () => {
  const otherUpload = snapshot();
  otherUpload.events[5]!.context.clientRequestId = 'unrelated-upload';
  assert.ok(grade(otherUpload).reasons.includes('missing_upload_phase'));
  const brokenUploadLink = snapshot();
  brokenUploadLink.events[3]!.context.parentSpanId = 'unrelated-span';
  assert.ok(grade(brokenUploadLink).reasons.includes('missing_upload_phase'));
  const otherReview = snapshot();
  otherReview.events[12]!.context.clientRequestId = 'unrelated-review';
  assert.ok(grade(otherReview).reasons.includes('missing_review_acceptance_phases'));
  const earlyAcceptance = snapshot();
  const phases = earlyAcceptance.events.splice(13, 2);
  earlyAcceptance.events.splice(7, 0, ...phases);
  resequence(earlyAcceptance);
  assert.ok(grade(earlyAcceptance).reasons.includes('missing_review_acceptance_phases'));
  const wrongAcceptance = snapshot();
  wrongAcceptance.events[14]!.context.importId = 'unrelated-import';
  assert.ok(grade(wrongAcceptance).reasons.includes('missing_review_acceptance_phases'));
});

test('recent operation evidence, retention and fixture privacy canaries are mandatory', () => {
  const emptyOperations = snapshot();
  emptyOperations.recentPerformance!.operations = [];
  assert.ok(grade(emptyOperations).reasons.includes('missing_correlated_recent_operation'));
  const incomplete = snapshot();
  incomplete.recentPerformance!.operations[0]!.lifecycleIncomplete = true;
  assert.ok(grade(incomplete).reasons.includes('incomplete_recent_timeline'));
  const absent = snapshot();
  delete absent.recentPerformance;
  assert.ok(grade(absent).reasons.includes('missing_recent_timeline'));
  const dropped = snapshot();
  dropped.droppedEvents = 1;
  assert.ok(grade(dropped).reasons.includes('incomplete_event_retention'));
  const truncated = snapshot();
  truncated.events[9]!.fields = { requestTruncated: true };
  assert.ok(grade(truncated).reasons.includes('truncated_event'));
  const leaked = snapshot();
  leaked.events[10]!.fields = { toolName: 'health_intake_read', page: 1, note: 'FXP1R02' };
  assert.ok(grade(leaked).reasons.includes('fictional_canary_in_export'));
});
