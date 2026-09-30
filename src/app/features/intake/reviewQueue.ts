import type { IntakeReportQueueActivity, IntakeReportQueueDetail } from '../../../shared/intake';

export function reportActivityLabel(activity: IntakeReportQueueActivity) {
  const active = activity.runningFiles + activity.queuedFiles;
  if (active)
    return `${active} ${active === 1 ? 'file is' : 'files are'} being read${activity.remainingUnits ? ` · ${activity.remainingUnits} sections remain` : ''}`;
  if (activity.pausedFiles)
    return `${activity.pausedFiles} ${activity.pausedFiles === 1 ? 'file is' : 'files are'} paused · completed work and originals are kept`;
  if (activity.filesAwaitingConversion)
    return `${activity.filesAwaitingConversion} saved ${activity.filesAwaitingConversion === 1 ? 'file is' : 'files are'} waiting to be read`;
  const accounting = activity.readingAccounting;
  if (accounting?.sourceCount === 0) return 'Ready for your first report';
  if (accounting?.allSourceOccurrencesAccounted && accounting.sourceCount > 0) {
    if (activity.allCurrentReportsReviewed)
      return accounting.state === 'accounted_with_gaps'
        ? 'Reading finished · source review available'
        : 'Reading finished · originals remain available';
    return accounting.state === 'accounted_with_gaps'
      ? 'Ready to review · reading notes available'
      : 'Ready to review · source reading accounted for';
  }
  if (activity.allCurrentReportsReviewed && activity.extractionComplete)
    return 'Reading finished · originals remain available';
  if (activity.allCurrentReportsReviewed && activity.extractionUnknownFiles)
    return 'Caught up for now · reading is not yet complete';
  return 'Ready to review reports';
}

export function intakeReadingPauseLabel(reason: string | null | undefined) {
  switch (reason) {
    case 'retain_only':
      return 'Original retained; this format is not interpreted.';
    case 'waiting_for_local_capacity':
      return 'Waiting for local extraction capacity. Completed work is kept; the next step will start automatically.';
    case 'source_changed':
      return 'The retained source no longer matches its recorded identity. Resolve the source integrity problem before resuming.';
    case 'extracting_source_text':
      return 'Extracting and retaining source text locally. Completed pages and corrections are kept.';
    case 'source_review_required':
      return 'Source text needs your review. Expand the affected source section below, resolve the unfinished page, then resume reading.';
    case 'waiting_for_provider':
      return 'Waiting for the provider retry window. Reading will retry automatically; completed source work is kept.';
    case 'provider_authentication':
      return 'The provider rejected authentication. Restore the provider connection; reading then continues automatically. Source work is kept.';
    case 'provider_outcome_unknown':
      return 'The provider request outcome is unknown. Retrying may use additional provider usage. Completed work and unknown usage are retained.';
    case 'provider_retry_limit':
      return 'Waiting for the provider. Reading will retry automatically; completed source work is kept.';
    case 'provider_rejected':
      return 'The provider rejected this request. Fix the provider configuration and check the connection; reading then continues automatically.';
    case 'model_unavailable':
      return 'The model provider was unavailable. Completed work and originals are kept.';
    case 'assistant_busy':
      return 'Waiting for another request to finish; reading continues automatically.';
    case 'no_progress':
      return 'Moxie paused after it could not make more reading progress.';
    case 'time_limit':
      return 'Reading is continuing from the saved checkpoint.';
    case 'context_limit':
      return 'This model context filled before reading finished. Completed work is kept.';
    case 'job_limit':
      return 'Reading is retrying the current section from its saved checkpoint.';
    case 'tool_error':
    case 'runner_error':
    case 'error':
      return 'Reading paused after an unexpected provider or reading error.';
    case 'profile_locked':
      return 'Waiting for unlock. Reading continues automatically after authorized unlock.';
    case 'interrupted':
      return 'Reading was interrupted by a restart. Completed work is kept.';
    case 'stopped':
      return 'You stopped reading. Completed work and originals are kept.';
    case 'items_paused':
      return 'One or more files paused before all source sections were handled.';
    default:
      return 'Reading is paused. Completed work and originals are kept.';
  }
}

export function mergeReportDetailPages(
  current: IntakeReportQueueDetail,
  page: IntakeReportQueueDetail,
): IntakeReportQueueDetail {
  const blocks = new Map(
    current.blocks.map((block) => [`${block.intakeId}\u0000${block.proposalId || ''}`, block]),
  );
  for (const block of page.blocks) {
    const key = `${block.intakeId}\u0000${block.proposalId || ''}`;
    const previous = blocks.get(key);
    if (!previous) {
      blocks.set(key, block);
      continue;
    }
    const records = new Map(previous.records.map((record) => [record.id, record]));
    block.records.forEach((record) => records.set(record.id, record));
    blocks.set(key, { ...block, records: [...records.values()] });
  }
  return {
    ...page,
    blocks: [...blocks.values()],
    totalRecords: page.totalRecords,
    nextCursor: page.nextCursor,
  };
}
