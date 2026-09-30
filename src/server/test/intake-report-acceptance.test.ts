import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { attachRecordDurability } from '../record-versions.ts';
import type { RecordStorage } from '../record-versions.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import type {
  HealthRecordEnvelope,
  Intake,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceResult,
} from '../../shared/intake.ts';
import type { IncomingMessage } from 'node:http';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-counted-acceptance-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}
type Fixture = ReturnType<typeof fixture>;
function envelope(id: string): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: '+14.00' },
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: 'Fictional issuer',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1 row ' + id,
    },
    coverage: { status: 'partial', notes: [] },
    report: {
      key: 'FICT-DXA',
      title: 'Fictional DEXA',
      anchor: { locator: 'page 1 heading', text: 'DEXA FICT-DXA' },
      subject: null,
    },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: id,
      valueText: '+14.00',
      date: '2026-09',
      unit: 'mg',
    },
  };
}
function upload(f: Fixture, values: HealthRecordEnvelope[], filename = 'fictional.jsonl'): Intake {
  return intake.uploadIntake(f.db, f.root, f.profileId, {
    filename,
    bytes: Buffer.from(values.map((value) => JSON.stringify(value)).join('\n')),
  });
}
function block(
  f: Fixture,
  intakeId: string,
  proposalId: string | null = null,
  indices?: number[],
): IntakeReportAcceptanceBlock {
  const review = intake.reviewIntake(f.db, f.root, f.profileId, intakeId, proposalId);
  return {
    intakeId,
    proposalId,
    intakeVersion: review.version,
    reviewToken: review.reviewToken,
    selections: review.records
      .filter((_record, index) => !indices || indices.includes(index))
      .map((record) => ({
        selectionReviewToken: record.selectionReviewToken,
        recordId: record.id,
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        mapping: record.draft?.mapping || {},
      })),
  };
}
function accept(f: Fixture, request: IntakeReportAcceptanceRequest) {
  return acceptIntakeReportSelection(f.db, f.root, f.profileId, request);
}
function request(...blocks: IntakeReportAcceptanceBlock[]): IntakeReportAcceptanceRequest {
  return { operationId: randomUUID(), blocks };
}
function confirmedProposal(f: Fixture, item: Intake, value: HealthRecordEnvelope) {
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(value),
    summary: 'Fictional candidate proposal',
  });
  const proposalId = proposed.proposals.at(-1)!.id;
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId),
    record = review.records[0]!;
  const identity = record.issues?.find((issue) => issue.kind === 'identity');
  const current = identity
    ? intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
        version: review.version,
        operationId: randomUUID(),
        proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        resolutions: [{ issueId: identity.id, outcome: 'this_is_me' }],
      })
    : proposed;
  return { item: current, proposalId };
}
function disposition(
  f: Fixture,
  item: Intake,
  index: number,
  value: 'review_later' | 'keep_original_only',
) {
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id),
    record = review.records[index]!;
  return intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    disposition: value,
  });
}

test('counted selection accepts only explicit current records, including deliberately selected deferred work', (t) => {
  const f = fixture(t),
    values = Array.from({ length: 28 }, (_, index) => envelope('measurement-' + index));
  values[27]!.reviewIssues = [
    {
      kind: 'uncertain_reading',
      field: 'valueText',
      prompt: 'Confirm the fictional clipped reading?',
    },
  ];
  let item = upload(f, values);
  item = disposition(f, item, 1, 'review_later');
  item = disposition(f, item, 2, 'review_later');
  item = disposition(f, item, 3, 'keep_original_only');
  const input = request(block(f, item.id, null, [0, 1, 4])),
    result = accept(f, input);
  assert.equal(result.receipt.atomic, true);
  assert.equal(result.receipt.selectedCount, 3);
  assert.equal(result.receipt.acceptedCount, 3);
  assert.equal(result.receipt.receipts[0]!.records.length, 3);
  assert.ok(
    result.receipt.receipts[0]!.records.every(
      (record) => record.kind === 'observation' && record.entityId && record.outcome === 'added',
    ),
  );
  const saved = intake.getIntake(f.db, f.root, f.profileId, item.id);
  assert.equal(
    saved.workflow!.candidates.filter((candidate) => candidate.versions[0]!.status === 'accepted')
      .length,
    3,
  );
  assert.equal(saved.workflow!.candidates[3]!.versions[0]!.status, 'kept_original');
  assert.equal(
    saved.workflow!.reviewDrafts!.findLast((draft) => draft.recordId === `${item.id}:line:3`)!
      .disposition,
    'review_later',
  );
  assert.equal(saved.workflow!.candidates[27]!.versions[0]!.status, 'pending');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 3);
});

test('one atomic operation spans proposal blocks and files without clobbering earlier source history', (t) => {
  const f = fixture(t),
    first = upload(f, [envelope('original-one')], 'first.jsonl');
  const proposed = confirmedProposal(f, first, envelope('proposal-two'));
  const other = upload(f, [envelope('other-file')], 'other.jsonl');
  const input = request(
    block(f, first.id),
    block(f, first.id, proposed.proposalId),
    block(f, other.id),
  );
  const result = accept(f, input);
  assert.equal(result.receipt.acceptedCount, 3);
  const receipts = result.receipt.receipts;
  assert.equal(receipts[1]!.intakeVersionBefore, receipts[0]!.intakeVersionAfter);
  assert.equal(receipts[1]!.intakeVersionAfter, input.blocks[0]!.intakeVersion + 2);
  const saved = intake.getIntake(f.db, f.root, f.profileId, first.id);
  assert.equal(saved.workflow!.decisions.length, 2);
  assert.equal(saved.importHistory!.length, 1);
  assert.equal(saved.workflow!.reportAcceptances!.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 3);
});

test('double submit and replay after a later ordinary import return the original receipt without new writes', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('first'), envelope('second')]);
  const input = request(block(f, item.id, null, [0])),
    result = accept(f, input);
  assert.equal(accept(f, input).replayed, true);
  const laterProposal = confirmedProposal(
    f,
    intake.getIntake(f.db, f.root, f.profileId, item.id),
    envelope('later-proposal'),
  );
  const later = block(f, item.id, laterProposal.proposalId);
  intake.importIntake(f.db, f.root, f.profileId, item.id, {
    version: later.intakeVersion,
    proposalId: later.proposalId,
    reviewToken: later.reviewToken,
    decisions: later.selections.map((selection) => ({
      recordId: selection.recordId,
      action: 'accept',
      mapping: {},
    })),
  });
  const version = intake.getIntake(f.db, f.root, f.profileId, item.id).version;
  assert.deepEqual(accept(f, input).receipt, result.receipt);
  assert.equal(intake.getIntake(f.db, f.root, f.profileId, item.id).version, version);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.deepEqual(
    getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId).receipt,
    result.receipt,
  );
  const conflicting = structuredClone(input);
  conflicting.blocks[0]!.selections[0]!.mapping = { unit: 'different' };
  assert.throws(() => accept(f, conflicting), { code: 'OPERATION_CONFLICT' });
});

test('blocked or stale selection rejects all blocks before acceptance; later application failure rolls everything back', (t) => {
  const f = fixture(t),
    first = upload(f, [envelope('good')], 'good.jsonl');
  const bad = envelope('blocked');
  bad.reviewIssues = [
    { kind: 'uncertain_reading', field: 'valueText', prompt: 'Confirm the reading?' },
  ];
  const second = upload(f, [bad], 'bad.jsonl');
  const blocked = request(block(f, first.id), block(f, second.id));
  assert.throws(() => accept(f, blocked));
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, blocked.operationId), {
    code: 'REPORT_ACCEPTANCE_NOT_FOUND',
  });
  const third = upload(f, [envelope('bad-mapping')], 'mapping.jsonl');
  const lateFailure = request(block(f, first.id), block(f, third.id));
  const before = intake.getIntake(f.db, f.root, f.profileId, first.id);
  (lateFailure.blocks[1]!.selections[0]!.mapping as Record<string, unknown>).unit = 123;
  assert.throws(() => accept(f, lateFailure), { code: 'IMPORT_MAPPING' });
  assert.deepEqual(intake.getIntake(f.db, f.root, f.profileId, first.id).workflow, before.workflow);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

test('a refreshed old proposal token cannot accept a superseded candidate and mappings are never silently refreshed', (t) => {
  const f = fixture(t),
    old = envelope('versioned');
  const first = upload(f, [old]),
    initial = request(block(f, first.id));
  confirmedProposal(f, first, { ...old, payload: 'Fictional changed evidence' });
  assert.throws(() => accept(f, initial), { code: 'REPORT_ACCEPTANCE_STALE' });
  const refreshedOld = request(block(f, first.id));
  assert.throws(() => accept(f, refreshedOld), { code: 'REPORT_ACCEPTANCE_STALE' });
  const other = upload(f, [envelope('drafted')], 'drafted.jsonl');
  const pinned = request(block(f, other.id));
  const review = intake.reviewIntake(f.db, f.root, f.profileId, other.id),
    record = review.records[0]!;
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, other.id, {
    version: review.version,
    proposalId: null,
    operationId: randomUUID(),
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
    mapping: { unit: 'g' },
  });
  assert.throws(() => accept(f, pinned), { code: 'VERSION_CONFLICT' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

test('receipt and original selections survive source updates, backup/rebuild and later operations', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('durable-one'), envelope('durable-two')]);
  const input = request(block(f, item.id, null, [0])),
    original = accept(f, input).receipt;
  accept(f, request(block(f, item.id, null, [1])));
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(
      getIntakeReportAcceptance(db, target, f.profileId, input.operationId).receipt,
      original,
    );
    assert.deepEqual(acceptIntakeReportSelection(db, target, f.profileId, input).receipt, original);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  } finally {
    db.close();
  }
});

test('a durable-head publication followed by lost commit acknowledgement never manufactures success or duplicates on recovery', (t) => {
  const f = fixture(t),
    first = upload(f, [envelope('head-one')], 'head-one.jsonl'),
    second = upload(f, [envelope('head-two')], 'head-two.jsonl');
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable(name, bytes) {
      const prior = objects.get(name);
      if (prior) assert.deepEqual(prior, Buffer.from(bytes));
      else objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
    },
  };
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const input = request(block(f, first.id), block(f, second.id));
  const publish = storage.publishHead;
  storage.publishHead = (bytes) => {
    publish(bytes);
    throw new Error('Fictional lost durable commit acknowledgement');
  };
  assert.throws(() => accept(f, input), /lost durable commit/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId), {
    code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
  });
  assert.throws(() => accept(f, input), { code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED' });
  storage.publishHead = publish;
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const recovered = getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId);
  assert.equal(recovered.receipt.acceptedCount, 2);
  assert.equal(accept(f, input).replayed, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});

test('encrypted profile lock prevents acceptance; receipt lookup is profile-scoped and survives unlock', async (t) => {
  const f = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(f.manager, 'Fictional counted acceptance');
  let state = f.manager.opened.get(profile.id)!;
  const local = { db: state.db, root: state.root, profileId: profile.id };
  const item = upload(local, [envelope('locked')]),
    input = request(block(local, item.id));
  const result = accept(local, input);
  const pending = upload(local, [envelope('still-pending')], 'pending.jsonl');
  const pendingInput = request(block(local, pending.id));
  f.manager.lock(profile.id);
  assert.throws(() => accept(local, input));
  assert.throws(() => accept(local, pendingInput));
  await f.manager.unlock(profile.id, recoveryKit);
  state = f.manager.opened.get(profile.id)!;
  assert.deepEqual(
    getIntakeReportAcceptance(state.db, state.root, profile.id, input.operationId).receipt,
    result.receipt,
  );
  assert.equal(
    intake.getIntake(state.db, state.root, profile.id, pending.id).workflow!.candidates[0]!
      .versions[0]!.status,
    'pending',
  );
  assert.throws(
    () => getIntakeReportAcceptance(state.db, state.root, profile.id, pendingInput.operationId),
    { code: 'REPORT_ACCEPTANCE_NOT_FOUND' },
  );
  assert.throws(
    () => getIntakeReportAcceptance(state.db, state.root, 'cookie-dough', input.operationId),
    { code: 'PROFILE_BOUNDARY' },
  );
});

test('acceptance routes return exact receipts and reject duplicate candidates and altered operation requests', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('route')]);
  const input = request(block(f, item.id));
  let response: unknown;
  const context = {
    ...f,
    resource: 'intakes',
    id: 'report-acceptance',
    method: 'POST',
    params: new URLSearchParams(),
    req: { headers: { 'content-type': 'application/json' } } as IncomingMessage,
    body: async () => Buffer.from(JSON.stringify(input)),
    respond: (value: unknown) => {
      response = value;
    },
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute(context), true);
  assert.equal((response as IntakeReportAcceptanceResult).receipt.acceptedCount, 1);
  await handleIntakeRoute({ ...context, method: 'GET', action: input.operationId });
  assert.equal((response as IntakeReportAcceptanceResult).replayed, true);
  const duplicate = request({
    ...input.blocks[0]!,
    selections: [...input.blocks[0]!.selections, ...input.blocks[0]!.selections],
  });
  assert.throws(() => accept(f, duplicate), { code: 'REPORT_ACCEPTANCE_INPUT' });
});

test('kept and repeated candidate selections are rejected and aggregate review bytes are bounded before parsing', (t) => {
  const f = fixture(t);
  let item = upload(f, [envelope('kept')]);
  item = disposition(f, item, 0, 'keep_original_only');
  assert.throws(() => accept(f, request(block(f, item.id))), { code: 'REPORT_ACCEPTANCE_STALE' });
  const other = upload(f, [envelope('bounded')], 'bounded.jsonl');
  const input = request(block(f, other.id));
  f.db.prepare('UPDATE source_files SET bytes=? WHERE id=?').run(65 * 1024 * 1024, other.id);
  assert.throws(() => accept(f, input), { code: 'REPORT_ACCEPTANCE_LIMIT' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

function partial(
  f: Fixture,
  ...blocks: IntakeReportAcceptanceBlock[]
): IntakeReportAcceptanceRequest {
  for (const block of blocks) {
    const review = intake.reviewIntake(f.db, f.root, f.profileId, block.intakeId, block.proposalId);
    for (const selection of block.selections)
      selection.mapping = {
        ...review.records.find((r) => r.id === selection.recordId)!.mapping,
        ...selection.mapping,
      };
  }
  return { ...request(...blocks), mode: 'partial-v1' };
}
test('partial v1 saves independent valid approvals and retains stale, blocked and invalid outcomes', (t) => {
  const f = fixture(t),
    blocked = envelope('blocked-partial');
  blocked.reviewIssues = [
    { kind: 'uncertain_reading', field: 'valueText', prompt: 'Confirm reading?' },
  ];
  const item = upload(f, [
    envelope('valid-a'),
    envelope('valid-b'),
    envelope('stale'),
    blocked,
    envelope('invalid'),
  ]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[2]!.selectionReviewToken = 'stale';
  (input.blocks[0]!.selections[4]!.mapping as Record<string, unknown>).unit = 123;
  const result = accept(f, input);
  assert.equal(result.receipt.atomic, false);
  if (result.receipt.atomic) throw Error('Expected partial receipt');
  // An unchanged sibling remains approvable: another save is not a new human review.
  // Rationale: docs/import/review-reliability.md.
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['saved', 'saved', 'needs_review', 'needs_review', 'needs_review'],
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.deepEqual(accept(f, input).receipt, result.receipt);
  const changed = structuredClone(input);
  changed.blocks[0]!.selections[0]!.mapping.unit = 'g';
  assert.throws(() => accept(f, changed), { code: 'OPERATION_CONFLICT' });
});
test('partial v1 pins exact records while unrelated intake changes do not invalidate approvals', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('one'), envelope('two')]);
  const input = partial(f, block(f, item.id, null, [0]));
  disposition(f, item, 1, 'review_later');
  assert.equal(accept(f, input).receipt.acceptedCount, 1);
  const other = upload(f, [envelope('substitute')], 'substitute.jsonl');
  const swapped = partial(f, block(f, other.id));
  swapped.blocks[0]!.selections[0]!.selectionReviewToken =
    input.blocks[0]!.selections[0]!.selectionReviewToken;
  const result = accept(f, swapped);
  assert.equal(result.receipt.acceptedCount, 0);
});
test('partial v1 manifest and bounded item receipts survive backup and rebuild without duplicate publication', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('durable-a'), envelope('durable-b')]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[1]!.selectionReviewToken = 'stale';
  const original = accept(f, input).receipt;
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'partial-rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(
      getIntakeReportAcceptance(db, target, f.profileId, input.operationId).receipt,
      original,
    );
    assert.deepEqual(acceptIntakeReportSelection(db, target, f.profileId, input).receipt, original);
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  } finally {
    db.close();
  }
});

test('partial children reconcile lost publication acknowledgement after earlier saves and reopen', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('alpha'), envelope('beta'), envelope('gamma')]);
  const objects = new Map<string, Buffer>();
  let publishes = 0,
    failAt = Infinity;
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable(name, bytes) {
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      if (++publishes === failAt) throw Error('Lost acknowledgement after publication');
    },
  };
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const input = partial(f, block(f, item.id));
  failAt = publishes + 3;
  assert.throws(() => accept(f, input), { code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId), {
    code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
  });
  // A lost response does not justify a new operation: recover the original journal.
  // Rationale: docs/import/review-reliability.md.
  failAt = Infinity;
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const recovered = getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId);
  assert.equal(recovered.receipt.acceptedCount, 2);
  assert.equal(!recovered.receipt.atomic && recovered.receipt.items[2]!.status, 'not_attempted');
  assert.deepEqual(accept(f, input).receipt, recovered.receipt);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});
test('partial shared storage failure stops later children with explicit terminal outcomes', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('alpha'), envelope('beta'), envelope('gamma')]);
  const objects = new Map<string, Buffer>();
  let publishes = 0,
    stopAfter = Infinity,
    failed = false;
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable(name, bytes) {
      if (publishes === stopAfter && !failed) {
        failed = true;
        throw Error('Storage write failed before publication');
      }
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      publishes++;
    },
  };
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const input = partial(f, block(f, item.id));
  stopAfter = publishes + 2;
  const result = accept(f, input);
  if (result.receipt.atomic) throw Error('Expected partial');
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['saved', 'failed', 'not_attempted'],
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.deepEqual(accept(f, input).receipt, result.receipt);
});
test('partial coupled identical assertions reject together while an independent item saves', (t) => {
  const f = fixture(t),
    first = envelope('same'),
    second = { ...envelope('same'), id: 'same-other' },
    third = envelope('independent');
  second.payload = { literal: 'same source assertion in a second delivery' };
  const item = upload(f, [first, third]),
    other = upload(f, [second], 'second.jsonl');
  const input = partial(f, block(f, item.id), block(f, other.id));
  input.blocks[1]!.selections[0]!.selectionReviewToken = 'stale';
  const result = accept(f, input);
  if (result.receipt.atomic) throw Error('Expected partial');
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['needs_review', 'saved', 'needs_review'],
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('operation IDs cannot change between atomic and partial modes', (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('one'), envelope('two')]);
  const atomic = request(block(f, item.id, null, [0]));
  accept(f, atomic);
  const altered = partial(f, block(f, item.id, null, [1]));
  altered.operationId = atomic.operationId;
  assert.throws(() => accept(f, altered), { code: 'OPERATION_CONFLICT' });
  const next = partial(f, block(f, item.id, null, [1]));
  accept(f, next);
  const legacy = structuredClone(next);
  delete legacy.mode;
  assert.throws(() => accept(f, legacy), { code: 'OPERATION_CONFLICT' });
});
test('same-label same-date distinct source events remain independent approvals', (t) => {
  const f = fixture(t),
    one = envelope('same-label'),
    two = envelope('same-label');
  two.id = 'distinct-event';
  two.provenance.sourceRecordId = 'distinct-event';
  two.clinical = { ...(two.clinical as object), valueText: '19' };
  const item = upload(f, [one, two]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[1]!.selectionReviewToken = 'stale';
  const result = accept(f, input);
  if (result.receipt.atomic) throw Error('Expected partial');
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['saved', 'needs_review'],
  );
});
