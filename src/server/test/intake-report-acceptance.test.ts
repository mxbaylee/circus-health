import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  applyAcceptanceGroup,
  acceptIntakeReportSelection,
  acceptIntakeReportSelectionAsync,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { createBackup } from '../recovery.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { attachRecordDurability, rebuildRecordDatabase } from '../record-versions.ts';
import type { RecordStorage } from '../record-versions.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import { planIntakeReportAcceptance } from '../intake-acceptance-plan.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { canonicalLiteral } from '../intake-format.ts';
import { prepareNativePartialReviews } from '../intake-partial-acceptance.ts';
import { applyNativeAcceptanceGroup } from '../intake-report-acceptance-native.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
import {
  previewDirectRecordCorrection,
  applyDirectRecordCorrection,
} from '../clinical-review-routes.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { createRecordPublicationDiagnostic } from './helpers/record-publication-callers.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';
import {
  recordVersionWorkInventory,
  recordVersionSequence,
  encodedRecordObjectInventory,
  type ImmutableWriteEvent,
} from './helpers/record-version-work-inventory.ts';
import type {
  HealthRecordEnvelope,
  Intake,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceResult,
  IntakePartialAcceptanceItem,
} from '../../shared/intake.ts';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

function fixture(t: TestContext, storage?: RecordStorage | 'memory') {
  const root = mkdtempSync(join(tmpdir(), 'fictional-counted-acceptance-')),
    profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  if (storage === 'memory') memoryRecordAuthority(db);
  else if (storage) attachRecordDurability(db, { profileId, storage });
  else attachPersonalDurability(db, { root, profileId });
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
function acceptPartial(f: Fixture, request: IntakeReportAcceptanceRequest) {
  return acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, request);
}
async function waitForCommittedObservations(
  t: TestContext,
  f: Fixture,
  saving: Promise<unknown>,
  count: number,
  observe: () => void,
) {
  let settled = false;
  void saving.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const current = () => Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n);
  // Native preparation can yield before the first clinical commit. Observe the
  // actual committed state instead of assuming one microtask means 200 saves.
  while (!settled && (f.db.isTransaction || current() < count)) {
    t.signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (settled) await saving;
  assert.equal(settled, false, 'save must remain pending at the observed commit boundary');
  assert.equal(f.db.isTransaction, false);
  assert.equal(current(), count, 'observe the exact bounded commit before changing its successor');
  // Run the observation/mutation in this turn; awaiting this helper first would
  // allow the next child to finish before the caller changes its authority.
  const result: unknown = observe();
  assert.equal(result, undefined, 'commit-boundary observer must finish synchronously');
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
  attachPersonalDurability(db, { root: target, profileId: f.profileId, initialize: false });
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
  const f = fixture(t, storage),
    first = upload(f, [envelope('head-one')], 'head-one.jsonl'),
    second = upload(f, [envelope('head-two')], 'head-two.jsonl');
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
  const socket = new Socket();
  t.after(() => socket.destroy());
  const req = new IncomingMessage(socket);
  req.headers['content-type'] = 'application/json';
  const context = {
    ...f,
    resource: 'intakes',
    id: 'report-acceptance',
    method: 'POST',
    params: new URLSearchParams(),
    req,
    body: async () => Buffer.from(JSON.stringify(input)),
    respond: (value: unknown) => {
      response = value;
    },
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute(context), true);
  assert.equal(req.listenerCount('aborted'), 0);
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
  // Synthetic oversized metadata tests the pre-parse limit without allocating
  // a large original; publish it through the same transaction boundary.
  const f = fixture(t, 'memory');
  let item = upload(f, [envelope('kept')]);
  item = disposition(f, item, 0, 'keep_original_only');
  assert.throws(() => accept(f, request(block(f, item.id))), { code: 'REPORT_ACCEPTANCE_STALE' });
  const other = upload(f, [envelope('bounded')], 'bounded.jsonl');
  const input = request(block(f, other.id));
  transaction(f.db, () =>
    f.db.prepare('UPDATE source_files SET bytes=? WHERE id=?').run(65 * 1024 * 1024, other.id),
  );
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
test('partial v1 saves independent valid approvals and retains stale, blocked and invalid outcomes', async (t) => {
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
  const result = await acceptPartial(f, input);
  assert.equal(result.receipt.atomic, false);
  if (result.receipt.atomic) throw Error('Expected partial receipt');
  // An unchanged sibling remains approvable: another save is not a new human review.
  // Rationale: docs/import/review-reliability.md.
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['saved', 'saved', 'needs_review', 'needs_review', 'needs_review'],
    JSON.stringify(result.receipt.items),
  );
  assert.equal(result.receipt.items[2]?.label, 'stale');
  assert.equal(result.receipt.items[2]?.kind, 'observation');
  assert.equal(result.receipt.items[2]?.personId, 'patient');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.deepEqual((await acceptPartial(f, input)).receipt, result.receipt);
  const changed = structuredClone(input);
  changed.blocks[0]!.selections[0]!.mapping.unit = 'g';
  await assert.rejects(() => acceptPartial(f, changed), { code: 'OPERATION_CONFLICT' });
});
for (const n of [2, 10])
  test(`small independent partial saves prepare and publish one bounded clinical unit N=${n}`, async (t) => {
    const objects = new Map<string, Buffer>();
    const diagnostic =
      process.env.CRS_PARTIAL_ACCEPTANCE_QUALIFY === '1'
        ? createRecordPublicationDiagnostic(objects)
        : undefined;
    const clinicalPublications: number[] = [];
    let armed = false;
    const storage: RecordStorage = {
      read: (name) => objects.get(name) || null,
      writeImmutable(name, value) {
        const previous = objects.get(name);
        if (previous) assert.deepEqual(value, previous, 'Immutable object content changed');
        objects.set(name, Buffer.from(value));
        diagnostic?.immutable(name, value.length);
      },
      publishHead(value) {
        objects.set('head', Buffer.from(value));
        diagnostic?.published(value);
        if (!armed) return;
        const count = Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n);
        if (count > (clinicalPublications.at(-1) || 0)) clinicalPublications.push(count);
      },
    };
    const f = fixture(t, storage);
    diagnostic?.phase('upload');
    const item = upload(
      f,
      Array.from({ length: n }, (_, index) => envelope(`fictional-small-unit-${index}`)),
    );
    diagnostic?.phase('approval');
    const input = partial(f, block(f, item.id));
    diagnostic?.phase('adoption');
    await intake.ensureNativeIntakeSchema(f.db, f.profileId, item.id);
    const before = intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations;
    armed = true;
    diagnostic?.phase('save');
    const result = await acceptPartial(f, input);
    const preparations =
      intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations - before;
    t.diagnostic(JSON.stringify({ n, preparations, clinicalPublications }));
    assert.equal(result.receipt.acceptedCount, n);
    assert.equal(preparations, 2);
    assert.deepEqual(clinicalPublications, [n]);
    diagnostic?.phase('replay');
    assert.deepEqual((await acceptPartial(f, input)).receipt, result.receipt);
    assert.deepEqual(clinicalPublications, [n]);
    assert.equal(intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations - before, 2);
    if (diagnostic)
      process.stderr.write(
        JSON.stringify({
          audit: 'partial-publication-callers-v1',
          n,
          ...diagnostic.inventory(f.db),
        }) + '\n',
      );
  });
test('partial approval bounds native review preparations and journals proportional work', async (t) => {
  const diagnose = process.env.CRS_PARTIAL_ACCEPTANCE_QUALIFY === '1';
  const metrics: Array<{
    n: number;
    preparations: number;
    writes: number;
    bytes: number;
    rows: number;
    adoption: { writes: number; bytes: number; rows: number };
  }> = [];
  // One initial selected proposal session plus one selected acceptance projection
  // per child commit. Every independent same-proposal save, including N<20,
  // uses one bounded clinical transaction while retaining individual receipts.
  for (const [n, expectedPreparations] of [
    [10, 2],
    [50, 2],
    [200, 2],
  ] as const) {
    t.signal.throwIfAborted();
    await t.test(`N=${n}`, async (scope) => {
      if (diagnose)
        process.stderr.write(
          JSON.stringify({ audit: 'partial-version-inventory-stage-v1', n, stage: 'fixture' }) +
            '\n',
        );
      const objects = new Map<string, Buffer>();
      const writeEvents: ImmutableWriteEvent[] = [];
      const diagnostic = diagnose ? createRecordPublicationDiagnostic(objects) : undefined;
      let writes = 0,
        bytes = 0,
        preparations = 0,
        headWrites = 0,
        headBytes = 0;
      const storage: RecordStorage = {
        read: (name) => objects.get(name) || null,
        writeImmutable(name, value) {
          const previous = objects.get(name);
          if (previous) assert.deepEqual(value, previous, 'Immutable object content changed');
          objects.set(name, Buffer.from(value));
          writes++;
          bytes += value.length;
          if (diagnose) writeEvents.push({ name, bytes: value.length });
          diagnostic?.immutable(name, value.length);
        },
        publishHead(value) {
          objects.set('head', Buffer.from(value));
          headWrites++;
          headBytes += value.length;
          diagnostic?.published(value);
        },
      };
      const f = fixture(scope, storage);
      diagnostic?.phase('upload');
      const item = upload(
        f,
        Array.from({ length: n }, (_, index) => envelope(`fictional-scale-${index}`)),
      );
      const input = partial(f, block(f, item.id));
      diagnostic?.phase('adoption');
      writes = 0;
      bytes = 0;
      const before = Number(f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n);
      const beforeSequence = diagnose ? recordVersionSequence(f.db) : 0;
      const beforeEvent = writeEvents.length;
      const beforeHeads = { writes: headWrites, bytes: headBytes };
      // Account for one-time adoption separately while retaining it in the total
      // write-growth oracle. The clinical operation keeps the original approval.
      await intake.ensureNativeIntakeSchema(f.db, f.profileId, item.id);
      const adoption = {
        writes,
        bytes,
        rows: Number(f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n) - before,
      };
      if (diagnose)
        process.stderr.write(
          JSON.stringify({
            audit: 'partial-version-inventory-stage-v1',
            n,
            stage: 'adoption-complete',
            ...adoption,
          }) + '\n',
        );
      const adoptionSequence = diagnose ? recordVersionSequence(f.db) : 0;
      const adoptionEvent = writeEvents.length;
      const adoptionHeads = { writes: headWrites, bytes: headBytes };
      const preparation = intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations;
      diagnostic?.phase('postAdoption');
      const receipt = (await acceptPartial(f, input)).receipt;
      preparations =
        intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations - preparation;
      const rows =
        Number(f.db.prepare('SELECT count(*) n FROM __record_versions').get()!.n) - before;
      scope.diagnostic(
        JSON.stringify({
          n,
          acceptedCount: receipt.acceptedCount,
          preparations,
          writes,
          bytes,
          rows,
          adoption,
        }),
      );
      // Detached attribution reads run after every measured counter is captured.
      // The existing opt-in enables this diagnostic without adding routine SQL.
      if (diagnose) {
        const afterSequence = recordVersionSequence(f.db);
        const attribution = {
          adoption: {
            versions: recordVersionWorkInventory(f.db, beforeSequence, adoptionSequence),
            objects: encodedRecordObjectInventory(objects, writeEvents, beforeEvent, adoptionEvent),
            heads: {
              writes: adoptionHeads.writes - beforeHeads.writes,
              bytes: adoptionHeads.bytes - beforeHeads.bytes,
            },
          },
          postAdoption: {
            versions: recordVersionWorkInventory(f.db, adoptionSequence, afterSequence),
            objects: encodedRecordObjectInventory(objects, writeEvents, adoptionEvent),
            heads: {
              writes: headWrites - adoptionHeads.writes,
              bytes: headBytes - adoptionHeads.bytes,
            },
          },
        };
        for (const [phase, expected] of [
          ['adoption', adoption],
          [
            'postAdoption',
            {
              rows: rows - adoption.rows,
              writes: writes - adoption.writes,
              bytes: bytes - adoption.bytes,
            },
          ],
        ] as const) {
          const observed = attribution[phase];
          assert.equal(
            observed.versions.buckets.reduce((sum, bucket) => sum + Number(bucket.rows), 0),
            expected.rows,
          );
          assert.equal(
            Object.values(observed.objects.families).reduce(
              (sum, family) => sum + family.writes,
              0,
            ),
            expected.writes,
          );
          assert.equal(
            Object.values(observed.objects.families).reduce((sum, family) => sum + family.bytes, 0),
            expected.bytes,
          );
        }
        scope.diagnostic(
          JSON.stringify({ audit: 'partial-version-inventory-v1', n, ...attribution }),
        );
        const callers = diagnostic!.inventory(f.db);
        for (const [phase, after, through, expected] of [
          ['adoption', beforeSequence, adoptionSequence, attribution.adoption],
          ['postAdoption', adoptionSequence, afterSequence, attribution.postAdoption],
        ] as const) {
          const assigned = callers.publications
            .filter(
              (publication) => publication.sequence > after && publication.sequence <= through,
            )
            .flatMap((publication) => (publication.versions ? [publication.versions] : []));
          const unknown = callers.unknownSequences.filter(
            (row) => Number(row.sequence) > after && Number(row.sequence) <= through,
          );
          assert.equal(
            [...assigned, ...unknown].reduce((sum, row) => sum + Number(row.rows), 0),
            expected.versions.buckets.reduce((sum, row) => sum + Number(row.rows), 0),
          );
          const fragments = [
            ...callers.publications.flatMap((publication) => publication.eventFragments),
            ...callers.trailingFragments,
          ].filter((fragment) => fragment.phase === phase);
          for (const key of ['writes', 'bytes'] as const) {
            assert.equal(
              fragments.reduce(
                (sum, fragment) =>
                  sum +
                  Object.values(fragment.objects.families).reduce(
                    (total, family) => total + family[key],
                    0,
                  ),
                0,
              ),
              Object.values(expected.objects.families).reduce(
                (sum, family) => sum + family[key],
                0,
              ),
            );
            assert.equal(
              callers.publications
                .filter((publication) => publication.phase === phase)
                .reduce(
                  (sum, publication) => sum + (key === 'writes' ? 1 : publication.headBytes),
                  0,
                ),
              expected.heads[key],
            );
          }
        }
        scope.diagnostic(
          JSON.stringify({
            audit: 'partial-publication-callers-v2',
            n,
            ...callers,
          }),
        );
      }
      assert.equal(receipt.acceptedCount, n);
      assert.equal(preparations, expectedPreparations);
      metrics.push({ n, preparations, writes, bytes, rows, adoption });
    });
  }
  const small = metrics.find((item) => item.n === 50)!;
  const large = metrics.find((item) => item.n === 200)!;
  // Journal growth follows changed selections; no cumulative copies of earlier receipts.
  // See docs/data/record-version-storage.md and docs/import/review-reliability.md.
  assert.ok(large.writes <= 4 * small.writes + 4, JSON.stringify(metrics));
  assert.ok(large.rows <= 4 * small.rows + 12, JSON.stringify(metrics));
  assert.ok(large.bytes <= 4 * small.bytes + 32_768, JSON.stringify(metrics));
  t.diagnostic(`partial acceptance work counts: ${JSON.stringify(metrics)}`);
});
test('partial approval prepares each distinct proposal and selected commit projection once', async (t) => {
  const f = fixture(t);
  const original = upload(f, [envelope('fictional-original')]);
  const first = confirmedProposal(f, original, envelope('fictional-proposal-one'));
  const second = confirmedProposal(f, first.item, envelope('fictional-proposal-two'));
  const input = partial(
    f,
    block(f, original.id),
    block(f, original.id, first.proposalId),
    block(f, original.id, second.proposalId),
  );
  await intake.ensureNativeIntakeSchema(f.db, f.profileId, original.id);
  const before = intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations;
  const receipt = (await acceptPartial(f, input)).receipt;
  // Three initial selected proposal sessions and three selected acceptance
  // projections share this constructor counter; it does not measure reread bytes.
  assert.equal(intakeWorkCounters(f.db).warm.collectionClinicalReviewPreparations - before, 6);
  assert.equal(receipt.acceptedCount, 3);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 3);
});
test('a 500-item partial save yields to a read and never reconciles live missing items', async (t) => {
  const f = fixture(t);
  const item = upload(
    f,
    Array.from({ length: 500 }, (_, index) => envelope(`fictional-yield-${index}`)),
  );
  const input = partial(f, block(f, item.id));
  let finished = false;
  const saving = acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  // The first bounded transaction has returned to the event loop. A parallel
  // feed read can answer before the final result, without treating live work as interrupted.
  await waitForCommittedObservations(t, f, saving, 200, () => {
    const read = intake.getIntakeRead(f.db, f.root, f.profileId, item.id);
    assert.equal(read.id, item.id);
    assert.equal(finished, false);
    assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId), {
      code: 'REPORT_ACCEPTANCE_IN_PROGRESS',
    });
  });
  const result = await saving;
  assert.equal(result.receipt.acceptedCount, 500);
  assert.equal(
    getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId).receipt.acceptedCount,
    500,
  );
});
test('a source authority change during a yielded save rejects remaining old approvals', async (t) => {
  const f = fixture(t);
  // One pending record beyond the 200-item commit boundary proves invalidation.
  // The separate 500-item test above covers large-save yielding and receipt recovery.
  const item = upload(
    f,
    Array.from({ length: 201 }, (_, index) => envelope(`fictional-changing-${index}`)),
  );
  const input = partial(f, block(f, item.id));
  const saving = acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input);
  await waitForCommittedObservations(t, f, saving, 200, () => {
    // Clinical draft commands serialize behind this save. Exercise a separate
    // authority writer here; draft invalidation before planning has its own case.
    transaction(f.db, () =>
      f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), item.id),
    );
  });
  const result = (await saving).receipt;
  assert.equal(result.atomic, false);
  if (result.atomic) throw Error('Expected partial receipt');
  assert.equal(result.acceptedCount, 200);
  assert.deepEqual(
    new Set(result.items.slice(200).map((entry) => entry.status)),
    new Set(['needs_review']),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
});
test('a new same-named person during a yielded save invalidates cached identity review', async (t) => {
  const f = fixture(t);
  const self = getNote(f.db, 'person-note:self');
  saveNote(f.db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Iris Meadow' },
  });
  const values = Array.from({ length: 201 }, (_, index) => {
    const value = envelope(`fictional-identity-yield-${index}`);
    if (index === 200)
      value.report!.subject = { locator: 'page 1 patient', text: 'Fictional Iris Meadow' };
    return value;
  });
  const item = upload(f, values);
  assert.equal(
    intake.reviewIntake(f.db, f.root, f.profileId, item.id).records[200]?.identityReview
      ?.evidencedIdentity.fullName,
    'Fictional Iris Meadow',
  );
  const input = partial(f, block(f, item.id));
  const saving = acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input);
  await waitForCommittedObservations(t, f, saving, 200, () => {
    createNote(f.db, {
      kind: 'person',
      title: 'Fictional Iris Meadow',
      person: { fullName: 'Fictional Iris Meadow' },
    });
  });
  const receipt = (await saving).receipt;
  if (receipt.atomic) throw Error('Expected partial receipt');
  assert.equal(receipt.acceptedCount, 200);
  assert.deepEqual(
    new Set(receipt.items.slice(200).map((entry) => entry.status)),
    new Set(['needs_review']),
  );
  assert.equal(receipt.items[200]?.reasonCode, 'IDENTITY_REVIEW_CHANGED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
});
test('locking the profile between bounded commits stops the save and recovers committed children', async (t) => {
  const f = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(f.manager, 'Fictional yielded lock');
  const opened = f.manager.opened.get(profile.id)!;
  const local = { db: opened.db, root: opened.root, profileId: profile.id };
  const item = upload(
    local,
    Array.from({ length: 201 }, (_, index) => envelope(`fictional-lock-${index}`)),
  );
  const input = partial(local, block(local, item.id));
  const saving = acceptIntakeReportSelectionAsync(local.db, local.root, local.profileId, input);
  await waitForCommittedObservations(t, local, saving, 200, () => {
    f.manager.lock(profile.id);
  });
  await assert.rejects(saving);
  await f.manager.unlock(profile.id, recoveryKit);
  const restored = f.manager.opened.get(profile.id)!;
  const recovered = getIntakeReportAcceptance(
    restored.db,
    restored.root,
    profile.id,
    input.operationId,
  ).receipt;
  if (recovered.atomic) throw Error('Expected partial receipt');
  assert.equal(recovered.acceptedCount, 200);
  assert.equal(recovered.items[200]?.status, 'not_attempted');
  assert.equal(restored.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
});
test('one stale approval in a bounded batch leaves every independent sibling saved', async (t) => {
  const f = fixture(t);
  const item = upload(
    f,
    Array.from({ length: 200 }, (_, index) => envelope(`fictional-batch-${index}`)),
  );
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[73]!.selectionReviewToken = 'fictional-stale-token';
  const result = (await acceptPartial(f, input)).receipt;
  assert.equal(result.atomic, false);
  if (result.atomic) throw Error('Expected partial receipt');
  assert.equal(result.acceptedCount, 199);
  assert.equal(result.items[73]?.status, 'needs_review');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 199);
});
test('a lost acknowledgement for 200 batched approvals rebuilds once under the original operation', async (t) => {
  const objects = new Map<string, Buffer>();
  let loseClinicalAcknowledgement = false;
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable(name, bytes) {
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      if (
        loseClinicalAcknowledgement &&
        Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n) === 200
      )
        throw Error('Fictional lost batch acknowledgement');
    },
  };
  const f = fixture(t, storage);
  const item = upload(
    f,
    Array.from({ length: 200 }, (_, index) => envelope(`fictional-rebuild-${index}`)),
  );
  const input = partial(f, block(f, item.id));
  // Native adoption and review preparation precede the operation under test.
  // Arm the lost acknowledgement at the manifest/clinical boundary, not during adoption.
  await planIntakeReportAcceptance(f.db, f.root, f.profileId, input);
  loseClinicalAcknowledgement = true;
  await assert.rejects(() => acceptPartial(f, input), {
    code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
  });
  loseClinicalAcknowledgement = false;
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const recovered = getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId);
  assert.equal(recovered.receipt.acceptedCount, 200);
  assert.equal((await acceptPartial(f, input)).receipt.acceptedCount, 200);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
  const target = join(f.root, 'partial-200-rebuilt.sqlite');
  await rebuildRecordDatabase(target, { profileId: f.profileId, storage });
  const db = openDatabase(target, f.profileId);
  attachRecordDurability(db, { profileId: f.profileId, storage });
  try {
    assert.equal(
      getIntakeReportAcceptance(db, f.root, f.profileId, input.operationId).receipt.acceptedCount,
      200,
    );
    assert.equal(
      (await acceptIntakeReportSelectionAsync(db, f.root, f.profileId, input)).receipt
        .acceptedCount,
      200,
    );
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 200);
  } finally {
    db.close();
  }
});
test('partial v1 pins exact records while unrelated intake changes do not invalidate approvals', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('one'), envelope('two')]);
  const input = partial(f, block(f, item.id, null, [0]));
  disposition(f, item, 1, 'review_later');
  assert.equal((await acceptPartial(f, input)).receipt.acceptedCount, 1);
  const other = upload(f, [envelope('substitute')], 'substitute.jsonl');
  const swapped = partial(f, block(f, other.id));
  swapped.blocks[0]!.selections[0]!.selectionReviewToken =
    input.blocks[0]!.selections[0]!.selectionReviewToken;
  const result = await acceptPartial(f, swapped);
  assert.equal(result.receipt.acceptedCount, 0);
});
test('a relevant draft change before planning rejects the original partial approval', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('fictional-draft-changed')]);
  const input = partial(f, block(f, item.id));
  disposition(f, item, 0, 'keep_original_only');
  const receipt = (await acceptPartial(f, input)).receipt;
  if (receipt.atomic) throw Error('Expected partial receipt');
  assert.equal(receipt.acceptedCount, 0);
  assert.equal(receipt.items[0]!.status, 'needs_review');
  assert.equal(receipt.items[0]!.reasonCode, 'REPORT_ACCEPTANCE_STALE');
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.deepEqual((await acceptPartial(f, input)).receipt, receipt);
});
test('partial v1 manifest and bounded item receipts survive backup and rebuild without duplicate publication', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('durable-a'), envelope('durable-b')]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[1]!.selectionReviewToken = 'stale';
  const original = (await acceptPartial(f, input)).receipt;
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'partial-rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: target, profileId: f.profileId, initialize: false });
  try {
    assert.deepEqual(
      getIntakeReportAcceptance(db, target, f.profileId, input.operationId).receipt,
      original,
    );
    assert.deepEqual(
      (await acceptIntakeReportSelectionAsync(db, target, f.profileId, input)).receipt,
      original,
    );
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  } finally {
    db.close();
  }
});

for (const recovery of ['lookup', 'retry'] as const)
  test(`a historical small manifest recovers original child IDs via ${recovery} without regrouping interrupted selections`, async (t) => {
    const objects = new Map<string, Buffer>();
    let loseAcknowledgement = false;
    let lost = false;
    let publications = 0;
    const storage: RecordStorage = {
      read: (name) => objects.get(name) || null,
      writeImmutable(name, bytes) {
        objects.set(name, Buffer.from(bytes));
      },
      publishHead(bytes) {
        objects.set('head', Buffer.from(bytes));
        publications++;
        if (
          loseAcknowledgement &&
          Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n) === 1
        ) {
          lost = true;
          throw Error('Fictional historical child acknowledgement lost');
        }
      },
    };
    const f = fixture(t, storage);
    const item = upload(f, [envelope('historical-alpha'), envelope('historical-beta')]);
    const input = partial(f, block(f, item.id));
    const digest = (value: unknown) =>
      createHash('sha256').update(canonicalLiteral(value)).digest('hex');
    // These are the pre-batching writer's exact deterministic IDs and retained
    // shape. Publish through real journal transactions; no edited accepted bytes.
    const oldChildId = (identity: unknown) => {
      const hash = digest([input.operationId, identity]);
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    };
    const { selections, ...sourceBlock } = input.blocks[0]!;
    const entries = selections.map((selection) => ({
      block: sourceBlock,
      selection,
      childId: oldChildId([sourceBlock.intakeId, sourceBlock.proposalId, selection]),
    }));
    const manifest = {
      fingerprint: digest(input),
      operationId: input.operationId,
      at: '2026-09-01T00:00:00.000Z',
      entries,
      groups: entries.map((_, index) => [index]),
    };
    const originalChildOperation = oldChildId([entries[0]!.childId]);
    const regroupedOperation = oldChildId(entries.map((entry) => entry.childId));
    const prefix = 'intake_partial_acceptance:v1:';
    const prepared = await prepareNativePartialReviews(f.db, f.root, f.profileId, input);
    try {
      const source = prepared.sources.get(item.id)!;
      if (source instanceof Error) throw source;
      const reviewed = new Map([[canonicalLiteral([item.id, null]), source.review(null)]]);
      intake.intakeTransaction(
        f.db,
        () => {
          f.db
            .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run(prefix + input.operationId, JSON.stringify(manifest));
          return { operationId: input.operationId };
        },
        { operationId: input.operationId, fingerprint: manifest.fingerprint },
      );
      loseAcknowledgement = true;
      await assert.rejects(() =>
        applyNativeAcceptanceGroup(
          f.db,
          f.root,
          f.profileId,
          {
            operationId: originalChildOperation,
            blocks: [{ ...sourceBlock, selections: [selections[0]!] }],
          },
          digest([entries[0]]),
          {
            reviewed,
            retainResult(receipt) {
              f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
                prefix + input.operationId + ':item:0',
                JSON.stringify({
                  intakeId: item.id,
                  proposalId: null,
                  recordId: selections[0]!.recordId,
                  candidateId: selections[0]!.candidateId,
                  candidateVersionId: selections[0]!.candidateVersionId,
                  selectionReviewToken: selections[0]!.selectionReviewToken!,
                  reviewedSelectionHash: digest(selections[0]),
                  operationId: entries[0]!.childId,
                  status: 'saved',
                  receipt: receipt.receipts[0]!,
                } satisfies IntakePartialAcceptanceItem),
              );
            },
          },
        ),
      );
    } finally {
      prepared.close();
    }
    assert.equal(lost, true);
    loseAcknowledgement = false;
    attachRecordDurability(f.db, { profileId: f.profileId, storage });
    const assertOriginalOperations = (db: Fixture['db']) => {
      assert.ok(
        db
          .prepare('SELECT 1 FROM __record_transactions WHERE operation_id=?')
          .get(originalChildOperation),
      );
      assert.equal(
        db
          .prepare('SELECT 1 FROM __record_transactions WHERE operation_id=?')
          .get(regroupedOperation),
        undefined,
      );
      assert.deepEqual(
        JSON.parse(
          String(
            db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + input.operationId)!
              .value,
          ),
        ),
        manifest,
      );
    };
    assertOriginalOperations(f.db);
    const recovered =
      recovery === 'lookup'
        ? getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId).receipt
        : (await acceptPartial(f, input)).receipt;
    if (recovered.atomic) throw Error('Expected partial');
    assert.equal(recovered.acceptedCount, 1);
    assert.deepEqual(
      recovered.items.map((entry) => entry.operationId),
      entries.map((entry) => entry.childId),
    );
    assert.deepEqual(
      recovered.items.map((entry) => entry.status),
      ['saved', 'not_attempted'],
    );
    assert.equal(recovered.items[1]!.reasonCode, 'SAVE_INTERRUPTED');
    const settledPublications = publications;
    assert.deepEqual((await acceptPartial(f, input)).receipt, recovered);
    assert.equal(publications, settledPublications);
    const target = join(f.root, 'historical-partial-rebuilt.sqlite');
    await rebuildRecordDatabase(target, { profileId: f.profileId, storage });
    const db = openDatabase(target, f.profileId);
    attachRecordDurability(db, { profileId: f.profileId, storage });
    try {
      assertOriginalOperations(db);
      assert.deepEqual(
        getIntakeReportAcceptance(db, f.root, f.profileId, input.operationId).receipt,
        recovered,
      );
      assert.deepEqual(
        (await acceptIntakeReportSelectionAsync(db, f.root, f.profileId, input)).receipt,
        recovered,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
      assert.equal(publications, settledPublications);
    } finally {
      db.close();
    }
  });

test('partial children reconcile lost publication acknowledgement after earlier saves and reopen', async (t) => {
  const objects = new Map<string, Buffer>();
  let loseSecondClinicalAcknowledgement = false;
  const storage: RecordStorage = {
    read: (name) => objects.get(name) || null,
    writeImmutable(name, bytes) {
      objects.set(name, Buffer.from(bytes));
    },
    publishHead(bytes) {
      objects.set('head', Buffer.from(bytes));
      // Bisection saves the first two valid siblings together, then the third.
      // Lose that second clinical acknowledgement, not auxiliary publication.
      if (
        loseSecondClinicalAcknowledgement &&
        Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n) === 3
      )
        throw Error('Lost acknowledgement after publication');
    },
  };
  const f = fixture(t, storage),
    item = upload(f, [envelope('alpha'), envelope('beta'), envelope('gamma'), envelope('stale')]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[3]!.selectionReviewToken = 'fictional-stale-token';
  await planIntakeReportAcceptance(f.db, f.root, f.profileId, input);
  loseSecondClinicalAcknowledgement = true;
  await assert.rejects(() => acceptPartial(f, input), {
    code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
  });
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId), {
    code: 'REPORT_ACCEPTANCE_RECOVERY_REQUIRED',
  });
  // A lost response does not justify a new operation: recover the original journal.
  // Rationale: docs/import/review-reliability.md.
  loseSecondClinicalAcknowledgement = false;
  attachRecordDurability(f.db, { profileId: f.profileId, storage });
  const recovered = getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId);
  assert.equal(recovered.receipt.acceptedCount, 3);
  assert.equal(!recovered.receipt.atomic && recovered.receipt.items[3]!.status, 'not_attempted');
  assert.deepEqual((await acceptPartial(f, input)).receipt, recovered.receipt);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 3);
});
for (const failAtCount of [2, 3])
  test(`partial shared storage failure at ${failAtCount} rolls back its whole unit and stops later children`, async (t) => {
    const objects = new Map<string, Buffer>();
    let failSecondClinicalWrite = false,
      failed = false;
    const storage: RecordStorage = {
      read: (name) => objects.get(name) || null,
      writeImmutable(name, bytes) {
        if (
          failSecondClinicalWrite &&
          !failed &&
          Number(f.db.prepare('SELECT count(*) n FROM observations').get()!.n) === failAtCount
        ) {
          failed = true;
          throw Error('Storage write failed before publication');
        }
        objects.set(name, Buffer.from(bytes));
      },
      publishHead(bytes) {
        objects.set('head', Buffer.from(bytes));
      },
    };
    const f = fixture(t, storage),
      item = upload(f, [envelope('alpha'), envelope('beta'), envelope('gamma'), envelope('stale')]);
    const input = partial(f, block(f, item.id));
    input.blocks[0]!.selections[3]!.selectionReviewToken = 'fictional-stale-token';
    await planIntakeReportAcceptance(f.db, f.root, f.profileId, input);
    failSecondClinicalWrite = true;
    const result = await acceptPartial(f, input);
    if (result.receipt.atomic) throw Error('Expected partial');
    assert.equal(failed, true);
    assert.deepEqual(
      result.receipt.items.map((i) => i.status),
      failAtCount === 2
        ? ['failed', 'failed', 'not_attempted', 'not_attempted']
        : ['saved', 'saved', 'failed', 'not_attempted'],
    );
    assert.equal(
      f.db.prepare('SELECT count(*) n FROM observations').get()!.n,
      failAtCount === 2 ? 0 : 2,
    );
    assert.deepEqual((await acceptPartial(f, input)).receipt, result.receipt);
  });
test('partial coupled identical assertions reject together while an independent item saves', async (t) => {
  const f = fixture(t),
    first = envelope('same'),
    second = { ...envelope('same'), id: 'same-other' },
    third = envelope('independent');
  second.payload = { literal: 'same source assertion in a second delivery' };
  const item = upload(f, [first, third]),
    other = upload(f, [second], 'second.jsonl');
  const input = partial(f, block(f, item.id), block(f, other.id));
  input.blocks[1]!.selections[0]!.selectionReviewToken = 'stale';
  const result = await acceptPartial(f, input);
  if (result.receipt.atomic) throw Error('Expected partial');
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['needs_review', 'saved', 'needs_review'],
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('operation IDs cannot change between atomic and partial modes', async (t) => {
  const f = fixture(t),
    item = upload(f, [envelope('one'), envelope('two')]);
  const atomic = request(block(f, item.id, null, [0]));
  accept(f, atomic);
  const altered = partial(f, block(f, item.id, null, [1]));
  altered.operationId = atomic.operationId;
  await assert.rejects(() => acceptPartial(f, altered), { code: 'OPERATION_CONFLICT' });
  const next = partial(f, block(f, item.id, null, [1]));
  await acceptPartial(f, next);
  const legacy = structuredClone(next);
  delete legacy.mode;
  assert.throws(() => accept(f, legacy), { code: 'OPERATION_CONFLICT' });
});
test('same-label same-date distinct source events remain independent approvals', async (t) => {
  const f = fixture(t),
    one = envelope('same-label'),
    two = envelope('same-label');
  two.id = 'distinct-event';
  two.provenance.sourceRecordId = 'distinct-event';
  two.clinical = { ...(two.clinical as object), valueText: '19' };
  const item = upload(f, [one, two]);
  const input = partial(f, block(f, item.id));
  input.blocks[0]!.selections[1]!.selectionReviewToken = 'stale';
  const originalSelections = structuredClone(input.blocks[0]!.selections);
  const result = await acceptPartial(f, input);
  if (result.receipt.atomic) throw Error('Expected partial');
  assert.deepEqual(
    result.receipt.items.map((i) => i.status),
    ['saved', 'needs_review'],
  );
  assert.deepEqual(
    result.receipt.items.map((entry) => entry.selectionReviewToken),
    originalSelections.map((entry) => entry.selectionReviewToken),
  );
  assert.deepEqual(input.blocks[0]!.selections, originalSelections);
  assert.deepEqual((await acceptPartial(f, input)).receipt, result.receipt);
});

// An identity question is not an assignment to Self; outcome labels must retain that distinction.
test('partial outcomes do not label an unresolved report owner as Self', async (t) => {
  const f = fixture(t);
  const value = envelope('fictional-unassigned');
  value.clinical = { ...(value.clinical as Record<string, unknown>), subject: 'unknown' };
  value.reviewIssues = [
    { kind: 'identity', field: 'subject', prompt: 'Who does this fictional report belong to?' },
  ];
  value.report!.subject = { locator: 'page 1 patient', text: 'Fictional Iris Meadow' };
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-unassigned.txt',
    bytes: Buffer.from('DEXA FICT-DXA\nFictional Iris Meadow\nFictional count +14.00 mg'),
  });
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    jsonlText: JSON.stringify(value),
    summary: 'Fictional unresolved ownership',
  });
  const proposalId = proposed.proposals.at(-1)!.id;
  const current = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
  assert.equal(current.records[0]!.identityReview?.blocking, true);
  const result = await acceptPartial(f, partial(f, block(f, item.id, proposalId)));
  assert.equal(result.receipt.atomic, false);
  if (result.receipt.atomic) throw Error('Expected partial receipt');
  assert.equal(result.receipt.items[0]?.status, 'needs_review');
  assert.equal(result.receipt.items[0]?.personId, undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

// A failed review cached during initialization is authoritative for this operation.
test('partial commit groups reject a cached unavailable review instead of rereading it', (t) => {
  const f = fixture(t);
  const item = upload(f, [envelope('fictional-unavailable-review')]);
  const input = partial(f, block(f, item.id));
  const cached = new Map([[JSON.stringify([item.id, null]), null]]);
  assert.throws(
    () =>
      applyAcceptanceGroup(
        f.db,
        f.root,
        f.profileId,
        input,
        'fictional-fingerprint',
        () => {},
        cached,
      ),
    { code: 'SELECTION_REVIEW_CHANGED' },
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});

for (const restoreValue of [false, true])
  test(`a chosen comparison ${restoreValue ? 'history' : 'value'} changed between partial batches rejects its old approval while independent saves remain`, async (t) => {
    const f = fixture(t, 'memory');
    const target = upload(f, [envelope('fictional-compared-marker')]);
    const accepted = accept(f, request(block(f, target.id))).receipt;
    const destination = accepted.receipts[0]!.records[0]!.entityId;
    const rows = Array.from({ length: 201 }, (_, i) =>
      envelope(`fictional-independent-comparison-${i}`),
    );
    rows[200]!.clinical = {
      ...(rows[200]!.clinical as object),
      testLabel: 'fictional-compared-marker',
      valueText: '19',
    };
    const item = upload(f, rows, 'fictional-comparison-intake.jsonl');
    const reviewed = intake.reviewIntake(f.db, f.root, f.profileId, item.id);
    const incoming = reviewed.records[200]!;
    const compared = incoming.comparisons?.find((c) => c.id === destination);
    assert.ok(
      compared,
      'the final pending approval explicitly compared this exact saved destination',
    );
    const selected = block(f, item.id);
    selected.selections[200]!.comparisons = [
      {
        otherRecordId: destination,
        scope: compared.scope,
        outcome: 'distinct',
        reason: 'Separate fictional specimens.',
      },
    ];
    const input = { operationId: randomUUID(), mode: 'partial-v1' as const, blocks: [selected] };
    const saving = acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, input);
    await waitForCommittedObservations(t, f, saving, 201, () => {
      const preview = previewDirectRecordCorrection(f.db, f.root, f.profileId, {
        kind: 'observation',
        recordId: destination,
        set: { valueText: '17' },
        reason: 'Fictional source correction after comparison.',
      });
      applyDirectRecordCorrection(f.db, f.root, f.profileId, {
        ...preview.request,
        version: preview.version,
        previewToken: preview.previewToken,
        operationId: 'fictional-late-comparison-correction',
      });
      if (restoreValue) {
        const restored = previewDirectRecordCorrection(f.db, f.root, f.profileId, {
          kind: 'observation',
          recordId: destination,
          set: { valueText: '+14.00' },
          reason: 'Fictional second reviewed correction restores displayed value.',
        });
        applyDirectRecordCorrection(f.db, f.root, f.profileId, {
          ...restored.request,
          version: restored.version,
          previewToken: restored.previewToken,
          operationId: 'fictional-late-comparison-restore',
        });
      }
    });
    const receipt = (await saving).receipt;
    if (receipt.atomic) throw Error('Expected partial receipt');
    assert.equal(receipt.acceptedCount, 200);
    assert.equal(receipt.items[200]!.status, 'needs_review');
    assert.equal(receipt.items[200]!.reasonCode, 'DUPLICATE_SCOPE_CHANGED');
    assert.equal(
      f.db.prepare('SELECT value_text FROM observations WHERE id=?').get(destination)!.value_text,
      restoreValue ? '+14.00' : '17',
    );
    assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 201);
  });

test('cold singleton duplicates avoid derived indexes without appending retained occurrences', async (t) => {
  const objects = new Map<string, Buffer>(),
    diagnostic = createRecordPublicationDiagnostic(objects),
    storage: RecordStorage = {
      read: (name) => objects.get(name) || null,
      writeImmutable(name, value) {
        const old = objects.get(name);
        if (old) assert.deepEqual(value, old);
        objects.set(name, Buffer.from(value));
        diagnostic.immutable(name, value.length);
      },
      publishHead(value) {
        objects.set('head', Buffer.from(value));
        diagnostic.published(value);
      },
    },
    f = fixture(t, storage),
    item = upload(f, [envelope('fictional-cold-one'), envelope('fictional-cold-two')]),
    input = partial(f, block(f, item.id));
  const before = intake
    .getIntake(f.db, f.root, f.profileId, item.id)
    .workflow!.candidates.map((candidate) => ({
      id: candidate.id,
      versions: candidate.versions.map((version) => ({
        id: version.id,
        occurrences: structuredClone(version.occurrences),
      })),
    }));
  await intake.ensureNativeIntakeSchema(f.db, f.profileId, item.id);
  assert.equal(before.length, 2);
  assert.ok(
    before.every(
      (candidate) =>
        candidate.versions.length === 1 && candidate.versions[0]!.occurrences.length === 1,
    ),
  );
  diagnostic.phase('cold-save');
  const result = await acceptPartial(f, input),
    inventory = diagnostic.inventory(f.db),
    catalogHeads = inventory.publications.filter(
      (head) =>
        head.phase === 'cold-save' &&
        head.stack.some((frame) => frame.includes('/intake-report-snapshot-catalog.ts:')),
    );
  assert.equal(result.receipt.acceptedCount, 2);
  assert.equal(
    catalogHeads.length,
    4,
    'only contribution-index checkpoints remain, including its catalog initialization',
  );
  const native = JSON.parse([...iterateIntakeEnvelopeText(f.db, { id: item.id })].join('')) as {
    intake: { workflow: NonNullable<Intake['workflow']> };
  };
  const after = native.intake.workflow.candidates.map((candidate) => ({
    id: candidate.id,
    versions: candidate.versions.map((version) => ({
      id: version.id,
      occurrences: structuredClone(version.occurrences),
    })),
  }));
  assert.deepEqual(
    after,
    before,
    'duplicate proof never appends or changes retained occurrence evidence',
  );
  const publications = inventory.publications.length;
  assert.deepEqual((await acceptPartial(f, input)).receipt, result.receipt);
  assert.equal(diagnostic.inventory(f.db).publications.length, publications);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
});
