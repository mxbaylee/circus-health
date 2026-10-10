import { createClinicalSourceScopePrefix } from './intake-source-scope-prefix.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { finishClinicalReviewWork, everyClinicalReviewWork } from './clinical-review-work.ts';
import {
  selectedReportGroupLinksWork,
  selectedReportGroups,
} from './intake-selected-report-groups.ts';
import { selectedDraftHandoff } from './intake-review-draft-handoff.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';
import { collectSelectedEvidencedIdentityWork } from './intake-identity-name-evidence.ts';
import { recordIntakeWork } from './intake-work-accounting.ts';
import { nativeIdentityPolicyScope } from './intake-identity-snapshot.ts';
import type { IntakeIdentityScopeReference } from '../shared/intake-identity.ts';
import type { ClinicalOriginalScope } from './clinical-source-scope.ts';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import {
  intakeEnvelopeRecordOrder,
  intakeEnvelopeFieldAccess,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { ReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type {
  IntakeCandidateVersion,
  IntakeQuestion,
  IntakeReviewDraft,
  IntakeReviewGroupReference,
  IntakeSourceContext,
} from '../shared/intake.ts';
import type {
  IdentityPolicyReceipt,
  IdentityPolicyTargets,
  IdentityPolicyMember,
  SelectedIdentityMembership,
} from './intake-identity-policy.ts';
import {
  structuredEvidencedIdentityWork,
  iterateCompetingIdentityBoundaries,
  identityCompetingClaimsEqualWork,
} from './intake-identity-policy.ts';
import {
  intakeCandidateVersionIdForRevision,
  type WorkflowReviewGroup,
  type WorkflowReviewScope,
} from './intake-workflow.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import { reviewRecordIssues } from './intake-review-issue-state.ts';
import { selectedReviewQuestions } from './intake-review-question-selection.ts';
import { readSelectedManualSourceReceipt } from './intake-manual-receipt.ts';

type IntakeCandidateOccurrence = IntakeCandidateVersion['occurrences'][number];
type SelectedWorkflowReviewScope = Omit<WorkflowReviewScope, 'membership'> & {
  membership(group: WorkflowReviewGroup): SelectedIdentityMembership;
};
type IdentityReceiptWork =
  | 'reviewProposalRevisionReads'
  | 'reviewProposalRevisionHits'
  | 'reviewDraftReconstructions'
  | 'reviewDraftHandoffs'
  | 'identityPolicyReceiptReconstructions'
  | 'identityPolicyReceiptCacheHits'
  | 'identityPolicyScopeReconstructions'
  | 'identityPolicyScopeCacheHits'
  | 'identityPolicyReceiptNamespaceReads'
  | 'identityPolicyReceiptNamespaceHits'
  | 'identityPolicyMembershipResolutions'
  | 'identityPolicyMembershipResolutionHits';

export interface IntakeReviewFragmentReference {
  format: 'health-intake-review-fragment-v1';
  logical: IntakeCollectionEnvelopeReader['logical'];
  address: string;
  field?: string;
}
/** Presentation budget exhaustion retains the exact address; it is never clinical absence. */
export class IntakeReviewFragmentRequired extends Error {
  readonly reference: IntakeReviewFragmentReference;
  constructor(reference: IntakeReviewFragmentReference) {
    super('Selected clinical evidence requires fragment access');
    this.name = 'IntakeReviewFragmentRequired';
    this.reference = reference;
  }
}
export function* intakeReviewChildren(
  view: IntakeCollectionEnvelopeReader,
  parent: IntakeEnvelopeRecord | undefined,
  field: string,
): Generator<IntakeEnvelopeRecord> {
  if (!parent) return;
  let after: string | undefined;
  do {
    const page = view.children(parent, field, { after, items: 64, bytes: 128 * 1024 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after || !page.records.length)
      throw Error('Clinical scope did not advance');
    after = page.after;
  } while (true);
}
export function readIntakeReviewValue<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  bytes: number,
): T {
  const chunks: string[] = [];
  let size = 0;
  for (const chunk of view.recordChunks(record)) {
    size += Buffer.byteLength(chunk);
    if (size > bytes)
      throw new IntakeReviewFragmentRequired({
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(record),
      });
    chunks.push(chunk);
  }
  return parseLiteralJSON(chunks.join('')) as T;
}
const hashChunks = (chunks: Iterable<string>) => {
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
};

function* hashChunksWork(chunks: Iterable<string>): Generator<void, string, void> {
  const hash = createHash('sha256');
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length;) {
      let end = Math.min(offset + 64 * 1024, chunk.length);
      // Keep UTF-16 pairs together so chunk boundaries preserve the UTF-8 digest.
      if (
        end < chunk.length &&
        chunk.charCodeAt(end - 1) >= 0xd800 &&
        chunk.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      hash.update(chunk.slice(offset, end));
      offset = end;
      yield;
    }
    yield;
  }
  return hash.digest('hex');
}

/** Complete joins over selected authority. The host supplies current source, policy and inventory proofs. */
export function collectionWorkflowReviewScope(input: {
  close?(): void;
  policySql?: import('node:sqlite').DatabaseSync;
  sourceScopePrefixProof?: () => string | undefined;
  sourceScopePrefixWork?: (
    metric: import('./intake-source-scope-prefix.ts').SourceScopePrefixMetric,
    count: number,
  ) => void;
  issueSink?: import('./intake-workflow.ts').WorkflowReviewScope['issueSink'];
  bindIdentityWarnings?: import('./intake-workflow.ts').WorkflowReviewScope['bindIdentityWarnings'];
  bindIdentityWarningsWork?: import('./intake-workflow.ts').WorkflowReviewScope['bindIdentityWarningsWork'];
  questionState?: ReturnType<
    typeof import('./intake-review-question-state.ts').openReviewQuestionState
  >;
  questionIndex?: ReturnType<
    typeof import('./intake-review-question-index.ts').indexedReviewQuestions
  >;
  readDraft?: (record: IntakeEnvelopeRecord) => IntakeReviewDraft;
  readDraftWork?: (record: IntakeEnvelopeRecord) => Generator<void, IntakeReviewDraft, void>;
  membershipIndex?: import('./intake-review-membership-index.ts').CollectionReviewMembership;
  view: IntakeCollectionEnvelopeReader;
  catalog: ReportSnapshotCatalog;
  metadataBytes: number;
  /** A host-verified SQLite state stamp; omitted hosts perform every read. */
  readCacheState?: () => string | undefined;
  /** In-flight provider authority, excluding only certified disposable maintenance. */
  readProofState?: () => string | undefined;
  /** Receipt snapshot accessors only; transaction-bound membership stays uncached. */
  readIdentityReceiptScopeState?: () => string | undefined;
  readIdentityReceiptScopeProofState?: () => string | undefined;
  identityReceiptWork?(metric: IdentityReceiptWork): void;
  packageEvidence: boolean;
  activeReceipt(receipt: IdentityPolicyReceipt): boolean;
  originalFingerprint(group: WorkflowReviewGroup): string;
  reportSource: WorkflowReviewScope['reportSource'];
  reportSourceWork?: WorkflowReviewScope['reportSourceWork'];
}): SelectedWorkflowReviewScope & {
  canonicalReviewRecords(records: unknown): Iterable<string>;
  latestAcceptedRecord(
    recordId: string,
  ): import('../shared/intake.ts').IntakeReviewDecision | undefined;
  latestAcceptedRecordWork(
    recordId: string,
  ): Generator<void, import('../shared/intake.ts').IntakeReviewDecision | undefined, void>;
  reportContext(
    envelopeId: string,
    proposalId: string | null,
  ): IntakeSourceContext['reportContext'] | undefined;
  reportContextWork(
    envelopeId: string,
    proposalId: string | null,
  ): Generator<void, IntakeSourceContext['reportContext'] | undefined, void>;
  occurrenceWork(
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): Generator<void, IntakeCandidateOccurrence | undefined, void>;
  groupRecords(): Iterable<IntakeEnvelopeRecord>;
  groupHeader(record: IntakeEnvelopeRecord): WorkflowReviewGroup;
  currentGroupVersion(record: IntakeEnvelopeRecord): IntakeEnvelopeRecord | undefined;
  occurrence(
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): IntakeCandidateOccurrence | undefined;
  groundingBoundary(
    profileId: string,
    intakeId: string,
    sourceHash: string,
  ): import('./intake-identity-grounding.ts').SelectedIdentityGroundingBoundary;
  ownershipScope(
    birthDates: import('./record-ownership-authority.ts').SelectedOwnershipReviewScope['birthDates'],
    intakeVersion: number,
    birthDatesWork?: import('./record-ownership-authority.ts').SelectedOwnershipReviewScope['birthDatesWork'],
  ): import('./record-ownership-authority.ts').SelectedOwnershipReviewScope;
  clinicalSourceScope(
    proofs: Pick<
      ClinicalOriginalScope,
      | 'profileId'
      | 'hasParent'
      | 'hasMember'
      | 'childBoundary'
      | 'subjectGrounded'
      | 'questionGrounded'
      | 'subjectGroundedWork'
      | 'questionGroundedWork'
    >,
  ): ClinicalOriginalScope;
} {
  const { view, catalog, metadataBytes } = input;
  if (!Number.isSafeInteger(metadataBytes) || metadataBytes < 1)
    throw Error('Invalid clinical metadata byte budget');
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Missing selected intake');
  const workflow = view.child(intake, 'workflow');
  const children = (record: IntakeEnvelopeRecord | undefined, field: string) =>
    intakeReviewChildren(view, record, field);
  const value = <T>(record: IntakeEnvelopeRecord, field: string): T | undefined => {
    const child = view.child(record, field);
    if (child) {
      try {
        return readIntakeReviewValue<T>(view, child, metadataBytes);
      } catch (error) {
        if (!(error instanceof IntakeReviewFragmentRequired)) throw error;
        throw new IntakeReviewFragmentRequired({
          ...error.reference,
          address: view.address(record),
          field,
        });
      }
    }
    const result = view.field(record, field, { bytes: metadataBytes });
    if (result.kind === 'fragmented')
      throw new IntakeReviewFragmentRequired({
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(record),
        field,
      });
    return result.kind === 'value' ? (result.value as T) : undefined;
  };
  const read = <T>(record: IntakeEnvelopeRecord) =>
    readIntakeReviewValue<T>(view, record, metadataBytes);
  const candidate = (id: string) => workflow && view.find('candidate', workflow, id);
  const version = (candidateId: string, id: string) => {
    const item = candidate(candidateId);
    return item && view.find('version', item, id);
  };
  let sourceScopePrefix: ReturnType<typeof createClinicalSourceScopePrefix> | undefined;
  const groupRecords = () => children(workflow, 'reportGroups');
  const groupRecord = (id: string) => workflow && view.find('reportGroup', workflow, id);
  const referenceCache = new Map<string, WorkflowReviewGroup | undefined>();
  let referenceState: string | undefined;
  const headerCache = new Map<string, WorkflowReviewGroup>();
  let headerState: string | undefined;
  const noCompetingBoundary = new Set<string>();
  let competingState: string | undefined;
  const groupHeader = (record: IntakeEnvelopeRecord): WorkflowReviewGroup => {
    const address = view.address(record),
      state = input.readCacheState?.();
    if (state !== headerState) {
      headerCache.clear();
      headerState = state;
    }
    if (state !== undefined) {
      const cached = headerCache.get(address);
      if (cached) {
        headerCache.delete(address);
        headerCache.set(address, cached);
        return cached;
      }
    }
    const result: WorkflowReviewGroup = {
      id: value<string>(record, 'id')!,
      basis: value<WorkflowReviewGroup['basis']>(record, 'basis')!,
      sourceFileId: value<string>(record, 'sourceFileId')!,
      sourceHash: value<string>(record, 'sourceHash')!,
      memberId: value<string | null>(record, 'memberId')!,
      report: value<WorkflowReviewGroup['report']>(record, 'report') ?? null,
    };
    if (state !== undefined) {
      if (headerCache.size >= 32) headerCache.delete(headerCache.keys().next().value!);
      headerCache.set(address, result);
    }
    return result;
  };
  const currentGroupVersion = (record: IntakeEnvelopeRecord) => {
    const count = view.childCount(record, 'versions');
    return count ? view.childAt(record, 'versions', count - 1) : undefined;
  };
  const selectedVersion = (group: WorkflowReviewGroup) => {
    const record = groupRecord(group.id);
    const current = record && currentGroupVersion(record);
    if (!current) throw Error('Selected report has no current version');
    return current;
  };
  const snapshot = (record: IntakeEnvelopeRecord) => {
    if (value(record, 'format') !== 'health-intake-report-group-version-v2') return undefined;
    return openReportMemberSnapshot(
      catalog,
      value<IntakeReportMembersReference>(record, 'members')!,
    );
  };
  const memberRecord = (record: IntakeEnvelopeRecord, candidateId: string, versionId: string) => {
    if (input.membershipIndex) return input.membershipIndex.member(record, candidateId, versionId);
    for (const member of children(record, 'members'))
      if (
        value(member, 'candidateId') === candidateId &&
        value(member, 'candidateVersionId') === versionId
      )
        return member;
    return undefined;
  };
  function* containsWork(
    record: IntakeEnvelopeRecord,
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): Generator<void, boolean, void> {
    if (input.membershipIndex)
      return input.membershipIndex.contains(record, candidateId, versionId, recordId, proposalId);
    const members = snapshot(record);
    if (members) {
      // Preserve occurrence union across duplicate member IDs, not only member().
      let after: string | undefined;
      do {
        const page = members.members({ after, items: 64, bytes: 128 * 1024 });
        for (const member of page.members) {
          yield;
          if (member.candidateId !== candidateId || member.candidateVersionId !== versionId)
            continue;
          let occurrenceAfter: string | undefined;
          do {
            yield;
            const occurrences = members.occurrences(member, {
              after: occurrenceAfter,
              items: 64,
              bytes: metadataBytes,
            });
            if (
              occurrences.occurrences.some(
                (occurrence) =>
                  occurrence.recordId === recordId && occurrence.proposalId === proposalId,
              )
            )
              return true;
            if (occurrences.complete) break;
            if (!occurrences.after || occurrences.after === occurrenceAfter)
              throw Error('Report occurrences failed to advance');
            occurrenceAfter = occurrences.after;
          } while (true);
        }
        if (page.complete) return false;
        if (!page.after || page.after === after) throw Error('Report members failed to advance');
        after = page.after;
      } while (true);
    }
    for (const member of children(record, 'members')) {
      yield;
      if (
        value(member, 'candidateId') !== candidateId ||
        value(member, 'candidateVersionId') !== versionId
      )
        continue;
      for (const occurrence of children(member, 'occurrences')) {
        yield;
        if (
          value(occurrence, 'recordId') === recordId &&
          value(occurrence, 'proposalId') === proposalId
        )
          return true;
      }
    }
    return false;
  }
  const fallbackGroupId = (candidate: IntakeEnvelopeRecord) =>
    'report-group:' + hashChunks([canonicalLiteral(['candidate', value(candidate, 'id')])]);
  const policyNamespace = 'scope_' + randomUUID().replaceAll('-', '') + '_';
  let fallbackScratch: ReturnType<typeof disposableSqlite> | undefined;
  let fallbackDb: import('node:sqlite').DatabaseSync | undefined;
  let fallbackCandidatesPrepared = false,
    fallbackSelection = 0,
    fallbackClosed = false;
  const fallbackStore = () => {
    if (fallbackClosed) throw Error('Selected fallback scope closed');
    view.address(view.root());
    if (!fallbackDb) {
      if (!input.policySql) fallbackScratch = disposableSqlite('circus-review-fallback-');
      fallbackDb = input.policySql || fallbackScratch!.db;
      fallbackDb.exec(
        `CREATE TABLE ${policyNamespace}candidates(group_id TEXT,ordinal INTEGER,address TEXT,PRIMARY KEY(group_id,ordinal)); CREATE TABLE ${policyNamespace}versions(group_id TEXT,ordinal INTEGER,candidate TEXT,version TEXT,id TEXT,PRIMARY KEY(group_id,ordinal)); CREATE INDEX ${policyNamespace}version_id ON ${policyNamespace}versions(group_id,id,ordinal); CREATE TABLE ${policyNamespace}complete(group_id TEXT PRIMARY KEY); CREATE TABLE ${policyNamespace}refs(selection INTEGER,ordinal INTEGER,value TEXT,PRIMARY KEY(selection,ordinal)); CREATE TABLE ${policyNamespace}active_receipts(selection INTEGER,ordinal INTEGER,address TEXT,PRIMARY KEY(selection,ordinal));`,
      );
    }
    return fallbackDb;
  };
  function* coveredVersionWork(
    candidateId: string,
    versionId: string,
  ): Generator<void, boolean, void> {
    if (input.membershipIndex) return input.membershipIndex.covered(candidateId, versionId);
    for (const group of groupRecords()) {
      yield;
      for (const version of children(group, 'versions')) {
        yield;
        const members = snapshot(version);
        if (members) {
          if (members.member(candidateId, versionId)) return true;
        } else
          for (const member of children(version, 'members')) {
            yield;
            if (
              value(member, 'candidateId') === candidateId &&
              value(member, 'candidateVersionId') === versionId
            )
              return true;
          }
      }
    }
    return false;
  }
  function* fallbackVersionIdWork(
    groupId: string,
    version: IntakeEnvelopeRecord,
  ): Generator<void, string, void> {
    const hash = createHash('sha256');
    hash.update(
      '[' + canonicalLiteral(groupId) + ',' + canonicalLiteral(value(version, 'id')) + ',[',
    );
    let comma = false;
    for (const occurrence of children(version, 'occurrences')) {
      yield;
      if (comma) hash.update(',');
      comma = true;
      for (const piece of canonicalReviewValueChunks(read(occurrence))) {
        hash.update(piece);
        yield;
      }
    }
    hash.update(']]');
    return 'report-group-version:' + hash.digest('hex');
  }
  function* prepareFallbackCandidatesWork(): Generator<void, void, void> {
    const sql = fallbackStore();
    if (fallbackCandidatesPrepared) return;
    sql.exec(`DELETE FROM ${policyNamespace}candidates`);
    let ordinal = 0;
    for (const candidate of children(workflow, 'candidates')) {
      yield;
      sql
        .prepare(`INSERT INTO ${policyNamespace}candidates VALUES(?,?,?)`)
        .run(fallbackGroupId(candidate), ordinal++, view.address(candidate));
    }
    fallbackCandidatesPrepared = true;
  }
  function* prepareFallbackGroupWork(groupId: string): Generator<void, void, void> {
    const sql = fallbackStore();
    if (sql.prepare(`SELECT 1 FROM ${policyNamespace}complete WHERE group_id=?`).get(groupId))
      return;
    yield* prepareFallbackCandidatesWork();
    sql.prepare(`DELETE FROM ${policyNamespace}versions WHERE group_id=?`).run(groupId);
    let ordinal = 0;
    // Later duplicate candidates prepend their versions, preserving the legacy recipe.
    for (const row of sql
      .prepare(
        `SELECT address FROM ${policyNamespace}candidates WHERE group_id=? ORDER BY ordinal DESC`,
      )
      .iterate(groupId)) {
      yield;
      const candidate = view.resolve(String(row.address));
      for (const version of children(candidate, 'versions')) {
        yield;
        if (
          !value(version, 'sourceContext') &&
          !(yield* coveredVersionWork(
            value<string>(candidate, 'id')!,
            value<string>(version, 'id')!,
          ))
        ) {
          const id = yield* fallbackVersionIdWork(groupId, version);
          sql
            .prepare(`INSERT INTO ${policyNamespace}versions VALUES(?,?,?,?,?)`)
            .run(groupId, ordinal++, view.address(candidate), view.address(version), id);
        }
      }
    }
    sql.prepare(`INSERT INTO ${policyNamespace}complete VALUES(?)`).run(groupId);
  }
  function* fallbackVersions(groupId: string) {
    finishClinicalReviewWork(prepareFallbackGroupWork(groupId));
    for (const row of fallbackStore()
      .prepare(
        `SELECT candidate,version,id FROM ${policyNamespace}versions WHERE group_id=? ORDER BY ordinal`,
      )
      .iterate(groupId))
      yield {
        candidate: view.resolve(String(row.candidate)),
        version: view.resolve(String(row.version)),
        id: String(row.id),
      };
  }
  function* fallbackHeaderWork(id: string): Generator<void, WorkflowReviewGroup | undefined, void> {
    yield* prepareFallbackGroupWork(id);
    if (
      !fallbackStore()
        .prepare(`SELECT 1 FROM ${policyNamespace}versions WHERE group_id=? LIMIT 1`)
        .get(id)
    )
      return undefined;
    return {
      id,
      basis: 'candidate_fallback',
      sourceFileId: null,
      sourceHash: null,
      memberId: null,
      report: null,
    };
  }
  const membershipBytes = new WeakMap<SelectedIdentityMembership, number>();
  const membershipFor = (current: IntakeEnvelopeRecord): SelectedIdentityMembership => {
    const members = snapshot(current);
    const result = {
      retains(prior) {
        return finishClinicalReviewWork(this.retainsWork!(prior));
      },
      *retainsWork(prior): Generator<void, boolean, void> {
        return yield* everyClinicalReviewWork(prior, function* (member) {
          if (members) {
            const selected = members.member(member.candidateId, member.candidateVersionId);
            return (
              !!selected &&
              (yield* hashChunksWork(members.canonicalSection(selected))) ===
                hashChunks([canonicalLiteral(member.section || null)]) &&
              (yield* everyClinicalReviewWork(member.occurrences, function* (occurrence) {
                return members.hasOccurrence(selected, occurrence);
              }))
            );
          }
          const selected = memberRecord(current, member.candidateId, member.candidateVersionId);
          if (
            !selected ||
            canonicalLiteral(value(selected, 'section') || null) !==
              canonicalLiteral(member.section || null)
          )
            return false;
          return yield* everyClinicalReviewWork(member.occurrences, function* (wanted) {
            for (const occurrence of children(selected, 'occurrences')) {
              yield;
              if (canonicalLiteral(read(occurrence)) === canonicalLiteral(wanted)) return true;
            }
            return false;
          });
        });
      },
    } satisfies SelectedIdentityMembership;
    membershipBytes.set(
      result,
      Buffer.byteLength(view.address(current)) +
        (members ? Buffer.byteLength(JSON.stringify(members.reference)) : 0) +
        1024,
    );
    return result;
  };
  // Immutable native receipt snapshots remain complete; only repeated decoding
  // within this exact live review proof is retained. Legacy receipt readers keep
  // their original path. Forward full-history selectors still visit every row.
  const nativeReceiptCache = new Map<
    string,
    {
      header: string;
      reference: string;
      collections: IdentityPolicyReceipt['scope'];
      bytes: number;
    }
  >();
  let nativeReceiptState: string | undefined,
    nativeReceiptProofState: string | undefined,
    nativeReceiptBytes = 0,
    receiptScopeClosed = false;
  let nativeReceiptEpoch = {};
  const commonReceiptScopes = new Map<
    string,
    { collections: IdentityPolicyReceipt['scope']; bytes: number }
  >();
  let commonReceiptScopeBytes = 0,
    commonReceiptScopeState: string | undefined,
    commonReceiptScopeProofState: string | undefined,
    commonReceiptScopeEpoch = {};
  const clearCommonReceiptScopes = (invalidate = true) => {
    if (invalidate) commonReceiptScopeEpoch = {};
    commonReceiptScopes.clear();
    commonReceiptScopeBytes = 0;
    // Header entries can hold borrowed common accessors. Drop those aliases on
    // authority invalidation, without changing membership/draft proof epochs.
    nativeReceiptCache.clear();
    nativeReceiptBytes = 0;
  };
  let receiptLocators: readonly IntakeEnvelopeRecord[] | undefined;
  let receiptLocatorBytes = 0;
  const membershipCache = new Map<
    string,
    { provider: SelectedIdentityMembership; bytes: number }
  >();
  let membershipCacheBytes = 0;
  const proposalRevisions = new Map<
    string,
    { revision: string | null | undefined; bytes: number }
  >();
  let proposalRevisionBytes = 0;
  const clearNativeReceipts = (invalidate = true) => {
    clearCommonReceiptScopes(invalidate);
    if (invalidate) nativeReceiptEpoch = {};
    nativeReceiptCache.clear();
    nativeReceiptBytes = 0;
    receiptLocators = undefined;
    receiptLocatorBytes = 0;
    membershipCache.clear();
    membershipCacheBytes = 0;
    proposalRevisions.clear();
    proposalRevisionBytes = 0;
  };
  const receiptState = () => {
    if (receiptScopeClosed) throw Error('Selected native identity receipt scope closed');
    try {
      view.address(view.root());
      return input.readCacheState?.();
    } catch (error) {
      clearNativeReceipts();
      throw error;
    }
  };
  const receiptProofState = () => {
    if (receiptScopeClosed) throw Error('Selected native identity receipt scope closed');
    try {
      view.address(view.root());
      return input.readProofState ? input.readProofState() : input.readCacheState?.();
    } catch (error) {
      clearNativeReceipts();
      throw error;
    }
  };
  const currentReceiptState = () => {
    const proof = receiptProofState();
    if (proof !== nativeReceiptProofState) {
      clearNativeReceipts();
      nativeReceiptProofState = proof;
    }
    const state = receiptState();
    if (state !== nativeReceiptState) {
      clearNativeReceipts(false);
      nativeReceiptState = state;
    }
    return proof === undefined ? undefined : state;
  };
  const draftHandoff = selectedDraftHandoff(() => {
    const state = currentReceiptState();
    return state === undefined ? undefined : { state, epoch: nativeReceiptEpoch };
  });
  const receiptProofGuard = (state: string, epoch: object) => {
    if (receiptScopeClosed || epoch !== nativeReceiptEpoch)
      throw Error('Selected native identity receipt proof changed');
    if (receiptProofState() !== state) {
      clearNativeReceipts();
      throw Error('Selected native identity receipt proof changed');
    }
  };
  const receiptWork = (metric: IdentityReceiptWork) =>
    input.identityReceiptWork ? input.identityReceiptWork(metric) : recordIntakeWork(metric);
  const decodeNativeReceipt = (entry: {
    header: string;
    reference: string;
    collections: IdentityPolicyReceipt['scope'];
  }) => {
    const { format: _format, collection: _collection, ...header } = JSON.parse(entry.reference);
    const receiptHeader = JSON.parse(entry.header, (_key, value, context) =>
      typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
        ? JSON.rawJSON(context.source)
        : value,
    ) as Record<string, unknown>;
    return {
      ...receiptHeader,
      scope: { ...header, ...entry.collections },
    } as IdentityPolicyReceipt;
  };
  const guardedNativeCollections = (reference: IntakeIdentityScopeReference, guard: () => void) => {
    const source = nativeIdentityPolicyScope(catalog, reference);
    const sequence = <T>(
      items: Iterable<T>,
      count: number,
      project: (item: T) => T = (item) => item,
    ) => {
      const result = selectedSequence(function* () {
        guard();
        for (const item of items) {
          guard();
          yield project(item);
        }
        guard();
      });
      Object.defineProperty(result, 'length', { value: count });
      return Object.freeze(result);
    };
    const target = (original: import('./intake-identity-policy.ts').IdentityPolicyTarget) => {
      const item = { ...original };
      if (original.hasIssueId) {
        const hasIssueId = original.hasIssueId.bind(original);
        Object.defineProperty(item, 'hasIssueId', {
          value: (id: string) => {
            guard();
            return hasIssueId(id);
          },
        });
      }
      if (item.issueIds) {
        const issues = item.issueIds;
        item.issueIds = selectedSequence(function* () {
          guard();
          for (const issue of issues) {
            guard();
            yield issue;
          }
          guard();
        });
      }
      return item;
    };
    const collections = {
      targets: sequence(source.targets, reference.collection.targets, target),
      assignmentTargets: sequence(
        source.assignmentTargets!,
        reference.collection.assignmentTargets,
        target,
      ),
      competingSubjects: sequence(
        source.competingSubjects || [],
        reference.collection.competingSubjects,
      ),
      membership: sequence(source.membership, reference.collection.membership, (member) => {
        const occurrences = member.occurrences;
        member.occurrences = selectedSequence(function* () {
          guard();
          for (const occurrence of occurrences) {
            guard();
            yield occurrence;
          }
          guard();
        });
        return member;
      }),
      questions: sequence(source.questions || [], reference.collection.questions, (question) => {
        if ('matches' in question) {
          const matches = question.matches.bind(question);
          question = {
            matches: (value) => {
              guard();
              return matches(value);
            },
          };
        }
        return question;
      }),
    };
    return collections as unknown as IdentityPolicyReceipt['scope'];
  };
  const currentCommonReceiptScopeProof = () => {
    try {
      if (receiptScopeClosed) throw Error('Selected native identity receipt scope closed');
      view.address(view.root());
      const proof = input.readIdentityReceiptScopeProofState
        ? input.readIdentityReceiptScopeProofState()
        : input.readProofState
          ? input.readProofState()
          : input.readIdentityReceiptScopeState
            ? input.readIdentityReceiptScopeState()
            : input.readCacheState?.();
      if (proof !== commonReceiptScopeProofState) {
        clearCommonReceiptScopes();
        commonReceiptScopeProofState = proof;
      }
      return proof;
    } catch (error) {
      clearCommonReceiptScopes();
      throw error;
    }
  };
  const currentCommonReceiptScopeState = () => {
    const proof = currentCommonReceiptScopeProof();
    try {
      const state = input.readIdentityReceiptScopeState
        ? input.readIdentityReceiptScopeState()
        : input.readCacheState?.();
      if (state !== commonReceiptScopeState) {
        clearCommonReceiptScopes(false);
        commonReceiptScopeState = state;
      }
      return proof === undefined ? undefined : state;
    } catch (error) {
      clearCommonReceiptScopes();
      throw error;
    }
  };
  const trimReceiptCaches = () => {
    while (
      nativeReceiptCache.size + commonReceiptScopes.size > 32 ||
      nativeReceiptBytes + commonReceiptScopeBytes > 256 * 1024
    ) {
      const header = nativeReceiptCache.keys().next();
      if (!header.done) {
        nativeReceiptBytes -= nativeReceiptCache.get(header.value)!.bytes;
        nativeReceiptCache.delete(header.value);
      } else {
        const scope = commonReceiptScopes.keys().next().value!;
        commonReceiptScopeBytes -= commonReceiptScopes.get(scope)!.bytes;
        commonReceiptScopes.delete(scope);
      }
    }
  };
  const nativeReceiptCollections = (reference: IntakeIdentityScopeReference) => {
    const state = currentCommonReceiptScopeState();
    if (state === undefined) {
      // No transaction or unproved host borrows a warm authority accessor.
      clearCommonReceiptScopes();
      receiptWork('identityPolicyScopeReconstructions');
      return nativeIdentityPolicyScope(catalog, reference);
    }
    const key = JSON.stringify(reference),
      epoch = commonReceiptScopeEpoch,
      proof = commonReceiptScopeProofState;
    const guard = () => {
      if (
        epoch !== commonReceiptScopeEpoch ||
        currentCommonReceiptScopeProof() !== proof ||
        epoch !== commonReceiptScopeEpoch
      )
        throw Error('Selected common identity scope proof changed');
    };
    const cached = commonReceiptScopes.get(key);
    if (cached) {
      guard();
      commonReceiptScopes.delete(key);
      commonReceiptScopes.set(key, cached);
      receiptWork('identityPolicyScopeCacheHits');
      return cached.collections;
    }
    receiptWork('identityPolicyScopeReconstructions');
    const collections = guardedNativeCollections(reference, guard),
      // Key text, reference captured by repeatable providers, and wrappers.
      bytes = 2 * Buffer.byteLength(key) + 2048;
    guard();
    if (
      epoch === commonReceiptScopeEpoch &&
      currentCommonReceiptScopeState() === state &&
      epoch === commonReceiptScopeEpoch &&
      bytes <= 256 * 1024
    ) {
      commonReceiptScopes.set(key, { collections, bytes });
      commonReceiptScopeBytes += bytes;
      trimReceiptCaches();
    }
    return collections;
  };
  const policyReceipt = (record: IntakeEnvelopeRecord): IdentityPolicyReceipt => {
    const state = currentReceiptState(),
      key = view.address(record);
    const cached = state === undefined ? undefined : nativeReceiptCache.get(key);
    if (cached) {
      nativeReceiptCache.delete(key);
      nativeReceiptCache.set(key, cached);
      receiptWork('identityPolicyReceiptCacheHits');
      return decodeNativeReceipt(cached);
    }
    const constructionEpoch = nativeReceiptEpoch;
    const receiptScope = view.child(record, 'scope');
    if (!receiptScope) throw Error('Missing retained identity scope');
    const native = value(receiptScope, 'format') === 'health-intake-identity-scope-v2';
    // The selected receipt handle is authenticated before taking this bounded
    // subtree. Resolve each field once within that receipt, preserving the same
    // selected store guards and lexical values without repeated root ancestry.
    const receiptView = native ? view.subtree(record) : undefined,
      receiptRoot = receiptView?.root(),
      receiptFields = receiptView && intakeEnvelopeFieldAccess(receiptView);
    const receiptValue = (name: string): unknown => {
      if (!native) return value(record, name);
      const selected = receiptFields!.chunks(receiptRoot!, name);
      if (!selected) return undefined;
      const pieces: string[] = [];
      let bytes = 0;
      for (const piece of selected) {
        bytes += Buffer.byteLength(piece);
        if (bytes > metadataBytes) {
          // Preserve the prior exact inspection address on budget exhaustion.
          // This ancestry resolution occurs only for an oversized field.
          const child = view.child(record, name);
          throw new IntakeReviewFragmentRequired({
            format: 'health-intake-review-fragment-v1',
            logical: view.logical,
            address: view.address(child || record),
            ...(!child ? { field: name } : {}),
          });
        }
        pieces.push(piece);
      }
      return parseLiteralJSON(pieces.join(''));
    };
    const header: Record<string, unknown> = {},
      scopeHeader: Record<string, unknown> = {};
    for (const name of [
      'operationId',
      'at',
      'outcome',
      'attestation',
      'identityAnswers',
      'assignedPerson',
      'knownNameAdded',
      'confirmedPrintedName',
      'selfUpdate',
    ]) {
      const item = receiptValue(name);
      if (item !== undefined)
        header[name] =
          name === 'assignedPerson' || name === 'selfUpdate'
            ? JSON.parse(JSON.stringify(item))
            : item;
    }
    if (native) {
      const reference = JSON.parse(
        JSON.stringify(receiptValue('scope')),
      ) as IntakeIdentityScopeReference;
      receiptWork('identityPolicyReceiptReconstructions');
      if (state === undefined) {
        const { format: _format, collection: _collection, ...scopeHeader } = reference;
        return {
          ...header,
          scope: {
            ...scopeHeader,
            ...nativeReceiptCollections(reference),
          },
        } as IdentityPolicyReceipt;
      }
      const entry = {
        header: JSON.stringify(header),
        reference: JSON.stringify(reference),
        collections: nativeReceiptCollections(reference),
        bytes: 0,
      };
      // Account both encoded reference copies (text and provider capture), key,
      // header and fixed wrapper overhead. No cumulative collection is retained.
      entry.bytes =
        Buffer.byteLength(entry.header) +
        2 * Buffer.byteLength(entry.reference) +
        Buffer.byteLength(key) +
        1024;
      if (
        nativeReceiptEpoch === constructionEpoch &&
        receiptState() === state &&
        entry.bytes <= 256 * 1024
      ) {
        nativeReceiptCache.set(key, entry);
        nativeReceiptBytes += entry.bytes;
        trimReceiptCaches();
      }
      return decodeNativeReceipt(entry);
    }
    for (const name of [
      'profileId',
      'intakeId',
      'intakeVersion',
      'selfVersion',
      'groupId',
      'groupVersionId',
      'sourceHash',
      'memberId',
      'original',
      'report',
      'subject',
      'birthDateReview',
      'competingSubjects',
      'verificationMode',
      'evidencedIdentity',
      'evidenceOriginalFingerprint',
      'questions',
      'scopeToken',
    ]) {
      const item = value(receiptScope, name);
      if (item !== undefined) scopeHeader[name] = item;
    }
    const targets = (name: string): IdentityPolicyTargets =>
      Object.defineProperty(
        selectedSequence(function* () {
          for (const target of children(receiptScope, name))
            yield read<
              import('../shared/intake-identity.ts').IntakeIdentityScope['targets'][number]
            >(target);
        }),
        'length',
        { value: view.childCount(receiptScope, name) },
      );
    scopeHeader.targets = targets('targets');
    if (view.has(receiptScope, 'assignmentTargets'))
      scopeHeader.assignmentTargets = targets('assignmentTargets');
    scopeHeader.membership = selectedSequence(function* () {
      for (const member of children(receiptScope, 'membership'))
        yield {
          candidateId: value<string>(member, 'candidateId')!,
          candidateVersionId: value<string>(member, 'candidateVersionId')!,
          ...(view.has(member, 'section')
            ? { section: value<IdentityPolicyMember['section']>(member, 'section') }
            : {}),
          occurrences: selectedSequence(function* () {
            for (const occurrence of children(member, 'occurrences'))
              yield read<
                import('../shared/intake.ts').IntakeCandidateVersion['occurrences'][number]
              >(occurrence);
          }),
        };
    });
    return { ...header, scope: scopeHeader } as IdentityPolicyReceipt;
  };
  function* receiptRecords(): Generator<IntakeEnvelopeRecord> {
    const state = currentReceiptState(),
      epoch = nativeReceiptEpoch,
      proof = nativeReceiptProofState;
    if (state !== undefined && receiptLocators) {
      receiptWork('identityPolicyReceiptNamespaceHits');
      for (const record of receiptLocators) {
        receiptProofGuard(proof!, epoch);
        // Authenticate each opaque address even when enumeration was retained.
        view.address(record);
        yield record;
      }
      receiptProofGuard(proof!, epoch);
      return;
    }
    receiptWork('identityPolicyReceiptNamespaceReads');
    let complete: IntakeEnvelopeRecord[] | undefined = state === undefined ? undefined : [];
    let bytes = 128;
    for (const record of children(workflow, 'identityConfirmations')) {
      if (complete) {
        bytes += Buffer.byteLength(view.address(record)) + 128;
        if (complete.length === 32 || bytes > 256 * 1024) complete = undefined;
        else complete.push(record);
      }
      yield record;
    }
    if (
      state !== undefined &&
      complete &&
      nativeReceiptEpoch === epoch &&
      receiptState() === state
    ) {
      // Admit only the entire namespace, never a prefix of a large history.
      receiptLocators = Object.freeze(complete);
      receiptLocatorBytes = bytes;
      while (membershipCacheBytes + receiptLocatorBytes > 256 * 1024 && membershipCache.size) {
        const oldest = membershipCache.keys().next().value!;
        membershipCacheBytes -= membershipCache.get(oldest)!.bytes;
        membershipCache.delete(oldest);
      }
    }
  }
  const receipts = selectedSequence(function* () {
    for (const record of receiptRecords()) {
      const receipt = policyReceipt(record);
      if (input.activeReceipt(receipt)) yield receipt;
    }
  });
  const resolveMembership = (group: WorkflowReviewGroup): SelectedIdentityMembership => {
    // Preserve first retained duplicate and the original fallback predicate.
    if (groupRecord(group.id)) return membershipFor(selectedVersion(group));
    let current:
      { candidate: IntakeEnvelopeRecord; version: IntakeEnvelopeRecord; id: string } | undefined;
    finishClinicalReviewWork(prepareFallbackGroupWork(group.id));
    const last = fallbackStore()
      .prepare(
        `SELECT candidate,version,id FROM ${policyNamespace}versions WHERE group_id=? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(group.id);
    if (last)
      current = {
        candidate: view.resolve(String(last.candidate)),
        version: view.resolve(String(last.version)),
        id: String(last.id),
      };
    if (!current) throw Error('Missing fallback clinical membership');
    const selected = current;
    const result = {
      retains(prior) {
        return finishClinicalReviewWork(this.retainsWork!(prior));
      },
      *retainsWork(prior): Generator<void, boolean, void> {
        return yield* everyClinicalReviewWork(prior, function* (member) {
          return (
            member.candidateId === value(selected.candidate, 'id') &&
            member.candidateVersionId === value(selected.version, 'id') &&
            !member.section &&
            (yield* everyClinicalReviewWork(member.occurrences, function* (wanted) {
              for (const occurrence of children(selected.version, 'occurrences')) {
                yield;
                if (canonicalLiteral(read(occurrence)) === canonicalLiteral(wanted)) return true;
              }
              return false;
            }))
          );
        });
      },
    } satisfies SelectedIdentityMembership;
    membershipBytes.set(
      result,
      Buffer.byteLength(view.address(selected.candidate)) +
        Buffer.byteLength(view.address(selected.version)) +
        Buffer.byteLength(selected.id) +
        1024,
    );
    return result;
  };
  const selectedMembership = (group: WorkflowReviewGroup): SelectedIdentityMembership => {
    const state = currentReceiptState(),
      epoch = nativeReceiptEpoch,
      proof = nativeReceiptProofState;
    // A bounded id selects the same first retained group; remaining header fields
    // have never participated in this membership resolution predicate.
    const key = group.id,
      keyBytes = Buffer.byteLength(key);
    const cached = state === undefined ? undefined : membershipCache.get(key);
    if (cached) {
      receiptProofGuard(proof!, epoch);
      membershipCache.delete(key);
      membershipCache.set(key, cached);
      receiptWork('identityPolicyMembershipResolutionHits');
      return cached.provider;
    }
    receiptWork('identityPolicyMembershipResolutions');
    const source = resolveMembership(group);
    if (state === undefined) return source;
    const provider = Object.freeze({
      *retainsWork(prior: Parameters<typeof source.retains>[0]): Generator<void, boolean, void> {
        receiptProofGuard(proof!, epoch);
        const result = source.retainsWork
          ? yield* source.retainsWork(prior)
          : source.retains(prior);
        receiptProofGuard(proof!, epoch);
        return result;
      },
      retains(prior: Parameters<typeof source.retains>[0]) {
        receiptProofGuard(proof!, epoch);
        const result = source.retains(prior);
        receiptProofGuard(proof!, epoch);
        return result;
      },
    });
    const bytes = (membershipBytes.get(source) || 1024) + keyBytes;
    if (
      nativeReceiptEpoch === epoch &&
      receiptState() === state &&
      bytes + receiptLocatorBytes <= 256 * 1024
    ) {
      membershipCache.set(key, { provider, bytes });
      membershipCacheBytes += bytes;
      while (membershipCache.size > 32 || membershipCacheBytes + receiptLocatorBytes > 256 * 1024) {
        const oldest = membershipCache.keys().next().value!;
        membershipCacheBytes -= membershipCache.get(oldest)!.bytes;
        membershipCache.delete(oldest);
      }
    }
    return provider;
  };
  let ownershipPolicyScratch: ReturnType<typeof disposableSqlite> | undefined;
  let ownershipPolicyDb: import('node:sqlite').DatabaseSync | undefined;
  let ownershipPolicyScope = 0;
  let questionInlineBytes = metadataBytes;
  const scope: SelectedWorkflowReviewScope = {
    close() {
      sourceScopePrefix?.close();
      draftHandoff.clear();
      receiptScopeClosed = true;
      clearNativeReceipts();
      fallbackClosed = true;
      fallbackScratch?.close();
      fallbackDb = undefined;
      fallbackScratch = undefined;
      ownershipPolicyDb = undefined;
      ownershipPolicyScratch?.close();
      ownershipPolicyScratch = undefined;
      input.close?.();
    },
    issueSink: input.issueSink,
    bindIdentityWarnings: input.bindIdentityWarnings,
    bindIdentityWarningsWork: input.bindIdentityWarningsWork,
    versionId(proposalId, entry) {
      if (!proposalId) return intakeCandidateVersionIdForRevision(entry, undefined);
      try {
        const state = currentReceiptState(),
          epoch = nativeReceiptEpoch;
        const cached =
          state === undefined || !proposalId ? undefined : proposalRevisions.get(proposalId);
        if (cached) {
          receiptProofGuard(nativeReceiptProofState!, epoch);
          proposalRevisions.delete(proposalId!);
          proposalRevisions.set(proposalId!, cached);
          receiptWork('reviewProposalRevisionHits');
          return intakeCandidateVersionIdForRevision(entry, cached.revision);
        }
        receiptWork('reviewProposalRevisionReads');
        const proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
        const revision =
          proposal &&
          (value<string>(proposal, 'sourceTextDependencyToken') ||
            value<string>(proposal, 'sourceTextRevisionId'));
        // Only immutable scalar metadata is retained. Candidate bodies and their
        // version hashes are always evaluated by the original recipe below.
        if (
          proposalId &&
          state !== undefined &&
          (revision == null || typeof revision === 'string')
        ) {
          const size = Buffer.byteLength(JSON.stringify([proposalId, revision]));
          if (
            currentReceiptState() === state &&
            nativeReceiptEpoch === epoch &&
            size <= 256 * 1024
          ) {
            proposalRevisions.set(proposalId, { revision, bytes: size });
            proposalRevisionBytes += size;
            while (proposalRevisions.size > 32 || proposalRevisionBytes > 256 * 1024) {
              const oldest = proposalRevisions.keys().next().value!;
              proposalRevisionBytes -= proposalRevisions.get(oldest)!.bytes;
              proposalRevisions.delete(oldest);
            }
          }
        }
        return intakeCandidateVersionIdForRevision(entry, revision);
      } catch (error) {
        clearNativeReceipts();
        throw error;
      }
    },
    references(candidateId, versionId, recordId, proposalId) {
      return finishClinicalReviewWork(
        this.referencesWork!(candidateId, versionId, recordId, proposalId),
      );
    },
    *referencesWork(candidateId, versionId, recordId, proposalId) {
      const sql = fallbackStore(),
        selection = ++fallbackSelection;
      let ordinal = 0;
      const retain = (reference: IntakeReviewGroupReference) =>
        sql
          .prepare(`INSERT INTO ${policyNamespace}refs VALUES(?,?,?)`)
          .run(selection, ordinal++, JSON.stringify(reference));
      if (input.membershipIndex) {
        for (const reference of input.membershipIndex.references(
          candidateId,
          versionId,
          recordId,
          proposalId,
        )) {
          yield;
          retain(reference);
        }
      } else
        for (const group of groupRecords()) {
          yield;
          for (const version of children(group, 'versions')) {
            yield;
            if (!(yield* containsWork(version, candidateId, versionId, recordId, proposalId)))
              continue;
            retain({
              groupId: value<string>(group, 'id')!,
              groupVersionId: value<string>(version, 'id')!,
            });
            break;
          }
        }
      if (!(yield* coveredVersionWork(candidateId, versionId))) {
        const groupId =
          'report-group:' + hashChunks([canonicalLiteral(['candidate', candidateId])]);
        yield* prepareFallbackGroupWork(groupId);
        outer: for (const fallback of fallbackVersions(groupId)) {
          yield;
          if (
            value(fallback.candidate, 'id') !== candidateId ||
            value(fallback.version, 'id') !== versionId
          )
            continue;
          for (const occurrence of children(fallback.version, 'occurrences')) {
            yield;
            if (
              value(occurrence, 'recordId') === recordId &&
              value(occurrence, 'proposalId') === proposalId
            ) {
              retain({ groupId, groupVersionId: fallback.id });
              break outer;
            }
          }
        }
      }
      const references = function* () {
        fallbackStore();
        for (const row of sql
          .prepare(`SELECT value FROM ${policyNamespace}refs WHERE selection=? ORDER BY ordinal`)
          .iterate(selection))
          yield JSON.parse(String(row.value)) as IntakeReviewGroupReference;
      };
      return yield* selectedReportGroupLinksWork(
        references,
        { candidateId, candidateVersionId: versionId, recordId, proposalId },
        metadataBytes,
        (ordinal) => {
          const row = fallbackStore()
            .prepare(`SELECT value FROM ${policyNamespace}refs WHERE selection=? AND ordinal=?`)
            .get(selection, ordinal);
          return row ? (JSON.parse(String(row.value)) as IntakeReviewGroupReference) : undefined;
        },
      );
    },
    reportSource: input.reportSource,
    reportSourceWork: input.reportSourceWork,
    questions(candidateId, versionId) {
      return finishClinicalReviewWork(this.questionsWork!(candidateId, versionId));
    },
    *questionsWork(candidateId, versionId) {
      if (input.questionIndex) yield* input.questionIndex.prepare(candidateId);
      const selected = function* () {
        for (const question of input.questionIndex
          ? input.questionIndex.records(candidateId, versionId)
          : children(workflow, 'questions')) {
          if (value(question, 'candidateId') !== candidateId) continue;
          const selectedVersion = value(question, 'candidateVersionId');
          if (!selectedVersion || selectedVersion === versionId) yield question;
        }
      };
      const readQuestion = (question: IntakeEnvelopeRecord) =>
        input.questionState?.question(question, metadataBytes) ?? read<IntakeQuestion>(question);
      const sql = fallbackStore(),
        selection = ++fallbackSelection,
        questionSelection = `${policyNamespace}questions`;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS ${questionSelection}(selection INTEGER,ordinal INTEGER,address TEXT,id TEXT,PRIMARY KEY(selection,ordinal)); CREATE INDEX IF NOT EXISTS ${questionSelection}_id ON ${questionSelection}(selection,id,ordinal)`,
      );
      const retain = sql.prepare(`INSERT INTO ${questionSelection} VALUES(?,?,?,?)`);
      const result: IntakeQuestion[] = [];
      let bytes = 0,
        count = 0,
        referenced = false;
      for (const question of selected()) {
        yield;
        retain.run(selection, count, view.address(question), value<string>(question, 'id')!);
        count++;
        if (referenced) continue;
        const item = readQuestion(question);
        bytes += Buffer.byteLength(canonicalLiteral(item));
        if (bytes > questionInlineBytes) {
          referenced = true;
          result.length = 0;
        } else result.push(item);
      }
      if (!referenced) {
        sql.prepare(`DELETE FROM ${questionSelection} WHERE selection=?`).run(selection);
        questionInlineBytes -= bytes;
        return result;
      }
      return selectedReviewQuestions(
        {
          format: 'health-intake-review-questions-v1',
          count,
          candidateId,
          candidateVersionId: versionId,
          reference: {
            format: 'health-intake-review-fragment-v1',
            logical: view.logical,
            address: view.address(workflow!),
            field: 'questions',
          },
        },
        function* () {
          for (const question of selected()) yield readQuestion(question);
        },
        (ordinal) => {
          const row = fallbackStore()
            .prepare(`SELECT address FROM ${questionSelection} WHERE selection=? AND ordinal=?`)
            .get(selection, ordinal);
          return row ? readQuestion(view.resolve(String(row.address))) : undefined;
        },
        (id) => {
          const row = fallbackStore()
            .prepare(
              `SELECT address FROM ${questionSelection} WHERE selection=? AND id=? ORDER BY ordinal LIMIT 1`,
            )
            .get(selection, id);
          return row ? readQuestion(view.resolve(String(row.address))) : undefined;
        },
      );
    },
    accepted(candidateId, versionId) {
      if (!workflow || view.childCount(workflow, 'decisions') === 0) return false;
      return !!view.lookup('accepted-candidate-version', [JSON.stringify(candidateId), versionId]);
    },
    draft(proposalId, recordId, versionId) {
      return finishClinicalReviewWork(this.draftWork!(proposalId, recordId, versionId));
    },
    *draftWork(proposalId, recordId, versionId) {
      return yield* draftHandoff.readWork(proposalId, recordId, versionId, function* () {
        if (!workflow || view.childCount(workflow, 'reviewDrafts') === 0) return null;
        const result = view.lookup('draft-record-version-last', [
          proposalId || '',
          recordId,
          versionId,
        ]);
        if (!result) return null;
        receiptWork('reviewDraftReconstructions');
        if (input.readDraftWork) return yield* input.readDraftWork(result);
        if (input.readDraft) return input.readDraft(result);
        const draft = read<IntakeReviewDraft>(result);
        if (draft.format === 'health-intake-review-draft-v2')
          throw Error('Native review history requires its selected policy reader');
        return draft;
      });
    },
    bindPreparedDraft: draftHandoff.bind,
    preparedDraft(proposalId, record, versionId) {
      const draft = draftHandoff.consume(proposalId, record, versionId);
      if (draft !== undefined) receiptWork('reviewDraftHandoffs');
      return draft;
    },
    firstVersion(candidateId) {
      const item = candidate(candidateId);
      const first = item && view.childAt(item, 'versions', 0);
      return first && value<string>(first, 'id');
    },
    keptOriginal(candidateId, versionId) {
      return finishClinicalReviewWork(this.keptOriginalWork!(candidateId, versionId));
    },
    *keptOriginalWork(candidateId, versionId) {
      // The original policy uses .some across duplicate version IDs under the FIRST candidate.
      for (const item of children(candidate(candidateId), 'versions')) {
        yield;
        if (value(item, 'id') === versionId && value(item, 'status') === 'kept_original')
          return true;
      }
      return false;
    },
    group(reference) {
      return finishClinicalReviewWork(this.groupWork!(reference));
    },
    *groupWork(reference) {
      const state = input.readCacheState?.(),
        key = JSON.stringify([reference.groupId, reference.groupVersionId]);
      if (state !== referenceState) {
        referenceCache.clear();
        referenceState = state;
      }
      if (state !== undefined && referenceCache.has(key)) {
        const result = referenceCache.get(key);
        referenceCache.delete(key);
        referenceCache.set(key, result);
        return result;
      }
      const resolve = function* (): Generator<void, WorkflowReviewGroup | undefined, void> {
        // The first retained ID match is also the first complete predicate match when
        // it contains this version. Address it through the complete index before
        // considering later repeated IDs; normal unique groups need no namespace scan.
        const first = groupRecord(reference.groupId);
        if (first)
          for (const version of children(first, 'versions')) {
            yield;
            if (value(version, 'id') === reference.groupVersionId) return groupHeader(first);
          }
        // Legacy .find includes the version predicate, so a later repeated group ID can qualify.
        for (const record of groupRecords()) {
          yield;
          if (value(record, 'id') !== reference.groupId) continue;
          for (const version of children(record, 'versions')) {
            yield;
            if (value(version, 'id') === reference.groupVersionId) return groupHeader(record);
          }
        }
        yield* prepareFallbackGroupWork(reference.groupId);
        if (
          fallbackStore()
            .prepare(`SELECT 1 FROM ${policyNamespace}versions WHERE group_id=? AND id=? LIMIT 1`)
            .get(reference.groupId, reference.groupVersionId)
        ) {
          const existing = groupRecord(reference.groupId);
          return existing ? groupHeader(existing) : yield* fallbackHeaderWork(reference.groupId);
        }
        return undefined;
      };
      const result = yield* resolve();
      if (state !== undefined && state === input.readCacheState?.()) {
        if (referenceCache.size >= 32) referenceCache.delete(referenceCache.keys().next().value!);
        referenceCache.set(key, result);
      }
      return result;
    },
    identityGroup(id) {
      return finishClinicalReviewWork(this.identityGroupWork!(id));
    },
    *identityGroupWork(id) {
      const record = groupRecord(id);
      return record ? groupHeader(record) : yield* fallbackHeaderWork(id);
    },
    currentVersion(group) {
      return finishClinicalReviewWork(this.currentVersionWork!(group));
    },
    *currentVersionWork(group) {
      const record = groupRecord(group.id),
        current = record && currentGroupVersion(record);
      if (current) return value<string>(current, 'id') || null;
      yield* prepareFallbackGroupWork(group.id);
      const last = fallbackStore()
        .prepare(
          `SELECT id FROM ${policyNamespace}versions WHERE group_id=? ORDER BY ordinal DESC LIMIT 1`,
        )
        .get(group.id);
      return last ? String(last.id) : null;
    },
    membership: selectedMembership,
    originalFingerprint: input.originalFingerprint,
    receipts,
    *receiptsWork() {
      const sql = fallbackStore(),
        selection = ++fallbackSelection,
        state = receiptProofState();
      let ordinal = 0;
      for (const record of receiptRecords()) {
        yield;
        const receipt = policyReceipt(record);
        if (input.activeReceipt(receipt))
          sql
            .prepare(`INSERT INTO ${policyNamespace}active_receipts VALUES(?,?,?)`)
            .run(selection, ordinal++, view.address(record));
      }
      return selectedSequence(function* () {
        fallbackStore();
        if (state !== receiptProofState()) throw Error('Selected identity receipts changed');
        for (const row of sql
          .prepare(
            `SELECT address FROM ${policyNamespace}active_receipts WHERE selection=? ORDER BY ordinal`,
          )
          .iterate(selection))
          yield policyReceipt(view.resolve(String(row.address)));
      });
    },
    packageEvidence: input.packageEvidence,
    manual(proposalId) {
      const proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
      return proposal && readSelectedManualSourceReceipt(view, proposal);
    },
    competingBoundaryUnrepaired(group, operationId, target) {
      return finishClinicalReviewWork(
        scope.competingBoundaryUnrepairedWork!(group, operationId, target),
      );
    },
    *competingBoundaryUnrepairedWork(group, operationId, target) {
      const state = input.readCacheState?.();
      if (state !== competingState) {
        noCompetingBoundary.clear();
        competingState = state;
      }
      const boundaryKey = state === undefined ? undefined : hashChunks([canonicalLiteral(group)]);
      if (boundaryKey && noCompetingBoundary.has(boundaryKey)) return false;
      let receipt: IdentityPolicyReceipt | undefined;
      const activeReceipts = yield* scope.receiptsWork!();
      for (const candidate of activeReceipts) {
        yield;
        if (candidate.operationId === operationId) {
          receipt = candidate;
          break;
        }
      }
      const claims = receipt?.scope.competingSubjects;
      let count = 0;
      const current = function* () {
        for (const record of groupRecords()) {
          const other = iterateCompetingIdentityBoundaries(group, [groupHeader(record)]).next()
            .value;
          if (!other) {
            yield undefined;
            continue;
          }
          count++;
          const latest = currentGroupVersion(record);
          if (!latest) throw Error('Competing report has no current version');
          yield {
            groupId: other.id,
            groupVersionId: value<string>(latest, 'id')!,
            subject: other.report!.subject!,
          };
        }
      };
      const authorized =
        receipt &&
        receipt.scope.groupId === group.id &&
        receipt.attestation === 'confirmed_displayed_identity_questions' &&
        claims?.length;
      const same = yield* identityCompetingClaimsEqualWork(current(), authorized ? claims! : []);
      if (!count) {
        if (boundaryKey) {
          if (noCompetingBoundary.size >= 32)
            noCompetingBoundary.delete(noCompetingBoundary.values().next().value!);
          noCompetingBoundary.add(boundaryKey);
        }
        return false;
      }
      if (!authorized || !same) return true;
      for (const prior of receipt!.scope.assignmentTargets || receipt!.scope.targets) {
        yield;
        if (
          prior.candidateId !== target.candidateId ||
          prior.candidateVersionId !== target.candidateVersionId ||
          prior.proposalId !== target.proposalId ||
          prior.recordId !== target.recordId
        )
          continue;
        let complete = true;
        for (const issueId of target.issueIds || [target.issueId]) {
          yield;
          let found = prior.hasIssueId?.(issueId) || false;
          if (!prior.hasIssueId)
            for (const id of prior.issueIds || [prior.issueId]) {
              yield;
              if (id === issueId) {
                found = true;
                break;
              }
            }
          if (!found) {
            complete = false;
            break;
          }
        }
        if (complete) return false;
      }
      return true;
    },
    evidence(...args) {
      return finishClinicalReviewWork(scope.evidenceWork!(...args));
    },
    *evidenceWork(group, record, review, original) {
      // Sentinel inspections cooperate even for records/links without claims.
      const issues = function* () {
        for (const candidate of group ? review.records : [record]) {
          yield undefined;
          let member = !group;
          if (group)
            for (const reference of selectedReportGroups(candidate.reportGroups)) {
              yield undefined;
              if (reference.groupId === group.id) {
                member = true;
                break;
              }
            }
          if (!member) continue;
          for (const issue of reviewRecordIssues(candidate))
            yield issue.kind === 'identity' ? issue : undefined;
        }
      };
      return {
        collected: yield* collectSelectedEvidencedIdentityWork(
          issues,
          group?.report?.subject?.text,
          original,
        ),
        structured: yield* structuredEvidencedIdentityWork(issues()),
      };
    },
  };
  return {
    ...scope,
    canonicalReviewRecords(records) {
      return input.questionState
        ? input.questionState.canonicalRecords(records)
        : canonicalReviewValueChunks(records);
    },
    groupRecords,
    groupHeader,
    currentGroupVersion,
    latestAcceptedRecord(recordId) {
      return finishClinicalReviewWork(this.latestAcceptedRecordWork(recordId));
    },
    *latestAcceptedRecordWork(recordId) {
      let latest: IntakeEnvelopeRecord | undefined;
      for (const decision of children(workflow, 'decisions')) {
        yield;
        if (value(decision, 'action') === 'accept' && value(decision, 'recordId') === recordId)
          latest = decision;
      }
      return latest ? read<import('../shared/intake.ts').IntakeReviewDecision>(latest) : undefined;
    },
    groundingBoundary(profileId, intakeId, sourceHash) {
      return {
        profileId,
        intakeId,
        sourceHash,
        originalFingerprint: input.originalFingerprint,
        boundaryFingerprint(group) {
          return finishClinicalReviewWork(this.boundaryFingerprintWork!(group));
        },
        *boundaryFingerprintWork(group) {
          const digest = createHash('sha256');
          digest.update(
            canonicalLiteral([
              'selected-intake-identity-v1',
              profileId,
              intakeId,
              sourceHash,
              input.originalFingerprint(group),
              group,
            ]),
          );
          yield;
          const record = groupRecord(group.id),
            current = record && currentGroupVersion(record);
          if (current) {
            // Preserve raw selected-version bytes, including unknown fields and
            // number spellings. A canonical re-encoding changes existing proofs.
            for (const chunk of view.recordChunks(current)) {
              digest.update(chunk);
              yield;
            }
          } else {
            digest.update(
              canonicalLiteral(
                scope.currentVersionWork
                  ? yield* scope.currentVersionWork(group)
                  : scope.currentVersion(group),
              ),
            );
            yield;
          }
          for (const record of groupRecords()) {
            const other = groupHeader(record);
            if (!iterateCompetingIdentityBoundaries(group, [other]).next().done)
              digest.update(canonicalLiteral([other.id, other.report?.subject]));
            // Noncompeting historical groups are inspected work too.
            yield;
          }
          return digest.digest('hex');
        },
      };
    },
    ownershipScope(birthDates, intakeVersion, birthDatesWork) {
      return {
        intakeVersion,
        remaining(groupId, selectedSources) {
          return finishClinicalReviewWork(this.remainingWork!(groupId, selectedSources));
        },
        *remainingWork(groupId, selectedSources) {
          const group = groupRecord(groupId),
            current = group && currentGroupVersion(group);
          if (!current) return false;
          const members = snapshot(current);
          if (members) {
            for (let ordinal = 0; ordinal < members.reference.memberCount; ordinal++) {
              yield;
              const member = members.memberAt(ordinal)!;
              for (let occurrence = 0; occurrence < member.occurrenceCount; occurrence++) {
                yield;
                if (!selectedSources.has(members.occurrenceRecordId(member, occurrence)!))
                  return true;
              }
            }
          } else
            for (const member of children(current, 'members')) {
              yield;
              for (const occurrence of children(member, 'occurrences')) {
                yield;
                if (!selectedSources.has(value<string>(occurrence, 'recordId')!)) return true;
              }
            }
          return false;
        },
        lastConfirmation(groupId, personId) {
          return finishClinicalReviewWork(this.lastConfirmationWork!(groupId, personId));
        },
        *lastConfirmationWork(groupId, personId) {
          let result: IdentityPolicyReceipt | undefined;
          for (const record of children(workflow, 'identityConfirmations')) {
            yield;
            const receipt = policyReceipt(record);
            if (
              receipt.scope.groupId === groupId &&
              (receipt.assignedPerson?.personId === personId ||
                (receipt.outcome === 'this_is_me' && personId === 'patient'))
            )
              result = receipt;
          }
          return result;
        },
        currentVersion: (group) => scope.currentVersion(group),
        currentVersionWork: (group) => scope.currentVersionWork!(group),
        group: (id) => scope.identityGroup(id),
        groupWork: (id) => scope.identityGroupWork!(id),
        firstGroup(references) {
          return finishClinicalReviewWork(this.firstGroupWork!(references));
        },
        *firstGroupWork(references) {
          let first: IntakeEnvelopeRecord | undefined,
            ordinal = Infinity;
          // References are the complete selected membership sequence. Resolve
          // each public ID's first retained group, then preserve collection order
          // even when duplicated IDs occur in a different reference order.
          for (const reference of selectedReportGroups(references)) {
            yield;
            const record = groupRecord(reference.groupId);
            if (!record) continue;
            const position = intakeEnvelopeRecordOrder(view, record).at(-1)!;
            if (position < ordinal) {
              first = record;
              ordinal = position;
            }
          }
          return first ? groupHeader(first) : undefined;
        },
        confirmation(operationId) {
          return finishClinicalReviewWork(this.confirmationWork!(operationId));
        },
        *confirmationWork(operationId) {
          for (const record of children(workflow, 'identityConfirmations')) {
            yield;
            if (value(record, 'operationId') === operationId) return policyReceipt(record);
          }
          return undefined;
        },
        competing(group) {
          return finishClinicalReviewWork(this.competingWork!(group));
        },
        *competingWork(group) {
          for (const record of groupRecords()) {
            yield;
            if (!iterateCompetingIdentityBoundaries(group, [groupHeader(record)]).next().done)
              return true;
          }
          return false;
        },
        blockerSink() {
          if (receiptScopeClosed) throw Error('Selected ownership scope closed');
          if (!ownershipPolicyDb) {
            if (!input.policySql)
              ownershipPolicyScratch = disposableSqlite('circus-ownership-policy-');
            ownershipPolicyDb = input.policySql || ownershipPolicyScratch!.db;
            ownershipPolicyDb.exec(
              `CREATE TABLE ${policyNamespace}blockers(scope INTEGER,ordinal INTEGER PRIMARY KEY,value TEXT,UNIQUE(scope,value))`,
            );
          }
          const sql = ownershipPolicyDb,
            id = ++ownershipPolicyScope;
          return {
            add(value: string) {
              sql
                .prepare(
                  `INSERT OR IGNORE INTO ${policyNamespace}blockers(scope,value) VALUES(?,?)`,
                )
                .run(id, value);
            },
            *values() {
              for (const row of sql
                .prepare(
                  `SELECT value FROM ${policyNamespace}blockers WHERE scope=? ORDER BY ordinal`,
                )
                .iterate(id))
                yield String(row.value);
            },
          };
        },
        birthDates,
        birthDatesWork,
      };
    },
    clinicalSourceScope(proofs) {
      const retainedGroups = new WeakMap<
        import('./clinical-source-scope.ts').ClinicalSourceScopeGroup,
        IntakeEnvelopeRecord
      >();
      const result: ClinicalOriginalScope = {
        ...proofs,
        packageSource: input.packageEvidence,
        groups: () =>
          selectedSequence(function* () {
            for (const record of groupRecords()) {
              const header = groupHeader(record);
              retainedGroups.set(header, record);
              yield header;
            }
          }),
        version(group, id) {
          return finishClinicalReviewWork(this.versionWork!(group, id));
        },
        *versionWork(
          group,
          id,
        ): Generator<
          void,
          import('./clinical-source-scope.ts').ClinicalSourceScopeVersion | undefined,
          void
        > {
          const record = retainedGroups.get(group);
          if (!record) throw Error('Foreign selected clinical source group');
          let selected: IntakeEnvelopeRecord | undefined;
          if (id === undefined) selected = currentGroupVersion(record);
          else
            for (const version of children(record, 'versions')) {
              yield;
              if (value(version, 'id') === id) {
                selected = version;
                break;
              }
            }
          if (!selected) return undefined;
          const current = selected,
            members = snapshot(current);
          return {
            id: value<string>(current, 'id')!,
            membership: membershipFor(current),
            hasOccurrence(versionId, recordId, proposalId) {
              return finishClinicalReviewWork(
                this.hasOccurrenceWork!(versionId, recordId, proposalId),
              );
            },
            *hasOccurrenceWork(versionId, recordId, proposalId): Generator<void, boolean, void> {
              if (members) {
                for (let index = 0; index < members.reference.memberCount; index++) {
                  yield;
                  const member = members.memberAt(index)!;
                  if (member.candidateVersionId !== versionId) continue;
                  let after: string | undefined;
                  do {
                    yield;
                    const page = members.occurrences(member, {
                      after,
                      items: 64,
                      bytes: metadataBytes,
                    });
                    if (
                      page.occurrences.some(
                        (occurrence) =>
                          occurrence.recordId === recordId &&
                          (proposalId === undefined || occurrence.proposalId === proposalId),
                      )
                    )
                      return true;
                    if (page.complete) break;
                    if (!page.after || page.after === after)
                      throw Error('Clinical source occurrences failed to advance');
                    after = page.after;
                  } while (true);
                }
              } else
                for (const member of children(current, 'members')) {
                  yield;
                  if (value(member, 'candidateVersionId') !== versionId) continue;
                  for (const occurrence of children(member, 'occurrences')) {
                    yield;
                    if (
                      value(occurrence, 'recordId') === recordId &&
                      (proposalId === undefined || value(occurrence, 'proposalId') === proposalId)
                    )
                      return true;
                  }
                }
              return false;
            },
          };
        },
        receipts: () =>
          selectedSequence(function* () {
            for (const receipt of children(workflow, 'identityConfirmations'))
              yield policyReceipt(receipt);
          }),
        originalFingerprint: (group) =>
          input.originalFingerprint({ ...group, basis: 'report_anchor' }),
        *acceptedRecords() {
          for (const record of this.acceptedRecordsWork!()) if (record !== undefined) yield record;
        },
        *acceptedRecordsWork() {
          const imported = view.child(intake, 'imported');
          function* batches() {
            if (imported) yield imported;
            yield* children(intake, 'importHistory');
          }
          for (const batch of batches()) {
            yield;
            const clinical = view.child(batch, 'clinical');
            for (const record of children(clinical, 'records')) {
              yield;
              yield read<Record<string, unknown>>(record);
            }
          }
        },
      };
      if (input.policySql && input.sourceScopePrefixProof) {
        sourceScopePrefix ??= createClinicalSourceScopePrefix({
          sql: input.policySql,
          scope: result,
          rowBytes: metadataBytes,
          work: input.sourceScopePrefixWork,
          assertOpen() {
            if (fallbackClosed || receiptScopeClosed) throw Error('Closed clinical source scope');
            view.address(view.root());
          },
          proof: input.sourceScopePrefixProof,
          groupAt(ordinal) {
            const record = workflow && view.childAt(workflow, 'reportGroups', ordinal);
            if (!record) throw Error('Missing verified clinical source group');
            const header = groupHeader(record);
            retainedGroups.set(header, record);
            return header;
          },
        });
        const prefix = sourceScopePrefix;
        result.groundedSomeWork = (boundary, evaluate) => prefix.some(boundary, evaluate);
      }
      return result;
    },
    occurrence(candidateId, versionId, recordId, proposalId) {
      return finishClinicalReviewWork(
        this.occurrenceWork(candidateId, versionId, recordId, proposalId),
      );
    },
    *occurrenceWork(candidateId, versionId, recordId, proposalId) {
      for (const occurrence of children(version(candidateId, versionId), 'occurrences')) {
        yield;
        if (
          value(occurrence, 'recordId') === recordId &&
          value(occurrence, 'proposalId') === proposalId
        )
          return read<IntakeCandidateOccurrence>(occurrence);
      }
      return undefined;
    },
    reportContext(envelopeId, proposalId) {
      return finishClinicalReviewWork(this.reportContextWork(envelopeId, proposalId));
    },
    *reportContextWork(envelopeId, proposalId) {
      let result: IntakeSourceContext['reportContext'] | undefined;
      for (const group of groupRecords()) {
        yield;
        for (const version of children(group, 'versions')) {
          yield;
          const context = value<IntakeSourceContext['reportContext']>(version, 'context');
          if (context?.envelopeId !== envelopeId) continue;
          const members = snapshot(version);
          let matches = false;
          if (members) {
            for (let index = 0; index < members.reference.memberCount && !matches; index++) {
              yield;
              const member = members.memberAt(index)!;
              let after: string | undefined;
              do {
                yield;
                const page = members.occurrences(member, {
                  after,
                  items: 64,
                  bytes: metadataBytes,
                });
                matches = page.occurrences.some(
                  (occurrence) => occurrence.proposalId === proposalId,
                );
                if (matches || page.complete) break;
                if (!page.after || page.after === after)
                  throw Error('Report context occurrences did not advance');
                after = page.after;
              } while (true);
            }
          } else
            for (const member of children(version, 'members')) {
              yield;
              for (const occurrence of children(member, 'occurrences')) {
                yield;
                if (value(occurrence, 'proposalId') === proposalId) matches = true;
              }
            }
          if (matches) result = context;
        }
      }
      return result;
    },
  };
}
