/** Exact changed-row projection preparation. SQLite is only a disposable staging surface. */
import { constants, type DatabaseSync, type Session } from 'node:sqlite';
import { cloneLiteral } from './intake-format.ts';
import {
  HttpError,
  revision,
  currentTransactionToken,
  rejectCurrentTransaction,
  observeTransactionOutcome,
} from './database.ts';
import {
  projectClinicalReview,
  retainedClinicalSourceRecord,
  validateClinicalPairScopes,
} from './clinical-import.ts';
import {
  refreshOccurrenceAttachmentAuthorities,
  type OccurrenceAuthorityFinalizer,
} from './duplicate-review.ts';
import { matchingClinicalSourceCanonicals } from './intake-clinical-source-index.ts';
import {
  collectionClinicalProjectionContext,
  type CollectionClinicalReviewSession,
} from './intake-review-collection-session.ts';
import type { IntakeReviewDecision } from '../shared/intake.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import {
  prepareDuplicateEvidenceSnapshots,
  type PreparedDuplicateEvidence,
} from './duplicate-evidence-preparation.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';

declare const projectionBrand: unique symbol;
export interface PreparedClinicalProjection {
  readonly [projectionBrand]: true;
  readonly format: 'health-intake-clinical-projection-plan-v1';
}
type Result = ReturnType<typeof projectClinicalReview> & { newMedications: number };
interface State {
  db: DatabaseSync;
  results: (Result | undefined)[];
  changes: Uint8Array;
  guards: Session[];
  assertCurrent(): void;
  applied: boolean;
  appliedToken?: object;
  sessions: CollectionClinicalReviewSession[];
  closed: boolean;
  matchingEarlierRows: number[];
  stopObserving(): void;
  evidence?: PreparedDuplicateEvidence;
}
const plans = new WeakMap<PreparedClinicalProjection, State>();
const activePlans = new WeakMap<DatabaseSync, Set<PreparedClinicalProjection>>();
const MAX_ACTIVE_PLANS = 64;
function state(plan: PreparedClinicalProjection): State {
  const value = plans.get(plan);
  if (!value || value.closed) throw Error('Foreign or disposed clinical projection plan');
  return value;
}
const changed = () =>
  new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected clinical review');

/** No awaits, filesystem writes, durability publication, or whole-table snapshots occur here. */
export function prepareCollectionClinicalProjection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  review: CollectionClinicalReviewSession,
  decisions: IntakeReviewDecision[],
  options: { reviewed?: boolean } = {},
): PreparedClinicalProjection {
  return prepareCollectionClinicalProjectionGroup(db, root, profileId, [
    { session: review, decisions, ...options },
  ]);
}

export function prepareCollectionClinicalProjectionGroup(
  db: DatabaseSync,
  root: string,
  profileId: string,
  members: {
    session: CollectionClinicalReviewSession;
    decisions: IntakeReviewDecision[];
    reviewed?: boolean;
  }[],
): PreparedClinicalProjection {
  return prepareProjectionGroup(db, root, profileId, members);
}
export async function prepareCollectionClinicalProjectionWithEvidence(
  db: DatabaseSync,
  root: string,
  profileId: string,
  session: CollectionClinicalReviewSession,
  decisions: IntakeReviewDecision[],
  options: { reviewed?: boolean } = {},
) {
  return prepareCollectionClinicalProjectionGroupWithEvidence(db, root, profileId, [
    { session, decisions, ...options },
  ]);
}
export async function prepareCollectionClinicalProjectionGroupWithEvidence(
  db: DatabaseSync,
  root: string,
  profileId: string,
  members: {
    session: CollectionClinicalReviewSession;
    decisions: IntakeReviewDecision[];
    reviewed?: boolean;
  }[],
) {
  const selected = members.map((member) => ({
    ...member,
    decisions: structuredClone(member.decisions),
  }));
  const pairScopes = validatePreparedEvidencePairs(db, selected);
  const evidence = await prepareDuplicateEvidenceSnapshots(db, selected);
  try {
    return prepareProjectionGroup(db, root, profileId, selected, undefined, evidence, pairScopes);
  } catch (error) {
    evidence.dispose();
    throw error;
  }
}
export async function prepareCollectionClinicalTerminalPairProjectionWithEvidence(
  db: DatabaseSync,
  root: string,
  profileId: string,
  session: CollectionClinicalReviewSession,
  decision: IntakeReviewDecision,
) {
  if (decision.action !== 'skip' || !decision.comparisons?.length)
    throw new HttpError(400, 'IMPORT_REVIEW', 'Choose a reviewed terminal evidence relationship');
  const members = [{ session, decisions: [structuredClone(decision)] }],
    pairScopes = validatePreparedEvidencePairs(db, members),
    evidence = await prepareDuplicateEvidenceSnapshots(db, members);
  try {
    return prepareProjectionGroup(
      db,
      root,
      profileId,
      members,
      decision.recordId,
      evidence,
      pairScopes,
    );
  } catch (error) {
    evidence.dispose();
    throw error;
  }
}
function validatePreparedEvidencePairs(
  db: DatabaseSync,
  members: {
    session: CollectionClinicalReviewSession;
    decisions: IntakeReviewDecision[];
    reviewed?: boolean;
  }[],
) {
  return members.map((member) => {
    const context = collectionClinicalProjectionContext(member.session);
    return member.reviewed === false
      ? undefined
      : validateClinicalPairScopes(
          db,
          context.proposal.file,
          context.proposal.inputFile,
          context.proposal.entries,
          context.review,
          member.decisions,
          context.selected,
        );
  });
}
/** Merge these builds-only changes when this source already owns an envelope mutation. */
export function preparedClinicalEvidenceChanges(
  plan: PreparedClinicalProjection,
  sourceId: string,
): readonly IntakeCollectionChange[] {
  return state(plan).evidence?.changes(sourceId) || [];
}

/** Retain one displayed terminal pair choice without accepting candidates or
 * publishing unrelated proposal rows. Complete policy callbacks and the
 * original session's guards still authorize its exact selected record. */
export function prepareCollectionClinicalTerminalPairProjection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  session: CollectionClinicalReviewSession,
  decision: IntakeReviewDecision,
): PreparedClinicalProjection {
  if (decision.action !== 'skip' || !decision.comparisons?.length)
    throw new HttpError(400, 'IMPORT_REVIEW', 'Choose a reviewed terminal evidence relationship');
  return prepareProjectionGroup(
    db,
    root,
    profileId,
    [{ session, decisions: [decision] }],
    decision.recordId,
  );
}

function prepareProjectionGroup(
  db: DatabaseSync,
  root: string,
  profileId: string,
  members: {
    session: CollectionClinicalReviewSession;
    decisions: IntakeReviewDecision[];
    reviewed?: boolean;
  }[],
  terminalRecordId?: string,
  evidence?: PreparedDuplicateEvidence,
  preparedPairScopes?: (Set<string> | undefined)[],
): PreparedClinicalProjection {
  if (!members.length) throw Error('Clinical projection group is empty');
  if (db.isTransaction)
    throw Error('Prepare clinical projection before the application transaction');
  const beforeRevision = revision(db);
  const blocks = members.map((member, memberIndex) => {
    const originalContext = collectionClinicalProjectionContext(member.session),
      complete = evidence
        ? {
            ...originalContext,
            selected: { ...originalContext.selected, duplicateEvidence: evidence.reference },
          }
        : originalContext,
      context =
        terminalRecordId === undefined
          ? complete
          : {
              ...complete,
              proposal: {
                ...complete.proposal,
                entries: complete.proposal.entries.filter(
                  (entry) =>
                    complete.proposal.inputFile.id + ':line:' + entry.line === terminalRecordId,
                ),
              },
              review: {
                ...complete.review,
                records: complete.review.records.filter((record) => record.id === terminalRecordId),
              },
            },
      reviewed = member.reviewed !== false,
      decisions = cloneLiteral(member.decisions);
    if (
      terminalRecordId !== undefined &&
      (context.proposal.entries.length !== 1 || context.review.records.length !== 1)
    )
      throw new HttpError(
        400,
        'IMPORT_REVIEW',
        'Choose one record from the complete selected review',
      );
    if (context.db !== db || context.profileId !== profileId)
      throw Error('Foreign clinical projection context');
    if (!reviewed && context.proposal.entries.some((entry) => !!entry.value.clinical))
      throw new HttpError(409, 'REVIEW_REQUIRED', 'Review clinical records before accepting them');
    if (member.session.review.sourceTextStale)
      throw new HttpError(
        409,
        'SOURCE_TEXT_CHANGED',
        'Review the current source text before acceptance',
      );
    const acquisition = db
      .prepare('SELECT provider_id,batch_id FROM source_files WHERE id=?')
      .get(context.proposal.file.id);
    if (!acquisition) throw changed();
    // The async audit preparation may publish certified auxiliary checkpoints.
    // Its private complete proof retains the original strict request CAS and
    // rechecks every source/clinical/target dependency before this projection.
    const prevalidatedPairScopes = preparedPairScopes
      ? preparedPairScopes[memberIndex]
      : reviewed
        ? validateClinicalPairScopes(
            db,
            context.proposal.file,
            context.proposal.inputFile,
            context.proposal.entries,
            context.review,
            decisions,
            context.selected,
          )
        : undefined;
    return {
      context,
      reviewed,
      decisions,
      acquisition,
      matchingEarlierRows: 0,
      prevalidatedPairScopes,
    };
  });
  // Complete prepared fingerprints answer only selected changed-entry digests.
  // No prior provider source JSON is read during warm acceptance preparation.
  for (const providerId of new Set(blocks.map((block) => block.acquisition.provider_id))) {
    const selected = blocks.filter((block) => block.acquisition.provider_id === providerId),
      pending = new Set(
        selected.flatMap((block) => block.context.proposal.entries.map((entry) => entry.canonical)),
      ),
      matches = matchingClinicalSourceCanonicals(db, providerId, pending);
    for (const block of selected)
      block.matchingEarlierRows = block.context.proposal.entries.filter((entry) =>
        matches.has(entry.canonical),
      ).length;
  }
  withIntakeWork(db, 'warm', () => {
    recordIntakeWork(
      'clinicalProjectionRetainedEntries',
      blocks.reduce((n, block) => n + block.context.proposal.entries.length, 0),
    );
  });
  const assertContextsCurrent = () => {
    for (const { context } of blocks) context.assertCurrent();
  };
  const dataVersion = Number(db.prepare('PRAGMA data_version').get()!.data_version);
  const results: (Result | undefined)[] = [];
  let changes: Uint8Array;
  const capture = db.createSession();
  db.exec('SAVEPOINT clinical_projection_prepare');
  try {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO source_records(id,source_file_id,provider_id,source_key,kind,label,raw_json,locator_json,extraction_status,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    const occurrenceAuthorityFinalizers: OccurrenceAuthorityFinalizer[] = [];
    for (const { context, reviewed, decisions, acquisition, prevalidatedPairScopes } of blocks) {
      for (const entry of context.proposal.entries) {
        const retained = retainedClinicalSourceRecord(
          entry,
          context.proposal.inputFile.id,
          context.proposal.file.id,
          context.proposal.proposalId,
          String(acquisition.provider_id),
          String(acquisition.batch_id),
        );
        insert.run(
          retained.id,
          retained.sourceFileId,
          retained.providerId,
          retained.sourceKey,
          retained.kind,
          retained.label,
          retained.raw,
          retained.locator,
          retained.extractionStatus,
          retained.batchId,
        );
      }
      if (reviewed) {
        context.selected.materializeSourceProviders();
        const medicationsBefore = Number(
          db.prepare('SELECT count(*) AS n FROM medications').get()!.n,
        );
        const clinical = projectClinicalReview(db, {
          ...context.proposal,
          review: context.review,
          decisions: cloneLiteral(decisions),
          root,
          profileId,
          selected: context.selected,
          prevalidatedPairScopes,
          occurrenceAuthorityFinalizers,
        });
        results.push({
          ...clinical,
          newMedications: Math.max(
            0,
            Number(db.prepare('SELECT count(*) AS n FROM medications').get()!.n) -
              medicationsBefore,
          ),
        });
      } else results.push(undefined);
    }
    refreshOccurrenceAttachmentAuthorities(db, occurrenceAuthorityFinalizers);
    changes = capture.changeset();
    withIntakeWork(db, 'warm', () =>
      recordIntakeWork('clinicalProjectionChangesetBytes', changes.byteLength),
    );
  } finally {
    try {
      db.exec('ROLLBACK TO clinical_projection_prepare');
    } finally {
      try {
        db.exec('RELEASE clinical_projection_prepare');
      } finally {
        capture.close();
      }
    }
  }
  assertContextsCurrent();
  if (revision(db) !== beforeRevision) throw changed();
  // Capture only subsequent application-row changes. Cache/schema preparation may
  // touch private __ tables; it cannot authorize changes to clinical dependencies.
  const guards: Session[] = [];
  const tables: string[] = [];
  try {
    for (const row of db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '__*' AND name NOT GLOB 'sqlite_*'",
      )
      .iterate()) {
      tables.push(String(row.name));
      guards.push(db.createSession({ table: String(row.name) }));
    }
  } catch (error) {
    for (const guard of guards) guard.close();
    throw error;
  }
  const plan = Object.freeze({
    format: 'health-intake-clinical-projection-plan-v1',
  }) as PreparedClinicalProjection;
  let guardedRevision = beforeRevision,
    invalidated = false;
  const stopObserving = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.committed) return;
    if (!outcome.intakeMaintenance || !outcome.succeeded || invalidated) {
      invalidated = true;
      return;
    }
    // Only the owning transaction verifier can mint this outcome witness. It
    // proves exact auxiliary writes and unchanged source/logical/domain scope.
    // Never forgive an ordinary policy write by excluding metadata namespaces.
    invalidated = true;
    assertContextsCurrent();
    if (
      revision(db) !== guardedRevision + 1 ||
      Number(db.prepare('PRAGMA data_version').get()!.data_version) !== dataVersion ||
      guards.some((guard, index) => tables[index] !== 'app_meta' && guard.changeset().length !== 0)
    )
      return;
    const index = tables.indexOf('app_meta');
    if (index < 0) return;
    guards[index]!.close();
    guards[index] = db.createSession({ table: 'app_meta' });
    guardedRevision = revision(db);
    invalidated = false;
  });
  plans.set(plan, {
    db,
    results: structuredClone(results),
    changes: changes!,
    guards,
    applied: false,
    sessions: members.map((member) => member.session),
    closed: false,
    matchingEarlierRows: blocks.map((block) => block.matchingEarlierRows),
    stopObserving,
    evidence,
    assertCurrent() {
      assertContextsCurrent();
      evidence?.assertCurrent();
      if (
        invalidated ||
        revision(db) !== guardedRevision ||
        Number(db.prepare('PRAGMA data_version').get()!.data_version) !== dataVersion ||
        guards.some((guard) => guard.changeset().length !== 0)
      )
        throw changed();
    },
  });
  let active = activePlans.get(db);
  if (!active) activePlans.set(db, (active = new Set()));
  while (active.size >= MAX_ACTIVE_PLANS)
    disposePreparedClinicalProjection(active.values().next().value!);
  active.add(plan);
  return plan;
}

export function preparedClinicalProjectionMatchingRows(plan: PreparedClinicalProjection): number {
  const value = state(plan);
  if (!value.applied) value.assertCurrent();
  if (value.results.length !== 1) throw Error('Use grouped projection results');
  return value.matchingEarlierRows[0]!;
}

/** Exact result produced by the retained projector, not an estimate or fabricated receipt. */
export function preparedClinicalProjectionResult(
  plan: PreparedClinicalProjection,
): Result | undefined {
  const value = state(plan);
  if (!value.applied) value.assertCurrent();
  if (value.results.length !== 1) throw Error('Use grouped projection results');
  return structuredClone(value.results[0]);
}

/** Call first inside the final ordinary transaction, before adopting the new envelope. */
export function applyPreparedClinicalProjection(
  db: DatabaseSync,
  plan: PreparedClinicalProjection,
): Result | undefined {
  if (state(plan).results.length !== 1) throw Error('Use grouped projection application');
  return applyPreparedClinicalProjectionGroup(db, plan)[0];
}
export function preparedClinicalProjectionGroupResults(plan: PreparedClinicalProjection) {
  const value = state(plan);
  if (!value.applied) value.assertCurrent();
  return value.results.map((clinical, index) => ({
    clinical: structuredClone(clinical),
    matchingEarlierRows: value.matchingEarlierRows[index]!,
  }));
}
export function preparedClinicalProjectionMember(
  db: DatabaseSync,
  plan: PreparedClinicalProjection,
  index: number,
  session: CollectionClinicalReviewSession,
) {
  const value = state(plan);
  if (
    value.db !== db ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    value.sessions[index] !== session
  )
    throw Error('Foreign clinical projection member');
  if (!value.applied) value.assertCurrent();
  return {
    clinical: structuredClone(value.results[index]),
    matchingEarlierRows: value.matchingEarlierRows[index]!,
  };
}
export function assertPreparedClinicalProjectionMember(
  db: DatabaseSync,
  plan: PreparedClinicalProjection,
  index: number,
  session: CollectionClinicalReviewSession,
): void {
  preparedClinicalProjectionMember(db, plan, index, session);
  const value = state(plan),
    token = currentTransactionToken(db);
  if (!token || !value.applied || value.appliedToken !== token)
    throw Error('Clinical projection member has not been applied in this transaction');
}
export function applyPreparedClinicalProjectionGroup(
  db: DatabaseSync,
  plan: PreparedClinicalProjection,
): (Result | undefined)[] {
  const value = state(plan),
    token = currentTransactionToken(db);
  if (value.db !== db || !token)
    throw Error('Clinical projection requires its ordinary application transaction');
  try {
    if (value.applied) throw changed();
    value.assertCurrent();
    value.evidence?.applyStandalone();
    if (!db.applyChangeset(value.changes, { onConflict: () => constants.SQLITE_CHANGESET_ABORT }))
      throw changed();
    value.applied = true;
    value.appliedToken = token;
    const stop = observeTransactionOutcome(db, (outcome) => {
      if (outcome.token !== token) return;
      stop();
      // A failed outer publication rolls back both projection and envelope.
      // Its plan can be retried against the same unchanged dependencies.
      if (!outcome.committed) {
        value.applied = false;
        value.appliedToken = undefined;
      }
    });
    return structuredClone(value.results);
  } catch (error) {
    rejectCurrentTransaction(db, error);
    throw error;
  }
}

export function disposePreparedClinicalProjection(plan: PreparedClinicalProjection): void {
  const value = plans.get(plan);
  if (!value || value.closed) return;
  for (const guard of value.guards) guard.close();
  value.stopObserving();
  value.evidence?.dispose();
  value.closed = true;
  activePlans.get(value.db)?.delete(plan);
}

/** Profile/session owners call before closing the SQLite connection. */
export function clearPreparedClinicalProjections(db: DatabaseSync): void {
  for (const plan of activePlans.get(db) ?? []) disposePreparedClinicalProjection(plan);
  activePlans.delete(db);
}
