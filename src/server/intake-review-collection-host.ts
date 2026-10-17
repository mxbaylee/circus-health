import { createReviewQuestionHydrationCache } from './intake-review-question-hydration.ts';
import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { indexedReviewQuestions } from './intake-review-question-index.ts';
import { finishClinicalReviewWork, runClinicalReviewWork } from './clinical-review-work.ts';
import { reviewPreparationStamp } from './clinical-review-maintenance.ts';
import { revision, managedDatabaseMethodEpoch } from './database.ts';
import {
  reviewReadStamp,
  preparedClinicalReviewRead,
  beginPreparedClinicalReviewRead,
  isPreparedClinicalReviewReadCurrent,
  discardPreparedClinicalReviewRead,
  retainPreparedClinicalReviewRead,
  leasePreparedClinicalReviewRead,
  type PreparedClinicalReviewRead,
  type PreparedClinicalReviewRoute,
} from './intake-clinical-review-read-cache.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { reviewIssueFactory, createReviewIssueScratch } from './intake-review-issue-state.ts';
/** Native clinical host orchestration. Authorization and verified proposal bytes precede all policy reads. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { assertIntakeOwner } from './intake.ts';
import { HttpError, clinicalReviewRevision, safeText } from './database.ts';
import { getNote } from './notes.ts';
import {
  bindReviewIdentityWarnings,
  bindReviewIdentityWarningsWork,
} from './intake-review-identity-warnings.ts';
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
import { verifyIntakeFileHashWork, intakeFileIdentity } from './intake-files.ts';
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
  resolveNativeReportSourceWork,
  hasHistoricalReportSourceProvider,
} from './intake-report-source-resolution.ts';
import { workflowHash } from './intake-workflow.ts';
import { readNativeReviewDraft, readNativeReviewDraftWork } from './intake-review-draft-state.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { activeMappingRules } from './clinical-import.ts';
import { prepareDuplicateEvidenceIndex } from './duplicate-evidence-index.ts';
import { prepareOwnershipDecisionIndex } from './ownership-decision-index.ts';
import {
  clinicalSourceScopeCheck,
  prepareClinicalSourceScopeCheckWork,
  clinicalSourceScopeDependencyIdsWork,
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
  createCollectionClinicalReviewSessionWork,
  collectionClinicalProjectionContextAsync,
  prepareCollectionClinicalOwnershipReview,
  disposeCollectionClinicalOwnershipReview,
  type CollectionClinicalOwnershipPreparationResult,
  deferCollectionClinicalAcceptanceReview,
  disposeCollectionClinicalAcceptanceReview,
  type CollectionClinicalAcceptancePreparationResult,
  type CollectionClinicalReviewResult,
  type CollectionClinicalProjectionContext,
} from './intake-review-collection-session.ts';
import {
  deferCorrectionSupportReview,
  disposeCorrectionSupportReview,
  type CorrectionSupportReviewPreparationResult,
} from './correction-support-review-preparation.ts';
import {
  captureManagedPhysicalEpoch,
  managedPhysicalEpochCurrent,
} from './clinical-review-physical-epoch.ts';
import { openClinicalPhysicalVerifier } from './clinical-review-physical-worker.ts';
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
  return runExclusiveClinicalOperation(
    db,
    async () => {
      assertIntakeOwner(db, profileId);
      await prepareIntakeSourceDependencyHeaders(db, intakeId, {
        ...options,
        nativeSchema: 'selected',
      });
      const original = requiredFile(db, intakeId, true),
        version = intakeSourceVersion(db, intakeId),
        revision = clinicalReviewRevision(db),
        view = openIntakeCollectionEnvelope(db, original),
        intake = view.child(view.root(), 'intake')!;
      const assertCurrent = () => {
        options.assertRunning?.();
        assertIntakeOwner(db, profileId);
        const current = intakeSourceVersion(db, intakeId);
        if (
          current.version !== version.version ||
          current.logicalBinding !== version.logicalBinding ||
          clinicalReviewRevision(db) !== revision
        )
          throw new HttpError(
            409,
            'INTAKE_REVIEW_CHANGED',
            'Refresh this selected clinical review',
          );
      };
      const verify = async (file: File) =>
        runClinicalReviewWork(
          verifyIntakeFileHashWork(profileOriginal(root, file.path, profileId), file),
          {
            capture() {
              assertCurrent();
              const stamp = reviewPreparationStamp(db);
              if (stamp === undefined)
                throw new HttpError(
                  409,
                  'INTAKE_REVIEW_CHANGED',
                  'Clinical verification cannot cross a transaction',
                );
              return () => {
                assertCurrent();
                if (reviewPreparationStamp(db) !== stamp)
                  throw new HttpError(
                    409,
                    'INTAKE_REVIEW_CHANGED',
                    'Review changed while verifying its original',
                  );
              };
            },
          },
        );
      if (proposalId && !view.find('proposal', intake, proposalId))
        throw new HttpError(404, 'NOT_FOUND', 'Proposal does not belong to this delivery');
      await verify(original);
      const inputFile = proposalId ? requiredFile(db, proposalId) : original;
      if (inputFile.bytes > MAX_INTAKE_BYTES)
        throw new HttpError(
          413,
          'CONVERSION_REQUIRED',
          'Review a bounded JSONL conversion proposal',
        );
      const path = profileOriginal(root, inputFile.path, profileId);
      await verify(inputFile);
      const bytes = readFileSync(path);
      if (
        bytes.length !== inputFile.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== inputFile.sha256
      )
        throw new HttpError(409, 'SOURCE_CHANGED', 'Review source changed');
      const validation = validateJSONL(bytes);
      if (!validation.valid)
        throw new HttpError(400, 'INVALID_JSONL', 'Convert the original before clinical review');
      await prepareOwnershipDecisionIndex(db, { assertRunning: assertCurrent });
      // A small cache removes nearby duplicate evidence without retaining a set
      // proportional to the installation's accepted source history.
      const prepared = new Set<string>();
      let dependencyInspections = 0;
      for (const id of clinicalSourceScopeDependencyIdsWork(db, original, validation.entries!)) {
        if (++dependencyInspections % 16 === 0) {
          await runClinicalReviewWork(
            (function* () {
              for (let n = 0; n < 16; n++) yield;
            })(),
            {
              capture() {
                assertCurrent();
                const stamp = reviewPreparationStamp(db);
                if (stamp === undefined)
                  throw Error('Clinical dependencies cannot cross a transaction');
                return () => {
                  assertCurrent();
                  if (reviewPreparationStamp(db) !== stamp)
                    throw new HttpError(
                      409,
                      'INTAKE_REVIEW_CHANGED',
                      'Review changed while preparing dependencies',
                    );
                };
              },
            },
          );
        }
        if (id === undefined) continue;
        assertCurrent();
        if (prepared.has(id)) continue;
        await prepareIntakeSourceDependencyHeaders(db, id, {
          assertRunning: assertCurrent,
          nativeSchema: 'selected',
        });
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
      await verify(inputFile);
      await prepareDuplicateEvidenceIndex(db, { assertRunning: assertCurrent });
    },
    { operation: currentClinicalOperation(db) },
  );
}
/** Pending native migration/index state fails explicitly; this host never falls back to whole-workflow reads. */
export function prepareCollectionClinicalReview(
  ...input: Parameters<typeof prepareCollectionClinicalReviewWork>
): CollectionClinicalReviewResult {
  return finishClinicalReviewWork(
    prepareCollectionClinicalReviewWork(
      input[0],
      input[1],
      input[2],
      input[3],
      input[4],
      input[5],
      false,
    ),
  );
}
export async function prepareCollectionClinicalReviewAsync(
  ...input: Parameters<typeof prepareCollectionClinicalReviewWork>
): Promise<CollectionClinicalReviewResult> {
  return prepareCollectionClinicalReviewAsyncResult(
    input,
    async (result) => {
      if (result.status === 'ready')
        await collectionClinicalProjectionContextAsync(
          result.session,
          input[5]?.signal,
          input[5]?.assertRunning,
        );
      return result;
    },
    (value) => {
      if (value.status === 'ready') value.session.close();
    },
  );
}

/** Queue preparation verifies its selected projection after the queue's guards,
 * immediately before returning a consumable session. */
export async function prepareCollectionClinicalReviewForQueueAsync(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  options: Parameters<typeof prepareCollectionClinicalReviewWork>[5],
  beforeVerification: () => void,
): Promise<{
  result: CollectionClinicalReviewResult;
  projection?: CollectionClinicalProjectionContext;
}> {
  return prepareCollectionClinicalReviewAsyncResult(
    [db, root, profileId, intakeId, proposalId, options],
    async (result) => {
      beforeVerification();
      const projection =
        result.status === 'ready'
          ? await collectionClinicalProjectionContextAsync(
              result.session,
              options?.signal,
              options?.assertRunning,
            )
          : undefined;
      return { result, projection };
    },
    (value) => {
      if (value.result.status === 'ready') value.result.session.close();
    },
  );
}

/** Private ownership construction forwards this already-verified context once;
 * its complete artifact union still closes before a preview becomes visible. */
export async function prepareCollectionClinicalReviewForOwnershipAsync(
  ...input: Parameters<typeof prepareCollectionClinicalReviewWork>
): Promise<CollectionClinicalOwnershipPreparationResult> {
  return prepareCollectionClinicalReviewAsyncResult(
    input,
    async (result) => {
      if (result.status !== 'ready') return result;
      return prepareCollectionClinicalOwnershipReview(
        result,
        input[5]?.signal,
        input[5]?.assertRunning,
      );
    },
    (result) => {
      if (result.status === 'prepared')
        disposeCollectionClinicalOwnershipReview(result.preparation);
    },
  );
}

/** Acceptance verifies the original consumed-artifact union before derived preparation. */
export async function prepareCollectionClinicalReviewForAcceptanceAsync(
  ...input: Parameters<typeof prepareCollectionClinicalReview>
): Promise<CollectionClinicalAcceptancePreparationResult> {
  return prepareCollectionClinicalReviewAsyncResult(
    input,
    async (result) =>
      deferCollectionClinicalAcceptanceReview(result, input[5]?.signal, input[5]?.assertRunning),
    (result) => {
      if (result.status === 'prepared')
        disposeCollectionClinicalAcceptanceReview(result.preparation);
    },
  );
}
/** Correction support consumes this opaque preparation after its intervening caller checks. */
export async function prepareCollectionClinicalReviewForCorrectionSupportAsync(
  ...input: Parameters<typeof prepareCollectionClinicalReviewWork>
): Promise<CorrectionSupportReviewPreparationResult> {
  return prepareCollectionClinicalReviewAsyncResult(
    input,
    async (result) =>
      deferCorrectionSupportReview(result, input[5]?.signal, input[5]?.assertRunning),
    (value) => {
      if (value.status === 'prepared') disposeCorrectionSupportReview(value.preparation);
    },
  );
}

async function prepareCollectionClinicalReviewAsyncResult<T>(
  input: Parameters<typeof prepareCollectionClinicalReviewWork>,
  complete: (result: CollectionClinicalReviewResult) => Promise<T>,
  discard: (value: T) => void,
): Promise<T> {
  return runExclusiveClinicalOperation(
    input[0],
    async () => {
      const [db, , profileId] = input;
      if (db.isTransaction) throw Error('Cooperative clinical review cannot hold a transaction');
      input[5]?.assertRunning?.();
      const result = await runClinicalReviewWork(
        prepareCollectionClinicalReviewWork(
          input[0],
          input[1],
          input[2],
          input[3],
          input[4],
          input[5],
          true,
        ),
        {
          signal: input[5]?.signal,
          capture() {
            input[5]?.assertRunning?.();
            assertIntakeOwner(db, profileId);
            const stamp = reviewPreparationStamp(db);
            if (stamp === undefined) throw Error('Clinical review authority is unavailable');
            return () => {
              input[5]?.assertRunning?.();
              assertIntakeOwner(db, profileId);
              if (reviewPreparationStamp(db) !== stamp)
                throw new HttpError(
                  409,
                  'INTAKE_REVIEW_CHANGED',
                  'Review changed while preparing; refresh this review',
                );
            };
          },
        },
      );
      try {
        input[5]?.assertRunning?.();
        return await complete(result);
      } catch (error) {
        if (result.status === 'ready') result.session.close();
        throw error;
      }
    },
    {
      operation: currentClinicalOperation(input[0]),
      onDiscardResult: discard,
    },
  );
}
function* prepareCollectionClinicalReviewWork(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null = null,
  options: {
    metadataBytes?: number;
    groundingDependency?: (intakeId: string) => void;
    signal?: AbortSignal;
    assertRunning?: () => void;
  } = {},
  cooperativePhysical = false,
): Generator<void, CollectionClinicalReviewResult, void> {
  assertIntakeOwner(db, profileId);
  withIntakeWork(db, 'warm', () => recordIntakeWork('collectionClinicalReviewPreparations'));
  const metadataBytes = options.metadataBytes ?? 256 * 1024;
  const file = requiredFile(db, intakeId, true);
  if (!hasIntakeCollectionEnvelope(db, file))
    throw new HttpError(
      409,
      'INTAKE_REVIEW_PENDING_MIGRATION',
      'Prepare this retained intake for selected clinical review',
    );
  yield* verifyIntakeFileHashWork(profileOriginal(root, file.path, profileId), file);
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
  const questionHydrations = (() => {
    try {
      return createReviewQuestionHydrationCache(db, issueScratch.db);
    } catch (error) {
      issueScratch.close();
      throw error;
    }
  })();
  let retainedIssueScratch = false;
  let preparingCooperatively = cooperativePhysical;
  try {
    issueScratch.db.exec(
      'CREATE TABLE main.consumed_source_files (id TEXT PRIMARY KEY, path TEXT, identity TEXT, seal TEXT)',
    );
    const physicalSealKey = randomBytes(32);
    const physicalSeal = (id: string, path: string, identity: string) =>
      createHmac('sha256', physicalSealKey)
        .update(JSON.stringify([id, path, identity]))
        .digest('hex');
    const physicallySealed = (
      row: Record<string, unknown>,
    ): row is { id: string; path: string; identity: string; seal: string } =>
      typeof row.id === 'string' &&
      typeof row.path === 'string' &&
      typeof row.identity === 'string' &&
      typeof row.seal === 'string' &&
      row.seal === physicalSeal(row.id, row.path, row.identity);
    const retainConsumedFile = issueScratch.db.prepare(
      'INSERT OR IGNORE INTO main.consumed_source_files (id) VALUES (?)',
    );
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
            if (version && lastVersion && view.address(version) === view.address(lastVersion))
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
        policySql: issueScratch.db,
        sourceScopePrefixProof() {
          if (db.isTransaction) return undefined;
          options.assertRunning?.();
          assertCurrent();
          const before = reviewReadStamp(db);
          if (before === undefined) throw Error('Clinical source scope authority unavailable');
          view.address(view.root());
          if (!preparingCooperatively) assertPhysicalEvidenceCurrent();
          options.assertRunning?.();
          assertCurrent();
          const after = reviewReadStamp(db);
          if (after !== before)
            throw Error('Clinical source scope authority changed during verification');
          return after;
        },
        sourceScopePrefixWork: (metric, count) =>
          withIntakeWork(db, 'warm', () => recordIntakeWork(metric, count)),
        issueSink,
        bindIdentityWarnings: (record, warnings) =>
          bindReviewIdentityWarnings(issueSink, record, warnings),
        bindIdentityWarningsWork: (record, warnings) =>
          bindReviewIdentityWarningsWork(issueSink, record, warnings),
        close: issueSink.dispose,
        questionState: openReviewQuestionState(db, retained, view, {
          cache: questionHydrations,
          assertCurrent: () => {
            assertCurrent();
            view.address(view.root());
          },
        }),
        questionIndex: indexedReviewQuestions(db, retained, view, issueScratch.db, metadataBytes),
        membershipIndex: readCollectionReviewMembership(db, retained, view),
        readDraftWork: (record) =>
          readNativeReviewDraftWork(
            view,
            record,
            createReportSnapshotCatalog(db, retained, { catalog: 'review.snapshots' }),
            metadataBytes,
            { db, source: retained },
          ),
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
        readProofState: () => {
          assertCurrent();
          view.address(view.root());
          return reviewPreparationStamp(db);
        },
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
          return finishClinicalReviewWork(scope.reportSourceWork!(record, selectedProposal));
        },
        *reportSourceWork(record, selectedProposal) {
          if (!record.candidateId || !record.candidateVersionId) return undefined;
          const occurrence = yield* scope.occurrenceWork(
            record.candidateId,
            record.candidateVersionId,
            record.id,
            selectedProposal,
          );
          const source = yield* resolveNativeReportSourceWork(db, retained, {
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
        subjectGroundedWork: grounding.subjectGroundedWork,
        questionGroundedWork: grounding.groundedWork,
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
        readCacheState,
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
      retainConsumedFile.run(original.id);
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
    function* validateAllProviders(materialize = false): Generator<void, void, void> {
      for (const confirmation of intakeReviewChildren(
        view,
        current.workflow,
        'reportSourceConfirmations',
      )) {
        yield;
        validateProvider(
          read<string>(confirmation, 'sourceProviderId')!,
          read<string>(confirmation, 'source')!,
          materialize,
        );
      }
      for (const group of intakeReviewChildren(view, current.workflow, 'reportGroups')) {
        yield;
        if (read(group, 'basis') !== 'report_anchor') continue;
        for (const version of intakeReviewChildren(view, group, 'versions')) {
          yield;
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
    yield* validateAllProviders();
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
    const rememberPhysical = issueScratch.db.prepare(
      'INSERT OR REPLACE INTO main.consumed_source_files VALUES (?, ?, ?, ?)',
    );
    for (const id of clinicalSourceScopeDependencyIdsWork(db, file, validation.entries!)) {
      yield;
      if (id === undefined) continue;
      const dependency = requiredFile(db, id, true),
        path = profileOriginal(root, dependency.path, profileId);
      const identity = yield* verifyIntakeFileHashWork(path, dependency);
      rememberPhysical.run(id, path, identity, physicalSeal(id, path, identity));
      yield;
    }
    const proposalPath = profileOriginal(root, inputFile.path, profileId);
    const proposalIdentity = yield* verifyIntakeFileHashWork(proposalPath, inputFile);
    rememberPhysical.run(
      inputFile.id,
      proposalPath,
      proposalIdentity,
      physicalSeal(inputFile.id, proposalPath, proposalIdentity),
    );
    const originalPhysicalCount = Number(
      issueScratch.db.prepare('SELECT count(*) count FROM main.consumed_source_files').get()!.count,
    );
    let projectionConsumptionScope: object | undefined;
    const assertPhysicalEvidenceCurrent = () => {
      let seen = 0;
      for (const row of issueScratch.db
        .prepare('SELECT id,path,identity,seal FROM main.consumed_source_files ORDER BY id')
        .iterate()) {
        if (!physicallySealed(row) || intakeFileIdentity(row.path) !== row.identity)
          throw new HttpError(
            409,
            'SOURCE_CHANGED',
            'Retained clinical evidence changed; refresh this review',
          );
        seen++;
      }
      if (seen !== originalPhysicalCount)
        throw new HttpError(
          409,
          'SOURCE_CHANGED',
          'Retained clinical evidence changed; refresh this review',
        );
    };
    let physicalSweeps = 0;
    const physicalChanged = () =>
      new HttpError(
        409,
        'SOURCE_CHANGED',
        'Retained clinical evidence changed; refresh this review',
      );
    type PhysicalVerifier = Awaited<ReturnType<typeof openClinicalPhysicalVerifier>>;
    let physicalVerifier:
      { controller: AbortController; opening: Promise<PhysicalVerifier> } | undefined;
    let physicalRevocation: Promise<void> | undefined;
    let physicalVerifierClosed = false;
    let physicalSweepActive = false;
    const revokePhysicalVerifier = (reason?: unknown): Promise<void> => {
      const retained = physicalVerifier;
      physicalVerifier = undefined;
      if (!retained) return physicalRevocation ?? Promise.resolve();
      retained.controller.abort(reason ?? physicalChanged());
      let draining!: Promise<void>;
      draining = retained.opening
        .then(
          (verifier) => verifier.abort(),
          () => {},
        )
        .finally(() => {
          if (physicalRevocation === draining) physicalRevocation = undefined;
        });
      physicalRevocation = draining;
      return draining;
    };
    const acquirePhysicalVerifier = async (): Promise<PhysicalVerifier> => {
      if (physicalRevocation) await physicalRevocation;
      if (physicalVerifierClosed) throw physicalChanged();
      let retained = physicalVerifier;
      if (!retained) {
        const controller = new AbortController();
        retained = { controller, opening: openClinicalPhysicalVerifier(controller.signal) };
        physicalVerifier = retained;
        // Owner close can revoke during module startup before the sweep awaits readiness.
        void retained.opening.catch(() => {});
      }
      const verifier = await retained.opening;
      if (physicalVerifierClosed || physicalVerifier !== retained) throw physicalChanged();
      return verifier;
    };
    const verifyPhysicalEvidenceCooperatively = async (
      signal?: AbortSignal,
      assertRunning?: () => void,
    ) => {
      signal?.throwIfAborted();
      if (physicalVerifierClosed || physicalSweepActive) throw physicalChanged();
      physicalSweepActive = true;
      const onAbort = () => {
        void revokePhysicalVerifier(signal?.reason).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      let complete = false;
      try {
        withIntakeWork(db, 'warm', () => {
          recordIntakeWork('collectionProjectionPhysicalSweeps');
          if (physicalSweeps++) recordIntakeWork('collectionProjectionPhysicalRepeatSweeps');
        });
        const epoch = captureManagedPhysicalEpoch();
        const methodEpoch = managedDatabaseMethodEpoch(db);
        if (!epoch || !methodEpoch || db.isTransaction || !issueScratch.db.isOpen)
          throw physicalChanged();
        const mainStamp = reviewReadStamp(db);
        if (mainStamp === undefined) throw physicalChanged();
        const scratchStamp = () => {
          if (!issueScratch.db.isOpen) throw physicalChanged();
          const row = issueScratch.db
            .prepare(
              'SELECT total_changes() changes, (SELECT data_version FROM pragma_data_version) external, (SELECT schema_version FROM pragma_schema_version) schema',
            )
            .get()!;
          return `${row.changes}:${row.external}:${row.schema}`;
        };
        const pinnedScratch = scratchStamp();
        const expectedCount = originalPhysicalCount;
        const current = () => {
          signal?.throwIfAborted();
          if (physicalVerifierClosed) throw physicalChanged();
          assertRunning?.();
          assertCurrent();
          if (
            !managedPhysicalEpochCurrent(epoch) ||
            managedDatabaseMethodEpoch(db) !== methodEpoch ||
            reviewReadStamp(db) !== mainStamp ||
            scratchStamp() !== pinnedScratch
          )
            throw physicalChanged();
        };
        current();
        try {
          const verifier = await acquirePhysicalVerifier();
          current();
          let seen = 0;
          let cursor: string | undefined;
          for (;;) {
            const rows =
              cursor === undefined
                ? issueScratch.db
                    .prepare(
                      'SELECT id,path,identity,seal FROM main.consumed_source_files ORDER BY id LIMIT 64',
                    )
                    .all()
                : issueScratch.db
                    .prepare(
                      'SELECT id,path,identity,seal FROM main.consumed_source_files WHERE id>? ORDER BY id LIMIT 64',
                    )
                    .all(cursor);
            if (!rows.length) break;
            const page: { kind: 'identity'; path: string; expectedIdentity: string }[] = [];
            for (const row of rows) {
              if (!physicallySealed(row)) throw physicalChanged();
              page.push({ kind: 'identity', path: row.path, expectedIdentity: row.identity });
            }
            cursor = String(rows[rows.length - 1]!.id);
            seen += page.length;
            if (seen > expectedCount) throw physicalChanged();
            current();
            await verifier.verifyPage(page);
            withIntakeWork(db, 'warm', () =>
              recordIntakeWork('collectionProjectionPhysicalItems', page.length),
            );
            current();
          }
          if (seen !== expectedCount) throw physicalChanged();
          verifier.idle();
          current();
          complete = true;
        } catch (error) {
          if (signal?.aborted) throw error;
          throw physicalChanged();
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (!complete) await revokePhysicalVerifier().catch(() => {});
        physicalSweepActive = false;
      }
    };
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
    const reportSource = (...input: Parameters<typeof reportSourceWork>) =>
      finishClinicalReviewWork(reportSourceWork(...input));
    function* reportSourceWork(
      record: Parameters<SelectedClinicalReportSource>[0],
      selectedProposal: string | null,
    ) {
      if (!record.candidateId || !record.candidateVersionId) return null;
      const source = yield* resolveNativeReportSourceWork(db, file, {
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        references: () => selectedReportGroups(record.reportGroups),
        occurrence: { proposalId: selectedProposal, recordId: record.id },
      });
      if (source) {
        validateProvider(source.confirmation.sourceProviderId, source.confirmation.source);
        return source;
      }
      return yield* suggestedSourceWork(current, record);
    }
    const pairSource: SelectedClinicalReportSource = (record, selectedProposal) =>
      finishClinicalReviewWork(pairSourceWork(record, selectedProposal));
    pairSource.work = pairSourceWork;
    function* pairSourceWork(
      record: Parameters<SelectedClinicalReportSource>[0],
      selectedProposal: string | null,
    ): Generator<void, ReturnType<SelectedClinicalReportSource>, void> {
      const source = yield* reportSourceWork(record, selectedProposal);
      return source
        ? {
            confirmationHash: source.confirmationHash,
            groupVersionId: source.coverage.groupVersionId,
            contextId: source.coverage.contextId,
            extensionId: source.coverage.extensionId || null,
            coverageEntryId: source.coverage.coverageEntryId || null,
          }
        : null;
    }
    // Only completed canonical hashes are retained, within this owned session.
    const suggestedHashes = new Map<string, string>();
    let suggestedHashBytes = 0;
    let suggestedHashState: string | undefined;
    function suggestedSource(...input: Parameters<typeof suggestedSourceWork>) {
      return finishClinicalReviewWork(suggestedSourceWork(...input));
    }
    function* suggestedSourceWork(
      current: ReturnType<typeof open>,
      record: Pick<IntakeReviewRecord, 'candidateId' | 'candidateVersionId' | 'reportGroups'>,
      providerId?: string,
    ): Generator<
      void,
      | (NonNullable<ReturnType<SelectedClinicalProjectionScope['reportSource']>> & {
          confirmationHash: string;
        })
      | null,
      void
    > {
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
          yield undefined;
          const group = view.childAt(workflow!, 'reportGroups', g)!;
          if (read(group, 'basis') !== 'report_anchor') continue;
          const groupId = read<string>(group, 'id')!;
          for (let v = view.childCount(group, 'versions') - 1; v >= 0; v--) {
            const version = view.childAt(group, 'versions', v)!;
            yield { group, version, groupId, versionId: read<string>(version, 'id')! };
          }
        }
      }
      for (const selectedVersion of versions()) {
        yield;
        if (!selectedVersion) continue;
        const { group, version, groupId, versionId } = selectedVersion;
        let referenced = false;
        for (const ref of selectedReportGroups(record.reportGroups)) {
          yield;
          if (ref.groupId === groupId && ref.groupVersionId === versionId) {
            referenced = true;
            break;
          }
        }
        if (!referenced || read(version, 'contextState') === 'mixed') continue;
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
          for (const member of identities()) {
            yield;
            if (
              member.candidateId === record.candidateId &&
              member.candidateVersionId === record.candidateVersionId
            ) {
              present = true;
              break;
            }
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
        const state = current.readCacheState();
        if (state !== suggestedHashState || state === undefined) {
          suggestedHashes.clear();
          suggestedHashBytes = 0;
          suggestedHashState = state;
        }
        const key = JSON.stringify([
          current.retained.id,
          view.logical,
          view.address(group),
          view.address(version),
          header,
        ]);
        let confirmationHash = state === undefined ? undefined : suggestedHashes.get(key);
        if (confirmationHash !== undefined) {
          suggestedHashes.delete(key);
          suggestedHashes.set(key, confirmationHash);
          withIntakeWork(db, 'warm', () => recordIntakeWork('collectionSuggestedSourceHashHits'));
        } else {
          withIntakeWork(db, 'warm', () => recordIntakeWork('collectionSuggestedSourceHashes'));
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
                yield;
                withIntakeWork(db, 'warm', () =>
                  recordIntakeWork('collectionSuggestedSourceMemberHashes'),
                );
                if (comma) hash.update(',');
                comma = true;
                hash.update(canonicalLiteral(member));
              }
              hash.update(']');
            } else hash.update(canonicalLiteral(header[name as keyof typeof header]));
          }
          hash.update('}');
          confirmationHash = hash.digest('hex');
          const bytes = Buffer.byteLength(key) + Buffer.byteLength(confirmationHash);
          if (state !== undefined && state === current.readCacheState() && bytes <= 256 * 1024) {
            while (suggestedHashes.size >= 32 || suggestedHashBytes + bytes > 256 * 1024) {
              const oldest = suggestedHashes.keys().next().value!;
              suggestedHashBytes -=
                Buffer.byteLength(oldest) + Buffer.byteLength(suggestedHashes.get(oldest)!);
              suggestedHashes.delete(oldest);
            }
            suggestedHashes.set(key, confirmationHash);
            suggestedHashBytes += bytes;
          }
        }
        return {
          confirmationHash,
          confirmation: header,
          coverage: { groupVersionId: versionId, contextId: context.contextId },
        };
      }
      return null;
    }
    issueScratch.db.exec(
      'CREATE TABLE source_scope_answers (line INTEGER PRIMARY KEY, problem TEXT)',
    );
    const writeScopeAnswer = issueScratch.db.prepare(
      'INSERT INTO source_scope_answers VALUES (?, ?)',
    );
    const readScopeAnswer = issueScratch.db.prepare(
      'SELECT problem FROM source_scope_answers WHERE line=?',
    );
    const result = yield* createCollectionClinicalReviewSessionWork({
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
      sourceScopeProblem: yield* prepareClinicalSourceScopeCheckWork(
        {
          set(entry, problem) {
            writeScopeAnswer.run(entry.line, problem);
          },
          get(entry) {
            return readScopeAnswer.get(entry.line)?.problem as string | null | undefined;
          },
        },
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
      ownership: scope.ownershipScope(
        grounding.originalBirthDateEvidence,
        initialVersion.version,
        grounding.originalBirthDateEvidenceWork,
      ),
      reportSource: pairSource,
      projection: {
        materializeSourceProviders: () => finishClinicalReviewWork(validateAllProviders(true)),
        sourceScope: (entries) =>
          clinicalSourceScopeCheck(db, reviewed, entries, inputFile.id, (original) => ({
            ...sourceFor(original).sourceScope,
            // Projection rechecks the complete scope after its own derived
            // maintenance and inside a speculative write transaction. The
            // immutable read-prefix certificate belongs only to preparation.
            groundedSomeWork: undefined,
          })),
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
      assertProjectionEvidenceCurrent: assertPhysicalEvidenceCurrent,
      verifyProjectionEvidenceCooperatively: cooperativePhysical
        ? verifyPhysicalEvidenceCooperatively
        : undefined,
      // The group owns the signed original union before speculative cross-member reads.
      beginProjectionConsumption() {
        if (projectionConsumptionScope)
          throw new HttpError(409, 'SOURCE_CHANGED', 'Clinical projection consumption is active');
        const last = issueScratch.db
          .prepare('SELECT COALESCE(max(rowid),0) AS ordinal FROM main.consumed_source_files')
          .get()!.ordinal;
        const scope = {};
        projectionConsumptionScope = scope;
        let restored = false;
        return () => {
          if (restored) return;
          if (projectionConsumptionScope !== scope)
            throw new HttpError(409, 'SOURCE_CHANGED', 'Clinical projection consumption changed');
          try {
            issueScratch.db
              .prepare('DELETE FROM main.consumed_source_files WHERE rowid>?')
              .run(last);
          } finally {
            projectionConsumptionScope = undefined;
            restored = true;
          }
        };
      },
      *consumedArtifactIds() {
        const scope = projectionConsumptionScope;
        const assertScope = () => {
          if (projectionConsumptionScope !== scope)
            throw new HttpError(409, 'SOURCE_CHANGED', 'Clinical projection consumption changed');
        };
        let sealed = 0;
        for (const row of issueScratch.db
          .prepare('SELECT id,path,identity,seal FROM main.consumed_source_files ORDER BY id')
          .iterate()) {
          assertScope();
          if (typeof row.id !== 'string') throw Error('Incomplete clinical consumed source');
          if (physicallySealed(row)) sealed++;
          else if (!scope || row.path !== null || row.identity !== null || row.seal !== null)
            throw Error('Incomplete clinical consumed source');
          yield row.id;
          assertScope();
        }
        assertScope();
        if (sealed !== originalPhysicalCount) throw Error('Incomplete clinical consumed source');
      },
      *verifiedArtifacts() {
        let seen = 0;
        for (const row of issueScratch.db
          .prepare('SELECT id,path,identity,seal FROM main.consumed_source_files ORDER BY id')
          .iterate()) {
          if (!physicallySealed(row)) throw Error('Incomplete clinical artifact proof');
          seen++;
          yield { id: row.id, path: row.path, identity: row.identity };
        }
        if (seen !== originalPhysicalCount) throw Error('Incomplete clinical artifact proof');
      },
      sourceText: {
        stale,
        revisionId: proposalId && measured !== null ? proposalRevision : parentRevision,
        dependencyToken: proposalId && measured !== null ? proposalDependency : parentDependency,
      },
      assertCurrent,
    });
    if (result.status === 'ready') {
      try {
        preparingCooperatively = false;
        // All consumed source dependencies remain covered even after the bounded opened-scope LRU evicts them.
        if (!cooperativePhysical) assertPhysicalEvidenceCurrent();
        assertCurrent();
      } catch (error) {
        result.session.close();
        throw error;
      }
      const close = result.session.close;
      result.session.close = () => {
        physicalVerifierClosed = true;
        void revokePhysicalVerifier().catch(() => {});
        try {
          close();
        } finally {
          try {
            questionHydrations.close();
          } finally {
            issueScratch.close();
          }
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
    if (!retainedIssueScratch) {
      try {
        questionHydrations.close();
      } finally {
        issueScratch.close();
      }
    }
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
  return readPreparedClinicalTransport(db, root, profileId, intakeId, proposalId, (session) =>
    input.kind === 'page'
      ? session.page(input.section, input.options)
      : input.kind === 'fragment'
        ? session.fragment(input.reference, input.offset, input.bytes)
        : session.selectedRecord(input.recordId, input.candidateVersionId, input.bytes),
  );
}

type ClinicalSectionTransport =
  | import('../shared/intake-clinical-record-sections.ts').ClinicalRecordSectionPage
  | {
      encoding: 'base64';
      data: string;
      totalBytes: number;
      complete: boolean;
      nextOffset: number | null;
    };
/** Internal synchronous renderer: only the detached bounded result may leave this callback. */
export async function readPreparedClinicalRecordSection<T extends ClinicalSectionTransport>(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  selection: import('../shared/intake-clinical-record-sections.ts').ClinicalRecordSelection,
  render: (selected: {
    review: ClinicalReadSession['review'];
    record: NonNullable<ReturnType<ClinicalReadSession['record']>>;
  }) => T,
): Promise<T> {
  const result = await readPreparedClinicalTransport(
    db,
    root,
    profileId,
    intakeId,
    selection.proposalId,
    (session) => {
      const record = session.record(selection.recordId, undefined, selection.candidateVersionId);
      if (!record)
        throw new HttpError(
          409,
          'REVIEW_SECTION_CHANGED',
          'Refresh the selected record and its exact evidence before continuing',
        );
      return render({ review: session.review, record });
    },
  );
  if (result.status !== 'ready')
    throw new HttpError(
      409,
      'REVIEW_PREPARATION_REQUIRED',
      'Prepare the complete selected evidence before continuing',
    );
  return result.value;
}

async function readPreparedClinicalTransport<T>(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  render: (session: ClinicalReadSession) => T,
): Promise<ClinicalReadResult<T>> {
  let value: T | undefined;
  const borrowed = await borrowCollectionClinicalReviewAsync(
    db,
    root,
    profileId,
    intakeId,
    proposalId,
    { public: true },
    (session) => {
      const output = render(session);
      if (
        output &&
        typeof output === 'object' &&
        ('then' in output || Symbol.iterator in output || Symbol.asyncIterator in output)
      )
        throw new TypeError('Clinical transport rendering must return a synchronous bounded DTO');
      // Detach only emitted bounded transport; no caller gets the private session or record aliases.
      value = JSON.parse(JSON.stringify(output), (_key, value, context) =>
        typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
          ? JSON.rawJSON(context.source)
          : value,
      ) as T;
    },
  );
  borrowed.release();
  if (borrowed.result.status !== 'ready') return borrowed.result;
  return { status: 'ready', value: value as T };
}

export interface BorrowedCollectionClinicalReview {
  result: CollectionClinicalReviewResult;
  /** Present for a ready result: verified after the caller's use callback. */
  projection?: CollectionClinicalProjectionContext;
  /** True when this request built the session from its original. */
  prepared: boolean;
  /** Ends this request's use; a retained session stays open for the next exact read. */
  release(): void;
}
/**
 * Read-only consumers share one retained selected review per connection.
 * Reuse requires the exact key, raw read stamp, source pin and revision that
 * were current when the retained session was proven. Every use, fresh or
 * reused, re-runs dependency preparation, the session's physical proof after
 * `use`, and the revision/source/preparation guards. A borrowed session is
 * never closed by its consumer: release() returns it to the slot, or closes it
 * if it was not retained or was discarded while leased.
 */
export async function borrowCollectionClinicalReviewAsync(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  proposalId: string | null,
  options: {
    signal?: AbortSignal;
    assertRunning?: () => void;
    groundingDependency?: (intakeId: string) => void;
    /** Public transport reads count their preparations separately. */
    public?: boolean;
  } = {},
  use: (session: ClinicalReadSession) => void = () => {},
): Promise<BorrowedCollectionClinicalReview> {
  let discardResult = (_value: BorrowedCollectionClinicalReview) => {};
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const attempt = beginPreparedClinicalReviewRead(db);
      const discardRetained = () => {
        if (isPreparedClinicalReviewReadCurrent(db, attempt)) discardPreparedClinicalReviewRead(db);
      };
      discardResult = (value) => {
        value.release();
        discardRetained();
      };
      let release = () => {};
      try {
        if (db.isTransaction) discardPreparedClinicalReviewRead(db);
        options.assertRunning?.();
        assertIntakeOwner(db, profileId);
        await prepareCollectionClinicalReviewDependencies(
          db,
          root,
          profileId,
          intakeId,
          proposalId,
          { assertRunning: options.assertRunning },
        );
        const key = canonicalLiteral([root, profileId, intakeId, proposalId]),
          stamp = reviewReadStamp(db),
          preparationStamp = reviewPreparationStamp(db),
          requestRevision = revision(db),
          sourcePin = canonicalLiteral(intakeSourceVersion(db, intakeId));
        const borrower = {
          assertRunning: options.assertRunning,
          groundingDependency: options.groundingDependency,
        };
        let cached: PreparedClinicalReviewRead | undefined = preparedClinicalReviewRead(db);
        if (
          cached &&
          (stamp === undefined ||
            cached.key !== key ||
            cached.stamp !== stamp ||
            cached.sourcePin !== sourcePin ||
            cached.requestRevision !== requestRevision)
        ) {
          discardRetained();
          cached = undefined;
        }
        let leased = cached && leasePreparedClinicalReviewRead(cached, borrower);
        if (cached && leased) {
          // A proof already stale at admission is a miss, never a new baseline.
          try {
            await collectionClinicalProjectionContextAsync(
              cached.session,
              options.signal,
              options.assertRunning,
            );
          } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 409) throw error;
            leased();
            leased = undefined;
            discardRetained();
            cached = undefined;
          }
        }
        let session: ClinicalReadSession, retain: PreparedClinicalReviewRead | undefined;
        if (cached && leased) {
          release = leased;
          session = cached.session;
          // The retained session may already have opened other originals.
          for (const id of cached.route!.dependencies) options.groundingDependency?.(id);
        } else {
          if (options.public)
            withIntakeWork(db, 'warm', () => recordIntakeWork('collectionPublicClinicalReviews'));
          // Late session callbacks reach only the current lease holder.
          const route: PreparedClinicalReviewRoute = {
            leased: true,
            discarded: false,
            dependencies: new Set(),
            borrower,
          };
          const prepared = await prepareCollectionClinicalReviewAsync(
            db,
            root,
            profileId,
            intakeId,
            proposalId,
            {
              signal: options.signal,
              assertRunning: () => route.borrower?.assertRunning?.(),
              groundingDependency: (id) => {
                route.dependencies.add(id);
                route.borrower?.groundingDependency?.(id);
              },
            },
          );
          if (prepared.status !== 'ready') {
            route.leased = false;
            route.borrower = undefined;
            return { result: prepared, prepared: true, release };
          }
          session = prepared.session;
          let released = false;
          release = () => {
            if (released) return;
            released = true;
            route.leased = false;
            route.borrower = undefined;
            if (route.discarded || !retain || preparedClinicalReviewRead(db) !== retain)
              session.close();
          };
          // A concurrently leased slot is never replaced under its holder.
          if (!cached) retain = { key, stamp: '', sourcePin, requestRevision, session, route };
        }
        use(session);
        // Recheck all consumed physical evidence after use.
        // The SQL/registry/grounding guards below must run after the last physical stat.
        const projection = await collectionClinicalProjectionContextAsync(
          session,
          options.signal,
          options.assertRunning,
        );
        assertIntakeOwner(db, profileId);
        if (
          requestRevision !== revision(db) ||
          sourcePin !== canonicalLiteral(intakeSourceVersion(db, intakeId)) ||
          (preparationStamp !== undefined && preparationStamp !== reviewPreparationStamp(db))
        )
          throw new HttpError(
            409,
            'INTAKE_REVIEW_CHANGED',
            'Review changed while reading; refresh this review',
          );
        if (cached && leased)
          withIntakeWork(db, 'warm', () =>
            recordIntakeWork('collectionRetainedClinicalReviewBorrows'),
          );
        const completedStamp = reviewReadStamp(db);
        if (
          retain &&
          completedStamp !== undefined &&
          isPreparedClinicalReviewReadCurrent(db, attempt)
        ) {
          retain.stamp = completedStamp;
          retainPreparedClinicalReviewRead(db, retain);
        }
        return { result: { status: 'ready', session }, projection, prepared: !leased, release };
      } catch (error) {
        release();
        discardRetained();
        throw error;
      }
    },
    {
      operation: currentClinicalOperation(db),
      onDiscardResult: (value) => discardResult(value),
    },
  );
}
