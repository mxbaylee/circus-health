import { disposableSqlite } from './disposable-sqlite.ts';
import { finishClinicalReviewWork } from './clinical-review-work.ts';
import {
  ownershipIdentityIssueIncluded,
  type OwnershipIdentityIssues,
} from './ownership-identity-snapshots.ts';
import { reviewRecordIssues } from './intake-review-issue-state.ts';
import { selectedSequence } from './intake-selected-sequence.ts';
import {
  ownershipSortedValues,
  ownershipDistinctValues,
  ownershipHoldMessageWork,
  bindOwnershipHoldMessage,
} from './ownership-identity-values.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import { readStoredIntakeDetails } from './intake-state-access.ts';
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
import { ownershipDecisionQueries } from './ownership-decision-index.ts';
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
  identityIssues: OwnershipIdentityIssues;
}
export interface OwnershipReportAuthority {
  operationId: string;
  revision: number;
  intakeId: string;
  groupId: string;
  boundary: string;
  personId: string;
  noteId: string;
  identityIssues: OwnershipIdentityIssues;
}
export const ownershipReportBoundary = (
  intakeId: string,
  sourceHash: string,
  group: import('./intake-identity-policy.ts').IdentityBoundaryHeader,
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
  ownershipSortedValues(function* () {
    for (const i of reviewRecordIssues(record))
      if (
        i.kind === 'identity' &&
        (i.textAnchor ||
          i.questionId ||
          i.resolution?.outcome === 'unknown' ||
          i.resolution?.outcome === 'other_person')
      )
        yield ownershipHash([i.prompt, i.textAnchor, i.questionId, i.resolution?.outcome]);
  });
const holds = new WeakMap<
  IntakeReviewRecord,
  { before: IntakeReviewRecord['identityReview']; hold: IntakeReviewRecord['identityReview'] }
>();
export function identityBeforeOwnershipHold(record: IntakeReviewRecord) {
  const old = holds.get(record);
  return old && old.hold === record.identityReview ? old.before : record.identityReview;
}
export interface SelectedOwnershipReviewScope {
  readonly intakeVersion: number;
  groupWork?(
    id: string,
  ): Generator<void, import('./intake-workflow.ts').WorkflowReviewGroup | undefined, void>;
  currentVersionWork?(
    group: import('./intake-workflow.ts').WorkflowReviewGroup,
  ): Generator<void, string | null, void>;
  remainingWork?(
    groupId: string,
    selectedSources: ReadonlySet<string>,
  ): Generator<void, boolean, void>;
  lastConfirmationWork?(
    groupId: string,
    personId: string,
  ): Generator<void, import('./intake-identity-policy.ts').IdentityPolicyReceipt | undefined, void>;
  firstGroupWork?(
    references: NonNullable<IntakeReviewRecord['reportGroups']>,
  ): Generator<void, import('./intake-workflow.ts').WorkflowReviewGroup | undefined, void>;
  confirmationWork?(
    operationId: string | undefined,
  ): Generator<void, import('./intake-identity-policy.ts').IdentityPolicyReceipt | undefined, void>;
  competingWork?(
    group: import('./intake-workflow.ts').WorkflowReviewGroup,
  ): Generator<void, boolean, void>;
  blockerSink?(): { add(value: string): void; values(): Iterable<string> };

  remaining(groupId: string, selectedSources: ReadonlySet<string>): boolean;
  lastConfirmation(
    groupId: string,
    personId: string,
  ): import('./intake-identity-policy.ts').IdentityPolicyReceipt | undefined;
  currentVersion(group: import('./intake-workflow.ts').WorkflowReviewGroup): string | null;
  group(id: string): import('./intake-workflow.ts').WorkflowReviewGroup | undefined;
  /** First retained group matching any reference, preserving collection order. */
  firstGroup(
    references: NonNullable<IntakeReviewRecord['reportGroups']>,
  ): import('./intake-workflow.ts').WorkflowReviewGroup | undefined;
  confirmation(
    operationId: string | undefined,
  ): import('./intake-identity-policy.ts').IdentityPolicyReceipt | undefined;
  competing(group: import('./intake-workflow.ts').WorkflowReviewGroup): boolean;
  birthDatesWork?(
    group: import('./intake-workflow.ts').WorkflowReviewGroup,
  ): Generator<void, import('./intake-evidence-dates.ts').BirthDateEvidence | undefined, void>;
  birthDates(
    group: import('./intake-workflow.ts').WorkflowReviewGroup,
  ): import('./intake-evidence-dates.ts').BirthDateEvidence | undefined;
}
/** Recheck original evidence and current refusal independently of the former person's receipt. */
export function ownershipIdentityBlockers(
  ...args: Parameters<typeof ownershipIdentityBlockersWork>
) {
  return selectedSequence(function* () {
    for (const value of ownershipIdentityBlockersWork(...args))
      if (value !== undefined) yield value;
  });
}
export function* ownershipIdentityBlockersWork(
  ...args: Parameters<typeof ownershipIdentityBlockerSteps>
): Generator<void | string, void, void> {
  const scratch = disposableSqlite('circus-ownership-blockers-');
  try {
    scratch.db.exec('CREATE TABLE values_(value TEXT PRIMARY KEY)');
    const put = scratch.db.prepare('INSERT OR IGNORE INTO values_ VALUES(?)');
    for (const value of ownershipIdentityBlockerSteps(...args)) {
      if (value === undefined) yield;
      else if (put.run(value).changes) yield value;
    }
  } finally {
    scratch.close();
  }
}
function* ownershipIdentityBlockerSteps(
  db: Database,
  intakeId: string,
  record: IntakeReviewRecord,
  destinationBirthDate: string | null | undefined,
  selected?: SelectedOwnershipReviewScope,
): Generator<void | string, void, void> {
  const file = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(intakeId);
  if (!file) {
    yield 'The retained original is unavailable.';
    return;
  }
  const workflow = selected ? undefined : readStoredIntakeDetails(db, intakeId)?.workflow;
  const groups = selectedReportGroups(record.reportGroups);
  const current = identityBeforeOwnershipHold(record);
  for (const issue of reviewRecordIssues(record)) {
    yield;
    if (
      issue.kind === 'identity' &&
      issue.blocking &&
      issue.status !== 'resolved' &&
      (issue.textAnchor ||
        issue.questionId ||
        !['Does this record belong to you?', current?.message].includes(issue.prompt))
    )
      yield 'Answer the report identity question before changing person: ' + issue.prompt;
  }
  for (const issue of reviewRecordIssues(record)) {
    yield;
    if (
      issue.kind === 'identity' &&
      ['unknown', 'other_person'].includes(String(issue.resolution?.outcome))
    ) {
      yield 'Resolve the explicit identity refusal before changing person.';
      break;
    }
  }
  for (const ref of groups) {
    yield;
    const group = selected
      ? selected.groupWork
        ? yield* selected.groupWork(ref.groupId)
        : selected.group(ref.groupId)
      : workflow?.reportGroups?.find((g) => g.id === ref.groupId);
    if (!group || (!workflow && !selected)) {
      yield 'The report boundary changed.';
      continue;
    }
    if (group.basis !== 'report_anchor' || !group.report?.subject) {
      const before = identityBeforeOwnershipHold(record);
      if (before?.blocking) yield before.message;
      if (
        destinationBirthDate &&
        before?.evidencedIdentity.birthDate &&
        !compatibleIdentityBirthDates(before.evidencedIdentity.birthDate, destinationBirthDate)
      )
        yield 'The verified source birth date conflicts with the destination.';
      continue;
    }
    if (
      selected
        ? selected.competingWork
          ? yield* selected.competingWork(group)
          : selected.competing(group)
        : competingIdentityBoundaries(group as IntakeReportGroup, workflow!.reportGroups || [])
            .length
    )
      yield 'Resolve competing report identity boundaries before changing person.';
    const dates = selected
      ? selected.birthDatesWork
        ? yield* selected.birthDatesWork(group)
        : selected.birthDates(group)
      : identityOriginalBirthDateEvidenceLookup(db, {
          profileId: String(
            db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value,
          ),
          intakeId,
          sourceHash: String(file.sha256),
          workflow: workflow!,
        })(group as IntakeReportGroup);
    if (!dates) yield 'Open the original identity review before changing person.';
    else if (dates.unreadable || dates.dates.length > 1)
      yield 'Review the ambiguous printed birth date before changing person.';
    else if (
      destinationBirthDate &&
      dates.dates.some((d) => !compatibleIdentityBirthDates(d, destinationBirthDate))
    )
      yield 'The verified source birth date conflicts with the destination. Ordinary ownership correction cannot resolve this discrepancy.';
  }
  const before = identityBeforeOwnershipHold(record);
  if (!groups.some(() => true) && before?.blocking) yield before.message;
  if (
    !groups.some(() => true) &&
    destinationBirthDate &&
    before?.evidencedIdentity.birthDate &&
    !compatibleIdentityBirthDates(before.evidencedIdentity.birthDate, destinationBirthDate)
  )
    yield 'The verified source birth date conflicts with the destination.';
}
/** A correction is current assignment authority only within its exact retained source boundary. */
export function requireCorrectedOwnershipReview(
  ...args: Parameters<typeof requireCorrectedOwnershipReviewWork>
) {
  return finishClinicalReviewWork(requireCorrectedOwnershipReviewWork(...args));
}
export function* requireCorrectedOwnershipReviewWork(
  db: Database,
  record: IntakeReviewRecord,
  identity: string,
  file?: { id: string; sha256: string; details_json?: string },
  workflow?: IntakeWorkflow,
  selected?: SelectedOwnershipReviewScope,
): Generator<void, void, void> {
  // A complete current index can prove that there is no correction authority.
  // Missing preparation supplies no absence answer; damaged/stale indexes refuse.
  if (selected && ownershipDecisionQueries(db)?.hasAssignmentPolicy() === false) return;
  if (!selected && workflow === undefined && file)
    workflow = readStoredIntakeDetails(db, file.id)?.workflow;
  const source = ownershipSourceAuthority(db, identity);
  const group = selected
    ? selected.firstGroupWork
      ? yield* selected.firstGroupWork(record.reportGroups || [])
      : selected.firstGroup(record.reportGroups || [])
    : workflow?.reportGroups?.find((g) =>
        selectedReportGroups(record.reportGroups).some((r) => r.groupId === g.id),
      );
  const report = group
    ? latestOwnershipDecision<OwnershipReportAuthority>(
        db,
        'Report ownership default',
        'groupId',
        group.id,
      )
    : null;
  const reportHold = group
    ? latestOwnershipDecision<OwnershipReportHold>(
        db,
        'Report ownership default hold',
        'groupId',
        group.id,
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
  if (!source && !report && !reportHold) return;
  const before = identityBeforeOwnershipHold(record);
  // A new explicit confirmation can replace the challenged default after ordinary scope checks.
  const confirmation = selected
    ? selected.confirmationWork
      ? yield* selected.confirmationWork(record.identityAttribution?.confirmationOperationId)
      : selected.confirmation(record.identityAttribution?.confirmationOperationId)
    : workflow?.identityConfirmations?.find(
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
  let person: ReturnType<typeof getNote> | undefined;
  if (authority) {
    try {
      person = getNote(db, authority.noteId);
    } catch {
      /* unavailable destination remains held */
    }
  }
  const blockerWork = function* (): Generator<void | string, void, void> {
    if (authority) {
      if (!person || person.archived || person.personId !== authority.personId)
        yield 'Choose an available destination person.';
      else {
        yield* ownershipIdentityBlockersWork(
          db,
          file!.id,
          record,
          person.person.birthDate,
          selected,
        );
        for (const issue of reviewRecordIssues(record)) {
          yield;
          if (
            issue.kind === 'identity' &&
            (issue.textAnchor ||
              issue.questionId ||
              issue.resolution?.outcome === 'unknown' ||
              issue.resolution?.outcome === 'other_person') &&
            !ownershipIdentityIssueIncluded(
              db,
              authority.identityIssues,
              ownershipHash([
                issue.prompt,
                issue.textAnchor,
                issue.questionId,
                issue.resolution?.outcome,
              ]),
            )
          ) {
            yield 'New identity evidence or a question needs explicit report review.';
            break;
          }
        }
      }
    } else
      yield reportHold
        ? 'A selected record contradicted the earlier report assignment; review this report’s person again.'
        : 'The corrected source or report boundary changed; review its identity again.';
  };
  const sink = selected?.blockerSink?.();
  if (sink) {
    for (const value of blockerWork()) {
      if (value !== undefined) sink.add(value);
      yield;
    }
  }
  const blockerValues = sink
    ? selectedSequence(() => sink.values())
    : ownershipDistinctValues(function* () {
        for (const value of blockerWork()) if (value !== undefined) yield value;
      });
  if (!authority || !person || blockerValues.some(() => true)) {
    const message = yield* ownershipHoldMessageWork(() => blockerValues);
    delete record.identityAttribution;
    delete record.mapping.personId;
    record.mapping.subject = 'unknown';
    const hold = {
      ...(before || { evidencedIdentity: {}, conflicts: [] }),
      status: 'confirmation_required' as const,
      blocking: true,
      ...message,
    };
    if (message.ownershipBlockers) bindOwnershipHoldMessage(hold, () => blockerValues);
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
    groupVersionId: group
      ? selected
        ? selected.currentVersionWork
          ? yield* selected.currentVersionWork(group)
          : selected.currentVersion(group)
        : (group as IntakeReportGroup).versions.at(-1)?.id || null
      : null,
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
  for (const issue of reviewRecordIssues(record)) {
    yield;
    if (issue.kind === 'identity') {
      issue.blocking = false;
      issue.status = 'resolved';
    }
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
  selected?: (intakeId: string, sourceRecordId: string) => SelectedOwnershipReviewScope | undefined,
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
        const complete = selected?.(c.sourceFileId, c.sourceRecordId);
        const intake = complete ? undefined : readStoredIntakeDetails(db, c.sourceFileId);
        const group = intake?.workflow?.reportGroups?.find((g) => g.id === groupId);
        const selectedSources = new Set(
          records.flatMap((r) =>
            r.contributions
              .filter((contribution) => contribution.selected)
              .map((contribution) => contribution.sourceRecordId),
          ),
        );
        const remaining = complete
          ? complete.remaining(groupId, selectedSources)
          : group?.versions
              .at(-1)
              ?.members.some((m) => m.occurrences.some((o) => !selectedSources.has(o.recordId)));
        if (!remaining) continue;
        const receipt = complete
          ? complete.lastConfirmation(groupId, record.owner.personId)
          : intake?.workflow?.identityConfirmations
              ?.filter(
                (r) =>
                  r.scope.groupId === groupId &&
                  (r.assignedPerson?.personId === record.owner.personId ||
                    (r.outcome === 'this_is_me' && record.owner.personId === 'patient')),
              )
              .at(-1);
        const defaultOperationId =
          authority?.personId === record.owner.personId && authority.intakeId === c.sourceFileId
            ? authority.operationId
            : receipt?.operationId;
        const intakeVersion = complete?.intakeVersion ?? intake?.version;
        if (!defaultOperationId || !intakeVersion) continue;
        if (
          latestOwnershipDecision(
            db,
            'Report ownership default hold',
            'defaultOperationId',
            defaultOperationId,
          )
        )
          continue;
        result.set(defaultOperationId, {
          intakeVersion,
          defaultOperationId,
          intakeId: c.sourceFileId,
          groupId,
        });
      }
  return [...result.values()].sort((a, b) =>
    a.defaultOperationId.localeCompare(b.defaultOperationId),
  );
}
