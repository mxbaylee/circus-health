/** Closed review-draft compiler effects. New history deltas retain their actual
 * schema occurrences, so semantic joins never need a copied cumulative array. */
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { WorkflowIndexContribution } from './intake-workflow-index.ts';

export interface WorkflowDraftEffects {
  draftAddresses: readonly string[];
  decisionAddresses: readonly string[];
  resolutionChanges: readonly {
    candidateId: string | null;
    candidateVersionId: string;
    issueId: string;
    resolutionAddress: string;
  }[];
}

export function* workflowDraftIndexContributions(
  before: IntakeCollectionEnvelopeReader,
  after: IntakeCollectionEnvelopeReader,
  effects: WorkflowDraftEffects,
): Generator<WorkflowIndexContribution> {
  const oldFlow = before.child(before.child(before.root(), 'intake')!, 'workflow'),
    flow = after.child(after.child(after.root(), 'intake')!, 'workflow');
  if (!flow) throw Error('Draft command workflow is unavailable');
  const read = (record: IntakeEnvelopeRecord, field: string) => {
    const value = after.field(record, field, { bytes: 8192 });
    if (value.kind !== 'value') throw Error('Draft command identity is unavailable');
    return value.value;
  };
  const text = (record: IntakeEnvelopeRecord, field: string) => {
    const value = read(record, field);
    if (typeof value !== 'string') throw Error('Invalid draft command identity');
    return value;
  };
  let resolutionOrdinal = 0;
  for (const [field, addresses] of [
    ['reviewDrafts', effects.draftAddresses],
    ['decisions', effects.decisionAddresses],
  ] as const) {
    const oldCount = oldFlow ? before.childCount(oldFlow, field) : 0;
    if (after.childCount(flow, field) !== oldCount + addresses.length)
      throw Error('Draft command changed unaccounted historical records');
    for (let n = 0; n < addresses.length; n++) {
      const record = after.childAt(flow, field, oldCount + n)!;
      if (after.address(record) !== addresses[n])
        throw Error('Draft command append order conflicts');
      if (field === 'decisions') {
        if (text(record, 'action') !== 'keep_original_only')
          throw Error('Draft compiler cannot mint an accepted decision');
        continue;
      }
      const candidateId = read(record, 'candidateId'),
        versionId = text(record, 'candidateVersionId');
      if (candidateId !== null && typeof candidateId !== 'string')
        throw Error('Invalid draft candidate identity');
      yield { index: 'draft-version-last', key: [versionId], target: record };
      yield {
        index: 'draft-candidate-version-last',
        key: [JSON.stringify(candidateId), versionId],
        target: record,
      };
      const proposal = after.field(record, 'proposalId', { bytes: 8192 });
      if (
        proposal.kind === 'fragmented' ||
        (proposal.kind === 'value' && proposal.value !== null && typeof proposal.value !== 'string')
      )
        throw Error('Invalid draft proposal identity');
      yield {
        index: 'draft-record-version-last',
        key: [
          proposal.kind === 'value' ? ((proposal.value || '') as string) : '',
          text(record, 'recordId'),
          versionId,
        ],
        target: record,
      };
      for (let i = 0, count = after.childCount(record, 'resolutions'); i < count; i++) {
        const resolution = after.childAt(record, 'resolutions', i)!,
          effect = effects.resolutionChanges[resolutionOrdinal++];
        const issueId = text(resolution, 'issueId');
        if (
          !effect ||
          effect.resolutionAddress !== after.address(resolution) ||
          effect.candidateId !== candidateId ||
          effect.candidateVersionId !== versionId ||
          effect.issueId !== issueId
        )
          throw Error('Draft resolution effect scope conflicts');
        yield {
          index: 'resolution-last',
          key: [JSON.stringify(candidateId), versionId, issueId],
          target: resolution,
        };
      }
    }
  }
  if (resolutionOrdinal !== effects.resolutionChanges.length)
    throw Error('Draft resolution effects include an unrelated record');
}
