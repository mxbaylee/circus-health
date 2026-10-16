/** A package batch is part of one proposal publication. Preparations below
 * publish only auxiliary checkpoints; the caller must atomically adopt the
 * receipt, candidate/report changes and file/dependency registration. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { HttpError, safeText, type Database } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { extractionPins } from './intake-plan.ts';
import { workflowHash } from './intake-workflow.ts';
import { readPackagePlanScope } from './intake-package-plan.ts';
import {
  decisionIndexAdoption,
  decisionIndexRank,
  selectedReadingStateIndex,
  prepareReadingStateCatalog,
} from './intake-reading-state.ts';
import { prepareExtractionBatchScope } from './intake-extraction-batch-scope.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type { IntakeEnvelopeMutation } from './intake-envelope-mutation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import type { IntakeExtractionCoverage } from '../shared/intake.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { withDiagnosticValidation } from './import-diagnostic-error.ts';

function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind !== 'value') throw Error('Missing bounded batch field: ' + name);
  return value.value as T;
}
function source(db: Database, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const file = db
    .prepare(
      "SELECT id,kind,sha256,details_json,provider_id,mime_type FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as
    | {
        id: string;
        kind: string;
        sha256: string;
        details_json: string;
        provider_id: string;
        mime_type: string;
      }
    | undefined;
  if (!file) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  return file;
}
export interface PagedPackageBatchInput {
  version: number;
  planId: string;
  operationId: string;
  /** Exact existing submitIntakeBatch request digest, calculated by its host. */
  fingerprint: string;
  proposalId: string;
  coverage: readonly IntakeExtractionCoverage[];
  createdAt: string;
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
}

/** Replay is checked before current source-text/model pins derive a new
 * proposal identity. The retained operation keeps its original meaning. */
export function retainedPagedPackageBatch(
  db: Database,
  profileId: string,
  id: string,
  input: Pick<PagedPackageBatchInput, 'operationId' | 'planId' | 'fingerprint'>,
) {
  const file = source(db, profileId, id),
    view = openIntakeCollectionEnvelope(db, file),
    intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  if (!flow) return undefined;
  const prior = view.find('operation', flow, input.operationId);
  if (!prior) return undefined;
  if (field(view, prior, 'fingerprint') !== input.fingerprint)
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'Batch operation already recorded a different result',
    );
  const store = selectedEnvelopeStore(db, file).collections,
    selected = store.get(
      store.openView(),
      'logical',
      'package.commands',
      workflowHash(input.operationId),
    );
  let address: string | undefined;
  if (selected !== undefined) {
    if (typeof selected !== 'string') throw Error('Invalid selected batch command');
    const command = JSON.parse(selected) as {
      fingerprint: string;
      planId: string;
      planAddress?: string;
    };
    if (command.fingerprint !== input.fingerprint || command.planId !== input.planId)
      throw Error('Selected batch command disagrees with retained operation');
    address = command.planAddress;
  }
  const plan = address ? view.resolve(address) : view.find('plan', flow, input.planId),
    batch = plan && view.find('batch', plan, input.operationId);
  if (plan && field(view, plan, 'id') !== input.planId)
    throw Error('Selected batch plan disagrees');
  if (!batch) throw Error('Retained batch operation has no selected receipt');
  const proposalId = field<string>(view, batch, 'proposalId');
  if (typeof proposalId !== 'string') throw Error('Invalid retained batch proposal identity');
  return { planId: input.planId, proposalId };
}

export async function preparePagedPackageBatch(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: PagedPackageBatchInput,
) {
  const file = source(db, profileId, id),
    view = openIntakeCollectionEnvelope(db, file),
    intake = view.child(view.root(), 'intake'),
    flow = intake && view.child(intake, 'workflow');
  if (!flow) throw new HttpError(404, 'NOT_FOUND', 'Active extraction plan not found');
  const operationId = safeText(input.operationId, 'batch operation ID', 200);
  if (!operationId)
    throw new HttpError(400, 'OPERATION_ID', 'A stable batch operation ID is required');
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) throw Error('Invalid batch request fingerprint');
  const prior = view.find('operation', flow, operationId);
  if (prior) {
    if (field(view, prior, 'fingerprint') !== input.fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'Batch operation already recorded a different result',
      );
    const receipt = retainedPagedPackageBatch(db, profileId, id, input);
    if (!receipt || receipt.proposalId !== input.proposalId)
      throw Error('Retained batch operation disagrees with its selected receipt');
    return { replayed: true as const, proposalId: input.proposalId, planId: input.planId };
  }
  const before = intakeSourceVersion(db, id);
  if (before.version !== input.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const scope = await prepareExtractionBatchScope(db, root, profileId, id, input.planId, {
    assertRunning: input.assertRunning,
  });
  if (scope.pinsHash !== workflowHash(extractionPins(db, file)))
    throw new HttpError(
      409,
      'EXTRACTION_CONFIG_CHANGED',
      'Model, instructions, mapping or source changed. Create an explicit replacement plan; prior completed work is retained',
    );
  const coverage = input.coverage;
  if (
    !Array.isArray(coverage) ||
    !coverage.length ||
    coverage.length > 50 ||
    new Set(coverage.map((item) => item?.unitId)).size !== coverage.length ||
    coverage.some(
      (item) =>
        !item ||
        typeof item.unitId !== 'string' ||
        !['inspected', 'extracted', 'context', 'unreadable'].includes(item.kind) ||
        typeof item.notes !== 'string' ||
        item.notes.length > 4000,
    )
  )
    throw withDiagnosticValidation(
      new HttpError(
        400,
        'BATCH_COVERAGE',
        'Supply distinct plan units with explicit extracted/context/inspected/unreadable coverage and notes',
      ),
      { code: 'invalid_batch_coverage', path: 'arguments.coverage' },
    );
  // Only the bounded changed units are retained across asynchronous checkpoints.
  const changed = coverage.map((item) => {
    const unit = scope.unitById(item.unitId);
    if (!unit)
      throw withDiagnosticValidation(
        new HttpError(
          400,
          'BATCH_COVERAGE',
          'A coverage unit does not belong to the selected plan',
        ),
        { code: 'invalid_batch_coverage', path: 'arguments.coverage' },
      );
    if (!Number.isSafeInteger(unit.attemptCount + 1)) throw Error('Unit attempt count overflow');
    return {
      coverage: { unitId: item.unitId, kind: item.kind, notes: item.notes },
      ordinal: unit.ordinal,
      unitAddress: unit.record ? scope.reader.address(unit.record) : undefined,
      attempts: unit.attemptCount + 1,
      exception: !!unit.processingException,
      pendingDelta:
        Number(item.kind === 'inspected') - Number(scope.accountedKind(item.unitId) === null),
    };
  });
  const collections = selectedEnvelopeStore(db, file).collections,
    assertCurrent = () => {
      input.assertRunning?.();
      assertIntakeOwner(db, profileId);
      const current = intakeSourceVersion(db, id);
      if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
        throw new HttpError(
          409,
          'VERSION_CONFLICT',
          'This intake changed. Reload it before continuing.',
        );
      if (scope.pinsHash !== workflowHash(extractionPins(db, file)))
        throw new HttpError(
          409,
          'EXTRACTION_CONFIG_CHANGED',
          'Extraction configuration changed during batch preparation',
        );
    };
  const prefix = 'batch.' + randomUUID(),
    kinds = ['units', 'attempts', 'accounted', 'readingSkipped'] as const;
  async function checkpoint(changes: IntakeCollectionChange[]) {
    assertCurrent();
    const operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: before.rawVersion,
        changes,
      }),
    );
    await input.onCheckpoint?.();
    await setImmediate();
    assertCurrent();
  }
  const initial: IntakeCollectionChange[] = [];
  for (const kind of kinds) {
    const selected = scope.decisionIndex(kind),
      collection = prefix + '.' + kind;
    initial.push(...decisionIndexAdoption(collections, selected, collection));
  }
  await checkpoint(initial);
  for (let offset = 0; offset < changed.length; offset += 15) {
    const changes: IntakeCollectionChange[] = [];
    for (let ordinal = offset; ordinal < Math.min(changed.length, offset + 15); ordinal++) {
      const item = changed[ordinal]!,
        terminal = item.coverage.kind !== 'inspected',
        ordinalKey = schemaOrdinal(item.ordinal);
      changes.push(
        {
          area: 'builds',
          collection: prefix + '.units',
          op: 'put',
          key: item.coverage.unitId,
          value: JSON.stringify({
            batchId: operationId,
            coverageOrdinal: ordinal,
            attemptCount: item.attempts,
          }),
        },
        {
          area: 'builds',
          collection: prefix + '.attempts',
          op: 'put',
          key: workflowHash([item.coverage.unitId, operationId]),
          value: '1',
        },
        terminal
          ? {
              area: 'builds',
              collection: prefix + '.accounted',
              op: 'put',
              key: ordinalKey,
              value: item.coverage.unitId,
            }
          : { area: 'builds', collection: prefix + '.accounted', op: 'delete', key: ordinalKey },
        !terminal && item.exception
          ? {
              area: 'builds',
              collection: prefix + '.readingSkipped',
              op: 'put',
              key: ordinalKey,
              value: item.coverage.unitId,
            }
          : {
              area: 'builds',
              collection: prefix + '.readingSkipped',
              op: 'delete',
              key: ordinalKey,
            },
      );
    }
    await checkpoint(changes);
  }
  const receipt = {
    id: operationId,
    proposalId: input.proposalId,
    coverage: changed.map((item) => item.coverage),
    at: input.createdAt,
  };
  const additionalLogicalChanges: IntakeCollectionChange[] = [
    ...scope.compatibilityChanges(),
    ...kinds.map(
      (kind) =>
        ({
          area: 'logical',
          collection: scope.decisionCollection(kind),
          op: 'adoptCollection',
          fromArea: 'builds',
          fromCollection: prefix + '.' + kind,
        }) as const,
    ),
  ];
  const planAddress = scope.reader.address(scope.record);
  const selectedExceptions = selectedReadingStateIndex(collections, planAddress, 'exceptions');
  if (selectedExceptions) {
    const catalog = prepareReadingStateCatalog(db, file, {
      assertRunning: assertCurrent,
      onCheckpoint: input.onCheckpoint,
    });
    const exceptions = await catalog.fork(selectedExceptions);
    await catalog.select(planAddress, { exceptions, readingSkipped: prefix + '.readingSkipped' });
    additionalLogicalChanges.push(...catalog.finalChanges());
  }
  additionalLogicalChanges.push({
    area: 'logical',
    collection: 'package.commands',
    op: 'put',
    key: workflowHash(operationId),
    value: JSON.stringify({
      fingerprint: input.fingerprint,
      planId: scope.planId,
      planAddress: scope.reader.address(scope.record),
    }),
  });
  return {
    replayed: false as const,
    proposalId: input.proposalId,
    planId: scope.planId,
    version: before.version,
    domainVersion: before.rawVersion,
    affected: {
      planAddress: scope.reader.address(scope.record),
      operationId,
      pendingDelta: changed.reduce((total, item) => total + item.pendingDelta, 0),
    },
    assertCurrent,
    compose: {
      additionalLogicalChanges,
      *changes(staged: IntakeCollectionEnvelopeReader): Iterable<IntakeEnvelopeMutation> {
        assertCurrent();
        const currentIntake = staged.child(staged.root(), 'intake'),
          currentWorkflow = currentIntake && staged.child(currentIntake, 'workflow'),
          plan = currentWorkflow && staged.resolve(scope.reader.address(scope.record));
        if (!plan || !currentWorkflow)
          throw Error('Selected plan missing during proposal publication');
        yield { op: 'append', record: plan, field: 'batches', jsonText: JSON.stringify(receipt) };
        for (const item of changed) {
          if (!item.unitAddress) continue;
          const unit = staged.resolve(item.unitAddress);
          yield {
            op: 'append',
            record: unit,
            field: 'attempts',
            jsonText: JSON.stringify(operationId),
          };
          yield {
            op: 'set',
            record: unit,
            field: 'status',
            jsonText: JSON.stringify(item.coverage.kind === 'extracted' ? 'completed' : 'partial'),
          };
          yield {
            op: 'put',
            record: unit,
            field: 'coverage',
            jsonText: JSON.stringify(item.coverage),
          };
        }
        yield {
          op: 'append',
          record: currentWorkflow,
          field: 'operations',
          jsonText: JSON.stringify({
            id: operationId,
            fingerprint: input.fingerprint,
            at: input.createdAt,
          }),
        };
      },
    },
  };
}

/** Authenticated subtree counts locate the first gap without rereading the
 * completed prefix. A selected unit still proves its own retained receipt. */
export function nextPendingPagedPackageUnit(
  db: Database,
  root: string,
  profileId: string,
  id: string,
) {
  const file = source(db, profileId, id),
    scope = readPackagePlanScope(db, root, profileId, id);
  if (!scope) return undefined;
  const collections = selectedEnvelopeStore(db, file).collections,
    accounted = scope.decisionIndex('accounted'),
    skipped = scope.decisionIndex('readingSkipped'),
    rank = (index: typeof accounted, n: number) =>
      decisionIndexRank(collections, index, schemaOrdinal(n));
  let low = 0,
    high = scope.plan.unitCount;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2),
      covered = rank(accounted, mid + 1) + rank(skipped, mid + 1);
    if (covered > mid + 1) throw Error('Overlapping package reading-accounting indexes');
    if (covered === mid + 1) low = mid + 1;
    else high = mid;
  }
  if (low === scope.plan.unitCount) return undefined;
  const member = scope.inventory.member(low),
    unit = member && scope.unit(member.memberId);
  if (!unit || scope.accountedKind(unit.id) || unit.processingException)
    throw Error('Package reading-accounting index disagrees with retained unit scope');
  return unit;
}
