import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  uploadIntake,
  reviewIntake,
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
import { listIntakeImportFeedRead, clearPreparedCollectionQueues } from '../intake-queue-native.ts';
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
      first = queue.reviewMember(incoming.id, member);
    check(first.record);
    assert.equal(first.recordBytes, Buffer.byteLength(expected));
    first.record.comparisons![0]!.previousDecision!.reason = 'Changed detached response';
    check(queue.reviewMember(incoming.id, member).record);
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
