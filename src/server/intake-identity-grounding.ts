import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral } from './intake-format.ts';
import type { BirthDateEvidence } from './intake-evidence-dates.ts';
import {
  identityOriginalFingerprint,
  competingIdentityBoundaries,
} from './intake-identity-policy.ts';
import type { IntakeReportGroup, IntakeReviewIssue, IntakeWorkflow } from '../shared/intake.ts';
import type { IdentityGroundingReceipt } from './intake-identity-policy.ts';

type Question = Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>;
export type IdentityGroundingLookup = (
  group: IntakeReportGroup,
  issue: Question,
  receipt: IdentityGroundingReceipt,
) => boolean;
interface Boundary {
  profileId: string;
  intakeId: string;
  sourceHash: string;
  workflow: Pick<IntakeWorkflow, 'plans' | 'reportGroups'>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalLiteral(value)).digest('hex');
// Ephemeral original-grounding cache, never recovery authority. No page text is retained.
// Labelled DOB facts, including whether a printed DOB label was unreadable, are
// re-derived from the exact original after a cold restart.
// Each unlocked database owns at most 256 scopes, each with at most 100 exact
// question/receipt proofs. Reopening/rebuilding uses a new database and rechecks
// the scoped original through the existing asynchronous identity review.
interface Grounding {
  boundaryKey: string;
  questions: Pick<Set<string>, 'has'>;
  subject: boolean;
  nameQuestions: Pick<Set<string>, 'has'>;
  birthDates: BirthDateEvidence;
}
const grounded = new WeakMap<DatabaseSync, Map<string, Grounding>>();
const maxGroups = 256;
const maxQuestions = 100;
const boundaryKey = (boundary: Boundary, group: IntakeReportGroup) =>
  hash([
    boundary.profileId,
    boundary.intakeId,
    boundary.sourceHash,
    identityOriginalFingerprint(boundary.intakeId, boundary.sourceHash, group, boundary.workflow),
    group.id,
    group.sourceFileId,
    group.sourceHash,
    group.memberId,
    group.report,
    group.versions.at(-1),
    competingIdentityBoundaries(group, boundary.workflow.reportGroups || [])
      .map((other) => [other.id, other.report?.subject])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  ]);
// Keep proof and DOB facts atomic per report group. Separate model groups can
// share an original anchor, but checking one must not replace the other's proof.
// A fact read from immutable source bytes survives new candidate membership.
// Page/member/subject changes still require another original read.
const originalDateKey = (boundary: Boundary, group: IntakeReportGroup) =>
  hash([
    boundary.profileId,
    boundary.intakeId,
    boundary.sourceHash,
    identityOriginalFingerprint(boundary.intakeId, boundary.sourceHash, group, boundary.workflow),
    group.id,
    group.report?.subject,
    group.report?.anchor,
  ]);
const questionKey = (issue: Question, receipt: IdentityGroundingReceipt) =>
  hash([issue.prompt, issue.textAnchor, receipt.operationId, receipt.scope.scopeToken]);

/** Only the host's original-reading identity module supplies these proofs. */
export function retainIdentityGrounding(
  db: DatabaseSync,
  boundary: Boundary,
  group: IntakeReportGroup,
  questions: { issue: Question; receipt: IdentityGroundingReceipt }[],
  verifiedSubject = false,
  verifiedNameQuestions: Question[] = [],
  birthDates: BirthDateEvidence = { dates: [], unreadable: false },
): void {
  const proofs = new Set(questions.map(({ issue, receipt }) => questionKey(issue, receipt)));
  const nameQuestions = new Set(
    verifiedNameQuestions.map((issue) => hash([issue.prompt, issue.textAnchor])),
  );
  if (proofs.size > maxQuestions || nameQuestions.size > maxQuestions)
    throw new Error('Identity grounding scope exceeds its bound');
  let scopes = grounded.get(db);
  if (!scopes) grounded.set(db, (scopes = new Map()));
  const key = originalDateKey(boundary, group);
  // Replace every proof and DOB fact atomically, including negative results.
  // Eviction must never leave a name proof without its DOB knowledge.
  scopes.delete(key);
  scopes.set(key, {
    boundaryKey: boundaryKey(boundary, group),
    questions: proofs,
    subject: verifiedSubject,
    nameQuestions,
    birthDates: structuredClone(birthDates),
  });
  while (scopes.size > maxGroups) scopes.delete(scopes.keys().next().value!);
}

function proof(db: DatabaseSync, boundary: Boundary, group: IntakeReportGroup) {
  const entry = grounded.get(db)?.get(originalDateKey(boundary, group));
  return entry?.boundaryKey === boundaryKey(boundary, group) ? entry : undefined;
}

export function identitySubjectGroundingLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup): boolean => proof(db, boundary, group)?.subject === true;
}

export function identityNameQuestionGroundingLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup, issue: Question): boolean =>
    proof(db, boundary, group)?.nameQuestions.has(hash([issue.prompt, issue.textAnchor])) === true;
}

export function identityGroundingLookup(
  db: DatabaseSync,
  boundary: Boundary,
): IdentityGroundingLookup {
  return (group, issue, receipt) =>
    proof(db, boundary, group)?.questions.has(questionKey(issue, receipt)) === true;
}

export function identityOriginalBirthDateEvidenceLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup): BirthDateEvidence | undefined => {
    const entry = grounded.get(db)?.get(originalDateKey(boundary, group));
    return entry ? structuredClone(entry.birthDates) : undefined;
  };
}

/** One synchronous review owns this snapshot. Discard it before any write or await. */
export function identityReviewGroundingLookups(db: DatabaseSync, boundary: Boundary) {
  const entries = new Map<IntakeReportGroup, { entry?: Grounding; current: boolean }>();
  function lookup(group: IntakeReportGroup) {
    let value = entries.get(group);
    if (!value) {
      const entry = grounded.get(db)?.get(originalDateKey(boundary, group));
      value = { entry, current: !!entry && entry.boundaryKey === boundaryKey(boundary, group) };
      entries.set(group, value);
    }
    return value;
  }
  return {
    subjectGrounded: (group: IntakeReportGroup) => {
      const { entry, current } = lookup(group);
      return current && entry?.subject === true;
    },
    nameQuestionGrounded: (group: IntakeReportGroup, issue: Question) => {
      const { entry, current } = lookup(group);
      return current && entry?.nameQuestions.has(hash([issue.prompt, issue.textAnchor])) === true;
    },
    grounded: (group: IntakeReportGroup, issue: Question, receipt: IdentityGroundingReceipt) => {
      const { entry, current } = lookup(group);
      return current && entry?.questions.has(questionKey(issue, receipt)) === true;
    },
    originalBirthDateEvidence: (group: IntakeReportGroup) => {
      const { entry } = lookup(group);
      return entry ? structuredClone(entry.birthDates) : undefined;
    },
  };
}

/** Host-selected native authority supplies streamed boundary commitments, never a display page. */
export interface SelectedIdentityGroundingBoundary {
  profileId: string;
  intakeId: string;
  sourceHash: string;
  originalFingerprint(group: import('./intake-workflow.ts').WorkflowReviewGroup): string;
  boundaryFingerprint(group: import('./intake-workflow.ts').WorkflowReviewGroup): string;
}
const selectedOriginalDateKey = (
  boundary: SelectedIdentityGroundingBoundary,
  group: import('./intake-workflow.ts').WorkflowReviewGroup,
) =>
  hash([
    boundary.profileId,
    boundary.intakeId,
    boundary.sourceHash,
    boundary.originalFingerprint(group),
    group.id,
    group.report?.subject,
    group.report?.anchor,
  ]);
/** Native original review retains the same bounded proof set and original-date semantics. */
export function retainSelectedIdentityGrounding(
  db: DatabaseSync,
  boundary: SelectedIdentityGroundingBoundary,
  group: import('./intake-workflow.ts').WorkflowReviewGroup,
  questions: Iterable<{ issue: Question; receipt: IdentityGroundingReceipt }>,
  verifiedSubject = false,
  verifiedNameQuestions: Iterable<Question> = [],
  birthDates: BirthDateEvidence = { dates: [], unreadable: false },
): void {
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS intake_selected_identity_proofs(scope TEXT,kind TEXT,proof TEXT,PRIMARY KEY(scope,kind,proof)) WITHOUT ROWID',
  );
  const key = selectedOriginalDateKey(boundary, group);
  db.prepare('DELETE FROM intake_selected_identity_proofs WHERE scope=?').run(key);
  const add = db.prepare('INSERT OR IGNORE INTO intake_selected_identity_proofs VALUES(?,?,?)');
  for (const { issue, receipt } of questions) add.run(key, 'question', questionKey(issue, receipt));
  for (const issue of verifiedNameQuestions)
    add.run(key, 'name', hash([issue.prompt, issue.textAnchor]));
  const proofs = (kind: string) => ({
    has: (proof: string) =>
      !!db
        .prepare(
          'SELECT 1 FROM intake_selected_identity_proofs WHERE scope=? AND kind=? AND proof=?',
        )
        .get(key, kind, proof),
  });
  let scopes = grounded.get(db);
  if (!scopes) grounded.set(db, (scopes = new Map()));
  scopes.delete(key);
  scopes.set(key, {
    boundaryKey: boundary.boundaryFingerprint(group),
    questions: proofs('question'),
    subject: verifiedSubject,
    nameQuestions: proofs('name'),
    birthDates: structuredClone(birthDates),
  });
  while (scopes.size > maxGroups) {
    const old = scopes.keys().next().value!;
    scopes.delete(old);
    db.prepare('DELETE FROM intake_selected_identity_proofs WHERE scope=?').run(old);
  }
}
/** Discard before writes/awaits. Exact source dates survive membership changes; question proofs do not. */
export function selectedIdentityReviewGroundingLookups(
  db: DatabaseSync,
  boundary: SelectedIdentityGroundingBoundary,
) {
  type Group = import('./intake-workflow.ts').WorkflowReviewGroup;
  const entries = new WeakMap<Group, { entry?: Grounding; current: boolean }>();
  const lookup = (group: Group) => {
    let value = entries.get(group);
    if (!value) {
      const entry = grounded.get(db)?.get(selectedOriginalDateKey(boundary, group));
      value = {
        entry,
        current: !!entry && entry.boundaryKey === boundary.boundaryFingerprint(group),
      };
      entries.set(group, value);
    }
    return value;
  };
  return {
    subjectGrounded: (group: Group) => {
      const { entry, current } = lookup(group);
      return current && entry?.subject === true;
    },
    nameQuestionGrounded: (group: Group, issue: Question) => {
      const { entry, current } = lookup(group);
      return current && entry?.nameQuestions.has(hash([issue.prompt, issue.textAnchor])) === true;
    },
    grounded: (group: Group, issue: Question, receipt: IdentityGroundingReceipt) => {
      const { entry, current } = lookup(group);
      return current && entry?.questions.has(questionKey(issue, receipt)) === true;
    },
    originalBirthDateEvidence: (group: Group) => {
      const { entry } = lookup(group);
      return entry ? structuredClone(entry.birthDates) : undefined;
    },
  };
}
