import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral } from './intake-format.ts';
import type { BirthDateEvidence } from './intake-evidence-dates.ts';
import {
  identityOriginalFingerprint,
  competingIdentityBoundaries,
} from './intake-identity-policy.ts';
import type { IntakeReportGroup, IntakeReviewIssue, IntakeWorkflow } from '../shared/intake.ts';
import type { IntakeIdentityReceipt } from '../shared/intake-identity.ts';

type Question = Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>;
export type IdentityGroundingLookup = (
  group: IntakeReportGroup,
  issue: Question,
  receipt: IntakeIdentityReceipt,
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
const grounded = new WeakMap<DatabaseSync, Map<string, Set<string>>>();
const subjectGrounded = new WeakMap<DatabaseSync, Set<string>>();
const nameQuestionsGrounded = new WeakMap<DatabaseSync, Map<string, Set<string>>>();
const originalDates = new WeakMap<DatabaseSync, Map<string, BirthDateEvidence>>();
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
// A fact read from immutable source bytes survives new candidate membership.
// Page/member/subject changes still require another original read.
const originalDateKey = (boundary: Boundary, group: IntakeReportGroup) =>
  hash([
    boundary.profileId,
    boundary.intakeId,
    boundary.sourceHash,
    identityOriginalFingerprint(boundary.intakeId, boundary.sourceHash, group, boundary.workflow),
    group.report?.subject,
    group.report?.anchor,
  ]);
const questionKey = (issue: Question, receipt: IntakeIdentityReceipt) =>
  hash([issue.prompt, issue.textAnchor, receipt.operationId, receipt.scope.scopeToken]);

/** Only the host's original-reading identity module supplies these proofs. */
export function retainIdentityGrounding(
  db: DatabaseSync,
  boundary: Boundary,
  group: IntakeReportGroup,
  questions: { issue: Question; receipt: IntakeIdentityReceipt }[],
  verifiedSubject = false,
  verifiedNameQuestions: Question[] = [],
  birthDates: BirthDateEvidence = { dates: [], unreadable: false },
): void {
  const proofs = new Set(questions.map(({ issue, receipt }) => questionKey(issue, receipt)));
  if (proofs.size > maxQuestions) throw new Error('Identity grounding scope exceeds its bound');
  let scopes = grounded.get(db);
  if (!scopes) grounded.set(db, (scopes = new Map()));
  const key = boundaryKey(boundary, group);
  let dates = originalDates.get(db);
  if (!dates) originalDates.set(db, (dates = new Map()));
  const dateKey = originalDateKey(boundary, group);
  dates.delete(dateKey);
  dates.set(dateKey, { dates: [...birthDates.dates], unreadable: birthDates.unreadable });
  while (dates.size > maxGroups) dates.delete(dates.keys().next().value!);
  const nameQuestionProofs = new Set(
    verifiedNameQuestions.map((issue) => hash([issue.prompt, issue.textAnchor])),
  );
  if (nameQuestionProofs.size > maxQuestions)
    throw new Error('Identity grounding scope exceeds its bound');
  if (verifiedNameQuestions.length) {
    let questions = nameQuestionsGrounded.get(db);
    if (!questions) nameQuestionsGrounded.set(db, (questions = new Map()));
    questions.delete(key);
    questions.set(key, nameQuestionProofs);
    while (questions.size > maxGroups) questions.delete(questions.keys().next().value!);
  }
  if (verifiedSubject) {
    let subjects = subjectGrounded.get(db);
    if (!subjects) subjectGrounded.set(db, (subjects = new Set()));
    subjects.delete(key);
    subjects.add(key);
    while (subjects.size > maxGroups) subjects.delete(subjects.values().next().value!);
  }
  scopes.delete(key);
  if (!proofs.size) return;
  scopes.set(key, proofs);
  while (scopes.size > maxGroups) scopes.delete(scopes.keys().next().value!);
}

export function identitySubjectGroundingLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup): boolean =>
    subjectGrounded.get(db)?.has(boundaryKey(boundary, group)) === true;
}

export function identityNameQuestionGroundingLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup, issue: Question): boolean =>
    nameQuestionsGrounded
      .get(db)
      ?.get(boundaryKey(boundary, group))
      ?.has(hash([issue.prompt, issue.textAnchor])) === true;
}

export function identityGroundingLookup(
  db: DatabaseSync,
  boundary: Boundary,
): IdentityGroundingLookup {
  const keys = new Map<IntakeReportGroup, string>();
  return (group, issue, receipt) => {
    let key = keys.get(group);
    if (!key) keys.set(group, (key = boundaryKey(boundary, group)));
    return grounded.get(db)?.get(key)?.has(questionKey(issue, receipt)) === true;
  };
}

export function identityOriginalBirthDateEvidenceLookup(db: DatabaseSync, boundary: Boundary) {
  return (group: IntakeReportGroup): BirthDateEvidence | undefined => {
    const evidence = originalDates.get(db)?.get(originalDateKey(boundary, group));
    return evidence ? { dates: [...evidence.dates], unreadable: evidence.unreadable } : undefined;
  };
}
