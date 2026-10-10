import type { DatabaseSync } from 'node:sqlite';

// Fixed numeric counters only. No identities, paths, values or operation histories
// are retained. Weak ownership lasts as long as the connection, including cache
// invalidation so failed/rolled-back work remains observable.
const primitiveTemplate = {
  handlesCreated: 0,
  coldReconstructions: 0,
  warmLoads: 0,
  ancestorReads: 0,
  candidateCopies: 0,
  patchOperations: 0,
  normalizedStateBytes: 0,
  candidateCopyBytes: 0,
  framesWritten: 0,
  frameBytesWritten: 0,
  readCopies: 0,
  readCopyBytes: 0,
  serializedReadBytes: 0,
  metadataReads: 0,
  metadataReadBytes: 0,
  selectedMetadataSqlPages: 0,
  selectedMetadataSqlReadBytes: 0,
};
const hostTemplate = {
  clinicalSourceScopePrefixVerifiedGroups: 0,
  clinicalSourceScopePrefixRowsRead: 0,
  clinicalSourceScopePrefixMatchedGroups: 0,
  clinicalSourceScopePrefixTextBytesRead: 0,
  clinicalSourceScopePrefixTextBytesWritten: 0,
  clinicalSourceScopePrefixScratchWitnessReads: 0,
  reviewQuestionHydrations: 0,
  reviewQuestionHydrationBytes: 0,
  reviewQuestionHydrationHits: 0,
  reviewQuestionParseBytes: 0,
  reviewQuestionScratchWrittenBytes: 0,
  reviewQuestionScratchReadBytes: 0,
  reviewQuestionScratchDiscardedRows: 0,
  reviewQuestionRecipeMacCalls: 0,
  reviewQuestionRecipeMacBytes: 0,
  schemaBuildOperations: 0,
  schemaBuildReplayedOperations: 0,
  schemaBuildTranscriptHashBytes: 0,
  schemaBuildScratchReadBytes: 0,
  schemaBuildScratchWrittenBytes: 0,
  schemaBuildReplayYields: 0,
  schemaBuildValidationHashBytes: 0,
  schemaBuildValidationChunks: 0,
  schemaBuildValidationYields: 0,
  schemaBuildSourceHashBytes: 0,
  reviewProposalRevisionReads: 0,
  reviewProposalRevisionHits: 0,
  reviewDraftReconstructions: 0,
  reviewDraftHandoffs: 0,
  identityPolicyReceiptReconstructions: 0,
  identityPolicyReceiptCacheHits: 0,
  identityPolicyScopeReconstructions: 0,
  identityPolicyScopeCacheHits: 0,
  identityPolicyReceiptNamespaceReads: 0,
  identityPolicyReceiptNamespaceHits: 0,
  identityPolicyMembershipResolutions: 0,
  identityPolicyMembershipResolutionHits: 0,
  identityFreshnessScopeHashBytes: 0,
  identityFreshnessWarningHashBytes: 0,
  identityWarningContentWrittenRows: 0,
  identityWarningContentWrittenBytes: 0,
  identityWarningContentWriteHashBytes: 0,
  identityWarningBindingsWritten: 0,
  identitySnapshotWarningReadBytes: 0,
  identitySnapshotWarningHashBytes: 0,
  identitySnapshotDeltaDesiredRows: 0,
  identitySnapshotDeltaDesiredBytes: 0,
  identitySnapshotDeltaReadBytes: 0,
  identitySnapshotDeltaHashBytes: 0,
  identitySnapshotDeltaComparedRows: 0,
  identitySnapshotDeltaChangedRows: 0,
  identitySnapshotDeltaWrittenBytes: 0,
  identitySnapshotDeltaDeletedRows: 0,
  identitySnapshotDeltaCertifiedRows: 0,
  identitySnapshotDeltaScratchReadBytes: 0,
  identitySnapshotDeltaScratchWrittenBytes: 0,
  reportSnapshotTextComparedChunks: 0,
  reportSnapshotTextChangedChunks: 0,
  reportSnapshotTextDeletedChunks: 0,
  reportSnapshotTextWrittenBytes: 0,
  reportSnapshotTextReadBytes: 0,
  reportSnapshotTextHashBytes: 0,
  identitySnapshotAliasReadBytes: 0,
  identitySnapshotAliasHashBytes: 0,
  identitySnapshotAliasesWritten: 0,
  identitySnapshotAliasHits: 0,
  collectionByteChunkReads: 0,
  collectionByteChunkReadBytes: 0,
  identityFragmentLegacyReadBytes: 0,
  identityPreviewFullPreparations: 0,
  identityPreviewArtifactChecks: 0,
  identityPreviewArtifactOccurrences: 0,
  reviewIssuePolicyRows: 0,
  reviewIssuePolicyWrittenBytes: 0,
  reviewIssuePolicyReadBytes: 0,
  reviewIssuePolicyPeakValueBytes: 0,
  // Public full source-text read attempts, including unavailable/refused calls.
  sourceTextReadCalls: 0,
  sourceAttentionPreparedSources: 0,
  sourceAttentionReturnedSources: 0,
  reviewQuestionTokenBytes: 0,
  collectionQueuePreparedSources: 0,
  collectionQueueMemberRows: 0,
  collectionQueuePagePointerRows: 0,
  collectionQueuePageMemberDecodes: 0,
  collectionQueueVisibilityRows: 0,
  collectionQueueReceiptRecords: 0,
  collectionQueueClinicalReviews: 0,
  collectionQueuePolicyBorrowHits: 0,
  collectionQueuePolicyBorrowMisses: 0,
  collectionPublicClinicalReviews: 0,
  collectionQueueSummaryBuilds: 0,
  collectionFeedRebuiltSources: 0,
  collectionFeedReviewedRecords: 0,
  collectionFeedRowCertificateHashes: 0,
  collectionFeedRowCertificateBytes: 0,
  collectionSuggestedSourceLookups: 0,
  collectionSuggestedSourceHashes: 0,
  collectionSuggestedSourceHashHits: 0,
  collectionSuggestedSourceMemberHashes: 0,
  duplicateSnapshotComparedRows: 0,
  duplicateSnapshotChangedRows: 0,
  duplicateSnapshotHashedBytes: 0,
  duplicateSnapshotYields: 0,
  duplicateSnapshotSortedRows: 0,
  duplicateSnapshotScratchWrittenBytes: 0,
  duplicateSnapshotScratchReadBytes: 0,
  duplicateEvidenceHashedRows: 0,
  duplicateEvidenceRawHashedRows: 0,
  duplicateEvidenceHashedBytes: 0,
  duplicateEvidenceYields: 0,
  readerCoverageColdUnits: 0,
  readerCoverageChangedUnits: 0,
  readerCoverageDependencyChecks: 0,
  ownershipSnapshotHashedBytes: 0,
  ownershipSnapshotChangedIds: 0,
  ownershipSnapshotComparedIds: 0,
  ownershipSnapshotYields: 0,
  collectionEvidenceFragmentInputBytes: 0,
  collectionEvidenceFragmentScratchWrittenBytes: 0,
  collectionEvidenceFragmentReadBytes: 0,
  collectionEvidenceFragmentPeakBufferBytes: 0,
  schemaCertificationChunks: 0,
  schemaCertificationYields: 0,
  schemaCertificationHashedBytes: 0,
  compactMetadataSourceReadBytes: 0,
  compactMetadataSourceGuardChecks: 0,
  compactMetadataProjectionBytes: 0,
  schemaUpgradeInputUnits: 0,
  schemaUpgradeScratchReadBytes: 0,
  schemaUpgradeScratchWrittenBytes: 0,
  schemaUpgradeNodes: 0,
  schemaUpgradeSqliteCalls: 0,
  schemaUpgradePeakBufferBytes: 0,
  clinicalProjectionEarlierRows: 0,
  clinicalProjectionEarlierRawBytes: 0,
  clinicalProjectionEarlierCanonicalBytes: 0,
  clinicalProjectionRetainedEntries: 0,
  clinicalProjectionChangesetBytes: 0,
  clinicalReviewMembershipRecords: 0,
  clinicalCanonicalIndexColdRows: 0,
  clinicalCanonicalIndexColdBytes: 0,
  clinicalCanonicalIndexChangedRows: 0,
  clinicalCanonicalIndexChangedBytes: 0,
  clinicalCanonicalIndexLookups: 0,
  reportSourceScopeMembers: 0,
  reportSourceScopeRoutingRows: 0,
  reportSourceScopeRoutingBuilds: 0,
  reportSourceScopeRoutingReuses: 0,
  reportSourceScopeOccurrences: 0,
  reportSourceScopeSortComparisons: 0,
  reportSourceScopeScratchReadBytes: 0,
  reportSourceScopeScratchWrittenBytes: 0,
  jsonCanonicalInputCodeUnits: 0,
  jsonCanonicalSqliteCalls: 0,
  jsonCanonicalScratchReadBytes: 0,
  jsonCanonicalScratchWrittenBytes: 0,
  jsonCanonicalOutputBytes: 0,
  jsonCanonicalYields: 0,
  jsonCanonicalPeakBufferBytes: 0,
  jsonCanonicalPeakChunkBytes: 0,
  proposalEntriesProcessed: 0,
  reportMemberHashBytes: 0,
  reportMemberHashItems: 0,
  reportSnapshotCheckpointChanges: 0,
  reportSnapshotCheckpointBatches: 0,
  packagePlanUnitIds: 0,
  packagePlanHashBytes: 0,
  collectionNodeReads: 0,
  collectionReadWitnessQueries: 0,
  collectionNodeCacheHits: 0,
  collectionReadBytes: 0,
  collectionPreparedBytes: 0,
  collectionPeakPreparedBytes: 0,
  collectionNodesWritten: 0,
  collectionWrittenBytes: 0,
  collectionItemsRead: 0,
  normalizeCalls: 0,
  normalizeValidationNodes: 0,
  normalizeCloneNodes: 0,
  normalizeReusedNodes: 0,
  normalizeValidationReusedNodes: 0,
  normalizeValidatedStringUnits: 0,
  trustedCloneCalls: 0,
  trustedCloneNodes: 0,
  immutableNodesFrozen: 0,
  immutableNodesReused: 0,
  candidatePathCopies: 0,
  candidateCopiedMembers: 0,
  candidateVerificationCalls: 0,
  candidateVerificationBytes: 0,
  materializationReads: 0,
  materializationsCreated: 0,
  preparedStateReuses: 0,
  serializationCalls: 0,
  serializedBytes: 0,
  diffCalls: 0,
  diffNodeVisits: 0,
  diffStringComparedUnits: 0,
  arrayMatchSerializedBytes: 0,
  arrayMatchItems: 0,
  diffAlignmentSteps: 0,
  diffTraceCells: 0,
  hashCalls: 0,
  hashedBytes: 0,
  jsonParseCalls: 0,
  jsonParseBytes: 0,
  evidenceDecodeCopyBytes: 0,
  evidenceBufferCopiedBytes: 0,
  evidenceFrameReads: 0,
  evidenceFrameReadBytes: 0,
  evidenceReceiptReads: 0,
  evidenceReceiptReadBytes: 0,
  evidenceReplayVersions: 0,
  evidenceReplayOperations: 0,
  envelopeHydrations: 0,
  envelopeTextReads: 0,
  envelopeSerializedBytes: 0,
  envelopeSerializationCalls: 0,
  rawNormalizations: 0,
  sourceDTOHydrations: 0,
  sourceDTOEnvelopeBytes: 0,
  retainedPlanHeaders: 0,
  retainedPlanUnits: 0,
  retainedPlanCoverageReceipts: 0,
};
export type IntakeHostWork = typeof hostTemplate;
export type IntakeWorkPhase = 'warm' | 'reconstruction';
export interface IntakeWorkCounters {
  primitive: typeof primitiveTemplate;
  warm: IntakeHostWork;
  reconstruction: IntakeHostWork;
}
const connections = new WeakMap<DatabaseSync, IntakeWorkCounters>();
function countersFor(db: DatabaseSync): IntakeWorkCounters {
  let counters = connections.get(db);
  if (!counters) {
    counters = {
      primitive: { ...primitiveTemplate },
      warm: { ...hostTemplate },
      reconstruction: { ...hostTemplate },
    };
    connections.set(db, counters);
  }
  return counters;
}
/** Snapshots cannot alter the measured counters. Initial/conversion/open intervals
 * should be sampled separately. Counts overlap by activity, are logical work, and
 * are not physical allocation or total CPU instructions. JSON runtime internals,
 * SQLite VM/index work is unmeasured here. Accepted-record codecs/hashes and
 * temporary rebuild work have their separate record-version-work observer. */
export function intakeWorkCounters(db: DatabaseSync): IntakeWorkCounters {
  const counters = countersFor(db);
  return {
    primitive: { ...counters.primitive },
    warm: { ...counters.warm },
    reconstruction: { ...counters.reconstruction },
  };
}
let active: { db: DatabaseSync; phase: IntakeWorkPhase; counters: IntakeHostWork } | undefined;
/** Synchronous production boundaries only; restores attribution even on failure.
 * Nested calls on the same database retain an enclosing reconstruction phase. */
export function withIntakeWork<T>(db: DatabaseSync, phase: IntakeWorkPhase, run: () => T): T {
  const previous = active;
  if (previous?.db === db && previous.phase === 'reconstruction') phase = 'reconstruction';
  active = { db, phase, counters: countersFor(db)[phase] };
  try {
    return run();
  } finally {
    active = previous;
  }
}
export function recordIntakeWork(metric: keyof IntakeHostWork, amount = 1): void {
  if (active) active.counters[metric] += amount;
}
/** High-water logical encoded bytes, distinct from cumulative work and RSS. */
export function recordIntakePeak(
  metric:
    | 'collectionPeakPreparedBytes'
    | 'jsonCanonicalPeakBufferBytes'
    | 'jsonCanonicalPeakChunkBytes'
    | 'schemaUpgradePeakBufferBytes'
    | 'reviewIssuePolicyPeakValueBytes'
    | 'collectionEvidenceFragmentPeakBufferBytes',
  amount: number,
): void {
  if (active) active.counters[metric] = Math.max(active.counters[metric], amount);
}
/** Charge a known existing serialization, never serialize solely for accounting. */
export function recordIntakeSerialization(text: string): string {
  recordIntakeWork('serializationCalls');
  recordIntakeWork('serializedBytes', Buffer.byteLength(text));
  return text;
}
export function recordIntakePrimitiveWork(
  db: DatabaseSync,
  metric: keyof typeof primitiveTemplate,
  amount = 1,
): void {
  countersFor(db).primitive[metric] += amount;
}
/** Keep every handle's old counters independent while also aggregating handles
 * created internally by production readers/writers. */
export function createIntakePrimitiveCounters(db: DatabaseSync) {
  recordIntakePrimitiveWork(db, 'handlesCreated');
  const counters = { ...primitiveTemplate };
  return {
    counters,
    count(metric: keyof typeof primitiveTemplate, amount = 1) {
      counters[metric] += amount;
      recordIntakePrimitiveWork(db, metric, amount);
    },
  };
}
