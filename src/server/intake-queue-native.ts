import { currentClinicalOperation, runExclusiveClinicalOperation } from './clinical-operation.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
/** Explicit preparation of the complete visible queue, followed by bounded read contracts. */
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, clinicalReviewRevision } from './database.ts';
import { assertIntakeOwner, withVerifiedIntakeOriginalDescriptor } from './intake.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { visibilityCondition, visibilitySQL } from './visibility.ts';
import { prepareIntakeSourceDependencyHeaders } from './intake-source-text-dependencies.ts';
import { prepareRetainedPlanAccess } from './intake-retained-plan.ts';
import { prepareCollectionWorkflowReadiness } from './intake-workflow-readiness.ts';
import {
  prepareCollectionPeopleIndex,
  readCollectionPeoplePage,
} from './intake-people-collection.ts';
import { prepareCollectionClinicalReviewDependencies } from './intake-review-collection-host.ts';
import {
  collectionReportQueueMembers,
  readCollectionIntakeReportRecords,
} from './intake-report-queue-collection.ts';
import { intakeSourceVersion, intakeSourceMetadata } from './intake-state-access.ts';
import { activeMappingRules } from './clinical-import.ts';
import { workflowHash } from './intake-workflow.ts';
import { prepareJournalActivity } from './journal-activity-index.ts';
import {
  listIntakeReportQueue,
  getIntakeReportQueueGroup,
  listIntakeImportFeed,
} from './intake-report-queue.ts';
import { getIntakePeopleQueue } from './intake-people.ts';
import {
  readCollectionReportQueuePage,
  readCollectionReportGroupDetail,
  readCollectionReportGroupFragment,
  readCollectionReportSourceCoverage,
} from './intake-queue-page-collection.ts';
import { readCollectionImportFeed } from './intake-import-feed-collection.ts';
import { canonicalLiteral } from './intake-format.ts';
import { intakeClinicalCachePin } from './intake-clinical-cache-pin.ts';
import {
  prepareCollectionQueueTransitions,
  collectionQueueTransitionEffects,
} from './intake-queue-transitions.ts';
import { openIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import {
  openCollectionReportQueue,
  clearCollectionQueueReviews,
} from './intake-report-group-collection.ts';
type PreparedQueue = {
  binding: string;
  revision: string;
  scratch: ReturnType<typeof disposableSqlite>;
};
const preparedQueues = new WeakMap<DatabaseSync, Map<string, PreparedQueue>>();
const preparingQueues = new WeakMap<DatabaseSync, Map<string, Promise<void>>>();
const activeScratch = new WeakMap<DatabaseSync, Set<PreparedQueue['scratch']>>();
const queueGenerations = new WeakMap<DatabaseSync, number>();
export function clearPreparedCollectionQueues(db: DatabaseSync) {
  queueGenerations.set(db, (queueGenerations.get(db) ?? 0) + 1);
  const active = activeScratch.get(db);
  for (const value of preparedQueues.get(db)?.values() || [])
    if (!active?.has(value.scratch)) value.scratch.close();
  preparedQueues.delete(db);
}

export function hasNativeIntakeQueue(db: DatabaseSync, profileId: string): boolean {
  assertIntakeOwner(db, profileId);
  prepareCollectionQueueTransitions(db);
  for (const row of db
    .prepare("SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original'")
    .iterate())
    if (hasIntakeCollectionEnvelope(db, { id: String(row.id) })) return true;
  return false;
}
type QueueInput = Parameters<typeof listIntakeReportQueue>[3] & {
  bytes?: unknown;
  intakeId?: string | null;
  peopleCursor?: string | null;
  personId?: string | null;
};
function nativeWindow(input: QueueInput) {
  if (input.cursor != null && typeof input.cursor !== 'string')
    throw new HttpError(400, 'REPORT_QUEUE_WINDOW', 'Choose a valid queue cursor');
  return {
    view: input.view as NonNullable<Parameters<typeof readCollectionReportQueuePage>[3]>['view'],
    limit: input.limit == null ? undefined : Number(input.limit),
    bytes: input.bytes == null ? undefined : Number(input.bytes),
    cursor: input.cursor ?? undefined,
    intakeId: input.intakeId ?? undefined,
    peopleCursor: input.peopleCursor ?? undefined,
    personId: input.personId ?? undefined,
  };
}

/** This is cold/recovery work over complete source pointers, not a claim that a
 * queue page describes every retained proposal or authorizes a clinical write. */
export async function prepareCollectionQueueRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  options: { assertRunning?: () => void } = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      let active = preparingQueues.get(db);
      if (!active) {
        active = new Map();
        preparingQueues.set(db, active);
      }
      const key = JSON.stringify([root, profileId]),
        prior = active.get(key);
      const operation = (async () => {
        // Each caller rechecks its own authority and cancellation after any earlier preparation.
        if (prior) await prior.catch(() => undefined);
        await prepareCollectionQueueReadNow(db, root, profileId, options);
      })();
      active.set(key, operation);
      try {
        await operation;
      } catch (error) {
        clearCollectionQueueReviews(db);
        throw error;
      } finally {
        if (active.get(key) === operation) active.delete(key);
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
async function prepareCollectionQueueReadNow(
  db: DatabaseSync,
  root: string,
  profileId: string,
  options: { assertRunning?: () => void },
) {
  assertIntakeOwner(db, profileId);
  prepareCollectionQueueTransitions(db);
  const revision = clinicalReviewRevision(db),
    policyPin = intakeClinicalCachePin(db),
    visible = visibilityCondition(
      new URLSearchParams({ visibility: 'visible' }),
      visibilitySQL("'source_file'", 'f.id'),
    ),
    cacheKey = JSON.stringify([root, profileId]);
  const bindingNow = () => {
    const hash = createHash('sha256').update(
      JSON.stringify([profileId, clinicalReviewRevision(db), intakeClinicalCachePin(db)]),
    );
    for (const row of db
      .prepare(
        "SELECT f.id,f.sha256 FROM source_files f WHERE f.kind='intake_original' AND " +
          visible +
          ' ORDER BY f.id',
      )
      .iterate())
      hash.update(JSON.stringify([row.id, row.sha256, intakeSourceVersion(db, String(row.id))]));
    return hash.digest('hex');
  };
  const binding = bindingNow();
  const previous = preparedQueues.get(db)?.get(cacheKey);
  if (previous?.binding === binding) {
    options.assertRunning?.();
    await prepareJournalActivity(root, profileId);
    assertIntakeOwner(db, profileId);
    if (bindingNow() !== binding)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
    return;
  }
  const scratch = previous?.scratch || disposableSqlite('circus-queue-preparation-');
  const generation = queueGenerations.get(db) ?? 0;
  let active = activeScratch.get(db);
  if (!active) {
    active = new Set();
    activeScratch.set(db, active);
  }
  active.add(scratch);
  let retained = !!previous;
  const assertCurrent = () => {
    if ((queueGenerations.get(db) ?? 0) !== generation)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
    options.assertRunning?.();
    assertIntakeOwner(db, profileId);
    if (clinicalReviewRevision(db) !== revision)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
  };
  if (!previous)
    scratch.db.exec(
      'CREATE TABLE sources(id TEXT PRIMARY KEY,logical TEXT,seen INTEGER);CREATE TABLE proposals(intake TEXT,id TEXT,PRIMARY KEY(intake,id));',
    );
  scratch.db.exec('BEGIN;UPDATE sources SET seen=0;DELETE FROM proposals;');
  try {
    for (const row of db
      .prepare(
        "SELECT f.id FROM source_files f WHERE f.kind='intake_original' AND " +
          visible +
          ' ORDER BY f.id',
      )
      .iterate())
      scratch.db
        .prepare('INSERT INTO sources(id,seen) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET seen=1')
        .run(String(row.id));
    scratch.db.exec('DELETE FROM sources WHERE seen=0');
    for (const row of scratch.db.prepare('SELECT id,logical FROM sources ORDER BY id').iterate()) {
      assertCurrent();
      const id = String(row.id);
      if (
        previous?.revision === policyPin &&
        row.logical === canonicalLiteral(intakeSourceVersion(db, id))
      )
        continue;
      await prepareIntakeSourceDependencyHeaders(db, id, { assertRunning: assertCurrent });
      withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueuePreparedSources'));
      await prepareRetainedPlanAccess(db, profileId, id, { assertRunning: assertCurrent });
      const mappingVersion = () =>
          workflowHash(
            activeMappingRules(
              db,
              intakeSourceMetadata(db, id).metadata?.sourceProviderId ||
                String(
                  db.prepare('SELECT provider_id FROM source_files WHERE id=?').get(id)
                    ?.provider_id || '',
                ),
            ),
          ),
        mapping = mappingVersion();
      const ready = await prepareCollectionWorkflowReadiness(db, root, profileId, id, {
        mappingVersion: mapping,
        currentMappingVersion: mappingVersion,
        assertRunning: assertCurrent,
      });
      if (ready.state !== 'ready')
        throw new HttpError(
          409,
          'WORKFLOW_PREPARATION_REQUIRED',
          'Prepare the complete retained report queue',
        );
      await prepareCollectionPeopleIndex(db, root, profileId, id, { assertRunning: assertCurrent });
      const old = row.logical
          ? (JSON.parse(String(row.logical)) as ReturnType<typeof intakeSourceVersion>)
          : undefined,
        current = intakeSourceVersion(db, id),
        effects =
          previous?.revision === policyPin &&
          old?.logicalBinding &&
          current.logicalBinding &&
          canonicalLiteral(old.sourcePin) === canonicalLiteral(current.sourcePin)
            ? collectionQueueTransitionEffects(
                db,
                id,
                JSON.parse(old.logicalBinding),
                JSON.parse(current.logicalBinding),
              )
            : undefined;
      let narrow = !!effects;
      if (effects)
        for (const effect of effects) {
          if (effect.kind === 'group') continue;
          if (effect.kind === 'proposal') {
            scratch.db
              .prepare('INSERT OR IGNORE INTO proposals VALUES(?,?)')
              .run(id, JSON.stringify(effect.key));
            continue;
          }
          if (effect.kind !== 'candidate') {
            narrow = false;
            continue;
          }
          const view = openIntakeCollectionEnvelope(db, { id }),
            intake = view.child(view.root(), 'intake')!,
            flow = view.child(intake, 'workflow')!,
            candidate = view.find('candidate', flow, effect.key, { match: 'last' });
          if (!candidate) {
            narrow = false;
            continue;
          }
          const change = JSON.parse(effect.value) as { candidateVersionId?: string },
            version = change.candidateVersionId
              ? view.find('version', candidate, change.candidateVersionId)
              : view.childAt(candidate, 'versions', view.childCount(candidate, 'versions') - 1);
          if (!version) {
            narrow = false;
            continue;
          }
          const read = (record: NonNullable<typeof version>, field: string) => {
            const value = view.field(record, field, { bytes: 16384 });
            if (value.kind === 'fragmented')
              throw new HttpError(
                409,
                'REPORT_REFERENCE_UNAVAILABLE',
                'Prepare the selected queue reference',
              );
            return value.kind === 'value' ? value.value : undefined;
          };
          const draft = view.childCount(flow, 'reviewDrafts')
            ? view.lookup('draft-candidate-version-last', [
                JSON.stringify(effect.key),
                String(read(version, 'id')),
              ])
            : undefined;
          const occurrence =
            draft ||
            view.childAt(version, 'occurrences', view.childCount(version, 'occurrences') - 1);
          if (occurrence)
            scratch.db
              .prepare('INSERT OR IGNORE INTO proposals VALUES(?,?)')
              .run(id, JSON.stringify(read(occurrence, 'proposalId') ?? null));
        }
      let count = 0;
      if (!narrow)
        await withVerifiedIntakeOriginalDescriptor(
          { db, root, profileId, id, assertRunning: assertCurrent },
          async ({ assertRunning }) => {
            for await (const member of collectionReportQueueMembers(
              db,
              profileId,
              id,
              undefined,
              assertRunning,
            )) {
              scratch.db
                .prepare('INSERT OR IGNORE INTO proposals VALUES(?,?)')
                .run(id, JSON.stringify(member.proposalId));
              if (++count % 64 === 0) {
                await setImmediate();
                assertRunning();
              }
            }
          },
        );
      scratch.db
        .prepare('UPDATE sources SET logical=? WHERE id=?')
        .run(canonicalLiteral(intakeSourceVersion(db, id)), id);
    }
    for (const row of scratch.db
      .prepare('SELECT intake,id FROM proposals ORDER BY intake,id')
      .iterate())
      await prepareCollectionClinicalReviewDependencies(
        db,
        root,
        profileId,
        String(row.intake),
        JSON.parse(String(row.id)),
        { assertRunning: assertCurrent },
      );
    await prepareJournalActivity(root, profileId);
    for (const row of scratch.db.prepare('SELECT id,logical FROM sources').iterate())
      if (canonicalLiteral(intakeSourceVersion(db, String(row.id))) !== row.logical)
        throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
    assertCurrent();
    let cache = preparedQueues.get(db);
    if (!cache) {
      cache = new Map();
      preparedQueues.set(db, cache);
    }
    if (cache.size >= 8 && !cache.has(cacheKey)) {
      const oldest = cache.keys().next().value!;
      cache.get(oldest)!.scratch.close();
      cache.delete(oldest);
    }
    scratch.db.exec('COMMIT');
    cache.set(cacheKey, { binding: bindingNow(), revision: policyPin, scratch });
    retained = true;
  } catch (error) {
    scratch.db.exec('ROLLBACK');
    throw error;
  } finally {
    active.delete(scratch);
    if (!active.size) activeScratch.delete(db);
    if (!retained || (queueGenerations.get(db) ?? 0) !== generation) scratch.close();
  }
}
export async function listIntakeReportQueueRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: QueueInput = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      if (!hasNativeIntakeQueue(db, profileId))
        return listIntakeReportQueue(db, root, profileId, input);
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionReportQueuePage(db, root, profileId, nativeWindow(input));
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function getIntakeReportQueueGroupRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: QueueInput = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      if (!hasNativeIntakeQueue(db, profileId))
        return getIntakeReportQueueGroup(db, root, profileId, groupId, input);
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionReportGroupDetail(db, root, profileId, groupId, nativeWindow(input));
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function listIntakeImportFeedRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: Parameters<typeof listIntakeImportFeed>[3] & { bytes?: unknown } = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      if (!hasNativeIntakeQueue(db, profileId))
        return listIntakeImportFeed(db, root, profileId, input);
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionImportFeed(db, root, profileId, {
        ...nativeWindow(input),
        q: input.q ?? undefined,
        state: input.state as NonNullable<Parameters<typeof readCollectionImportFeed>[3]>['state'],
        kind: input.kind as NonNullable<Parameters<typeof readCollectionImportFeed>[3]>['kind'],
        edited: input.edited ?? undefined,
        peopleCursor: input.peopleCursor ?? undefined,
        groupId: input.groupId ?? undefined,
        intakeId: input.intakeId ?? undefined,
        recordId: input.recordId ?? undefined,
      });
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function getIntakePeopleQueueRead(
  db: DatabaseSync,
  root: string,
  profileId: string,
  groupId: string,
  input: Parameters<typeof getIntakePeopleQueue>[4] & {
    intakeId?: string | null;
    bytes?: unknown;
    personId?: string | null;
    view?: string | null;
    q?: string | null;
  } = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      if (input.view && !['active', 'deferred', 'all'].includes(input.view))
        throw new HttpError(400, 'INTAKE_PERSON_WINDOW', 'Choose active, deferred or all People');
      if (!hasNativeIntakeQueue(db, profileId))
        return getIntakePeopleQueue(db, root, profileId, groupId, input);
      await prepareCollectionQueueRead(db, root, profileId);
      const detail = await readCollectionReportGroupDetail(db, root, profileId, groupId, {
        intakeId: input.intakeId ?? undefined,
        personId: input.personId ?? undefined,
        view: (input.view || 'all') as import('../shared/intake.ts').IntakeReportQueueView,
        limit: input.limit == null ? undefined : Number(input.limit),
        bytes: input.bytes == null ? undefined : Number(input.bytes),
        peopleCursor: input.cursor == null ? undefined : String(input.cursor),
        peopleQuery: input.q ?? undefined,
      });
      return detail.people;
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function readIntakeReportGroupFragment(
  db: DatabaseSync,
  root: string,
  profileId: string,
  reference: Parameters<typeof readCollectionReportGroupFragment>[3],
  offset?: number,
  bytes?: number,
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionReportGroupFragment(db, root, profileId, reference, offset, bytes);
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function readIntakeReportSourceCoverage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: Parameters<typeof readCollectionReportSourceCoverage>[3],
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      await prepareCollectionQueueRead(db, root, profileId);
      return readCollectionReportSourceCoverage(db, root, profileId, input);
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function readIntakePeoplePage(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: Parameters<typeof readCollectionPeoplePage>[4] = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      assertIntakeOwner(db, profileId);
      await prepareIntakeSourceDependencyHeaders(db, id);
      await prepareCollectionPeopleIndex(db, root, profileId, id);
      return readCollectionPeoplePage(db, root, profileId, id, input);
    },
    { operation: currentClinicalOperation(db) },
  );
}
export async function readIntakeReportRecords(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: Parameters<typeof readCollectionIntakeReportRecords>[4] = {},
) {
  return runExclusiveClinicalOperation(
    db,
    async () => {
      await prepareCollectionQueueRead(db, root, profileId);
      const queue = await openCollectionReportQueue(db, root, profileId);
      try {
        return await readCollectionIntakeReportRecords(db, root, profileId, id, input, queue);
      } finally {
        queue.close();
      }
    },
    { operation: currentClinicalOperation(db) },
  );
}
