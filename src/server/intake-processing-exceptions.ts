/** Host-owned reading exceptions. They never count as terminal extraction coverage. */
import { randomUUID } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import {
  assertIntakeOwner,
  intakeTransaction,
  flushIntake,
  withVerifiedIntakeOriginalDescriptor,
} from './intake.ts';
import { activeMappingRules } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeWorkflowCommand,
  retainedIntakeWorkflowCommand,
} from './intake-workflow-command.ts';
import {
  prepareRetainedPlanAccess,
  readRetainedIntakeUnitScope,
  prepareRetainedPlanDerived,
} from './intake-retained-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { prepareSourceContextClassificationDerived } from './intake-source-context-state.ts';
import { prepareWorkflowCommandDerived } from './intake-workflow-update.ts';
import { prepareReadingStateCatalog, selectedReadingStateIndex } from './intake-reading-state.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import type { IntakeEnvelopeMutation } from './intake-envelope-mutation.ts';

type Command = {
  version: number;
  operationId: string;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
} & (
  | { kind: 'set'; unitId: string; exception: { reason: 'processing_stalled'; at: string } }
  | { kind: 'clear' }
);
export function setCollectionProcessingException(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: Omit<Extract<Command, { kind: 'set' }>, 'kind'>,
) {
  return command(db, root, profileId, id, { ...input, kind: 'set' });
}
export function clearCollectionProcessingExceptions(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: Omit<Extract<Command, { kind: 'clear' }>, 'kind'>,
) {
  return command(db, root, profileId, id, { ...input, kind: 'clear' });
}
async function command(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: Command,
): Promise<void> {
  assertIntakeOwner(db, profileId);
  if (
    input.kind === 'set' &&
    (input.exception.reason !== 'processing_stalled' ||
      !input.exception.at ||
      Buffer.byteLength(input.exception.at) > 128)
  )
    throw Error('Invalid processing exception');
  const source = db
    .prepare(
      "SELECT id,kind,sha256,details_json,provider_id FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as
    | { id: string; kind: string; sha256: string; details_json: string; provider_id: string }
    | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  // These host commands preserve the historical workflowMutation receipt recipe.
  const request = { operationId: input.operationId };
  if (retainedIntakeWorkflowCommand(db, source, { operationId: input.operationId, request })) {
    flushIntake(db, root, profileId);
    return;
  }
  await withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id },
    async ({ assertRunning: assertOriginal }) => {
      const assertRunning = () => {
        input.assertRunning?.();
        assertOriginal();
      };
      await prepareRetainedPlanAccess(db, profileId, id, { assertRunning });
      const mappingVersion = () =>
        workflowHash(
          activeMappingRules(
            db,
            intakeSourceMetadata(db, id).metadata?.sourceProviderId || source.provider_id,
          ),
        );
      const selectedMapping = mappingVersion();
      const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
        mappingVersion: selectedMapping,
        currentMappingVersion: mappingVersion,
        assertRunning,
        onCheckpoint: input.onCheckpoint,
      });
      if (ready.state !== 'ready')
        throw new HttpError(
          409,
          'WORKFLOW_PREPARATION_REQUIRED',
          'Prepare complete workflow facts before changing reading exceptions',
        );
      const before = openIntakeCollectionEnvelope(db, source),
        beforeIntake = before.child(before.root(), 'intake')!,
        flow = before.child(beforeIntake, 'workflow');
      if (!flow) throw new HttpError(404, 'NOT_FOUND', 'Extraction plan not found');
      const catalog = prepareReadingStateCatalog(db, source, {
        assertRunning,
        onCheckpoint: input.onCheckpoint,
      });
      const selected =
        input.kind === 'set'
          ? readRetainedIntakeUnitScope(db, root, profileId, id, input.unitId)
          : undefined;
      if (
        selected &&
        (selected.format === 'retained' ? selected.scope.status : selected.scope.plan.status) !==
          'active'
      )
        throw new HttpError(409, 'PLAN_CHANGED', 'Active extraction unit not found');
      let assertDerived: (() => void) | undefined;
      const affected = {
        candidateChanges: [],
        questionAddresses: [],
        reportGroupAddresses: [],
        proposalIds: [],
      };
      const prepared = await prepareIntakeWorkflowCommand(db, source, {
        version: input.version,
        operationId: input.operationId,
        request,
        createdAt: new Date().toISOString(),
        assertRunning,
        onCheckpoint: input.onCheckpoint,
        async *changes({ reader, intake }): AsyncGenerator<IntakeEnvelopeMutation> {
          if (input.kind === 'set' && selected) {
            const originalPlan =
              selected.format !== 'native'
                ? selected.scope.record
                : before.find('plan', flow, selected.scope.planId)!;
            const address =
              selected.format !== 'native'
                ? selected.scope.reader.address(originalPlan)
                : before.address(originalPlan);
            const exceptions = await catalog.fork(
              selectedReadingStateIndex(catalog.collections, address, 'exceptions') ??
                (selected.format === 'direct'
                  ? selected.scope.decisionIndex('exceptions')
                  : {
                      area: 'logical',
                      collection: 'package.exceptions.' + workflowHash(selected.scope.planId),
                    }),
            );
            const readingSkipped = await catalog.fork(
              selected.scope.decisionIndex('readingSkipped'),
            );
            const ordinal =
              selected.format !== 'native'
                ? selected.unit.ordinal
                : selected.scope.inventory.byUnit(input.unitId)!.ordinal;
            await catalog.checkpoint([
              {
                area: 'builds',
                collection: exceptions,
                op: 'put',
                key: input.unitId,
                value: JSON.stringify(input.exception),
              },
              selected.scope.accountedKind(input.unitId)
                ? {
                    area: 'builds',
                    collection: readingSkipped,
                    op: 'delete',
                    key: schemaOrdinal(ordinal),
                  }
                : {
                    area: 'builds',
                    collection: readingSkipped,
                    op: 'put',
                    key: schemaOrdinal(ordinal),
                    value: input.unitId,
                  },
            ]);
            if (selected.format === 'retained')
              yield {
                op: 'set',
                record: reader.resolve(selected.unit.reader.address(selected.unit.record)),
                field: 'processingException',
                jsonText: JSON.stringify(input.exception),
              };
            await catalog.select(address, { exceptions, readingSkipped });
          } else {
            let after: string | undefined;
            do {
              const page = before.children(flow, 'plans', { after, items: 32, bytes: 32768 });
              for (const plan of page.records) {
                const status = before.field(plan, 'status', { bytes: 256 });
                if (status.kind !== 'value' || status.value !== 'active') continue;
                const empty = {
                  area: 'builds' as const,
                  collection: 'reading.empty.' + randomUUID(),
                };
                const exceptions = await catalog.fork(empty),
                  readingSkipped = await catalog.fork(empty);
                let unitAfter: string | undefined;
                do {
                  const units = before.children(plan, 'units', {
                    after: unitAfter,
                    items: 32,
                    bytes: 32768,
                  });
                  for (const unit of units.records)
                    if (before.has(unit, 'processingException'))
                      yield {
                        op: 'delete',
                        record: reader.resolve(before.address(unit)),
                        field: 'processingException',
                      };
                  if (units.complete) break;
                  if (!units.after || units.after === unitAfter)
                    throw Error('Retry unit scope failed to advance');
                  unitAfter = units.after;
                } while (true);
                await catalog.select(before.address(plan), { exceptions, readingSkipped });
              }
              if (page.complete) break;
              if (!page.after || page.after === after)
                throw Error('Retry plan scope failed to advance');
              after = page.after;
            } while (true);
          }
          if (ready.counts.needsReview)
            yield { op: 'set', record: intake, field: 'state', jsonText: '"needs_review"' };
        },
        additionalLogicalChanges: () => catalog.finalChanges(),
        async prepareDerived(derived) {
          const plans = await prepareRetainedPlanDerived(db, profileId, id, {
            ...derived,
            impact: { kind: 'processing-exception' },
          });
          const classifier = await prepareSourceContextClassificationDerived(
            db,
            root,
            profileId,
            id,
            { ...derived, affected, impact: 'metadata', assertRunning },
          );
          if (classifier.state !== 'ready')
            throw Error('Processing exception classification changed');
          assertDerived = classifier.assertPublicationCurrent;
          const changes = await prepareWorkflowCommandDerived(db, source, {
            ...derived,
            affected,
            impact: 'metadata',
            mappingVersion: selectedMapping,
            currentMappingVersion: mappingVersion,
            isSourceContextVersion: classifier.isSourceContextVersion,
            assertRunning,
            onCheckpoint: input.onCheckpoint,
          });
          return [...plans, ...classifier.changes, ...changes];
        },
      });
      if (!prepared.replayed)
        intakeTransaction(
          db,
          () => {
            prepared.assertCurrent();
            catalog.assertCurrent();
            assertDerived?.();
            selectedEnvelopeStore(db, source).collections.stage(prepared.prepared);
          },
          { operationId: prepared.publicationId, fingerprint: prepared.fingerprint },
        );
      flushIntake(db, root, profileId);
    },
  );
}
