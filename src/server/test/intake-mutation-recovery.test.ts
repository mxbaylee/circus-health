import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import {
  openContributorRecordStorage,
  contributorOriginalVerifier,
  type ContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile, attachPersonalDurability } from '../portable.ts';
import type { IntakeReportAcceptanceRequest } from '../../shared/intake.ts';
import { createEncryptedProfiles, type OpenedProfile } from '../encrypted-profiles.ts';
import * as intake from '../intake.ts';
import { createManualSourceRecord } from '../intake-manual-source-record.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText } from '../intake-source-text.ts';
import { readIntakeSourcePin } from '../intake-source-pin.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { maximumReportDiscoveryOrder, retainedReportAcceptance } from '../intake-state-access.ts';
import { createSourceDetailsSearch } from '../source-details-search.ts';
import { getIntakeIdentityReview } from '../intake-identity.ts';
import { getIntakePeopleQueue } from '../intake-people.ts';
import { getNote } from '../notes.ts';
import {
  acceptIntakeReportSelection,
  getIntakeReportAcceptance,
} from '../intake-report-acceptance.ts';
import { createMutationFixture, fictionalEnvelope } from './helpers/intake-mutation-fixture.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';

function search(db: Database, term: string) {
  const plan = createSourceDetailsSearch(db, term);
  try {
    return db
      .prepare(
        `SELECT f.id FROM source_files f ${plan.joins} WHERE ${plan.predicate} ORDER BY f.id`,
      )
      .all(...plan.parameters)
      .map((row) => row.id);
  } finally {
    plan.dispose();
  }
}
const rows = (db: Database, table: string) =>
  db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all();
function request(
  state: Pick<OpenedProfile, 'db' | 'root' | 'id'>,
  id: string,
  proposalId: string,
  operationId = randomUUID(),
): IntakeReportAcceptanceRequest {
  const review = intake.reviewIntake(state.db, state.root, state.id, id, proposalId);
  return {
    operationId,
    blocks: [
      {
        intakeId: id,
        proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: review.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          selectionReviewToken: record.selectionReviewToken,
          mapping: {},
        })),
      },
    ],
  };
}
function capture(state: OpenedProfile, id: string, proposalId: string, operationId: string) {
  const view = intake.getIntake(state.db, state.root, state.id, id);
  return {
    serialized: readIntakeEnvelopeText(state.db, { id }),
    workflow: view.workflow,
    version: view.version,
    proposals: view.proposals,
    pin: readIntakeSourcePin(state.db, id),
    sourceText: getIntakeSourceText(state.db, state.root, state.id, id).revision!.spans,
    review: intake.reviewIntake(state.db, state.root, state.id, id, proposalId).records,
    order: intake.listIntakes(state.db, state.id, {}, state.root).data.map((item) => item.id),
    discovery: maximumReportDiscoveryOrder(state.db),
    lookup: retainedReportAcceptance(state.db, operationId),
    receipt: getIntakeReportAcceptance(state.db, state.root, state.id, operationId).receipt,
    search: ['Fictional reading', '12.50', 'pending-only-term'].map((term) =>
      search(state.db, term),
    ),
    people: view.workflow!.reportGroups!.map((group) =>
      getIntakePeopleQueue(state.db, state.root, state.id, group.id),
    ),
    observations: rows(state.db, 'observations'),
    sourceRecords: rows(state.db, 'source_records'),
  };
}

// This source, literal and clinical oracle are authored here independently of the storage codec.
test('real human records and duplicate review retain exact pending state through private copy, lock, restart and total encrypted cache loss', async (t) => {
  let manager!: ReturnType<typeof createEncryptedProfiles>;
  t.after(() => manager?.close());
  const f = vaultFixture(t);
  const created = await newProfile(f.manager, 'Fictional recovery owner');
  manager = f.manager;
  let source = manager.opened.get(created.profile.id)!;
  const bytes = Buffer.from(
    'Fictional recovery owner\nFictional reading: 12.50 units\nFictional second reading: 7.25 units',
  );
  const item = intake.uploadIntake(source.db, source.root, source.id, {
    filename: 'fictional-human.txt',
    bytes,
    newProviderName: 'Fictional manual clinic',
  });
  await intakeSourceRoute({
    db: source.db,
    root: source.root,
    profileId: source.id,
    id: item.id,
    action: 'source-extract',
    params: new URLSearchParams(),
    input: { operationId: randomUUID(), expectedRevisionId: null },
  });
  const revision = getIntakeSourceText(source.db, source.root, source.id, item.id).revision!;
  const manual = (valueText: string, literalText: string) =>
    createManualSourceRecord(source.db, source.root, source.id, item.id, {
      version: intake.getIntake(source.db, source.root, source.id, item.id).version,
      operationId: randomUUID(),
      sourceHash: item.sha256,
      sourceTextRevisionId: revision.id,
      scope: { page: 1 },
      person: { kind: 'self', expectedVersion: getNote(source.db, 'person-note:self').version },
      literalText,
      clinical: {
        kind: 'observation',
        testLabel: 'Fictional reading',
        valueText,
        unit: 'units',
        date: '2026-09-01',
      },
    });
  const first = manual('12.50', 'Fictional reading: 12.50 units');
  const originalRequest = request(source, item.id, first.proposalId);
  const saved = acceptIntakeReportSelection(source.db, source.root, source.id, originalRequest);
  assert.equal(saved.receipt.acceptedCount, 1);
  assert.deepEqual(
    source.db
      .prepare('SELECT label,value_text,unit,effective_at FROM observations')
      .all()
      .map((row) => ({ ...row })),
    [
      {
        label: 'Fictional reading',
        value_text: '12.50',
        unit: 'units',
        effective_at: '2026-09-01',
      },
    ],
  );
  const duplicate = manual('12.50', 'Fictional reading: 12.50 units');
  const duplicateReview = intake.reviewIntake(
    source.db,
    source.root,
    source.id,
    item.id,
    duplicate.proposalId,
  );
  assert.ok(duplicateReview.records[0]!.comparisons!.length > 0);
  const comparison = duplicateReview.records[0]!.comparisons![0]!;
  intake.importIntake(source.db, source.root, source.id, item.id, {
    version: duplicateReview.version,
    proposalId: duplicate.proposalId,
    reviewToken: duplicateReview.reviewToken,
    decisions: [
      {
        recordId: duplicateReview.records[0]!.id,
        action: 'skip',
        mapping: {},
        comparisons: [
          {
            otherRecordId: comparison.id,
            scope: comparison.scope,
            outcome: 'unresolved',
            reason: 'Fictional duplicate decision remains pending.',
          },
        ],
      },
    ],
  });
  const pending = manual('7.25', 'Fictional second reading: 7.25 units');
  let review = intake.reviewIntake(source.db, source.root, source.id, item.id, pending.proposalId);
  const stale = request(source, item.id, pending.proposalId);
  intake.saveIntakeReviewDraft(source.db, source.root, source.id, item.id, {
    version: review.version,
    operationId: randomUUID(),
    proposalId: pending.proposalId,
    recordId: review.records[0]!.id,
    candidateVersionId: review.records[0]!.candidateVersionId!,
    disposition: 'review_later',
    mapping: { unit: 'units' },
  });
  assert.throws(() => acceptIntakeReportSelection(source.db, source.root, source.id, stale), {
    code: 'VERSION_CONFLICT',
  });
  review = intake.reviewIntake(source.db, source.root, source.id, item.id, pending.proposalId);
  intake.askIntakeQuestion(source.db, source.root, source.id, item.id, {
    version: review.version,
    operationId: randomUUID(),
    key: 'pending-only-term',
    candidateId: review.records[0]!.candidateId!,
    candidateVersionId: review.records[0]!.candidateVersionId!,
    prompt: 'Fictional pending-only-term question?',
    locator: 'fictional line 3',
    field: 'valueText',
  });
  const before = capture(source, item.id, pending.proposalId, originalRequest.operationId);
  assert.ok(before.pin);
  assert.deepEqual(
    before.search.map((ids) => ids.includes(item.id)),
    [true, true, true],
  );
  const originalHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(item.sha256, originalHash);
  const setup = manager.begin({ name: 'Fictional independent copy', copyFrom: source.id });
  await manager.verify(setup.setupId, { acknowledged: true, recovery: setup.recoveryKit });
  // Manual receipt owner bindings are intentionally retained as source evidence during copy.
  for (const [id, kit] of [
    [source.id, created.recoveryKit],
    [setup.profileId, setup.recoveryKit],
  ] as const) {
    const current = capture(
      manager.opened.get(id)!,
      item.id,
      pending.proposalId,
      originalRequest.operationId,
    );
    const { review: sourceReview, ...sourceRetained } = before;
    const { review: targetReview, ...targetRetained } = current;
    assert.deepEqual(targetRetained, sourceRetained);
    assert.equal(targetReview[0]!.identityAttribution?.basis, 'explicit_manual_source_record');
    assert.deepEqual(targetReview[0]!.identityAttribution, sourceReview[0]!.identityAttribution);
    const check = () => {
      const state = manager.opened.get(id)!;
      assert.deepEqual(
        capture(state, item.id, pending.proposalId, originalRequest.operationId),
        current,
      );
      const original = intake.getIntakeOriginal(state.db, state.root, id, item.id).bytes;
      assert.deepEqual(original, bytes);
      assert.equal(createHash('sha256').update(original).digest('hex'), originalHash);
      const replay = acceptIntakeReportSelection(state.db, state.root, id, originalRequest);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, saved.receipt);
      assert.deepEqual(rows(state.db, 'observations'), before.observations);
    };
    check();
    manager.lock(id);
    manager.unlock(id, kit);
    check();
    manager.lock(id);
    rmSync(resolve(manager.pathFor(id), 'cache'), { recursive: true, force: true });
    manager.unlock(id, kit);
    check();
  }
  const reopenedExpected = new Map(
    [created.profile.id, setup.profileId].map((id) => [
      id,
      capture(manager.opened.get(id)!, item.id, pending.proposalId, originalRequest.operationId),
    ]),
  );
  manager.close();
  manager = createEncryptedProfiles({
    dataDirectory: f.dataDirectory,
    runtimeDirectory: f.runtimeDirectory,
  });

  for (const [id, kit] of [
    [created.profile.id, created.recoveryKit],
    [setup.profileId, setup.recoveryKit],
  ] as const) {
    manager.unlock(id, kit);
    source = manager.opened.get(id)!;
    assert.deepEqual(
      capture(source, item.id, pending.proposalId, originalRequest.operationId),
      reopenedExpected.get(id),
    );
  }
  manager.close();
});

for (const boundary of [
  'staging',
  'immutable-write',
  'before-head',
  'published-head-sql-rollback',
  'lost-acknowledgement',
] as const) {
  test(`real batch reviewed acceptance recovers at ${boundary} without duplicated receipts or lost decisions`, async (t) => {
    let backend!: ContributorRecordStorage;
    let f!: Awaited<ReturnType<typeof createMutationFixture>>;
    t.after(() => {
      f?.close();
      backend?.close();
    });
    f = await createMutationFixture(t, {
      verifyReferencesFactory: contributorOriginalVerifier,
      storageFactory(root, profileId) {
        backend = openContributorRecordStorage(root, profileId, { initialize: true });
        return {
          read: (name) => backend.read(name),
          writeImmutable: (name, bytes) => backend.writeImmutable(name, bytes),
          publishHead: (bytes) => backend.publishHead(bytes),
        };
      },
    });
    const freshBackend = () => {
      f.close();
      backend.close();
      backend = openContributorRecordStorage(f.root, f.profileId);
    };
    await f.prepare(0);
    const earlier = f.accept(0, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await f.prepare(1);
    await f.prepare(2); // Retained sibling review must survive acceptance failure and recovery.
    const input = f.acceptanceRequest(1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const before = recoveryCapture(f);
    assert.throws(() => acceptIntakeReportSelection(f.db, f.root, 'fictional-other-owner', input), {
      code: 'PROFILE_BOUNDARY',
    });
    assert.deepEqual(recoveryCapture(f), before);
    const retainedObjects = new Map(
      [...f.objects]
        .filter(([name]) => name !== 'head')
        .map(([name]) => [name, backend.read(name)]),
    );
    const immutable = f.storage.writeImmutable;
    const publish = f.storage.publishHead;
    let hits = 0;
    if (boundary === 'staging')
      f.db.exec(
        `CREATE TEMP TRIGGER fictional_staging_failure BEFORE INSERT ON main.app_meta WHEN NEW.key GLOB 'intake_state_v1:*:frame:*' BEGIN SELECT RAISE(ABORT,'fictional staging failure'); END`,
      );
    else if (boundary === 'immutable-write')
      f.storage.writeImmutable = () => {
        hits++;
        throw Error('fictional immutable-write failure');
      };
    else if (boundary === 'before-head' || boundary === 'lost-acknowledgement')
      f.storage.publishHead = (bytes) => {
        hits++;
        if (boundary === 'lost-acknowledgement') publish(bytes);
        throw Error('fictional ' + boundary + ' failure');
      };
    else {
      const exec = f.db.exec.bind(f.db);
      t.mock.method(f.db, 'exec', (sql: string) => {
        if (sql === 'COMMIT') {
          hits++;
          throw Error('fictional published-head-sql-rollback failure');
        }
        return exec(sql);
      });
    }
    assert.throws(() => acceptIntakeReportSelection(f.db, f.root, f.profileId, input), /fictional/);
    f.storage.writeImmutable = immutable;
    f.storage.publishHead = publish;
    if (boundary === 'staging') f.db.exec('DROP TRIGGER fictional_staging_failure');
    else assert.ok(hits > 0, 'the intended real publication boundary was reached');
    t.mock.restoreAll();
    for (const [name, bytes] of retainedObjects) assert.deepEqual(backend.read(name), bytes);
    assert.deepEqual(
      f.db
        .prepare('SELECT value_text FROM observations ORDER BY label')
        .all()
        .map((row) => row.value_text),
      ['< 0.030'],
    );
    const published =
      boundary === 'published-head-sql-rollback' || boundary === 'lost-acknowledgement';
    if (published) {
      assert.throws(
        () => intake.getIntake(f.db, f.root, f.profileId, f.original.id),
        /accepted|authority|current|dirty|recovery/i,
      );
      await assert.rejects(
        createBackup(f.db, f.root, f.profileId),
        /accepted|authority|current|journal|coheren|recovery|state/i,
      );
    } else assert.deepEqual(recoveryCapture(f), before);
    // True total projection loss selects the accepted journal, never failed SQL state.
    freshBackend();
    f.rebuild();
    assert.deepEqual(
      getIntakeReportAcceptance(f.db, f.root, f.profileId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        .receipt,
      earlier.receipt,
    );
    if (!published) {
      assert.deepEqual(recoveryCapture(f), before);
      assert.throws(() => getIntakeReportAcceptance(f.db, f.root, f.profileId, input.operationId), {
        code: 'REPORT_ACCEPTANCE_NOT_FOUND',
      });
    }
    const recovered = acceptIntakeReportSelection(f.db, f.root, f.profileId, input);
    assert.equal(recovered.replayed, published);
    assert.equal(recovered.receipt.operationId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(recovered.receipt.acceptedCount, 1);
    assert.equal(recovered.receipt.selectedCount, 1);
    assert.deepEqual(
      f.db
        .prepare(
          'SELECT label,value_text,unit,effective_at,date_precision FROM observations ORDER BY label',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          label: 'Invented serum measure 0',
          value_text: '< 0.030',
          unit: 'mg/L',
          effective_at: '2025-04',
          date_precision: 'month',
        },
        {
          label: 'Invented serum measure 1',
          value_text: '+004.500',
          unit: 'mg/L',
          effective_at: '2025-04',
          date_precision: 'month',
        },
      ],
    );
    const current = recoveryCapture(f);
    const view = intake.getIntake(f.db, f.root, f.profileId, f.original.id);
    assert.equal(
      view.workflow!.reportAcceptances!.filter(
        (entry) => entry.receipt.operationId === input.operationId,
      ).length,
      1,
    );
    const pending = intake.reviewIntake(
      f.db,
      f.root,
      f.profileId,
      f.original.id,
      f.proposals.get(2)!,
    );
    assert.equal(pending.records[0]!.reviewState, 'pending');
    assert.deepEqual(
      acceptIntakeReportSelection(f.db, f.root, f.profileId, input).receipt,
      recovered.receipt,
    );
    assert.deepEqual(recoveryCapture(f), current);
    freshBackend();
    f.reopen();
    assert.deepEqual(recoveryCapture(f), current);
    freshBackend();
    f.rebuild();
    assert.deepEqual(recoveryCapture(f), current);
    assert.deepEqual(
      intake.getIntakeOriginal(f.db, f.root, f.profileId, f.original.id).bytes,
      f.original.bytes,
    );
    assert.equal(createHash('sha256').update(f.original.bytes).digest('hex'), f.original.sha256);
  });
}

function recoveryCapture(f: Awaited<ReturnType<typeof createMutationFixture>>) {
  const view = intake.getIntake(f.db, f.root, f.profileId, f.original.id);
  return {
    serialized: readIntakeEnvelopeText(f.db, { id: f.original.id }),
    workflow: view.workflow,
    version: view.version,
    proposals: view.proposals,
    pin: readIntakeSourcePin(f.db, f.original.id),
    order: intake.listIntakes(f.db, f.profileId, {}, f.root).data.map((item) => item.id),
    discovery: maximumReportDiscoveryOrder(f.db),
    reviews: [...f.proposals.values()].map(
      (proposalId) =>
        intake.reviewIntake(f.db, f.root, f.profileId, f.original.id, proposalId).records,
    ),
    lookups: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'].map(
      (id) => retainedReportAcceptance(f.db, id),
    ),
    search: ['Invented serum measure 0', '+004.500', 'specimen-2'].map((term) =>
      search(f.db, term),
    ),
    observations: rows(f.db, 'observations'),
    sourceRecords: rows(f.db, 'source_records'),
  };
}

test('a coherent contributor backup retains actual clinical acceptance and pending review after journal reconstruction', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-intake-backup-'));
  const databases = new Map<string, Database>();
  const actions = createProfileLifecycle({ root, databases });
  t.after(() => {
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const profile = await actions.create({
    name: 'Fictional backup owner',
    fullName: 'Fictional backup owner',
    birthDate: '1982-04-17',
  });
  const db = databases.get(profile.id)!;
  const bytes = Buffer.from(
    [0, 1].map((index) => JSON.stringify(fictionalEnvelope(index))).join('\n'),
  );
  const item = intake.uploadIntake(db, root, profile.id, {
    filename: 'fictional-backup.jsonl',
    bytes,
    newProviderName: 'Invented receiving clinic',
  });
  const review = intake.reviewIntake(db, root, profile.id, item.id);
  const record = review.records[0]!;
  const input: IntakeReportAcceptanceRequest = {
    operationId: randomUUID(),
    blocks: [
      {
        intakeId: item.id,
        proposalId: null,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: [
          {
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            selectionReviewToken: record.selectionReviewToken,
            mapping: {},
          },
        ],
      },
    ],
  };
  const accepted = acceptIntakeReportSelection(db, root, profile.id, input);
  const latest = intake.reviewIntake(db, root, profile.id, item.id);
  const pending = latest.records.find((row) => row.id !== record.id)!;
  intake.saveIntakeReviewDraft(db, root, profile.id, item.id, {
    version: latest.version,
    operationId: randomUUID(),
    proposalId: null,
    recordId: pending.id,
    candidateVersionId: pending.candidateVersionId!,
    disposition: 'review_later',
  });
  const foreign = intake.uploadIntake(db, root, profile.id, {
    filename: 'fictional-wrong-person.json',
    bytes: Buffer.from(
      JSON.stringify({
        reportTitle: 'Fictional conflicting report',
        patient: { name: 'Fictional backup owner', dob: '1950-01-05' },
        result: 'Fictional count 7.20',
      }),
    ),
    newProviderName: 'Invented receiving clinic',
  });
  const foreignEnvelope = fictionalEnvelope(2);
  foreignEnvelope.clinical = { ...(foreignEnvelope.clinical as object), subject: 'unknown' };
  foreignEnvelope.report = {
    key: 'wrong-person',
    title: 'Fictional conflicting report',
    anchor: { locator: 'page 1 heading', text: 'Fictional conflicting report' },
    subject: { locator: 'page 1 patient', text: 'Fictional backup owner' },
  };
  const proposed = intake.proposeConversion(db, root, profile.id, foreign.id, {
    version: foreign.version,
    summary: 'Fictional conflicting identity',
    jsonlText: JSON.stringify(foreignEnvelope),
  });
  const identity = await getIntakeIdentityReview(
    db,
    root,
    profile.id,
    foreign.id,
    proposed.workflow!.reportGroups![0]!.id,
  );
  assert.equal(identity.evidencedIdentity.birthDate, '1950-01-05');
  assert.equal(identity.selfBirthDateConflict, true);
  assert.equal(identity.blocking, true);
  const refused = request({ db, root, id: profile.id }, foreign.id, proposed.proposals[0]!.id);
  const beforeRefusal = readIntakeEnvelopeText(db, { id: foreign.id });
  assert.throws(() => acceptIntakeReportSelection(db, root, profile.id, refused));
  assert.equal(readIntakeEnvelopeText(db, { id: foreign.id }), beforeRefusal);
  assert.throws(() => getIntakeReportAcceptance(db, root, profile.id, refused.operationId), {
    code: 'REPORT_ACCEPTANCE_NOT_FOUND',
  });
  const expected = {
    serialized: readIntakeEnvelopeText(db, { id: item.id }),
    workflow: intake.getIntake(db, root, profile.id, item.id).workflow,
    observations: rows(db, 'observations'),
    sourceRecords: rows(db, 'source_records'),
    pin: readIntakeSourcePin(db, item.id),
    search: search(db, '+004.500'),
  };
  assert.deepEqual(
    db
      .prepare('SELECT label,value_text,unit,effective_at,date_precision FROM observations')
      .all()
      .map((row) => ({ ...row })),
    [
      {
        label: 'Invented serum measure 0',
        value_text: '< 0.030',
        unit: 'mg/L',
        effective_at: '2025-04',
        date_precision: 'month',
      },
    ],
  );
  const backup = await createBackup(db, root, profile.id);
  const rebuilt = rebuildProfile(
    resolve(backup.path, 'files'),
    profile.id,
    resolve(root, 'independent-backup-rebuild'),
  );
  const recovered = openDatabase(rebuilt.database, profile.id);
  t.after(() => {
    if (recovered.isOpen) recovered.close();
  });
  attachPersonalDurability(recovered, {
    root: resolve(backup.path, 'files'),
    profileId: profile.id,
  });
  assert.deepEqual(
    {
      serialized: readIntakeEnvelopeText(recovered, { id: item.id }),
      workflow: intake.getIntake(recovered, resolve(backup.path, 'files'), profile.id, item.id)
        .workflow,
      observations: rows(recovered, 'observations'),
      sourceRecords: rows(recovered, 'source_records'),
      pin: readIntakeSourcePin(recovered, item.id),
      search: search(recovered, '+004.500'),
    },
    expected,
  );
  assert.deepEqual(
    getIntakeReportAcceptance(
      recovered,
      resolve(backup.path, 'files'),
      profile.id,
      input.operationId,
    ).receipt,
    accepted.receipt,
  );
  assert.deepEqual(
    intake.getIntakeOriginal(recovered, resolve(backup.path, 'files'), profile.id, item.id).bytes,
    bytes,
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
  assert.equal(readIntakeEnvelopeText(recovered, { id: foreign.id }), beforeRefusal);
  assert.throws(
    () =>
      getIntakeReportAcceptance(
        recovered,
        resolve(backup.path, 'files'),
        profile.id,
        refused.operationId,
      ),
    { code: 'REPORT_ACCEPTANCE_NOT_FOUND' },
  );
  assert.throws(() =>
    acceptIntakeReportSelection(recovered, resolve(backup.path, 'files'), profile.id, refused),
  );
  assert.equal(rows(recovered, 'observations').length, 1);
  recovered.close();
});
