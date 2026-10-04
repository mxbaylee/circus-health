import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, now } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import { createIntakeReviewSession, flushIntake, intakeTransaction } from './intake.ts';
import { acceptanceOwner, applyAcceptanceGroup } from './intake-report-acceptance.ts';
import { identityPeopleSnapshots } from './intake-identity-people.ts';
import { effectiveKnownNames } from './name-associations.ts';
import { getNote } from './notes.ts';
import { canonicalIdentityName, possiblySameIdentityName } from '../shared/self-identity.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  hasNativeAcceptanceBlock,
  applyNativeAcceptanceGroup,
} from './intake-report-acceptance-native.ts';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceBlock,
  IntakePartialAcceptanceItem,
  IntakePartialAcceptanceReceipt,
  IntakeReportAcceptanceResult,
  IntakeReview,
} from '../shared/intake.ts';

type Entry = {
  block: Omit<IntakeReportAcceptanceBlock, 'selections'>;
  selection: IntakeReportAcceptanceBlock['selections'][number];
  childId: string;
  label?: string;
  kind?: IntakePartialAcceptanceItem['kind'];
  personId?: string;
  personNoteId?: string;
  identityName?: string;
  reportName?: string;
};
type Manifest = {
  fingerprint: string;
  at: string;
  operationId: string;
  entries: Entry[];
  groups: number[][];
};
type ReviewSource = { filename: string; review(proposalId: string | null): IntakeReview };
type AcceptanceStep = {
  request: IntakeReportAcceptanceRequest;
  fingerprint: string;
  retainResult: NonNullable<Parameters<typeof applyAcceptanceGroup>[5]>;
  reviews: Map<string, IntakeReview | null>;
};
/** A bounded set of selected proposal reviews, never an intake workflow page. */
async function prepareNativePartialReviews(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
) {
  const { hasIntakeCollectionEnvelope } = await import('./intake-collection-envelope.ts');
  const { buildIntakeCollectionEnvelope } = await import('./intake-envelope-build.ts');
  const { prepareRetainedPlanAccess } = await import('./intake-retained-plan.ts');
  const { prepareCollectionWorkflowReadiness } = await import('./intake-workflow-readiness.ts');
  const { prepareCollectionClinicalReview, prepareCollectionClinicalReviewDependencies } =
    await import('./intake-review-collection-host.ts');
  const { intakeSourceMetadata } = await import('./intake-state-access.ts');
  const { activeMappingRules } = await import('./clinical-import.ts');
  const { workflowHash } = await import('./intake-workflow.ts');
  const { getIntakeRead } = await import('./intake.ts');
  const { intakeFilenameDisplay } = await import('../shared/intake-summary.ts');
  const prepared = new Map<string, ReviewSource | Error>();
  const sessions: Extract<
    ReturnType<typeof prepareCollectionClinicalReview>,
    { status: 'ready' }
  >['session'][] = [];
  const close = () => {
    for (const session of sessions) session.close();
    sessions.length = 0;
  };
  try {
    for (const id of new Set(request.blocks.map((block) => block.intakeId))) {
      try {
        if (!hasIntakeCollectionEnvelope(db, { id }))
          await buildIntakeCollectionEnvelope(db, { id });
        await prepareRetainedPlanAccess(db, profileId, id);
        const currentMappingVersion = () =>
          workflowHash(
            activeMappingRules(
              db,
              intakeSourceMetadata(db, id).metadata?.sourceProviderId ||
                String(
                  db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(id)
                    ?.provider_id,
                ),
            ),
          );
        const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
          mappingVersion: currentMappingVersion(),
          currentMappingVersion,
        });
        if (ready.state !== 'ready')
          throw new HttpError(
            409,
            'WORKFLOW_PREPARATION_REQUIRED',
            'Prepare this report before approving its records',
          );
        const reviews = new Map<string | null, IntakeReview>();
        for (const block of request.blocks.filter((block) => block.intakeId === id)) {
          if (reviews.has(block.proposalId)) continue;
          await prepareCollectionClinicalReviewDependencies(
            db,
            root,
            profileId,
            id,
            block.proposalId,
          );
          const result = prepareCollectionClinicalReview(db, root, profileId, id, block.proposalId);
          if (result.status !== 'ready')
            throw new HttpError(
              409,
              'REVIEW_PREPARATION_REQUIRED',
              'Prepare this selected clinical evidence before accepting it',
            );
          sessions.push(result.session);
          reviews.set(block.proposalId, result.session.review);
        }
        prepared.set(id, {
          filename: intakeFilenameDisplay(getIntakeRead(db, root, profileId, id)),
          review(proposalId) {
            const review = reviews.get(proposalId);
            if (!review)
              throw new HttpError(404, 'NOT_FOUND', 'Selected proposal was not prepared');
            return review;
          },
        });
      } catch (error) {
        if (!(error instanceof HttpError) || [401, 403].includes(error.status)) throw error;
        prepared.set(id, error);
      }
    }
    return { sources: prepared, close };
  } catch (error) {
    close();
    throw error;
  }
}
const prefix = 'intake_partial_acceptance:v1:';
const active = new WeakMap<DatabaseSync, Set<string>>();
const activeFor = (db: DatabaseSync) => {
  let operations = active.get(db);
  if (!operations) active.set(db, (operations = new Set()));
  return operations;
};
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const childId = (parent: string, identity: unknown) => {
  const hash = digest([parent, identity]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
function read<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + key);
  return row ? (JSON.parse(String(row.value)) as T) : null;
}
function write(db: DatabaseSync, key: string, value: unknown) {
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
    prefix + key,
    JSON.stringify(value),
  );
}
const itemKey = (manifest: Manifest, index: number) => `${manifest.operationId}:item:${index}`;
const identity = (entry: Entry): Omit<IntakePartialAcceptanceItem, 'status'> => ({
  ...(entry.label ? { label: entry.label } : {}),
  ...(entry.kind ? { kind: entry.kind } : {}),
  ...(entry.personId ? { personId: entry.personId } : {}),
  ...(entry.reportName ? { reportName: entry.reportName } : {}),
  selectionReviewToken: entry.selection.selectionReviewToken!,
  reviewedSelectionHash: digest(entry.selection),
  intakeId: entry.block.intakeId,
  proposalId: entry.block.proposalId,
  recordId: entry.selection.recordId,
  candidateId: entry.selection.candidateId,
  candidateVersionId: entry.selection.candidateVersionId,
  operationId: entry.childId,
});

export const hasPartialAcceptance = (db: DatabaseSync, operationId: string) =>
  !!read<Manifest>(db, operationId);
const noteVersion = (db: DatabaseSync, id: string) =>
  Number(
    (db.prepare('SELECT version FROM notes WHERE id=?').get(id) as { version?: number } | undefined)
      ?.version ?? -1,
  );
// An unrelated person's alias can make an originally unique printed identity ambiguous.
// Keep the review's relevant owner set, rather than only the assigned person's version.
function identityAuthoritySnapshot(db: DatabaseSync) {
  const self = getNote(db, 'person-note:self');
  return {
    self,
    selfNames: [
      self.person?.fullName || '',
      ...effectiveKnownNames(db, self.id, self.person || {}),
    ],
    people: identityPeopleSnapshots(db),
    // The journal can change authority without advancing a Person note version.
    authority: db
      .prepare(
        "SELECT title,coverage_json FROM manual_batches WHERE title IN ('Remembered name correction','Future name owner') ORDER BY id",
      )
      .all(),
  };
}
const identityStamp = (snapshot: ReturnType<typeof identityAuthoritySnapshot>, name: string) => {
  const relevant = (candidate: string) =>
    canonicalIdentityName(candidate) === canonicalIdentityName(name) ||
    possiblySameIdentityName(name, candidate);
  const people = snapshot.people.filter((person) =>
    [person.fullName, ...person.knownNames].some(relevant),
  );
  // Name correction and future-owner decisions can alter matching authority
  // without changing the assigned Person note's version.
  const authority = snapshot.authority.filter((row) => {
    try {
      const value = JSON.parse(String(row.coverage_json)) as { name?: string };
      return !!value.name && relevant(value.name);
    } catch {
      return false;
    }
  });
  return digest({
    self: snapshot.selfNames.some(relevant)
      ? { version: snapshot.self.version, person: snapshot.self.person }
      : null,
    people,
    authority,
  });
};

function initializePartialSelection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
  fingerprint: string,
  preparedSources?: Map<string, ReviewSource | Error>,
): {
  manifest: Manifest;
  replayed: boolean;
  reviews: Map<string, IntakeReview | null>;
  noteVersions: Map<string, number>;
  identityStamps: Map<string, string>;
} {
  if (activeFor(db).has(request.operationId))
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_IN_PROGRESS',
      'This exact save is still processing. Check its receipt again.',
    );
  let manifest = read<Manifest>(db, request.operationId);
  const reviews = new Map<string, IntakeReview | null>();
  const noteVersions = new Map<string, number>();
  const identityStamps = new Map<string, string>();
  const replayed = !!manifest;
  if (manifest && manifest.fingerprint !== fingerprint)
    throw new HttpError(
      409,
      'OPERATION_CONFLICT',
      'This operation already belongs to different exact selections.',
    );
  if (!manifest) {
    let initialIdentityAuthority: ReturnType<typeof identityAuthoritySnapshot> | null = null;
    const entries: Entry[] = request.blocks.flatMap(({ selections, ...block }) =>
      selections.map((selection) => ({
        block,
        selection,
        childId: childId(request.operationId, [block.intakeId, block.proposalId, selection]),
      })),
    );
    // Same destination or same incoming assertion is one coupled commit group.
    // Unknown/stale inputs stay conservative and are rejected within their own boundary.
    const reportNames = new Map<string, string>();
    const reviewRecords = new Map<string, Map<string, IntakeReview['records'][number]>>();
    const sessions = new Map<string, ReviewSource | Error>(preparedSources);
    const dependencies = entries.map((entry) => {
      const keys = new Set<string>();
      for (const comparison of entry.selection.comparisons || [])
        keys.add('destination:' + comparison.otherRecordId);
      try {
        const pair = canonicalLiteral([entry.block.intakeId, entry.block.proposalId]);
        let session = sessions.get(entry.block.intakeId);
        if (!session) {
          try {
            session = createIntakeReviewSession(db, root, profileId, entry.block.intakeId);
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            session = error;
          }
          sessions.set(entry.block.intakeId, session);
        }
        if (session instanceof Error) throw session;
        if (!reportNames.has(entry.block.intakeId))
          reportNames.set(entry.block.intakeId, session.filename.slice(0, 160));
        entry.reportName = reportNames.get(entry.block.intakeId);
        if (!reviews.has(pair)) {
          reviews.set(pair, session.review(entry.block.proposalId));
          reviewRecords.set(
            pair,
            new Map(reviews.get(pair)?.records.map((item) => [item.id, item])),
          );
        }
        const record = reviewRecords.get(pair)?.get(entry.selection.recordId);
        entry.label = record?.title?.slice(0, 160);
        entry.kind = record?.kind;
        entry.personId = record?.identityReview?.blocking
          ? undefined
          : record?.identityReview?.assignedPerson?.personId ||
            record?.mapping.personId ||
            (record?.mapping.subject === 'self' ? 'patient' : undefined);
        entry.personNoteId = record?.identityReview?.assignedPerson?.noteId || 'person-note:self';
        entry.identityName = record?.identityReview?.evidencedIdentity.fullName?.trim();
        if (entry.identityName && !identityStamps.has(entry.identityName)) {
          initialIdentityAuthority ||= identityAuthoritySnapshot(db);
          identityStamps.set(
            entry.identityName,
            identityStamp(initialIdentityAuthority, entry.identityName),
          );
        }
        if (!noteVersions.has(entry.personNoteId))
          noteVersions.set(entry.personNoteId, noteVersion(db, entry.personNoteId));
        if (record?.comparisonReference)
          keys.add('assertion:' + record.kind + ':' + record.comparisonReference.identity);
        if (record?.duplicateOf) keys.add('destination:' + record.duplicateOf.id);
        keys.add('destination:' + entry.selection.recordId);
      } catch (error) {
        if (!(error instanceof HttpError) || [401, 403].includes(error.status)) throw error;
        reviews.set(canonicalLiteral([entry.block.intakeId, entry.block.proposalId]), null);
      }
      return keys;
    });
    const parent = entries.map((_, index) => index);
    const find = (index: number): number => {
      let root = index;
      while (parent[root] !== root) root = parent[root]!;
      while (parent[index] !== index) {
        const next = parent[index]!;
        parent[index] = root;
        index = next;
      }
      return root;
    };
    const seenKeys = new Map<string, number>();
    for (const [index, keys] of dependencies.entries())
      for (const key of keys) {
        const prior = seenKeys.get(key);
        if (prior !== undefined) {
          const a = find(index),
            b = find(prior);
          parent[Math.max(a, b)] = Math.min(a, b);
        }
        seenKeys.set(key, index);
      }
    const byRoot = new Map<number, number[]>();
    for (let index = 0; index < entries.length; index++) {
      const root = find(index);
      const group = byRoot.get(root) || [];
      group.push(index);
      byRoot.set(root, group);
    }
    const groups = [...byRoot.values()];
    manifest = { fingerprint, operationId: request.operationId, at: now(), entries, groups };
    const retained = manifest;
    intakeTransaction(
      db,
      () => {
        write(db, request.operationId, retained);
        return { operationId: request.operationId };
      },
      { operationId: request.operationId, fingerprint },
    );
  }
  return { manifest, replayed, reviews, noteVersions, identityStamps };
}
export function acceptPartialSelection(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
  fingerprint: string,
): IntakeReportAcceptanceResult {
  const { manifest, replayed, reviews, noteVersions, identityStamps } = initializePartialSelection(
    db,
    root,
    profileId,
    request,
    fingerprint,
  );
  return replayed
    ? reconcileManifest(db, root, profileId, manifest)
    : processManifest(db, root, profileId, manifest, false, reviews, noteVersions, identityStamps);
}
export async function acceptPartialSelectionAsync(
  db: DatabaseSync,
  root: string,
  profileId: string,
  request: IntakeReportAcceptanceRequest,
  fingerprint: string,
): Promise<IntakeReportAcceptanceResult> {
  let preparedSources: Awaited<ReturnType<typeof prepareNativePartialReviews>> | undefined;
  try {
    if (hasNativeAcceptanceBlock(db, request)) {
      const preparing = activeFor(db);
      if (preparing.has(request.operationId))
        throw new HttpError(
          409,
          'REPORT_ACCEPTANCE_IN_PROGRESS',
          'This exact save is still processing. Check its receipt again.',
        );
      preparing.add(request.operationId);
      try {
        const { prepareIntakeLookupIndices } = await import('./intake-lookup-projection.ts');
        const { retainedReportAcceptance } = await import('./intake-state-access.ts');
        await prepareIntakeLookupIndices(db);
        if (retainedReportAcceptance(db, request.operationId))
          throw new HttpError(
            409,
            'OPERATION_CONFLICT',
            'Operation ID already belongs to a different acceptance mode.',
          );
        if (!read<Manifest>(db, request.operationId))
          preparedSources = await prepareNativePartialReviews(db, root, profileId, request);
      } finally {
        preparing.delete(request.operationId);
      }
    }
    const { manifest, replayed, reviews, noteVersions, identityStamps } =
      initializePartialSelection(
        db,
        root,
        profileId,
        request,
        fingerprint,
        preparedSources?.sources,
      );
    if (replayed) return reconcileManifest(db, root, profileId, manifest);
    const operations = activeFor(db);
    operations.add(request.operationId);
    try {
      const steps = processManifestSteps(
        db,
        root,
        profileId,
        manifest,
        false,
        reviews,
        noteVersions,
        identityStamps,
      );
      let step = steps.next();
      while (!step.done) {
        try {
          if (step.value) {
            if (hasNativeAcceptanceBlock(db, step.value.request))
              await applyNativeAcceptanceGroup(
                db,
                root,
                profileId,
                step.value.request,
                step.value.fingerprint,
                { retainResult: step.value.retainResult, reviewed: step.value.reviews },
              );
            else
              applyAcceptanceGroup(
                db,
                root,
                profileId,
                step.value.request,
                step.value.fingerprint,
                step.value.retainResult,
                step.value.reviews,
              );
          } else {
            await new Promise<void>((resolve) => setImmediate(resolve));
            acceptanceOwner(db, profileId);
          }
          step = steps.next();
        } catch (error) {
          step = steps.throw(error);
        }
      }
      return step.value;
    } finally {
      operations.delete(request.operationId);
    }
  } finally {
    preparedSources?.close();
  }
}
export function getPartialAcceptance(
  db: DatabaseSync,
  root: string,
  profileId: string,
  operationId: string,
): IntakeReportAcceptanceResult | null {
  if (activeFor(db).has(operationId))
    throw new HttpError(
      409,
      'REPORT_ACCEPTANCE_IN_PROGRESS',
      'This exact save is still processing. Check its receipt again.',
    );
  const manifest = read<Manifest>(db, operationId);
  return manifest ? reconcileManifest(db, root, profileId, manifest) : null;
}
function processManifest(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
  replayed: boolean,
  reviews: Map<string, IntakeReview | null>,
  noteVersions: Map<string, number>,
  identityStamps: Map<string, string>,
): IntakeReportAcceptanceResult {
  const steps = processManifestSteps(
    db,
    root,
    profileId,
    manifest,
    replayed,
    reviews,
    noteVersions,
    identityStamps,
  );
  let step = steps.next();
  while (!step.done) {
    try {
      if (step.value)
        applyAcceptanceGroup(
          db,
          root,
          profileId,
          step.value.request,
          step.value.fingerprint,
          step.value.retainResult,
          step.value.reviews,
        );
      step = steps.next();
    } catch (error) {
      step = steps.throw(error);
    }
  }
  return step.value;
}
function* processManifestSteps(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
  replayed: boolean,
  reviews: Map<string, IntakeReview | null>,
  noteVersions: Map<string, number>,
  identityStamps: Map<string, string>,
): Generator<AcceptanceStep | void, IntakeReportAcceptanceResult> {
  const expectedVersions = new Map<string, number>();
  for (const entry of manifest.entries) {
    const review = reviews.get(canonicalLiteral([entry.block.intakeId, entry.block.proposalId]));
    if (review && !expectedVersions.has(entry.block.intakeId))
      expectedVersions.set(entry.block.intakeId, review.version);
  }
  const units: number[][][] = [];
  for (const group of manifest.groups) {
    const last = units.at(-1);
    const pair = (index: number) => {
      const entry = manifest.entries[index]!;
      return canonicalLiteral([entry.block.intakeId, entry.block.proposalId]);
    };
    // Independent selections from one proposal share one bounded transaction.
    // A coupled group always retains its own atomic boundary.
    if (
      group.length === 1 &&
      manifest.groups.length >= 20 &&
      last &&
      last.length < 200 &&
      last.every((prior) => prior.length === 1) &&
      pair(last[0]![0]!) === pair(group[0]!)
    )
      last.push(group);
    else units.push([group]);
  }
  function* run(groups: number[][]): Generator<AcceptanceStep, boolean> {
    const group = groups.flat();
    acceptanceOwner(db, profileId);
    if (group.every((index) => read(db, itemKey(manifest, index)))) return true;
    const blocks = new Map<string, IntakeReportAcceptanceBlock>();
    for (const index of group) {
      const entry = manifest.entries[index]!;
      const key = canonicalLiteral([entry.block.intakeId, entry.block.proposalId]);
      if (!blocks.has(key)) blocks.set(key, { ...entry.block, selections: [] });
      blocks.get(key)!.selections.push(entry.selection);
    }
    const operationId = childId(
      manifest.operationId,
      group.map((index) => manifest.entries[index]!.childId),
    );
    const fingerprint = digest(group.map((index) => manifest.entries[index]));
    try {
      const currentVersions = new Map<string, number>();
      const currentNotes = new Map<string, number>();
      const currentIdentities = new Map<string, string>();
      const currentIdentityAuthority = group.some((index) => manifest.entries[index]?.identityName)
        ? identityAuthoritySnapshot(db)
        : null;
      for (const index of group) {
        const entry = manifest.entries[index]!;
        const expected = expectedVersions.get(entry.block.intakeId);
        if (!currentVersions.has(entry.block.intakeId))
          currentVersions.set(
            entry.block.intakeId,
            intakeSourceVersion(db, entry.block.intakeId).version,
          );
        if (expected !== undefined && currentVersions.get(entry.block.intakeId) !== expected)
          throw new HttpError(
            409,
            'REPORT_CHANGED_DURING_SAVE',
            'This report changed while the save was processing. Review this exact record again.',
          );
        if (entry.personNoteId && !currentNotes.has(entry.personNoteId))
          currentNotes.set(entry.personNoteId, noteVersion(db, entry.personNoteId));
        if (
          entry.personNoteId &&
          noteVersions.has(entry.personNoteId) &&
          currentNotes.get(entry.personNoteId) !== noteVersions.get(entry.personNoteId)
        )
          throw new HttpError(
            409,
            'PERSON_REVIEW_CHANGED',
            'This person changed while the save was processing. Review this exact record again.',
          );
        if (entry.identityName && identityStamps.has(entry.identityName)) {
          if (!currentIdentities.has(entry.identityName))
            currentIdentities.set(
              entry.identityName,
              identityStamp(currentIdentityAuthority!, entry.identityName),
            );
          if (currentIdentities.get(entry.identityName) !== identityStamps.get(entry.identityName))
            throw new HttpError(
              409,
              'IDENTITY_REVIEW_CHANGED',
              'A possible owner changed while the save was processing. Review this exact record again.',
            );
        }
      }
      yield {
        request: { operationId, blocks: [...blocks.values()] },
        fingerprint,
        retainResult: (receipt) => {
          const receiptBlocks = new Map(
            receipt.receipts.map((block) => [
              canonicalLiteral([block.intakeId, block.proposalId]),
              block,
            ]),
          );
          const records = new Map(
            receipt.receipts.flatMap((block) =>
              block.records.map(
                (record) =>
                  [
                    canonicalLiteral([block.intakeId, block.proposalId, record.recordId]),
                    record,
                  ] as const,
              ),
            ),
          );
          for (const index of group) {
            const entry = manifest.entries[index]!;
            const block = receiptBlocks.get(
              canonicalLiteral([entry.block.intakeId, entry.block.proposalId]),
            )!;
            const exact = {
              ...block,
              records: [
                records.get(
                  canonicalLiteral([
                    entry.block.intakeId,
                    entry.block.proposalId,
                    entry.selection.recordId,
                  ]),
                )!,
              ],
            };
            write(db, itemKey(manifest, index), {
              ...identity(entry),
              status: 'saved',
              receipt: exact,
            } satisfies IntakePartialAcceptanceItem);
          }
        },
        reviews,
      };
      for (const block of blocks.values())
        expectedVersions.set(block.intakeId, intakeSourceVersion(db, block.intakeId).version);
      return true;
    } catch (error) {
      // A published head with a lost acknowledgement is unknown, never a failure.
      // See docs/import/review-reliability.md. Reopening replays its original IDs.
      acceptanceOwner(db, profileId);
      if (error instanceof HttpError && [401, 403].includes(error.status)) throw error;
      const reviewFailure =
        error instanceof HttpError && [400, 404, 409, 413, 422].includes(error.status);
      if (reviewFailure && groups.length > 1 && error.code !== 'REPORT_CHANGED_DURING_SAVE') {
        const middle = Math.floor(groups.length / 2);
        return (yield* run(groups.slice(0, middle))) && (yield* run(groups.slice(middle)));
      }
      const affected = reviewFailure
        ? group
        : manifest.entries.map((_, i) => i).filter((i) => !read(db, itemKey(manifest, i)));
      intakeTransaction(
        db,
        () => {
          for (const index of affected) {
            const inGroup = group.includes(index);
            write(db, itemKey(manifest, index), {
              ...identity(manifest.entries[index]!),
              status: reviewFailure ? 'needs_review' : inGroup ? 'failed' : 'not_attempted',
              reasonCode: reviewFailure
                ? error.code
                : inGroup
                  ? 'SAVE_FAILED'
                  : 'SHARED_SAVE_STOPPED',
              message: reviewFailure
                ? `${group.length > 1 ? 'Coupled selections need review. ' : ''}${error.message}`
                : inGroup
                  ? 'No clinical publication occurred. Review and approve a new save.'
                  : 'Processing stopped after a shared failure. Review and approve a new save.',
            } satisfies IntakePartialAcceptanceItem);
          }
          return { operationId, status: reviewFailure ? 'needs_review' : 'stopped' };
        },
        { operationId: childId(operationId, 'rejection'), fingerprint },
      );
      return reviewFailure;
    }
  }
  for (const unit of units) {
    if (!(yield* run(unit))) break;
    yield;
  }
  return manifestResult(db, root, profileId, manifest, replayed);
}
function manifestResult(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
  replayed: boolean,
): IntakeReportAcceptanceResult {
  const items = manifest.entries.map((_, index) =>
    read<IntakePartialAcceptanceItem>(db, itemKey(manifest, index))!,
  );
  const receipt: IntakePartialAcceptanceReceipt = {
    version: 1,
    operationId: manifest.operationId,
    status: 'completed',
    atomic: false,
    at: manifest.at,
    selectedCount: items.length,
    acceptedCount: items.filter((item) => item.status === 'saved').length,
    receipts: items.flatMap((item) => (item.receipt ? [item.receipt] : [])),
    items,
  };
  return { receipt, replayed, durability: flushIntake(db, root, profileId) };
}

function reconcileManifest(
  db: DatabaseSync,
  root: string,
  profileId: string,
  manifest: Manifest,
): IntakeReportAcceptanceResult {
  acceptanceOwner(db, profileId);
  const missing = manifest.entries
    .map((_, index) => index)
    .filter((index) => !read(db, itemKey(manifest, index)));
  if (missing.length)
    intakeTransaction(
      db,
      () => {
        for (const index of missing)
          write(db, itemKey(manifest, index), {
            ...identity(manifest.entries[index]!),
            status: 'not_attempted',
            reasonCode: 'SAVE_INTERRUPTED',
            message:
              'Processing was interrupted. Previously committed results are retained; review and explicitly approve a new save for this item.',
          } satisfies IntakePartialAcceptanceItem);
        return { operationId: manifest.operationId, status: 'interrupted' };
      },
      {
        operationId: childId(manifest.operationId, 'interrupted'),
        fingerprint: manifest.fingerprint,
      },
    );
  return manifestResult(db, root, profileId, manifest, true);
}
