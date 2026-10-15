import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
/** Native named-Person commands keep selected evidence complete without a workflow DTO. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './database.ts';
import { intakeSourceVersion, intakeSourceMetadata } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from './intake-envelope-mutation.ts';
import {
  prepareCollectionPeopleIndex,
  openCollectionPeopleRead,
  collectionPeopleDispositionDerived,
} from './intake-people-collection.ts';
import {
  applyIntakePerson,
  applySelectedIntakePerson,
  saveIntakePersonDisposition,
  getIntakePersonById,
  type IntakePersonSourceFileRow,
} from './intake-people.ts';
import {
  assertIntakeOwner,
  getIntakeRead,
  intakeTransaction,
  flushIntake,
  verifyIntakeOriginal,
} from './intake.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { prepareSourceContextClassificationDerived } from './intake-source-context-state.ts';
import { prepareWorkflowCommandDerived } from './intake-workflow-update.ts';
import { prepareRetainedPlanAccess, prepareRetainedPlanDerived } from './intake-retained-plan.ts';
import { activeMappingRules } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import type {
  IntakePersonApplyRequest,
  IntakePersonDispositionRequest,
} from '../shared/intake-people.ts';
import { prepareIntakeWorkflowPeopleDraftsSchema } from './intake-envelope-upgrade.ts';

function source(db: DatabaseSync, profileId: string, intakeId: string) {
  assertIntakeOwner(db, profileId);
  const row = db
    .prepare("SELECT * FROM source_files WHERE id=? AND kind='intake_original'")
    .get(intakeId) as IntakePersonSourceFileRow | undefined;
  if (!row)
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal source is unavailable');
  return row;
}
export async function getIntakePersonRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  personId: string,
) {
  const original = source(db, profileId, intakeId);
  if (!hasIntakeCollectionEnvelope(db, original))
    return getIntakePersonById(db, root, profileId, intakeId, personId);
  await prepareCollectionPeopleIndex(db, root, profileId, intakeId);
  const reader = openCollectionPeopleRead(db, root, profileId, intakeId),
    pointer = reader.pointer(personId);
  if (!pointer)
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal is unavailable');
  return reader.person(pointer);
}
export async function applyIntakePersonRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakePersonApplyRequest,
) {
  const original = source(db, profileId, input.intakeId);
  if (!hasIntakeCollectionEnvelope(db, original))
    return applyIntakePerson(db, root, profileId, input);
  await prepareCollectionPeopleIndex(db, root, profileId, input.intakeId);
  const reader = openCollectionPeopleRead(db, root, profileId, input.intakeId),
    pointer = reader.pointer(input.proposalId);
  if (!pointer)
    throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal is unavailable');
  const dto = reader.person(pointer),
    retained = reader.retained(pointer),
    inputFile = db.prepare('SELECT * FROM source_files WHERE id=?').get(retained.inputFileId) as
      IntakePersonSourceFileRow | undefined;
  if (!inputFile)
    throw new HttpError(409, 'INTAKE_PERSON_SOURCE', 'Retained People proposal changed');
  reader.assertCurrent();
  return applySelectedIntakePerson(db, root, profileId, input, {
    dto,
    entry: retained.entry,
    rawProposal: retained.rawProposal,
    original,
    inputFile,
  });
}
export async function saveIntakePersonDispositionRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: IntakePersonDispositionRequest,
) {
  const original = source(db, profileId, input.intakeId);
  if (!hasIntakeCollectionEnvelope(db, original))
    return saveIntakePersonDisposition(db, root, profileId, input);
  if (
    typeof input.operationId !== 'string' ||
    !input.operationId.trim() ||
    !['pending', 'later', 'excluded'].includes(input.state)
  )
    throw new HttpError(
      400,
      'INTAKE_PERSON_INPUT',
      'Supply an operation ID and choose pending, later or excluded',
    );
  await prepareIntakeWorkflowPeopleDraftsSchema(db, original);
  const view = openIntakeCollectionEnvelope(db, original),
    intake = view.child(view.root(), 'intake')!,
    flow = view.child(intake, 'workflow');
  if (!flow) throw new HttpError(404, 'INTAKE_PERSON_NOT_FOUND', 'People proposal is unavailable');
  const fingerprint = workflowHash({
      operationId: input.operationId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      state: input.state,
    }),
    previous = view.find('operation', flow, input.operationId),
    finish = () => ({
      ...getIntakeRead(db, root, profileId, input.intakeId),
      durability: flushIntake(db, root, profileId),
    });
  if (previous) {
    const old = view.field(previous, 'fingerprint', { bytes: 1024 });
    if (old.kind !== 'value' || old.value !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    return finish();
  }
  const before = intakeSourceVersion(db, input.intakeId);
  if (before.version !== input.intakeVersion)
    throw new HttpError(409, 'VERSION_CONFLICT', 'This intake changed. Reload before saving.');
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, input.intakeId);
    if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
      throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Refresh these People proposals');
  };
  await prepareCollectionPeopleIndex(db, root, profileId, input.intakeId, {
    assertRunning: assertCurrent,
  });
  const people = openCollectionPeopleRead(db, root, profileId, input.intakeId),
    pointer = people.pointer(input.proposalId);
  if (!pointer || pointer.version !== input.proposalVersion)
    throw new HttpError(409, 'INTAKE_PERSON_CHANGED', 'Reload this named Person proposal');
  if (people.state(pointer) === 'saved')
    throw new HttpError(409, 'INTAKE_PERSON_SAVED', 'A saved Person proposal cannot be deferred');
  const mappingVersion = () =>
      workflowHash(
        activeMappingRules(
          db,
          intakeSourceMetadata(db, input.intakeId).metadata?.sourceProviderId ||
            original.provider_id,
        ),
      ),
    mapping = mappingVersion();
  await prepareRetainedPlanAccess(db, profileId, input.intakeId, { assertRunning: assertCurrent });
  const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, input.intakeId, {
    mappingVersion: mapping,
    currentMappingVersion: mappingVersion,
    assertRunning: assertCurrent,
  });
  if (ready.state !== 'ready')
    throw new HttpError(
      409,
      'WORKFLOW_PREPARATION_REQUIRED',
      'Prepare the complete retained review before saving',
    );
  const operationId = randomUUID(),
    at = new Date().toISOString();
  let assertDerived: (() => void) | undefined;
  const mutation = await prepareIntakeEnvelopeMutation(db, original, {
    reader: view,
    operationId,
    requestDigest: fingerprint,
    domainVersion: before.rawVersion + 1,
    assertRunning: assertCurrent,
    changes: [
      {
        op: 'append',
        record: flow,
        field: 'peopleDrafts',
        jsonText: JSON.stringify({
          proposalId: input.proposalId,
          proposalVersion: input.proposalVersion,
          state: input.state,
          at,
        }),
      },
      {
        op: 'append',
        record: flow,
        field: 'operations',
        jsonText: JSON.stringify({ id: input.operationId, fingerprint, at }),
      },
    ],
    async prepareDerived(derived) {
      const affected = {
          candidateChanges: [],
          questionAddresses: [],
          reportGroupAddresses: [],
          proposalIds: [],
        },
        plans = await prepareRetainedPlanDerived(db, profileId, input.intakeId, {
          ...derived,
          impact: { kind: 'proposal' },
        }),
        classifier = await prepareSourceContextClassificationDerived(
          db,
          root,
          profileId,
          input.intakeId,
          { ...derived, affected, impact: 'metadata', assertRunning: assertCurrent },
        );
      if (classifier.state !== 'ready')
        throw new HttpError(
          409,
          'WORKFLOW_PREPARATION_REQUIRED',
          'Prepare complete retained source evidence',
        );
      assertDerived = classifier.assertPublicationCurrent;
      const changes = await prepareWorkflowCommandDerived(db, original, {
        ...derived,
        affected,
        impact: 'metadata',
        mappingVersion: mapping,
        currentMappingVersion: mappingVersion,
        isSourceContextVersion: classifier.isSourceContextVersion,
        assertRunning: () => {
          assertCurrent();
          classifier.assertCurrent();
        },
      });
      return [
        ...plans,
        ...classifier.changes,
        ...changes,
        ...collectionPeopleDispositionDerived(db, original, derived, {
          id: input.proposalId,
          version: input.proposalVersion,
          state: input.state,
        }),
      ];
    },
  });
  if (!mutation.prepared) throw Error('Unexpected private People operation replay');
  intakeTransaction(
    db,
    () => {
      assertCurrent();
      people.assertCurrent();
      people.retained(pointer);
      assertDerived?.();
      verifyIntakeOriginal(db, root, profileId, input.intakeId);
      selectedEnvelopeStore(db, original).collections.stage(mutation.prepared!);
    },
    { operationId, fingerprint },
  );
  return finish();
}
