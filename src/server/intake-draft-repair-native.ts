import { selectedReportGroups } from './intake-selected-report-groups.ts';
/** One reviewed repair command may append several ordered draft events, while
 * retaining their common history by reference and selecting one public version. */
import { HttpError, required, type Database } from './database.ts';
import type { IntakeDraftRepairUpdate, IntakeReviewDraft } from '../shared/intake.ts';
import {
  assertIntakeOwner,
  getIntakeRead,
  flushIntake,
  intakeTransaction,
  withVerifiedIntakeOriginalDescriptor,
} from './intake.ts';
import {
  selectedEnvelopeStore,
  hasIntakeCollectionEnvelope,
  openIntakeCollectionEnvelope,
} from './intake-collection-envelope.ts';
import { intakeSourceMetadata, intakeSourceVersion } from './intake-state-access.ts';
import { activeMappingRules, datePrecision } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import { validateDraftMapping } from './intake-review.ts';
import {
  retainedIntakeWorkflowCommand,
  prepareIntakeWorkflowCommand,
} from './intake-workflow-command.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import { collectionClinicalProjectionContext } from './intake-review-collection-session.ts';
import { prepareNativeDraftHistory } from './intake-review-draft-state.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { prepareWorkflowDraftDerived } from './intake-workflow-update.ts';
import { prepareSourceContextClassificationDerived } from './intake-source-context-state.ts';
import { prepareRetainedPlanDerived } from './intake-retained-plan.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';

const fields = new Set(['date', 'method', 'observationCategory']);
function validate(input: IntakeDraftRepairUpdate) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['version', 'operationId', 'groupId', 'corrections'].includes(key),
    ) ||
    !Number.isInteger(input.version) ||
    typeof input.operationId !== 'string' ||
    !input.operationId
  )
    throw new HttpError(400, 'OPERATION_ID', 'A stable draft repair operation ID is required');
  if (
    !input.groupId ||
    !Array.isArray(input.corrections) ||
    !input.corrections.length ||
    input.corrections.length > 100
  )
    throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Choose 1–100 exact pending draft fields');
  const seen = new Set<string>();
  for (const correction of input.corrections) {
    if (
      !correction ||
      typeof correction !== 'object' ||
      Array.isArray(correction) ||
      Object.keys(correction).some(
        (key) =>
          !['proposalId', 'recordId', 'candidateVersionId', 'field', 'before', 'after'].includes(
            key,
          ),
      ) ||
      !fields.has(correction.field) ||
      typeof correction.recordId !== 'string' ||
      typeof correction.candidateVersionId !== 'string' ||
      (correction.proposalId !== null && typeof correction.proposalId !== 'string') ||
      typeof correction.before !== 'string' ||
      typeof correction.after !== 'string' ||
      correction.after.length > 1000
    )
      throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Supply exact supported draft corrections');
    const key = JSON.stringify([
      correction.proposalId,
      correction.recordId,
      correction.candidateVersionId,
      correction.field,
    ]);
    if (seen.has(key))
      throw new HttpError(400, 'DRAFT_REPAIR_SCOPE', 'Each selected field may be corrected once');
    seen.add(key);
  }
  return seen.size;
}

export async function saveIntakeDraftRepairRead(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: IntakeDraftRepairUpdate,
) {
  const count = validate(input);
  assertIntakeOwner(db, profileId);
  const file = required(
    db
      .prepare(
        "SELECT id,sha256,provider_id,kind FROM source_files WHERE id=? AND kind='intake_original'",
      )
      .get(id) as { id: string; sha256: string; provider_id: string; kind: string } | undefined,
    'Source intake not found',
  );
  if (!hasIntakeCollectionEnvelope(db, file)) {
    const { saveIntakeDraftRepair } = await import('./intake.ts');
    return saveIntakeDraftRepair(db, root, profileId, id, input);
  }
  const { version: _version, ...request } = input;
  const response = () => ({
    ...getIntakeRead(db, root, profileId, id),
    durability: flushIntake(db, root, profileId),
  });
  if (retainedIntakeWorkflowCommand(db, file, { operationId: input.operationId, request }))
    return response();
  if (!Number.isSafeInteger(input.version) || intakeSourceVersion(db, id).version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  return withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id },
    async ({ assertRunning }) => {
      const mappingVersion = () =>
          workflowHash(
            activeMappingRules(
              db,
              intakeSourceMetadata(db, id).metadata?.sourceProviderId || file.provider_id,
            ),
          ),
        selectedMappingVersion = mappingVersion();
      const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
        mappingVersion: selectedMappingVersion,
        currentMappingVersion: mappingVersion,
        assertRunning,
      });
      if (ready.state !== 'ready')
        throw new HttpError(
          409,
          'WORKFLOW_PREPARATION_REQUIRED',
          'Prepare this retained review before repairing fields',
        );
      const reviews = new Map<
        string,
        Extract<ReturnType<typeof prepareCollectionClinicalReview>, { status: 'ready' }>
      >();
      try {
        const contexts: ReturnType<typeof collectionClinicalProjectionContext>[] = [];
        const view = openIntakeCollectionEnvelope(db, file);
        const latest = new Map<string, IntakeReviewDraft>();
        const drafts: IntakeReviewDraft[] = [];
        const catalog = createReportSnapshotCatalog(db, file, {
          catalog: 'review.snapshots',
          assertRunning,
        });
        const histories = new Map<string, NonNullable<IntakeReviewDraft['history']>>();
        for (const correction of input.corrections) {
          assertRunning();
          const proposalKey = correction.proposalId || '';
          let selected = reviews.get(proposalKey);
          if (!selected) {
            await prepareCollectionClinicalReviewDependencies(
              db,
              root,
              profileId,
              id,
              correction.proposalId,
              { assertRunning },
            );
            const prepared = prepareCollectionClinicalReview(
              db,
              root,
              profileId,
              id,
              correction.proposalId,
            );
            if (prepared.status !== 'ready')
              throw new HttpError(
                409,
                'REVIEW_PREPARATION_REQUIRED',
                'Prepare the complete selected evidence before repairing fields',
              );
            selected = prepared;
            reviews.set(proposalKey, selected);
            contexts.push(collectionClinicalProjectionContext(selected.session));
          }
          const record = required(
            selected.session.record(correction.recordId),
            'Selected draft does not belong to this proposal',
          );
          if (record.candidateVersionId !== correction.candidateVersionId)
            throw new HttpError(
              409,
              'DRAFT_REPAIR_STALE',
              'A selected draft changed. Review the current fields before applying this correction.',
            );
          if (
            !selectedReportGroups(record.reportGroups).some(
              (group) => group.groupId === input.groupId,
            )
          )
            throw new HttpError(
              409,
              'DRAFT_REPAIR_SCOPE',
              'Selected drafts no longer share the reviewed report boundary',
            );
          if (record.reviewState === 'accepted' || record.reviewState === 'kept_original')
            throw new HttpError(409, 'DRAFT_REPAIR_STATE', 'Only pending drafts can be corrected');
          if (
            (correction.field === 'date' &&
              record.mapping.kind !== 'observation' &&
              record.mapping.kind !== 'procedure') ||
            ((correction.field === 'method' || correction.field === 'observationCategory') &&
              record.mapping.kind !== 'observation')
          )
            throw new HttpError(
              400,
              'DRAFT_REPAIR_FIELD',
              'That correction field does not apply to this draft kind',
            );
          if (correction.field === 'date') datePrecision(correction.after);
          else if (!correction.after.trim())
            throw new HttpError(400, 'DRAFT_REPAIR_FIELD', 'Method and category cannot be blank');
          const key = JSON.stringify([correction.proposalId, record.id, record.candidateVersionId]);
          const previous = latest.get(key) ?? record.draft;
          const currentMapping = {
            ...record.mapping,
            ...previous?.mapping,
            ...previous?.decision?.mapping,
          };
          if (String(currentMapping[correction.field] ?? '') !== correction.before)
            throw new HttpError(
              409,
              'DRAFT_REPAIR_STALE',
              'A selected field changed. Review the current value before applying this correction.',
            );
          const patch = validateDraftMapping(
            { [correction.field]: correction.after },
            record.mapping,
          );
          const draft: IntakeReviewDraft = {
            id: `${input.operationId}:${count}:${correction.recordId}:${correction.field}`,
            proposalId: correction.proposalId,
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            mapping: { ...previous?.mapping, ...patch },
            ...(previous?.corrections ? { corrections: previous.corrections } : {}),
            resolutions: previous?.resolutions ?? [],
            disposition: previous?.disposition ?? 'pending',
            ...(previous?.decision
              ? {
                  decision: {
                    ...previous.decision,
                    mapping: { ...previous.decision.mapping, ...patch },
                  },
                }
              : {}),
            answers: previous?.answers ?? {},
            at: new Date().toISOString(),
          };
          let history = histories.get(key);
          if (!history) {
            const previousRecord = view.lookup('draft-record-version-last', [
              proposalKey,
              record.id,
              record.candidateVersionId!,
            ]);
            const prepared = await prepareNativeDraftHistory(
              db,
              file,
              view,
              previousRecord,
              { ...draft, resolutions: [], corrections: [] },
              {
                assertRunning,
                catalog,
              },
            );
            history = prepared.draft.history!;
            histories.set(key, history);
          }
          const saved: IntakeReviewDraft = {
            ...draft,
            format: 'health-intake-review-draft-v2',
            history,
            resolutions: [],
            corrections: [],
          };
          drafts.push(saved);
          latest.set(key, saved);
        }
        const affected: NativeProposalAffected = {
            candidateChanges: [],
            questionAddresses: [],
            reportGroupAddresses: [],
            proposalIds: [],
          },
          draftAddresses: string[] = [];
        let assertDerived: (() => void) | undefined;
        const prepared = await prepareIntakeWorkflowCommand(db, file, {
          version: input.version,
          operationId: input.operationId,
          request,
          createdAt: drafts[0]!.at,
          additionalLogicalChanges: await catalog.finalChanges(),
          assertRunning() {
            assertRunning();
            catalog.assertCurrent();
            for (const context of contexts) context.assertCurrent();
          },
          *changes({ reader, workflow }) {
            const touched = new Set<string>();
            for (const draft of drafts) {
              yield {
                op: 'append',
                record: workflow,
                field: 'reviewDrafts',
                jsonText: JSON.stringify(draft),
              };
              draftAddresses.push(
                reader.address(
                  reader.childAt(
                    workflow,
                    'reviewDrafts',
                    reader.childCount(workflow, 'reviewDrafts') - 1,
                  )!,
                ),
              );
              const candidate = reader.find('candidate', workflow, draft.candidateId),
                version = candidate && reader.find('version', candidate, draft.candidateVersionId);
              if (!candidate || !version) throw Error('Selected repair candidate is unavailable');
              const address = reader.address(version);
              if (!touched.has(address)) {
                touched.add(address);
                affected.candidateChanges.push({
                  candidateId: draft.candidateId,
                  candidateVersionId: draft.candidateVersionId,
                  candidateAddress: reader.address(candidate),
                  versionAddress: address,
                  kind: 'update',
                });
              }
            }
          },
          async prepareDerived(derived) {
            const plans = await prepareRetainedPlanDerived(db, profileId, id, {
              ...derived,
              impact: { kind: 'proposal' },
            });
            const classifier = await prepareSourceContextClassificationDerived(
              db,
              root,
              profileId,
              id,
              { ...derived, affected, impact: 'proposal', assertRunning },
            );
            if (classifier.state !== 'ready')
              throw Error('Repair classification changed during preparation');
            assertDerived = classifier.assertPublicationCurrent;
            const result = await prepareWorkflowDraftDerived(db, file, {
              ...derived,
              affected,
              draftAddresses,
              decisionAddresses: [],
              resolutionChanges: [],
              mappingVersion: selectedMappingVersion,
              currentMappingVersion: mappingVersion,
              isSourceContextVersion: classifier.isSourceContextVersion,
              additionalVersionIds: classifier.additionalVersionIds,
              assertRunning() {
                assertRunning();
                classifier.assertCurrent();
              },
            });
            return [...plans, ...classifier.changes, ...result.changes];
          },
        });
        if (!prepared.replayed)
          intakeTransaction(
            db,
            () => {
              prepared.assertCurrent();
              catalog.assertCurrent();
              assertDerived?.();
              for (const context of contexts) context.assertCurrent();
              selectedEnvelopeStore(db, file).collections.stage(prepared.prepared);
            },
            { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
          );
        // The selected scope above is bound to the old root; it is never reused as a
        // post-save review or as an invented full intake response.
        return response();
      } finally {
        for (const selected of reviews.values()) selected.session.close();
      }
    },
  );
}
