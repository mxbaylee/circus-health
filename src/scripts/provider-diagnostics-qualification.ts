import type {
  ImportDiagnosticExport,
  ImportDiagnosticEvent,
} from '../server/import-diagnostics.ts';
import {
  answersForQualification,
  qualificationBirthDate,
  qualificationPerson,
  qualificationSourceSystem,
} from './provider-qualification-fixture.ts';

/** A narrow privacy canary plus a reconstruction check for one complete fictional Import.
 * The canary proves absence of these fixture strings, not absence of all health content. */
export function gradeDiagnosticLifecycle(
  snapshot: ImportDiagnosticExport,
  afterSequence: number,
  expectedPages: number,
  expected: {
    uploadClientRequestId: string;
    reviewFeedClientRequestIds: readonly string[];
  },
) {
  const reasons: string[] = [];
  const events = snapshot.events.filter((event) => event.sequence > afterSequence);
  const canaries = [
    qualificationPerson,
    qualificationBirthDate,
    qualificationSourceSystem,
    ...answersForQualification('tiny').map((answer) => answer.marker),
  ];
  const serialized = JSON.stringify(snapshot);
  const privacyCanariesAbsent = canaries.every((canary) => !serialized.includes(canary));
  if (!privacyCanariesAbsent) reasons.push('fictional_canary_in_export');
  if (
    snapshot.coverage !== 'bounded_metadata_only' ||
    snapshot.droppedEvents !== 0 ||
    snapshot.retainedEvents !== snapshot.events.length ||
    snapshot.events.some(
      (event, index) => index > 0 && event.sequence <= snapshot.events[index - 1]!.sequence,
    )
  )
    reasons.push('incomplete_event_retention');
  if (
    events.some((event) =>
      Object.entries(event.fields).some(
        ([name, value]) => name.toLowerCase().includes('truncated') && value === true,
      ),
    )
  )
    reasons.push('truncated_event');
  if (!snapshot.recentPerformance) reasons.push('missing_recent_timeline');
  else if (
    snapshot.recentPerformance.droppedOperations > 0 ||
    snapshot.recentPerformance.readFailures > 0 ||
    snapshot.recentPerformance.writeFailures > 0 ||
    snapshot.recentPerformance.operations.some(
      (operation) =>
        operation.droppedEvents > 0 ||
        operation.relatedImportIdsTruncated ||
        operation.lifecycleIncomplete ||
        operation.phaseTotalsTruncated ||
        (operation.recoverySequenceDropped ?? 0) > 0,
    )
  )
    reasons.push('incomplete_recent_timeline');
  const started = events.filter((event) => event.event === 'model.request.started');
  const completed = events.filter((event) => event.event === 'model.request.completed');
  const failed = events.filter((event) => event.event === 'model.request.failed');
  const modelEvents = [...started, ...completed, ...failed];
  const importIds = new Set(modelEvents.map((event) => event.context.importId).filter(Boolean));
  const importId = [...importIds][0];
  if (importIds.size !== 1 || modelEvents.some((event) => !event.context.importId))
    reasons.push('missing_import_correlation');
  const activeStarts = events.filter(
    (event) => event.event === 'import.active.started' && event.context.importId === importId,
  );
  const activeEnds = events.filter(
    (event) => event.event === 'import.active.completed' && event.context.importId === importId,
  );
  const activeKey = (event: ImportDiagnosticEvent) =>
    [event.context.importId, event.context.runId, event.context.sliceId].join('|');
  const activePairs = activeStarts.map((start) => ({
    start,
    end: activeEnds.find((candidate) => activeKey(candidate) === activeKey(start)),
  }));
  if (
    !activePairs.length ||
    activePairs.length !== activeEnds.length ||
    activeStarts.some((event) => !event.context.runId || !event.context.sliceId) ||
    new Set(activeStarts.map(activeKey)).size !== activeStarts.length ||
    activePairs.some(({ start, end }) => !end || end.sequence <= start.sequence)
  )
    reasons.push('incomplete_active_lifecycle');
  const withinActive = (event: ImportDiagnosticEvent) =>
    activePairs.some(
      ({ start, end }) =>
        end &&
        event.context.importId === start.context.importId &&
        event.context.runId === start.context.runId &&
        event.context.sliceId === start.context.sliceId &&
        start.sequence < event.sequence &&
        event.sequence < end.sequence,
    );
  const startedById = new Map(started.map((event) => [event.context.providerRequestId, event]));
  const completedById = new Map(completed.map((event) => [event.context.providerRequestId, event]));
  const sameModelScope = (a: ImportDiagnosticEvent, b: ImportDiagnosticEvent) =>
    a.context.importId === b.context.importId &&
    a.context.runId === b.context.runId &&
    a.context.sliceId === b.context.sliceId &&
    a.context.turnId === b.context.turnId;
  if (
    !started.length ||
    failed.length ||
    started.some((event) => !event.context.providerRequestId || !event.context.turnId) ||
    completed.some((event) => !event.context.providerRequestId || !event.context.turnId) ||
    startedById.size !== started.length ||
    completedById.size !== completed.length ||
    started.length !== completed.length ||
    modelEvents.some((event) => !withinActive(event)) ||
    completed.some((event) => {
      const start = startedById.get(event.context.providerRequestId);
      return !start || start.sequence >= event.sequence || !sameModelScope(start, event);
    })
  )
    reasons.push('unpaired_model_requests');
  const reads = events.filter(
    (event) =>
      event.event === 'model.tool.completed' && event.fields.toolName === 'health_intake_read',
  );
  // Tool completions have no providerRequestId. The bridge executes returned
  // tools after the provider response and before starting its next request.
  const attributableRead = (read: ImportDiagnosticEvent) => {
    if (!withinActive(read) || !read.context.turnId) return false;
    const previousStart = started
      .filter((event) => event.sequence < read.sequence && sameModelScope(event, read))
      .at(-1);
    const response = previousStart && completedById.get(previousStart.context.providerRequestId);
    return (
      !!response && previousStart!.sequence < response.sequence && response.sequence < read.sequence
    );
  };
  const readPages = new Set(
    reads
      .filter(attributableRead)
      .map((event) => event.fields.page)
      .filter((page): page is number => typeof page === 'number' && Number.isInteger(page)),
  );
  if (
    reads.some((read) => !attributableRead(read)) ||
    Array.from({ length: expectedPages }, (_, index) => index + 1).some(
      (page) => !readPages.has(page),
    )
  )
    reasons.push('missing_completed_page_reads');
  const firstActive = Math.min(...activeStarts.map((event) => event.sequence));
  const lastActive = Math.max(...activeEnds.map((event) => event.sequence));
  const phase = (name: string) =>
    events.filter(
      (event) => event.event === 'import.phase.completed' && event.fields.phase === name,
    );
  const uploads = phase('upload_receive').filter(
    (event) =>
      !!event.context.requestId &&
      event.context.clientRequestId === expected.uploadClientRequestId &&
      event.sequence < firstActive,
  );
  const uploadJoined = uploads.some((upload) =>
    phase('upload_original_publish').some(
      (published) =>
        published.context.requestId === upload.context.requestId &&
        !!published.context.spanId &&
        published.sequence <= upload.sequence &&
        phase('upload_original_publish').some(
          (retained) =>
            retained.context.importId === importId &&
            retained.context.parentSpanId === published.context.spanId,
        ),
    ),
  );
  if (
    !uploadJoined ||
    !phase('processing_queue').some(
      (event) =>
        event.context.importId === importId &&
        uploads.some((upload) => upload.sequence < event.sequence && event.sequence < firstActive),
    )
  )
    reasons.push('missing_upload_phase');
  const validation = phase('review_acceptance_validation').filter(
    (event) => event.context.importId === importId && event.sequence > lastActive,
  );
  const applied = phase('review_acceptance_apply').filter(
    (event) =>
      event.context.importId === importId &&
      validation.some((checked) => checked.sequence < event.sequence),
  );
  // Feed query is profile-wide metadata, without an importId. The harness
  // tags its own review requests; exact report review is still proven by the
  // separate acceptance oracle and import-correlated validation/application.
  if (
    !validation.length ||
    !applied.length ||
    !phase('review_feed_query').some(
      (event) =>
        !!event.context.requestId &&
        !!event.context.clientRequestId &&
        expected.reviewFeedClientRequestIds.includes(event.context.clientRequestId) &&
        event.sequence > lastActive &&
        validation.some((checked) => event.sequence < checked.sequence),
    )
  )
    reasons.push('missing_review_acceptance_phases');
  const relevantOperations = snapshot.recentPerformance?.operations.filter(
    (operation) => importId && operation.relatedImportIds.includes(importId),
  );
  if (
    !relevantOperations?.length ||
    !relevantOperations.some(
      (operation) =>
        operation.status === 'completed' &&
        operation.context.importId === importId &&
        activeStarts.some(
          (active) =>
            operation.context.runId === active.context.runId &&
            operation.context.sliceId === active.context.sliceId,
        ) &&
        ['processing_active', 'provider_request', 'tool_execution'].every((name) =>
          operation.spans.some((span) => span.phase === name),
        ),
    )
  )
    reasons.push('missing_correlated_recent_operation');
  const phases = new Set(phase('upload_receive').map((event) => event.fields.phase));
  for (const event of events.filter((event) => event.event === 'import.phase.completed'))
    phases.add(event.fields.phase);
  return {
    passed: reasons.length === 0,
    reasons,
    privacyCanariesAbsent,
    completedModelRequests: completed.length,
    completedPageReads: reads.length,
    pagesRead: [...readPages].sort((a, b) => a - b),
    completedPhases: [...phases]
      .filter((value): value is string => typeof value === 'string')
      .sort(),
  };
}
