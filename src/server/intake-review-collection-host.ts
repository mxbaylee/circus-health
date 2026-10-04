import { revision } from './database.ts';
import {
  reviewReadStamp,
  preparedClinicalReviewRead,
  beginPreparedClinicalReviewRead,
  isPreparedClinicalReviewReadCurrent,
  discardPreparedClinicalReviewRead,
  retainPreparedClinicalReviewRead,
} from './intake-clinical-review-read-cache.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { reviewIssueFactory, createReviewIssueScratch } from './intake-review-issue-state.ts';
/** Native clinical host orchestration. Authorization and verified proposal bytes precede all policy reads. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { assertIntakeOwner, verifyIntakeOriginal } from './intake.ts';
import { HttpError, clinicalReviewRevision, safeText } from './database.ts';
import { getNote } from './notes.ts';
import { bindReviewIdentityWarnings } from './intake-review-identity-warnings.ts';
import {
  effectiveKnownNames,
  challengedKnownNames,
  futureNameOwners,
} from './name-associations.ts';
import { selectedIdentityPeopleSnapshots } from './intake-identity-people.ts';
import { identityOriginalFingerprintForMember } from './intake-identity-policy.ts';
import {
  selectedIdentityReviewGroundingLookups,
  identityGroundingGeneration,
} from './intake-identity-grounding.ts';
import { copiedManualSourceRecordApplies } from './intake-manual-copy.ts';
import { issueResolutionCurrent } from './intake-issue-dependencies.ts';
import { profileOriginal } from './profile-storage.ts';
import { intakeSourceVersion, intakeSourceMetadata } from './intake-state-access.ts';
import { proposalDependenciesCurrent } from './intake-proposal-dependencies.ts';
import { readRetainedPlanEvidence, prepareRetainedPlanAccess } from './intake-retained-plan.ts';
import {
  readCollectionReviewMembership,
  prepareCollectionReviewMembership,
} from './intake-review-membership-index.ts';
import { prepareIntakeSourceDependencyHeaders } from './intake-source-text-dependencies.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import {
  canonicalLiteral,
  validateJSONL,
  validationSummary,
  MAX_INTAKE_BYTES,
} from './intake-format.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import {
  prepareReviewQuestionState,
  openReviewQuestionState,
} from './intake-review-question-state.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import {
  resolveNativeReportSource,
  hasHistoricalReportSourceProvider,
} from './intake-report-source-resolution.ts';
import { workflowHash } from './intake-workflow.ts';
import { readNativeReviewDraft } from './intake-review-draft-state.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { activeMappingRules } from './clinical-import.ts';
import { prepareDuplicateEvidenceIndex } from './duplicate-evidence-index.ts';
import { prepareOwnershipDecisionIndex } from './ownership-decision-index.ts';
import {
  clinicalSourceScopeCheck,
  clinicalSourceScopeDependencyIds,
  type ClinicalScopeOriginal,
} from './clinical-source-scope.ts';
import type {
  BuildReviewInput,
  SelectedClinicalReportSource,
  SelectedClinicalProjectionScope,
} from './clinical-import.ts';
import {
  collectionWorkflowReviewScope,
  intakeReviewChildren,
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
} from './intake-review-collection.ts';
import {
  createCollectionClinicalReviewSession,
  type CollectionClinicalReviewResult,
} from './intake-review-collection-session.ts';
import type {
  IntakeReportContextReference,
  IntakeMetadata,
  IntakePackageMember,
  IntakeReviewRecord,
} from '../shared/intake.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';

type File = BuildReviewInput['file'] & {
  mime_type: string;
  path: string;
  bytes: number;
  kind: string;
  details_json: string;
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function requiredFile(db: DatabaseSync, id: string, original = false): File {
  const row = db
    .prepare(
      'SELECT f.*,p.name AS provider FROM source_files f LEFT JOIN providers p ON p.id=f.provider_id WHERE f.id=?' +
        (original ? " AND f.kind='intake_original'" : ''),
    )
    .get(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  return row as unknown as File;
}
function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
  bytes: number,
): T | undefined {
  const child = view.child(record, name);
  if (child) return readIntakeReviewValue<T>(view, child, bytes);
  const value = view.field(record, name, { bytes });
  if (value.kind === 'fragmented')
    throw new IntakeReviewFragmentRequired({
      format: 'health-intake-review-fragment-v1',
      logical: view.logical,
      address: view.address(record),
      field: name,
    });
  return value.kind === 'value' ? (value.value as T) : undefined;
}
/** Prepare only originals reachable through this proposal's exact accepted source identities.
 * Parent headers and retained membership are explicit cold compatibility work. A
 * queue must call this for its selected proposals, not turn a display page into
 * the policy's complete dependency scope. */
export async function prepareCollectionClinicalReviewDependencies(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null = null,
  options: { assertRunning?: () => void } = {},
): Promise<void> {
  assertIntakeOwner(db, profileId);
  await prepareIntakeSourceDependencyHeaders(db, intakeId, options);
  const original = requiredFile(db, intakeId, true),
    version = intakeSourceVersion(db, intakeId),
    revision = clinicalReviewRevision(db),
    view = openIntakeCollectionEnvelope(db, original),
    intake = view.child(view.root(), 'intake')!;
  if (proposalId && !view.find('proposal', intake, proposalId))
    throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
  verifyIntakeOriginal(db, root, profileId, intakeId);
  const inputFile = proposalId ? requiredFile(db, proposalId) : original;
  if (inputFile.bytes > MAX_INTAKE_BYTES)
    throw new HttpError(413, 'CONVERSION_REQUIRED', 'Review a bounded JSONL conversion proposal');
  const path = profileOriginal(root, inputFile.path, profileId);
  verifyIntakeFileHash(path, inputFile);
  const bytes = readFileSync(path);
  if (
    bytes.length !== inputFile.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== inputFile.sha256
  )
    throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
  const validation = validateJSONL(bytes);
  if (!validation.valid)
    throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before clinical review');
  const assertCurrent = () => {
    options.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, intakeId);
    if (
      current.version !== version.version ||
      current.logicalBinding !== version.logicalBinding ||
      clinicalReviewRevision(db) !== revision
    )
      throw new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected clinical review');
  };
  // A small cache removes nearby duplicate evidence without retaining a set
  // proportional to the installation's accepted source history.
  const prepared = new Set<string>();
  for (const id of clinicalSourceScopeDependencyIds(db, original, validation.entries!)) {
    assertCurrent();
    if (prepared.has(id)) continue;
    await prepareIntakeSourceDependencyHeaders(db, id, { assertRunning: assertCurrent });
    const source = requiredFile(db, id, true),
      selected = openIntakeCollectionEnvelope(db, source),
      details = selected.child(selected.root(), 'intake')!,
      workflow = selected.child(details, 'workflow');
    if (workflow && selected.childCount(workflow, 'plans'))
      await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: assertCurrent });
    const mappingVersion = () =>
        workflowHash(
          activeMappingRules(
            db,
            intakeSourceMetadata(db, id).metadata?.sourceProviderId || source.provider_id,
          ),
        ),
      mapping = mappingVersion();
    const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
      mappingVersion: mapping,
      currentMappingVersion: mappingVersion,
      assertRunning: assertCurrent,
    });
    if (ready.state !== 'ready')
      throw new HttpError(
        409,
        'WORKFLOW_PREPARATION_REQUIRED',
        'Prepare complete selected clinical dependencies',
      );
    await prepareCollectionReviewMembership(db, source, { assertRunning: assertCurrent });
    await prepareReviewQuestionState(db, source, { assertRunning: assertCurrent });
    if (prepared.size >= 256) prepared.delete(prepared.values().next().value!);
    prepared.add(id);
  }
  assertCurrent();
  verifyIntakeFileHash(path, inputFile);
  await prepareDuplicateEvidenceIndex(db, { assertRunning: assertCurrent });
  await prepareOwnershipDecisionIndex(db, { assertRunning: assertCurrent });
}
/** Pending native migration/index state fails explicitly; this host never falls back to whole-workflow reads. */
export function prepareCollectionClinicalReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null = null,
  options: { metadataBytes?: number; groundingDependency?: (intakeId: string) => void } = {},
): CollectionClinicalReviewResult {
  assertIntakeOwner(db, profileId);
  const metadataBytes = options.metadataBytes ?? 256 * 1024;
  const file = requiredFile(db, intakeId, true);
  if (!hasIntakeCollectionEnvelope(db, file))
    throw new HttpError(
      409,
      'INTAKE_REVIEW_PENDING_MIGRATION',
      'Prepare this retained intake for selected clinical review',
    );
  verifyIntakeOriginal(db, root, profileId, intakeId);
  const initialVersion = intakeSourceVersion(db, intakeId),
    initialRevision = clinicalReviewRevision(db),
    initialGrounding = identityGroundingGeneration(db);
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, intakeId);
    if (
      current.logicalBinding !== initialVersion.logicalBinding ||
      current.version !== initialVersion.version ||
      clinicalReviewRevision(db) !== initialRevision ||
      identityGroundingGeneration(db) !== initialGrounding
    )
      throw new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected clinical review');
  };
  const issueScratch = createReviewIssueScratch(db);
  let retainedIssueScratch = false;
  try {
    const opened = new Map<string, ReturnType<typeof open>>();
    function open(original: ClinicalScopeOriginal) {
      options.groundingDependency?.(original.id);
      const retained = requiredFile(db, original.id, true);
      if (retained.sha256 !== original.sha256)
        throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original changed');
      if (!hasIntakeCollectionEnvelope(db, retained))
        throw new HttpError(
          409,
          'INTAKE_REVIEW_PENDING_MIGRATION',
          'Prepare the referenced retained original for selected clinical review',
        );
      const view = openIntakeCollectionEnvelope(db, retained),
        catalog = createReportSnapshotCatalog(db, retained);
      const cacheStatement = db.prepare(
        'SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS external, (SELECT schema_version FROM pragma_schema_version) AS schema',
      );
      cacheStatement.setReadBigInts(true);
      let cacheGeneration: object | undefined,
        cacheGrounding: object | undefined,
        cacheEpoch = 0;
      const readCacheState = () => {
        assertCurrent();
        view.address(view.root());
        if (db.isTransaction) return undefined;
        const generation = intakeCollectionCacheGeneration(db),
          grounding = identityGroundingGeneration(db);
        if (generation !== cacheGeneration || grounding !== cacheGrounding) {
          cacheGeneration = generation;
          cacheGrounding = grounding;
          cacheEpoch++;
        }
        const state = cacheStatement.get()!;
        return `${cacheEpoch}:${state.changes}:${state.external}:${state.schema}`;
      };
      type SelectedSourceVersion = {
        group: IntakeEnvelopeRecord;
        version: IntakeEnvelopeRecord;
        groupId: string;
        versionId: string;
      };
      const uniqueVersions = new Map<string, SelectedSourceVersion | null>();
      let uniqueVersionState: string | undefined;
      const uniqueVersion = (groupId: string, versionId: string): SelectedSourceVersion | null => {
        const state = readCacheState(),
          key = JSON.stringify([groupId, versionId]);
        if (state !== uniqueVersionState) {
          uniqueVersions.clear();
          uniqueVersionState = state;
        }
        if (state !== undefined && uniqueVersions.has(key)) {
          const cached = uniqueVersions.get(key)!;
          uniqueVersions.delete(key);
          uniqueVersions.set(key, cached);
          return cached;
        }
        withIntakeWork(db, 'warm', () => recordIntakeWork('collectionSuggestedSourceLookups'));
        const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow');
        let result: SelectedSourceVersion | null = null;
        if (workflow) {
          const group = view.find('reportGroup', workflow, groupId),
            lastGroup = view.find('reportGroup', workflow, groupId, { match: 'last' });
          if (group && lastGroup && view.address(group) === view.address(lastGroup)) {
            const version = view.find('version', group, versionId),
              lastVersion = view.find('version', group, versionId, { match: 'last' });
            if (
              version &&
              lastVersion &&
              view.address(version) === view.address(lastVersion) &&
              field<string>(view, version, 'format', metadataBytes) ===
                'health-intake-report-group-version-v2'
            )
              result = { group, version, groupId, versionId };
          }
        }
        if (state !== undefined) {
          if (uniqueVersions.size >= 32) uniqueVersions.delete(uniqueVersions.keys().next().value!);
          uniqueVersions.set(key, result);
        }
        return result;
      };
      const intake = view.child(view.root(), 'intake');
      if (!intake) throw Error('Missing selected intake');
      const workflow = view.child(intake, 'workflow');
      const read = <T>(record: IntakeEnvelopeRecord, name: string) =>
        field<T>(view, record, name, metadataBytes);
      const planEvidence =
        workflow && view.childCount(workflow, 'plans')
          ? readRetainedPlanEvidence(db, profileId, retained.id)
          : undefined;
      const member = (
        id: string,
      ): Pick<IntakePackageMember, 'locator' | 'sourceHash'> | undefined => {
        const selected = planEvidence?.firstMember(id);
        if (!selected) return undefined;
        if (selected.kind === 'inventory') return selected.member;
        return {
          locator: field<string>(selected.view, selected.record, 'locator', metadataBytes)!,
          sourceHash: field<string>(selected.view, selected.record, 'sourceHash', metadataBytes)!,
        };
      };
      const packageEvidence =
        retained.mime_type === 'application/zip' || !!planEvidence?.hasMembers;
      const issueSink = reviewIssueFactory(
        db,
        {
          sourceId: retained.id,
          generation: workflowHash([view.logical, initialRevision]),
          assertCurrent: () => {
            assertCurrent();
            view.address(view.root());
          },
        },
        issueScratch.db,
      );
      const scope = collectionWorkflowReviewScope({
        issueSink,
        bindIdentityWarnings: (record, warnings) =>
          bindReviewIdentityWarnings(issueSink, record, warnings),
        close: issueSink.dispose,
        questionState: openReviewQuestionState(db, retained, view),
        membershipIndex: readCollectionReviewMembership(db, retained, view),
        readDraft: (record) =>
          readNativeReviewDraft(
            view,
            record,
            createReportSnapshotCatalog(db, retained, { catalog: 'review.snapshots' }),
            metadataBytes,
            { db, source: retained },
          ),
        view,
        catalog,
        metadataBytes,
        readCacheState,
        identityReceiptWork: (metric) => withIntakeWork(db, 'warm', () => recordIntakeWork(metric)),
        packageEvidence,
        activeReceipt: (receipt) =>
          !db
            .prepare(
              "SELECT 1 FROM manual_batches WHERE title='Identity receipt supersession' AND json_extract(coverage_json,'$.supportOperationId')=? LIMIT 1",
            )
            .get(receipt.operationId),
        originalFingerprint: (group) =>
          identityOriginalFingerprintForMember(
            retained.id,
            retained.sha256,
            group.memberId,
            group.memberId ? member(group.memberId) : undefined,
          ),
        reportSource(record, selectedProposal) {
          if (!record.candidateId || !record.candidateVersionId) return undefined;
          const occurrence = scope.occurrence(
            record.candidateId,
            record.candidateVersionId,
            record.id,
            selectedProposal,
          );
          const source = resolveNativeReportSource(db, retained, {
            candidateId: record.candidateId,
            candidateVersionId: record.candidateVersionId,
            references: () => selectedReportGroups(record.reportGroups),
            occurrence,
          });
          if (source)
            validateProvider(source.confirmation.sourceProviderId, source.confirmation.source);
          return source?.confirmation.source;
        },
      });
      const grounding = selectedIdentityReviewGroundingLookups(
        db,
        scope.groundingBoundary(profileId, retained.id, retained.sha256),
      );
      const parent = read<string>(intake, 'parentSourceFileId'),
        locator = read<string>(intake, 'locator');
      const sourceScope = scope.clinicalSourceScope({
        profileId,
        hasParent: !!parent,
        hasMember: (id) => planEvidence?.hasMember(id) || false,
        childBoundary:
          typeof parent === 'string' && typeof locator === 'string'
            ? canonicalLiteral([retained.id, parent, locator])
            : null,
        subjectGrounded: grounding.subjectGrounded,
        questionGrounded: grounding.grounded,
      });
      return {
        retained,
        view,
        catalog,
        intake,
        workflow,
        read,
        scope,
        grounding,
        sourceScope,
        uniqueVersion,
      };
    }
    function validateProvider(id: string, name: string, materialize = false) {
      const existing = db.prepare('SELECT name FROM providers WHERE id=?').get(id);
      if (existing && existing.name !== name)
        throw new HttpError(
          409,
          'REPORT_SOURCE_SCOPE',
          'The retained report source no longer matches its provider identity',
        );
      if (!existing && materialize)
        db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run(id, name);
    }
    const sourceFor = (original: ClinicalScopeOriginal) => {
      let current = opened.get(original.id);
      if (!current) {
        current = open(original);
        if (opened.size >= 16) opened.delete(opened.keys().next().value!);
        opened.set(original.id, current);
      }
      return current;
    };
    const current = sourceFor(file),
      { view, intake, read, scope, grounding } = current;
    // V1 reviewedSource validates every retained provider binding, including off-page receipts.
    function validateAllProviders(materialize = false) {
      for (const confirmation of intakeReviewChildren(
        view,
        current.workflow,
        'reportSourceConfirmations',
      ))
        validateProvider(
          read<string>(confirmation, 'sourceProviderId')!,
          read<string>(confirmation, 'source')!,
          materialize,
        );
      for (const group of intakeReviewChildren(view, current.workflow, 'reportGroups')) {
        if (read(group, 'basis') !== 'report_anchor') continue;
        for (const version of intakeReviewChildren(view, group, 'versions')) {
          if (read(version, 'contextState') === 'mixed') continue;
          const context = read<IntakeReportContextReference>(version, 'context');
          if (context?.status !== 'linked' || !context.sourceSuggestion?.value.trim()) continue;
          const name =
            safeText(context.sourceSuggestion.value.trim(), 'source name', 200).trim() ||
            'Unknown source';
          const existing = db
            .prepare('SELECT id,name FROM providers WHERE name=? COLLATE NOCASE')
            .get(name);
          validateProvider(
            existing ? String(existing.id) : 'source-' + digest(name.toLowerCase()).slice(0, 24),
            existing ? String(existing.name) : name,
            materialize,
          );
        }
      }
    }
    validateAllProviders();
    const proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
    if (proposalId && !proposal)
      throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
    const inputFile = proposalId ? requiredFile(db, proposalId) : file;
    if (inputFile.bytes > MAX_INTAKE_BYTES)
      throw new HttpError(
        413,
        'CONVERSION_REQUIRED',
        'Original retained; review a bounded JSONL conversion proposal (at most 25 MiB)',
      );
    const bytes = readFileSync(profileOriginal(root, inputFile.path, profileId));
    if (
      bytes.length !== inputFile.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== inputFile.sha256
    )
      throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
    const validation = validateJSONL(bytes);
    if (!validation.valid)
      throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before clinical review');
    const metadata = read<IntakeMetadata>(intake, 'metadata');
    const reviewed = {
      ...file,
      provider_id: metadata?.sourceProviderId || file.provider_id,
      provider: metadata?.source || file.provider,
      reviewedMetadata: metadata || null,
    };
    const selfNote = getNote(db, 'person-note:self');
    const self = {
      noteId: 'person-note:self' as const,
      version: selfNote.version,
      knownNames: effectiveKnownNames(db, selfNote.id, selfNote.person),
      challengedNames: challengedKnownNames(db, selfNote.id),
      futureNameOwners: futureNameOwners(db),
      fullName:
        typeof selfNote.person.fullName === 'string' && selfNote.person.fullName.trim()
          ? selfNote.person.fullName.trim()
          : null,
      birthDate:
        typeof selfNote.person.birthDate === 'string' && selfNote.person.birthDate.trim()
          ? selfNote.person.birthDate.trim()
          : null,
    };
    const measured = proposalId ? proposalDependenciesCurrent(db, proposalId) : null;
    const parentRevision = initialVersion.sourcePin
      ? initialVersion.sourcePin.revisionId
      : (read<string | null>(intake, 'sourceTextRevisionId') ?? null);
    const parentDependency = initialVersion.sourcePin
      ? initialVersion.sourcePin.dependencyToken
      : (read<string | null>(intake, 'sourceTextDependencyToken') ?? null);
    const proposalRevision = proposal
      ? (read<string | null>(proposal, 'sourceTextRevisionId') ?? null)
      : null;
    const proposalDependency = proposal
      ? (read<string | null>(proposal, 'sourceTextDependencyToken') ?? null)
      : null;
    const requiresInterpretation =
      !!initialVersion.sourcePin?.requiresInterpretation ||
      !!read(intake, 'sourceTextRequiresInterpretation');
    const stale =
      (!!proposalId || requiresInterpretation) &&
      ((!proposalId && requiresInterpretation) ||
        !(
          measured ??
          (proposalRevision === parentRevision && proposalDependency === parentDependency)
        ));
    const reportSource = (
      record: Parameters<SelectedClinicalReportSource>[0],
      selectedProposal: string | null,
    ) => {
      if (!record.candidateId || !record.candidateVersionId) return null;
      const source = resolveNativeReportSource(db, file, {
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        references: () => selectedReportGroups(record.reportGroups),
        occurrence: { proposalId: selectedProposal, recordId: record.id },
      });
      if (source) {
        validateProvider(source.confirmation.sourceProviderId, source.confirmation.source);
        return source;
      }
      return suggestedSource(current, record);
    };
    const pairSource: SelectedClinicalReportSource = (record, selectedProposal) => {
      const source = reportSource(record, selectedProposal);
      return source
        ? {
            confirmationHash: source.confirmationHash,
            groupVersionId: source.coverage.groupVersionId,
            contextId: source.coverage.contextId,
            extensionId: source.coverage.extensionId || null,
            coverageEntryId: source.coverage.coverageEntryId || null,
          }
        : null;
    };
    function suggestedSource(
      current: ReturnType<typeof open>,
      record: Pick<IntakeReviewRecord, 'candidateId' | 'candidateVersionId' | 'reportGroups'>,
      providerId?: string,
    ):
      | (NonNullable<ReturnType<SelectedClinicalProjectionScope['reportSource']>> & {
          confirmationHash: string;
        })
      | null {
      const { view, read, workflow, catalog } = current;
      function* versions() {
        const references = selectedReportGroups(record.reportGroups)[Symbol.iterator]();
        let only: { groupId: string; groupVersionId: string } | undefined;
        try {
          const first = references.next();
          if (!first.done && references.next().done) only = first.value;
        } finally {
          references.return?.();
        }
        // New native records normally retain one report reference. Prove both
        // IDs are unique before bypassing reverse historical precedence.
        if (workflow && only) {
          const selected = current.uniqueVersion(only.groupId, only.groupVersionId);
          if (selected) {
            if (read(selected.group, 'basis') === 'report_anchor') yield selected;
            return;
          }
        }
        const groupCount = workflow ? view.childCount(workflow, 'reportGroups') : 0;
        for (let g = groupCount - 1; g >= 0; g--) {
          const group = view.childAt(workflow!, 'reportGroups', g)!;
          if (read(group, 'basis') !== 'report_anchor') continue;
          const groupId = read<string>(group, 'id')!;
          for (let v = view.childCount(group, 'versions') - 1; v >= 0; v--) {
            const version = view.childAt(group, 'versions', v)!;
            yield { group, version, groupId, versionId: read<string>(version, 'id')! };
          }
        }
      }
      for (const { version, groupId, versionId } of versions()) {
        if (
          !selectedReportGroups(record.reportGroups).some(
            (ref) => ref.groupId === groupId && ref.groupVersionId === versionId,
          ) ||
          read(version, 'contextState') === 'mixed'
        )
          continue;
        const context = read<IntakeReportContextReference>(version, 'context');
        if (context?.status !== 'linked' || !context.sourceSuggestion?.value.trim()) continue;
        const members =
          read(version, 'format') === 'health-intake-report-group-version-v2'
            ? openReportMemberSnapshot(
                catalog,
                read<IntakeReportMembersReference>(version, 'members')!,
              )
            : undefined;
        const selected = members
          ? members.member(record.candidateId!, record.candidateVersionId!)
          : undefined;
        const identities = function* () {
          if (members)
            for (let i = 0; i < members.reference.memberCount; i++) {
              const member = members.memberAt(i)!;
              yield {
                candidateId: member.candidateId,
                candidateVersionId: member.candidateVersionId,
              };
            }
          else
            for (const member of intakeReviewChildren(view, version, 'members'))
              yield {
                candidateId: read<string>(member, 'candidateId')!,
                candidateVersionId: read<string>(member, 'candidateVersionId')!,
              };
        };
        let present = !!selected;
        if (!members)
          for (const member of identities())
            if (
              member.candidateId === record.candidateId &&
              member.candidateVersionId === record.candidateVersionId
            ) {
              present = true;
              break;
            }
        if (!present) continue;
        const name =
          safeText(context.sourceSuggestion.value.trim(), 'source name', 200).trim() ||
          'Unknown source';
        const existing = db
          .prepare('SELECT id,name FROM providers WHERE name=? COLLATE NOCASE')
          .get(name);
        const provider = existing
          ? { id: String(existing.id), name: String(existing.name) }
          : { id: 'source-' + digest(name.toLowerCase()).slice(0, 24), name };
        const header = {
          at: '',
          basis: 'suggested_report_label' as const,
          contextId: context.contextId,
          groupId,
          groupVersionId: versionId,
          operationId:
            'default-report-source:' +
            workflowHash([
              groupId,
              versionId,
              context.contextId,
              context.sourceSuggestion.value.trim(),
            ]),
          source: provider.name,
          sourceProviderId: provider.id,
        };
        if (providerId !== undefined && provider.id !== providerId) continue;
        validateProvider(provider.id, provider.name);
        const hash = createHash('sha256');
        hash.update('{');
        let comma = false;
        for (const name of [...Object.keys(header), 'members'].sort()) {
          if (comma) hash.update(',');
          comma = true;
          hash.update(JSON.stringify(name) + ':');
          if (name === 'members') {
            hash.update('[');
            let comma = false;
            for (const member of identities()) {
              if (comma) hash.update(',');
              comma = true;
              hash.update(canonicalLiteral(member));
            }
            hash.update(']');
          } else hash.update(canonicalLiteral(header[name as keyof typeof header]));
        }
        hash.update('}');
        return {
          confirmationHash: hash.digest('hex'),
          confirmation: header,
          coverage: { groupVersionId: versionId, contextId: context.contextId },
        };
      }
      return null;
    }
    const result = createCollectionClinicalReviewSession({
      db,
      profileId,
      proposal: {
        file: reviewed,
        inputFile,
        entries: validation.entries!,
        proposalId,
        version: initialVersion.version,
        ...(proposalId && measured !== null
          ? { reviewTokenVersion: initialVersion.rawVersion }
          : {}),
      },
      scope,
      sourceScopeProblem: clinicalSourceScopeCheck(
        db,
        reviewed,
        validation.entries!,
        inputFile.id,
        (original) => sourceFor(original).sourceScope,
      ),
      self,
      identity: {
        profileId,
        people: selectedIdentityPeopleSnapshots(db),
        ...grounding,
        resolutionCurrent: (resolution, mapping) => issueResolutionCurrent(db, resolution, mapping),
        copiedManualSourceApplies: (receipt, selectedProposal) =>
          selectedProposal === proposalId &&
          copiedManualSourceRecordApplies(
            db,
            {
              profileId,
              intakeId,
              sourceHash: file.sha256,
              proposalId: selectedProposal,
              proposalHash: inputFile.sha256,
            },
            receipt,
          ),
      },
      ownership: scope.ownershipScope(grounding.originalBirthDateEvidence, initialVersion.version),
      reportSource: pairSource,
      projection: {
        materializeSourceProviders: () => validateAllProviders(true),
        sourceScope: (entries) =>
          clinicalSourceScopeCheck(
            db,
            reviewed,
            entries,
            inputFile.id,
            (original) => sourceFor(original).sourceScope,
          ),
        pairSource,
        reportSource,
        providerAuthorized(record, selectedProposal, providerId) {
          if (!record.candidateId || !record.candidateVersionId) return false;
          return (
            hasHistoricalReportSourceProvider(
              db,
              file,
              {
                candidateId: record.candidateId,
                candidateVersionId: record.candidateVersionId,
                references: () => selectedReportGroups(record.reportGroups),
                occurrence: { proposalId: selectedProposal, recordId: record.id },
              },
              providerId,
            ) || suggestedSource(current, record, providerId) !== null
          );
        },
      },
      validation: validationSummary(validation),
      assertProjectionEvidenceCurrent() {
        verifyIntakeOriginal(db, root, profileId, intakeId);
        verifyIntakeFileHash(profileOriginal(root, inputFile.path, profileId), {
          bytes: inputFile.bytes,
          sha256: inputFile.sha256,
        });
      },
      sourceText: {
        stale,
        revisionId: proposalId && measured !== null ? proposalRevision : parentRevision,
        dependencyToken: proposalId && measured !== null ? proposalDependency : parentDependency,
      },
      assertCurrent,
    });
    if (result.status === 'ready') {
      const close = result.session.close;
      result.session.close = () => {
        try {
          close();
        } finally {
          issueScratch.close();
        }
      };
      retainedIssueScratch = true;
    }
    return result;
  } catch (error) {
    if (error instanceof IntakeReviewFragmentRequired)
      return { status: 'fragment_required', reference: error.reference };
    throw error;
  } finally {
    if (!retainedIssueScratch) issueScratch.close();
  }
}

type ClinicalReadSession =
  import('./intake-review-collection-session.ts').CollectionClinicalReviewSession;
type ClinicalReadRequests = {
  page: {
    section: Parameters<ClinicalReadSession['page']>[0];
    options: Parameters<ClinicalReadSession['page']>[1];
  };
  fragment: {
    reference: Parameters<ClinicalReadSession['fragment']>[0];
    offset: number;
    bytes: number;
  };
  record: { recordId: string; candidateVersionId?: string; bytes?: number };
};
type ClinicalReadValues = {
  page: ReturnType<ClinicalReadSession['page']>;
  fragment: ReturnType<ClinicalReadSession['fragment']>;
  record: ReturnType<ClinicalReadSession['selectedRecord']>;
};
type ClinicalReadRequest = {
  [K in keyof ClinicalReadRequests]: { kind: K } & ClinicalReadRequests[K];
}[keyof ClinicalReadRequests];
type ClinicalReadResult<T> =
  | { status: 'ready'; value: T }
  | Extract<CollectionClinicalReviewResult, { status: 'fragment_required' }>;
export function readPreparedCollectionClinicalReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  input: Extract<ClinicalReadRequest, { kind: 'page' }>,
): Promise<ClinicalReadResult<ClinicalReadValues['page']>>;
export function readPreparedCollectionClinicalReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  input: Extract<ClinicalReadRequest, { kind: 'fragment' }>,
): Promise<ClinicalReadResult<ClinicalReadValues['fragment']>>;
export function readPreparedCollectionClinicalReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  input: Extract<ClinicalReadRequest, { kind: 'record' }>,
): Promise<ClinicalReadResult<ClinicalReadValues['record']>>;
/** Read-only transport access: one exact, completed proposal review may serve successive windows. */
export async function readPreparedCollectionClinicalReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  input: ClinicalReadRequest,
): Promise<ClinicalReadResult<ClinicalReadValues[keyof ClinicalReadValues]>> {
  const attempt = beginPreparedClinicalReviewRead(db);
  let owned: ClinicalReadSession | undefined;
  try {
    if (db.isTransaction) discardPreparedClinicalReviewRead(db);
    assertIntakeOwner(db, profileId);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, intakeId, proposalId);
    const key = canonicalLiteral([root, profileId, intakeId, proposalId]),
      stamp = reviewReadStamp(db),
      requestRevision = revision(db),
      sourcePin = canonicalLiteral(intakeSourceVersion(db, intakeId));
    let cached = preparedClinicalReviewRead(db);
    if (
      cached &&
      (stamp === undefined ||
        cached.key !== key ||
        cached.stamp !== stamp ||
        cached.sourcePin !== sourcePin ||
        cached.requestRevision !== requestRevision)
    ) {
      if (isPreparedClinicalReviewReadCurrent(db, attempt)) discardPreparedClinicalReviewRead(db);
      cached = undefined;
    }
    verifyIntakeOriginal(db, root, profileId, intakeId);
    if (proposalId) {
      const file = requiredFile(db, proposalId, false);
      verifyIntakeFileHash(profileOriginal(root, file.path, profileId), file);
    }
    if (!cached) {
      withIntakeWork(db, 'warm', () => recordIntakeWork('collectionPublicClinicalReviews'));
      const prepared = prepareCollectionClinicalReview(db, root, profileId, intakeId, proposalId);
      if (prepared.status !== 'ready') return prepared;
      owned = prepared.session;
    }
    const session = cached?.session || owned!;
    const output =
      input.kind === 'page'
        ? session.page(input.section, input.options)
        : input.kind === 'fragment'
          ? session.fragment(input.reference, input.offset, input.bytes)
          : session.selectedRecord(input.recordId, input.candidateVersionId, input.bytes);
    // Detach only emitted bounded transport; no caller gets the private session or record aliases.
    const value = JSON.parse(JSON.stringify(output), (_key, value, context) =>
      typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
        ? JSON.rawJSON(context.source)
        : value,
    ) as ClinicalReadValues[keyof ClinicalReadValues];
    assertIntakeOwner(db, profileId);
    if (
      requestRevision !== revision(db) ||
      sourcePin !== canonicalLiteral(intakeSourceVersion(db, intakeId)) ||
      (stamp !== undefined && stamp !== reviewReadStamp(db))
    )
      throw new HttpError(
        409,
        'INTAKE_REVIEW_CHANGED',
        'Review changed while reading; refresh this review',
      );
    if (stamp !== undefined && !cached && isPreparedClinicalReviewReadCurrent(db, attempt)) {
      retainPreparedClinicalReviewRead(db, { key, stamp, sourcePin, requestRevision, session });
      owned = undefined;
    }
    return { status: 'ready', value };
  } catch (error) {
    if (isPreparedClinicalReviewReadCurrent(db, attempt)) discardPreparedClinicalReviewRead(db);
    throw error;
  } finally {
    owned?.close();
  }
}
