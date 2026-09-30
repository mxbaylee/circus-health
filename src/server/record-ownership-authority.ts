import { json, type Database } from './database.ts';
import type {
  IntakeReviewRecord,
  IntakeReportGroup,
  IntakeWorkflow,
  HealthRecordEnvelope,
} from '../shared/intake.ts';
import { getNote } from './notes.ts';
import { compatibleIdentityBirthDates } from '../shared/self-identity.ts';
import { competingIdentityBoundaries } from './intake-identity-policy.ts';
import { identityOriginalBirthDateEvidenceLookup } from './intake-identity-grounding.ts';
import { ownershipHash, latestOwnershipDecision } from './ownership-journal.ts';
import { clinicalTables, type ClinicalKind } from './clinical-references.ts';

export interface OwnershipSourceAuthority {
  operationId: string;
  revision: number;
  recordId: string;
  kind: ClinicalKind;
  sourceRecordId: string;
  identity: string;
  personId: string;
  noteId: string;
  sourceHash: string;
  envelopeHash: string;
  mappingHash: string;
  targetVersion: string;
  identityIssues: string[];
}
export interface OwnershipReportAuthority {
  operationId: string;
  revision: number;
  intakeId: string;
  groupId: string;
  boundary: string;
  personId: string;
  noteId: string;
  identityIssues: string[];
}
export const ownershipReportBoundary = (
  intakeId: string,
  sourceHash: string,
  group: IntakeReportGroup,
) =>
  ownershipHash([
    intakeId,
    sourceHash,
    group.id,
    group.memberId,
    group.sourceFileId,
    group.sourceHash,
    group.report,
  ]);
export function ownershipSourceAuthority(
  db: Database,
  identity: string,
): OwnershipSourceAuthority | null {
  return latestOwnershipDecision(db, 'Record ownership source', 'identity', identity);
}
export const ownershipEnvelopeHash = (envelope: HealthRecordEnvelope) => ownershipHash(envelope);
export const ownershipMappingHash = (mapping: object) => {
  const { personId: _person, subject: _subject, ...clinical } = mapping as Record<string, unknown>;
  return ownershipHash(clinical);
};
export function correctedOccurrence(
  db: Database,
  identity: string,
  sourceHash: string,
  envelope: HealthRecordEnvelope,
  mapping: Record<string, unknown>,
) {
  const a = ownershipSourceAuthority(db, identity);
  if (
    !a ||
    a.sourceHash !== sourceHash ||
    a.envelopeHash !== ownershipEnvelopeHash(envelope) ||
    a.mappingHash !== ownershipMappingHash(mapping)
  )
    return null;
  const row = db
    .prepare(
      `SELECT id,source_record_id,extra_json ${a.kind === 'document' ? '' : ',person_id'} FROM ${clinicalTables[a.kind]} WHERE id=?`,
    )
    .get(a.recordId);
  if (
    !row ||
    (a.kind === 'document'
      ? (json(row.extra_json) as { import?: { personId?: string } }).import?.personId || 'patient'
      : row.person_id) !== a.personId
  )
    return null;
  const currentVersion = (json(row.extra_json) as { import?: { version?: string } }).import
    ?.version;
  if (currentVersion !== a.targetVersion) return null;
  return {
    ...row,
    extra_json: String(row.extra_json),
    id: String(row.id),
    source_record_id: String(row.source_record_id),
    kind: a.kind,
    exact: true,
    personId: a.personId,
  };
}
export const ownershipIdentityIssues = (record: IntakeReviewRecord) =>
  (record.issues || [])
    .filter(
      (i) =>
        i.kind === 'identity' &&
        (i.textAnchor ||
          i.questionId ||
          i.resolution?.outcome === 'unknown' ||
          i.resolution?.outcome === 'other_person'),
    )
    .map((i) => ownershipHash([i.prompt, i.textAnchor, i.questionId, i.resolution?.outcome]))
    .sort();
const holds = new WeakMap<
  IntakeReviewRecord,
  { before: IntakeReviewRecord['identityReview']; hold: IntakeReviewRecord['identityReview'] }
>();
export function identityBeforeOwnershipHold(record: IntakeReviewRecord) {
  const old = holds.get(record);
  return old && old.hold === record.identityReview ? old.before : record.identityReview;
}
/** Recheck original evidence and current refusal independently of the former person's receipt. */
export function ownershipIdentityBlockers(
  db: Database,
  intakeId: string,
  record: IntakeReviewRecord,
  destinationBirthDate: string | null | undefined,
): string[] {
  const file = db.prepare('SELECT sha256,details_json FROM source_files WHERE id=?').get(intakeId);
  if (!file) return ['The retained original is unavailable.'];
  const details = json(file.details_json) as { intake?: { workflow?: IntakeWorkflow } };
  const workflow = details.intake?.workflow;
  const groups = record.reportGroups || [];
  const blockers: string[] = [];
  const current = identityBeforeOwnershipHold(record);
  for (const issue of record.issues || [])
    if (
      issue.kind === 'identity' &&
      issue.blocking &&
      issue.status !== 'resolved' &&
      (issue.textAnchor ||
        issue.questionId ||
        !['Does this record belong to you?', current?.message].includes(issue.prompt))
    )
      blockers.push('Answer the report identity question before changing person: ' + issue.prompt);
  if (
    (record.issues || []).some(
      (i) =>
        i.kind === 'identity' &&
        ['unknown', 'other_person'].includes(String(i.resolution?.outcome)),
    )
  )
    blockers.push('Resolve the explicit identity refusal before changing person.');
  for (const ref of groups) {
    const group = workflow?.reportGroups?.find((g) => g.id === ref.groupId);
    if (!group || !workflow) {
      blockers.push('The report boundary changed.');
      continue;
    }
    if (group.basis !== 'report_anchor' || !group.report?.subject) {
      const before = identityBeforeOwnershipHold(record);
      if (before?.blocking) blockers.push(before.message);
      if (
        destinationBirthDate &&
        before?.evidencedIdentity.birthDate &&
        !compatibleIdentityBirthDates(before.evidencedIdentity.birthDate, destinationBirthDate)
      )
        blockers.push('The verified source birth date conflicts with the destination.');
      continue;
    }
    if (competingIdentityBoundaries(group, workflow.reportGroups || []).length)
      blockers.push('Resolve competing report identity boundaries before changing person.');
    const dates = identityOriginalBirthDateEvidenceLookup(db, {
      profileId: String(
        db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value,
      ),
      intakeId,
      sourceHash: String(file.sha256),
      workflow,
    })(group);
    if (!dates) blockers.push('Open the original identity review before changing person.');
    else if (dates.unreadable || dates.dates.length > 1)
      blockers.push('Review the ambiguous printed birth date before changing person.');
    else if (
      destinationBirthDate &&
      dates.dates.some((d) => !compatibleIdentityBirthDates(d, destinationBirthDate))
    )
      blockers.push(
        'The verified source birth date conflicts with the destination. Ordinary ownership correction cannot resolve this discrepancy.',
      );
  }
  const before = identityBeforeOwnershipHold(record);
  if (!groups.length && before?.blocking) blockers.push(before.message);
  if (
    !groups.length &&
    destinationBirthDate &&
    before?.evidencedIdentity.birthDate &&
    !compatibleIdentityBirthDates(before.evidencedIdentity.birthDate, destinationBirthDate)
  )
    blockers.push('The verified source birth date conflicts with the destination.');
  return [...new Set(blockers)];
}
/** A correction is current assignment authority only within its exact retained source boundary. */
export function requireCorrectedOwnershipReview(
  db: Database,
  record: IntakeReviewRecord,
  identity: string,
  file?: { id: string; sha256: string; details_json?: string },
) {
  const source = ownershipSourceAuthority(db, identity);
  const workflow = file
    ? (json(file.details_json) as { intake?: { workflow?: IntakeWorkflow } }).intake?.workflow
    : undefined;
  const group = workflow?.reportGroups?.find((g) =>
    record.reportGroups?.some((r) => r.groupId === g.id),
  );
  const report = group
    ? latestOwnershipDecision<OwnershipReportAuthority>(
        db,
        'Report ownership default',
        'groupId',
        group.id,
      )
    : null;
  const reportHold = report
    ? latestOwnershipDecision<OwnershipReportHold>(
        db,
        'Report ownership default hold',
        'defaultOperationId',
        report.operationId,
      )
    : null;
  const exactSource =
    source &&
    file &&
    source.sourceHash === file.sha256 &&
    source.envelopeHash ===
      (record as IntakeReviewRecord & { ownershipEnvelopeHash?: string }).ownershipEnvelopeHash;
  const exactReport =
    report &&
    !reportHold &&
    file &&
    group &&
    report.intakeId === file.id &&
    report.boundary === ownershipReportBoundary(file.id, file.sha256, group);
  const authority =
    exactSource && (!exactReport || source.revision >= report.revision)
      ? source
      : exactReport
        ? report
        : null;
  if (!source && !report) return;
  const before = identityBeforeOwnershipHold(record);
  // A new explicit confirmation can replace the challenged default after ordinary scope checks.
  const confirmation = workflow?.identityConfirmations?.find(
    (r) => r.operationId === record.identityAttribution?.confirmationOperationId,
  );
  if (
    reportHold &&
    !exactSource &&
    confirmation &&
    confirmation.scope.intakeVersion >= reportHold.intakeVersion &&
    !before?.blocking
  )
    return;
  if (!file && before?.blocking) {
    record.identityReview = before;
    delete record.identityAttribution;
    holds.delete(record);
    return;
  }
  let blockers: string[] = [];
  let person;
  if (authority) {
    try {
      person = getNote(db, authority.noteId);
    } catch {
      /* unavailable destination remains held */
    }
    if (!person || person.archived || person.personId !== authority.personId)
      blockers.push('Choose an available destination person.');
    else {
      blockers = ownershipIdentityBlockers(db, file!.id, record, person.person.birthDate);
      if (
        ownershipIdentityIssues(record).some((issue) => !authority.identityIssues?.includes(issue))
      )
        blockers.push('New identity evidence or a question needs explicit report review.');
    }
  } else
    blockers.push(
      reportHold
        ? 'A selected record contradicted the earlier report assignment; review this report’s person again.'
        : 'The corrected source or report boundary changed; review its identity again.',
    );
  if (!authority || !person || blockers.length) {
    delete record.identityAttribution;
    const hold = {
      ...(before || { evidencedIdentity: {}, conflicts: [] }),
      status: 'confirmation_required' as const,
      blocking: true,
      message: blockers.join(' ') || 'Review the accepted person correction.',
    };
    holds.set(record, { before, hold });
    record.identityReview = hold;
    return;
  }
  const assignedPerson = {
    noteId: person.id,
    personId: person.personId!,
    version: person.version,
    fullName: person.person.fullName || person.title,
    birthDate: person.person.birthDate || null,
  };
  record.identityAttribution = {
    status: 'prior_confirmation',
    basis: 'explicit_ownership_correction',
    groupId: group?.id || null,
    groupVersionId: group?.versions.at(-1)?.id || null,
    confirmationOperationId: authority.operationId,
    assignedPerson,
    evidencedIdentity: before?.evidencedIdentity,
  };
  record.identityReview = {
    ...(before || { evidencedIdentity: {}, conflicts: [] }),
    status: 'prior_confirmation',
    blocking: false,
    message:
      'Person assignment corrected to ' +
      assignedPerson.fullName +
      '. Clinical acceptance is still required.',
    assignedPerson,
  };
  record.mapping.personId = authority.personId === 'patient' ? undefined : authority.personId;
  record.mapping.subject = authority.personId === 'patient' ? 'self' : 'other';
  for (const issue of record.issues || [])
    if (issue.kind === 'identity') {
      issue.blocking = false;
      issue.status = 'resolved';
    }
  holds.delete(record);
}

export interface OwnershipReportHold {
  intakeVersion: number;
  operationId: string;
  defaultOperationId: string;
  intakeId: string;
  groupId: string;
  at: string;
}
/** A partial contradiction revokes future use of the old default, never other accepted owners. */
export function ownershipReportHolds(
  db: Database,
  records: import('../shared/record-ownership.ts').OwnershipPreviewRecord[],
) {
  const result = new Map<
    string,
    { defaultOperationId: string; intakeId: string; groupId: string; intakeVersion: number }
  >();
  for (const record of records.filter((r) => r.action !== 'unchanged'))
    for (const c of record.contributions.filter((c) => c.selected))
      for (const scope of c.reportScopes) {
        const groupId = scope.slice(c.sourceFileId.length + 1);
        const authority = latestOwnershipDecision<OwnershipReportAuthority>(
          db,
          'Report ownership default',
          'groupId',
          groupId,
        );
        if (
          !authority ||
          authority.personId !== record.owner.personId ||
          authority.intakeId !== c.sourceFileId ||
          latestOwnershipDecision(
            db,
            'Report ownership default hold',
            'defaultOperationId',
            authority.operationId,
          )
        )
          continue;
        result.set(authority.operationId, {
          intakeVersion: Number(
            db
              .prepare(
                "SELECT json_extract(details_json,'$.intake.version') version FROM source_files WHERE id=?",
              )
              .get(authority.intakeId)!.version,
          ),
          defaultOperationId: authority.operationId,
          intakeId: authority.intakeId,
          groupId,
        });
      }
  return [...result.values()].sort((a, b) =>
    a.defaultOperationId.localeCompare(b.defaultOperationId),
  );
}
