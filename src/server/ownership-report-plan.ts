import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
  sealClinicalReadResult,
  type ClinicalOperation,
} from './clinical-operation.ts';
import {
  createClinicalReviewArtifactProof,
  captureClinicalArtifactReadTerminal,
  type ClinicalArtifactReadTerminal,
} from './clinical-review-artifact-proof.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { identityGroundingGeneration } from './intake-identity-grounding.ts';
import { ownershipPlanGroups } from './ownership-plan-groups.ts';
import { ownershipPlanHolds } from './ownership-plan-holds.ts';
import { prepareOwnershipRecordsSelection } from './ownership-records-selection.ts';
import { prepareOwnershipIdentitySnapshots } from './ownership-identity-snapshots.ts';
/** Owned complete report preview. Its scratch rows are views, never durable authority. */
import { createOwnershipScopeIndex } from './ownership-scope-index.ts';
import { ClinicalPhysicalEvidenceChanged } from './clinical-review-physical-worker.ts';
import {
  iterateOwnershipStreamContributions,
  OwnershipContributionSequence,
  readOwnershipStreamContribution,
  restoreOwnershipStreamContribution,
} from './ownership-contribution-stream.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import {
  collectionClinicalProjectionContext,
  collectionClinicalProjectionContextAsync,
  type VerifiedClinicalArtifact,
} from './intake-review-collection-session.ts';
import type { IntakeReview } from '../shared/intake.ts';
import type { SelectedOwnershipReviewScope } from './record-ownership-authority.ts';
import { randomUUID, createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  HttpError,
  currentTransactionToken,
  installTransactionTerminalGuard,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import { prepareOwnershipReportSelection } from './ownership-report-selection.ts';
import {
  createOwnershipPreviewStore,
  type OwnershipCommitView,
} from './ownership-preview-store.ts';
import { previewRecordOwnership, previewRecordOwnershipPrepared } from './record-ownership.ts';
import { prepareOwnershipNamePlan, captureOwnershipNameReadOwner } from './ownership-name-plan.ts';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  prepareTerminalStatements,
  withTerminalStatements,
} from './database-terminal-statements.ts';
import {
  captureRecordReadOwner,
  recordReadOwnerSupported,
  assertRecordReadOwnerBeforeVerification,
  assertRecordReadOwnerTerminal,
  closeRecordReadOwner,
  type RecordReadOwner,
  type RecordPublicationOriginals,
} from './record-versions.ts';
import {
  captureOwnershipReadInterval,
  bindOwnershipReadInterval,
  assertOwnershipReadInterval,
  closeOwnershipReadInterval,
  prepareOwnershipReadOwner,
  assertOwnershipReadOwner,
  sealOwnershipReadInterval,
} from './ownership-read-owner.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { prepareCollectionReviewMembership } from './intake-review-membership-index.ts';
import { activeMappingRules } from './clinical-import.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import { intakeDiscoveryRevision } from './intake-lookup-state.ts';
import { clinicalReviewRevision } from './database.ts';
import { workflowHash } from './intake-workflow.ts';
import { ownershipHash } from './ownership-journal.ts';
import { ownershipClinicalHeader } from './ownership-clinical-header.ts';
import { prepareOwnershipDecisionIndex } from './ownership-decision-index.ts';
import {
  createOwnershipSourceSnapshotPreparation,
  assertOwnershipSourceSnapshot,
  type OwnershipSourceSnapshotReference,
} from './ownership-source-snapshots.ts';
import { ownershipRequest, object } from './record-ownership-input.ts';
import type { OwnershipRequest, OwnershipPreview } from '../shared/record-ownership.ts';
import type {
  OwnershipReportPreviewReference,
  OwnershipReportEvidenceReference,
} from '../shared/ownership-report-reference.ts';

declare const originalProofBrand: unique symbol;
export interface OwnershipReportOriginalProof {
  readonly [originalProofBrand]: true;
}
interface OriginalProofOwner {
  db: Database;
  profileId: string;
  current(): boolean;
  capture(): () => Generator<VerifiedClinicalArtifact>;
}
const originalProofOwners = new WeakMap<object, OriginalProofOwner>();
const nativeReadPrepare = DatabaseSync.prototype.prepare,
  nativeReadGet = StatementSync.prototype.get;
declare const readOwnerBrand: unique symbol;
export interface OwnershipReportReadOwner {
  readonly [readOwnerBrand]: true;
}
const readOwners = new WeakMap<
  object,
  {
    db: Database;
    profileId: string;
    sql: DatabaseSync;
    record: RecordReadOwner;
    current(): boolean;
    ownsTerminal(proof: ClinicalArtifactReadTerminal): boolean;
  }
>();
const readProofs = new WeakMap<
  OwnershipReportReadOwner,
  {
    owner: NonNullable<ReturnType<typeof readOwners.get>>;
    statements: StatementSync[];
    stamp: unknown[];
  }
>();
const readContinuations = new WeakMap<Function, { db: Database; plan?: object }>();
export function ownershipReportReadContinuationCurrent(work: Function, db: Database): boolean {
  return readContinuations.get(work)?.db === db && db.isOpen;
}
function runReportReadOperation<T>(
  db: Database,
  work: Parameters<typeof runExclusiveClinicalOperation<T>>[1],
  options: Parameters<typeof runExclusiveClinicalOperation<T>>[2],
  plan?: object,
) {
  readContinuations.set(work, { db, plan });
  return runExclusiveClinicalOperation(db, work, options);
}
export function captureOwnershipReportReadOwner(plan: object, db: Database, profileId: string) {
  const owner = readOwners.get(plan);
  if (!owner || owner.db !== db || owner.profileId !== profileId || !owner.current())
    throw Error('Original ownership report read owner unavailable');
  const statements = [
    'SELECT total_changes() AS value',
    'PRAGMA main.schema_version',
    'PRAGMA temp.schema_version',
    'PRAGMA main.data_version',
  ].map((sql) => Reflect.apply(nativeReadPrepare, owner.sql, [sql]));
  const stamp = statements.map(
    (statement) => Object.values(Reflect.apply(nativeReadGet, statement, [])!)[0],
  );
  const proof = Object.freeze({}) as OwnershipReportReadOwner;
  readProofs.set(proof, { owner, statements, stamp });
  assertOwnershipReportReadOwner(db, proof);
  return proof;
}
export function assertOwnershipReportReadOwner(
  db: Database,
  proof: OwnershipReportReadOwner,
): void {
  const data = readProofs.get(proof);
  if (!data || data.owner.db !== db || !data.owner.current())
    throw Error('Original ownership report read owner changed');
  const stamp = data.statements.map(
    (statement) => Object.values(Reflect.apply(nativeReadGet, statement, [])!)[0],
  );
  if (stamp.some((value, index) => value !== data.stamp[index]) || !data.owner.current())
    throw Error('Original ownership report read owner changed');
}
export function ownershipReportReadRecordOwner(
  db: Database,
  proof: OwnershipReportReadOwner,
): RecordReadOwner {
  assertOwnershipReportReadOwner(db, proof);
  return readProofs.get(proof)!.owner.record;
}
export function ownershipReportReadTerminalCurrent(
  db: Database,
  proof: OwnershipReportReadOwner,
  terminal: ClinicalArtifactReadTerminal,
): boolean {
  assertOwnershipReportReadOwner(db, proof);
  return readProofs.get(proof)!.owner.ownsTerminal(terminal);
}
const originalProofs = new WeakMap<
  OwnershipReportOriginalProof,
  {
    owner: OriginalProofOwner;
    operation: ClinicalOperation;
    rows: () => Generator<VerifiedClinicalArtifact>;
  }
>();
function originalProofUnavailable(): never {
  throw new HttpError(
    409,
    'OWNERSHIP_CHANGED',
    'Original ownership evidence is no longer available',
  );
}
/** Only an actual prepared report can transport its original complete proof. */
export function captureOwnershipReportOriginalProof(
  plan: PreparedOwnershipReportPlan,
  db: Database,
  profileId: string,
): OwnershipReportOriginalProof {
  const owner = originalProofOwners.get(plan),
    operation = currentClinicalOperation(db);
  if (
    !owner ||
    owner.db !== db ||
    owner.profileId !== profileId ||
    !owner.current() ||
    !operation ||
    db.isTransaction
  )
    originalProofUnavailable();
  const rows = owner!.capture();
  assertClinicalOperation(db, operation);
  if (!owner!.current()) originalProofUnavailable();
  const proof = Object.freeze({}) as OwnershipReportOriginalProof;
  originalProofs.set(proof, { owner: owner!, operation: operation!, rows });
  return proof;
}
/** Authentication and membership transport only, never current physical authority. */
export function ownershipReportOriginalProofCurrent(
  proof: OwnershipReportOriginalProof,
  db: Database,
  profileId: string,
): boolean {
  const data = originalProofs.get(proof);
  if (!data || data.owner.db !== db || data.owner.profileId !== profileId || !data.owner.current())
    return false;
  try {
    assertClinicalOperation(db, data.operation);
    return true;
  } catch {
    return false;
  }
}
/** Identifies the exact report issuer; the core separately checks the active
 * child frame and its unchanged caller prerequisites before synchronous T1. */
export function ownershipReportOriginalProofOwnsContinuation(
  proof: OwnershipReportOriginalProof,
  work: Function,
  db: Database,
  profileId: string,
): boolean {
  const continuation = readContinuations.get(work),
    original = originalProofs.get(proof);
  return (
    !!continuation?.plan &&
    continuation.db === db &&
    !!original &&
    original.owner === originalProofOwners.get(continuation.plan) &&
    ownershipReportOriginalProofCurrent(proof, db, profileId)
  );
}
export function* verifiedOwnershipReportOriginalArtifacts(
  proof: OwnershipReportOriginalProof,
  db: Database,
  profileId: string,
): Generator<VerifiedClinicalArtifact> {
  const data = originalProofs.get(proof);
  const current = () => {
    if (!ownershipReportOriginalProofCurrent(proof, db, profileId)) originalProofUnavailable();
  };
  current();
  for (const artifact of data!.rows()) {
    current();
    yield artifact;
    current();
  }
  current();
}
export async function prepareOwnershipReportPlan(
  db: Database,
  root: string,
  profileId: string,
  request: OwnershipRequest,
  options: {
    assertRunning?: () => void;
    onCheckpoint?: (stage: string) => void;
    approvedRelationshipDecisions?: () => Iterable<
      NonNullable<OwnershipRequest['relationshipDecisions']>[number]
    >;
  } = {},
) {
  const originalAssertRunning = options.assertRunning;
  return runExclusiveClinicalOperation(
    db,
    async () => {
      request = structuredClone(request);
      const submittedDecisions = request.decisions ?? [],
        submittedRelationshipValues = request.relationshipDecisions ?? [],
        submittedRelationships =
          options.approvedRelationshipDecisions ?? (() => submittedRelationshipValues);
      request = { ...request, decisions: [], relationshipDecisions: [] };
      const report = request.selection.type === 'report' ? request.selection : null;
      await prepareOwnershipDecisionIndex(db, options);
      if (report) {
        await prepareCollectionClinicalReviewDependencies(
          db,
          root,
          profileId,
          report.intakeId,
          null,
          options,
        );
        const intakeId = report.intakeId,
          metadata = intakeSourceMetadata(db, intakeId).metadata;
        const mappingVersion = () =>
          workflowHash(
            activeMappingRules(
              db,
              metadata?.sourceProviderId ||
                String(
                  db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(intakeId)!
                    .provider_id,
                ),
            ),
          );
        options.onCheckpoint?.('readiness-start');
        const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, intakeId, {
          mappingVersion: mappingVersion(),
          currentMappingVersion: mappingVersion,
          assertRunning: originalAssertRunning,
        });
        if (ready.state !== 'ready')
          throw new HttpError(
            409,
            'OWNERSHIP_REVIEW_PENDING',
            'Complete report clinical evidence is still being prepared',
          );
        options.onCheckpoint?.('readiness-complete');
        await prepareCollectionReviewMembership(db, { id: intakeId }, options);
      }
      const prepareSelection = () =>
        report
          ? prepareOwnershipReportSelection(db, profileId, request, options)
          : prepareOwnershipRecordsSelection(db, profileId, request, options);
      const intakeId = report?.intakeId;
      const token = randomUUID(),
        evidenceUrl =
          '/api/profiles/' +
          encodeURIComponent(profileId) +
          '/record-ownership/report-evidence/' +
          token;
      let selection = await prepareSelection();
      // Upgrade only exact participating legacy originals before selecting the final
      // preview frontier. This is a counted cold conversion, never a legacy DTO fallback.
      const selectedClinical = clinicalReviewRevision(db),
        selectedFrontier = intakeDiscoveryRevision(db);
      let preparedSources = 0;
      selection.sql.exec('CREATE TABLE dependency_prepared(key TEXT PRIMARY KEY)');
      const prepareDependency = async (originalId: string, sourceRecordId: string) => {
        const proposal = sourceRecordId.replace(/:line:\d+$/, ''),
          proposalId = proposal === originalId ? null : proposal,
          key = JSON.stringify([originalId, proposalId]);
        if (selection.sql.prepare('SELECT 1 FROM dependency_prepared WHERE key=?').get(key)) return;
        await prepareCollectionClinicalReviewDependencies(
          db,
          root,
          profileId,
          originalId,
          proposalId,
          options,
        );
        selection.sql.prepare('INSERT INTO dependency_prepared VALUES(?)').run(key);
      };
      try {
        for (const ref of selection.records())
          for (const contribution of iterateOwnershipStreamContributions(
            db,
            ref.kind,
            ref.recordId,
            {
              scopes: () => [],
            },
          )) {
            await prepareDependency(contribution.intakeId, contribution.sourceRecordId);
            if (++preparedSources % 32 === 0) await setImmediate();
            originalAssertRunning?.();
            if (clinicalReviewRevision(db) !== selectedClinical)
              throw new HttpError(
                409,
                'OWNERSHIP_CHANGED',
                'Clinical evidence changed while preparing its exact sources',
              );
            if (selection.view) selection.view.address(selection.view.root());
          }
        for (const pending of selection.pending())
          await prepareDependency(intakeId!, pending.recordId);
        if (clinicalReviewRevision(db) !== selectedClinical)
          throw new HttpError(
            409,
            'OWNERSHIP_CHANGED',
            'Clinical evidence changed while preparing its exact sources',
          );
        if (selection.view) selection.view.address(selection.view.root());
        if (intakeDiscoveryRevision(db) !== selectedFrontier) {
          selection.close();
          selection = await prepareSelection();
        } else selection.assertCurrent();
      } catch (error) {
        selection.close();
        throw error;
      }
      const selectedGrounding = identityGroundingGeneration(db);
      const assertCurrent = () => {
        selection.assertCurrent();
        if (identityGroundingGeneration(db) !== selectedGrounding)
          throw new HttpError(
            409,
            'OWNERSHIP_CHANGED',
            'Identity evidence changed; prepare a fresh preview',
          );
      };
      const store = createOwnershipPreviewStore(
        selection.sql,
        selection.sources,
        evidenceUrl,
        report ? 'all' : 'changed',
      );
      options.onCheckpoint?.('selection-complete');
      const scopes = createOwnershipScopeIndex(db, selection.sql, assertCurrent);
      selection.sql.exec(
        'CREATE TABLE record_choices(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE relationship_choices(id TEXT PRIMARY KEY); CREATE TABLE ownership_lineage(record_key TEXT PRIMARY KEY,moving TEXT,remaining TEXT); CREATE TABLE contribution_values(record_key TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(record_key,ordinal));',
      );
      let snapshotPrepared = false;
      let identitySnapshots:
        Awaited<ReturnType<typeof prepareOwnershipIdentitySnapshots>> | undefined;
      for (const choice of submittedDecisions)
        selection.sql
          .prepare(
            'INSERT INTO record_choices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(choice.recordId, JSON.stringify(choice));
      for (const choice of submittedRelationships())
        selection.sql
          .prepare('INSERT OR IGNORE INTO relationship_choices VALUES(?)')
          .run(choice.decisionId);
      const decision = (recordId: string) => {
        const row = selection.sql
          .prepare('SELECT value FROM record_choices WHERE id=?')
          .get(recordId);
        return row
          ? (JSON.parse(String(row.value)) as NonNullable<OwnershipRequest['decisions']>[number])
          : undefined;
      };
      const relationshipDecision = (id: string) =>
        !!selection.sql.prepare('SELECT 1 FROM relationship_choices WHERE id=?').get(id);
      // Finalization updates preview rows. Keep the signed original proofs in a
      // separate private scratch whose witness stays unchanged through publication.
      const artifactScratch = disposableSqlite('ownership-artifact-proof-'),
        artifacts = createClinicalReviewArtifactProof(artifactScratch.db, 'clinical_artifacts');
      let closed = false;
      let returnedPlan: object | undefined;
      let recordReadOwner: RecordReadOwner | undefined;
      let terminalPhysicalCurrent: (() => void) | undefined,
        stopTerminalGuard: (() => void) | undefined;
      const assertPreparedCurrent = () => {
        assertCurrent();
        if (terminalPhysicalCurrent) terminalPhysicalCurrent();
        else artifacts.assertCurrent();
      };
      const selectionWitness = () => {
        if (!selection.sql.isOpen) throw Error('Closed ownership report plan');
        return [
          selection.sql.prepare('SELECT total_changes() changes').get()!.changes,
          selection.sql.prepare('PRAGMA main.schema_version').get()!.schema_version,
          selection.sql.prepare('PRAGMA temp.schema_version').get()!.schema_version,
        ].join(':');
      };
      const withVerified = async <T>(
        complete: () => T,
        mode: 'read-only' | 'publication',
      ): Promise<T> =>
        runReportReadOperation(
          db,
          async (operation) => {
            if (terminalPhysicalCurrent || db.isTransaction || currentTransactionToken(db))
              throw Error('Ownership physical verification requires its outside-transaction owner');
            const witness = selectionWitness();
            const assertPreflightCurrent = () => {
              assertClinicalOperation(db, operation);
              assertCurrent();
              plan?.assertCurrent();
              if (db.isTransaction || selectionWitness() !== witness)
                throw new HttpError(
                  409,
                  'OWNERSHIP_CHANGED',
                  'Ownership preview changed during verification',
                );
            };
            if (mode === 'read-only' && recordReadOwner) {
              const interval = captureOwnershipReadInterval(db);
              let handedOff = false;
              try {
                const owner = await prepareOwnershipReadOwner(
                    db,
                    profileId,
                    operation,
                    originalAssertRunning ? [originalAssertRunning] : [],
                  ),
                  reportOwner = captureOwnershipReportReadOwner(returnedPlan!, db, profileId),
                  nameOwner = captureOwnershipNameReadOwner(plan!, db, profileId);
                bindOwnershipReadInterval(db, interval, reportOwner, nameOwner);
                const current = () => {
                  assertOwnershipReadOwner(db, owner);
                  assertOwnershipReadInterval(db, interval);
                };
                assertPreflightCurrent();
                current();
                // All caller rendering and getter evaluation precedes the final
                // original-member sweep. Only a detached result can escape it.
                terminalPhysicalCurrent = current;
                let value: T;
                try {
                  const rendered = complete();
                  if (
                    rendered !== null &&
                    (typeof rendered === 'object' || typeof rendered === 'function') &&
                    ('then' in rendered || 'next' in rendered)
                  )
                    throw Error('Ownership read requires a synchronous detached result');
                  value = structuredClone(rendered);
                } finally {
                  terminalPhysicalCurrent = undefined;
                }
                assertPreflightCurrent();
                const statements = prepareTerminalStatements(db, { statements: [] });
                assertRecordReadOwnerBeforeVerification(db, recordReadOwner);
                current();
                return await artifacts.withVerifiedTerminal(
                  { assertCurrent: current },
                  (physicalCurrent) =>
                    withTerminalStatements(db, statements, () => {
                      current();
                      assertRecordReadOwnerTerminal(db, recordReadOwner!);
                      sealOwnershipReadInterval(
                        db,
                        interval,
                        captureClinicalArtifactReadTerminal(physicalCurrent),
                      );
                      const result = sealClinicalReadResult(db, operation, owner, interval, value);
                      handedOff = true;
                      return result;
                    }),
                  'read-only',
                );
              } catch (error) {
                if (error instanceof ClinicalPhysicalEvidenceChanged) {
                  assertClinicalOperation(db, operation);
                  throw new HttpError(
                    409,
                    'SOURCE_CHANGED',
                    'Retained physical evidence changed; prepare a fresh review',
                  );
                }
                throw error;
              } finally {
                terminalPhysicalCurrent = undefined;
                if (!handedOff) closeOwnershipReadInterval(interval);
              }
            }
            return artifacts.withVerifiedTerminal(
              { assertCurrent: assertPreflightCurrent },
              (physicalCurrent) => {
                assertPreflightCurrent();
                terminalPhysicalCurrent = physicalCurrent;
                try {
                  return complete();
                } finally {
                  terminalPhysicalCurrent = undefined;
                  stopTerminalGuard?.();
                  stopTerminalGuard = undefined;
                }
              },
              mode,
            );
          },
          { operation: currentClinicalOperation(db) },
          returnedPlan,
        );
      let retainedReview:
        | {
            key: string;
            review: IntakeReview;
            ownership: SelectedOwnershipReviewScope;
            record(id: string): import('../shared/intake.ts').IntakeReviewRecord | undefined;
            assertCurrent(): void;
            close(): void;
          }
        | undefined;
      const prepareReviewSource = async (intakeId: string, sourceId: string): Promise<void> => {
        assertCurrent();
        const proposal = sourceId.replace(/:line:\d+$/, ''),
          key = intakeId + ':' + proposal;
        if (retainedReview?.key !== key) {
          retainedReview?.close();
          retainedReview = undefined;
          const ready = await prepareCollectionClinicalReviewAsync(
            db,
            root,
            profileId,
            intakeId,
            proposal === intakeId ? null : proposal,
            { assertRunning: assertCurrent },
          );
          if (ready.status !== 'ready')
            throw new HttpError(
              409,
              'OWNERSHIP_REVIEW_FRAGMENT',
              'Selected report clinical evidence requires its complete addressed reference',
            );
          // Copy the host's already-verified identities before this one retained
          // session is replaced. SQL holds the complete fan-in without live sessions.
          let context: ReturnType<typeof collectionClinicalProjectionContext>;
          try {
            context = await collectionClinicalProjectionContextAsync(ready.session);
            artifacts.retain(context.verifiedArtifacts());
          } catch (error) {
            ready.session.close();
            throw error;
          }
          retainedReview = {
            key,
            review: ready.session.review,
            ownership: ready.session.ownership,
            record: (id: string) => ready.session.record(id),
            assertCurrent: () => context.assertAuthorityCurrent(),
            close: () => ready.session.close(),
          };
        }
        retainedReview!.assertCurrent();
        assertCurrent();
      };
      const reviewSource = (intakeId: string, sourceId: string) => {
        assertCurrent();
        const proposal = sourceId.replace(/:line:\d+$/, '');
        if (retainedReview?.key !== intakeId + ':' + proposal)
          throw Error('Ownership source requires cooperative preparation');
        retainedReview.assertCurrent();
        return retainedReview;
      };
      let plan: Awaited<ReturnType<typeof prepareOwnershipNamePlan>> | undefined;
      try {
        if (intakeId) await scopes.prepare(intakeId);
        options.onCheckpoint?.('index-complete');
        const reportSelection = (
          refs: import('../shared/record-ownership.ts').OwnershipRecordReference[],
          pending: OwnershipPreview['pending'],
        ) => ({
          sources: selection.sources,
          refs,
          pending,
          hasRecord: selection.hasRecord,
          boundary: selection.boundary,
        });
        const scopeOptions = (
          refs: import('../shared/record-ownership.ts').OwnershipRecordReference[] = [],
          pending: OwnershipPreview['pending'] = [],
        ) => ({
          selection: reportSelection(refs, pending),
          sink: store.sink,
          scopes,
          reviewSource,
          prepareReviewSource,
          decision,
          relationshipDecision,
          contributions(kind: import('./clinical-references.ts').ClinicalKind, recordId: string) {
            const key = ownershipHash([kind, recordId]);
            return new OwnershipContributionSequence(function* () {
              for (const row of selection.sql
                .prepare(
                  'SELECT value FROM contribution_values WHERE record_key=? ORDER BY ordinal',
                )
                .iterate(key))
                yield restoreOwnershipStreamContribution(
                  db,
                  kind,
                  recordId,
                  String(row.value),
                  scopes.contributionValues.bind(scopes),
                );
            });
          },
          captureNameScopes() {},
        });
        for (const ref of selection.records()) {
          assertCurrent();
          let contributionOrdinal = 0;
          for (const contribution of iterateOwnershipStreamContributions(
            db,
            ref.kind,
            ref.recordId,
            {
              scopes: () => [],
            },
          )) {
            await scopes.prepare(contribution.intakeId);
            selection.sql
              .prepare('INSERT INTO contribution_values VALUES(?,?,?)')
              .run(
                ownershipHash([ref.kind, ref.recordId]),
                contributionOrdinal++,
                JSON.stringify(contribution),
              );
            if (contributionOrdinal % 32 === 0) {
              await setImmediate();
              assertCurrent();
            }
          }
          assertCurrent();
          await previewRecordOwnershipPrepared(
            db,
            root,
            profileId,
            request,
            scopeOptions([ref]),
            assertCurrent,
          );
          options.onCheckpoint?.('record-complete');
          await setImmediate();
        }
        options.onCheckpoint?.('records-complete');
        const blockers = store.sink.blockerBucket('allheader');
        for (const choice of submittedDecisions)
          if (!store.sink.hasRecord(choice.recordId))
            blockers.push('A matching decision is outside this selection.');
        for (const choice of submittedRelationships())
          if (!store.sink.relationships.has(choice.decisionId))
            blockers.push('A relationship decision is outside this selection.');
        for (const pending of selection.pending()) {
          assertCurrent();
          const partial = await previewRecordOwnershipPrepared(
            db,
            root,
            profileId,
            request,
            scopeOptions([], [pending]),
            assertCurrent,
          );
          void partial;
          for (const blocker of store.sink.blockerBucket('header', false).values())
            blockers.push(blocker);
          await setImmediate();
        }
        options.onCheckpoint?.('pending-complete');
        plan = await prepareOwnershipNamePlan(
          db,
          profileId,
          store.sink.sources,
          store.sink.owners,
          request,
          { ...options, assertRunning: originalAssertRunning, ownedReportScopes: true, scopes },
        );
        options.onCheckpoint?.('names-complete');
        const prepareHolds = () =>
          ownershipPlanHolds(
            db,
            selection.sql,
            report ? [] : store.records,
            selection.sources,
            async (intakeId, sourceId) => {
              await prepareReviewSource(intakeId, sourceId);
              return reviewSource(intakeId, sourceId).ownership;
            },
            assertCurrent,
          );
        let holds = await prepareHolds();
        const finalize = () => {
          assertPreparedCurrent();
          plan!.assertCurrent();
          const header = previewRecordOwnership(db, root, profileId, request, {
            ...scopeOptions(),
            namePlan: plan,
          });
          const bucket = store.sink.blockerBucket('header', false);
          for (const blocker of blockers.values()) bucket.push(blocker);
          Object.assign(header, { blockerEvidence: bucket.reference() });
          // Holds were prepared with complete source policy before synchronous finalization.
          // Choices rebuild them before refresh; publication never starts cold clinical work.
          if (!report) {
            const decisions = [
              ...selection.sql.prepare('SELECT value FROM record_choices ORDER BY id').iterate(),
            ].map((row) => JSON.parse(String(row.value)));
            header.commitGroups = ownershipPlanGroups(
              selection.sql,
              store.records,
              { ...request, decisions },
              plan!.groupSourceEffects(),
            );
          }
          const holdHash = createHash('sha256');
          for (const hold of holds) holdHash.update(JSON.stringify(hold));
          header.scopeToken = ownershipHash([
            header.scopeToken,
            header.commitGroups,
            holdHash.digest('hex'),
          ]);
          return header;
        };
        let header = await withVerified(finalize, 'publication');
        const reference: OwnershipReportEvidenceReference = {
          token,
          digest: ownershipHash([selection.reference, store.sink.digest]),
          complete: true,
          recordTotal: store.records.length,
          pendingTotal: store.pending.length,
          relationshipTotal: store.relationships.length,
          recordBlockerTotal: store.recordBlockerTotal,
          reportHoldTotal: holds.length,
          url: evidenceUrl,
        };
        let stageToken: ReturnType<typeof currentTransactionToken>;
        const refresh = () => {
          header = finalize();
          reference.digest = ownershipHash([selection.reference, store.sink.digest]);
          reference.recordBlockerTotal = store.recordBlockerTotal;
          reference.reportHoldTotal = holds.length;
          return header;
        };
        const prepared = {
          plan,
          scopes,
          decision,
          contributions(
            kind: import('./clinical-references.ts').ClinicalKind,
            recordId: string,
            selected?: boolean,
          ) {
            const key = ownershipHash([kind, recordId]);
            return new OwnershipContributionSequence(function* () {
              for (const row of selection.sql
                .prepare(
                  'SELECT source_id FROM preview_contributions WHERE record_key=?' +
                    (selected === undefined ? '' : ' AND selected=?') +
                    ' ORDER BY ordinal',
                )
                .iterate(...(selected === undefined ? [key] : [key, Number(selected)])))
                yield readOwnershipStreamContribution(db, kind, recordId, String(row.source_id));
            });
          },
          async prepareSourceSnapshots(
            this: { stageSourceSnapshots(): void },
            originalRecordPublicationOriginals?: RecordPublicationOriginals,
          ) {
            return runExclusiveClinicalOperation(
              db,
              async () => {
                if (snapshotPrepared) {
                  this.stageSourceSnapshots();
                  return;
                }
                assertCurrent();
                plan!.assertCurrent();
                if (
                  'personId' in header.destination &&
                  store.records.every((item) => item.action === 'unchanged') &&
                  store.pending.every(
                    (item) =>
                      item.personId ===
                      ('personId' in header.destination ? header.destination.personId : null),
                  )
                )
                  return;
                selection.sql.exec('DELETE FROM ownership_lineage');
                const factoryFor = (id: string) =>
                  createOwnershipSourceSnapshotPreparation(
                    db,
                    { id },
                    {
                      assertRunning: () => {
                        assertCurrent();
                        plan!.assertCurrent();
                      },
                      ...(originalRecordPublicationOriginals
                        ? { originalRecordPublicationOriginals }
                        : {}),
                    },
                  );
                for (const item of store.records) {
                  if (item.action === 'unchanged' || !item.splitReviewRequired) continue;
                  const clinical = ownershipClinicalHeader(db, item.kind, item.recordId),
                    audit = clinical.extra.import.ownershipReview as
                      { sourceRecordIdsReference?: OwnershipSourceSnapshotReference } | undefined,
                    previous = audit?.sourceRecordIdsReference,
                    custodian = previous?.source.intakeId ?? intakeId;
                  if (!custodian)
                    throw Error('A selected whole record cannot require a contribution split');
                  const factory = factoryFor(custodian),
                    key = ownershipHash([item.kind, item.recordId]);
                  const ids = function* (selected?: boolean) {
                    for (const row of selection.sql
                      .prepare(
                        'SELECT source_id FROM preview_contributions WHERE record_key=?' +
                          (selected === undefined ? '' : ' AND selected=?') +
                          ' ORDER BY ordinal',
                      )
                      .iterate(...(selected === undefined ? [key] : [key, Number(selected)])))
                      yield String(row.source_id);
                  };
                  const snapshots = await factory.prepareSplit({
                    previous,
                    sourceRecordIds: () => ids(),
                    movingSourceRecordIds: () => ids(true),
                  });
                  await factory.finishMaintenance();
                  selection.sql
                    .prepare('INSERT INTO ownership_lineage VALUES(?,?,?)')
                    .run(
                      key,
                      JSON.stringify(snapshots.moving),
                      JSON.stringify(snapshots.remaining),
                    );
                }
                identitySnapshots = await prepareOwnershipIdentitySnapshots(db, selection.sql, {
                  factory: factoryFor,
                  record: async (intakeId, recordId) => {
                    await prepareReviewSource(intakeId, recordId);
                    return reviewSource(intakeId, recordId).record(recordId);
                  },
                  ...(report
                    ? { report: { intakeId: report.intakeId, groupId: report.groupId } }
                    : {}),
                  sources: (function* () {
                    for (const item of store.records)
                      if (item.action !== 'unchanged')
                        for (const c of iterateOwnershipStreamContributions(
                          db,
                          item.kind,
                          item.recordId,
                          {
                            scopes: scopes.contributionValues.bind(scopes),
                          },
                        ))
                          yield {
                            intakeId: c.intakeId,
                            recordId: c.sourceRecordId,
                            identity: c.identity,
                          };
                    for (const recordId of selection.occurrences())
                      yield { intakeId: intakeId!, recordId, reportMember: true };
                  })(),
                });
                assertCurrent();
                plan!.assertCurrent();
                snapshotPrepared = true;
                this.stageSourceSnapshots();
              },
              { operation: currentClinicalOperation(db) },
            );
          },
          identityIssues(intakeId: string, recordId: string) {
            if (!identitySnapshots) throw Error('Identity authority preparation required');
            return identitySnapshots.forSource(intakeId, recordId);
          },
          reportIdentityIssues() {
            if (!identitySnapshots) throw Error('Identity authority preparation required');
            return identitySnapshots.forReport();
          },
          sourceSnapshots(kind: string, recordId: string) {
            if (!snapshotPrepared)
              throw Error('Ownership source snapshots require completed preparation');
            const row = selection.sql
              .prepare('SELECT moving,remaining FROM ownership_lineage WHERE record_key=?')
              .get(ownershipHash([kind, recordId]));
            if (!row) throw Error('Ownership split source snapshots are unavailable');
            return {
              moving: JSON.parse(String(row.moving)) as OwnershipSourceSnapshotReference,
              remaining: JSON.parse(String(row.remaining)) as OwnershipSourceSnapshotReference,
            };
          },
          stageSourceSnapshots() {
            if (!snapshotPrepared)
              throw Error('Ownership source snapshots require completed preparation');
            assertCurrent();
            plan!.assertCurrent();
            for (const row of selection.sql
              .prepare('SELECT moving,remaining FROM ownership_lineage ORDER BY record_key')
              .iterate()) {
              assertOwnershipSourceSnapshot(db, JSON.parse(String(row.moving)));
              assertOwnershipSourceSnapshot(db, JSON.parse(String(row.remaining)));
            }
            identitySnapshots!.assertCurrent();
          },
          reference,
          boundary: selection.boundary,
          occurrences: selection.occurrences,
          assertCurrent: assertPreparedCurrent,
          finalize: refresh,
          finalizeVerified() {
            // This fixed callback owns the preview-row updates made by finalize.
            return withVerified(refresh, 'publication');
          },
          withVerifiedRead<T>(complete: () => T) {
            return withVerified(complete, 'read-only');
          },
          withVerifiedPublication<T>(complete: () => T) {
            return withVerified(complete, 'publication');
          },
          requestForGroup(group: OwnershipPreview['commitGroups'][number]): OwnershipRequest {
            // The approved parent can be read after an earlier independent child commits.
            // Each child reselects and checks its own current clinical authority.
            if (request.selection.type !== 'records')
              throw Error('A report is one indivisible ownership group');
            const ids = new Set(group.recordIds),
              decisions: NonNullable<OwnershipRequest['decisions']> = [];
            for (const id of ids) {
              const choice = decision(id);
              if (choice) decisions.push(choice);
            }
            return {
              ...request,
              selection: {
                type: 'records',
                records: request.selection.records.filter((record) => ids.has(record.recordId)),
              },
              decisions,
              relationshipDecisions: [],
              nameDecisions: [],
            };
          },
          *relationshipChoicesForGroup(group: OwnershipPreview['commitGroups'][number]) {
            const ids = new Set(group.recordIds);
            for (const row of selection.sql
              .prepare(
                'SELECT r.id,r.value FROM preview_relationships r JOIN relationship_choices c ON c.id=r.id ORDER BY r.ordinal',
              )
              .iterate()) {
              const relation = JSON.parse(
                String(row.value),
              ) as OwnershipPreview['relationships'][number];
              if (ids.has(relation.recordId) || ids.has(relation.otherRecordId))
                yield { decisionId: String(row.id), action: 'withdraw' as const };
            }
          },
          *choices() {
            assertCurrent();
            for (const row of selection.sql
              .prepare('SELECT id,value FROM record_choices ORDER BY id')
              .iterate())
              yield { recordId: String(row.id), decision: JSON.parse(String(row.value)) };
            for (const row of selection.sql
              .prepare('SELECT id FROM relationship_choices ORDER BY id')
              .iterate())
              yield { relationshipId: String(row.id), withdraw: true };
          },
          async choose(input: unknown) {
            return runExclusiveClinicalOperation(
              db,
              async () => {
                await withVerified(() => undefined, 'read-only');
                if (!object(input))
                  throw new HttpError(
                    400,
                    'OWNERSHIP_DECISION',
                    'Choose one displayed report decision',
                  );
                const restoreArtifacts = artifacts.checkpoint();
                const restore = store.checkpoint(),
                  previousHeader = header,
                  previousReference = { ...reference };
                selection.sql.exec('SAVEPOINT ownership_choice');
                artifactScratch.db.exec('SAVEPOINT ownership_choice');
                try {
                  let recordId: string;
                  if (
                    'recordId' in input &&
                    typeof input.recordId === 'string' &&
                    object(input.decision) &&
                    Object.keys(input).every((key) => ['recordId', 'decision'].includes(key))
                  ) {
                    recordId = input.recordId;
                    if (!store.sink.hasRecord(recordId))
                      throw new HttpError(
                        400,
                        'OWNERSHIP_DECISION',
                        'The record is outside this complete report selection',
                      );
                    const parsed = ownershipRequest({
                      ...request,
                      decisions: [{ ...decision(recordId), ...input.decision, recordId }],
                    }).decisions![0]!;
                    selection.sql
                      .prepare(
                        'INSERT INTO record_choices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                      )
                      .run(recordId, JSON.stringify(parsed));
                  } else if (
                    'relationshipId' in input &&
                    typeof input.relationshipId === 'string' &&
                    typeof input.withdraw === 'boolean' &&
                    Object.keys(input).every((key) => ['relationshipId', 'withdraw'].includes(key))
                  ) {
                    const row = selection.sql
                      .prepare('SELECT value FROM preview_relationships WHERE id=?')
                      .get(input.relationshipId);
                    if (!row)
                      throw new HttpError(
                        400,
                        'OWNERSHIP_DECISION',
                        'The relationship is outside this complete report selection',
                      );
                    recordId = (
                      JSON.parse(String(row.value)) as OwnershipPreview['relationships'][number]
                    ).recordId;
                    if (input.withdraw)
                      selection.sql
                        .prepare('INSERT OR IGNORE INTO relationship_choices VALUES(?)')
                        .run(input.relationshipId);
                    else
                      selection.sql
                        .prepare('DELETE FROM relationship_choices WHERE id=?')
                        .run(input.relationshipId);
                  } else
                    throw new HttpError(
                      400,
                      'OWNERSHIP_DECISION',
                      'Choose one displayed report decision',
                    );
                  const affected = selection.sql
                    .prepare(
                      "SELECT s.kind,s.record_id FROM sorted s WHERE s.record_id=? OR EXISTS(SELECT 1 FROM preview_relationships r WHERE (json_extract(r.value,'$.recordId')=? OR json_extract(r.value,'$.otherRecordId')=?) AND (s.record_id=json_extract(r.value,'$.recordId') OR s.record_id=json_extract(r.value,'$.otherRecordId'))) ORDER BY s.rank",
                    )
                    .iterate(recordId, recordId, recordId);
                  for (const row of affected) {
                    assertCurrent();
                    await previewRecordOwnershipPrepared(
                      db,
                      root,
                      profileId,
                      request,
                      scopeOptions([
                        {
                          kind: row.kind as import('./clinical-references.ts').ClinicalKind,
                          recordId: String(row.record_id),
                        },
                      ]),
                      assertCurrent,
                    );
                    await setImmediate();
                  }
                  holds = await prepareHolds();
                  await withVerified(refresh, 'publication');
                  selection.sql.exec('RELEASE ownership_choice');
                  artifactScratch.db.exec('RELEASE ownership_choice');
                } catch (error) {
                  try {
                    selection.sql.exec('ROLLBACK TO ownership_choice; RELEASE ownership_choice');
                    artifactScratch.db.exec(
                      'ROLLBACK TO ownership_choice; RELEASE ownership_choice',
                    );
                  } catch {
                    /* Profile lock can close the disposable plan while preparation yields. */
                  }
                  restoreArtifacts();
                  restore();
                  header = previousHeader;
                  Object.assign(reference, previousReference);
                  throw error;
                }
              },
              { operation: currentClinicalOperation(db) },
            );
          },
          assertForTransaction() {
            assertPreparedCurrent();
            stageToken = currentTransactionToken(db);
            if (!stageToken)
              throw Error('Report publication requires its owned atomic transaction');
            if (terminalPhysicalCurrent) {
              const witness = selectionWitness(),
                physicalCurrent = terminalPhysicalCurrent;
              stopTerminalGuard = installTransactionTerminalGuard(db, stageToken, () => {
                physicalCurrent();
                if (selectionWitness() !== witness)
                  throw new HttpError(
                    409,
                    'OWNERSHIP_CHANGED',
                    'Ownership preview changed during publication',
                  );
              });
            }
          },
          preview(): OwnershipCommitView {
            if (!stageToken || stageToken !== currentTransactionToken(db))
              throw Error('Report preview belongs to another transaction');
            assertPreparedCurrent();
            return {
              ...header,
              records: store.records,
              pending: store.pending,
              relationships: store.relationships,
              reportHolds: holds,
            };
          },
          publicPreview(): OwnershipReportPreviewReference {
            assertPreparedCurrent();
            const {
              records,
              pending,
              names,
              relationships,
              commitGroups,
              blockers: legacyBlockers,
              reportHolds,
              ...rest
            } = header;
            const blockerEvidence = (header as OwnershipCommitView).blockerEvidence;
            void legacyBlockers;
            void records;
            void pending;
            void names;
            void relationships;
            void reportHolds;
            return {
              ...rest,
              blockers: blockerEvidence
                ? store.sink.blockerBucket('header', false).presentation()
                : [],
              namesIncluded: false,
              nameEvidence: plan!.reference,
              recordsIncluded: false,
              pendingIncluded: false,
              relationshipsIncluded: false,
              reportHoldsIncluded: false,
              reportEvidence: reference,
              commitGroups: commitGroups.map((group) => ({
                id: group.id,
                atomic: true,
                recordTotal: report ? reference.recordTotal : group.recordIds.length,
                pendingCount: group.pendingCount,
                url: reference.url,
              })),
            };
          },
          contributionPage(
            key: string,
            source: string | null,
            after = -1,
            limit = 16,
            bytes = 65536,
          ) {
            assertCurrent();
            plan!.assertCurrent();
            if (
              !/^[a-f0-9]{64}$/.test(key) ||
              !Number.isSafeInteger(after) ||
              after < -1 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 32 ||
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > 65536
            )
              throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid contribution evidence page');
            const table = source === null ? 'preview_contributions' : 'preview_contribution_scopes',
              predicate = 'record_key=?' + (source === null ? '' : ' AND source_id=?'),
              parameters = source === null ? [key] : [key, source],
              total = Number(
                selection.sql
                  .prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE ' + predicate)
                  .get(...parameters)!.n,
              ),
              rows = selection.sql
                .prepare(
                  'SELECT ordinal,length(CAST(value AS BLOB)) bytes FROM ' +
                    table +
                    ' WHERE ' +
                    predicate +
                    ' AND ordinal>? ORDER BY ordinal LIMIT ?',
                )
                .all(...parameters, after, limit + 1);
            const items: unknown[] = [];
            let used = 0;
            for (const row of rows.slice(0, limit)) {
              if (Number(row.bytes) > bytes - used) {
                items.push({
                  type: 'contribution-fragment',
                  ordinal: Number(row.ordinal),
                  bytes: Number(row.bytes),
                  url:
                    evidenceUrl +
                    '?contribution=' +
                    key +
                    (source === null ? '' : '&source=' + encodeURIComponent(source)),
                });
                used += 256;
              } else {
                items.push(
                  JSON.parse(
                    String(
                      selection.sql
                        .prepare(
                          'SELECT value FROM ' + table + ' WHERE ' + predicate + ' AND ordinal=?',
                        )
                        .get(...parameters, row.ordinal)!.value,
                    ),
                  ),
                );
                used += Number(row.bytes);
              }
            }
            return {
              items,
              total,
              complete: rows.length <= limit,
              after: rows.length > limit ? String(rows[limit - 1]!.ordinal) : null,
            };
          },
          contributionFragment(
            key: string,
            source: string | null,
            ordinal: number,
            offset: number,
            bytes = 32768,
          ) {
            assertCurrent();
            plan!.assertCurrent();
            if (
              !/^[a-f0-9]{64}$/.test(key) ||
              !Number.isSafeInteger(ordinal) ||
              ordinal < 0 ||
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > 32768
            )
              throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid contribution fragment cursor');
            const table = source === null ? 'preview_contributions' : 'preview_contribution_scopes',
              predicate = 'record_key=?' + (source === null ? '' : ' AND source_id=?'),
              parameters = source === null ? [key] : [key, source];
            const row = selection.sql
              .prepare(
                'SELECT length(CAST(value AS BLOB)) bytes,substr(CAST(value AS BLOB),?,?) data FROM ' +
                  table +
                  ' WHERE ' +
                  predicate +
                  ' AND ordinal=?',
              )
              .get(offset + 1, bytes, ...parameters, ordinal);
            if (!row || offset > Number(row.bytes))
              throw new HttpError(
                400,
                'OWNERSHIP_CURSOR',
                'Contribution fragment is outside selected evidence',
              );
            const data = Buffer.from(row.data as Uint8Array),
              nextOffset = offset + data.length;
            return {
              encoding: 'base64' as const,
              data: data.toString('base64'),
              complete: nextOffset === Number(row.bytes),
              nextOffset,
            };
          },
          fragment(
            section: 'records' | 'pending' | 'relationships' | 'holds',
            ordinal: number,
            offset: number,
            bytes = 65536,
          ) {
            assertCurrent();
            plan!.assertCurrent();
            if (
              !['records', 'pending', 'relationships', 'holds'].includes(section) ||
              !Number.isSafeInteger(ordinal) ||
              ordinal < 0 ||
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > 65536
            )
              throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report fragment cursor');
            const row = selection.sql
              .prepare(
                'SELECT length(CAST(value AS BLOB)) bytes,substr(CAST(value AS BLOB),?,?) data FROM preview_' +
                  section +
                  ' WHERE ordinal=?',
              )
              .get(offset + 1, bytes, ordinal);
            if (!row || offset > Number(row.bytes))
              throw new HttpError(
                400,
                'OWNERSHIP_CURSOR',
                'Report fragment is outside selected evidence',
              );
            const data = Buffer.from(row.data as Uint8Array),
              nextOffset = offset + data.byteLength;
            return {
              encoding: 'base64' as const,
              data: data.toString('base64'),
              complete: nextOffset === Number(row.bytes),
              nextOffset,
            };
          },
          page(
            section: 'records' | 'pending' | 'relationships' | 'holds',
            after = -1,
            limit = 32,
            bytes = 65536,
          ) {
            assertCurrent();
            plan!.assertCurrent();
            if (
              !Number.isSafeInteger(after) ||
              after < -1 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > 32 ||
              !Number.isSafeInteger(bytes) ||
              bytes < 1 ||
              bytes > 65536
            )
              throw new HttpError(400, 'OWNERSHIP_CURSOR', 'Invalid report evidence page');
            const table = 'preview_' + section,
              total =
                section === 'records'
                  ? reference.recordTotal
                  : section === 'pending'
                    ? reference.pendingTotal
                    : section === 'relationships'
                      ? reference.relationshipTotal
                      : reference.reportHoldTotal;
            const rows = selection.sql
                .prepare(
                  'SELECT ordinal,length(CAST(value AS BLOB)) bytes FROM ' +
                    table +
                    ' WHERE ordinal>? ORDER BY ordinal LIMIT ?',
                )
                .all(after, limit + 1),
              more = rows.length > limit;
            const items: import('../shared/ownership-report-reference.ts').OwnershipReportPageItem[] =
              [];
            let used = 0;
            for (const row of rows.slice(0, limit)) {
              const size = Number(row.bytes);
              if (size > bytes - used) {
                items.push({
                  type: 'reference',
                  section,
                  ordinal: Number(row.ordinal),
                  bytes: size,
                  token,
                  url: reference.url,
                });
                used += 128;
              } else {
                const value = selection.sql
                  .prepare('SELECT value FROM ' + table + ' WHERE ordinal=?')
                  .get(row.ordinal)!;
                items.push(JSON.parse(String(value.value)));
                used += size;
              }
            }
            return {
              items,
              total,
              complete: !more,
              after: more ? String(rows[limit - 1]!.ordinal) : null,
            };
          },
          close() {
            if (closed) return;
            closed = true;
            if (recordReadOwner) closeRecordReadOwner(recordReadOwner);
            retainedReview?.close();
            plan!.close();
            selection.close();
            artifactScratch.close();
          },
        };
        originalProofOwners.set(prepared, {
          db,
          profileId,
          current: () => !closed && db.isOpen && artifactScratch.db.isOpen,
          capture: () => artifacts.captureVerifiedArtifacts(),
        });
        returnedPlan = prepared;
        if (recordReadOwnerSupported(db, profileId)) {
          recordReadOwner = captureRecordReadOwner(db, profileId);
          readOwners.set(prepared, {
            db,
            profileId,
            sql: selection.sql,
            record: recordReadOwner,
            current: () => !closed && db.isOpen && selection.sql.isOpen,
            ownsTerminal: (proof) => artifacts.ownsReadTerminal(proof),
          });
        }
        return prepared;
      } catch (error) {
        closed = true;
        if (recordReadOwner) closeRecordReadOwner(recordReadOwner);
        retainedReview?.close();
        plan?.close();
        selection.close();
        artifactScratch.close();
        if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
        throw error;
      }
    },
    { operation: currentClinicalOperation(db), onDiscardResult: (value) => value.close() },
  );
}
export type PreparedOwnershipReportPlan = Awaited<ReturnType<typeof prepareOwnershipReportPlan>>;
