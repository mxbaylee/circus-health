import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral } from './intake-format.ts';
import { identityOriginalFingerprint } from './intake-identity-policy.ts';
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
  workflow: Pick<IntakeWorkflow, 'plans'>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalLiteral(value)).digest('hex');
// Hashes only: neither extracted page text nor another store of identity facts.
// Each unlocked database owns at most 256 scopes, each with at most 100 exact
// question/receipt proofs. Reopening/rebuilding uses a new database and rechecks
// the scoped original through the existing asynchronous identity review.
const grounded = new WeakMap<DatabaseSync, Map<string, Set<string>>>();
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
  ]);
const questionKey = (issue: Question, receipt: IntakeIdentityReceipt) =>
  hash([issue.prompt, issue.textAnchor, receipt.operationId, receipt.scope.scopeToken]);

/** Only the host's original-reading identity module supplies these proofs. */
export function retainIdentityGrounding(
  db: DatabaseSync,
  boundary: Boundary,
  group: IntakeReportGroup,
  questions: { issue: Question; receipt: IntakeIdentityReceipt }[],
): void {
  const proofs = new Set(questions.map(({ issue, receipt }) => questionKey(issue, receipt)));
  if (proofs.size > maxQuestions) throw new Error('Identity grounding scope exceeds its bound');
  let scopes = grounded.get(db);
  if (!scopes) grounded.set(db, (scopes = new Map()));
  const key = boundaryKey(boundary, group);
  scopes.delete(key);
  if (!proofs.size) return;
  scopes.set(key, proofs);
  while (scopes.size > maxGroups) scopes.delete(scopes.keys().next().value!);
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
