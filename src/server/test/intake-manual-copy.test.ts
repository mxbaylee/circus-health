import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction, type Database } from '../database.ts';
import { createProfileLifecycle, type ProfileCopyCheckpointContext } from '../profile-lifecycle.ts';
import { getIntake, uploadIntake, reviewIntake, proposeConversion } from '../intake.ts';
import {
  createManualSourceRecord,
  createManualSourceRecordRead,
} from '../intake-manual-source-record.ts';
import {
  prepareManualSourceCopy,
  stageManualSourceCopy,
  copiedManualSourceRecordApplies,
} from '../intake-manual-copy.ts';
import { intakeSourceRoute } from '../intake-source-routes.ts';
import { getIntakeSourceText, reviewIntakeSourceText } from '../intake-source-text.ts';
import { createNote, getNote } from '../notes.ts';
import { setVisibility } from '../visibility.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { profilePaths } from '../profile-storage.ts';
import { rebuildContributorDatabase } from '../contributor-durability.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import type { ManualSourceRecordRequest } from '../../shared/intake-manual-source-record.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { iterateIntakeEnvelopeText } from '../intake-collection-envelope.ts';

const proofs = (db: Database) =>
  db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_manual_copy:*' ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
async function fixture(t: TestContext, family = false, fullName = 'Fictional child') {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-manual-copy-'));
  const databases = new Map<string, Database>();
  let beforeStage: (context: ProfileCopyCheckpointContext) => void = () => {};
  const lifecycle = createProfileLifecycle({
    root,
    databases,
    copyCheckpoint: (checkpoint, context) => {
      if (checkpoint === 'validated') beforeStage(context);
    },
  });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await lifecycle.create({
    name: 'Fictional manual author',
    fullName: 'Fictional manual author',
    birthDate: '1982-04-17',
  });
  const db = databases.get(source.id)!;
  const person = family
    ? createNote(db, {
        kind: 'person',
        title: 'Fictional child',
        person: { fullName },
      })
    : getNote(db, 'person-note:self');
  const original = uploadIntake(db, root, source.id, {
    filename: 'fictional-manual.txt',
    bytes: Buffer.from('Fictional manual author\nFictional reading: 12.50 units'),
    newProviderName: 'Fictional clinic',
  });
  await intakeSourceRoute({
    db,
    root,
    profileId: source.id,
    id: original.id,
    action: 'source-extract',
    params: new URLSearchParams(),
    input: { operationId: randomUUID(), expectedRevisionId: null },
  });
  const request: ManualSourceRecordRequest = {
    version: getIntake(db, root, source.id, original.id).version,
    operationId: randomUUID(),
    sourceHash: original.sha256,
    sourceTextRevisionId: getIntakeSourceText(db, root, source.id, original.id).revision!.id,
    scope: { page: 1 },
    person: family
      ? { kind: 'person', noteId: person.id, expectedVersion: person.version }
      : { kind: 'self', expectedVersion: person.version },
    literalText: 'Fictional reading: 12.50 units',
    clinical: {
      kind: 'observation',
      testLabel: 'Fictional reading',
      valueText: '12.50',
      unit: 'units',
      date: '2026-09-01',
    },
  };
  const manual = createManualSourceRecord(db, root, source.id, original.id, request);
  const review = (profileId: string, proposalId = manual.proposalId) =>
    reviewIntake(databases.get(profileId)!, root, profileId, original.id, proposalId);
  const copy = (sourceId = source.id, operationId = randomUUID()) =>
    lifecycle.create({ name: 'Fictional copy ' + randomUUID(), operationId }, sourceId);
  const accept = (profileId: string, proposalId = manual.proposalId) => {
    const current = review(profileId, proposalId);
    return acceptIntakeReportSelection(databases.get(profileId)!, root, profileId, {
      operationId: randomUUID(),
      blocks: [
        {
          intakeId: original.id,
          proposalId,
          intakeVersion: current.version,
          reviewToken: current.reviewToken,
          selections: current.records.map((record) => ({
            recordId: record.id,
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            selectionReviewToken: record.selectionReviewToken,
            mapping: {},
          })),
        },
      ],
    });
  };
  return {
    root,
    databases,
    lifecycle,
    source,
    db,
    person,
    original,
    request,
    manual,
    review,
    copy,
    accept,
    setBeforeStage: (hook: typeof beforeStage) => {
      beforeStage = hook;
    },
  };
}

// This host integration converts a 270KB retained Unicode author receipt, copies
// and rebuilds selected authority, then replays the exact manual operation.
test(
  'native schema copy preserves real manual author receipt and source pins through selected authority rebuild',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t, true, '界'.repeat(90000));
    await buildIntakeCollectionEnvelope(f.db, { id: f.original.id });
    const sourceText = [...iterateIntakeEnvelopeText(f.db, { id: f.original.id })].join('');
    const copy = await f.copy(),
      target = f.databases.get(copy.id)!;
    assert.equal(
      [...iterateIntakeEnvelopeText(target, { id: f.original.id })].join(''),
      sourceText,
    );
    const receipt = f.manual.intake.proposals[0]!.manualSourceRecord!;
    const scope = {
      profileId: copy.id,
      intakeId: f.original.id,
      sourceHash: f.original.sha256,
      proposalId: f.manual.proposalId,
      proposalHash: String(
        target.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.manual.proposalId)!
          .sha256,
      ),
    };
    assert.equal(copiedManualSourceRecordApplies(target, scope, receipt), true);
    assert.equal(receipt.profileId, f.source.id);
    assert.equal(proofs(target).length, 1);
    const replay = await createManualSourceRecordRead(
      target,
      f.root,
      copy.id,
      f.original.id,
      f.request,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.proposalId, f.manual.proposalId);
    assert.ok('format' in replay.intake);
    assert.equal(proofs(target).length, 1);
  },
);

test('genuine contributor manual copy preserves exact receipt, review and replay and supports new acceptance and nested authorship', async (t) => {
  const f = await fixture(t);
  const before = readIntakeEnvelopeText(f.db, { id: f.original.id });
  const attribution = f.review(f.source.id).records[0].identityAttribution!;
  const first = await f.copy(),
    target = f.databases.get(first.id)!;
  assert.equal(readIntakeEnvelopeText(target, { id: f.original.id }), before);
  assert.deepEqual(f.review(first.id).records[0].identityAttribution, attribution);
  const replay = createManualSourceRecord(target, f.root, first.id, f.original.id, f.request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.proposalId, f.manual.proposalId);
  assert.equal(f.accept(first.id).receipt.acceptedCount, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM observations').get()!.n, 0);
  assert.equal(target.prepare('SELECT value_text FROM observations').get()!.value_text, '12.50');
  const originalProof = proofs(target)[0];
  assert.ok(Buffer.byteLength(originalProof.value) < 2000);
  const later = createManualSourceRecord(target, f.root, first.id, f.original.id, {
    ...f.request,
    version: getIntake(target, f.root, first.id, f.original.id).version,
    operationId: randomUUID(),
    person: { kind: 'self', expectedVersion: getNote(target, 'person-note:self').version },
    literalText: 'Fictional later reading: 7.25 units',
    clinical: { ...f.request.clinical, valueText: '7.25' },
  });
  const second = await f.copy(first.id),
    nested = f.databases.get(second.id)!;
  assert.deepEqual(f.review(second.id).records[0].identityAttribution, attribution);
  assert.equal(
    f.review(second.id, later.proposalId).records[0].identityAttribution!.basis,
    'explicit_manual_source_record',
  );
  assert.equal(f.accept(second.id, later.proposalId).receipt.acceptedCount, 1);
  assert.deepEqual(
    nested
      .prepare('SELECT value_text FROM observations ORDER BY value_text')
      .all()
      .map((row) => row.value_text),
    ['12.50', '7.25'],
  );
  assert.equal(
    nested
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(`private_copy_source_receipt:v1:${first.id}:${originalProof.key}`)?.value,
    originalProof.value,
  );
  assert.deepEqual(
    getIntake(nested, f.root, second.id, f.original.id).proposals.find(
      (p) => p.id === f.manual.proposalId,
    )!.manualSourceRecord,
    f.manual.intake.proposals[0].manualSourceRecord,
  );
});

test('a foreign host receipt without validated prior copy proof never gains target assignment', async (t) => {
  const f = await fixture(t);
  const file = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.manual.proposalId)!;
  const envelope = JSON.parse(readFileSync(resolve(f.root, String(file.path)), 'utf8'));
  const claimedPerson = createNote(f.db, {
    kind: 'person',
    title: 'Fictional foreign assignment',
    person: { fullName: 'Fictional foreign assignment' },
  });
  const receipt = {
    ...f.manual.intake.proposals[0].manualSourceRecord!,
    profileId: 'fictional-foreign-owner',
    operationId: randomUUID(),
    person: {
      noteId: claimedPerson.id,
      personId: claimedPerson.personId!,
      version: claimedPerson.version,
      fullName: claimedPerson.title,
    },
  };
  envelope.id = 'manual:' + receipt.operationId;
  const proposal = proposeConversion(
    f.db,
    f.root,
    f.source.id,
    f.original.id,
    {
      version: getIntake(f.db, f.root, f.source.id, f.original.id).version,
      jsonlText: JSON.stringify(envelope),
      summary: 'Fictional foreign host receipt',
    },
    { manualSourceRecord: receipt },
  );
  const proposalId = proposal.proposals.find(
    (p) => p.manualSourceRecord?.operationId === receipt.operationId,
  )!.id;
  assert.notEqual(
    f.review(f.source.id, proposalId).records[0].identityAttribution?.basis,
    'explicit_manual_source_record',
  );
  const copy = await f.copy();
  assert.notEqual(
    f.review(copy.id, proposalId).records[0].identityAttribution?.basis,
    'explicit_manual_source_record',
  );
  assert.equal(
    f.review(copy.id, proposalId).records[0].identityAttribution?.manualSourceRecord,
    undefined,
  );
  assert.notEqual(
    f.review(copy.id, proposalId).records[0].identityAttribution?.assignedPerson?.noteId,
    claimedPerson.id,
  );
  assert.equal(
    proofs(f.databases.get(copy.id)!).length,
    1,
    'only the legitimate native proposal receives a proof',
  );
});

test('target-bound proof rejects transplantation, changed hashes and receipt tampering', async (t) => {
  const f = await fixture(t),
    first = await f.copy(),
    second = await f.copy();
  const one = f.databases.get(first.id)!,
    two = f.databases.get(second.id)!;
  const receipt = f.manual.intake.proposals[0].manualSourceRecord!;
  const scope = {
    profileId: first.id,
    intakeId: f.original.id,
    sourceHash: f.original.sha256,
    proposalId: f.manual.proposalId,
    proposalHash: String(
      one.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.manual.proposalId)!.sha256,
    ),
  };
  assert.equal(copiedManualSourceRecordApplies(one, scope, receipt), true);
  assert.throws(
    () => copiedManualSourceRecordApplies(one, { ...scope, sourceHash: '0'.repeat(64) }, receipt),
    /does not match target/,
  );
  assert.throws(
    () => copiedManualSourceRecordApplies(one, { ...scope, proposalHash: '0'.repeat(64) }, receipt),
    /does not match target/,
  );
  for (const changed of [{ proposalId: 'foreign-proposal' }, { intakeId: 'foreign-intake' }])
    assert.equal(copiedManualSourceRecordApplies(one, { ...scope, ...changed }, receipt), false);
  assert.throws(
    () =>
      copiedManualSourceRecordApplies(one, scope, {
        ...receipt,
        person: { ...receipt.person, personId: 'foreign-person' },
      }),
    /does not match target/,
  );
  transaction(two, () =>
    two
      .prepare('UPDATE app_meta SET value=? WHERE key=?')
      .run(proofs(one)[0].value, proofs(two)[0].key),
  );
  assert.throws(() => f.review(second.id), /does not match target/);
  assert.throws(() => f.accept(second.id));
  await assert.rejects(f.copy(second.id), /proof namespace or owner/);
});

test('copy proof remains evidence only and cannot bypass changed physical proposal or current person availability', async (t) => {
  const f = await fixture(t, true),
    copy = await f.copy(),
    db = f.databases.get(copy.id)!;
  assert.equal(
    f.review(copy.id).records[0].identityAttribution?.basis,
    'explicit_manual_source_record',
  );
  setVisibility(db, 'note', f.person.id, { version: 0, archived: true });
  assert.equal(f.review(copy.id).records[0].identityReview?.blocking, true);
  assert.throws(() => f.accept(copy.id));
  const file = db.prepare('SELECT path FROM source_files WHERE id=?').get(f.manual.proposalId)!;
  const path = resolve(f.root, String(file.path)),
    bytes = readFileSync(path);
  writeFileSync(path, Buffer.alloc(bytes.length, 32));
  assert.throws(() => f.review(copy.id), /Review source changed/);
  writeFileSync(path, bytes);
});

test('copy proof survives later source-text changes while existing stale-source acceptance guard remains active', async (t) => {
  const f = await fixture(t),
    copy = await f.copy(),
    db = f.databases.get(copy.id)!;
  reviewIntakeSourceText(
    db,
    f.root,
    copy.id,
    f.original.id,
    {
      operationId: randomUUID(),
      expectedRevisionId: f.request.sourceTextRevisionId,
      sourceHash: f.original.sha256,
      action: 'correct',
      scope: { page: 1 },
      spans: [
        {
          id: 'fictional-correction',
          text: 'Fictional reading: 12.60 units',
          region: { page: 1 },
          provenance: 'human',
        },
      ],
      relations: [],
    },
    'profile-owner',
  );
  const review = f.review(copy.id);
  assert.equal(review.records[0].identityAttribution?.basis, 'explicit_manual_source_record');
  assert.equal(review.sourceTextStale, true);
  assert.throws(() => f.accept(copy.id));
});

test('source advancement between preparation and staging refuses the unpublished copy', async (t) => {
  const f = await fixture(t);
  let destination: string | undefined;
  let advancedHead: Buffer | undefined;
  const sourceHead = resolve(contributorAuthorityPath(f.root, f.source.id), 'head');
  f.setBeforeStage((context) => {
    destination = context.targetProfileId;
    transaction(f.db, () =>
      f.db.prepare("INSERT INTO app_meta VALUES('fictional:advanced','retained')").run(),
    );
    advancedHead = readFileSync(sourceHead);
  });
  await assert.rejects(f.copy(), { message: 'Copy original read interval changed' });
  assert.ok(destination);
  assert.ok(advancedHead);
  assert.equal(existsSync(profilePaths(f.root, destination).root), false);
  assert.equal(existsSync(resolve(contributorAuthorityPath(f.root, destination), 'head')), false);
  assert.deepEqual(readFileSync(sourceHead), advancedHead);
  assert.equal(
    f.db.prepare("SELECT value FROM app_meta WHERE key='fictional:advanced'").get()?.value,
    'retained',
  );
  assert.equal(proofs(f.db).length, 0);
});

test('fabricated plans and published targets cannot mint copy proofs even when staging errors are caught', async (t) => {
  const f = await fixture(t),
    copy = await f.copy(),
    target = f.databases.get(copy.id)!;
  const original = proofs(target);
  const plan = prepareManualSourceCopy(f.db, f.root, f.source.id, copy.id);
  for (const input of [plan, { ...plan }]) {
    assert.throws(() =>
      transaction(target, () => {
        try {
          stageManualSourceCopy(target, input, {
            profileId: copy.id,
            readSelectedHead: () => Buffer.from('published'),
          });
        } catch {}
        target
          .prepare("INSERT OR REPLACE INTO app_meta VALUES('fictional:should-rollback','yes')")
          .run();
      }),
    );
    assert.deepEqual(proofs(target), original);
    assert.equal(
      target.prepare("SELECT value FROM app_meta WHERE key='fictional:should-rollback'").get(),
      undefined,
    );
  }
});

test('total contributor cache loss reconstructs missing copied manual proof from accepted authority', async (t) => {
  const f = await fixture(t),
    copy = await f.copy(),
    db = f.databases.get(copy.id)!;
  const accepted = proofs(db);
  db.prepare("DELETE FROM app_meta WHERE key GLOB 'intake_manual_copy:*'").run();
  db.close();
  const path = profilePaths(f.root, copy.id).database;
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  rebuildContributorDatabase(path, f.root, copy.id);
  const rebuilt = openDatabase(path, copy.id);
  attachPersonalDurability(rebuilt, { root: f.root, profileId: copy.id, initialize: false });
  f.databases.set(copy.id, rebuilt);
  assert.deepEqual(proofs(rebuilt), accepted);
  assert.equal(
    f.review(copy.id).records[0].identityAttribution?.basis,
    'explicit_manual_source_record',
  );
  assert.equal(f.accept(copy.id).receipt.acceptedCount, 1);
});
