import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, HttpError } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { getNote, saveNote } from '../notes.ts';
import {
  uploadIntake,
  ensureNativeIntakeSchema,
  reviewIntakeRead,
  importIntakeRead,
  proposeConversionRead,
} from '../intake.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { collectionWorkflowReviewScope } from '../intake-review-collection.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { identityOriginalFingerprintForMember } from '../intake-identity-policy.ts';
import {
  retainSelectedIdentityGrounding,
  clearIdentityGrounding,
  identityGroundingGeneration,
} from '../intake-identity-grounding.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import {
  openCollectionReportQueue,
  collectionReportGroupSummary,
  clearCollectionReportQueues,
} from '../intake-report-group-collection.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import { clearCollectionImportFeeds } from '../intake-import-feed-collection.ts';
import { listIntakeImportFeedRead } from '../intake-queue-native.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';

const record = (id: string, date: string | null = '2026-01-01', report = id) => ({
  format: 'health-record-v1',
  id,
  kind: 'document',
  payload: { text: 'Fictional visit ' + id },
  provenance: {
    capturedVia: 'Fictional export',
    sourceSystem: 'Fictional clinic',
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
  clinical: {
    kind: 'document',
    subject: 'unknown',
    documentTitle: id,
    ...(date === null ? {} : { date }),
  },
  report: {
    key: report,
    title: 'Fictional report ' + report,
    anchor: { locator: 'page 1 heading', text: 'Fictional report ' + report },
    subject: { locator: 'page 1 patient', text: 'Patient: Fictional Iris Meadow' },
  },
});
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-grounding-review-')),
    profileId = 'fictional-profile',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const self = getNote(db, 'person-note:self');
  saveNote(db, self.id, {
    version: self.version,
    title: 'Fictional Iris Meadow',
    person: { ...self.person, fullName: 'Fictional Iris Meadow', birthDate: '1990-03-08' },
  });
  t.after(() => {
    clearIdentityGrounding(db);
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
const rawSqlStamp = (db: ReturnType<typeof openDatabase>) =>
  JSON.stringify([
    db.prepare('SELECT total_changes() AS changes').get()!.changes,
    db.prepare('PRAGMA data_version').get()!.data_version,
    db.prepare('PRAGMA schema_version').get()!.schema_version,
    db.prepare('PRAGMA temp.schema_version').get()!.schema_version,
  ]);
async function source(
  t: test.TestContext,
  entries: ReturnType<typeof record>[],
  existing?: ReturnType<typeof fixture>,
) {
  const f = existing || fixture(t);
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(entries.map((entry) => JSON.stringify(entry)).join('\n')),
  });
  await ensureNativeIntakeSchema(f.db, f.profileId, original.id);
  await prepareCollectionClinicalReviewDependencies(f.db, f.root, f.profileId, original.id);
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, original.id);
  const view = openIntakeCollectionEnvelope(f.db, { id: original.id }),
    workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
  const scope = collectionWorkflowReviewScope({
    view,
    catalog: createReportSnapshotCatalog(f.db, { id: original.id }),
    metadataBytes: 256 * 1024,
    packageEvidence: false,
    activeReceipt: () => true,
    originalFingerprint: (group) =>
      identityOriginalFingerprintForMember(original.id, original.sha256, group.memberId, undefined),
    reportSource: () => undefined,
  });
  assert.ok(scope.close);
  const closeScope = scope.close;
  t.after(() => closeScope());
  const groups = [];
  for (let n = 0; n < view.childCount(workflow, 'reportGroups'); n++)
    groups.push(scope.groupHeader(view.childAt(workflow, 'reportGroups', n)!));
  const ground = (n: number, subject = true) => {
    const currentView = openIntakeCollectionEnvelope(f.db, { id: original.id }),
      currentScope = collectionWorkflowReviewScope({
        view: currentView,
        catalog: createReportSnapshotCatalog(f.db, { id: original.id }),
        metadataBytes: 256 * 1024,
        packageEvidence: false,
        activeReceipt: () => true,
        originalFingerprint: (group) =>
          identityOriginalFingerprintForMember(
            original.id,
            original.sha256,
            group.memberId,
            undefined,
          ),
        reportSource: () => undefined,
      });
    assert.ok(currentScope.close);
    const closeCurrentScope = currentScope.close;
    try {
      const flow = currentView.child(currentView.child(currentView.root(), 'intake')!, 'workflow')!;
      retainSelectedIdentityGrounding(
        f.db,
        currentScope.groundingBoundary(f.profileId, original.id, original.sha256),
        currentScope.groupHeader(currentView.childAt(flow, 'reportGroups', n)!),
        [],
        subject,
        [],
        {
          dates: subject ? ['1990-03-08'] : [],
          unreadable: !subject,
        },
      );
    } finally {
      closeCurrentScope();
    }
  };
  const summary = async (n: number) => {
    const queue = await openCollectionReportQueue(f.db, f.root, f.profileId);
    try {
      const pointer = queue.groupPointer(original.id, n);
      assert.ok(pointer);
      return await collectionReportGroupSummary(f.db, f.root, f.profileId, queue, pointer);
    } finally {
      queue.close();
    }
  };
  const review = () => {
    const selected = prepareCollectionClinicalReview(f.db, f.root, f.profileId, original.id);
    assert.ok(selected.status === 'ready');
    t.after(() => selected.session.close());
    return selected.session;
  };
  return { ...f, original, ground, summary, review, groups };
}

// Repeated original-grounding publications verify fresh clinical records and exact selected-group counts under one host guard.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'second zero-question native grounding refreshes actual clinical records and selected group counts with unchanged SQL',
  { timeout: 90000 },
  async (t) => {
    const f = await source(t, [record('first'), record('second')]);
    assert.equal(f.groups.length, 2);
    f.ground(0);
    const held = f.review(),
      records = held.review.records;
    assert.equal(records.length, 2);
    assert.equal(records[0]!.identityReview?.blocking, false);
    assert.equal(records[1]!.identityReview?.blocking, true);
    const first = await f.summary(0),
      before = await f.summary(1);
    assert.equal(first.counts.blocked, 0);
    assert.equal(before.counts.blocked, 1);
    assert.equal(before.counts.questions, 1);
    const feed = async () => {
      const page = await listIntakeImportFeedRead(f.db, f.root, f.profileId, {
        view: 'active',
        state: 'pending',
        limit: '2',
        bytes: '65536',
      });
      assert.ok('format' in page && page.format === 'health-intake-import-feed-v2');
      return page;
    };
    const initialFeed = await feed();
    assert.equal(initialFeed.records.length, 2);
    assert.equal(initialFeed.counts.blocked, 1);
    assert.equal(initialFeed.counts.questions, 1);
    const sql = rawSqlStamp(f.db),
      stamp = reviewReadStamp(f.db),
      builds = intakeWorkCounters(f.db).warm.collectionQueueSummaryBuilds,
      rows = intakeWorkCounters(f.db).warm.collectionQueueMemberRows;
    f.ground(1);
    assert.equal(rawSqlStamp(f.db), sql);
    assert.notEqual(reviewReadStamp(f.db), stamp);
    assert.throws(
      () => held.record(records[1]!.id),
      (error) => error instanceof HttpError && error.code === 'INTAKE_REVIEW_CHANGED',
    );
    const refreshed = f.review().record(records[1]!.id)!;
    assert.equal(refreshed.identityReview?.blocking, false);
    const after = await f.summary(1);
    assert.equal(after.counts.blocked, 0);
    assert.equal(after.counts.questions, 0);
    assert.equal(intakeWorkCounters(f.db).warm.collectionQueueSummaryBuilds, builds + 1);
    const afterFeed = await feed();
    assert.equal(afterFeed.records.length, 2);
    assert.equal(afterFeed.counts.blocked, 0);
    assert.equal(afterFeed.counts.questions, 0);
    for (const row of afterFeed.records) {
      assert.equal(row.detail.kind, 'record');
      if (row.detail.kind === 'record') assert.equal(row.detail.record.selectable, true);
    }
    const feedBuilds = intakeWorkCounters(f.db).warm.collectionFeedRebuiltSources,
      summaryBuilds = intakeWorkCounters(f.db).warm.collectionQueueSummaryBuilds;
    assert.equal(
      intakeWorkCounters(f.db).warm.collectionQueueMemberRows,
      rows,
      'grounding performs no installation membership rebuild',
    );
    const generation = identityGroundingGeneration(f.db),
      identical = rawSqlStamp(f.db);
    f.ground(1);
    assert.equal(identityGroundingGeneration(f.db), generation);
    assert.equal(rawSqlStamp(f.db), identical);
    assert.deepEqual((await f.summary(1)).counts, after.counts);
    const identicalFeed = await feed();
    assert.deepEqual(identicalFeed.counts, afterFeed.counts);
    assert.equal(intakeWorkCounters(f.db).warm.collectionFeedRebuiltSources, feedBuilds);
    assert.equal(intakeWorkCounters(f.db).warm.collectionQueueSummaryBuilds, summaryBuilds);
    const page = await reviewIntakeRead(f.db, f.root, f.profileId, f.original.id, null, {
      items: 2,
      bytes: 65536,
    });
    assert.ok('format' in page && page.format === 'health-intake-clinical-review-page-v2');
    assert.equal(page.items.length, 2);
    const selected = page.items[1]!;
    assert.ok(selected.kind === 'value');
    assert.equal((selected.value as IntakeReviewRecord).identityReview?.blocking, false);
    const latest = f.review(),
      latestSql = rawSqlStamp(f.db);
    f.ground(1, false);
    assert.equal(rawSqlStamp(f.db), latestSql);
    assert.throws(
      () => latest.record(records[1]!.id),
      (error) => error instanceof HttpError && error.code === 'INTAKE_REVIEW_CHANGED',
    );
    assert.equal(f.review().record(records[1]!.id)!.identityReview?.blocking, true);
    assert.equal((await f.summary(1)).counts.blocked, 1);
    assert.equal((await f.summary(1)).counts.questions, 1);
    const negativeFeed = await feed();
    assert.equal(negativeFeed.counts.blocked, 1);
    assert.equal(negativeFeed.counts.questions, 1);
    const beforeClear = f.review(),
      clearSql = rawSqlStamp(f.db);
    clearIdentityGrounding(f.db);
    assert.equal(rawSqlStamp(f.db), clearSql);
    assert.throws(
      () => beforeClear.record(records[0]!.id),
      (error) => error instanceof HttpError && error.code === 'INTAKE_REVIEW_CHANGED',
    );
    assert.equal(f.review().record(records[0]!.id)!.identityReview?.blocking, true);
    assert.equal((await f.summary(0)).counts.blocked, 1);
    assert.equal((await f.summary(0)).counts.questions, 1);
    const clearedFeed = await feed();
    assert.equal(clearedFeed.records.length, 2);
    assert.equal(clearedFeed.counts.blocked, 2);
    assert.equal(clearedFeed.counts.questions, 2);
    for (const row of clearedFeed.records) {
      assert.equal(row.detail.kind, 'record');
      if (row.detail.kind === 'record') assert.equal(row.detail.record.selectable, false);
    }
  },
);

for (const scenario of [
  { name: 'empty', dates: [null], expected: null },
  { name: 'repeated', dates: ['2026-01-01', '2026-01-01', '2026-01-01'], expected: '2026-01-01' },
  { name: 'distinct', dates: ['2026-01-01', '2026-01-02', '2026-01-03'], expected: null },
  { name: 'null-and-date', dates: [null, '2026-01-01'], expected: null },
] as const)
  test(`native group summary retains exact ${scenario.name} date semantics through complete member traversal`, async (t) => {
    const f = await source(
      t,
      scenario.dates.map((date, n) => record('date-' + n, date, 'shared')),
    );
    assert.equal(f.groups.length, 1);
    f.ground(0);
    const summary = await f.summary(0);
    assert.equal(summary.date, scenario.expected);
    assert.equal(summary.counts.pending, scenario.dates.length);
  });

// Three actual sources exercise incremental dependencies, proof replacement, affected rebuilds and unchanged-source reuse.
// This is a host-integration hang guard; correctness remains count/evidence based.
test(
  'incremental native candidate records its newly opened grounding dependency and reuses unrelated feed sources',
  { timeout: 90000 },
  async (t) => {
    const bEntry = record('accepted-origin', '2026-01-01', 'shared'),
      b = await source(t, [bEntry]);
    b.ground(0);
    const accepted = b.review().review;
    await importIntakeRead(b.db, b.root, b.profileId, b.original.id, {
      version: accepted.version,
      reviewToken: accepted.reviewToken,
      decisions: accepted.records.map((row) => ({
        recordId: row.id,
        action: 'accept' as const,
        mapping: {},
      })),
    });
    b.ground(0);
    const a = await source(t, [record('unrelated-incoming', '2026-01-01', 'shared')], b),
      unrelated = await source(t, [record('independent')], b);
    a.ground(0);
    unrelated.ground(0);
    const feed = async () => {
      const page = await listIntakeImportFeedRead(b.db, b.root, b.profileId, {
        view: 'active',
        state: 'pending',
        limit: '10',
        bytes: '65536',
      });
      assert.ok('format' in page && page.format === 'health-intake-import-feed-v2');
      return page;
    };
    const first = await feed();
    assert.equal(first.totalRecords, 2);
    assert.equal(first.counts.blocked, 0);
    await proposeConversionRead(a.db, a.root, a.profileId, a.original.id, {
      version: a.review().review.version,
      jsonlText: JSON.stringify({ ...bEntry, payload: { text: 'Changed fictional source' } }),
      summary: 'Fictional source identity introduced incrementally',
    });
    a.ground(0);
    const changed = await feed();
    assert.equal(changed.totalRecords, 3);
    assert.equal(changed.counts.blocked, 0);
    const held = a.review(),
      dependencyQueue = await openCollectionReportQueue(b.db, b.root, b.profileId),
      certificate = dependencyQueue.groundingStamp(a.original.id);
    dependencyQueue.close();
    const before = { ...intakeWorkCounters(b.db).warm },
      sql = rawSqlStamp(b.db);
    b.ground(0, false);
    assert.equal(rawSqlStamp(b.db), sql);
    assert.throws(
      () => held.record(held.review.records[0]!.id),
      (error) => error instanceof HttpError && error.code === 'INTAKE_REVIEW_CHANGED',
    );
    const negative = await feed();
    assert.equal(negative.totalRecords, 3);
    assert.equal(
      negative.counts.blocked,
      0,
      'durable accepted original scope survives disposable proof removal',
    );
    assert.equal((await a.summary(0)).counts.blocked, 0);
    const refreshedQueue = await openCollectionReportQueue(b.db, b.root, b.profileId);
    assert.notEqual(
      refreshedQueue.groundingStamp(a.original.id),
      certificate,
      'the newly introduced accepted source participates in A certification',
    );
    refreshedQueue.close();
    for (const row of negative.records) {
      assert.equal(row.detail.kind, 'record');
      if (row.detail.kind === 'record') assert.equal(row.detail.record.selectable, true);
    }
    assert.equal((await unrelated.summary(0)).counts.blocked, 0);
    assert.equal(
      intakeWorkCounters(b.db).warm.collectionFeedRebuiltSources -
        before.collectionFeedRebuiltSources,
      2,
      'only the changed accepted source and its dependent source are refreshed',
    );
    assert.equal(
      intakeWorkCounters(b.db).warm.collectionQueueMemberRows,
      before.collectionQueueMemberRows,
      'grounding changes do not rebuild installation membership',
    );
    const warm = { ...intakeWorkCounters(b.db).warm };
    assert.deepEqual((await feed()).counts, negative.counts);
    assert.equal(
      intakeWorkCounters(b.db).warm.collectionFeedRebuiltSources,
      warm.collectionFeedRebuiltSources,
    );
    assert.equal(
      intakeWorkCounters(b.db).warm.collectionQueueSummaryBuilds,
      warm.collectionQueueSummaryBuilds,
    );
  },
);

test('skipped intermediate grounding publications reuse only the identical absent summary and refuse held clinical captures', async (t) => {
  const f = await source(t, [record('absent-owner')]),
    held = f.review(),
    selected = held.review.records[0]!,
    absent = await f.summary(0),
    before = { ...intakeWorkCounters(f.db).warm },
    initialQueue = await openCollectionReportQueue(f.db, f.root, f.profileId),
    certificate = initialQueue.groundingStamp(f.original.id);
  initialQueue.close();
  assert.equal(selected.identityReview?.blocking, true);
  assert.equal(absent.counts.blocked, 1);
  assert.equal(absent.counts.questions, 1);
  f.ground(0);
  const evictionBoundary = {
    profileId: f.profileId,
    intakeId: 'fictional-eviction-owner',
    sourceHash: 'fictional-eviction-source-hash',
    originalFingerprint: (group: { id: string }) => group.id,
    boundaryFingerprint: (group: { id: string }) => group.id,
  };
  // Fill the actual 256-scope bound without reading the selected owner between
  // publication and eviction. Every staged proof scope is empty and bounded.
  for (let n = 0; n < 256; n++)
    retainSelectedIdentityGrounding(
      f.db,
      evictionBoundary,
      { ...f.groups[0]!, id: 'fictional-eviction-' + n },
      [],
      true,
    );
  assert.throws(
    () => held.record(selected.id),
    (error) => error instanceof HttpError && error.code === 'INTAKE_REVIEW_CHANGED',
  );
  const finalQueue = await openCollectionReportQueue(f.db, f.root, f.profileId);
  assert.equal(
    finalQueue.groundingStamp(f.original.id),
    certificate,
    'source certificate describes final absence, not publication chronology',
  );
  finalQueue.close();
  assert.equal(f.review().record(selected.id)!.identityReview?.blocking, true);
  assert.deepEqual((await f.summary(0)).counts, absent.counts);
  assert.equal(
    intakeWorkCounters(f.db).warm.collectionQueueSummaryBuilds,
    before.collectionQueueSummaryBuilds,
  );
  assert.equal(
    intakeWorkCounters(f.db).warm.collectionQueueMemberRows,
    before.collectionQueueMemberRows,
  );
});
