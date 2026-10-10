import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
/** Native report approval prepares bounded selected blocks before one commit. */
import { HttpError, type Database } from './database.ts';
import { observeIntakePairPreparation } from './intake-pair-preparation.ts';
import {
  assertIntakeOwner,
  flushIntake,
  intakeTransaction,
  withVerifiedIntakeOriginalDescriptor,
} from './intake.ts';
import { buildIntakeCollectionEnvelope } from './intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  hasIntakeCollectionEnvelope,
} from './intake-collection-envelope.ts';
import {
  intakeSourceMetadata,
  intakeSourceVersion,
  maximumReportDiscoveryOrder,
} from './intake-state-access.ts';
import { activeMappingRules } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import {
  prepareRetainedPlanAccess,
  prepareRetainedPlanDerived,
  readRetainedPlanEvidence,
} from './intake-retained-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import { collectionClinicalProjectionContextAsync } from './intake-review-collection-session.ts';
import {
  prepareNativeIntakeAcceptanceGroup,
  type NativeAcceptanceGroupMember,
} from './intake-collection-acceptance-group.ts';
import { buildReportContextLookup } from './intake-report-context.ts';
import { prepareSourceContextClassificationDerived } from './intake-source-context-state.ts';
import { prepareWorkflowAcceptanceDerived } from './intake-workflow-update.ts';
import { prepareIntakeLookupIndices } from './intake-lookup-projection.ts';
import {
  consumeIntakeDiscoveryAdmission,
  disposeIntakeDiscoveryAdmission,
  prepareIntakeDiscoveryAdmission,
} from './intake-discovery-admission.ts';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
  IntakeAtomicAcceptanceReceipt,
  IntakeReview,
} from '../shared/intake.ts';
import { canonicalLiteral } from './intake-format.ts';
import { nativeDuplicateRecord, intakePairScope } from './duplicate-review.ts';
import { durableSelectionInputs } from './intake-selection-authority.ts';

export function hasNativeAcceptanceBlock(db: Database, selected: IntakeReportAcceptanceRequest) {
  return selected.blocks.some(
    (block) =>
      db
        .prepare("SELECT 1 FROM source_files WHERE id=? AND kind='intake_original'")
        .get(block.intakeId) && hasIntakeCollectionEnvelope(db, { id: block.intakeId }),
  );
}

export async function applyNativeAcceptanceGroup(
  db: Database,
  root: string,
  profileId: string,
  selected: IntakeReportAcceptanceRequest,
  fingerprint: string,
  options: {
    retainResult?: (receipt: IntakeAtomicAcceptanceReceipt) => void;
    reviewed?: Map<string, IntakeReview | null>;
  } = {},
): Promise<IntakeReportAcceptanceResult> {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      assertIntakeOwner(db, profileId);
      const pairPreparation = observeIntakePairPreparation(db);
      const reviewedAtEntry = new Set<IntakeReportAcceptanceRequest['blocks'][number]>();
      try {
        // Fresh requests must be current at entry; retained/partial choices have
        // their separate exact-selection proof below.
        if (!options.retainResult)
          for (const block of selected.blocks) {
            for (const selection of block.selections) {
              if (selection.useRetainedDecision) continue;
              for (const comparison of selection.comparisons || [])
                pairPreparation.capture(comparison.scope, block.intakeVersion);
            }
            // A complete review includes generated pair transport pins even when
            // no comparison choice is submitted. Verify the exact human-reviewed
            // token before our own auxiliary publications can advance those pins.
            // The observer below permits only certified, domain-invisible writes;
            // an ordinary write (including one imitating a maintenance actor)
            // invalidates this proof before any refreshed token can be used.
            if (!hasIntakeCollectionEnvelope(db, { id: block.intakeId })) continue;
            const entry = await prepareCollectionClinicalReviewAsync(
              db,
              root,
              profileId,
              block.intakeId,
              block.proposalId,
              { assertRunning: () => pairPreparation.assertCurrent() },
            );
            if (entry.status !== 'ready') continue;
            try {
              pairPreparation.assertCurrent();
              if (entry.session.review.reviewToken !== block.reviewToken)
                throw new HttpError(
                  409,
                  'REVIEW_CHANGED',
                  'Refresh the complete selected review before approving its choices',
                );
              reviewedAtEntry.add(block);
            } finally {
              entry.session.close();
            }
          }
      } catch (error) {
        pairPreparation.dispose();
        throw error;
      }
      const sessions: import('./intake-review-collection-session.ts').CollectionClinicalReviewSession[] =
        [];
      const ids = [...new Set(selected.blocks.map((block) => block.intakeId))];
      // Preserve every physical source witness until the ordinary group commit.
      const leases: Array<() => void> = [];
      const assertRunning = () => {
        assertIntakeOwner(db, profileId);
        pairPreparation.assertCurrent();
        for (const check of leases) check();
      };
      async function acquire(at: number): Promise<IntakeReportAcceptanceResult> {
        if (at < ids.length)
          return withVerifiedIntakeOriginalDescriptor(
            { db, root, profileId, id: ids[at]! },
            async (source) => {
              leases.push(source.assertRunning);
              try {
                return await acquire(at + 1);
              } finally {
                leases.pop();
              }
            },
          );
        const mappings = new Map<string, { value: string; current: () => string }>();
        for (const id of ids) {
          if (!hasIntakeCollectionEnvelope(db, { id }))
            await buildIntakeCollectionEnvelope(db, { id }, { assertRunning });
          await prepareRetainedPlanAccess(db, profileId, id, { assertRunning });
          const current = () => {
            const file = db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(id);
            if (!file) throw new HttpError(404, 'NOT_FOUND', 'Selected original is missing');
            return workflowHash(
              activeMappingRules(
                db,
                intakeSourceMetadata(db, id).metadata?.sourceProviderId || String(file.provider_id),
              ),
            );
          };
          const value = current();
          mappings.set(id, { value, current });
          const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
            mappingVersion: value,
            currentMappingVersion: current,
            assertRunning,
          });
          if (ready.state !== 'ready')
            throw new HttpError(
              409,
              'WORKFLOW_PREPARATION_REQUIRED',
              'Prepare the retained report evidence before accepting it',
            );
        }
        for (const block of selected.blocks)
          await prepareCollectionClinicalReviewDependencies(
            db,
            root,
            profileId,
            block.intakeId,
            block.proposalId,
            { assertRunning },
          );
        const { prepareClinicalSourceFingerprintIndex } =
          await import('./intake-clinical-source-index.ts');
        await prepareClinicalSourceFingerprintIndex(db, { assertRunning });
        const lookup = await prepareIntakeLookupIndices(db, { assertRunning });
        let discoveryOrder = maximumReportDiscoveryOrder(db);
        const members: NativeAcceptanceGroupMember[] = [];
        for (const block of selected.blocks) {
          assertRunning();
          const version = intakeSourceVersion(db, block.intakeId);
          if (!options.retainResult && version.version !== block.intakeVersion)
            throw new HttpError(
              409,
              'VERSION_CONFLICT',
              'This intake changed. Reload it before continuing.',
            );
          if (
            options.retainResult &&
            options.reviewed?.get(canonicalLiteral([block.intakeId, block.proposalId])) === null
          )
            throw new HttpError(
              409,
              'SELECTION_REVIEW_CHANGED',
              'This selection could not be reviewed. Refresh its exact record before saving.',
            );
          const result = await prepareCollectionClinicalReviewAsync(
            db,
            root,
            profileId,
            block.intakeId,
            block.proposalId,
            { assertRunning },
          );
          if (result.status !== 'ready')
            throw new HttpError(
              409,
              'REVIEW_PREPARATION_REQUIRED',
              'Prepare the selected clinical evidence before accepting records',
            );
          sessions.push(result.session);
          const session = result.session,
            context = await collectionClinicalProjectionContextAsync(session),
            view = openIntakeCollectionEnvelope(db, { id: block.intakeId }),
            intake = view.child(view.root(), 'intake')!,
            flow = view.child(intake, 'workflow');
          for (const selection of block.selections) {
            const candidate = flow && view.find('candidate', flow, selection.candidateId),
              count = candidate ? view.childCount(candidate, 'versions') : 0,
              latest =
                candidate && count ? view.childAt(candidate, 'versions', count - 1) : undefined;
            const value = (name: string) => {
              if (!latest) return undefined;
              const field = view.field(latest, name, { bytes: 8192 });
              return field.kind === 'value' ? field.value : undefined;
            };
            const record = session.record(selection.recordId);
            if (
              !latest ||
              value('id') !== selection.candidateVersionId ||
              value('status') !== 'pending' ||
              value('sourceContext') === true ||
              !record ||
              record.candidateId !== selection.candidateId ||
              record.candidateVersionId !== selection.candidateVersionId ||
              record.reviewState === 'accepted' ||
              record.reviewState === 'kept_original'
            )
              throw new HttpError(
                409,
                'REPORT_ACCEPTANCE_STALE',
                'Select the current pending candidate version from its exact retained proposal',
              );
            if (
              (options.retainResult || selection.useRetainedDecision) &&
              record.selectionReviewToken !== selection.selectionReviewToken
            )
              throw new HttpError(
                409,
                'SELECTION_REVIEW_CHANGED',
                'This record or its source/person dependencies changed. Review this exact record again.',
              );
            // A partial manifest advances transport revisions before this group.
            // Its exact selection proof above includes the complete retained draft.
            if (
              selection.useRetainedDecision &&
              !options.retainResult &&
              !reviewedAtEntry.has(block) &&
              block.reviewToken !== session.review.reviewToken
            )
              throw new HttpError(
                409,
                'REVIEW_CHANGED',
                'Refresh the retained draft before approving its choices',
              );
          }
          const evidence = readRetainedPlanEvidence(db, profileId, block.intakeId);
          members.push({
            session,
            expectedVersion: options.retainResult ? version.version : block.intakeVersion,
            reviewToken:
              options.retainResult || reviewedAtEntry.has(block)
                ? session.review.reviewToken
                : block.reviewToken,
            decisions: block.selections.map((selection) => {
              const record = session.record(selection.recordId)!;
              if (
                selection.useRetainedDecision &&
                record.draft?.decision &&
                record.draft.decision.action !== 'accept'
              )
                throw new HttpError(
                  409,
                  'REVIEW_CHANGED',
                  'Review the retained decision before accepting this record',
                );
              const selectedComparisons = selection.useRetainedDecision
                ? record.draft?.decision?.comparisons
                : selection.comparisons;
              const comparisons = selectedComparisons?.map((decision) => {
                const fresh =
                  !options.retainResult &&
                  !selection.useRetainedDecision &&
                  decision.scope?.format === 'intake-pair-scope-v2';
                if (!options.retainResult && !selection.useRetainedDecision && !fresh)
                  return decision;
                assertRunning();
                const incoming = record.comparisonReference;
                const current = incoming
                  ? intakePairScope(
                      db,
                      { ...incoming, id: record.id, evidence: record.evidence },
                      nativeDuplicateRecord(db, incoming.kind, decision.otherRecordId),
                      record.comparisonContextHash
                        ? {
                            intakeVersion: session.review.version,
                            contextHash: record.comparisonContextHash,
                          }
                        : undefined,
                    )
                  : undefined;
                if (fresh)
                  return { ...decision, scope: pairPreparation.refresh(decision.scope, current) };
                if (
                  !current ||
                  canonicalLiteral(durableSelectionInputs(decision.scope)) !==
                    canonicalLiteral(durableSelectionInputs(current))
                )
                  throw new HttpError(
                    409,
                    'DUPLICATE_SCOPE_CHANGED',
                    'Compare the changed destination record again.',
                  );
                return { ...decision, scope: current };
              });
              return {
                recordId: selection.recordId,
                action: 'accept' as const,
                mapping: selection.useRetainedDecision
                  ? (record.draft?.decision?.mapping ?? {})
                  : selection.mapping,
                comparisons,
              };
            }),
            reportEvidence: {
              packageEvidence: evidence.packageEvidence,
              hasMember: evidence.hasMember,
              contextLookup: buildReportContextLookup(context.proposal.entries),
            },
            nextDiscoveryOrder: () => ++discoveryOrder,
          });
        }
        const publicationChecks = new Map<string, () => void>();
        const prepared = await prepareNativeIntakeAcceptanceGroup(db, root, profileId, {
          members,
          operationId: selected.operationId,
          fingerprint,
          assertRunning,
          retainReportReceipt: !options.retainResult,
          async prepareDerived(source, derived) {
            const mapping = mappings.get(source.id)!;
            const candidates = new Map(
              derived.affected.candidateChanges.map((item) => [item.versionAddress, item]),
            );
            for (const item of derived.acceptance.candidateChanges)
              if (candidates.get(item.versionAddress)?.kind !== 'append')
                candidates.set(item.versionAddress, item);
            const affected = {
              ...derived.affected,
              candidateChanges: [...candidates.values()],
              questionAddresses: [
                ...new Set([
                  ...derived.affected.questionAddresses,
                  ...derived.acceptance.questionAddresses,
                ]),
              ],
            };
            const plans = await prepareRetainedPlanDerived(db, profileId, source.id, {
              ...derived,
              impact: { kind: 'proposal' },
            });
            const classifier = await prepareSourceContextClassificationDerived(
              db,
              root,
              profileId,
              source.id,
              { ...derived, affected, impact: 'proposal', assertRunning },
            );
            if (classifier.state !== 'ready')
              throw Error('Acceptance classification changed during preparation');
            publicationChecks.set(source.id, classifier.assertPublicationCurrent);
            const result = await prepareWorkflowAcceptanceDerived(db, source, {
              ...derived,
              affected,
              mappingVersion: mapping.value,
              currentMappingVersion: mapping.current,
              isSourceContextVersion: classifier.isSourceContextVersion,
              additionalVersionIds: classifier.additionalVersionIds,
              assertRunning: () => {
                assertRunning();
                classifier.assertCurrent();
              },
            });
            return {
              changes: [...plans, ...classifier.changes, ...result.changes],
              needsReview: result.needsReview,
              receiptAppend: result.receiptAppend,
            };
          },
        });
        try {
          const admission = await prepareIntakeDiscoveryAdmission(db, lookup.discoveryRevision, {
            assertRunning,
          });
          try {
            const receipt = await prepared.withVerifiedPublication(() =>
              intakeTransaction(
                db,
                () => {
                  assertRunning();
                  for (const check of publicationChecks.values()) check();
                  consumeIntakeDiscoveryAdmission(db, admission);
                  const result = prepared.apply();
                  options.retainResult?.(result);
                  return result;
                },
                { operationId: selected.operationId, fingerprint },
              ),
            );
            return { receipt, replayed: false, durability: flushIntake(db, root, profileId) };
          } finally {
            disposeIntakeDiscoveryAdmission(admission);
          }
        } finally {
          prepared.dispose();
        }
      }
      try {
        return await acquire(0);
      } finally {
        pairPreparation.dispose();
        for (const session of sessions) session.close();
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
