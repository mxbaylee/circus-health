import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { createNote } from '../notes.ts';
import {
  prepareOwnershipEvidence,
  previewRecordOwnership,
  commitRecordOwnership,
  getRecordOwnershipReceipt,
} from '../record-ownership.ts';
import {
  previewNativeRecordOwnership,
  commitNativeRecordOwnership,
  nativeOwnershipNamePlan,
  clearNativeOwnershipPlans,
  chooseNativeOwnershipName,
  chooseNativeOwnershipReport,
} from '../record-ownership-native.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import type { OwnershipRequest } from '../../shared/record-ownership.ts';

test('native records-selected ownership previews and commits a complete large name effect without whole intake hydration', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-ownership-host-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional Person',
    person: { fullName: 'Fictional Person' },
  });
  const envelope = {
    format: 'health-record-v1',
    id: 'literal',
    kind: 'record',
    payload: { literal: 'Fictional retained evidence' },
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2026-01-12',
      testLabel: 'Fictional reach',
      valueText: '12.00',
      unit: 'cm',
    },
    provenance: {
      sourceSystem: 'Fictional Clinic',
      sourceRecordId: 'literal',
      capturedVia: null,
      evidenceClass: 'provider_export',
      locator: 'Fictional row 1',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    bytes: Buffer.from(JSON.stringify(envelope)),
    newProviderName: 'Fictional Clinic',
  });
  const review = reviewIntake(db, root, profileId, original.id);
  importIntake(db, root, profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const record = db.prepare('SELECT id,source_record_id FROM observations').get()!;
  const stored = JSON.parse(readIntakeEnvelopeText(db, { id: original.id }));
  stored.intake.workflow.identityConfirmations = [
    {
      operationId: 'fictional-historical-confirmation',
      outcome: 'this_is_me',
      attestation: 'reviewed_original_and_membership',
      assignedPerson: { personId: 'patient' },
      confirmedPrintedName: 'Fictional Historical Name',
      scope: {
        intakeId: original.id,
        groupId: 'fictional-historical-group',
        targets: Array.from({ length: 96 }, (_, i) => ({
          recordId: i === 0 ? String(record.source_record_id) : 'independent-' + i,
          padding: 'x'.repeat(1500),
        })),
      },
    },
  ];
  writeIntakeFixtureEnvelope(db, original.id, stored);
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [{ kind: 'observation', recordId: String(record.id) }] },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  };
  const oracle = previewRecordOwnership(db, root, profileId, request);
  assert.equal(oracle.names.length, 1);
  assert.equal(oracle.names[0]!.support[0]!.sourceRecordIds.length, 96);
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  const before = intakeWorkCounters(db);
  await prepareOwnershipEvidence(db, root, profileId, request);
  const preview = await previewNativeRecordOwnership(db, root, profileId, request);
  assert.equal(preview.namesIncluded, false);
  assert.equal('names' in preview, false);
  assert.ok('records' in preview);
  assert.deepEqual(preview.records, oracle.records);
  assert.deepEqual(preview.blockers, oracle.blockers);
  const plan = nativeOwnershipNamePlan(db, profileId, preview.nameEvidence.token);
  assert.equal(plan.reference.targetTotal, 96);
  assert.equal(plan.effects().items[0]!.unknownSupport, true);
  const decided = chooseNativeOwnershipName(
    db,
    root,
    profileId,
    preview.nameEvidence.token,
    plan.effects().items[0]!.key,
    'old',
  );
  assert.notEqual(decided.scopeToken, preview.scopeToken);
  await assert.rejects(
    commitNativeRecordOwnership(db, root, profileId, {
      operationId: randomUUID(),
      request: preview.request,
      scopeToken: preview.scopeToken,
      version: preview.version,
    }),
    /current ownership evidence/,
  );
  const operationId = randomUUID(),
    command = {
      operationId,
      request: decided.request,
      scopeToken: decided.scopeToken,
      version: decided.version,
    };
  const receipt = await commitNativeRecordOwnership(db, root, profileId, command);
  assert.equal(receipt.moved, 1);
  const assignment = JSON.parse(
    String(
      db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Record ownership source' ORDER BY id LIMIT 1",
        )
        .get()!.coverage_json,
    ),
  );
  assert.equal(assignment.identityIssues.format, 'health-ownership-identity-issues-v1');
  assert.equal(assignment.identityIssues.snapshot.count, 0);
  assert.equal(
    db.prepare('SELECT person_id FROM observations WHERE id=?').get(record.id)!.person_id,
    destination.personId,
  );
  assert.equal(commitRecordOwnership(db, root, profileId, command).replayed, true);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.warm.materializationReads);
  assert.throws(
    () => nativeOwnershipNamePlan(db, 'another-profile', preview.nameEvidence.token),
    /current ownership evidence/,
  );
});

test('native whole-report preview pages exact clinical and pending scope and publishes one atomic report correction with durable outcome pages', async (t) => {
  const { nativeOwnershipReportPlan } = await import('../record-ownership-native.ts');
  const { ownershipReceiptReference, replayOwnershipReceiptReference, ownershipOutcomePage } =
    await import('../ownership-outcome-page.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-report-ownership-')),
    profileId = 'fictional';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const journalObjects = new Map<string, Buffer>();
  const recordStorage = {
    read(name: string) {
      const value = journalObjects.get(name);
      return value ? Buffer.from(value) : null;
    },
    writeImmutable(name: string, bytes: Uint8Array) {
      assert.equal(journalObjects.has(name), false);
      journalObjects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes: Uint8Array) {
      journalObjects.set('head', Buffer.from(bytes));
    },
  };
  attachPersonalDurability(db, { root, profileId, recordStorage });
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional Report Person',
    person: { fullName: 'Fictional Report Person' },
  });
  const values = Array.from({ length: 18 }, (_, i) => ({
    format: 'health-record-v1',
    id: 'literal-' + i,
    kind: 'record',
    payload: { literal: 'Fictional retained evidence ' + i },
    report: {
      key: 'shared-report',
      title: 'Fictional shared report',
      subject: null,
      anchor: { text: 'Fictional shared report', locator: 'Fictional heading' },
    },
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2026-01-12',
      testLabel: 'Fictional test ' + i,
      valueText: String(i),
      unit: 'cm',
    },
    provenance: {
      sourceSystem: 'Fictional Clinic',
      sourceRecordId: 'literal-' + i,
      capturedVia: null,
      evidenceClass: 'provider_export',
      locator: 'Fictional row ' + i,
    },
    coverage: { status: 'complete_response', notes: [] },
  }));
  const original = uploadIntake(db, root, profileId, {
    filename: 'fictional-report.jsonl',
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
    newProviderName: 'Fictional Clinic',
  });
  const review = reviewIntake(db, root, profileId, original.id);
  importIntake(db, root, profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records
      .slice(0, 12)
      .map((row) => ({ recordId: row.id, action: 'accept', mapping: {} })),
  });
  const stored = JSON.parse(readIntakeEnvelopeText(db, { id: original.id })),
    group = stored.intake.workflow.reportGroups[0];
  group.versions.at(-1).members[0].unknown = 'x'.repeat(300000);
  writeIntakeFixtureEnvelope(db, original.id, stored);
  const request: OwnershipRequest = {
    selection: {
      type: 'report',
      intakeId: original.id,
      groupId: group.id,
      groupVersionId: group.versions.at(-1).id,
    },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  };
  const oracle = previewRecordOwnership(db, root, profileId, request);
  assert.equal(oracle.records.length, 12);
  assert.equal(oracle.pending.length, 6);
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  const before = intakeWorkCounters(db);
  let preview = await previewNativeRecordOwnership(db, root, profileId, request);
  assert.ok('reportEvidence' in preview);
  assert.equal('records' in preview, false);
  assert.equal('pending' in preview, false);
  assert.equal(preview.reportEvidence.recordTotal, 12);
  assert.equal(preview.reportEvidence.pendingTotal, 6);
  assert.equal(preview.commitGroups.length, 1);
  assert.equal(preview.commitGroups[0]!.atomic, true);
  const plan = nativeOwnershipReportPlan(db, profileId, preview.reportEvidence.token);
  const records: unknown[] = [],
    pending: unknown[] = [];
  for (const [section, items] of [
    ['records', records],
    ['pending', pending],
  ] as const) {
    let after = -1;
    do {
      const page = plan.page(section, after, 3);
      assert.ok(page.items.length <= 3);
      items.push(...page.items);
      if (page.complete) break;
      after = Number(page.after);
    } while (true);
  }
  const expanded = records.map((value) => {
    const record =
      value as import('../../shared/ownership-report-reference.ts').OwnershipReportPreviewRecord;
    assert.ok(!Array.isArray(record.contributions));
    const reference = record.contributions;
    const contributionPage = plan.contributionPage(reference.key, null, -1, 32);
    assert.equal(contributionPage.complete, true);
    const contributions = contributionPage.items.map((value) => {
      const contribution =
        value as import('../../shared/ownership-report-reference.ts').OwnershipContributionEvidence;
      const scopePage = plan.contributionPage(reference.key, contribution.sourceRecordId, -1, 32);
      assert.equal(scopePage.complete, true);
      return { ...contribution, reportScopes: scopePage.items };
    });
    assert.equal(contributions.length, reference.total);
    return { ...record, contributions };
  });
  assert.deepEqual(expanded, JSON.parse(JSON.stringify(oracle.records)));
  assert.deepEqual(pending, oracle.pending);
  assert.deepEqual(preview.blockers, oracle.blockers);
  const oldToken = preview.scopeToken;
  const firstRecord = oracle.records[0]!;
  const changed = await chooseNativeOwnershipReport(db, profileId, preview.reportEvidence.token, {
    recordId: firstRecord.recordId,
    decision: { action: 'keep_both' },
  });
  assert.ok('reportEvidence' in changed);
  preview = changed;
  assert.notEqual(preview.scopeToken, oldToken);
  assert.equal(preview.request.decisions?.length, 0);
  assert.equal(preview.reportEvidence.recordTotal, 12);
  await assert.rejects(
    chooseNativeOwnershipReport(db, profileId, preview.reportEvidence.token, {
      recordId: 'outside-selection',
      decision: { action: 'keep_both' },
    }),
    /outside this complete report/,
  );
  assert.equal(plan.publicPreview().scopeToken, preview.scopeToken);
  const operationId = randomUUID(),
    command = {
      operationId,
      request: preview.request,
      scopeToken: preview.scopeToken,
      version: preview.version,
    };
  const journalWork = createRecordVersionWorkCounters();
  const receipt = await withRecordVersionWork(journalWork, () =>
    commitNativeRecordOwnership(db, root, profileId, command),
  );
  assert.ok('outcomesIncluded' in receipt);
  assert.ok('outcomeDigest' in receipt);
  assert.equal(receipt.outcomesIncluded, false);
  assert.equal('outcomes' in receipt, false);
  assert.equal(receipt.moved, 12);
  assert.equal(receipt.pending, 6);
  assert.ok(journalWork.operation.maxSegmentReferencesBuffered <= 64);
  const acceptedHead = JSON.parse(journalObjects.get('head')!.toString()),
    acceptedCommit = JSON.parse(journalObjects.get(acceptedHead.name)!.toString());
  assert.equal(acceptedCommit.result.outcomes, undefined);
  assert.equal(acceptedCommit.result.outcomesIncluded, false);
  assert.ok(JSON.stringify(acceptedCommit.result).length < 2048);
  assert.throws(() => getRecordOwnershipReceipt(db, profileId, operationId), /paged outcomes/);
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?').get(destination.personId)!
      .n,
    12,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM manual_batches WHERE title='Report ownership default' AND json_extract(coverage_json,'$.operationId')=?",
      )
      .get(operationId)!.n,
    1,
  );
  assert.deepEqual(replayOwnershipReceiptReference(db, profileId, command), {
    ...receipt,
    replayed: true,
  });
  assert.deepEqual(ownershipReceiptReference(db, profileId, operationId), {
    ...receipt,
    replayed: true,
  });
  const outcomes: unknown[] = [];
  let after = '';
  do {
    const page = ownershipOutcomePage(db, profileId, operationId, after, 5);
    outcomes.push(...page.items);
    if (page.complete) break;
    after = page.after!;
  } while (true);
  assert.equal(outcomes.length, 12);
  assert.match(receipt.outcomeDigest, /^[a-f0-9]{64}$/);
  assert.throws(
    () => ownershipOutcomePage(db, 'another-profile', operationId, '', 1),
    /another profile/,
  );
  const late = db
    .prepare(
      "SELECT id,coverage_json FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.operationId')=? ORDER BY id DESC LIMIT 1",
    )
    .get(operationId)!;
  const modified = JSON.parse(String(late.coverage_json));
  modified.fromNoteId = 'fictional-corrupted-owner';
  db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
    JSON.stringify(modified),
    late.id,
  );
  assert.throws(
    () => ownershipOutcomePage(db, profileId, operationId, 'zzzz-past-final-evidence', 1),
    /complete digest/,
  );
  db.prepare('UPDATE manual_batches SET coverage_json=? WHERE id=?').run(
    late.coverage_json,
    late.id,
  );
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.warm.materializationReads);
});

test('native selected-record ownership keeps every off-page identity requirement and refuses the complete blocked scope', async (t) => {
  const { nativeOwnershipBlockerStore } = await import('../record-ownership-native.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-identity-questions-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearNativeOwnershipPlans(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional Willow',
    person: { fullName: 'Fictional Willow' },
  });
  const value = {
    format: 'health-record-v1',
    id: 'fictional',
    kind: 'record',
    payload: { literal: 'Fictional evidence' },
    clinical: {
      kind: 'observation',
      subject: 'self',
      date: '2026-01-12',
      testLabel: 'Fictional reading',
      valueText: '12',
      unit: 'cm',
    },
    provenance: {
      sourceSystem: 'Fictional clinic',
      sourceRecordId: 'fictional',
      capturedVia: null,
      evidenceClass: 'provider_export',
      locator: 'Fictional row',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const original = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      bytes: Buffer.from(JSON.stringify(value)),
      newProviderName: 'Fictional clinic',
    }),
    review = reviewIntake(db, root, profileId, original.id);
  importIntake(db, root, profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const row = db.prepare('SELECT id FROM observations').get()!,
    stored = JSON.parse(readIntakeEnvelopeText(db, { id: original.id })),
    candidate = stored.intake.workflow.candidates[0];
  stored.intake.workflow.questions = Array.from({ length: 65 }, (_, index) => ({
    id: 'fictional-identity-' + index,
    key: 'fictional-identity-' + index,
    candidateId: candidate.id,
    candidateVersionId: candidate.versions.at(-1).id,
    prompt: 'Does this fictional record identify another person? ' + index + ' ' + 'x'.repeat(3000),
    locator: 'Fictional row',
    field: 'subject',
    status: 'unanswered',
    createdAt: '2026-01-01T00:00:00Z',
    answers: [],
  }));
  writeIntakeFixtureEnvelope(db, original.id, stored);
  await buildIntakeCollectionEnvelope(db, { id: original.id });
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [{ kind: 'observation', recordId: String(row.id) }] },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  };
  await prepareOwnershipEvidence(db, root, profileId, request);
  const preview = await previewNativeRecordOwnership(db, root, profileId, request);
  if (!('records' in preview)) throw Error('Expected selected record preview');
  const blockers = preview.records[0]!.blockers;
  assert.equal(Array.isArray(blockers), false);
  if (Array.isArray(blockers)) throw Error('Expected complete blocker reference');
  assert.equal(blockers.count, 66);
  const token = new URL(blockers.url, 'http://fictional').pathname.split('/').at(-1)!,
    plan = nativeOwnershipBlockerStore(db, profileId, token),
    first = plan.page(blockers.key, -1, 3, 4096);
  assert.equal(first.total, 66);
  assert.equal(first.items.length, 3);
  const last = plan.page(blockers.key, 63, 3, 8192);
  assert.equal(last.items.length, 2);
  assert.match(String(last.items[0]), /64/);
  await assert.rejects(
    commitNativeRecordOwnership(db, root, profileId, {
      operationId: randomUUID(),
      request: preview.request,
      version: preview.version,
      scopeToken: preview.scopeToken,
    }),
    /Resolve every displayed decision/,
  );
  assert.equal(
    db.prepare('SELECT person_id FROM observations WHERE id=?').get(row.id)!.person_id,
    'patient',
  );
  assert.throws(() => nativeOwnershipBlockerStore(db, 'other-profile', token), /Refresh/);
});
