import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observeDatabaseClose } from './database.ts';
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
  intakeId: string;
  semanticFingerprint: string;
  boundaryKey: string;
  questions: Pick<Set<string>, 'has'>;
  subject: boolean;
  nameQuestions: Pick<Set<string>, 'has'>;
  birthDates: BirthDateEvidence;
  dispose?: () => void;
}
const grounded = new WeakMap<DatabaseSync, Map<string, Grounding>>();
const generations = new WeakMap<DatabaseSync, object>();
const generationLabels = new WeakMap<object, string>();
/** Transport certificates compare this opaque label, never its ordering. */
export function identityGroundingReadStamp(db: DatabaseSync): string {
  const generation = identityGroundingGeneration(db);
  let label = generationLabels.get(generation);
  if (!label) generationLabels.set(generation, (label = randomUUID()));
  return label;
}
const sourceGenerations = new WeakMap<
  DatabaseSync,
  {
    baseline: string;
    sources: Map<string, { stamp: string; scopes: number }>;
  }
>();
function sourceGenerationState(db: DatabaseSync) {
  let state = sourceGenerations.get(db);
  if (!state) sourceGenerations.set(db, (state = { baseline: randomUUID(), sources: new Map() }));
  return state;
}
/** Only live proof owners occupy memory; absent owners share the clear/absence stamp. */
export function identityGroundingSourceStamp(db: DatabaseSync, intakeId: string): string {
  identityGroundingGeneration(db);
  const state = sourceGenerationState(db);
  return state.baseline + ':' + (state.sources.get(intakeId)?.stamp || '');
}
/** Disposable proof changes participate in clinical cache/session validity even without SQL writes. */
export function identityGroundingGeneration(db: DatabaseSync): object {
  let generation = generations.get(db);
  if (!generation) {
    generations.set(db, (generation = {}));
    if (db.isOpen) observeDatabaseClose(db, () => clearIdentityGrounding(db));
  }
  return generation;
}
function advanceGroundingGeneration(db: DatabaseSync, intakeId?: string) {
  identityGroundingGeneration(db);
  generations.set(db, {});
  if (intakeId) {
    const source = sourceGenerationState(db).sources.get(intakeId);
    if (source) source.stamp = randomUUID();
  }
}
function discardGrounding(
  db: DatabaseSync,
  scopes: Map<string, Grounding>,
  key: string,
  invalidate = true,
) {
  const previous = scopes.get(key);
  if (!previous) return;
  if (invalidate) advanceGroundingGeneration(db, previous.intakeId);
  scopes.delete(key);
  const state = sourceGenerationState(db),
    source = state.sources.get(previous.intakeId);
  if (source && --source.scopes === 0) state.sources.delete(previous.intakeId);
  previous?.dispose?.();
}
/** Clear before profile lock or database close, including native SQL proof rows. */
export function clearIdentityGrounding(db: DatabaseSync): void {
  advanceGroundingGeneration(db);
  const state = sourceGenerationState(db);
  state.baseline = randomUUID();
  state.sources.clear();
  const scopes = grounded.get(db);
  if (!scopes) return;
  const failures: unknown[] = [];
  for (const key of scopes.keys()) {
    try {
      discardGrounding(db, scopes, key, false);
    } catch (error) {
      failures.push(error);
    }
  }
  grounded.delete(db);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Identity grounding clear failed');
}
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

function semanticFingerprint(
  boundaryKey: string,
  subject: boolean,
  birthDates: BirthDateEvidence,
  proofs: Iterable<{ kind: string; proof: string }>,
): string {
  const digest = createHash('sha256').update(canonicalLiteral([boundaryKey, subject, birthDates]));
  for (const { kind, proof } of proofs) digest.update('\n' + kind + ':' + proof);
  return digest.digest('hex');
}
function publishGrounding(db: DatabaseSync, key: string, next: Grounding): void {
  let scopes = grounded.get(db);
  if (!scopes) grounded.set(db, (scopes = new Map()));
  if (scopes.get(key)?.semanticFingerprint === next.semanticFingerprint) return;
  // Advance before any destructive disposal. A throwing disposer cannot revive
  // an older clinical session, even if later publication restores the same facts.
  advanceGroundingGeneration(db, next.intakeId);
  discardGrounding(db, scopes, key, false);
  scopes.set(key, next);
  const sources = sourceGenerationState(db).sources,
    source = sources.get(next.intakeId);
  if (source) source.scopes++;
  else sources.set(next.intakeId, { stamp: randomUUID(), scopes: 1 });
  while (scopes.size > maxGroups) discardGrounding(db, scopes, scopes.keys().next().value!);
}

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
  const key = originalDateKey(boundary, group);
  const selectedBoundary = boundaryKey(boundary, group),
    dates = structuredClone(birthDates);
  // Replace every proof and DOB fact atomically, including negative results.
  // Eviction must never leave a name proof without its DOB knowledge.
  publishGrounding(db, key, {
    intakeId: boundary.intakeId,
    semanticFingerprint: semanticFingerprint(
      selectedBoundary,
      verifiedSubject,
      dates,
      (function* () {
        for (const proof of [...nameQuestions].sort()) yield { kind: 'name', proof };
        for (const proof of [...proofs].sort()) yield { kind: 'question', proof };
      })(),
    ),
    boundaryKey: selectedBoundary,
    questions: proofs,
    subject: verifiedSubject,
    nameQuestions,
    birthDates: dates,
  });
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
  const generation = identityGroundingGeneration(db);
  const entries = new Map<IntakeReportGroup, { entry?: Grounding; current: boolean }>();
  function lookup(group: IntakeReportGroup) {
    if (!db.isOpen || identityGroundingGeneration(db) !== generation)
      throw Error('Identity grounding snapshot changed');
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
  const storageScope = randomUUID(),
    selectedBoundary = boundary.boundaryFingerprint(group),
    dates = structuredClone(birthDates);
  const add = db.prepare('INSERT OR IGNORE INTO intake_selected_identity_proofs VALUES(?,?,?)');
  const dispose = () => {
    if (db.isOpen)
      db.prepare('DELETE FROM intake_selected_identity_proofs WHERE scope=?').run(storageScope);
  };
  const proofs = (kind: string) => ({
    has: (proof: string) =>
      !!db
        .prepare(
          'SELECT 1 FROM intake_selected_identity_proofs WHERE scope=? AND kind=? AND proof=?',
        )
        .get(storageScope, kind, proof),
  });
  let next: Grounding | undefined;
  try {
    // Unpublished SQL staging keeps deduplication and canonical ordering bounded
    // without destroying the complete prior scope when an input iterator fails.
    for (const { issue, receipt } of questions)
      add.run(storageScope, 'question', questionKey(issue, receipt));
    for (const issue of verifiedNameQuestions)
      add.run(storageScope, 'name', hash([issue.prompt, issue.textAnchor]));
    next = {
      intakeId: boundary.intakeId,
      semanticFingerprint: semanticFingerprint(
        selectedBoundary,
        verifiedSubject,
        dates,
        (function* () {
          for (const row of db
            .prepare(
              'SELECT kind,proof FROM intake_selected_identity_proofs WHERE scope=? ORDER BY kind,proof',
            )
            .iterate(storageScope))
            yield { kind: String(row.kind), proof: String(row.proof) };
        })(),
      ),
      boundaryKey: selectedBoundary,
      questions: proofs('question'),
      subject: verifiedSubject,
      nameQuestions: proofs('name'),
      birthDates: dates,
      dispose,
    };
    publishGrounding(db, key, next);
  } finally {
    // Identical publication retains its prior scope/generation. Nonempty staging
    // still changes SQLite stamps; an empty repeat performs no proof-row writes.
    if (!next || grounded.get(db)?.get(key) !== next) dispose();
  }
}
/** Discard before writes/awaits. Exact source dates survive membership changes; question proofs do not. */
export function selectedIdentityReviewGroundingLookups(
  db: DatabaseSync,
  boundary: SelectedIdentityGroundingBoundary,
) {
  const generation = identityGroundingGeneration(db);
  type Group = import('./intake-workflow.ts').WorkflowReviewGroup;
  const entries = new WeakMap<Group, { entry?: Grounding; current: boolean }>();
  const lookup = (group: Group) => {
    if (!db.isOpen || identityGroundingGeneration(db) !== generation)
      throw Error('Identity grounding snapshot changed');
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
