import type { ProposalSourceTextHandoff } from '../shared/intake-source-text.ts';

/** Derive the whole handoff from current source state and actual passage-read state. */
export function proposalSourceTextHandoff(
  currentRevisionId: string | null,
  readRevisionId: string | null | undefined,
): ProposalSourceTextHandoff {
  if (currentRevisionId === null)
    return {
      status: 'unavailable',
      currentRevisionId: null,
      readRequired: false,
      sourceTextRevisionId: null,
      instruction:
        'No durable text revision is available yet. Original-page reads may create one; follow their sourceText metadata before proposing.',
    };
  const instruction =
    'For every next batch/proposal, read the relevant current durable passages with health_intake_source_text if required and include their exact revisionId as sourceTextRevisionId. Do not infer clinical completeness from this metadata. Original-page reads may advance this revision; recheck after reading another page.';
  if (readRevisionId !== currentRevisionId)
    return {
      status: 'read_required',
      currentRevisionId,
      readRequired: true,
      sourceTextRevisionId: null,
      instruction,
    };
  return {
    status: 'ready',
    currentRevisionId,
    readRequired: false,
    sourceTextRevisionId: currentRevisionId,
    instruction,
  };
}
