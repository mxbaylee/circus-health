import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
/** Complete native report summaries. Pages never become a clinical decision scope. */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, clinicalReviewRevision, revision, observeDatabaseClose } from './database.ts';
import {
  identityGroundingGeneration,
  identityGroundingSourceStamp,
} from './intake-identity-grounding.ts';
import { assertIntakeOwner, verifyIntakeOriginal } from './intake.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
  intakeEnvelopeRecordOrder,
} from './intake-collection-envelope.ts';
import {
  intakeReviewChildren,
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
  type IntakeReviewFragmentReference,
} from './intake-review-collection.ts';
import {
  collectionReportQueueMembers,
  currentCollectionReportQueueMember,
  type CollectionReportQueueMember,
  type CollectionReportQueueGroupPointer,
} from './intake-report-queue-collection.ts';
import { openCollectionPeopleRead } from './intake-people-collection.ts';
import { prepareCollectionClinicalReview } from './intake-review-collection-host.ts';
import { reviewedIntakeQueueRecord } from './intake-report-queue.ts';
import { clinicalMappingLabel } from './clinical-import.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { canonicalLiteral } from './intake-format.ts';
import { reviewRecordIssues } from './intake-review-issue-state.ts';
import { prepareNativeReportSourceReviewScope } from './intake-report-source-review-scope.ts';
import {
  resolveNativeReportSource,
  selectNativeReportSourceLocator,
} from './intake-report-source-resolution.ts';
import { readRetainedPlanEvidence } from './intake-retained-plan.ts';
import { visibilitySQL, visibilityCondition } from './visibility.ts';
import { prepareIntakeJsonCanonical } from './intake-json-canonical.ts';
import { intakeClinicalCachePin } from './intake-clinical-cache-pin.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { collectionQueueTransitionEffects } from './intake-queue-transitions.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import type {
  IntakeReportQueueCounts,
  IntakeReportQueueView,
  IntakeReportSourceCoverageCounts,
  IntakeReportQueueRecord,
} from '../shared/intake.ts';

type Evidence = unknown | IntakeReviewFragmentReference;
export interface CollectionReportGroupSummary {
  format: 'health-intake-report-group-v2';
  intakeId: string;
  intakeVersion: number;
  groupId: string;
  groupOrdinal: number;
  groupVersionId: string | null;
  basis: string;
  discoveryOrder: number | null;
  title: Evidence;
  source: Evidence;
  sourceScope: 'report' | 'intake' | 'issuer' | null;
  date: string | null;
  original: { filename: Evidence; contentUrl: string; parentSourceFileId: string | null };
  member: { memberId: string; filename: Evidence; locator: Evidence } | null;
  report: Evidence;
  reportContext: Evidence;
  counts: IntakeReportQueueCounts;
  peopleCounts: { pending: number; later: number; excluded: number; saved: number };
  sourceCoverage: { current: CollectionSourceCoverage; saved: CollectionSourceCoverage };
  sourceReview: { intakeId: string; groupId: string; view: 'all'; scopeToken: string } | null;
  records: { intakeId: string; groupId: string };
  people: { intakeId: string; groupId: string };
}
export interface CollectionSourceCoverage extends Omit<
  IntakeReportSourceCoverageCounts,
  'bySource'
> {
  sourceCount: number;
  /** Bounded first page; all labels remain available through the source coverage endpoint. */
  bySource: {
    items: { source: string; count: number }[];
    total: number;
    nextCursor: string | null;
  };
}
const emptyCounts = (): IntakeReportQueueCounts => ({
  pending: 0,
  deferred: 0,
  blocked: 0,
  accepted: 0,
  keptOriginal: 0,
  superseded: 0,
  questions: 0,
});
const changed = () => new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
interface MemberFacts {
  counts: IntakeReportQueueCounts;
  date?: string | null;
  title?: string;
}
function reviewedMemberFacts(
  member: CollectionReportQueueMember,
  record?: IntakeReportQueueRecord,
  title = false,
): MemberFacts {
  const counts = emptyCounts();
  if (member.state === 'kept_original') counts.keptOriginal++;
  else counts[member.state]++;
  const facts: MemberFacts = { counts };
  if (title && record) facts.title = clinicalMappingLabel(record.mapping).trim();
  if (member.state === 'pending' || member.state === 'deferred') {
    if (!record) throw Error('Missing complete selected record for queue facts');
    if (!record.selectable) counts.blocked++;
    counts.questions = reviewRecordIssues(record).filter(
      (issue) => issue.kind !== 'information' && issue.status !== 'resolved',
    ).length;
    const date = record.mapping.documentDate || record.mapping.date;
    facts.date =
      typeof date === 'string' &&
      /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(date) &&
      !reviewRecordIssues(record).some(
        (issue) => issue.kind === 'date' && issue.status !== 'resolved',
      )
        ? date
        : null;
  }
  return facts;
}
function selectedValue<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const child = view.child(record, name);
  if (child) return readIntakeReviewValue<T>(view, child, 16384);
  const raw = view.field(record, name, { bytes: 16384 });
  if (raw.kind === 'fragmented')
    throw new IntakeReviewFragmentRequired({
      format: 'health-intake-review-fragment-v1',
      logical: view.logical,
      address: view.address(record),
      field: name,
    });
  return raw.kind === 'value' ? (raw.value as T) : undefined;
}
function evidence(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord | undefined,
  name: string,
): Evidence {
  if (!record) return null;
  try {
    return selectedValue(view, record, name) ?? null;
  } catch (error) {
    if (error instanceof IntakeReviewFragmentRequired) return error.reference;
    throw error;
  }
}
const scalar = <T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) => selectedValue<T>(view, record, name);
export function* collectionQueueSources(
  db: DatabaseSync,
  profileId: string,
): Generator<IntakeEnvelopeSource> {
  assertIntakeOwner(db, profileId);
  const visible = visibilityCondition(
    new URLSearchParams({ visibility: 'visible' }),
    visibilitySQL("'source_file'", 'f.id'),
  );
  for (const row of db
    .prepare(
      "SELECT f.id,f.sha256,f.kind,f.details_json FROM source_files f WHERE f.kind='intake_original' AND " +
        visible +
        ' ORDER BY f.id',
    )
    .iterate()) {
    const source = row as unknown as IntakeEnvelopeSource;
    if (!hasIntakeCollectionEnvelope(db, source))
      throw new HttpError(
        409,
        'INTAKE_REVIEW_PENDING_MIGRATION',
        'Prepare retained intakes before opening the native report queue',
      );
    yield source;
  }
}
type QueueCache = {
  db: DatabaseSync;
  root: string;
  profileId: string;
  binding: string;
  queue: Awaited<ReturnType<typeof buildCollectionReportQueue>>;
  users: number;
  used: number;
  closed: boolean;
};
export interface CollectionReviewRowCertificate {
  stamp: string;
  requestRevision: number;
  sourcePin: string;
  queueBinding: string;
}
const queueCaches = new Set<QueueCache>(),
  queueEpochs = new WeakMap<DatabaseSync, number>();
const observedQueues = new WeakSet<DatabaseSync>();
let queueClock = 0;
function closeQueueCache(cache: QueueCache) {
  cache.closed = true;
  queueCaches.delete(cache);
  cache.queue.close();
}
export function clearCollectionReportQueues(db: DatabaseSync) {
  queueEpochs.set(db, (queueEpochs.get(db) || 0) + 1);
  for (const cache of queueCaches) if (cache.db === db) closeQueueCache(cache);
}
export function clearCollectionQueueReviews(db: DatabaseSync) {
  for (const cache of queueCaches) if (cache.db === db) cache.queue.resetReview();
}
function reserveQueueSlot() {
  while (queueCaches.size >= 4) {
    let oldest: QueueCache | undefined;
    for (const prior of queueCaches)
      if (!prior.users && (!oldest || prior.used < oldest.used)) oldest = prior;
    if (!oldest)
      throw new HttpError(
        503,
        'REPORT_QUEUE_BUSY',
        'Other report windows are active; retry this window',
      );
    closeQueueCache(oldest);
  }
}
function collectionQueueBinding(db: DatabaseSync, profileId: string) {
  const hash = createHash('sha256').update(
    canonicalLiteral([profileId, clinicalReviewRevision(db), intakeClinicalCachePin(db)]),
  );
  for (const source of collectionQueueSources(db, profileId))
    hash.update(canonicalLiteral([source.id, intakeSourceVersion(db, source.id)]));
  return hash.digest('hex');
}
/** Reuse an exact selected disposable join; no domain change is inferred from cache state. */
export async function openCollectionReportQueue(db: DatabaseSync, root: string, profileId: string) {
  try {
    return await openCollectionReportQueueNow(db, root, profileId);
  } catch (error) {
    clearCollectionQueueReviews(db);
    throw error;
  }
}
async function openCollectionReportQueueNow(db: DatabaseSync, root: string, profileId: string) {
  if (!observedQueues.has(db)) {
    observeDatabaseClose(db, () => {
      observedQueues.delete(db);
      clearCollectionReportQueues(db);
    });
    observedQueues.add(db);
  }
  if (db.isTransaction) clearCollectionQueueReviews(db);
  const binding = collectionQueueBinding(db, profileId),
    epoch = queueEpochs.get(db) || 0;
  let cache = [...queueCaches].find(
    (cache) =>
      cache.db === db &&
      cache.root === root &&
      cache.profileId === profileId &&
      cache.binding === binding &&
      !cache.closed,
  );
  if (!cache) {
    const prior = [...queueCaches].find(
      (value) =>
        value.db === db &&
        value.root === root &&
        value.profileId === profileId &&
        !value.closed &&
        !value.users,
    );
    if (prior) {
      prior.users++;
      try {
        await prior.queue.refresh();
        if ((queueEpochs.get(db) || 0) !== epoch || prior.queue.binding !== binding)
          throw changed();
        prior.binding = binding;
        cache = prior;
      } finally {
        prior.users--;
      }
    }
  }
  if (!cache) {
    for (const prior of queueCaches)
      if (prior.db === db && prior.root === root && prior.profileId === profileId && !prior.users)
        closeQueueCache(prior);
    reserveQueueSlot();
    const queue = await buildCollectionReportQueue(db, root, profileId);
    try {
      if ((queueEpochs.get(db) || 0) !== epoch || queue.binding !== binding) throw changed();
      // Other cold opens may have published while this preparation awaited IO.
      // Recheck the global bound immediately before publishing this queue.
      reserveQueueSlot();
    } catch (error) {
      queue.close();
      throw error;
    }
    cache = { db, root, profileId, binding, queue, users: 0, used: ++queueClock, closed: false };
    queueCaches.add(cache);
  }
  cache.users++;
  cache.used = ++queueClock;
  let released = false;
  const selected = cache;
  const verified = new Set<string>();
  const rememberVerified = (id: string) => {
    if (verified.size >= 32) verified.delete(verified.values().next().value!);
    verified.add(id);
  };
  return {
    ...selected.queue,
    reviewMember(intakeId: string, member: CollectionReportQueueMember) {
      if (released || selected.closed) throw changed();
      try {
        selected.queue.assertCurrent();
        if (!verified.has(intakeId)) {
          verifyIntakeOriginal(db, root, profileId, intakeId);
          rememberVerified(intakeId);
        }
        if (member.proposalId && !verified.has(member.proposalId)) {
          const file = db
            .prepare('SELECT path,sha256,bytes FROM source_files WHERE id=?')
            .get(member.proposalId) as { path: string; sha256: string; bytes: number } | undefined;
          if (!file) throw changed();
          verifyIntakeFileHash(profileOriginal(root, file.path, profileId), file);
          rememberVerified(member.proposalId);
        }
        return selected.queue.reviewMember(intakeId, member);
      } catch (error) {
        selected.queue.resetReview();
        throw error;
      }
    },
    close(options: { retainReview?: boolean } = {}) {
      if (released) return;
      released = true;
      selected.users--;
      selected.queue.releaseReview(options.retainReview === true);
    },
    assertCurrent() {
      if (released || selected.closed) throw changed();
      selected.queue.assertCurrent();
    },
  };
}
/** Complete selected pointers and saved receipt joins held on bounded disposable disk. */
async function buildCollectionReportQueue(db: DatabaseSync, root: string, profileId: string) {
  const scratch = disposableSqlite('circus-report-queue-'),
    cache = scratch.db;
  cache.exec(
    'CREATE TABLE sources(id TEXT PRIMARY KEY,pin TEXT,seen INTEGER,dirty INTEGER);CREATE TABLE groups(intake TEXT,id TEXT,ordering TEXT,address TEXT,basis TEXT,groupOrdinal INTEGER,span INTEGER,PRIMARY KEY(intake,groupOrdinal));CREATE TABLE members(intake TEXT,groupId TEXT,ordinal INTEGER,candidate TEXT,version TEXT,value TEXT,groupOrdinal INTEGER,state TEXT,ordering TEXT);CREATE INDEX memberWindow ON members(intake,ordering);CREATE INDEX memberStateWindow ON members(intake,state,ordering);CREATE INDEX memberGroupWindow ON members(intake,groupId,ordering);CREATE INDEX memberGroupStateWindow ON members(intake,groupId,state,ordering);CREATE INDEX groupMembers ON members(intake,groupOrdinal,ordinal);CREATE INDEX memberIdentity ON members(intake,candidate,version);CREATE TABLE people(intake TEXT,groupId TEXT,state TEXT,count INTEGER,PRIMARY KEY(intake,groupId,state));CREATE TABLE receipts(owner TEXT,intake TEXT,candidate TEXT,version TEXT,reviewedGroup TEXT,source TEXT);CREATE INDEX receiptsByOwner ON receipts(owner);CREATE INDEX receiptsByTarget ON receipts(intake,candidate,version);',
  );
  cache.exec(
    'CREATE TABLE memberTotals(intake TEXT,groupId TEXT,state TEXT,count INTEGER,PRIMARY KEY(intake,groupId,state))',
  );
  const changeMemberCount = (
    intakeId: string,
    member: CollectionReportQueueMember,
    delta: number,
  ) => {
    for (const group of ['', member.groupId])
      cache
        .prepare(
          'INSERT INTO memberTotals VALUES(?,?,?,?) ON CONFLICT(intake,groupId,state) DO UPDATE SET count=count+excluded.count',
        )
        .run(intakeId, group, member.state, delta);
  };
  const memberOrderKey = (member: CollectionReportQueueMember) =>
    member.groupOrder +
    ':' +
    String(member.groupOrdinal).padStart(12, '0') +
    ':' +
    String(member.memberOrder).padStart(12, '0') +
    ':' +
    JSON.stringify([member.candidateId, member.candidateVersionId]);
  const bindingNow = () => collectionQueueBinding(db, profileId);
  let grounding = identityGroundingGeneration(db),
    groundingEpoch = 0;
  cache.exec(
    'CREATE TABLE groundingSources(intake TEXT PRIMARY KEY,stamp TEXT,epoch INTEGER);CREATE TABLE groundingDependencies(intake TEXT,dependency TEXT,stamp TEXT,PRIMARY KEY(intake,dependency)) WITHOUT ROWID',
  );
  const retainGroundingDependency = (intakeId: string, dependency: string) => {
    cache
      .prepare('INSERT OR IGNORE INTO groundingDependencies VALUES(?,?,?)')
      .run(intakeId, dependency, identityGroundingSourceStamp(db, dependency));
  };
  const currentGroundingEpoch = (intakeId: string): string => {
    const current = identityGroundingGeneration(db);
    if (current !== grounding) {
      grounding = current;
      groundingEpoch++;
    }
    retainGroundingDependency(intakeId, intakeId);
    const prior = cache
      .prepare('SELECT stamp,epoch FROM groundingSources WHERE intake=?')
      .get(intakeId);
    if (prior?.epoch === groundingEpoch) return String(prior.stamp);
    let changed = !prior;
    for (const dependency of cache
      .prepare('SELECT dependency,stamp FROM groundingDependencies WHERE intake=?')
      .iterate(intakeId)) {
      const stamp = identityGroundingSourceStamp(db, String(dependency.dependency));
      if (stamp !== dependency.stamp) {
        changed = true;
        cache
          .prepare('UPDATE groundingDependencies SET stamp=? WHERE intake=? AND dependency=?')
          .run(stamp, intakeId, dependency.dependency);
      }
    }
    const stamp = changed ? randomUUID() : String(prior!.stamp);
    cache
      .prepare('INSERT OR REPLACE INTO groundingSources VALUES(?,?,?)')
      .run(intakeId, stamp, groundingEpoch);
    return stamp;
  };
  cache.exec(
    'CREATE TABLE summaries(intake TEXT,ordinal INTEGER,value TEXT,grounding INTEGER,PRIMARY KEY(intake,ordinal))',
  );
  cache.exec(
    'CREATE TABLE changedCandidates(id TEXT,version TEXT,PRIMARY KEY(id,version));CREATE TABLE changedGroups(sequence INTEGER PRIMARY KEY,value TEXT)',
  );
  cache.exec(
    'CREATE TABLE memberFacts(intake TEXT,groupOrdinal INTEGER,candidate TEXT,version TEXT,value TEXT,grounding INTEGER,PRIMARY KEY(intake,groupOrdinal,candidate,version));CREATE TABLE dates(intake TEXT,groupOrdinal INTEGER,date TEXT,count INTEGER,PRIMARY KEY(intake,groupOrdinal,date))',
  );
  const putFacts = (intakeId: string, member: CollectionReportQueueMember, facts: MemberFacts) => {
    const prior = cache
      .prepare(
        'SELECT value,grounding FROM memberFacts WHERE intake=? AND groupOrdinal=? AND candidate=? AND version=?',
      )
      .get(intakeId, member.groupOrdinal, member.candidateId, member.candidateVersionId);
    const old = prior ? (JSON.parse(String(prior.value)) as MemberFacts) : undefined;
    if (old && Object.hasOwn(old, 'date'))
      cache
        .prepare('UPDATE dates SET count=count-1 WHERE intake=? AND groupOrdinal=? AND date=?')
        .run(intakeId, member.groupOrdinal, old.date ?? '');
    if (Object.hasOwn(facts, 'date'))
      cache
        .prepare(
          'INSERT INTO dates VALUES(?,?,?,1) ON CONFLICT(intake,groupOrdinal,date) DO UPDATE SET count=count+1',
        )
        .run(intakeId, member.groupOrdinal, facts.date ?? '');
    cache
      .prepare('DELETE FROM dates WHERE intake=? AND groupOrdinal=? AND count=0')
      .run(intakeId, member.groupOrdinal);
    cache
      .prepare('INSERT OR REPLACE INTO memberFacts VALUES(?,?,?,?,?,?)')
      .run(
        intakeId,
        member.groupOrdinal,
        member.candidateId,
        member.candidateVersionId,
        JSON.stringify(facts),
        currentGroundingEpoch(intakeId),
      );
    return prior?.grounding === currentGroundingEpoch(intakeId) ? old : undefined;
  };
  let binding = '',
    clinicalRevision = '';
  const refresh = async () => {
    const expected = bindingNow(),
      currentRevision = intakeClinicalCachePin(db);
    cache.exec('BEGIN;UPDATE sources SET seen=0,dirty=0');
    try {
      for (const source of collectionQueueSources(db, profileId)) {
        const pin = canonicalLiteral(intakeSourceVersion(db, source.id)),
          prior = cache.prepare('SELECT pin FROM sources WHERE id=?').get(source.id);
        cache
          .prepare('INSERT INTO sources VALUES(?,?,1,0) ON CONFLICT(id) DO UPDATE SET seen=1')
          .run(source.id, pin);
        if (prior?.pin === pin && clinicalRevision === currentRevision) continue;
        const old = prior
            ? (JSON.parse(String(prior.pin)) as ReturnType<typeof intakeSourceVersion>)
            : undefined,
          current = intakeSourceVersion(db, source.id);
        const effects =
          clinicalRevision === currentRevision &&
          old?.logicalBinding &&
          current.logicalBinding &&
          canonicalLiteral(old.sourcePin) === canonicalLiteral(current.sourcePin)
            ? collectionQueueTransitionEffects(
                db,
                source.id,
                JSON.parse(old.logicalBinding),
                JSON.parse(current.logicalBinding),
              )
            : undefined;
        let narrow = !!effects;
        cache.exec('DELETE FROM changedCandidates;DELETE FROM changedGroups');
        if (effects)
          for (const effect of effects) {
            if (effect.kind === 'proposal') continue;
            if (effect.kind === 'group') {
              cache.prepare('INSERT INTO changedGroups(value) VALUES(?)').run(effect.value);
              continue;
            }
            if (effect.kind !== 'candidate') {
              narrow = false;
              continue;
            }
            const change = JSON.parse(effect.value) as {
              candidateVersionId?: string;
              kind?: string;
            };
            cache
              .prepare('INSERT OR IGNORE INTO changedCandidates VALUES(?,?)')
              .run(effect.key, change.candidateVersionId || '');
            if (change.kind === 'append')
              for (const previous of cache
                .prepare(
                  "SELECT version FROM members WHERE intake=? AND candidate=? AND state IN ('pending','deferred')",
                )
                .iterate(source.id, effect.key))
                cache
                  .prepare('INSERT OR IGNORE INTO changedCandidates VALUES(?,?)')
                  .run(effect.key, previous.version);
          }
        if (narrow && cache.prepare('SELECT 1 FROM changedGroups LIMIT 1').get()) {
          // Synthetic legacy fallbacks and duplicate group identities retain their complete compatibility preparation.
          if (
            cache
              .prepare(
                'SELECT 1 FROM groups WHERE intake=? AND (address IS NULL OR span<0) LIMIT 1',
              )
              .get(source.id) ||
            cache
              .prepare('SELECT 1 FROM groups WHERE intake=? GROUP BY id HAVING count(*)>1 LIMIT 1')
              .get(source.id)
          )
            narrow = false;
        }
        if (narrow)
          for (const event of cache
            .prepare('SELECT value FROM changedGroups ORDER BY sequence')
            .iterate()) {
            const change = JSON.parse(String(event.value)) as NonNullable<
                NativeProposalAffected['reportVersionChanges']
              >[number],
              view = openIntakeCollectionEnvelope(db, source),
              group = view.resolve(change.groupAddress),
              groupId = scalar<string>(view, group, 'id')!,
              basis = scalar<string>(view, group, 'basis')!,
              ordinal = intakeEnvelopeRecordOrder(view, group).at(-1)!,
              first = view.childAt(group, 'versions', 0)!,
              discovery = scalar<number>(view, group, 'discoveryOrder'),
              ordering =
                discovery === undefined
                  ? '0:' +
                    scalar(view, first, 'createdAt') +
                    ':' +
                    source.id +
                    ':' +
                    String(ordinal).padStart(12, '0') +
                    ':' +
                    groupId
                  : '1:' + String(discovery).padStart(20, '0') + ':' + groupId,
              priorGroup = cache
                .prepare('SELECT span FROM groups WHERE intake=? AND groupOrdinal=?')
                .get(source.id, ordinal),
              span = Number(priorGroup?.span || 0),
              snapshot = openReportMemberSnapshot(
                createReportSnapshotCatalog(db, source),
                change.members,
              );
            cache
              .prepare(
                'INSERT INTO groups VALUES(?,?,?,?,?,?,?) ON CONFLICT(intake,groupOrdinal) DO UPDATE SET span=excluded.span',
              )
              .run(
                source.id,
                groupId,
                ordering,
                change.groupAddress,
                basis,
                ordinal,
                span + change.members.memberCount,
              );
            cache
              .prepare('DELETE FROM summaries WHERE intake=? AND ordinal=?')
              .run(source.id, ordinal);
            cache
              .prepare('DELETE FROM people WHERE intake=? AND groupId=?')
              .run(source.id, groupId);
            const people = openCollectionPeopleRead(db, root, profileId, source.id);
            for (const pointer of people.pointers(groupId))
              cache
                .prepare(
                  'INSERT INTO people VALUES(?,?,?,1) ON CONFLICT(intake,groupId,state) DO UPDATE SET count=count+1',
                )
                .run(source.id, groupId, people.state(pointer));
            for (const selected of change.changed) {
              const header = snapshot.member(selected.candidateId, selected.candidateVersionId);
              if (!header) throw changed();
              const oldRow = cache
                .prepare(
                  'SELECT m.rowid,m.value,g.basis,g.groupOrdinal FROM members m JOIN groups g ON g.intake=m.intake AND g.groupOrdinal=m.groupOrdinal WHERE m.intake=? AND m.candidate=? AND m.version=?',
                )
                .get(source.id, selected.candidateId, selected.candidateVersionId);
              if (oldRow) {
                if (Number(oldRow.groupOrdinal) === ordinal) continue;
                const oldRank = oldRow.basis === 'report_anchor' ? 1 : 0,
                  newRank = basis === 'report_anchor' ? 1 : 0;
                if (
                  oldRank > newRank ||
                  (oldRank === newRank && Number(oldRow.groupOrdinal) > ordinal)
                )
                  continue;
                const oldMember = JSON.parse(String(oldRow.value)) as CollectionReportQueueMember;
                changeMemberCount(source.id, oldMember, -1);
                cache.prepare('DELETE FROM members WHERE rowid=?').run(oldRow.rowid);
                cache
                  .prepare('DELETE FROM summaries WHERE intake=? AND ordinal=?')
                  .run(source.id, oldMember.groupOrdinal);
              }
              const member = currentCollectionReportQueueMember(db, profileId, source.id, {
                groupOrdinal: ordinal,
                groupId,
                groupOrder: ordering,
                memberOrder: span + header.ordinal,
                candidateId: selected.candidateId,
                candidateVersionId: selected.candidateVersionId,
                proposalId: null,
                recordId: '',
                state: 'pending',
              });
              if (!member) continue;
              cache
                .prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?,?)')
                .run(
                  source.id,
                  groupId,
                  member.memberOrder,
                  member.candidateId,
                  member.candidateVersionId,
                  JSON.stringify(member),
                  ordinal,
                  member.state,
                  memberOrderKey(member),
                );
              changeMemberCount(source.id, member, 1);
            }
          }
        if (narrow) {
          let prepared: ReturnType<typeof prepareCollectionClinicalReview> | undefined,
            proposal: string | null | undefined;
          try {
            for (const candidate of cache
              .prepare('SELECT id,version FROM changedCandidates')
              .iterate())
              for (const row of cache
                .prepare(
                  "SELECT rowid,value,groupOrdinal FROM members WHERE intake=? AND candidate=? AND (?='' OR version=?)",
                )
                .iterate(source.id, candidate.id, candidate.version, candidate.version)) {
                const member = currentCollectionReportQueueMember(
                  db,
                  profileId,
                  source.id,
                  JSON.parse(String(row.value)),
                );
                withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueueMemberRows'));
                if (member)
                  cache
                    .prepare('UPDATE members SET value=?,state=? WHERE rowid=?')
                    .run(JSON.stringify(member), member.state, row.rowid);
                else cache.prepare('DELETE FROM members WHERE rowid=?').run(row.rowid);
                changeMemberCount(source.id, JSON.parse(String(row.value)), -1);
                if (member) changeMemberCount(source.id, member, 1);
                const retained = cache
                    .prepare(
                      'SELECT value FROM summaries WHERE intake=? AND ordinal=? AND grounding=?',
                    )
                    .get(source.id, row.groupOrdinal, currentGroundingEpoch(source.id)),
                  oldMember = JSON.parse(String(row.value)) as CollectionReportQueueMember;
                if (
                  member &&
                  retained &&
                  ['pending', 'deferred'].includes(member.state) &&
                  ['pending', 'deferred'].includes(oldMember.state)
                ) {
                  if (!prepared || proposal !== member.proposalId) {
                    if (prepared?.status === 'ready') prepared.session.close();
                    prepared = prepareCollectionClinicalReview(
                      db,
                      root,
                      profileId,
                      source.id,
                      member.proposalId,
                      {
                        groundingDependency: (dependency) =>
                          retainGroundingDependency(source.id, dependency),
                      },
                    );
                    proposal = member.proposalId;
                    withIntakeWork(db, 'warm', () =>
                      recordIntakeWork('collectionQueueClinicalReviews'),
                    );
                  }
                  if (prepared.status !== 'ready')
                    throw new IntakeReviewFragmentRequired(prepared.reference);
                  const selected = prepared.session.record(
                    member.recordId,
                    member.candidateId,
                    member.candidateVersionId,
                  );
                  if (!selected) throw changed();
                  const summary = JSON.parse(
                      String(retained.value),
                    ) as CollectionReportGroupSummary,
                    facts = reviewedMemberFacts(
                      member,
                      reviewedIntakeQueueRecord(selected, member.state),
                      summary.basis === 'candidate_fallback',
                    ),
                    old = putFacts(source.id, member, facts);
                  if (old) {
                    for (const key of Object.keys(
                      summary.counts,
                    ) as (keyof IntakeReportQueueCounts)[])
                      summary.counts[key] += facts.counts[key] - old.counts[key];
                    const dates = cache
                      .prepare('SELECT date FROM dates WHERE intake=? AND groupOrdinal=? LIMIT 2')
                      .all(source.id, member.groupOrdinal);
                    summary.date = dates.length === 1 ? String(dates[0]!.date) || null : null;
                    if (facts.title !== undefined)
                      summary.title = facts.title || summary.original.filename;
                    cache
                      .prepare('UPDATE summaries SET value=? WHERE intake=? AND ordinal=?')
                      .run(JSON.stringify(summary), source.id, member.groupOrdinal);
                  } else
                    cache
                      .prepare('DELETE FROM summaries WHERE intake=? AND ordinal=?')
                      .run(source.id, row.groupOrdinal);
                } else
                  cache
                    .prepare('DELETE FROM summaries WHERE intake=? AND ordinal=?')
                    .run(source.id, row.groupOrdinal);
              }
          } finally {
            if (prepared?.status === 'ready') prepared.session.close();
          }
          cache.prepare('UPDATE sources SET pin=?,dirty=2 WHERE id=?').run(pin, source.id);
          continue;
        }
        cache.prepare('UPDATE sources SET pin=?,dirty=1 WHERE id=?').run(pin, source.id);
        for (const table of [
          'groups',
          'members',
          'memberTotals',
          'people',
          'summaries',
          'memberFacts',
          'dates',
          'groundingSources',
          'groundingDependencies',
        ])
          cache.prepare(`DELETE FROM ${table} WHERE intake=?`).run(source.id);
        cache
          .prepare(
            'DELETE FROM summaries WHERE intake IN (SELECT intake FROM receipts WHERE owner=?)',
          )
          .run(source.id);
        cache.prepare('DELETE FROM receipts WHERE owner=?').run(source.id);
        for (const member of collectionReportQueueMembers(db, profileId, source.id, (group) =>
          cache
            .prepare('INSERT INTO groups VALUES(?,?,?,?,?,?,?)')
            .run(
              source.id,
              group.groupId,
              group.order,
              group.address,
              group.basis,
              group.ordinal,
              group.memberSpan ?? -1,
            ),
        )) {
          withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueueMemberRows'));
          cache
            .prepare('INSERT INTO members VALUES(?,?,?,?,?,?,?,?,?)')
            .run(
              source.id,
              member.groupId,
              member.memberOrder,
              member.candidateId,
              member.candidateVersionId,
              JSON.stringify(member),
              member.groupOrdinal,
              member.state,
              memberOrderKey(member),
            );
          changeMemberCount(source.id, member, 1);
        }
        const people = openCollectionPeopleRead(db, root, profileId, source.id);
        for (const pointer of people.pointers())
          cache
            .prepare(
              'INSERT INTO people VALUES(?,?,?,1) ON CONFLICT(intake,groupId,state) DO UPDATE SET count=count+1',
            )
            .run(source.id, pointer.groupId, people.state(pointer));
      }
      for (const row of cache.prepare('SELECT id FROM sources WHERE seen=0').iterate()) {
        for (const table of [
          'groups',
          'members',
          'memberTotals',
          'people',
          'summaries',
          'memberFacts',
          'dates',
        ])
          cache.prepare(`DELETE FROM ${table} WHERE intake=?`).run(row.id);
        cache.prepare('DELETE FROM receipts WHERE owner=?').run(row.id);
      }
      cache.exec('DELETE FROM sources WHERE seen=0');
      // Report acceptance receipts can cover other intake blocks. Preserve every retained receipt occurrence.
      for (const source of collectionQueueSources(db, profileId)) {
        if (cache.prepare('SELECT dirty FROM sources WHERE id=?').get(source.id)?.dirty !== 1)
          continue;
        const view = openIntakeCollectionEnvelope(db, source),
          intake = view.child(view.root(), 'intake')!,
          flow = view.child(intake, 'workflow');
        for (const accepted of intakeReviewChildren(view, flow, 'reportAcceptances')) {
          const receipt = view.child(accepted, 'receipt');
          if (!receipt) continue;
          for (const block of intakeReviewChildren(view, receipt, 'receipts')) {
            const intakeId = scalar<string>(view, block, 'intakeId');
            if (!intakeId) continue;
            for (const record of intakeReviewChildren(view, block, 'records')) {
              withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueueReceiptRecords'));
              const candidate = scalar<string>(view, record, 'candidateId'),
                version = scalar<string>(view, record, 'candidateVersionId');
              if (!candidate || !version) continue;
              let reviewedGroup: string | undefined, label: string | undefined;
              if (view.has(record, 'reviewedSource')) {
                const reviewed = await prepareIntakeJsonCanonical(
                  view.fieldChunks(record, 'reviewedSource'),
                );
                try {
                  const text = (name: string) => {
                    const handle = reviewed.field(reviewed.root, name);
                    if (!handle) return undefined;
                    let value = '';
                    for (const chunk of reviewed.pieces(handle)) {
                      if (Buffer.byteLength(value) + Buffer.byteLength(chunk) > 16384)
                        throw new IntakeReviewFragmentRequired({
                          format: 'health-intake-review-fragment-v1',
                          logical: view.logical,
                          address: view.address(record),
                          field: 'reviewedSource',
                        });
                      value += chunk;
                    }
                    const parsed: unknown = JSON.parse(value);
                    return typeof parsed === 'string' ? parsed : undefined;
                  };
                  reviewedGroup = text('groupId');
                  label = text('source');
                } finally {
                  reviewed.close();
                }
              }
              cache
                .prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?)')
                .run(source.id, intakeId, candidate, version, reviewedGroup || null, label || '');
              cache.prepare('DELETE FROM summaries WHERE intake=?').run(intakeId);
            }
          }
        }
      }
      if (bindingNow() !== expected) throw changed();
      cache.exec('COMMIT');
      binding = expected;
      clinicalRevision = currentRevision;
    } catch (error) {
      cache.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    await refresh();
  } catch (error) {
    scratch.close();
    throw error;
  }
  const assertCurrent = () => {
    if (bindingNow() !== binding) throw changed();
  };
  let reviewCache: ReturnType<typeof prepareCollectionClinicalReview> | undefined,
    reviewKey = '',
    reviewObservedStamp: string | undefined,
    reviewCertificate: CollectionReviewRowCertificate | undefined;
  const resetReview = () => {
    if (reviewCache?.status === 'ready') reviewCache.session.close();
    reviewCache = undefined;
    reviewKey = '';
    reviewObservedStamp = undefined;
    reviewCertificate = undefined;
  };
  return {
    get binding() {
      return binding;
    },
    get clinicalRevision() {
      return clinicalRevision;
    },
    refresh,
    groundingStamp: currentGroundingEpoch,
    *sources() {
      for (const row of cache.prepare('SELECT id,pin FROM sources ORDER BY id').iterate())
        yield { id: String(row.id), pin: String(row.pin) };
    },
    assertCurrent,
    currentReviewCertificate(
      intakeId: string,
      certificate: CollectionReviewRowCertificate | undefined,
    ) {
      const currentStamp = reviewReadStamp(db);
      if (!certificate || certificate.stamp !== currentStamp) return false;
      return (
        certificate.queueBinding === binding &&
        certificate.requestRevision === revision(db) &&
        certificate.sourcePin === canonicalLiteral(intakeSourceVersion(db, intakeId))
      );
    },
    close() {
      resetReview();
      scratch.close();
    },
    resetReview,
    releaseReview(success: boolean) {
      // Only an unchanged successful read may retain one completed proposal. Failed
      // leases and transactions cannot seed a session for a later window.
      let retained = false;
      try {
        retained = !!(
          success &&
          reviewCertificate &&
          reviewCertificate.stamp === reviewReadStamp(db) &&
          reviewCertificate.requestRevision === revision(db) &&
          reviewCertificate.queueBinding === bindingNow()
        );
      } finally {
        if (!retained) resetReview();
      }
    },
    summary(intakeId: string, ordinal: number) {
      const row = cache
        .prepare('SELECT value FROM summaries WHERE intake=? AND ordinal=? AND grounding=?')
        .get(intakeId, ordinal, currentGroundingEpoch(intakeId));
      if (!row) return undefined;
      const value = JSON.parse(String(row.value)) as CollectionReportGroupSummary;
      value.intakeVersion = intakeSourceVersion(db, intakeId).version;
      const logical = openIntakeCollectionEnvelope(db, { id: intakeId }).logical;
      const refresh = (field: unknown) => {
        if (
          field &&
          typeof field === 'object' &&
          (field as { format?: string }).format === 'health-intake-review-fragment-v1'
        )
          (field as IntakeReviewFragmentReference).logical = logical;
      };
      for (const field of [
        value.title,
        value.source,
        value.original.filename,
        value.member?.filename,
        value.member?.locator,
        value.report,
        value.reportContext,
      ])
        refresh(field);
      for (const kind of ['current', 'saved'] as const) {
        const cursor = value.sourceCoverage[kind].bySource.nextCursor;
        if (cursor) {
          const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          parts[0] = binding;
          value.sourceCoverage[kind].bySource.nextCursor = Buffer.from(
            JSON.stringify(parts),
          ).toString('base64url');
        }
      }
      return value;
    },
    cacheSummary(value: CollectionReportGroupSummary) {
      cache
        .prepare('INSERT OR REPLACE INTO summaries VALUES(?,?,?,?)')
        .run(
          value.intakeId,
          value.groupOrdinal,
          JSON.stringify(value),
          currentGroundingEpoch(value.intakeId),
        );
    },
    cacheMemberFacts: putFacts,
    beginSummary(intakeId: string, ordinal: number) {
      cache
        .prepare('DELETE FROM memberFacts WHERE intake=? AND groupOrdinal=?')
        .run(intakeId, ordinal);
      cache.prepare('DELETE FROM dates WHERE intake=? AND groupOrdinal=?').run(intakeId, ordinal);
    },
    groupPointer(intakeId: string, ordinal: number) {
      const row = cache
        .prepare('SELECT * FROM groups WHERE intake=? AND groupOrdinal=?')
        .get(intakeId, ordinal);
      return row
        ? {
            intakeId,
            groupId: String(row.id),
            ordinal,
            order: String(row.ordering),
            basis: String(row.basis),
            address: row.address === null ? null : String(row.address),
          }
        : undefined;
    },
    memberFacts(intakeId: string, member: CollectionReportQueueMember) {
      const row = cache
        .prepare(
          'SELECT value FROM memberFacts WHERE intake=? AND groupOrdinal=? AND candidate=? AND version=? AND grounding=?',
        )
        .get(
          intakeId,
          member.groupOrdinal,
          member.candidateId,
          member.candidateVersionId,
          currentGroundingEpoch(intakeId),
        );
      return row ? (JSON.parse(String(row.value)) as MemberFacts) : undefined;
    },
    *membersByCandidate(intakeId: string, candidateId: string, version = '') {
      for (const row of cache
        .prepare(
          `SELECT m.value,g.* FROM members m JOIN groups g
        ON g.intake=m.intake AND g.groupOrdinal=m.groupOrdinal
        WHERE m.intake=? AND m.candidate=? AND (?='' OR m.version=?)
        ORDER BY g.groupOrdinal,m.ordinal`,
        )
        .iterate(intakeId, candidateId, version, version))
        yield {
          member: JSON.parse(String(row.value)) as CollectionReportQueueMember,
          pointer: {
            intakeId,
            groupId: String(row.id),
            ordinal: Number(row.groupOrdinal),
            order: String(row.ordering),
            basis: String(row.basis),
            address: row.address === null ? null : String(row.address),
          },
        };
    },
    reviewMember(intakeId: string, member: CollectionReportQueueMember) {
      assertCurrent();
      const key = canonicalLiteral([intakeId, member.proposalId]),
        stamp = reviewReadStamp(db),
        requestRevision = revision(db),
        sourcePin = canonicalLiteral(intakeSourceVersion(db, intakeId));
      if (
        !reviewCache ||
        reviewKey !== key ||
        stamp === undefined ||
        stamp !== reviewObservedStamp ||
        reviewCertificate?.requestRevision !== requestRevision ||
        reviewCertificate?.sourcePin !== sourcePin ||
        reviewCertificate?.queueBinding !== binding
      ) {
        resetReview();
        withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueueClinicalReviews'));
        reviewCache = prepareCollectionClinicalReview(
          db,
          root,
          profileId,
          intakeId,
          member.proposalId,
          { groundingDependency: (dependency) => retainGroundingDependency(intakeId, dependency) },
        );
        reviewKey = key;
        reviewObservedStamp = reviewReadStamp(db);
        reviewCertificate =
          stamp !== undefined &&
          stamp === reviewObservedStamp &&
          requestRevision === revision(db) &&
          sourcePin === canonicalLiteral(intakeSourceVersion(db, intakeId))
            ? { stamp, requestRevision, sourcePin, queueBinding: binding }
            : undefined;
      }
      if (reviewCache.status !== 'ready')
        throw new IntakeReviewFragmentRequired(reviewCache.reference);
      const record = reviewCache.session.record(
        member.recordId,
        member.candidateId,
        member.candidateVersionId,
      );
      if (!record)
        throw new HttpError(
          409,
          'REPORT_REFERENCE_UNAVAILABLE',
          'A report reference no longer matches its retained proposal',
        );
      const reviewed = reviewedIntakeQueueRecord(record, member.state),
        facts = reviewedMemberFacts(member, reviewed, true),
        // Transport omits absent optional fields while retaining raw JSON numbers.
        // canonicalLiteral also serves digest recipes that retain own undefined fields.
        encoded = JSON.stringify(record),
        detached = JSON.parse(encoded, (_key, value, context) =>
          typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
            ? JSON.rawJSON(context.source)
            : value,
        ) as typeof record;
      withIntakeWork(db, 'warm', () => {
        const bytes = Buffer.byteLength(encoded);
        recordIntakeWork('serializationCalls');
        recordIntakeWork('serializedBytes', bytes);
        recordIntakeWork('jsonParseCalls');
        recordIntakeWork('jsonParseBytes', bytes);
      });
      return {
        certificate: reviewCertificate && { ...reviewCertificate },
        version: reviewCache.session.review.version,
        reviewToken: reviewCache.session.review.reviewToken,
        recordBytes: Buffer.byteLength(encoded),
        // Complete policy providers stay private. Transport contains their existing
        // references; small policy facts are computed before detaching the row.
        record: { ...detached, queueState: reviewed.queueState, selectable: reviewed.selectable },
        facts,
        ordinal: reviewCache.session.review.records.indexOf(record),
      };
    },
    *groups(
      view: IntakeReportQueueView = 'all',
      selectedIntake?: string,
    ): Generator<CollectionReportQueueGroupPointer & { intakeId: string }> {
      for (const row of cache
        .prepare('SELECT * FROM groups WHERE (? IS NULL OR intake=?) ORDER BY ordering,intake,id')
        .iterate(selectedIntake || null, selectedIntake || null)) {
        const intakeId = String(row.intake),
          groupId = String(row.id);
        const clinical = cache
          .prepare('SELECT value FROM members WHERE intake=? AND groupOrdinal=?')
          .iterate(intakeId, Number(row.groupOrdinal));
        let visible = false;
        for (const item of clinical) {
          const state = (JSON.parse(String(item.value)) as CollectionReportQueueMember).state;
          if (view === 'all' || state === (view === 'active' ? 'pending' : 'deferred')) {
            visible = true;
            break;
          }
        }
        if (!visible)
          for (const item of cache
            .prepare('SELECT state FROM people WHERE intake=? AND groupId=?')
            .iterate(intakeId, groupId))
            if (view === 'all' || item.state === (view === 'active' ? 'pending' : 'later')) {
              visible = true;
              break;
            }
        if (visible)
          yield {
            intakeId,
            groupId,
            ordinal: Number(row.groupOrdinal),
            order: String(row.ordering),
            basis: String(row.basis),
            address: row.address === null ? null : String(row.address),
          };
      }
    },
    *members(intakeId: string, groupOrdinal: number): Generator<CollectionReportQueueMember> {
      for (const row of cache
        .prepare('SELECT value FROM members WHERE intake=? AND groupOrdinal=? ORDER BY ordinal')
        .iterate(intakeId, groupOrdinal))
        yield JSON.parse(String(row.value));
    },
    recordMemberWindow(
      intakeId: string,
      input: { groupId?: string; view: IntakeReportQueueView; after: string; limit: number },
    ) {
      const state = input.view === 'all' ? null : input.view === 'active' ? 'pending' : 'deferred',
        clauses = ['intake=?', 'ordering>?'],
        args: (string | number)[] = [intakeId, input.after];
      if (input.groupId) {
        clauses.push('groupId=?');
        args.push(input.groupId);
      }
      if (state) {
        clauses.push('state=?');
        args.push(state);
      }
      const totals = cache
        .prepare(
          'SELECT coalesce(sum(count),0) n FROM memberTotals WHERE intake=? AND groupId=?' +
            (state ? ' AND state=?' : ''),
        )
        .get(intakeId, input.groupId || '', ...(state ? [state] : []));
      return {
        totalRecords: Number(totals!.n),
        *members() {
          for (const row of cache
            .prepare(
              'SELECT value FROM members WHERE ' +
                clauses.join(' AND ') +
                ' ORDER BY ordering LIMIT ?',
            )
            .iterate(...args, input.limit))
            yield JSON.parse(String(row.value)) as CollectionReportQueueMember;
        },
      };
    },
    peopleCounts(intakeId: string, groupId: string) {
      const counts = { pending: 0, later: 0, excluded: 0, saved: 0 };
      for (const row of cache
        .prepare('SELECT state,count FROM people WHERE intake=? AND groupId=?')
        .iterate(intakeId, groupId))
        counts[String(row.state) as keyof typeof counts] = Number(row.count);
      return counts;
    },
    allPeopleCounts(intakeId: string, groupId?: string) {
      const counts = { pending: 0, later: 0, excluded: 0, saved: 0 };
      for (const row of cache
        .prepare(
          'SELECT state,sum(count) count FROM people WHERE intake=?' +
            (groupId ? ' AND groupId=?' : '') +
            ' GROUP BY state',
        )
        .iterate(intakeId, ...(groupId ? [groupId] : [])))
        counts[String(row.state) as keyof typeof counts] = Number(row.count);
      return counts;
    },
    saved(intakeId: string, groupOrdinal: number) {
      return cache
        .prepare(
          `SELECT CASE WHEN r.reviewedGroup=m.groupId THEN r.source ELSE '' END AS source,count(*) AS count
          FROM receipts r JOIN (SELECT DISTINCT intake,groupId,candidate,version FROM members WHERE intake=? AND groupOrdinal=?) m
          ON r.intake=m.intake AND r.candidate=m.candidate AND r.version=m.version
          GROUP BY CASE WHEN r.reviewedGroup=m.groupId THEN r.source ELSE '' END ORDER BY source`,
        )
        .iterate(intakeId, groupOrdinal);
    },
  };
}

export async function collectionReportGroupSummary(
  db: DatabaseSync,
  root: string,
  profileId: string,
  queue: Awaited<ReturnType<typeof openCollectionReportQueue>>,
  pointer: CollectionReportQueueGroupPointer & { intakeId: string },
  sourcePage?: { kind: 'current' | 'saved'; cursor?: string; limit?: number },
): Promise<CollectionReportGroupSummary> {
  queue.assertCurrent();
  const grounding = identityGroundingGeneration(db);
  if (!sourcePage) {
    const cached = queue.summary(pointer.intakeId, pointer.ordinal);
    if (cached) return cached;
  }
  withIntakeWork(db, 'warm', () => recordIntakeWork('collectionQueueSummaryBuilds'));
  const { intakeId, groupId } = pointer,
    source = { id: intakeId },
    view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow'),
    group = pointer.address ? view.resolve(pointer.address) : undefined,
    current = group && view.childAt(group, 'versions', view.childCount(group, 'versions') - 1),
    filename = evidence(view, intake, 'originalName');
  const tally = emptyCounts(),
    dates = new Set<string | null>();
  queue.beginSummary(intakeId, pointer.ordinal);
  let fallbackTitle = '';

  const coverageScratch = disposableSqlite('circus-report-coverage-'),
    coverageDb = coverageScratch.db;
  coverageDb.exec(
    'CREATE TABLE sources(kind TEXT,source TEXT,count INTEGER,PRIMARY KEY(kind,source))',
  );
  let sourceReview: CollectionReportGroupSummary['sourceReview'] = null;
  try {
    const report = group && view.child(group, 'report');
    if (group && pointer.basis === 'report_anchor' && report && view.has(report, 'anchor')) {
      const scope = await prepareNativeReportSourceReviewScope(db, source, {
        profileId,
        groupId,
        view: 'all',
      });
      try {
        sourceReview = { intakeId, groupId, view: 'all', scopeToken: scope.scopeToken };
        for (const entry of scope.entries()) {
          const resolution = resolveNativeReportSource(db, source, {
            candidateId: entry.candidateId,
            candidateVersionId: entry.candidateVersionId,
            references: () => [entry.sourceRef],
            occurrence: {
              proposalId: entry.proposalId,
              recordId: entry.recordId,
              batchId: entry.batchId,
              locator: selectNativeReportSourceLocator(db, source, entry.occurrenceAddress),
            },
          });
          coverageDb
            .prepare(
              'INSERT INTO sources VALUES(?,?,1) ON CONFLICT(kind,source) DO UPDATE SET count=count+1',
            )
            .run('current', resolution?.confirmation.source || '');
        }
        scope.assertCurrent();
      } finally {
        scope.close();
      }
    }
    for (const member of queue.members(intakeId, pointer.ordinal)) {
      if (member.state === 'kept_original') tally.keptOriginal++;
      else tally[member.state]++;
      const candidate =
          workflow && view.find('candidate', workflow, member.candidateId, { match: 'last' }),
        latest =
          candidate &&
          view.childAt(candidate, 'versions', view.childCount(candidate, 'versions') - 1),
        isCurrent = latest && scalar(view, latest, 'id') === member.candidateVersionId;
      if (
        member.state !== 'pending' &&
        member.state !== 'deferred' &&
        !(pointer.basis === 'candidate_fallback' && !fallbackTitle && isCurrent)
      ) {
        queue.cacheMemberFacts(intakeId, member, reviewedMemberFacts(member));
        continue;
      }
      const { facts } = queue.reviewMember(intakeId, member);
      queue.cacheMemberFacts(intakeId, member, {
        ...facts,
        title: isCurrent && pointer.basis === 'candidate_fallback' ? facts.title : undefined,
      });
      if (pointer.basis === 'candidate_fallback' && !fallbackTitle && isCurrent)
        fallbackTitle = facts.title || '';
      if (member.state !== 'pending' && member.state !== 'deferred') continue;
      tally.blocked += facts.counts.blocked;
      tally.questions += facts.counts.questions;
      if (dates.size < 2) dates.add(facts.date ?? null);
    }
    for (const row of queue.saved(intakeId, pointer.ordinal))
      coverageDb.prepare('INSERT INTO sources VALUES(?,?,?)').run('saved', row.source, row.count);
    const coverage = (kind: 'current' | 'saved'): CollectionSourceCoverage => {
      const limit = sourcePage?.kind === kind ? (sourcePage.limit ?? 20) : 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new HttpError(400, 'REPORT_QUEUE_WINDOW', 'Choose 1 to 100 source labels');
      let after: string | undefined;
      if (sourcePage?.kind === kind && sourcePage.cursor) {
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.from(sourcePage.cursor, 'base64url').toString('utf8'));
        } catch {
          throw changed();
        }
        if (
          !Array.isArray(raw) ||
          raw.length !== 6 ||
          raw[0] !== queue.binding ||
          raw[1] !== intakeId ||
          raw[2] !== groupId ||
          raw[3] !== pointer.ordinal ||
          raw[4] !== kind ||
          typeof raw[5] !== 'string'
        )
          throw changed();
        after = raw[5];
      }
      const row = coverageDb
          .prepare(
            "SELECT coalesce(sum(count),0) total,coalesce(sum(CASE WHEN source<>'' THEN count ELSE 0 END),0) covered,coalesce(sum(CASE WHEN source<>'' THEN 1 ELSE 0 END),0) sources FROM sources WHERE kind=?",
          )
          .get(kind)!,
        total = Number(row.total),
        covered = Number(row.covered),
        sourceCount = Number(row.sources);
      const items: { source: string; count: number }[] = [];
      let remaining = 0;
      for (const row of coverageDb
        .prepare("SELECT source,count FROM sources WHERE kind=? AND source<>''")
        .iterate(kind)) {
        const source = String(row.source);
        if (after !== undefined && source.localeCompare(after) <= 0) continue;
        remaining++;
        items.push({ source, count: Number(row.count) });
        items.sort((a, b) => a.source.localeCompare(b.source));
        if (items.length > limit) items.pop();
      }
      return {
        total,
        covered,
        uncovered: total - covered,
        status: !total
          ? 'empty'
          : !covered
            ? 'uncovered'
            : covered < total
              ? 'partial'
              : sourceCount === 1
                ? 'single'
                : 'mixed',
        sourceCount,
        bySource: {
          items,
          total: sourceCount,
          nextCursor:
            remaining > items.length
              ? Buffer.from(
                  canonicalLiteral([
                    queue.binding,
                    intakeId,
                    groupId,
                    pointer.ordinal,
                    kind,
                    items.at(-1)!.source,
                  ]),
                ).toString('base64url')
              : null,
        },
      };
    };
    const sourceCoverage = { current: coverage('current'), saved: coverage('saved') },
      effective =
        sourceCoverage.current.status === 'single'
          ? String(
              coverageDb
                .prepare("SELECT source FROM sources WHERE kind='current' AND source<>''")
                .get()!.source,
            )
          : sourceCoverage.current.status === 'empty' && sourceCoverage.saved.status === 'single'
            ? String(
                coverageDb
                  .prepare("SELECT source FROM sources WHERE kind='saved' AND source<>''")
                  .get()!.source,
              )
            : null,
      metadata = view.child(intake, 'metadata'),
      intakeSource = metadata ? evidence(view, metadata, 'source') : null,
      issuer = group ? evidence(view, group, 'sourceSystem') : null;
    const people = openCollectionPeopleRead(db, root, profileId, intakeId);
    let firstPerson: ReturnType<typeof people.pointer>;
    for (const pointer of people.pointers(groupId))
      if (!firstPerson || pointer.order < firstPerson.order) firstPerson = pointer;
    const memberId = group && scalar<string | null>(view, group, 'memberId'),
      selected =
        memberId && workflow && view.childCount(workflow, 'plans')
          ? readRetainedPlanEvidence(db, profileId, intakeId).firstMember(memberId)
          : undefined;
    const member = memberId
      ? {
          memberId,
          filename:
            selected?.kind === 'retained'
              ? evidence(selected.view, selected.record, 'filename')
              : selected?.member.filename || null,
          locator:
            selected?.kind === 'retained'
              ? evidence(selected.view, selected.record, 'locator')
              : selected?.member.locator || null,
        }
      : null;
    queue.assertCurrent();
    if (identityGroundingGeneration(db) !== grounding) throw changed();
    const summary: CollectionReportGroupSummary = {
      format: 'health-intake-report-group-v2',
      intakeId,
      intakeVersion: intakeSourceVersion(db, intakeId).version,
      groupId,
      groupOrdinal: pointer.ordinal,
      groupVersionId: current ? scalar<string>(view, current, 'id') || null : null,
      basis: pointer.basis,
      discoveryOrder: group ? (scalar<number>(view, group, 'discoveryOrder') ?? null) : null,
      title:
        pointer.basis === 'candidate_fallback'
          ? fallbackTitle || (firstPerson ? people.person(firstPerson).title : '') || filename
          : current
            ? evidence(view, current, 'title')
            : filename,
      source: effective || intakeSource || issuer,
      sourceScope: effective ? 'report' : intakeSource ? 'intake' : issuer ? 'issuer' : null,
      date: dates.size === 1 ? [...dates][0]! : null,
      original: {
        filename,
        contentUrl: '/api/sources/' + encodeURIComponent(intakeId) + '/content',
        parentSourceFileId: scalar<string | null>(view, intake, 'parentSourceFileId') || null,
      },
      member,
      report: group ? evidence(view, group, 'report') : null,
      reportContext: current ? evidence(view, current, 'context') : null,
      counts: tally,
      peopleCounts: queue.peopleCounts(intakeId, groupId),
      sourceCoverage,
      sourceReview,
      records: { intakeId, groupId },
      people: { intakeId, groupId },
    };
    if (!sourcePage) queue.cacheSummary(summary);
    return summary;
  } finally {
    coverageScratch.close();
  }
}
