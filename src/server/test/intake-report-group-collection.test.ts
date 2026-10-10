import { listIntakeImportFeed } from '../intake-report-queue.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import { setImmediate as immediate } from 'node:timers/promises';
import { prepareCollectionClinicalReviewDependencies } from '../intake-review-collection-host.ts';
import { readCollectionIntakeReportRecords } from '../intake-report-queue-collection.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  uploadIntake,
  reviewIntake,
  proposeConversionRead,
  importIntake,
  readIntakeReviewRecord,
  readIntakeReviewFragment,
} from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  applyClinicalRecordAction,
  openSelectedClinicalRecord,
  readClinicalRecordSection,
} from '../intake-clinical-record-sections.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import {
  openCollectionReportQueue,
  collectionReportGroupSummary,
  clearCollectionReportQueues,
} from '../intake-report-group-collection.ts';
import {
  listIntakeImportFeedRead,
  readIntakeReportRecords,
  clearPreparedCollectionQueues,
} from '../intake-queue-native.ts';
import { clearCollectionImportFeeds } from '../intake-import-feed-collection.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { canonicalLiteral } from '../intake-format.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';

test('accepted native pair transport omits absent status and retains literal evidence through group, host and fragment reads', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-group-json-')),
    profileId = 'fictional-group-json',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearPreparedCollectionQueues(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const literal = 'Keep "attachmentStatus":undefined and undefined literally. ' + 'z'.repeat(2500);
  const upload = (id: string) =>
    uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'record',
          payload: {
            text: literal,
            negative: JSON.rawJSON('-0'),
            exponent: JSON.rawJSON('1e0'),
            decimal: JSON.rawJSON('12.00'),
            large: JSON.rawJSON('9007199254740993'),
          },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'page 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'observation',
            subject: 'self',
            testLabel: 'Shared fictional observation',
            valueText: id === 'saved' ? '7.5' : '9.25',
            unit: 'mg/L',
            date: '2026-01-01',
          },
        }),
      ),
    });
  const saved = upload('saved'),
    savedReview = reviewIntake(db, root, profileId, saved.id);
  importIntake(db, root, profileId, saved.id, {
    version: savedReview.version,
    reviewToken: savedReview.reviewToken,
    decisions: [{ recordId: savedReview.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const incoming = upload('incoming'),
    originalRecord = reviewIntake(db, root, profileId, incoming.id).records[0]!,
    selection = {
      proposalId: null,
      recordId: originalRecord.id,
      candidateVersionId: originalRecord.candidateVersionId!,
    };
  await buildIntakeCollectionEnvelope(db, { id: incoming.id });
  await buildIntakeCollectionEnvelope(db, { id: saved.id });
  const pairs = await readClinicalRecordSection(db, root, profileId, incoming.id, {
    ...selection,
    section: 'comparisons',
    comparisonSearch: { query: 'Shared' },
  });
  assert.equal(pairs.total, 1);
  const pair = pairs.items[0]!.control;
  assert.ok(pair.kind === 'pair' && pair.scopeToken);
  const reason = 'Separate fictional source identifiers; retain both original assertions.';
  await applyClinicalRecordAction(db, root, profileId, incoming.id, {
    ...selection,
    version: pairs.context.version,
    reviewToken: pairs.context.reviewToken,
    operationId: randomUUID(),
    pair: {
      otherRecordId: pair.otherRecordId,
      scopeToken: pair.scopeToken,
      outcome: 'distinct',
      reason,
    },
  });
  const approval = await openSelectedClinicalRecord(db, root, profileId, incoming.id, selection);
  try {
    const accepted = await acceptIntakeReportSelectionAsync(db, root, profileId, {
      mode: 'partial-v1',
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: incoming.id,
          proposalId: null,
          intakeVersion: approval.review.version,
          reviewToken: approval.review.reviewToken,
          selections: [
            {
              recordId: selection.recordId,
              candidateVersionId: selection.candidateVersionId,
              candidateId: approval.record.candidateId!,
              selectionReviewToken: approval.record.selectionReviewToken!,
              mapping: {},
              useRetainedDecision: true,
            },
          ],
        },
      ],
    });
    assert.equal(accepted.receipt.acceptedCount, 1);
  } finally {
    approval.session.close();
  }
  const coldFeed = await listIntakeImportFeedRead(db, root, profileId, { view: 'all' });
  assert.ok('format' in coldFeed);
  assert.equal(coldFeed.counts.accepted, 2);
  const privateReview = await openSelectedClinicalRecord(
    db,
    root,
    profileId,
    incoming.id,
    selection,
  );
  let expected: string;
  try {
    const previous = privateReview.record.comparisons!.find(
      (value) => value.id === pair.otherRecordId,
    )!.previousDecision!;
    assert.equal(previous.outcome, 'distinct');
    assert.equal(previous.reason, reason);
    assert.ok(Object.hasOwn(previous, 'attachmentStatus'));
    assert.equal(previous.attachmentStatus, undefined);
    assert.match(canonicalLiteral(privateReview.record), /"attachmentStatus":undefined/);
    expected = JSON.stringify(privateReview.record);
  } finally {
    privateReview.session.close();
  }
  const check = (record: IntakeReviewRecord) => {
    const previous = record.comparisons!.find(
      (value) => value.id === pair.otherRecordId,
    )!.previousDecision!;
    assert.equal(Object.hasOwn(previous, 'attachmentStatus'), false);
    assert.equal(previous.reason, reason);
    assert.equal(JSON.parse(record.mapping.text!).text, literal);
    const wire = JSON.stringify(record);
    assert.match(wire, /:-0[,}]/);
    assert.match(wire, /:1e0[,}]/);
    assert.match(wire, /:12\.00[,}]/);
    assert.match(wire, /:9007199254740993[,}]/);
    const { queueState: _queueState, selectable: _selectable, ...transport } = JSON.parse(wire);
    assert.deepEqual(transport, JSON.parse(expected));
  };
  const queue = await openCollectionReportQueue(db, root, profileId);
  try {
    const pointer = [...queue.groups('all', incoming.id)][0]!,
      member = [...queue.members(incoming.id, pointer.ordinal)][0]!,
      first = await queue.reviewMember(incoming.id, member);
    check(first.record);
    assert.equal(first.recordBytes, Buffer.byteLength(expected));
    first.record.comparisons![0]!.previousDecision!.reason = 'Changed detached response';
    check((await queue.reviewMember(incoming.id, member)).record);
    const summary = await collectionReportGroupSummary(db, root, profileId, queue, pointer);
    assert.equal(summary.counts.accepted, 1);
  } finally {
    queue.close();
  }
  const read = () => readIntakeReviewRecord(db, root, profileId, incoming.id, selection);
  const host = await read();
  assert.ok(host.record.kind === 'record');
  check(host.record.record);
  host.record.record.comparisons![0]!.previousDecision!.reason = 'Changed detached host response';
  const warm = await read();
  assert.ok(warm.record.kind === 'record');
  check(warm.record.record);
  const referenced = await readIntakeReviewRecord(db, root, profileId, incoming.id, {
    ...selection,
    bytes: 1024,
  });
  assert.ok(referenced.record.kind === 'reference');
  const fragment = await readIntakeReviewFragment(db, root, profileId, incoming.id, {
    proposalId: null,
    reference: referenced.record.reference,
    bytes: 256 * 1024,
  });
  assert.equal(fragment.complete, true);
  const fragmentJson = Buffer.from(fragment.data, 'base64').toString();
  assert.equal(Buffer.byteLength(fragmentJson), referenced.record.reference.bytes);
  assert.equal(fragmentJson, expected);
  check(
    JSON.parse(fragmentJson, (_key, value, context) =>
      typeof value === 'number' && context?.source && JSON.stringify(value) !== context.source
        ? JSON.rawJSON(context.source)
        : value,
    ) as IntakeReviewRecord,
  );
  for (let n = 0; n < 2; n++) {
    const feed = await listIntakeImportFeedRead(db, root, profileId, { view: 'all' });
    assert.ok('format' in feed);
    assert.equal(feed.counts.accepted, 2);
  }
});

function readFixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-cooperative-queue-')),
    profileId = 'fictional-cooperative-queue',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    clearCollectionImportFeeds(db);
    clearCollectionReportQueues(db);
    clearPreparedCollectionQueues(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const envelope = (id: string) => ({
    format: 'health-record-v1',
    id,
    kind: 'document',
    payload: { text: 'Independently fictional source ' + id },
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: 'Fictional clinic',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1',
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: { kind: 'document', subject: 'unknown', documentTitle: id, date: '2026-01-01' },
  });
  const upload = (count: number) =>
    uploadIntake(db, root, profileId, {
      filename: 'fictional-read.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        Array.from({ length: count }, (_, n) => JSON.stringify(envelope('original-' + n))).join(
          '\n',
        ),
      ),
    });
  return { db, root, profileId, envelope, upload };
}

test(
  'cooperative report pages close every proposal session on repeated pages and dangling membership',
  { timeout: 90000 },
  async (t) => {
    const { db, root, profileId, envelope, upload } = readFixture(t),
      source = upload(2);
    await buildIntakeCollectionEnvelope(db, source);
    await proposeConversionRead(db, root, profileId, source.id, {
      version: source.version,
      summary: 'Fictional additional report',
      jsonlText: JSON.stringify(envelope('proposed')),
    });
    const proposalId = String(
      db.prepare("SELECT id FROM source_files WHERE kind='intake_proposal'").get()!.id,
    );
    for (const proposal of [null, proposalId])
      await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposal);
    const baseline = reviewIssueScratchCounts(db);
    assert.equal(baseline.databases, 0);
    let expected = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = await readIntakeReportRecords(db, root, profileId, source.id, { view: 'all' });
      assert.equal(page.records.length, 3);
      assert.equal(page.totalRecords, 3);
      assert.equal(page.nextCursor, null);
      assert.equal(new Set(page.records.map((record) => record.proposalId)).size, 2);
      const encoded = JSON.stringify(page);
      if (attempt) assert.equal(encoded, expected);
      else expected = encoded;
      assert.deepEqual(reviewIssueScratchCounts(db), baseline);
    }
    const first = await openCollectionReportQueue(db, root, profileId),
      second = await openCollectionReportQueue(db, root, profileId),
      members = [...first.groups('all', source.id)].flatMap((group) => [
        ...first.members(source.id, group.ordinal),
      ]),
      original = members.find((member) => member.proposalId === null)!,
      proposed = members.find((member) => member.proposalId === proposalId)!;
    assert.ok(original && proposed);
    const rows = await Promise.all([
      first.reviewMember(source.id, original),
      second.reviewMember(source.id, proposed),
    ]);
    assert.equal(rows[0]!.record.id, original.recordId);
    assert.equal(rows[1]!.record.id, proposed.recordId);
    const unchanged = JSON.stringify(rows[0]);
    rows[1]!.record.mapping.documentTitle = 'Changed detached proposed row';
    assert.equal(JSON.stringify(await first.reviewMember(source.id, original)), unchanged);
    first.close();
    second.close();
    assert.deepEqual(reviewIssueScratchCounts(db), baseline);
    const queue = await openCollectionReportQueue(db, root, profileId);
    try {
      const window = queue.recordMemberWindow(source.id, { view: 'all', after: '', limit: 51 });
      await assert.rejects(
        readCollectionIntakeReportRecords(
          db,
          root,
          profileId,
          source.id,
          { view: 'all' },
          {
            ...queue,
            recordMemberWindow: () => ({
              ...window,
              *members() {
                let index = 0;
                for (const member of window.members())
                  yield index++ ? { ...member, recordId: 'fictional-dangling-record' } : member;
              },
            }),
          },
        ),
        /reference no longer matches/i,
      );
      assert.deepEqual(reviewIssueScratchCounts(db), baseline);
      const proposalPath = profileOriginal(
          root,
          String(db.prepare('SELECT path FROM source_files WHERE id=?').get(proposalId)!.path),
          profileId,
        ),
        proposalBytes = readFileSync(proposalPath);
      let replaced = false,
        replacement: ReturnType<typeof setImmediate> | undefined;
      try {
        await assert.rejects(
          readCollectionIntakeReportRecords(
            db,
            root,
            profileId,
            source.id,
            { view: 'all' },
            {
              ...queue,
              recordMemberWindow: () => ({
                totalRecords: 2,
                *members() {
                  // Two actual owned members, ordered to put the independent proposal
                  // proof before an original-session preparation with a real yield.
                  yield proposed;
                  replacement = setImmediate(() => {
                    writeFileSync(proposalPath, Buffer.alloc(proposalBytes.length, 32));
                    replaced = true;
                  });
                  yield original;
                },
              }),
            },
          ),
          /evidence changed|hash/i,
        );
        assert.equal(replaced, true);
        assert.deepEqual(reviewIssueScratchCounts(db), baseline);
      } finally {
        if (replacement) clearImmediate(replacement);
        writeFileSync(proposalPath, proposalBytes);
      }
    } finally {
      queue.close();
    }
  },
);

test(
  'cooperative queue reads cancel only their owner and discard reset or closed queued work',
  { timeout: 90000 },
  async (t) => {
    const { db, root, profileId, upload } = readFixture(t),
      source = upload(8);
    await buildIntakeCollectionEnvelope(db, source);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    await prepareCollectionPeopleIndex(db, root, profileId, source.id);
    const baseline = reviewIssueScratchCounts(db);
    const owner = await openCollectionReportQueue(db, root, profileId),
      peer = await openCollectionReportQueue(db, root, profileId),
      group = [...owner.groups('all', source.id)][0]!,
      member = [...owner.members(source.id, group.ordinal)][0]!;
    const cancelled = assert.rejects(owner.reviewMember(source.id, member), /Refresh|changed/i),
      surviving = peer.reviewMember(source.id, member);
    await immediate();
    assert.ok(
      reviewIssueScratchCounts(db).databases > baseline.databases,
      'cancellation occurs during real review preparation',
    );
    owner.close();
    await cancelled;
    assert.equal((await surviving).record.id, member.recordId);
    peer.close();
    assert.deepEqual(reviewIssueScratchCounts(db), baseline);
    for (const boundary of ['reset', 'close'] as const) {
      const active = await openCollectionReportQueue(db, root, profileId),
        queued = await openCollectionReportQueue(db, root, profileId),
        first = assert.rejects(active.reviewMember(source.id, member), /Refresh|changed/i),
        next = assert.rejects(queued.reviewMember(source.id, member), /Refresh|changed/i);
      await immediate();
      assert.ok(reviewIssueScratchCounts(db).databases > baseline.databases);
      if (boundary === 'reset') active.resetReview();
      else clearCollectionReportQueues(db);
      await Promise.all([first, next]);
      active.close();
      queued.close();
      assert.deepEqual(reviewIssueScratchCounts(db), baseline);
    }
    const current = await readIntakeReportRecords(db, root, profileId, source.id, { view: 'all' });
    assert.equal(current.totalRecords, 8);
    assert.deepEqual(reviewIssueScratchCounts(db), baseline);
  },
);

test(
  'queued warm review and signed cached feed refuse physical replacement without SQL changes',
  { timeout: 90000 },
  async (t) => {
    const { db, root, profileId, upload } = readFixture(t),
      source = upload(2);
    await buildIntakeCollectionEnvelope(db, source);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    await prepareCollectionPeopleIndex(db, root, profileId, source.id);
    const queue = await openCollectionReportQueue(db, root, profileId),
      group = [...queue.groups('all', source.id)][0]!,
      member = [...queue.members(source.id, group.ordinal)][0]!,
      file = String(db.prepare('SELECT path FROM source_files WHERE id=?').get(source.id)!.path),
      path = profileOriginal(root, file, profileId),
      original = readFileSync(path);
    await queue.reviewMember(source.id, member);
    const admitted = queue.reviewMember(source.id, member);
    // The wrapper has verified the path, but the serialized read has not resumed.
    writeFileSync(path, Buffer.alloc(original.length, 32));
    try {
      await assert.rejects(admitted, /changed|hash/i);
      assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    } finally {
      writeFileSync(path, original);
      queue.close();
    }
    const initial = await listIntakeImportFeedRead(db, root, profileId, {
      view: 'all',
      limit: '1',
    });
    assert.ok('format' in initial && initial.records.length === 1 && initial.nextCursor);
    writeFileSync(path, Buffer.alloc(original.length, 32));
    try {
      await assert.rejects(
        listIntakeImportFeedRead(db, root, profileId, { view: 'all', limit: '1' }),
        /changed|hash/i,
      );
      assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    } finally {
      writeFileSync(path, original);
    }
    const restored = await listIntakeImportFeedRead(db, root, profileId, {
      view: 'all',
      limit: '1',
    });
    assert.ok('format' in restored);
    assert.equal(restored.totalRecords, 2);
  },
);

test(
  'Documents filters history and unsupported before native pagination when the unfiltered first page contains only tests',
  { timeout: 90000 },
  async (t) => {
    const { db, root, profileId, envelope } = readFixture(t);
    const report = {
      key: 'fictional-documents-filter',
      title: 'Fictional mixed report',
      anchor: { locator: 'page 1', text: 'Fictional mixed report' },
      subject: null,
    };
    const values = [
      ...['first-test', 'second-test'].map((id) => ({
        ...envelope(id),
        report,
        kind: 'record',
        clinical: {
          kind: 'observation',
          subject: 'unknown',
          testLabel: id,
          valueText: '8',
          date: '2026-01-01',
        },
      })),
      { ...envelope('Fictional history'), report },
      { ...envelope('Fictional unsupported'), report, kind: 'record', clinical: undefined },
    ];
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional-documents-filter.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
    });
    const legacy = listIntakeImportFeed(db, root, profileId, {
      view: 'all',
      kind: 'documents',
      limit: 1,
    });
    assert.equal(legacy.totalRecords, 2);
    assert.ok(legacy.nextCursor);
    const legacyNext = listIntakeImportFeed(db, root, profileId, {
      view: 'all',
      kind: 'documents',
      limit: 1,
      cursor: legacy.nextCursor,
    });
    assert.deepEqual(
      new Set(
        [...legacy.blocks, ...legacyNext.blocks].flatMap((block) =>
          block.records.map((record) => record.feedKind),
        ),
      ),
      new Set(['history', 'unsupported']),
    );
    await buildIntakeCollectionEnvelope(db, source);
    const all = await listIntakeImportFeedRead(db, root, profileId, { view: 'all', limit: '2' });
    assert.ok('format' in all);
    assert.equal(all.totalRecords, 4);
    assert.deepEqual(
      all.records.map((record) => record.feedKind),
      ['test', 'test'],
    );
    assert.equal(all.kindCounts.history, 1);
    assert.equal(all.kindCounts.unsupported, 1);
    const options = { view: 'all', kind: 'documents', limit: '1' };
    const first = await listIntakeImportFeedRead(db, root, profileId, options);
    assert.ok('format' in first);
    assert.equal(first.totalRecords, 2);
    assert.equal(first.records.length, 1);
    assert.ok(first.nextCursor);
    assert.deepEqual(first.kindCounts, all.kindCounts);
    const second = await listIntakeImportFeedRead(db, root, profileId, {
      ...options,
      cursor: first.nextCursor,
    });
    assert.ok('format' in second);
    assert.equal(second.totalRecords, 2);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      new Set([first.records[0]!.feedKind, second.records[0]!.feedKind]),
      new Set(['history', 'unsupported']),
    );
    assert.notEqual(first.records[0]!.feedKey, second.records[0]!.feedKey);
    await assert.rejects(
      listIntakeImportFeedRead(db, root, profileId, {
        ...options,
        kind: 'history',
        cursor: first.nextCursor,
      }),
      /Refresh/i,
    );
    const searched = await listIntakeImportFeedRead(db, root, profileId, {
      ...options,
      q: 'Fictional history',
    });
    assert.ok('format' in searched);
    assert.equal(searched.totalRecords, 1);
    assert.equal(searched.records[0]!.feedKind, 'history');
    assert.equal(searched.nextCursor, null);
    assert.equal(searched.kindCounts.unsupported, 0);
  },
);
