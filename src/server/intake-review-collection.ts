import { selectedReportGroupLinks, selectedReportGroups } from './intake-selected-report-groups.ts';
import { canonicalReviewValueChunks } from './intake-review-question-state.ts';
import { collectSelectedEvidencedIdentity } from './intake-identity-name-evidence.ts';
import { nativeIdentityPolicyScope } from './intake-identity-snapshot.ts';
import type { IntakeIdentityScopeReference } from '../shared/intake-identity.ts';
import type { ClinicalOriginalScope } from './clinical-source-scope.ts';
import { createHash } from 'node:crypto';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import {
  intakeEnvelopeRecordOrder,
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
} from './intake-identity-policy.ts';
import {
  structuredEvidencedIdentity,
  iterateCompetingIdentityBoundaries,
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

/** Complete joins over selected authority. The host supplies current source, policy and inventory proofs. */
export function collectionWorkflowReviewScope(input: {
  close?(): void;
  issueSink?: import('./intake-workflow.ts').WorkflowReviewScope['issueSink'];
  bindIdentityWarnings?: import('./intake-workflow.ts').WorkflowReviewScope['bindIdentityWarnings'];
  questionState?: ReturnType<
    typeof import('./intake-review-question-state.ts').openReviewQuestionState
  >;
  readDraft?: (record: IntakeEnvelopeRecord) => IntakeReviewDraft;
  membershipIndex?: import('./intake-review-membership-index.ts').CollectionReviewMembership;
  view: IntakeCollectionEnvelopeReader;
  catalog: ReportSnapshotCatalog;
  metadataBytes: number;
  /** A host-verified SQLite state stamp; omitted hosts perform every read. */
  readCacheState?: () => string | undefined;
  packageEvidence: boolean;
  activeReceipt(receipt: IdentityPolicyReceipt): boolean;
  originalFingerprint(group: WorkflowReviewGroup): string;
  reportSource: WorkflowReviewScope['reportSource'];
}): WorkflowReviewScope & {
  canonicalReviewRecords(records: unknown): Iterable<string>;
  latestAcceptedRecord(
    recordId: string,
  ): import('../shared/intake.ts').IntakeReviewDecision | undefined;
  reportContext(
    envelopeId: string,
    proposalId: string | null,
  ): IntakeSourceContext['reportContext'] | undefined;
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
  const contains = (
    record: IntakeEnvelopeRecord,
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): boolean => {
    if (input.membershipIndex)
      return input.membershipIndex.contains(record, candidateId, versionId, recordId, proposalId);
    const members = snapshot(record);
    if (members) {
      // Preserve occurrence union across duplicate member IDs, not only member().
      let after: string | undefined;
      do {
        const page = members.members({ after, items: 64, bytes: 128 * 1024 });
        for (const member of page.members) {
          if (member.candidateId !== candidateId || member.candidateVersionId !== versionId)
            continue;
          let occurrenceAfter: string | undefined;
          do {
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
      if (
        value(member, 'candidateId') !== candidateId ||
        value(member, 'candidateVersionId') !== versionId
      )
        continue;
      for (const occurrence of children(member, 'occurrences'))
        if (
          value(occurrence, 'recordId') === recordId &&
          value(occurrence, 'proposalId') === proposalId
        )
          return true;
    }
    return false;
  };
  const fallbackGroupId = (candidate: IntakeEnvelopeRecord) =>
    'report-group:' + hashChunks([canonicalLiteral(['candidate', value(candidate, 'id')])]);
  const coveredVersion = (candidateId: string, versionId: string): boolean => {
    if (input.membershipIndex) return input.membershipIndex.covered(candidateId, versionId);
    for (const group of groupRecords())
      for (const version of children(group, 'versions')) {
        const members = snapshot(version);
        if (
          members
            ? !!members.member(candidateId, versionId)
            : !!memberRecord(version, candidateId, versionId)
        )
          return true;
      }
    return false;
  };
  const fallbackVersionId = (groupId: string, version: IntakeEnvelopeRecord) => {
    function* pieces() {
      yield '[' + canonicalLiteral(groupId) + ',' + canonicalLiteral(value(version, 'id')) + ',[';
      let comma = false;
      for (const occurrence of children(version, 'occurrences')) {
        if (comma) yield ',';
        comma = true;
        yield canonicalLiteral(read(occurrence));
      }
      yield ']]';
    }
    return 'report-group-version:' + hashChunks(pieces());
  };
  function* fallbackVersions(groupId: string) {
    // Every later duplicate candidate prepends its fallback versions to the earlier group.
    const count = workflow ? view.childCount(workflow, 'candidates') : 0;
    for (let index = count - 1; index >= 0; index--) {
      const candidate = view.childAt(workflow!, 'candidates', index)!;
      if (fallbackGroupId(candidate) !== groupId) continue;
      for (const version of children(candidate, 'versions'))
        if (
          !value(version, 'sourceContext') &&
          !coveredVersion(value<string>(candidate, 'id')!, value<string>(version, 'id')!)
        )
          yield { candidate, version, id: fallbackVersionId(groupId, version) };
    }
  }
  const fallbackHeader = (id: string): WorkflowReviewGroup | undefined => {
    for (const candidate of children(workflow, 'candidates')) {
      if (fallbackGroupId(candidate) !== id) continue;
      for (const version of children(candidate, 'versions'))
        if (
          !value(version, 'sourceContext') &&
          !coveredVersion(value<string>(candidate, 'id')!, value<string>(version, 'id')!)
        )
          return {
            id,
            basis: 'candidate_fallback',
            sourceFileId: null,
            sourceHash: null,
            memberId: null,
            report: null,
          };
    }
    return undefined;
  };
  const membershipFor = (
    current: IntakeEnvelopeRecord,
  ): ReturnType<WorkflowReviewScope['membership']> => {
    const members = snapshot(current);
    return {
      retains(prior) {
        return selectedSequence(prior).every((member) => {
          if (members) {
            const selected = members.member(member.candidateId, member.candidateVersionId);
            return (
              !!selected &&
              hashChunks(members.canonicalSection(selected)) ===
                hashChunks([canonicalLiteral(member.section || null)]) &&
              selectedSequence(member.occurrences).every((occurrence) =>
                members.hasOccurrence(selected, occurrence),
              )
            );
          }
          const selected = memberRecord(current, member.candidateId, member.candidateVersionId);
          if (
            !selected ||
            canonicalLiteral(value(selected, 'section') || null) !==
              canonicalLiteral(member.section || null)
          )
            return false;
          return selectedSequence(member.occurrences).every((wanted) => {
            for (const occurrence of children(selected, 'occurrences'))
              if (canonicalLiteral(read(occurrence)) === canonicalLiteral(wanted)) return true;
            return false;
          });
        });
      },
    };
  };
  const policyReceipt = (record: IntakeEnvelopeRecord): IdentityPolicyReceipt => {
    const receiptScope = view.child(record, 'scope');
    if (!receiptScope) throw Error('Missing retained identity scope');
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
      const item = value(record, name);
      if (item !== undefined)
        header[name] =
          name === 'assignedPerson' || name === 'selfUpdate'
            ? JSON.parse(JSON.stringify(item))
            : item;
    }
    if (value(receiptScope, 'format') === 'health-intake-identity-scope-v2') {
      const reference = JSON.parse(
        JSON.stringify(read<IntakeIdentityScopeReference>(receiptScope)),
      ) as IntakeIdentityScopeReference;
      return {
        ...header,
        scope: nativeIdentityPolicyScope(catalog, reference),
      } as IdentityPolicyReceipt;
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
  const receipts = selectedSequence(function* () {
    for (const record of children(workflow, 'identityConfirmations')) {
      const receipt = policyReceipt(record);
      if (input.activeReceipt(receipt)) yield receipt;
    }
  });
  let questionInlineBytes = metadataBytes;
  const scope: WorkflowReviewScope = {
    close: input.close,
    issueSink: input.issueSink,
    bindIdentityWarnings: input.bindIdentityWarnings,
    versionId(proposalId, entry) {
      const proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
      const revision =
        proposal &&
        (value<string>(proposal, 'sourceTextDependencyToken') ||
          value<string>(proposal, 'sourceTextRevisionId'));
      return intakeCandidateVersionIdForRevision(entry, revision);
    },
    references(candidateId, versionId, recordId, proposalId) {
      const references = function* (): Generator<IntakeReviewGroupReference> {
        if (input.membershipIndex) {
          for (const reference of input.membershipIndex.references(
            candidateId,
            versionId,
            recordId,
            proposalId,
          )) {
            yield reference;
          }
        } else
          for (const group of groupRecords()) {
            for (const version of children(group, 'versions')) {
              if (!contains(version, candidateId, versionId, recordId, proposalId)) continue;
              const reference = {
                groupId: value<string>(group, 'id')!,
                groupVersionId: value<string>(version, 'id')!,
              };
              yield reference;
              break;
            }
          }
        if (!coveredVersion(candidateId, versionId)) {
          const groupId =
            'report-group:' + hashChunks([canonicalLiteral(['candidate', candidateId])]);
          outer: for (const fallback of fallbackVersions(groupId)) {
            if (
              value(fallback.candidate, 'id') !== candidateId ||
              value(fallback.version, 'id') !== versionId
            )
              continue;
            for (const occurrence of children(fallback.version, 'occurrences'))
              if (
                value(occurrence, 'recordId') === recordId &&
                value(occurrence, 'proposalId') === proposalId
              ) {
                yield { groupId, groupVersionId: fallback.id };
                break outer;
              }
          }
        }
      };
      return selectedReportGroupLinks(
        references,
        { candidateId, candidateVersionId: versionId, recordId, proposalId },
        metadataBytes,
      );
    },
    reportSource: input.reportSource,
    questions(candidateId, versionId) {
      const selected = function* () {
        for (const question of children(workflow, 'questions')) {
          if (value(question, 'candidateId') !== candidateId) continue;
          const selectedVersion = value(question, 'candidateVersionId');
          if (!selectedVersion || selectedVersion === versionId) yield question;
        }
      };
      const readQuestion = (question: IntakeEnvelopeRecord) =>
        input.questionState?.question(question, metadataBytes) ?? read<IntakeQuestion>(question);
      const result: IntakeQuestion[] = [];
      let bytes = 0,
        count = 0,
        referenced = false;
      for (const question of selected()) {
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
      );
    },
    accepted(candidateId, versionId) {
      if (!workflow || view.childCount(workflow, 'decisions') === 0) return false;
      return !!view.lookup('accepted-candidate-version', [JSON.stringify(candidateId), versionId]);
    },
    draft(proposalId, recordId, versionId) {
      if (!workflow || view.childCount(workflow, 'reviewDrafts') === 0) return null;
      const result = view.lookup('draft-record-version-last', [
        proposalId || '',
        recordId,
        versionId,
      ]);
      if (!result) return null;
      if (input.readDraft) return input.readDraft(result);
      const draft = read<IntakeReviewDraft>(result);
      if (draft.format === 'health-intake-review-draft-v2')
        throw Error('Native review history requires its selected policy reader');
      return draft;
    },
    firstVersion(candidateId) {
      const item = candidate(candidateId);
      const first = item && view.childAt(item, 'versions', 0);
      return first && value<string>(first, 'id');
    },
    keptOriginal(candidateId, versionId) {
      // The original policy uses .some across duplicate version IDs under the FIRST candidate.
      for (const item of children(candidate(candidateId), 'versions'))
        if (value(item, 'id') === versionId && value(item, 'status') === 'kept_original')
          return true;
      return false;
    },
    group(reference) {
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
      const resolve = (): WorkflowReviewGroup | undefined => {
        // The first retained ID match is also the first complete predicate match when
        // it contains this version. Address it through the complete index before
        // considering later repeated IDs; normal unique groups need no namespace scan.
        const first = groupRecord(reference.groupId);
        if (first)
          for (const version of children(first, 'versions'))
            if (value(version, 'id') === reference.groupVersionId) return groupHeader(first);
        // Legacy .find includes the version predicate, so a later repeated group ID can qualify.
        for (const record of groupRecords()) {
          if (value(record, 'id') !== reference.groupId) continue;
          for (const version of children(record, 'versions'))
            if (value(version, 'id') === reference.groupVersionId) return groupHeader(record);
        }
        for (const fallback of fallbackVersions(reference.groupId))
          if (fallback.id === reference.groupVersionId) {
            const existing = groupRecord(reference.groupId);
            return existing ? groupHeader(existing) : fallbackHeader(reference.groupId);
          }
        return undefined;
      };
      const result = resolve();
      if (state !== undefined && state === input.readCacheState?.()) {
        if (referenceCache.size >= 32) referenceCache.delete(referenceCache.keys().next().value!);
        referenceCache.set(key, result);
      }
      return result;
    },
    identityGroup(id) {
      const record = groupRecord(id);
      return record ? groupHeader(record) : fallbackHeader(id);
    },
    currentVersion(group) {
      const record = groupRecord(group.id),
        current = record && currentGroupVersion(record);
      if (current) return value<string>(current, 'id') || null;
      let latest: string | null = null;
      for (const fallback of fallbackVersions(group.id)) latest = fallback.id;
      return latest;
    },
    membership(group) {
      if (groupRecord(group.id)) return membershipFor(selectedVersion(group));
      let current:
        { candidate: IntakeEnvelopeRecord; version: IntakeEnvelopeRecord; id: string } | undefined;
      for (const fallback of fallbackVersions(group.id)) current = fallback;
      if (!current) throw Error('Missing fallback clinical membership');
      const selected = current;
      return {
        retains(prior) {
          return selectedSequence(prior).every(
            (member) =>
              member.candidateId === value(selected.candidate, 'id') &&
              member.candidateVersionId === value(selected.version, 'id') &&
              !member.section &&
              selectedSequence(member.occurrences).every((wanted) => {
                for (const occurrence of children(selected.version, 'occurrences'))
                  if (canonicalLiteral(read(occurrence)) === canonicalLiteral(wanted)) return true;
                return false;
              }),
          );
        },
      };
    },
    originalFingerprint: input.originalFingerprint,
    receipts,
    packageEvidence: input.packageEvidence,
    manual(proposalId) {
      const proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
      return proposal && readSelectedManualSourceReceipt(view, proposal);
    },
    competingBoundaryUnrepaired(group, operationId, target) {
      const state = input.readCacheState?.();
      if (state !== competingState) {
        noCompetingBoundary.clear();
        competingState = state;
      }
      const boundaryKey = state === undefined ? undefined : hashChunks([canonicalLiteral(group)]);
      if (boundaryKey && noCompetingBoundary.has(boundaryKey)) return false;
      const receipt = receipts.find((receipt) => receipt.operationId === operationId);
      const claims = receipt?.scope.competingSubjects;
      const headers = function* () {
        for (const item of groupRecords()) yield groupHeader(item);
      };
      let count = 0;
      for (const other of iterateCompetingIdentityBoundaries(group, headers())) {
        count++;
        if (
          !receipt ||
          receipt.scope.groupId !== group.id ||
          receipt.attestation !== 'confirmed_displayed_identity_questions' ||
          !claims?.length ||
          count > claims.length
        )
          return true;
        if (
          !claims.some(
            (claim) =>
              claim.groupId === other.id &&
              claim.groupVersionId === scope.currentVersion(other) &&
              canonicalLiteral(claim.subject) === canonicalLiteral(other.report!.subject),
          )
        )
          return true;
      }
      if (!count) {
        if (boundaryKey) {
          if (noCompetingBoundary.size >= 32)
            noCompetingBoundary.delete(noCompetingBoundary.values().next().value!);
          noCompetingBoundary.add(boundaryKey);
        }
        return false;
      }
      return (
        count !== claims!.length ||
        !(receipt!.scope.assignmentTargets || receipt!.scope.targets).some(
          (prior) =>
            prior.candidateId === target.candidateId &&
            prior.candidateVersionId === target.candidateVersionId &&
            prior.proposalId === target.proposalId &&
            prior.recordId === target.recordId &&
            (target.issueIds || [target.issueId]).every((issueId) =>
              selectedSequence(prior.issueIds || [prior.issueId]).some((id) => id === issueId),
            ),
        )
      );
    },
    evidence(group, record, review, original) {
      // The supplied review is the complete bounded proposal, not a display page.
      const issues = function* () {
        for (const candidate of group ? review.records : [record]) {
          if (
            group &&
            !selectedReportGroups(candidate.reportGroups).some(
              (reference) => reference.groupId === group.id,
            )
          )
            continue;
          for (const issue of reviewRecordIssues(candidate))
            if (issue.kind === 'identity') yield issue;
        }
      };
      return {
        collected: collectSelectedEvidencedIdentity(issues, group?.report?.subject?.text, original),
        structured: structuredEvidencedIdentity(issues()),
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
      let latest: IntakeEnvelopeRecord | undefined;
      for (const decision of children(workflow, 'decisions'))
        if (value(decision, 'action') === 'accept' && value(decision, 'recordId') === recordId)
          latest = decision;
      return latest ? read<import('../shared/intake.ts').IntakeReviewDecision>(latest) : undefined;
    },
    groundingBoundary(profileId, intakeId, sourceHash) {
      return {
        profileId,
        intakeId,
        sourceHash,
        originalFingerprint: input.originalFingerprint,
        boundaryFingerprint(group) {
          function* pieces() {
            yield canonicalLiteral([
              'selected-intake-identity-v1',
              profileId,
              intakeId,
              sourceHash,
              input.originalFingerprint(group),
              group,
            ]);
            const record = groupRecord(group.id),
              current = record && currentGroupVersion(record);
            if (current) yield* view.recordChunks(current);
            else yield canonicalLiteral(scope.currentVersion(group));
            for (const record of groupRecords()) {
              const other = groupHeader(record);
              if (!iterateCompetingIdentityBoundaries(group, [other]).next().done)
                yield canonicalLiteral([other.id, other.report?.subject]);
            }
          }
          return hashChunks(pieces());
        },
      };
    },
    ownershipScope(birthDates, intakeVersion) {
      return {
        intakeVersion,
        remaining(groupId, selectedSources) {
          const group = groupRecord(groupId),
            current = group && currentGroupVersion(group);
          if (!current) return false;
          const members = snapshot(current);
          if (members) {
            for (let ordinal = 0; ordinal < members.reference.memberCount; ordinal++) {
              const member = members.memberAt(ordinal)!;
              for (let occurrence = 0; occurrence < member.occurrenceCount; occurrence++)
                if (!selectedSources.has(members.occurrenceRecordId(member, occurrence)!))
                  return true;
            }
          } else
            for (const member of children(current, 'members'))
              for (const occurrence of children(member, 'occurrences'))
                if (!selectedSources.has(value<string>(occurrence, 'recordId')!)) return true;
          return false;
        },
        lastConfirmation(groupId, personId) {
          let result: IdentityPolicyReceipt | undefined;
          for (const record of children(workflow, 'identityConfirmations')) {
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
        currentVersion: scope.currentVersion,
        group: scope.identityGroup,
        firstGroup(references) {
          let first: IntakeEnvelopeRecord | undefined,
            ordinal = Infinity;
          // References are the complete selected membership sequence. Resolve
          // each public ID's first retained group, then preserve collection order
          // even when duplicated IDs occur in a different reference order.
          for (const reference of selectedReportGroups(references)) {
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
          for (const record of children(workflow, 'identityConfirmations'))
            if (value(record, 'operationId') === operationId) return policyReceipt(record);
          return undefined;
        },
        competing(group) {
          function* groups() {
            for (const record of groupRecords()) yield groupHeader(record);
          }
          return !iterateCompetingIdentityBoundaries(group, groups()).next().done;
        },
        birthDates,
      };
    },
    clinicalSourceScope(proofs) {
      const retainedGroups = new WeakMap<
        import('./clinical-source-scope.ts').ClinicalSourceScopeGroup,
        IntakeEnvelopeRecord
      >();
      return {
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
          const record = retainedGroups.get(group);
          if (!record) throw Error('Foreign selected clinical source group');
          let selected: IntakeEnvelopeRecord | undefined;
          if (id === undefined) selected = currentGroupVersion(record);
          else
            for (const version of children(record, 'versions'))
              if (value(version, 'id') === id) {
                selected = version;
                break;
              }
          if (!selected) return undefined;
          const current = selected,
            members = snapshot(current);
          return {
            id: value<string>(current, 'id')!,
            membership: membershipFor(current),
            hasOccurrence(versionId, recordId, proposalId) {
              if (members) {
                for (let index = 0; index < members.reference.memberCount; index++) {
                  const member = members.memberAt(index)!;
                  if (member.candidateVersionId !== versionId) continue;
                  let after: string | undefined;
                  do {
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
                  if (value(member, 'candidateVersionId') !== versionId) continue;
                  for (const occurrence of children(member, 'occurrences'))
                    if (
                      value(occurrence, 'recordId') === recordId &&
                      (proposalId === undefined || value(occurrence, 'proposalId') === proposalId)
                    )
                      return true;
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
          const imported = view.child(intake, 'imported');
          function* batches() {
            if (imported) yield imported;
            yield* children(intake, 'importHistory');
          }
          for (const batch of batches()) {
            const clinical = view.child(batch, 'clinical');
            for (const record of children(clinical, 'records'))
              yield read<Record<string, unknown>>(record);
          }
        },
      };
    },
    occurrence(candidateId, versionId, recordId, proposalId) {
      for (const occurrence of children(version(candidateId, versionId), 'occurrences'))
        if (
          value(occurrence, 'recordId') === recordId &&
          value(occurrence, 'proposalId') === proposalId
        )
          return read<IntakeCandidateOccurrence>(occurrence);
      return undefined;
    },
    reportContext(envelopeId, proposalId) {
      let result: IntakeSourceContext['reportContext'] | undefined;
      for (const group of groupRecords())
        for (const version of children(group, 'versions')) {
          const context = value<IntakeSourceContext['reportContext']>(version, 'context');
          if (context?.envelopeId !== envelopeId) continue;
          const members = snapshot(version);
          let matches = false;
          if (members) {
            for (let index = 0; index < members.reference.memberCount && !matches; index++) {
              const member = members.memberAt(index)!;
              let after: string | undefined;
              do {
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
            for (const member of children(version, 'members'))
              for (const occurrence of children(member, 'occurrences'))
                if (value(occurrence, 'proposalId') === proposalId) matches = true;
          if (matches) result = context;
        }
      return result;
    },
  };
}
