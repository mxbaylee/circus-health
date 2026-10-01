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
  const id = (event: ImportDiagnosticEvent) => event.context.providerRequestId;
  const startedIds = started.map(id);
  const completedIds = completed.map(id);
  if (
    !started.length ||
    failed.length ||
    startedIds.some((value) => !value) ||
    new Set(startedIds).size !== started.length ||
    completedIds.length !== started.length ||
    completedIds.some((value) => !value || !startedIds.includes(value)) ||
    new Set(completedIds).size !== completed.length ||
    completed.some(
      (event) =>
        started.find((candidate) => id(candidate) === id(event))!.sequence >= event.sequence,
    )
  )
    reasons.push('unpaired_model_requests');
  const importIds = new Set(
    [...started, ...completed].map((event) => event.context.importId).filter(Boolean),
  );
  if (importIds.size !== 1 || [...started, ...completed].some((event) => !event.context.importId))
    reasons.push('missing_import_correlation');
  const importId = [...importIds][0];
  const reads = events.filter(
    (event) =>
      event.event === 'model.tool.completed' && event.fields.toolName === 'health_intake_read',
  );
  const readPages = new Set(
    reads
      .filter(
        (event) =>
          event.context.importId === importId &&
          !!event.context.providerRequestId &&
          completedIds.includes(event.context.providerRequestId),
      )
      .map((event) => event.fields.page)
      .filter((page): page is number => typeof page === 'number' && Number.isInteger(page)),
  );
  if (
    Array.from({ length: expectedPages }, (_, index) => index + 1).some(
      (page) => !readPages.has(page),
    )
  )
    reasons.push('missing_completed_page_reads');
  const phases = new Set(
    events
      .filter((event) => event.event === 'import.phase.completed')
      .map((event) => event.fields.phase),
  );
  if (!phases.has('upload_receive')) reasons.push('missing_upload_phase');
  if (
    !phases.has('review_feed_query') ||
    !events.some(
      (event) =>
        event.event === 'import.phase.completed' &&
        event.fields.phase === 'review_acceptance_validation' &&
        event.context.importId === importId,
    ) ||
    !events.some(
      (event) =>
        event.event === 'import.phase.completed' &&
        event.fields.phase === 'review_acceptance_apply' &&
        event.context.importId === importId,
    )
  )
    reasons.push('missing_review_acceptance_phases');
  const activeKey = (event: ImportDiagnosticEvent) =>
    `${event.context.importId ?? ''}|${event.context.runId ?? ''}|${event.context.sliceId ?? ''}`;
  const activeStarts = events.filter(
    (event) => event.event === 'import.active.started' && event.context.importId === importId,
  );
  const activeEnds = events.filter(
    (event) => event.event === 'import.active.completed' && event.context.importId === importId,
  );
  const startsByKey = activeStarts.map(activeKey).sort();
  const endsByKey = activeEnds.map(activeKey).sort();
  if (
    !activeStarts.length ||
    activeStarts.some((event) => !event.context.runId || !event.context.sliceId) ||
    JSON.stringify(startsByKey) !== JSON.stringify(endsByKey) ||
    activeEnds.some(
      (event) =>
        (activeStarts.find((candidate) => activeKey(candidate) === activeKey(event))?.sequence ??
          Infinity) >= event.sequence,
    )
  )
    reasons.push('incomplete_active_lifecycle');
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
