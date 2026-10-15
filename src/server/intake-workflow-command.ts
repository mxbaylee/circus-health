/** Addressed workflow commands share one selected envelope and operation history.
 * Preparation publishes only resumable auxiliary work; the host stages the final
 * capability in its ordinary transaction with any related clinical writes. */
import { randomUUID } from 'node:crypto';
import { HttpError, safeText, type Database } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeMutation,
  type IntakeEnvelopeDerivedPreparation,
} from './intake-envelope-mutation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { workflowHash } from './intake-workflow.ts';

export interface IntakeWorkflowCommandView {
  reader: IntakeCollectionEnvelopeReader;
  intake: IntakeEnvelopeRecord;
  workflow: IntakeEnvelopeRecord;
}

export interface IntakeWorkflowCommandInput {
  version: number;
  operationId?: string | null;
  /** The existing domain request, excluding only its optimistic version. */
  request: unknown;
  createdAt: string;
  /** Link-only legacy commands keep their existing public version semantics. */
  incrementVersion?: boolean;
  changes(
    view: IntakeWorkflowCommandView,
  ): Iterable<IntakeEnvelopeMutation> | AsyncIterable<IntakeEnvelopeMutation>;
  prepareDerived?: (
    input: IntakeEnvelopeDerivedPreparation,
  ) => Promise<readonly IntakeCollectionChange[]>;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
  additionalLogicalChanges?: Parameters<
    typeof prepareIntakeEnvelopeMutation
  >[2]['additionalLogicalChanges'];
  derivedIntakeState?: Parameters<typeof prepareIntakeEnvelopeMutation>[2]['derivedIntakeState'];
}

/** External receipt replay is checked before version or physical-source work. */
export function retainedIntakeWorkflowCommand(
  db: Database,
  source: IntakeEnvelopeSource,
  input: Pick<IntakeWorkflowCommandInput, 'operationId' | 'request'>,
): boolean {
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake'),
    workflow = intake && reader.child(intake, 'workflow'),
    operationId = input.operationId ? safeText(input.operationId, 'operation ID', 200) : null,
    prior = workflow && operationId && reader.find('operation', workflow, operationId);
  if (!prior) return false;
  const retained = reader.field(prior, 'fingerprint', { bytes: 1024 });
  if (retained.kind !== 'value' || retained.value !== workflowHash(input.request))
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This operation already records a different request',
    );
  return true;
}

export async function prepareIntakeWorkflowCommand(
  db: Database,
  source: IntakeEnvelopeSource,
  input: IntakeWorkflowCommandInput,
) {
  const reader = openIntakeCollectionEnvelope(db, source),
    intake = reader.child(reader.root(), 'intake');
  if (!intake) throw Error('Selected intake header is missing');
  const operationId = input.operationId ? safeText(input.operationId, 'operation ID', 200) : null,
    fingerprint = workflowHash(input.request);
  // A retained external command is independent of later optimistic versions.
  if (retainedIntakeWorkflowCommand(db, source, input)) {
    return { replayed: true as const, fingerprint };
  }
  const before = intakeSourceVersion(db, source.id);
  if (!Number.isSafeInteger(input.version) || input.version !== before.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const assertCurrent = () => {
    input.assertRunning?.();
    const current = intakeSourceVersion(db, source.id);
    if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
    reader.address(intake);
  };
  const publicationId = randomUUID();
  const result = await prepareIntakeEnvelopeMutation(db, source, {
    reader,
    operationId: publicationId,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + Number(input.incrementVersion !== false),
    async *changes(staged) {
      const selected = staged.child(staged.root(), 'intake');
      if (!selected) throw Error('Staged intake header is missing');
      let flow = staged.child(selected, 'workflow');
      if (!flow) {
        if (staged.has(selected, 'workflow')) throw Error('Selected workflow is invalid');
        yield {
          op: 'set',
          record: selected,
          field: 'workflow',
          jsonText:
            '{"format":"health-intake-workflow-v1","candidates":[],"questions":[],"plans":[],"operations":[]}',
        };
        flow = staged.child(selected, 'workflow');
      }
      if (!flow) throw Error('Staged workflow is missing');
      yield* input.changes({ reader: staged, intake: selected, workflow: flow });
      if (operationId)
        yield {
          op: 'append',
          record: flow,
          field: 'operations',
          jsonText: JSON.stringify({ id: operationId, fingerprint, at: input.createdAt }),
        };
    },
    prepareDerived: input.prepareDerived,
    additionalLogicalChanges: input.additionalLogicalChanges,
    derivedIntakeState: input.derivedIntakeState,
    assertRunning: assertCurrent,
    onCheckpoint: input.onCheckpoint,
  });
  if (!result.prepared) throw Error('Unexpected private workflow publication replay');
  return {
    replayed: false as const,
    prepared: result.prepared,
    publicationId,
    fingerprint,
    assertCurrent,
    projectDetailsJson: result.projectDetailsJson,
  };
}
