import { hasIntakeCollectionEnvelope } from './intake-collection-envelope.ts';
/** Complete selected report membership traversal for native clinical record queues. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { HttpError, clinicalReviewRevision } from './database.ts';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  intakeReviewChildren,
  readIntakeReviewValue,
  IntakeReviewFragmentRequired,
} from './intake-review-collection.ts';
import { prepareCollectionClinicalReview } from './intake-review-collection-host.ts';
import type { IntakeClinicalReviewReference } from './intake-review-collection-session.ts';
import { reviewedIntakeQueueRecord } from './intake-report-queue.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type {
  IntakeReportQueueRecordState,
  IntakeReportQueueRecord,
  IntakeReportQueueView,
} from '../shared/intake.ts';
import type { openCollectionReportQueue } from './intake-report-group-collection.ts';

export interface CollectionReportQueueMember {
  groupOrdinal: number;
  groupId: string;
  groupOrder: string;
  memberOrder: number;
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  state: IntakeReportQueueRecordState;
}
export interface CollectionReportQueueGroupPointer {
  ordinal: number;
  groupId: string;
  order: string;
  basis: string;
  address: string | null;
  /** First-introduction order spans across retained report versions. */
  memberSpan?: number;
}
/** Refresh an existing owned membership without traversing unrelated candidates/history. */
export function currentCollectionReportQueueMember(
  db: DatabaseSync,
  profileId: string,
  intakeId: string,
  member: CollectionReportQueueMember,
): CollectionReportQueueMember | null {
  assertIntakeOwner(db, profileId);
  const view = openIntakeCollectionEnvelope(db, { id: intakeId }),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  if (!workflow) return null;
  const field = <T>(record: IntakeEnvelopeRecord, name: string): T | undefined => {
    const value = view.field(record, name, { bytes: 16384 });
    if (value.kind === 'fragmented')
      throw new HttpError(
        409,
        'REPORT_REFERENCE_UNAVAILABLE',
        'The selected queue field requires preparation',
      );
    return value.kind === 'value' ? (value.value as T) : undefined;
  };
  const candidate = view.find('candidate', workflow, member.candidateId, { match: 'last' }),
    version = candidate && view.find('version', candidate, member.candidateVersionId);
  if (!candidate || !version || field(version, 'sourceContext') || field(version, 'peopleOnly'))
    return null;
  const draft = view.childCount(workflow, 'reviewDrafts')
    ? view.lookup('draft-candidate-version-last', [
        JSON.stringify(member.candidateId),
        member.candidateVersionId,
      ])
    : undefined;
  let occurrence = draft
    ? view.lookup('version-occurrence-last', [
        view.address(version),
        JSON.stringify(field(draft, 'proposalId') ?? null),
        field<string>(draft, 'recordId')!,
      ])
    : undefined;
  occurrence ??= view.childCount(version, 'occurrences')
    ? view.childAt(version, 'occurrences', view.childCount(version, 'occurrences') - 1)
    : undefined;
  if (!occurrence) return null;
  const accepted =
    field(version, 'status') === 'accepted' ||
    !!(
      view.childCount(workflow, 'decisions') &&
      view.lookup('accepted-candidate-version', [
        JSON.stringify(member.candidateId),
        member.candidateVersionId,
      ])
    );
  const latest = view.childAt(candidate, 'versions', view.childCount(candidate, 'versions') - 1)!;
  return {
    ...member,
    proposalId: field<string | null>(occurrence, 'proposalId') ?? null,
    recordId: field<string>(occurrence, 'recordId')!,
    state: accepted
      ? 'accepted'
      : field(version, 'status') === 'kept_original'
        ? 'kept_original'
        : field(version, 'status') === 'superseded' ||
            field(latest, 'id') !== member.candidateVersionId
          ? 'superseded'
          : draft && field(draft, 'disposition') === 'review_later'
            ? 'deferred'
            : 'pending',
  };
}
/** Returns every historical owned candidate/version exactly once per report group. */
export function* collectionReportQueueMembers(
  db: DatabaseSync,
  profileId: string,
  intakeId: string,
  onGroup?: (group: CollectionReportQueueGroupPointer) => void,
): Generator<CollectionReportQueueMember> {
  assertIntakeOwner(db, profileId);
  const file = db
    .prepare(
      "SELECT id,sha256,kind,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(intakeId) as
    { id: string; sha256: string; kind: string; details_json: string } | undefined;
  if (!file) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  if (!hasIntakeCollectionEnvelope(db, file))
    throw new HttpError(
      409,
      'INTAKE_REVIEW_PENDING_MIGRATION',
      'Prepare this retained intake for selected report review',
    );
  const view = openIntakeCollectionEnvelope(db, file),
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!intake) throw Error('Missing selected intake');
  if (!workflow) return;
  const catalog = createReportSnapshotCatalog(db, file);
  const children = (record: IntakeEnvelopeRecord | undefined, field: string) =>
    intakeReviewChildren(view, record, field);
  const value = <T>(record: IntakeEnvelopeRecord, field: string): T | undefined => {
    const child = view.child(record, field);
    if (child) return readIntakeReviewValue<T>(view, child, 256 * 1024);
    const result = view.field(record, field, { bytes: 256 * 1024 });
    if (result.kind === 'fragmented')
      throw new IntakeReviewFragmentRequired({
        format: 'health-intake-review-fragment-v1',
        logical: view.logical,
        address: view.address(record),
        field,
      });
    return result.kind === 'value' ? (result.value as T) : undefined;
  };
  const scratch = disposableSqlite('circus-native-report-members-');
  try {
    const cache = scratch.db;
    cache.exec(
      'CREATE TABLE groups(ordinal INTEGER PRIMARY KEY,id TEXT NOT NULL,basis TEXT NOT NULL,ordering TEXT NOT NULL,address TEXT,span INTEGER);CREATE TABLE members(groupOrdinal INTEGER,candidate TEXT,version TEXT,ordering TEXT,PRIMARY KEY(groupOrdinal,candidate,version));CREATE TABLE owners(candidate TEXT,version TEXT,groupId TEXT,PRIMARY KEY(candidate,version));CREATE INDEX byCandidateVersion ON members(candidate,version);',
    );
    const groupInsert = cache.prepare('INSERT INTO groups VALUES(?,?,?,?,?,?)'),
      memberInsert = cache.prepare(
        'INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(groupOrdinal,candidate,version) DO UPDATE SET ordering=min(ordering,excluded.ordering)',
      );
    let ordinal = 0;
    for (const group of children(workflow, 'reportGroups')) {
      const id = value<string>(group, 'id')!,
        basis = value<string>(group, 'basis')!;
      const first = view.childAt(group, 'versions', 0);
      if (!first) continue;
      const discovery = value<number>(group, 'discoveryOrder');
      const order =
        discovery === undefined
          ? `0:${value(first, 'createdAt')}:${intakeId}:${String(ordinal).padStart(12, '0')}:${id}`
          : `1:${String(discovery).padStart(20, '0')}:${id}`;
      groupInsert.run(ordinal, id, basis, order, view.address(group), 0);
      let memberOrdinal = 0;
      for (const version of children(group, 'versions')) {
        if (value(version, 'format') === 'health-intake-report-group-version-v2') {
          const snapshot = openReportMemberSnapshot(
            catalog,
            value<IntakeReportMembersReference>(version, 'members')!,
          );
          for (let i = 0; i < snapshot.reference.memberCount; i++) {
            const member = snapshot.memberAt(i)!;
            memberInsert.run(
              ordinal,
              member.candidateId,
              member.candidateVersionId,
              '1:' + String(memberOrdinal++).padStart(16, '0'),
            );
          }
        } else
          for (const member of children(version, 'members'))
            memberInsert.run(
              ordinal,
              value<string>(member, 'candidateId')!,
              value<string>(member, 'candidateVersionId')!,
              '1:' + String(memberOrdinal++).padStart(16, '0'),
            );
      }
      cache.prepare('UPDATE groups SET span=? WHERE ordinal=?').run(memberOrdinal, ordinal);
      ordinal++;
    }
    // The legacy fallback covers versions absent from retained groups, including duplicate IDs.
    cache.exec(
      'CREATE TABLE retainedMembership AS SELECT DISTINCT candidate,version FROM members;CREATE UNIQUE INDEX retainedKey ON retainedMembership(candidate,version);',
    );
    let candidateOrdinal = 0;
    for (const candidate of children(workflow, 'candidates')) {
      const candidateId = value<string>(candidate, 'id')!;
      const id =
        'report-group:' +
        createHash('sha256')
          .update(canonicalLiteral(['candidate', candidateId]))
          .digest('hex');
      let versionOrdinal = 0,
        firstFallback = true;
      for (const version of children(candidate, 'versions')) {
        const versionId = value<string>(version, 'id')!;
        if (
          value(version, 'sourceContext') ||
          cache
            .prepare('SELECT 1 FROM retainedMembership WHERE candidate=? AND version=?')
            .get(candidateId, versionId)
        ) {
          versionOrdinal++;
          continue;
        }
        let group = cache
          .prepare('SELECT ordinal FROM groups WHERE id=? ORDER BY ordinal LIMIT 1')
          .get(id);
        if (!group) {
          group = { ordinal };
          groupInsert.run(
            ordinal,
            id,
            'candidate_fallback',
            `0:${value(version, 'createdAt')}:${intakeId}:${String(ordinal).padStart(12, '0')}:${id}`,
            null,
            0,
          );
          ordinal++;
        }
        if (firstFallback) {
          cache
            .prepare("UPDATE groups SET ordering=? WHERE ordinal=? AND ordering LIKE '0:%'")
            .run(
              `0:${value(version, 'createdAt')}:${intakeId}:${String(group.ordinal).padStart(12, '0')}:${id}`,
              Number(group.ordinal),
            );
          firstFallback = false;
        }
        cache.prepare('UPDATE groups SET span=-1 WHERE ordinal=?').run(Number(group.ordinal));
        // Later duplicate candidates prepend versions before earlier fallback members.
        memberInsert.run(
          Number(group.ordinal),
          candidateId,
          versionId,
          '0:' +
            String(Number.MAX_SAFE_INTEGER - candidateOrdinal).padStart(16, '0') +
            ':' +
            String(versionOrdinal).padStart(16, '0'),
        );
        versionOrdinal++;
      }
      candidateOrdinal++;
    }
    // Anchor ownership takes precedence over fallback; each pass retains last matching group.
    const owner = cache.prepare(
      'INSERT INTO owners VALUES(?,?,?) ON CONFLICT(candidate,version) DO UPDATE SET groupId=excluded.groupId',
    );
    for (const basis of ['candidate_fallback', 'report_anchor'])
      for (const row of cache
        .prepare(
          'SELECT m.candidate,m.version,g.id FROM groups g JOIN members m ON m.groupOrdinal=g.ordinal WHERE g.basis=? ORDER BY g.ordinal,m.ordering',
        )
        .iterate(basis))
        owner.run(String(row.candidate), String(row.version), String(row.id));
    if (onGroup)
      for (const group of cache
        .prepare(
          'SELECT ordinal,id,basis,ordering,address,span FROM groups ORDER BY ordering,ordinal',
        )
        .iterate())
        onGroup({
          ordinal: Number(group.ordinal),
          groupId: String(group.id),
          order: String(group.ordering),
          basis: String(group.basis),
          address: group.address === null ? null : String(group.address),
          memberSpan: Number(group.span),
        });
    let previousGroup = -1,
      memberOrder = 0;
    for (const row of cache
      .prepare(
        'SELECT g.ordinal,g.id,g.ordering,m.candidate,m.version,m.ordering AS memberOrdering,g.span FROM groups g JOIN members m ON m.groupOrdinal=g.ordinal JOIN owners o ON o.candidate=m.candidate AND o.version=m.version AND o.groupId=g.id ORDER BY g.ordering,g.ordinal,m.ordering',
      )
      .iterate()) {
      const candidateId = String(row.candidate),
        versionId = String(row.version);
      const candidate = view.find('candidate', workflow, candidateId, { match: 'last' }),
        version = candidate && view.find('version', candidate, versionId);
      if (!candidate || !version || value(version, 'sourceContext') || value(version, 'peopleOnly'))
        continue;
      const draft = view.childCount(workflow, 'reviewDrafts')
        ? view.lookup('draft-candidate-version-last', [JSON.stringify(candidateId), versionId])
        : undefined;
      let occurrence: IntakeEnvelopeRecord | undefined;
      const count = view.childCount(version, 'occurrences');
      if (draft)
        occurrence = view.lookup('version-occurrence-last', [
          view.address(version),
          JSON.stringify(value(draft, 'proposalId') ?? null),
          value<string>(draft, 'recordId')!,
        ]);
      occurrence ??= count ? view.childAt(version, 'occurrences', count - 1) : undefined;
      if (!occurrence) continue;
      let accepted = value(version, 'status') === 'accepted';
      if (!accepted && view.childCount(workflow, 'decisions'))
        accepted = !!view.lookup('accepted-candidate-version', [
          JSON.stringify(candidateId),
          versionId,
        ]);
      const latest = view.childAt(
        candidate,
        'versions',
        view.childCount(candidate, 'versions') - 1,
      )!;
      const state: IntakeReportQueueRecordState = accepted
        ? 'accepted'
        : value(version, 'status') === 'kept_original'
          ? 'kept_original'
          : value(version, 'status') === 'superseded' || value(latest, 'id') !== versionId
            ? 'superseded'
            : draft && value(draft, 'disposition') === 'review_later'
              ? 'deferred'
              : 'pending';
      if (previousGroup !== Number(row.ordinal)) {
        previousGroup = Number(row.ordinal);
        memberOrder = 0;
      }
      yield {
        groupOrdinal: Number(row.ordinal),
        groupId: String(row.id),
        groupOrder: String(row.ordering),
        memberOrder:
          Number(row.span) >= 0 && String(row.memberOrdering).startsWith('1:')
            ? Number(String(row.memberOrdering).slice(2))
            : memberOrder++,
        candidateId,
        candidateVersionId: versionId,
        proposalId: value<string | null>(occurrence, 'proposalId') ?? null,
        recordId: value<string>(occurrence, 'recordId')!,
        state,
      };
    }
  } finally {
    scratch.close();
  }
}

export interface CollectionIntakeReportRecordPage {
  format: 'health-intake-report-record-page-v2';
  intakeId: string;
  version: number;
  /** Clinical records only. People and reading activity retain their own selected read contracts. */
  scope: 'clinical_records';
  view: IntakeReportQueueView;
  records: ({
    groupId: string;
    proposalId: string | null;
    reviewToken: string;
    queueState: IntakeReportQueueRecordState;
    selectable: boolean;
  } & (
    | { kind: 'record'; record: IntakeReportQueueRecord }
    | {
        kind: 'record_reference';
        reference: IntakeClinicalReviewReference;
        selection: { recordId: string; candidateVersionId?: string };
      }
  ))[];
  totalRecords: number;
  nextCursor: string | null;
}
/** Native report-detail/import record slice; every row is enriched from its COMPLETE bounded proposal. */
export function readCollectionIntakeReportRecords(
  db: DatabaseSync,
  root: string,
  profileId: string,
  intakeId: string,
  input: {
    groupId?: string;
    view?: IntakeReportQueueView;
    cursor?: string;
    limit?: number;
    bytes?: number;
  } = {},
  queue?: Awaited<ReturnType<typeof openCollectionReportQueue>>,
): CollectionIntakeReportRecordPage {
  assertIntakeOwner(db, profileId);
  const view = input.view || 'active',
    limit = input.limit ?? 50,
    byteBudget = input.bytes ?? 128 * 1024;
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 1024 || byteBudget > 256 * 1024)
    throw new HttpError(
      400,
      'REPORT_QUEUE_WINDOW',
      'Choose a report byte budget from 1024 to 262144',
    );
  if (
    !['active', 'deferred', 'all'].includes(view) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new HttpError(
      400,
      'REPORT_QUEUE_WINDOW',
      'Choose an active, deferred or all report window from 1 to 100',
    );
  const source = db
    .prepare(
      "SELECT id,sha256,kind,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(intakeId) as
    { id: string; sha256: string; kind: string; details_json: string } | undefined;
  if (!source) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  if (!hasIntakeCollectionEnvelope(db, source))
    throw new HttpError(
      409,
      'INTAKE_REVIEW_PENDING_MIGRATION',
      'Prepare this retained intake for selected report review',
    );
  const binding = intakeSourceVersion(db, intakeId),
    policy = clinicalReviewRevision(db),
    query = JSON.stringify([
      profileId,
      intakeId,
      binding.logicalBinding,
      binding.version,
      policy,
      input.groupId || null,
      view,
    ]);
  let after = '';
  if (input.cursor) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 2 ||
      cursor[0] !== query ||
      typeof cursor[1] !== 'string'
    )
      throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
    after = cursor[1];
  }
  const records: CollectionIntakeReportRecordPage['records'] = [];
  const window = queue?.recordMemberWindow(intakeId, {
    groupId: input.groupId,
    view,
    after,
    limit: limit + 1,
  });
  let totalRecords = window?.totalRecords ?? 0,
    last = '',
    remaining = false,
    usedBytes = 0,
    pageFull = false;
  // Keep at most one complete bounded proposal review; never one full review per package member.
  let cachedProposal: string | null | undefined,
    cached: ReturnType<typeof prepareCollectionClinicalReview> | undefined;
  for (const member of window
    ? window.members()
    : collectionReportQueueMembers(db, profileId, intakeId)) {
    if (input.groupId && member.groupId !== input.groupId) continue;
    if (view !== 'all' && member.state !== (view === 'active' ? 'pending' : 'deferred')) continue;
    if (!window) totalRecords++;
    const order =
      member.groupOrder +
      ':' +
      String(member.groupOrdinal).padStart(12, '0') +
      ':' +
      String(member.memberOrder).padStart(12, '0') +
      ':' +
      JSON.stringify([member.candidateId, member.candidateVersionId]);
    if (order <= after) continue;
    if (pageFull || records.length >= limit) {
      remaining = true;
      continue;
    }
    if (!cached || cachedProposal !== member.proposalId) {
      cached = prepareCollectionClinicalReview(db, root, profileId, intakeId, member.proposalId);
      cachedProposal = member.proposalId;
    }
    if (cached.status !== 'ready') throw new IntakeReviewFragmentRequired(cached.reference);
    const record = cached.session.record(
      member.recordId,
      member.candidateId,
      member.candidateVersionId,
    );
    if (!record)
      throw new HttpError(
        409,
        'REPORT_REFERENCE_UNAVAILABLE',
        'A report reference no longer matches its retained proposal; inspect the original',
      );
    const reviewed = reviewedIntakeQueueRecord(record, member.state),
      selectable = reviewed.selectable;
    const row = {
      groupId: member.groupId,
      proposalId: member.proposalId,
      reviewToken: cached.session.review.reviewToken,
      queueState: member.state,
      selectable,
    };
    const expanded: CollectionIntakeReportRecordPage['records'][number] = {
      ...row,
      kind: 'record',
      record: reviewed,
    };
    const cost = Buffer.byteLength(canonicalLiteral(expanded));
    const item: CollectionIntakeReportRecordPage['records'][number] =
      cost > byteBudget
        ? {
            ...row,
            kind: 'record_reference',
            selection: { recordId: record.id, candidateVersionId: record.candidateVersionId },
            reference: {
              format: 'health-intake-clinical-review-reference-v2',
              reviewToken: cached.session.review.reviewToken,
              section: 'records',
              ordinal: cached.session.review.records.indexOf(record),
              bytes: Buffer.byteLength(canonicalLiteral(record)),
            },
          }
        : expanded;
    const size = Buffer.byteLength(canonicalLiteral(item));
    if (records.length && usedBytes + size > byteBudget) {
      pageFull = true;
      remaining = true;
      continue;
    }
    records.push(item);
    usedBytes += size;
    last = order;
  }
  const current = intakeSourceVersion(db, intakeId);
  queue?.assertCurrent();
  if (
    current.logicalBinding !== binding.logicalBinding ||
    current.version !== binding.version ||
    clinicalReviewRevision(db) !== policy
  )
    throw new HttpError(409, 'REPORT_QUEUE_CURSOR', 'Refresh this report queue');
  return {
    format: 'health-intake-report-record-page-v2',
    scope: 'clinical_records',
    intakeId,
    version: binding.version,
    view,
    records,
    totalRecords,
    nextCursor: remaining ? Buffer.from(JSON.stringify([query, last])).toString('base64url') : null,
  };
}
