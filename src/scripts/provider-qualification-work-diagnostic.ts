import type { IntakeWorkCounters } from '../server/intake-work-accounting.ts';

export function qualificationOperation(path: string): string {
  const pathname = path.split('?')[0]!;
  return (
    [
      'identity-review',
      'identity-scope-page',
      'identity-scope',
      'report-acceptance',
      'import-feed',
      'report-queue',
      'review',
      'questions',
      'proposals',
      'intake-batches',
      'stop',
      'profile-setups',
      'verify',
      'intakes',
      'lock',
      'unlock',
      'recover',
    ].find((label) => pathname.endsWith('/' + label)) ?? 'other'
  );
}

const selectedKeys = [
  'collectionProjectionPhysicalSweeps',
  'collectionProjectionPhysicalRepeatSweeps',
  'collectionProjectionPhysicalItems',
  'collectionByteChunkReadBytes',
  'collectionPublicClinicalReviews',
  'clinicalReviewMembershipRecords',
  'identityPolicyMembershipComparisons',
  'identityPolicyMembershipResultHits',
  'schemaBuildReplayedOperations',
  'reportSourceScopeMembers',
  'reportSourceScopeRoutingBuilds',
  'collectionFeedRebuiltSources',
  'collectionFeedReviewedRecords',
  'collectionFeedWindowReviews',
  'collectionFeedRowCertificateHashes',
  'collectionFeedRowCertificateBytes',
] as const;

type WorkKey = (typeof selectedKeys)[number];
type WorkPhase = 'warm' | 'reconstruction';
export type QualificationWorkDelta = Record<WorkPhase, Record<WorkKey, number>>;

export function qualificationWorkDelta(
  before: IntakeWorkCounters,
  after: IntakeWorkCounters,
): QualificationWorkDelta {
  const phaseDelta = (phase: WorkPhase) =>
    Object.fromEntries(
      selectedKeys.map((key) => [key, after[phase][key] - before[phase][key]]),
    ) as Record<WorkKey, number>;
  return { warm: phaseDelta('warm'), reconstruction: phaseDelta('reconstruction') };
}
