import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { firstReportGroup } from '../shared/intake-report-group-links.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HealthRecordEnvelope, Intake, IntakeProposal } from '../shared/intake.ts';
import { isIntakeSummary, type IntakeRead } from '../shared/intake-summary.ts';
import type {
  ManualSourceRecordRequest,
  ManualSourceRecordReceipt,
  ManualSourceRecordResult,
} from '../shared/intake-manual-source-record.ts';
import { HttpError } from './database.ts';
import {
  flushIntake,
  getIntake,
  getIntakeRead,
  proposeConversion,
  proposeConversionRead,
  reviewIntake,
} from './intake.ts';
import { getIntakeSourceText, currentIntakeSourceTextRevisionId } from './intake-source-text.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  activeMappingRules,
  checkClinicalMapping,
  clinicalFields,
  mappingFrom,
} from './clinical-import.ts';
import { getNote } from './notes.ts';
import { noteVisibilitySQL } from './visibility.ts';
import { isRetainOnlyIntake } from './intake-source-policy.ts';
import { prepareRetainedPlanAccess } from './intake-retained-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import { workflowHash } from './intake-workflow.ts';
import { intakeSourceMetadata } from './intake-state-access.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from './intake-review-collection-host.ts';
import { readSelectedManualSourceReceipt } from './intake-manual-receipt.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const bad = (message: string): never => {
  throw new HttpError(400, 'MANUAL_SOURCE_RECORD', message);
};

function result(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intake: Intake,
  proposal: IntakeProposal,
  replayed: boolean,
): ManualSourceRecordResult<Intake> {
  const review = reviewIntake(db, root, profileId, intake.id, proposal.id);
  const record = review.records[0];
  const groupId = firstReportGroup(record?.reportGroups)?.groupId;
  if (!record || !groupId)
    throw new HttpError(
      409,
      'MANUAL_SOURCE_RECORD',
      'The retained manual draft needs review recovery',
    );
  const params = new URLSearchParams({
    intake: intake.id,
    group: groupId,
    proposal: proposal.id,
    record: record.id,
  });
  return {
    intake,
    proposalId: proposal.id,
    recordId: record.id,
    groupId,
    reviewUrl: `/import?${params}`,
    replayed,
  };
}

function manualSourceFingerprint(input: ManualSourceRecordRequest): string {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          'version',
          'operationId',
          'sourceHash',
          'sourceTextRevisionId',
          'scope',
          'person',
          'literalText',
          'clinical',
        ].includes(key),
    )
  )
    bad('Supply only the manual source record fields');
  if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId))
    bad('A stable manual creation operation ID is required');
  const { version: _version, ...request } = input;
  const fingerprint = createHash('sha256').update(canonicalLiteral(request)).digest('hex');
  return fingerprint;
}

function prepareManualSourceRecordInput(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  current: IntakeRead,
  input: ManualSourceRecordRequest,
  fingerprint: string,
) {
  if (!Number.isSafeInteger(input.version) || input.version !== current.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'The source changed; reload before creating this draft',
    );
  if (input.sourceHash !== current.sha256)
    throw new HttpError(409, 'SOURCE_CHANGED', 'The retained original changed');
  if (isRetainOnlyIntake(current) || /zip/i.test(current.mimeType))
    bad('Choose a supported retained document or package member for this record');
  const text = getIntakeSourceText(db, root, profileId, intakeId);
  if (!text.revision || text.revision.id !== input.sourceTextRevisionId)
    throw new HttpError(
      409,
      'SOURCE_TEXT_CHANGED',
      'Reload the current source text and page before creating this draft',
    );
  const scope = input.scope;
  if (
    !object(scope) ||
    Object.keys(scope).some((key) => !['page', 'box'].includes(key)) ||
    !Number.isSafeInteger(scope.page) ||
    !text.revision.pages.some((page) => page.page === scope.page)
  )
    bad('Choose an existing retained source page');
  if (
    scope.box !== undefined &&
    (!Array.isArray(scope.box) ||
      scope.box.length !== 4 ||
      scope.box.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1,
      ) ||
      scope.box[2] <= 0 ||
      scope.box[3] <= 0 ||
      scope.box[0] + scope.box[2] > 1 ||
      scope.box[1] + scope.box[3] > 1)
  )
    bad('Use a valid normalized source region');
  if (
    typeof input.literalText !== 'string' ||
    !input.literalText.trim() ||
    input.literalText.length > 64000
  )
    bad('Supply a transcription of this region, up to 64000 characters');
  const selection = input.person;
  if (
    !object(selection) ||
    !['self', 'person'].includes(selection.kind) ||
    !Number.isSafeInteger(selection.expectedVersion) ||
    Object.keys(selection).some((key) => !['kind', 'noteId', 'expectedVersion'].includes(key)) ||
    (selection.kind === 'self' && 'noteId' in selection) ||
    (selection.kind === 'person' &&
      (typeof selection.noteId !== 'string' || selection.noteId === 'person-note:self'))
  )
    bad('Explicitly choose Self or an existing person');
  const person = getNote(db, selection.kind === 'self' ? 'person-note:self' : selection.noteId);
  if (
    person.kind !== 'person' ||
    !person.personId ||
    !db
      .prepare(`SELECT id FROM notes n WHERE n.id=? AND ${noteVisibilitySQL('n')}=0`)
      .get(person.id)
  )
    throw new HttpError(409, 'IDENTITY_SELECTION', 'Choose an available person');
  if (person.version !== selection.expectedVersion)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'The selected person changed; review the person choice again',
    );
  const clinical = input.clinical;
  if (
    !object(clinical) ||
    !['observation', 'medication', 'procedure', 'document'].includes(String(clinical.kind))
  )
    bad('Choose a supported clinical record type');
  const allowed = new Set<string>([
    ...clinicalFields[clinical.kind as keyof typeof clinicalFields],
    'label',
  ]);
  allowed.delete('subject');
  if (
    Object.entries(clinical).some(
      ([key, value]) =>
        !allowed.has(key) ||
        (key !== 'opticalPrescription' && (typeof value !== 'string' || value.length > 64000)),
    )
  )
    bad('Use supported clinical fields; identity and source authority are assigned by the host');
  const envelope: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: `manual:${input.operationId}`,
    kind: clinical.kind === 'document' ? 'document' : 'record',
    payload: input.literalText,
    provenance: {
      capturedVia: 'Human source review',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: `page ${scope.page}`,
    },
    coverage: {
      status: 'partial',
      notes: [
        'Human-authored record from the selected source region; not a completeness assessment.',
      ],
    },
    clinical: { ...clinical, subject: person.personId === 'patient' ? 'self' : 'other' },
  };
  const mapping = mappingFrom({ value: envelope });
  if (person.personId !== 'patient') mapping.personId = person.personId;
  const problem = checkClinicalMapping(mapping);
  if (problem) bad(problem);
  const receipt: ManualSourceRecordReceipt = {
    actor: 'profile-owner',
    operationId: input.operationId,
    fingerprint,
    profileId,
    intakeId,
    sourceHash: current.sha256,
    sourceTextRevisionId: text.revision.id,
    scope,
    person: {
      noteId: person.id,
      personId: person.personId,
      version: person.version,
      fullName:
        typeof person.person.fullName === 'string' && person.person.fullName.trim()
          ? person.person.fullName
          : person.title,
    },
  };
  const assertCurrent = () => {
    const selected = getNote(db, person.id);
    if (
      selected.version !== person.version ||
      selected.personId !== person.personId ||
      !db
        .prepare(`SELECT id FROM notes n WHERE n.id=? AND ${noteVisibilitySQL('n')}=0`)
        .get(person.id)
    )
      throw new HttpError(
        409,
        'IDENTITY_SELECTION',
        'The selected person changed; review the person choice again',
      );
    if (currentIntakeSourceTextRevisionId(db, profileId, intakeId) !== receipt.sourceTextRevisionId)
      throw new HttpError(
        409,
        'SOURCE_TEXT_CHANGED',
        'The retained source text changed before creating this draft',
      );
  };
  return { envelope, receipt, assertCurrent };
}

/** Native creation uses the same request/identity policy while proposals stay
 * addressed. A complete operation lookup is prepared explicitly before replay. */
export async function createManualSourceRecordRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: ManualSourceRecordRequest,
): Promise<ManualSourceRecordResult> {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      const current = getIntakeRead(db, root, profileId, intakeId);
      if (!isIntakeSummary(current))
        return createManualSourceRecord(db, root, profileId, intakeId, input);
      const fingerprint = manualSourceFingerprint(input),
        selectedInput = structuredClone(input);
      const assertSelected = () => {
        const selected = getIntakeRead(db, root, profileId, intakeId);
        if (
          !isIntakeSummary(selected) ||
          selected.version !== current.version ||
          selected.pins.logicalRoot !== current.pins.logicalRoot
        )
          throw new HttpError(
            409,
            'VERSION_CONFLICT',
            'The source changed; reload before creating this draft',
          );
      };
      await prepareRetainedPlanAccess(db, profileId, intakeId, { assertRunning: assertSelected });
      const mappingVersion = () =>
        workflowHash(
          activeMappingRules(
            db,
            intakeSourceMetadata(db, intakeId).metadata?.sourceProviderId || current.providerId,
          ),
        );
      const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, intakeId, {
        mappingVersion: mappingVersion(),
        currentMappingVersion: mappingVersion,
        assertRunning: assertSelected,
      });
      if (ready.state !== 'ready')
        throw new HttpError(
          409,
          'WORKFLOW_PREPARATION_REQUIRED',
          'Prepare the selected source before creating a manual draft',
        );
      assertSelected();
      const view = openIntakeCollectionEnvelope(db, { id: intakeId }),
        prior = view.lookup('manual-source-operation-first', [selectedInput.operationId]);
      const read = <T>(record: NonNullable<typeof prior>, key: string): T => {
        const value = view.field(record, key, { bytes: 8192 });
        if (value.kind !== 'value')
          throw new HttpError(
            409,
            'MANUAL_SOURCE_RECORD',
            'The retained manual draft needs selected evidence preparation',
          );
        return value.value as T;
      };
      let proposalId: string, saved: IntakeRead;
      if (prior) {
        const receipt = readSelectedManualSourceReceipt(view, prior);
        if (
          receipt?.operationId !== selectedInput.operationId ||
          receipt.fingerprint !== fingerprint
        )
          throw new HttpError(
            409,
            'OPERATION_CONFLICT',
            'This manual creation operation already records a different request',
          );
        proposalId = read<string>(prior, 'id');
        saved = { ...current, durability: flushIntake(db, root, profileId) };
      } else {
        const prepared = prepareManualSourceRecordInput(
          db,
          root,
          profileId,
          intakeId,
          current,
          selectedInput,
          fingerprint,
        );
        saved = await proposeConversionRead(
          db,
          root,
          profileId,
          intakeId,
          {
            version: current.version,
            jsonlText: JSON.stringify(prepared.envelope),
            summary: 'Record authored by you from retained source evidence',
          },
          { manualSourceRecord: prepared.receipt, assertRunning: prepared.assertCurrent },
        );
        const published = openIntakeCollectionEnvelope(db, { id: intakeId }),
          selected = published.lookup('manual-source-operation-first', [selectedInput.operationId]),
          identity = selected && published.field(selected, 'id', { bytes: 8192 });
        if (!identity || identity.kind !== 'value' || typeof identity.value !== 'string')
          throw new HttpError(
            409,
            'MANUAL_SOURCE_RECORD',
            'The retained manual draft needs review recovery',
          );
        proposalId = identity.value;
      }
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, intakeId, proposalId);
      const reviewed = await prepareCollectionClinicalReviewAsync(
        db,
        root,
        profileId,
        intakeId,
        proposalId,
      );
      if (reviewed.status !== 'ready')
        throw new HttpError(
          409,
          'MANUAL_SOURCE_RECORD',
          'The retained manual draft needs selected review preparation',
        );
      try {
        const record = reviewed.session.review.records[0],
          groupId = firstReportGroup(record?.reportGroups)?.groupId;
        if (!record || !groupId)
          throw new HttpError(
            409,
            'MANUAL_SOURCE_RECORD',
            'The retained manual draft needs review recovery',
          );
        const params = new URLSearchParams({
          intake: intakeId,
          group: groupId,
          proposal: proposalId,
          record: record.id,
        });
        return {
          intake: saved,
          proposalId,
          recordId: record.id,
          groupId,
          reviewUrl: `/import?${params}`,
          replayed: !!prior,
        };
      } finally {
        reviewed.session.close();
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}

/** Profile-authorized route only. Model proposal input has no access to this host receipt. */
export function createManualSourceRecord(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: ManualSourceRecordRequest,
): ManualSourceRecordResult<Intake> {
  const current = getIntake(db, root, profileId, intakeId),
    fingerprint = manualSourceFingerprint(input);
  const prior = current.proposals.find(
    (proposal) => proposal.manualSourceRecord?.operationId === input.operationId,
  );
  if (prior) {
    if (prior.manualSourceRecord?.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This manual creation operation already records a different request',
      );
    return result(
      db,
      root,
      profileId,
      { ...current, durability: flushIntake(db, root, profileId) },
      prior,
      true,
    );
  }
  const { envelope, receipt } = prepareManualSourceRecordInput(
    db,
    root,
    profileId,
    intakeId,
    current,
    input,
    fingerprint,
  );
  const saved = proposeConversion(
    db,
    root,
    profileId,
    intakeId,
    {
      version: current.version,
      jsonlText: JSON.stringify(envelope),
      summary: 'Record authored by you from retained source evidence',
    },
    { manualSourceRecord: receipt },
  );
  const proposal = saved.proposals.find(
    (item) => item.manualSourceRecord?.operationId === input.operationId,
  )!;
  return result(db, root, profileId, saved, proposal, false);
}
