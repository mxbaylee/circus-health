/** Complete filters and counts with bounded native feed rows and referenced group evidence. */
import type { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { HttpError } from './database.ts';
import {
  identityGroundingGeneration,
  identityGroundingReadStamp,
} from './intake-identity-grounding.ts';
import {
  openCollectionReportQueue,
  collectionReportGroupSummary,
} from './intake-report-group-collection.ts';
import type { CollectionReportGroupReference } from './intake-queue-page-collection.ts';
import { readCollectionQueueActivity } from './intake-queue-activity-collection.ts';
import {
  openCollectionPeopleRead,
  collectionPersonMatchesQuery,
} from './intake-people-collection.ts';
import { feedKind } from './intake-report-queue.ts';
import { canonicalLiteral } from './intake-format.ts';
import { intakeFeedTextMatcher } from './intake-feed-match.ts';
import {
  openIntakeCollectionEnvelope,
  intakeEnvelopeRecordOrder,
} from './intake-collection-envelope.ts';
import type { IntakeReviewFragmentReference } from './intake-review-collection.ts';
import type { IntakeClinicalReviewReference } from './intake-review-collection-session.ts';
import { hashSourceScalar } from './intake-report-source-resolution-index.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import { journalActivityBinding } from './journal-activity-index.ts';
import { verifyIntakeOriginal } from './intake.ts';
import { verifyIntakeFileHash } from './intake-files.ts';
import { profileOriginal } from './profile-storage.ts';
import type {
  IntakeReportQueueView,
  IntakeReportQueueRecordState,
  IntakeReportQueueCounts,
  IntakeImportFeedKind,
  IntakeImportFeedRecord,
} from '../shared/intake.ts';
import type { CollectionReportQueueMember } from './intake-report-queue-collection.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
import { collectionQueueTransitionEffects } from './intake-queue-transitions.ts';
import type { intakeSourceVersion } from './intake-state-access.ts';
import type { CollectionReportGroupSummary } from './intake-report-group-collection.ts';
import type { CollectionReviewRowCertificate } from './intake-report-group-collection.ts';
import type { CollectionReportQueueGroupPointer } from './intake-report-queue-collection.ts';

const kinds: IntakeImportFeedKind[] = [
  'test',
  'prescription',
  'vision',
  'procedure',
  'history',
  'unsupported',
  'person',
];
export interface CollectionImportFeedOptions {
  view?: IntakeReportQueueView;
  limit?: number;
  bytes?: number;
  cursor?: string;
  peopleCursor?: string;
  groupId?: string;
  intakeId?: string;
  recordId?: string;
  state?: IntakeReportQueueRecordState;
  q?: string;
  kind?: IntakeImportFeedKind;
  edited?: string;
}
export interface CollectionFeedRecord {
  intakeId: string;
  groupId: string;
  groupOrdinal: number;
  proposalId: string | null;
  intakeVersion: number;
  reviewToken: string;
  feedKind: Exclude<IntakeImportFeedKind, 'person'>;
  feedKey: string;
  feedOrder: string;
  manuallyEdited: boolean;
  detail:
    | { kind: 'record'; record: IntakeImportFeedRecord }
    | {
        kind: 'reference';
        reference: IntakeClinicalReviewReference;
        selection: { recordId: string; candidateVersionId?: string };
      };
}
type PreparedFeed = {
  db: DatabaseSync;
  key: string;
  binding: string;
  clinicalRevision: string;
  grounding: object;
  busy: boolean;
  scratch: ReturnType<typeof disposableSqlite>;
  signingKey: Buffer;
  counts: IntakeReportQueueCounts;
  peopleCounts: { pending: number; later: number; excluded: number; saved: number };
  kindCounts: Record<IntakeImportFeedKind, number>;
  totalRecords: number;
  totalPeopleGroups: number;
  totalGroups: number;
  used: number;
};
type CachedFeedMember = {
  member: CollectionReportQueueMember;
  certificate?: CollectionReviewRowCertificate;
};
// Keep source numeric spelling on the wire while retaining ordinary host
// counters/ordinals as numbers. This is a disposable transport snapshot.
function cachedFeedRecord(text: string): CollectionFeedRecord {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' &&
    context.source !== undefined &&
    JSON.stringify(value) !== context.source
      ? JSON.rawJSON(context.source)
      : value,
  ) as CollectionFeedRecord;
}
const preparedFeeds = new Set<PreparedFeed>(),
  feedEpochs = new WeakMap<DatabaseSync, number>();
let feedClock = 0;
function disposeFeed(feed: PreparedFeed) {
  preparedFeeds.delete(feed);
  feed.scratch.close();
  feed.signingKey.fill(0);
}
function feedRowSignature(
  db: DatabaseSync,
  key: Buffer,
  ordering: string,
  value: string,
  group: string,
  intake: string,
  member: string,
) {
  const mac = createHmac('sha256', key);
  let bytes = 0;
  for (const field of [ordering, value, group, intake, member]) {
    const prefix = String(Buffer.byteLength(field)) + ':';
    bytes += Buffer.byteLength(prefix) + Buffer.byteLength(field);
    mac.update(prefix).update(field);
  }
  withIntakeWork(db, 'warm', () => {
    recordIntakeWork('collectionFeedRowCertificateHashes');
    recordIntakeWork('collectionFeedRowCertificateBytes', bytes);
  });
  return mac.digest('hex');
}
export function clearCollectionImportFeeds(db: DatabaseSync) {
  feedEpochs.set(db, (feedEpochs.get(db) || 0) + 1);
  for (const feed of preparedFeeds) if (feed.db === db) disposeFeed(feed);
}
function feedWindow(
  db: DatabaseSync,
  root: string,
  profileId: string,
  queue: Awaited<ReturnType<typeof openCollectionReportQueue>>,
  feed: PreparedFeed,
  input: {
    view: IntakeReportQueueView;
    limit: number;
    budget: number;
    after: string;
    peopleAfter: string;
    cursor: (section: string, order: string) => string;
  },
) {
  const records: CollectionFeedRecord[] = [],
    groups = new Map<string, CollectionReportGroupReference>(),
    peopleGroups: CollectionReportGroupReference[] = [],
    verified = new Set<string>(),
    certificates: Array<{
      intakeId: string;
      certificate: NonNullable<CachedFeedMember['certificate']>;
    }> = [];
  let used = 0,
    more = false,
    peopleMore = false,
    last = '',
    peopleLast = '';
  for (const row of feed.scratch.db
    .prepare(
      'SELECT ordering,value,groupValue,intake,member,signature FROM records WHERE ordering>? ORDER BY ordering LIMIT ?',
    )
    .iterate(input.after, input.limit + 1)) {
    const value = String(row.value);
    if (records.length >= input.limit) {
      more = true;
      break;
    }
    if (
      row.signature !==
      feedRowSignature(
        db,
        feed.signingKey,
        String(row.ordering),
        value,
        String(row.groupValue),
        String(row.intake),
        String(row.member),
      )
    ) {
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Cached review changed; refresh this feed');
    }
    const record = cachedFeedRecord(value),
      cached = JSON.parse(String(row.member)) as CachedFeedMember;
    let fresh: ReturnType<typeof queue.reviewMember> | undefined;
    if (!queue.currentReviewCertificate(record.intakeId, cached.certificate)) {
      fresh = queue.reviewMember(record.intakeId, cached.member);
      record.intakeVersion = fresh.version;
      record.reviewToken = fresh.reviewToken;
      if (record.detail.kind === 'record')
        record.detail.record = {
          ...fresh.record,
          feedKind: record.feedKind,
          feedKey: record.feedKey,
          feedOrder: record.feedOrder,
          manuallyEdited: record.manuallyEdited,
        };
      else
        record.detail.reference = {
          ...record.detail.reference,
          reviewToken: record.reviewToken,
          ordinal: fresh.ordinal,
          bytes: fresh.recordBytes,
        };
    }
    let size = Buffer.byteLength(canonicalLiteral(record));
    if (size > input.budget && record.detail.kind === 'record') {
      fresh ??= queue.reviewMember(record.intakeId, cached.member);
      record.detail = {
        kind: 'reference',
        selection: {
          recordId: fresh.record.id,
          candidateVersionId: fresh.record.candidateVersionId,
        },
        reference: {
          format: 'health-intake-clinical-review-reference-v2',
          reviewToken: record.reviewToken,
          section: 'records',
          ordinal: fresh.ordinal,
          bytes: fresh.recordBytes,
        },
      };
      size = Buffer.byteLength(canonicalLiteral(record));
    }
    if (fresh) {
      const updated = canonicalLiteral(record),
        member = JSON.stringify({
          member: cached.member,
          certificate: fresh.certificate,
        } satisfies CachedFeedMember);
      feed.scratch.db
        .prepare('UPDATE records SET value=?,member=?,signature=? WHERE ordering=?')
        .run(
          updated,
          member,
          feedRowSignature(
            db,
            feed.signingKey,
            String(row.ordering),
            updated,
            String(row.groupValue),
            String(row.intake),
            member,
          ),
          row.ordering,
        );
    }
    if (records.length && used + size > input.budget) {
      more = true;
      break;
    }
    if (!verified.has(record.intakeId)) {
      verifyIntakeOriginal(db, root, profileId, record.intakeId);
      verified.add(record.intakeId);
    }
    if (record.proposalId && !verified.has(record.proposalId)) {
      const source = db
        .prepare('SELECT path,sha256,bytes FROM source_files WHERE id=?')
        .get(record.proposalId) as { path: string; sha256: string; bytes: number } | undefined;
      if (!source)
        throw new HttpError(409, 'SOURCE_CHANGED', 'Retained review source is unavailable');
      verifyIntakeFileHash(profileOriginal(root, source.path, profileId), source);
      verified.add(record.proposalId);
    }
    const certificate = fresh ? fresh.certificate : cached.certificate;
    if (certificate) certificates.push({ intakeId: record.intakeId, certificate });
    records.push(record);
    used += size;
    last = String(row.ordering);
    const group = JSON.parse(String(row.groupValue)) as CollectionReportGroupReference;
    group.binding = queue.binding;
    const summary = queue.summary(group.intakeId, group.ordinal);
    if (!summary) throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report summary');
    group.bytes = Buffer.byteLength(canonicalLiteral(summary));
    groups.set(JSON.stringify([group.intakeId, group.ordinal]), group);
  }
  for (const row of feed.scratch.db
    .prepare('SELECT ordering,value FROM people WHERE ordering>? ORDER BY ordering LIMIT ?')
    .iterate(input.peopleAfter, input.limit + 1)) {
    if (peopleGroups.length >= input.limit) {
      peopleMore = true;
      break;
    }
    const group = {
      ...JSON.parse(String(row.value)),
      binding: queue.binding,
    } as CollectionReportGroupReference;
    const summary = queue.summary(group.intakeId, group.ordinal);
    if (!summary) throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report summary');
    group.bytes = Buffer.byteLength(canonicalLiteral(summary));
    peopleGroups.push(group);
    peopleLast = String(row.ordering);
  }
  const activity = readCollectionQueueActivity(db, root, profileId, queue);
  queue.assertCurrent();
  for (const { intakeId, certificate } of certificates)
    if (!queue.currentReviewCertificate(intakeId, certificate))
      throw new HttpError(
        409,
        'REPORT_QUEUE_CURSOR',
        'Review changed while reading; refresh this feed',
      );
  return {
    format: 'health-intake-import-feed-v2' as const,
    view: input.view,
    records,
    totalRecords: feed.totalRecords,
    totalGroups: feed.totalGroups,
    nextCursor: more ? input.cursor('records', last) : null,
    counts: { ...feed.counts },
    kindCounts: { ...feed.kindCounts },
    groups: [...groups.values()].sort((a, b) =>
      a.intakeId < b.intakeId ? -1 : a.intakeId > b.intakeId ? 1 : a.ordinal - b.ordinal,
    ),
    people: {
      groups: peopleGroups,
      totalGroups: feed.totalPeopleGroups,
      counts: { ...feed.peopleCounts },
      nextCursor: peopleMore ? input.cursor('people', peopleLast) : null,
    },
    activity,
  };
}
export async function readCollectionImportFeed(
  db: DatabaseSync,
  root: string,
  profileId: string,
  input: CollectionImportFeedOptions = {},
) {
  const query = (input.q || '').trim().toLowerCase(),
    view = input.view || 'active',
    limit = input.limit ?? 50,
    budget = input.bytes ?? 128 * 1024;
  if (
    query.length > 300 ||
    !['active', 'deferred', 'all'].includes(view) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(budget) ||
    budget < 1024 ||
    budget > 256 * 1024 ||
    (input.state &&
      !['pending', 'deferred', 'accepted', 'kept_original', 'superseded'].includes(input.state)) ||
    (input.kind && !kinds.includes(input.kind)) ||
    (input.edited !== undefined && !['true', 'false'].includes(input.edited))
  )
    throw new HttpError(
      400,
      'IMPORT_FEED_FILTER',
      'Choose supported filters and a bounded feed window',
    );
  const activityPin = journalActivityBinding(root, profileId),
    queue = await openCollectionReportQueue(db, root, profileId),
    grounding = identityGroundingGeneration(db),
    epoch = feedEpochs.get(db) || 0;
  let scratch = disposableSqlite('circus-import-feed-');
  let signingKey: Buffer = randomBytes(32);
  let readingFeed: PreparedFeed | undefined;
  let reused: PreparedFeed | undefined;
  let retained = false;
  let successfulRead = false;
  scratch.db.exec(
    'CREATE TABLE sources(id TEXT PRIMARY KEY,pin TEXT,seen INTEGER,counts TEXT,peopleCounts TEXT,kindCounts TEXT,totalRecords INTEGER,totalPeopleGroups INTEGER,grounding TEXT);CREATE TABLE matches(intake TEXT,groupId TEXT,PRIMARY KEY(intake,groupId));CREATE TABLE records(ordering TEXT PRIMARY KEY,value TEXT,groupValue TEXT,intake TEXT,member TEXT,signature TEXT);CREATE INDEX recordIntake ON records(intake);CREATE TABLE people(ordering TEXT PRIMARY KEY,value TEXT,intake TEXT);CREATE INDEX peopleIntake ON people(intake);CREATE TABLE facts(intake TEXT,groupOrdinal INTEGER,candidate TEXT,version TEXT,ordering TEXT,groupId TEXT,counts TEXT,kind TEXT,included INTEGER,PRIMARY KEY(intake,groupOrdinal,candidate,version));CREATE INDEX factsGroup ON facts(intake,groupId,included);CREATE TABLE changedCandidates(id TEXT,version TEXT,PRIMARY KEY(id,version));CREATE TABLE changedGroups(ordinal INTEGER PRIMARY KEY);',
  );
  scratch.db.exec(
    'CREATE TABLE peopleMatches(intake TEXT,ordinal INTEGER,ordering TEXT,counts TEXT,visible INTEGER,PRIMARY KEY(intake,ordinal)) WITHOUT ROWID',
  );
  try {
    const binding = canonicalLiteral([
      queue.binding,
      identityGroundingReadStamp(db),
      activityPin,
      view,
      query,
      input.groupId || null,
      input.intakeId || null,
      input.recordId || null,
      input.state || null,
      input.kind || null,
      input.edited === 'true',
    ]);
    const offset = (raw: string | undefined, section: string) => {
        if (!raw) return '';
        let value: unknown;
        try {
          value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        } catch {
          throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this import feed');
        }
        if (
          !Array.isArray(value) ||
          value.length !== 3 ||
          value[0] !== binding ||
          value[1] !== section ||
          typeof value[2] !== 'string'
        )
          throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this import feed');
        return value[2];
      },
      cursor = (section: string, order: string) =>
        Buffer.from(canonicalLiteral([binding, section, order])).toString('base64url');
    const after = offset(input.cursor, 'records'),
      peopleAfter = offset(input.peopleCursor, 'people'),
      cacheKey = canonicalLiteral([
        root,
        profileId,
        view,
        query,
        input.groupId || null,
        input.intakeId || null,
        input.recordId || null,
        input.state || null,
        input.kind || null,
        input.edited === 'true',
        budget,
      ]),
      cached = [...preparedFeeds].find(
        (feed) => feed.db === db && feed.key === cacheKey && !feed.busy,
      );
    if (cached && cached.binding === queue.binding && cached.grounding === grounding) {
      cached.used = ++feedClock;
      readingFeed = cached;
      const result = feedWindow(db, root, profileId, queue, cached, {
        view,
        limit,
        budget,
        after,
        peopleAfter,
        cursor,
      });
      successfulRead = true;
      return result;
    }
    if (cached) {
      scratch.close();
      scratch = cached.scratch;
      signingKey.fill(0);
      signingKey = cached.signingKey;
      reused = cached;
      retained = true;
      cached.busy = true;
    }
    scratch.db.exec('BEGIN;UPDATE sources SET seen=0');
    const counts: IntakeReportQueueCounts = {
        pending: 0,
        deferred: 0,
        blocked: 0,
        accepted: 0,
        keptOriginal: 0,
        superseded: 0,
        questions: 0,
      },
      peopleCounts = { pending: 0, later: 0, excluded: 0, saved: 0 },
      kindCounts = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<
        IntakeImportFeedKind,
        number
      >;
    let totalRecords = 0,
      totalPeopleGroups = 0;
    const forgetPeopleMatch = (intakeId: string, ordinal: number) => {
      const old = scratch.db
        .prepare('SELECT * FROM peopleMatches WHERE intake=? AND ordinal=?')
        .get(intakeId, ordinal);
      if (!old) return;
      const previous = JSON.parse(String(old.counts)) as typeof peopleCounts;
      for (const state of Object.keys(peopleCounts) as (keyof typeof peopleCounts)[])
        peopleCounts[state] -= previous[state];
      kindCounts.person -= Number(old.visible);
      scratch.db.prepare('DELETE FROM people WHERE ordering=?').run(old.ordering);
      scratch.db
        .prepare('DELETE FROM peopleMatches WHERE intake=? AND ordinal=?')
        .run(intakeId, ordinal);
    };
    const visitPeople = (
      pointer: CollectionReportQueueGroupPointer & { intakeId: string },
      ordering: string,
    ) => {
      const matching = { pending: 0, later: 0, excluded: 0, saved: 0 },
        people = openCollectionPeopleRead(db, root, profileId, pointer.intakeId);
      let visible = 0;
      for (const person of people.pointers(pointer.groupId)) {
        if (query && !collectionPersonMatchesQuery(db, people.person(person), query)) continue;
        const state = people.state(person);
        matching[state]++;
        if (view === 'all' || state === (view === 'active' ? 'pending' : 'later')) visible++;
      }
      for (const state of Object.keys(peopleCounts) as (keyof typeof peopleCounts)[])
        peopleCounts[state] += matching[state];
      kindCounts.person += visible;
      if (query)
        scratch.db
          .prepare('INSERT INTO peopleMatches VALUES(?,?,?,?,?)')
          .run(pointer.intakeId, pointer.ordinal, ordering, JSON.stringify(matching), visible);
      return visible;
    };
    const visitMember = (
      pointer: CollectionReportQueueGroupPointer & { intakeId: string },
      summary: CollectionReportGroupSummary,
      member: CollectionReportQueueMember,
      groupOrder: string,
      groupReference: CollectionReportGroupReference,
    ) => {
      const facts = queue.memberFacts(pointer.intakeId, member);
      if (!facts) throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report summary');
      const order =
        groupOrder +
        ':' +
        String(member.memberOrder).padStart(16, '0') +
        ':' +
        canonicalLiteral([member.candidateId, member.candidateVersionId]);
      for (const key of Object.keys(counts) as (keyof typeof counts)[])
        counts[key] += facts.counts[key];
      let factKind: IntakeImportFeedKind | null = null,
        included = false;
      try {
        withIntakeWork(db, 'warm', () => recordIntakeWork('collectionFeedReviewedRecords'));
        if (
          (view !== 'all' && member.state !== (view === 'active' ? 'pending' : 'deferred')) ||
          (input.state && input.state !== member.state)
        )
          return;
        const {
            version,
            reviewToken,
            recordBytes,
            record: raw,
            ordinal,
            certificate,
          } = queue.reviewMember(pointer.intakeId, member),
          kind = feedKind(raw);
        if (
          (input.recordId && raw.id !== input.recordId) ||
          (input.edited === 'true' && !raw.manuallyEdited)
        )
          return;
        if (query) {
          const matcher = intakeFeedTextMatcher(query);
          let separated = false;
          const add = (value: unknown) => {
            if (!value) return;
            if (separated) matcher.push(' ');
            separated = true;
            if (
              typeof value === 'object' &&
              (value as IntakeReviewFragmentReference).format === 'health-intake-review-fragment-v1'
            ) {
              const reference = value as IntakeReviewFragmentReference,
                reader = openIntakeCollectionEnvelope(db, { id: pointer.intakeId });
              if (canonicalLiteral(reader.logical) !== canonicalLiteral(reference.logical))
                throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Report evidence changed');
              const record = reader.resolve(reference.address);
              hashSourceScalar(
                db,
                reference.field
                  ? reader.fieldChunks(record, reference.field)
                  : reader.recordChunks(record),
                [],
                (unit) => matcher.push(unit),
              );
            } else matcher.push(String(value));
          };
          for (const value of [
            raw.title,
            summary.title,
            summary.source,
            summary.original.filename,
            summary.member?.filename,
            ...Object.values(raw.mapping).filter((value) => typeof value === 'string'),
          ])
            add(value);
          if (!matcher.finish()) return;
        }
        factKind = kind;
        kindCounts[kind]++;
        if (input.kind && input.kind !== kind) return;
        included = true;
        totalRecords++;
        scratch.db
          .prepare('INSERT OR IGNORE INTO matches VALUES(?,?)')
          .run(pointer.intakeId, pointer.groupId);
        const record: IntakeImportFeedRecord = {
            ...raw,
            feedKind: kind,
            feedKey: canonicalLiteral([
              pointer.intakeId,
              member.candidateId,
              member.candidateVersionId,
            ]),
            feedOrder: order,
            manuallyEdited: raw.manuallyEdited === true,
          },
          base = {
            intakeId: pointer.intakeId,
            groupId: pointer.groupId,
            groupOrdinal: pointer.ordinal,
            proposalId: member.proposalId,
            intakeVersion: version,
            reviewToken: reviewToken,
            feedKind: kind,
            feedKey: record.feedKey,
            feedOrder: order,
            manuallyEdited: record.manuallyEdited,
          };
        let row: CollectionFeedRecord = { ...base, detail: { kind: 'record', record } };
        if (Buffer.byteLength(canonicalLiteral(row)) > budget)
          row = {
            ...base,
            detail: {
              kind: 'reference',
              selection: { recordId: record.id, candidateVersionId: record.candidateVersionId },
              reference: {
                format: 'health-intake-clinical-review-reference-v2',
                reviewToken: reviewToken,
                section: 'records',
                ordinal,
                bytes: recordBytes,
              },
            },
          };
        const encoded = canonicalLiteral(row),
          groupEncoded = canonicalLiteral(groupReference),
          memberEncoded = JSON.stringify({ member, certificate } satisfies CachedFeedMember);
        scratch.db
          .prepare('INSERT INTO records VALUES(?,?,?,?,?,?)')
          .run(
            order,
            encoded,
            groupEncoded,
            pointer.intakeId,
            memberEncoded,
            feedRowSignature(
              db,
              signingKey,
              order,
              encoded,
              groupEncoded,
              pointer.intakeId,
              memberEncoded,
            ),
          );
      } finally {
        scratch.db
          .prepare('INSERT OR REPLACE INTO facts VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            pointer.intakeId,
            pointer.ordinal,
            member.candidateId,
            member.candidateVersionId,
            order,
            pointer.groupId,
            JSON.stringify(facts.counts),
            factKind,
            included ? 1 : 0,
          );
      }
    };
    for (const source of queue.sources()) {
      const prior = scratch.db.prepare('SELECT * FROM sources WHERE id=?').get(source.id);
      const sourceGrounding = queue.groundingStamp(source.id);
      scratch.db.prepare('UPDATE sources SET seen=1 WHERE id=?').run(source.id);
      if (
        prior?.pin === source.pin &&
        prior.grounding === sourceGrounding &&
        cached?.clinicalRevision === queue.clinicalRevision
      )
        continue;
      withIntakeWork(db, 'warm', () => recordIntakeWork('collectionFeedRebuiltSources'));
      const old = prior
          ? (JSON.parse(String(prior.pin)) as ReturnType<typeof intakeSourceVersion>)
          : undefined,
        current = JSON.parse(source.pin) as ReturnType<typeof intakeSourceVersion>,
        effects =
          old?.logicalBinding &&
          current.logicalBinding &&
          cached?.clinicalRevision === queue.clinicalRevision &&
          prior?.grounding === sourceGrounding &&
          canonicalLiteral(old.sourcePin) === canonicalLiteral(current.sourcePin)
            ? collectionQueueTransitionEffects(
                db,
                source.id,
                JSON.parse(old.logicalBinding),
                JSON.parse(current.logicalBinding),
              )
            : undefined;
      let narrow = !!effects;
      scratch.db.exec('DELETE FROM changedCandidates;DELETE FROM changedGroups');
      if (effects)
        for (const effect of effects) {
          if (effect.kind === 'proposal') continue;
          if (effect.kind === 'group') {
            const value = JSON.parse(effect.value) as { groupAddress: string },
              reader = openIntakeCollectionEnvelope(db, { id: source.id }),
              ordinal = intakeEnvelopeRecordOrder(reader, reader.resolve(value.groupAddress)).at(
                -1,
              )!;
            scratch.db.prepare('INSERT OR IGNORE INTO changedGroups VALUES(?)').run(ordinal);
            for (const member of queue.members(source.id, ordinal))
              scratch.db
                .prepare('INSERT OR IGNORE INTO changedCandidates VALUES(?,?)')
                .run(member.candidateId, '');
            for (const row of scratch.db
              .prepare('SELECT candidate FROM facts WHERE intake=? AND groupOrdinal=?')
              .iterate(source.id, ordinal))
              scratch.db
                .prepare('INSERT OR IGNORE INTO changedCandidates VALUES(?,?)')
                .run(row.candidate, '');
            continue;
          }
          if (effect.kind !== 'candidate') {
            narrow = false;
            continue;
          }
          // A candidate fallback label also participates in its historical versions' search text.
          scratch.db
            .prepare('INSERT OR IGNORE INTO changedCandidates VALUES(?,?)')
            .run(effect.key, '');
        }
      if (narrow && prior) {
        Object.assign(counts, JSON.parse(String(prior.counts)));
        Object.assign(peopleCounts, JSON.parse(String(prior.peopleCounts)));
        Object.assign(kindCounts, JSON.parse(String(prior.kindCounts)));
        totalRecords = Number(prior.totalRecords);
        totalPeopleGroups = Number(prior.totalPeopleGroups);
        const peopleChanged = !!scratch.db.prepare('SELECT 1 FROM changedGroups LIMIT 1').get();
        scratch.db
          .prepare(
            'INSERT OR IGNORE INTO changedGroups SELECT DISTINCT f.groupOrdinal FROM facts f JOIN changedCandidates c ON c.id=f.candidate WHERE f.intake=?',
          )
          .run(source.id);
        for (const changedGroup of scratch.db
          .prepare('SELECT ordinal FROM changedGroups')
          .iterate()) {
          if (peopleChanged && query) forgetPeopleMatch(source.id, Number(changedGroup.ordinal));
          const pointer = queue.groupPointer(source.id, Number(changedGroup.ordinal));
          if (
            !pointer ||
            (input.groupId && input.groupId !== pointer.groupId) ||
            (input.intakeId && input.intakeId !== source.id)
          )
            continue;
          const summary = await collectionReportGroupSummary(db, root, profileId, queue, pointer),
            order =
              pointer.order +
              ':' +
              pointer.intakeId +
              ':' +
              String(pointer.ordinal).padStart(16, '0'),
            reference: CollectionReportGroupReference = {
              format: 'health-intake-report-group-reference-v2',
              binding: queue.binding,
              intakeId: source.id,
              groupId: pointer.groupId,
              ordinal: pointer.ordinal,
              bytes: Buffer.byteLength(canonicalLiteral(summary)),
            },
            visible =
              query && peopleChanged
                ? visitPeople(pointer, order)
                : view === 'all'
                  ? Object.values(summary.peopleCounts).reduce((a, b) => a + b, 0)
                  : summary.peopleCounts[view === 'active' ? 'pending' : 'later'];
          if (!peopleChanged) continue;
          scratch.db.prepare('DELETE FROM people WHERE ordering=?').run(order);
          if (visible)
            scratch.db
              .prepare('INSERT INTO people VALUES(?,?,?)')
              .run(order, canonicalLiteral(reference), source.id);
        }
        if (peopleChanged) {
          if (!query) {
            Object.assign(
              peopleCounts,
              !input.intakeId || input.intakeId === source.id
                ? queue.allPeopleCounts(source.id, input.groupId)
                : { pending: 0, later: 0, excluded: 0, saved: 0 },
            );
            kindCounts.person =
              view === 'all'
                ? Object.values(peopleCounts).reduce((a, b) => a + b, 0)
                : peopleCounts[view === 'active' ? 'pending' : 'later'];
          }
          totalPeopleGroups = Number(
            scratch.db.prepare('SELECT count(*) n FROM people WHERE intake=?').get(source.id)!.n,
          );
        }
        for (const changed of scratch.db
          .prepare('SELECT id,version FROM changedCandidates')
          .iterate()) {
          for (const fact of scratch.db
            .prepare('SELECT * FROM facts WHERE intake=? AND candidate=?')
            .iterate(source.id, changed.id)) {
            const oldCounts = JSON.parse(String(fact.counts)) as IntakeReportQueueCounts;
            for (const key of Object.keys(counts) as (keyof typeof counts)[])
              counts[key] -= oldCounts[key];
            if (fact.kind !== null) kindCounts[String(fact.kind) as IntakeImportFeedKind]--;
            totalRecords -= Number(fact.included);
            scratch.db.prepare('DELETE FROM records WHERE ordering=?').run(fact.ordering);
          }
          scratch.db
            .prepare('DELETE FROM facts WHERE intake=? AND candidate=?')
            .run(source.id, changed.id);
          for (const { pointer, member } of queue.membersByCandidate(
            source.id,
            String(changed.id),
          )) {
            if (
              (input.groupId && input.groupId !== pointer.groupId) ||
              (input.intakeId && input.intakeId !== pointer.intakeId)
            )
              continue;
            const summary = await collectionReportGroupSummary(db, root, profileId, queue, pointer),
              groupOrder =
                pointer.order +
                ':' +
                pointer.intakeId +
                ':' +
                String(pointer.ordinal).padStart(16, '0'),
              groupReference: CollectionReportGroupReference = {
                format: 'health-intake-report-group-reference-v2',
                binding: queue.binding,
                intakeId: pointer.intakeId,
                groupId: pointer.groupId,
                ordinal: pointer.ordinal,
                bytes: Buffer.byteLength(canonicalLiteral(summary)),
              };
            visitMember(pointer, summary, member, groupOrder, groupReference);
          }
        }
        scratch.db
          .prepare(
            'DELETE FROM matches WHERE intake=? AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.intake=matches.intake AND f.groupId=matches.groupId AND included=1)',
          )
          .run(source.id);
        scratch.db
          .prepare(
            'UPDATE sources SET pin=?,counts=?,kindCounts=?,totalRecords=?,peopleCounts=?,totalPeopleGroups=?,grounding=? WHERE id=?',
          )
          .run(
            source.pin,
            JSON.stringify(counts),
            JSON.stringify(kindCounts),
            totalRecords,
            JSON.stringify(peopleCounts),
            totalPeopleGroups,
            queue.groundingStamp(source.id),
            source.id,
          );
        continue;
      }
      for (const table of ['records', 'people', 'matches', 'facts', 'peopleMatches'])
        scratch.db.prepare(`DELETE FROM ${table} WHERE intake=?`).run(source.id);
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
      for (const key of Object.keys(peopleCounts) as (keyof typeof peopleCounts)[])
        peopleCounts[key] = 0;
      for (const key of kinds) kindCounts[key] = 0;
      totalRecords = 0;
      totalPeopleGroups = 0;
      for (const pointer of queue.groups('all', source.id)) {
        if (
          (input.groupId && input.groupId !== pointer.groupId) ||
          (input.intakeId && input.intakeId !== pointer.intakeId)
        )
          continue;
        const summary = await collectionReportGroupSummary(db, root, profileId, queue, pointer),
          groupOrder =
            pointer.order +
            ':' +
            pointer.intakeId +
            ':' +
            String(pointer.ordinal).padStart(16, '0'),
          groupReference: CollectionReportGroupReference = {
            format: 'health-intake-report-group-reference-v2',
            binding: queue.binding,
            intakeId: pointer.intakeId,
            groupId: pointer.groupId,
            ordinal: pointer.ordinal,
            bytes: Buffer.byteLength(canonicalLiteral(summary)),
          };
        const visiblePeople = visitPeople(pointer, groupOrder);
        if (visiblePeople) {
          totalPeopleGroups++;
          scratch.db
            .prepare('INSERT INTO people VALUES(?,?,?)')
            .run(groupOrder, canonicalLiteral(groupReference), source.id);
        }
        for (const member of queue.members(pointer.intakeId, pointer.ordinal)) {
          visitMember(pointer, summary, member, groupOrder, groupReference);
        }
      }
      scratch.db
        .prepare('INSERT OR REPLACE INTO sources VALUES(?,?,1,?,?,?,?,?,?)')
        .run(
          source.id,
          source.pin,
          JSON.stringify(counts),
          JSON.stringify(peopleCounts),
          JSON.stringify(kindCounts),
          totalRecords,
          totalPeopleGroups,
          queue.groundingStamp(source.id),
        );
    }
    for (const row of scratch.db.prepare('SELECT id FROM sources WHERE seen=0').iterate())
      for (const table of ['records', 'people', 'matches', 'facts', 'peopleMatches'])
        scratch.db.prepare(`DELETE FROM ${table} WHERE intake=?`).run(row.id);
    scratch.db.exec('DELETE FROM sources WHERE seen=0');
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    for (const key of Object.keys(peopleCounts) as (keyof typeof peopleCounts)[])
      peopleCounts[key] = 0;
    for (const key of kinds) kindCounts[key] = 0;
    totalRecords = 0;
    totalPeopleGroups = 0;
    for (const row of scratch.db
      .prepare('SELECT counts,peopleCounts,kindCounts,totalRecords,totalPeopleGroups FROM sources')
      .iterate()) {
      const c = JSON.parse(String(row.counts)),
        p = JSON.parse(String(row.peopleCounts)),
        k = JSON.parse(String(row.kindCounts));
      for (const key of Object.keys(counts) as (keyof typeof counts)[])
        counts[key] += Number(c[key]);
      for (const key of Object.keys(peopleCounts) as (keyof typeof peopleCounts)[])
        peopleCounts[key] += Number(p[key]);
      for (const key of kinds) kindCounts[key] += Number(k[key]);
      totalRecords += Number(row.totalRecords);
      totalPeopleGroups += Number(row.totalPeopleGroups);
    }
    queue.assertCurrent();
    if (identityGroundingGeneration(db) !== grounding)
      throw new HttpError(
        409,
        'REPORT_QUEUE_CURSOR',
        'Review changed while preparing; refresh this feed',
      );
    if (journalActivityBinding(root, profileId) !== activityPin)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Reading activity changed');
    if ((feedEpochs.get(db) || 0) !== epoch)
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this import feed');
    const feed: PreparedFeed = {
      db,
      key: cacheKey,
      binding: queue.binding,
      clinicalRevision: queue.clinicalRevision,
      grounding,
      busy: false,
      scratch,
      signingKey,
      counts,
      kindCounts,
      peopleCounts,
      totalRecords,
      totalPeopleGroups,
      totalGroups: Number(
        scratch.db.prepare('SELECT count(DISTINCT groupId) AS n FROM matches').get()!.n,
      ),
      used: ++feedClock,
    };
    scratch.db.exec('COMMIT');
    if (reused) preparedFeeds.delete(reused);
    while (preparedFeeds.size >= 4) {
      let oldest: PreparedFeed | undefined;
      for (const prior of preparedFeeds)
        if (!prior.busy && (!oldest || prior.used < oldest.used)) oldest = prior;
      if (!oldest)
        throw new HttpError(
          503,
          'REPORT_QUEUE_BUSY',
          'Other feed windows are active; retry this window',
        );
      disposeFeed(oldest!);
    }
    preparedFeeds.add(feed);
    retained = true;
    readingFeed = feed;
    const result = feedWindow(db, root, profileId, queue, feed, {
      view,
      limit,
      budget,
      after,
      peopleAfter,
      cursor,
    });
    successfulRead = true;
    return result;
  } catch (error) {
    if (readingFeed) disposeFeed(readingFeed);
    try {
      scratch.db.exec('ROLLBACK');
    } catch {
      /* The read failed before or after the private transaction. */
    }
    throw error;
  } finally {
    if (reused) reused.busy = false;
    queue.close({ retainReview: successfulRead });
    if (!retained) {
      scratch.close();
      signingKey.fill(0);
    }
  }
}
