import { fixtureTransaction } from './helpers/accepted-record-fixture.ts';
import { writeIntakeFixtureEnvelope } from './helpers/intake-authority-fixture.ts';
import { readIntakeEnvelopeText } from '../intake-authority.ts';
import { attachPersonalDurability } from '../portable.ts';
import { recordOwner } from '../record-owner.ts';
import { ownershipCorrections } from '../ownership-history.ts';
import { evidenceFor } from '../queries.ts';
import { linkTarget, relatedNotes, finishNote } from '../notes.ts';
import { observations, documents, clinicalList, testTypes, trends } from '../queries.ts';
import { exportOptions } from '../note-exports.ts';
import { getIntakeRelatedRecords } from '../related-records.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createNote, getNote, rememberSourceNameInTransaction } from '../notes.ts';
import { uploadIntake, reviewIntake, importIntake, getIntake } from '../intake.ts';
import {
  previewRecordOwnership,
  commitRecordOwnership,
  getRecordOwnershipReceipt,
} from '../record-ownership.ts';
import { clinicalTables, type ClinicalKind } from '../clinical-references.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import type { OwnershipRequest, OwnershipPreview } from '../../shared/record-ownership.ts';

function fixture(
  t: TestContext,
  kind: ClinicalKind = 'observation',
  journal?: ReturnType<typeof memoryJournal>,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-'));
  const profileId = 'fictional-ownership';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, {
    root,
    profileId,
    ...(journal ? { recordStorage: journal.storage } : {}),
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = createNote(db, {
    kind: 'person',
    title: 'Robin Lane',
    person: { fullName: 'Robin Lane' },
  });
  const another = createNote(db, {
    kind: 'person',
    title: 'Ash River',
    person: { fullName: 'Ash River' },
  });
  const envelope: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'fictional-assertion',
    kind: 'record',
    payload: { literal: 'Fictional retained evidence' },
    clinical: {
      kind,
      subject: 'self',
      date: '2026-01-12',
      testLabel: 'Fictional reach',
      valueText: '12.00',
      unit: 'cm',
      medicationName: 'Fictional medication',
      medicationKind: 'order',
      procedureLabel: 'Fictional procedure',
      procedureCategory: 'clinical_procedure',
      documentTitle: 'Fictional document',
      text: 'Fictional text',
    },
    provenance: {
      sourceSystem: 'Fictional Clinic',
      sourceRecordId: 'fictional-assertion',
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
  const recordId = String(db.prepare(`SELECT id FROM ${clinicalTables[kind]}`).get()!.id);
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [{ kind, recordId }] },
    destination: { noteId: person.id, expectedVersion: person.version },
  };
  const preview = (input: OwnershipRequest = request) =>
    previewRecordOwnership(db, root, profileId, input);
  const apply = (p: OwnershipPreview, operationId = randomUUID()) =>
    commitRecordOwnership(db, root, profileId, {
      operationId,
      request: p.request,
      version: p.version,
      scopeToken: p.scopeToken,
    });
  const row = () => db.prepare(`SELECT * FROM ${clinicalTables[kind]} WHERE id=?`).get(recordId)!;
  return {
    envelope,
    root,
    profileId,
    db,
    person,
    another,
    original,
    recordId,
    kind,
    request,
    preview,
    apply,
    row,
  };
}
for (const kind of Object.keys(clinicalTables) as ClinicalKind[])
  test(`${kind}: reviewed whole-record correction preserves clinical values and original bytes across Self and People`, (t) => {
    const f = fixture(t, kind);
    const before = f.row();
    const sources = f.db.prepare('SELECT * FROM source_records ORDER BY id').all();
    const files = f.db.prepare('SELECT * FROM source_files ORDER BY id').all();
    const p = f.preview();
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.records[0]!.blockers, []);
    assert.equal(p.title, 'Move these saved records and all their sources');
    assert.equal(p.reportDefault, false);
    assert.equal(p.records[0]!.contributions.length, 1);
    f.apply(p);
    assert.equal(JSON.parse(String(f.row().extra_json)).import.personId, f.person.personId);
    const collection = (personId: string) => {
      const params = new URLSearchParams({ personId, visibility: 'all', status: 'all' });
      return kind === 'observation'
        ? observations(f.db, params)
        : kind === 'document'
          ? documents(f.db, params)
          : kind === 'medication'
            ? clinicalList(f.db, 'medications', params)
            : clinicalList(f.db, 'procedures', params);
    };
    assert.equal(collection('patient').total, 0);
    assert.equal(collection(f.person.personId!).total, 1);
    const oldExport = exportOptions(f.db, { type: 'note', id: 'person-note:self' });
    assert.ok(!oldExport.choices.some((c) => c.id === f.recordId));
    const newExport = exportOptions(f.db, { type: 'note', id: f.person.id });
    assert.ok(newExport.choices.some((c) => c.id === f.recordId));
    if (kind === 'observation') {
      assert.equal(testTypes(f.db, new URLSearchParams({ personId: 'patient' })).length, 0);
      const types = testTypes(f.db, new URLSearchParams({ personId: f.person.personId! }));
      assert.equal(types.length, 1);
      assert.equal(
        trends(f.db, new URLSearchParams({ personId: f.person.personId!, ids: types[0]!.id }))[0]!
          .points.length,
        1,
      );
    }

    for (const [key, value] of Object.entries(before))
      if (!['person_id', 'extra_json'].includes(key)) assert.deepEqual(f.row()[key], value, key);
    const toOther = f.preview({
      ...f.request,
      destination: { noteId: f.another.id, expectedVersion: f.another.version },
    });
    f.apply(toOther);
    const self = getNote(f.db, 'person-note:self');
    f.apply(
      f.preview({ ...f.request, destination: { noteId: self.id, expectedVersion: self.version } }),
    );
    assert.equal(JSON.parse(String(f.row().extra_json)).import.personId, 'patient');
    assert.deepEqual(f.db.prepare('SELECT * FROM source_records ORDER BY id').all(), sources);
    assert.deepEqual(f.db.prepare('SELECT * FROM source_files ORDER BY id').all(), files);
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Record ownership event'")
        .get()!.n,
      3,
    );
  });

test('stable replay, lost-response lookup and conflicting operation identity', (t) => {
  const f = fixture(t),
    p = f.preview(),
    id = randomUUID();
  const receipt = f.apply(p, id);
  assert.deepEqual(f.apply(p, id), { ...receipt, replayed: true });
  assert.deepEqual(getRecordOwnershipReceipt(f.db, f.profileId, id), {
    ...receipt,
    replayed: true,
  });
  assert.throws(() => f.apply({ ...p, request: { ...p.request, reason: 'Changed request' } }, id), {
    code: 'OPERATION_CONFLICT',
  });
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Record ownership event'")
      .get()!.n,
    1,
  );
});

test('record history and a later patient packet disclose an accepted ownership correction', async (t) => {
  const { clinicalRecordHistory } = await import('../clinical-history.ts');
  const { exportSnapshot, exportHtml, exportEvidence } = await import('../note-exports.ts');
  const { attachRecordDurability } = await import('../record-versions.ts');
  const journal = memoryJournal();
  const f = fixture(t, 'observation', journal);
  attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
  f.apply(f.preview({ ...f.request, reason: 'Fictional patient-side correction' }));
  const self = getNote(f.db, 'person-note:self');
  f.apply(
    f.preview({
      selection: { type: 'records', records: [{ kind: 'observation', recordId: f.recordId }] },
      destination: { noteId: self.id, expectedVersion: self.version },
      reason: 'Fictional return to Self',
    }),
  );
  const history = clinicalRecordHistory(f.db, {
    profileId: f.profileId,
    kind: 'observation',
    recordId: f.recordId,
  });
  assert.equal(history.ownershipCorrections.length, 2);
  assert.equal(history.ownershipCorrections[1]!.fromPersonName, 'Robin Lane');
  assert.equal(history.ownershipCorrections[1]!.reason, 'Fictional return to Self');
  assert.equal(history.earlierPacketInclusion, 'not_recorded');
  const snapshot = exportSnapshot(f.db, {
    type: 'note',
    id: self.id,
    noteVersion: self.version,
    mode: 'provider',
  });
  const html = exportHtml(snapshot);
  assert.match(html, /Owner corrected on/);
  assert.match(html, /Owner corrected on[^<]+\(moved\)/);
  assert.match(html, /Previously attributed to Robin Lane/);
  const evidence = JSON.stringify(exportEvidence(snapshot));
  assert.match(evidence, /ownershipCorrections/);
  assert.match(evidence, /Fictional return to Self/);
});

test('stale records, edited destination and foreign profile fail before writes', (t) => {
  const f = fixture(t),
    p = f.preview(),
    before = f.row();
  transaction(f.db, () =>
    f.db.prepare("UPDATE observations SET value_text='13.00' WHERE id=?").run(f.recordId),
  );
  assert.throws(() => f.apply(p), { code: 'OWNERSHIP_CHANGED' });
  assert.equal(f.row().person_id, before.person_id);
  assert.throws(() => previewRecordOwnership(f.db, f.root, 'different-profile', f.request), {
    code: 'PROFILE_BOUNDARY',
  });
  transaction(f.db, () =>
    f.db.prepare('UPDATE notes SET version=version+1 WHERE id=?').run(f.person.id),
  );
  assert.throws(() => f.preview(), { code: 'OWNERSHIP_CHANGED' });
});

test('moving a prescription resets only its current personal activity assertion', (t) => {
  const f = fixture(t, 'medication');
  transaction(f.db, () =>
    f.db
      .prepare("UPDATE medication_preferences SET status='current' WHERE medication_id=?")
      .run(f.recordId),
  );
  f.apply(f.preview());
  assert.equal(
    f.db.prepare('SELECT status FROM medication_preferences WHERE medication_id=?').get(f.recordId)!
      .status,
    'not_current',
  );
});

test('repeated full-name confirmations retain independent support instead of only the first spelling', (t) => {
  const f = fixture(t);
  transaction(f.db, () => {
    for (const operationId of ['first-confirmation', 'second-confirmation'])
      rememberSourceNameInTransaction(f.db, 'person-note:self', {
        name: 'Robin Lane',
        operationId,
        intakeId: f.original.id,
        groupId: operationId,
        sourceHash: 'fictional-source-hash',
        subjectText: 'Robin Lane',
      });
  });
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Remembered name support'")
      .get()!.n,
    2,
  );
  const supports = f.db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Remembered name support' ORDER BY rowid",
    )
    .all()
    .map((r) => JSON.parse(String(r.coverage_json)));
  assert.equal(supports[0].independentManual, false);
  assert.equal(
    supports[1].independentManual,
    false,
    'mirroring a learned name is not an independent manual assertion',
  );
  const displayedNames = getNote(f.db, 'person-note:self').person.sourceKnownNames!;
  assert.match(displayedNames[0]!.confirmedAt || '', /^\d{4}-\d{2}-\d{2}/);
  assert.equal(displayedNames.length, 1, 'legacy evidence display stays compact');
});

test('a source whose ownership was corrected cannot reuse an old intake assignment', (t) => {
  const f = fixture(t);
  f.apply(f.preview());
  const review = reviewIntake(f.db, f.root, f.profileId, f.original.id);
  assert.equal(review.records[0]!.identityReview?.blocking, false);
  assert.equal(review.records[0]!.identityAttribution?.assignedPerson?.personId, f.person.personId);
  assert.equal(review.records[0]!.identityAttribution?.basis, 'explicit_ownership_correction');
  assert.equal(review.records[0]!.duplicateOf?.id, f.recordId);
});

function memoryJournal() {
  const objects = new Map<string, Buffer>();
  let failPublication = false;
  return {
    objects,
    failNextPublication() {
      failPublication = true;
    },
    storage: {
      read(name: string) {
        return objects.has(name) ? Buffer.from(objects.get(name)!) : null;
      },
      writeImmutable(name: string, bytes: Uint8Array) {
        assert.equal(objects.has(name), false);
        objects.set(name, Buffer.from(bytes));
      },
      publishHead(bytes: Uint8Array) {
        if (failPublication) {
          failPublication = false;
          throw new Error('Fictional pre-publication failure');
        }
        objects.set('head', Buffer.from(bytes));
      },
    },
  };
}

test('ownership history and exact replay survive losing and rebuilding the SQLite projection', async (t) => {
  const { attachRecordDurability, rebuildRecordDatabase, queryRecordHistory } =
    await import('../record-versions.ts');
  const { ownershipSourceAuthority } = await import('../record-ownership-authority.ts');
  const journal = memoryJournal(),
    f = fixture(t, 'observation', journal);
  attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
  const p = f.preview(),
    operationId = randomUUID(),
    receipt = f.apply(p, operationId);
  const before = queryRecordHistory(f.db, {
    profileId: f.profileId,
    entity: 'observations',
    recordId: f.recordId,
  });
  assert.equal(before.entries[0]!.contents.person_id, f.person.personId);
  assert.equal(before.entries[1]!.contents.person_id, 'patient');
  const path = join(f.root, 'rebuilt.sqlite');
  rebuildRecordDatabase(path, { profileId: f.profileId, storage: journal.storage });
  const rebuilt = openDatabase(path, f.profileId);
  try {
    attachRecordDurability(rebuilt, { profileId: f.profileId, storage: journal.storage });
    assert.equal(
      rebuilt.prepare('SELECT person_id FROM observations WHERE id=?').get(f.recordId)!.person_id,
      f.person.personId,
    );
    assert.deepEqual(getRecordOwnershipReceipt(rebuilt, f.profileId, operationId), {
      ...receipt,
      replayed: true,
    });
    assert.deepEqual(
      commitRecordOwnership(rebuilt, f.root, f.profileId, {
        operationId,
        request: p.request,
        version: p.version,
        scopeToken: p.scopeToken,
      }),
      { ...receipt, replayed: true },
    );
    const identity = JSON.parse(String(f.row().extra_json)).import.identity;
    assert.equal(ownershipSourceAuthority(rebuilt, identity)!.personId, f.person.personId);
  } finally {
    rebuilt.close();
  }
});

test('failure before journal publication leaves both ownership and its receipt unapplied', async (t) => {
  const { attachRecordDurability } = await import('../record-versions.ts');
  const journal = memoryJournal(),
    f = fixture(t, 'observation', journal);
  attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
  const head = journal.objects.get('head'),
    p = f.preview(),
    operationId = randomUUID();
  journal.failNextPublication();
  assert.throws(() => f.apply(p, operationId), /Fictional pre-publication failure/);
  assert.equal(f.row().person_id, 'patient');
  assert.deepEqual(journal.objects.get('head'), head);
  assert.throws(() => getRecordOwnershipReceipt(f.db, f.profileId, operationId), {
    code: 'OWNERSHIP_NOT_FOUND',
  });
  assert.equal(f.apply(p, operationId).moved, 1, 'same reviewed operation has a clear retry path');
});

test('prior ownership correction never masks a new blocking identity assessment', async (t) => {
  const { identityBeforeOwnershipHold, requireCorrectedOwnershipReview } =
    await import('../record-ownership-authority.ts');
  const f = fixture(t);
  f.apply(f.preview());
  const record = reviewIntake(f.db, f.root, f.profileId, f.original.id).records[0]!;
  const identity = JSON.parse(String(f.row().extra_json)).import.identity;
  const conflict = {
    status: 'conflict' as const,
    blocking: true,
    message: 'New verified DOB conflict',
    evidencedIdentity: { birthDate: '1990-01-01' },
    conflicts: [
      {
        field: 'birthDate' as const,
        selfValue: '1980-01-01',
        evidencedValue: '1990-01-01',
        reason: 'self_mismatch' as const,
      },
    ],
  };
  record.identityReview = conflict;
  requireCorrectedOwnershipReview(f.db, record, identity);
  assert.deepEqual(record.identityReview, conflict);
  assert.deepEqual(identityBeforeOwnershipHold(record), conflict);
});

function attachedReport(f: ReturnType<typeof fixture>, suffix = 'b') {
  const second = {
    ...f.envelope,
    id: 'fictional-report-' + suffix,
    provenance: {
      ...f.envelope.provenance,
      sourceRecordId: 'fictional-report-' + suffix,
      locator: 'Fictional report ' + suffix,
    },
  };
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-' + suffix + '.jsonl',
    bytes: Buffer.from(JSON.stringify(second)),
    newProviderName: 'Fictional Clinic',
  });
  const review = reviewIntake(f.db, f.root, f.profileId, original.id),
    record = review.records[0]!;
  const matches = getIntakeRelatedRecords(f.db, f.root, f.profileId, original.id, {
    proposalId: null,
    recordId: record.id,
    candidateVersionId: record.candidateVersionId!,
  });
  const match = matches.comparisons.find((m) => m.id === f.recordId)!;
  assert.ok(match, 'the existing matching flow exposes report A');
  importIntake(f.db, f.root, f.profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [
      {
        recordId: record.id,
        action: 'accept',
        mapping: {},
        comparisons: [
          {
            otherRecordId: match.id,
            scope: match.scope,
            outcome: 'same_event',
            reason: 'Reviewed independently fictional reports A and B.',
            occurrenceEvidence: 'attach',
          },
        ],
      },
    ],
  });
  const intake = getIntake(f.db, f.root, f.profileId, original.id),
    group = intake.workflow!.reportGroups![0]!;
  return {
    original,
    sourceRecordId: record.id,
    selection: {
      type: 'report' as const,
      intakeId: original.id,
      groupId: group.id,
      groupVersionId: group.versions.at(-1)!.id,
    },
  };
}
test('native report split publishes portable exact source snapshots with the clinical correction and replays without copying memberships', async (t) => {
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts');
  const {
    previewNativeRecordOwnership,
    commitNativeRecordOwnership,
    nativeOwnershipReportPlan,
    clearNativeOwnershipPlans,
  } = await import('../record-ownership-native.ts');
  const { readOwnershipSourceSnapshot } = await import('../ownership-source-snapshots.ts');
  const { ownershipReceiptReference, replayOwnershipReceiptReference } =
    await import('../ownership-outcome-page.ts');
  const f = fixture(t, 'document'),
    b = attachedReport(f),
    first = f.preview({ ...f.request, selection: b.selection });
  const request: OwnershipRequest = {
    ...first.request,
    decisions: [
      {
        recordId: f.recordId,
        action: 'keep_both',
        reviewedSplit: true,
        splitMapping: first.records[0]!.mapping,
        remainingMapping: first.records[0]!.remainingMapping,
      },
    ],
  };
  const expected = first.records[0]!.contributions;
  await buildIntakeCollectionEnvelope(f.db, { id: b.original.id });
  t.after(() => clearNativeOwnershipPlans(f.db));
  const preview = await previewNativeRecordOwnership(f.db, f.root, f.profileId, request);
  assert.ok('reportEvidence' in preview);
  const plan = nativeOwnershipReportPlan(f.db, f.profileId, preview.reportEvidence.token);
  assert.equal(preview.reportEvidence.recordBlockerTotal, 0);
  const page = plan.page('records');
  assert.equal(page.items.length, 1);
  const operationId = randomUUID(),
    command = {
      operationId,
      request: preview.request,
      scopeToken: preview.scopeToken,
      version: preview.version,
    };
  const receipt = await commitNativeRecordOwnership(f.db, f.root, f.profileId, command);
  assert.equal(receipt.moved, 1);
  for (const row of f.db.prepare('SELECT id,extra_json FROM documents ORDER BY id').iterate()) {
    const extra = JSON.parse(String(row.extra_json)),
      reference = extra.import.ownershipReview.sourceRecordIdsReference;
    assert.equal(extra.import.ownershipReview.sourceRecordIds, undefined);
    assert.equal(reference.format, 'health-ownership-source-snapshot-v1');
    const members = readOwnershipSourceSnapshot(f.db, reference);
    assert.equal(members.complete, true);
    assert.deepEqual(
      members.sourceRecordIds,
      expected
        .filter((c) => (String(row.id) === f.recordId ? !c.selected : c.selected))
        .map((c) => c.sourceRecordId),
    );
  }
  assert.deepEqual(replayOwnershipReceiptReference(f.db, f.profileId, command), {
    ...ownershipReceiptReference(f.db, f.profileId, operationId),
    replayed: true,
  });
});
for (const kind of Object.keys(clinicalTables) as ClinicalKind[])
  test(`${kind}: report B splits only its accepted contribution; replay and reimport retain B's corrected destination`, (t) => {
    const f = fixture(t, kind),
      b = attachedReport(f),
      before = f.row();
    const first = f.preview({ ...f.request, selection: b.selection });
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0]!.action, 'split');
    assert.equal(first.records[0]!.contributions.length, 2);
    assert.ok(first.records[0]!.blockers.some((s) => s.includes('Review both')));
    const p = f.preview({
      ...first.request,
      decisions: [
        {
          recordId: f.recordId,
          action: 'keep_both',
          reviewedSplit: true,
          splitMapping: first.records[0]!.mapping,
          remainingMapping: first.records[0]!.remainingMapping,
        },
      ],
    });
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.records[0]!.blockers, []);
    const id = randomUUID(),
      receipt = f.apply(p, id),
      destination = receipt.outcomes[0]!.destinationRecordId;
    assert.notEqual(destination, f.recordId);
    assert.equal(f.row().source_record_id, before.source_record_id);
    // Splitting B cannot rewrite A's clinical values; its retained evidence
    // remains authoritative (docs/data/change-history.md).
    for (const [field, value] of Object.entries(before))
      if (!['extra_json', 'person_id'].includes(field))
        assert.deepEqual(f.row()[field], value, field);
    assert.equal(JSON.parse(String(f.row().extra_json)).import.personId, 'patient');
    // Only B's new record changed owner. A's retained record must not claim a
    // correction in its history or in later packets, and an empty reason is not
    // shown as the person's reason.
    assert.deepEqual(ownershipCorrections(f.db, kind, f.recordId), []);
    const corrected = ownershipCorrections(f.db, kind, destination);
    assert.equal(corrected.length, 1);
    assert.equal(corrected[0]!.action, 'split');
    assert.equal(corrected[0]!.reason, null);
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${clinicalTables[kind]}`).get()!.n, 2);
    assert.equal(
      f.db
        .prepare('SELECT entity_id FROM evidence WHERE entity_type=? AND source_record_id=?')
        .get(kind, b.sourceRecordId)!.entity_id,
      destination,
    );
    assert.deepEqual(f.apply(p, id), { ...receipt, replayed: true });
    const review = reviewIntake(f.db, f.root, f.profileId, b.original.id),
      incoming = review.records[0]!;
    assert.equal(incoming.identityReview?.blocking, false);
    assert.equal(incoming.identityAttribution?.assignedPerson?.personId, f.person.personId);
    assert.equal(incoming.duplicateOf?.id, destination);
    importIntake(f.db, f.root, f.profileId, b.original.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: incoming.id, action: 'accept', mapping: {} }],
    });
    assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${clinicalTables[kind]}`).get()!.n, 2);
  });

test('whole-record preview includes every attached source and moves both A and B authority', (t) => {
  const f = fixture(t),
    b = attachedReport(f),
    p = f.preview();
  assert.equal(p.records[0]!.action, 'move');
  assert.equal(p.records[0]!.contributions.filter((c) => c.selected).length, 2);
  assert.deepEqual(p.records[0]!.blockers, []);
  f.apply(p);
  for (const intakeId of [f.original.id, b.original.id]) {
    const r = reviewIntake(f.db, f.root, f.profileId, intakeId).records[0]!;
    assert.equal(r.identityAttribution?.assignedPerson?.personId, f.person.personId);
    assert.equal(r.duplicateOf?.id, f.recordId);
  }
});

async function confirmedReport(
  f: ReturnType<typeof fixture>,
  suffix: string,
  count = 2,
  accepted = count,
  printedName = 'Robin Lane',
) {
  const { proposeConversion } = await import('../intake.ts');
  const { getIntakeIdentityScope, confirmIntakeIdentityScope } =
    await import('../intake-identity.ts');
  const subject = 'Patient: ' + printedName,
    heading = 'Fictional report ' + suffix;
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-' + suffix + '.txt',
    bytes: Buffer.from(heading + '\n' + subject + '\nFictional values 12.00'),
    newProviderName: 'Fictional Clinic',
  });
  const value = (id: string): HealthRecordEnvelope => ({
    ...f.envelope,
    id,
    provenance: { ...f.envelope.provenance, sourceRecordId: id, locator: 'row ' + id },
    clinical: { ...(f.envelope.clinical as object), subject: 'unknown' },
    report: {
      key: suffix,
      title: heading,
      anchor: { locator: 'heading', text: heading },
      subject: { locator: 'patient', text: subject },
    },
  });
  const propose = (values: HealthRecordEnvelope[]) =>
    proposeConversion(f.db, f.root, f.profileId, original.id, {
      version: getIntake(f.db, f.root, f.profileId, original.id).version,
      summary: 'Fictional retained report proposal',
      jsonlText: values.map((v) => JSON.stringify(v)).join('\n'),
    });
  const proposed = propose(Array.from({ length: count }, (_, i) => value(suffix + '-' + i)));
  const group = getIntake(f.db, f.root, f.profileId, original.id).workflow!.reportGroups![0]!;
  const scope = await getIntakeIdentityScope(f.db, f.root, f.profileId, original.id, group.id);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, original.id, {
    version: scope.intakeVersion,
    operationId: 'fictional-confirm-' + suffix,
    scope,
    outcome: 'this_is_me',
    attestation: 'reviewed_original_and_membership',
    printedName,
  });
  const review = reviewIntake(
    f.db,
    f.root,
    f.profileId,
    original.id,
    proposed.proposals.at(-1)!.id,
  );
  importIntake(f.db, f.root, f.profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    proposalId: review.proposalId,
    decisions: review.records
      .slice(0, accepted)
      .map((r) => ({ recordId: r.id, action: 'accept', mapping: {} })),
  });
  return {
    original,
    group,
    value,
    propose,
    review,
    selection: {
      type: 'report' as const,
      intakeId: original.id,
      groupId: group.id,
      groupVersionId: group.versions.at(-1)!.id,
    },
  };
}
test('whole report transfers sole learned-name authority and later members default without acceptance', async (t) => {
  const { prepareOwnershipEvidence } = await import('../record-ownership.ts');
  const { effectiveKnownNames, activeIdentityReceipts } = await import('../name-associations.ts');
  const f = fixture(t),
    r = await confirmedReport(f, 'name-default');
  const request = { ...f.request, selection: r.selection };
  await prepareOwnershipEvidence(f.db, f.root, f.profileId, request);
  const p = f.preview(request);
  assert.deepEqual(p.blockers, []);
  assert.ok(p.records.every((r) => !r.blockers.length));
  assert.equal(p.names.length, 1);
  assert.equal(p.names[0]!.proposed, 'destination');
  const oldReceipts = getIntake(f.db, f.root, f.profileId, r.original.id).workflow!
    .identityConfirmations;
  f.apply(p);
  assert.equal(getNote(f.db, 'person-note:self').person.nameAssociations![0]!.origin, 'ownership');
  assert.equal(getNote(f.db, f.person.id).person.nameAssociations![0]!.origin, 'ownership');
  assert.ok(
    !effectiveKnownNames(
      f.db,
      'person-note:self',
      getNote(f.db, 'person-note:self').person,
    ).includes('Robin Lane'),
  );
  assert.ok(
    effectiveKnownNames(f.db, f.person.id, getNote(f.db, f.person.id).person).includes(
      'Robin Lane',
    ),
  );
  assert.deepEqual(
    getIntake(f.db, f.root, f.profileId, r.original.id).workflow!.identityConfirmations,
    oldReceipts,
  );
  assert.equal(activeIdentityReceipts(f.db, oldReceipts)!.length, 0);
  const later = r.propose([r.value('name-default-later')]);
  const next = reviewIntake(f.db, f.root, f.profileId, r.original.id, later.proposals.at(-1)!.id)
    .records[0]!;
  assert.equal(next.identityReview?.blocking, false);
  assert.equal(next.mapping.personId, f.person.personId);
  assert.equal(next.reviewState, 'pending');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?').get(f.person.personId)!.n,
    2,
  );
});
test('two confirmation decisions of the same name retain separate support and require a reviewed association choice', async (t) => {
  const { prepareOwnershipEvidence } = await import('../record-ownership.ts');
  const f = fixture(t),
    a = await confirmedReport(f, 'name-a'),
    b = await confirmedReport(f, 'name-b');
  const request = { ...f.request, selection: b.selection };
  await prepareOwnershipEvidence(f.db, f.root, f.profileId, request);
  const p = f.preview(request);
  assert.equal(p.names.length, 1);
  assert.equal(p.names[0]!.independentSupport, true);
  assert.equal(p.names[0]!.proposed, 'unresolved');
  assert.equal(p.names[0]!.support.length, 2);
  f.apply(p);
  const { activeIdentityReceipts } = await import('../name-associations.ts');
  assert.equal(
    activeIdentityReceipts(
      f.db,
      getIntake(f.db, f.root, f.profileId, a.original.id).workflow!.identityConfirmations,
    )!.length,
    1,
  );
  assert.equal(
    activeIdentityReceipts(
      f.db,
      getIntake(f.db, f.root, f.profileId, b.original.id).workflow!.identityConfirmations,
    )!.length,
    0,
  );
});

async function laterPrintedNameReview(f: ReturnType<typeof fixture>, suffix: string) {
  const { proposeConversion } = await import('../intake.ts');
  const { getIntakeIdentityReview } = await import('../intake-identity.ts');
  const heading = 'Fictional later report ' + suffix;
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-later-' + suffix + '.txt',
    bytes: Buffer.from(heading + '\nPatient: Robin Lane\nFictional values 17.00'),
    newProviderName: 'Fictional Clinic',
  });
  const value: HealthRecordEnvelope = {
    ...f.envelope,
    id: 'fictional-later-' + suffix,
    provenance: {
      ...f.envelope.provenance,
      sourceRecordId: 'fictional-later-' + suffix,
    },
    clinical: { ...(f.envelope.clinical as object), subject: 'unknown' },
    report: {
      key: suffix,
      title: heading,
      anchor: { locator: 'heading', text: heading },
      subject: { locator: 'patient', text: 'Patient: Robin Lane' },
    },
  };
  const proposed = proposeConversion(f.db, f.root, f.profileId, original.id, {
    version: getIntake(f.db, f.root, f.profileId, original.id).version,
    summary: 'Fictional later identity review',
    jsonlText: JSON.stringify(value),
  });
  const groupId = getIntake(f.db, f.root, f.profileId, original.id).workflow!.reportGroups![0]!.id;
  await getIntakeIdentityReview(f.db, f.root, f.profileId, original.id, groupId);
  return {
    original,
    review: reviewIntake(f.db, f.root, f.profileId, original.id, proposed.proposals.at(-1)!.id),
  };
}

test('unresolved learned name blocks a distinct later report rather than making a Person unique', async (t) => {
  const f = fixture(t);
  await confirmedReport(f, 'challenged-a');
  const b = await confirmedReport(f, 'challenged-b');
  const p = f.preview({ ...f.request, selection: b.selection });
  assert.equal(p.names[0]!.proposed, 'unresolved');
  f.apply(p);
  const later = await laterPrintedNameReview(f, 'challenged-c');
  assert.equal(later.review.records[0]!.identityReview?.status, 'confirmation_required');
  assert.equal(later.review.records[0]!.identityReview?.blocking, true);
  assert.match(later.review.records[0]!.identityReview?.message || '', /corrected|challenged/i);
});

test('an independently asserted Self name remains a positive name after its learned association is challenged', async (t) => {
  const f = fixture(t);
  const self = getNote(f.db, 'person-note:self');
  const { saveNote } = await import('../notes.ts');
  saveNote(f.db, self.id, {
    version: self.version,
    person: { ...self.person, knownNames: ['Robin Lane'] },
  });
  const report = await confirmedReport(f, 'manual-name');
  const p = f.preview({ ...f.request, selection: report.selection });
  assert.equal(p.names[0]!.independentSupport, true);
  assert.equal(p.names[0]!.proposed, 'unresolved');
  f.apply(p);
  const { effectiveKnownNames } = await import('../name-associations.ts');
  assert.ok(
    effectiveKnownNames(f.db, self.id, getNote(f.db, self.id).person).includes('Robin Lane'),
  );
  const later = await laterPrintedNameReview(f, 'manual-name-later');
  assert.equal(later.review.records[0]!.identityReview?.blocking, true);
  assert.match(later.review.records[0]!.identityReview?.message || '', /correction/i);
});

for (const future of ['person', 'self', 'ask'] as const)
  test(`a challenged printed name offers an explicit ${future} future choice`, async (t) => {
    const { getIntakeIdentityScope, getIntakeIdentityReview, confirmIntakeIdentityScope } =
      await import('../intake-identity.ts');
    const f = fixture(t);
    await confirmedReport(f, 'future-choice-a-' + future);
    const b = await confirmedReport(f, 'future-choice-b-' + future);
    f.apply(f.preview({ ...f.request, selection: b.selection }));
    const current = await laterPrintedNameReview(f, 'future-choice-current-' + future);
    const groupId = getIntake(f.db, f.root, f.profileId, current.original.id).workflow!
      .reportGroups![0]!.id;
    const identity = await getIntakeIdentityReview(
      f.db,
      f.root,
      f.profileId,
      current.original.id,
      groupId,
    );
    assert.equal(identity.challengedName, 'Robin Lane');
    const scope = await getIntakeIdentityScope(
      f.db,
      f.root,
      f.profileId,
      current.original.id,
      groupId,
    );
    const person = getNote(f.db, f.person.id);
    await confirmIntakeIdentityScope(f.db, f.root, f.profileId, current.original.id, {
      scope,
      version: scope.intakeVersion,
      operationId: randomUUID(),
      outcome: 'this_is_person',
      attestation: 'confirmed_displayed_report_subject',
      personSelection: { noteId: person.id, expectedVersion: person.version },
      printedName: 'Robin Lane',
      futureNameOwner:
        future === 'person'
          ? { outcome: 'person', noteId: person.id, expectedVersion: person.version }
          : { outcome: future },
    });
    const later = await laterPrintedNameReview(f, 'future-choice-later-' + future);
    assert.equal(later.review.records[0]!.identityReview?.blocking, future === 'ask');
    if (future !== 'ask')
      assert.equal(
        later.review.records[0]!.mapping.personId || 'patient',
        future === 'self' ? 'patient' : f.person.personId,
      );
  });

for (const outcome of ['old', 'destination', 'unresolved'] as const)
  test(`partial confirmed report with ${outcome} name choice holds its remaining pending member`, async (t) => {
    const f = fixture(t);
    const report = await confirmedReport(f, 'held-' + outcome, 3, 2);
    const selected = String(
      f.db
        .prepare('SELECT id FROM observations WHERE source_record_id=?')
        .get(report.review.records[0]!.id)!.id,
    );
    const request: OwnershipRequest = {
      selection: { type: 'records', records: [{ kind: 'observation', recordId: selected }] },
      destination: { noteId: f.person.id, expectedVersion: f.person.version },
    };
    const preview = f.preview(request);
    assert.equal(preview.reportHolds.length, 1);
    f.apply(f.preview({ ...request, nameDecisions: [{ key: preview.names[0]!.key, outcome }] }));
    const proposed = report.propose(
      Array.from({ length: 3 }, (_, i) => report.value('held-' + outcome + '-' + i)),
    );
    const after = reviewIntake(
      f.db,
      f.root,
      f.profileId,
      report.original.id,
      proposed.proposals.at(-1)!.id,
    );
    const remaining = after.records.find((r) => r.id === report.review.records[2]!.id)!;
    assert.equal(remaining.identityReview?.status, 'confirmation_required');
    assert.equal(remaining.identityReview?.blocking, true);
  });

test('partial correction holds a confirmed single-token report even with no name association', async (t) => {
  const f = fixture(t);
  const report = await confirmedReport(f, 'single-token-hold', 3, 2, 'R');
  const selected = String(
    f.db
      .prepare('SELECT id FROM observations WHERE source_record_id=?')
      .get(report.review.records[0]!.id)!.id,
  );
  const p = f.preview({
    selection: { type: 'records', records: [{ kind: 'observation', recordId: selected }] },
    destination: { noteId: f.person.id, expectedVersion: f.person.version },
  });
  assert.equal(p.names.length, 0);
  assert.equal(p.reportHolds.length, 1);
  f.apply(p);
  const next = report.propose(
    Array.from({ length: 3 }, (_, i) => report.value('single-token-hold-' + i)),
  );
  const review = reviewIntake(
    f.db,
    f.root,
    f.profileId,
    report.original.id,
    next.proposals.at(-1)!.id,
  );
  assert.equal(review.records[2]!.identityReview?.status, 'confirmation_required');
});
for (const outcome of ['old', 'both', 'unresolved'] as const)
  test(`partial report correction with ${outcome} names challenges old receipt without moving the remaining record`, async (t) => {
    const f = fixture(t),
      r = await confirmedReport(f, 'partial-' + outcome);
    const row = f.db
      .prepare('SELECT id FROM observations WHERE source_record_id=?')
      .get(r.review.records[0]!.id)!;
    const request = {
      ...f.request,
      selection: {
        type: 'records' as const,
        records: [{ kind: 'observation' as const, recordId: String(row.id) }],
      },
    };
    const p = f.preview(request);
    assert.equal(p.names.length, 1);
    assert.equal(p.names[0]!.proposed, 'unresolved');
    f.apply(f.preview({ ...request, nameDecisions: [{ key: p.names[0]!.key, outcome }] }));
    const { activeIdentityReceipts } = await import('../name-associations.ts');
    assert.equal(
      activeIdentityReceipts(
        f.db,
        getIntake(f.db, f.root, f.profileId, r.original.id).workflow!.identityConfirmations,
      )!.length,
      0,
    );
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Report ownership default'")
        .get()!.n,
      0,
    );
    assert.equal(
      f.db
        .prepare('SELECT person_id FROM observations WHERE source_record_id=?')
        .get(r.review.records[1]!.id)!.person_id,
      'patient',
    );
  });

function destinationMatch(f: ReturnType<typeof fixture>) {
  const value = {
    ...f.envelope,
    id: 'fictional-destination',
    provenance: {
      ...f.envelope.provenance,
      sourceRecordId: 'fictional-destination',
      locator: 'Fictional separate event',
    },
    clinical: {
      ...(f.envelope.clinical as object),
      valueText: '99.00',
      doseText: 'Different destination dose',
      text: 'Different destination text',
    },
  };
  const original = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-destination.jsonl',
    bytes: Buffer.from(JSON.stringify(value)),
    newProviderName: 'Fictional Clinic',
  });
  const review = reviewIntake(f.db, f.root, f.profileId, original.id);
  importIntake(f.db, f.root, f.profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const id = String(
    f.db
      .prepare(`SELECT id FROM ${clinicalTables[f.kind]} WHERE source_record_id=?`)
      .get(review.records[0]!.id)!.id,
  );
  f.apply(
    f.preview({
      ...f.request,
      selection: { type: 'records', records: [{ kind: f.kind, recordId: id }] },
    }),
  );
  return id;
}
test('split contents checkbox cannot silently choose keep both when a destination match exists', (t) => {
  const f = fixture(t),
    destination = destinationMatch(f),
    b = attachedReport(f);
  const first = f.preview({ ...f.request, selection: b.selection });
  assert.ok(first.records[0]!.matches.some((m) => m.recordId === destination));
  const reviewed = f.preview({
    ...first.request,
    decisions: [
      {
        recordId: f.recordId,
        reviewedSplit: true,
        splitMapping: first.records[0]!.mapping,
        remainingMapping: first.records[0]!.remainingMapping,
      },
    ],
  });
  assert.ok(reviewed.records[0]!.blockers.some((b) => /link|keep both/i.test(b)));
});
for (const kind of Object.keys(clinicalTables) as ClinicalKind[])
  test(`${kind}: explicit link preserves destination contents and current activity with a durable redirect`, async (t) => {
    const f = fixture(t, kind),
      destinationId = destinationMatch(f);
    if (kind === 'medication')
      transaction(f.db, () =>
        f.db
          .prepare("UPDATE medication_preferences SET status='current' WHERE medication_id=?")
          .run(destinationId),
      );
    const before = f.db
      .prepare(`SELECT * FROM ${clinicalTables[kind]} WHERE id=?`)
      .get(destinationId);
    const p = f.preview();
    assert.ok(p.records[0]!.matches.some((m) => m.recordId === destinationId));
    assert.ok(p.records[0]!.blockers.some((b) => b.includes('link')));
    const input = {
      ...f.request,
      decisions: [{ recordId: f.recordId, action: 'link' as const, targetRecordId: destinationId }],
    };
    const preview = f.preview(input);
    assert.deepEqual(preview.records[0]!.blockers, []);
    f.apply(preview);
    assert.deepEqual(
      f.db.prepare(`SELECT * FROM ${clinicalTables[kind]} WHERE id=?`).get(destinationId),
      before,
    );
    assert.equal(f.row(), undefined);
    assert.equal(recordOwner(f.db, kind, f.recordId), f.person.personId);
    assert.equal(linkTarget(f.db, kind, f.recordId).missing, false);
    assert.ok(
      linkTarget(f.db, kind, f.recordId).apiUrl?.includes(encodeURIComponent(destinationId)),
    );
    assert.ok(
      evidenceFor(f.db, kind, f.recordId).some(
        (e) => e.sourceRecordId === f.original.id + ':line:1',
      ),
    );
    const { resolveClinicalReference } = await import('../clinical-references.ts');
    assert.equal(resolveClinicalReference(f.db, kind, f.recordId)!.recordId, destinationId);
    if (kind === 'medication')
      assert.equal(
        f.db
          .prepare('SELECT status FROM medication_preferences WHERE medication_id=?')
          .get(destinationId)!.status,
        'current',
      );
    const later = reviewIntake(f.db, f.root, f.profileId, f.original.id);
    assert.equal(
      later.records[0]!.identityAttribution?.assignedPerson?.personId,
      f.person.personId,
    );
    assert.equal(later.records[0]!.duplicateOf?.id, destinationId);
  });
test('a new person and all selected records are created in the same correction and replay once', (t) => {
  const f = fixture(t);
  const p = f.preview({
    ...f.request,
    destination: { newPerson: { fullName: 'Fictional Juniper Lake', relationship: 'Sibling' } },
  });
  const before = f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n;
  const id = randomUUID(),
    receipt = f.apply(p, id);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n,
    Number(before) + 1,
  );
  assert.equal(f.row().person_id, receipt.destinationPersonId);
  f.apply(p, id);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n,
    Number(before) + 1,
  );
});
test('later new anchored identity questions invalidate a standing report assignment', async (t) => {
  const f = fixture(t),
    r = await confirmedReport(f, 'new-question');
  const p = f.preview({ ...f.request, selection: r.selection });
  f.apply(p);
  const nextValue = {
    ...r.value('new-question-later'),
    reviewIssues: [
      {
        kind: 'identity' as const,
        field: 'subject',
        prompt: 'Does this later section refer to another patient?',
        textAnchor: 'Patient: Robin Lane',
      },
    ],
  };
  const later = r.propose([nextValue]);
  const review = reviewIntake(f.db, f.root, f.profileId, r.original.id, later.proposals.at(-1)!.id);
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.match(review.records[0]!.identityReview!.message, /New identity evidence/);
});

test('large report correction stages bounded journal objects and exposes no ownership or names before atomic publication', async (t) => {
  const { attachRecordDurability, iterateRecordCommitSegments } =
    await import('../record-versions.ts');
  const journal = memoryJournal(),
    f = fixture(t, 'observation', journal),
    report = await confirmedReport(f, 'large', 60);
  attachRecordDurability(f.db, {
    profileId: f.profileId,
    storage: journal.storage,
    segmentBytes: 4096,
  });
  const beforeObjects = new Set(journal.objects.keys());
  const p = f.preview({ ...f.request, selection: report.selection }),
    id = randomUUID();
  assert.equal(p.records.length, 60);
  journal.failNextPublication();
  assert.throws(() => f.apply(p, id), /Fictional pre-publication failure/);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?').get(f.person.personId)!.n,
    0,
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Remembered name correction'")
      .get()!.n,
    0,
  );
  const receipt = f.apply(p, id);
  assert.equal(receipt.moved, 60);
  const head = JSON.parse(journal.objects.get('head')!.toString()),
    commit = JSON.parse(journal.objects.get(head.name)!.toString());
  assert.equal(commit.result.moved, 60);
  assert.equal(commit.result.outcomes, undefined);
  assert.ok(JSON.stringify(commit.result).length < 1024);
  const segments = [...iterateRecordCommitSegments(journal.storage, commit)];
  assert.ok(segments.length > 1);
  assert.ok(segments.every((s) => s.bytes <= 4096));
  const writes = [...journal.objects].filter(([key]) => !beforeObjects.has(key));
  assert.ok(writes.length > 1);
});
test('legacy mirrored name repair does not invent an independent manual assertion', async (t) => {
  const { saveNote } = await import('../notes.ts');
  const f = fixture(t);
  transaction(f.db, () =>
    f.db.prepare('UPDATE notes SET profile_json=? WHERE id=?').run(
      JSON.stringify({
        sourceKnownNames: [
          {
            name: 'Robin Lane',
            intakeId: f.original.id,
            groupId: 'legacy-group',
            operationId: 'legacy',
            sourceHash: 'legacy',
            subjectText: 'Robin Lane',
          },
        ],
      }),
      'person-note:self',
    ),
  );
  const note = getNote(f.db, 'person-note:self');
  saveNote(f.db, note.id, {
    version: note.version,
    person: { ...note.person, pronouns: 'they/them' },
  });
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Manual name assertion'").get()!
      .n,
    0,
  );
});

for (const kind of Object.keys(clinicalTables) as ClinicalKind[])
  test(`${kind}: split linking leaves A with only A provenance and preserves destination values`, (t) => {
    const f = fixture(t, kind),
      b = attachedReport(f),
      target = destinationMatch(f);
    const before = f.db.prepare(`SELECT * FROM ${clinicalTables[kind]} WHERE id=?`).get(target);
    transaction(f.db, () => {
      const extra = JSON.parse(String(f.row().extra_json));
      extra.import.identityAttributions = [{ groupId: 'fictional-b-only' }];
      extra.import.reviewedReportSources = [{ source: 'fictional-b-only' }];
      extra.import.corrections = [{ operationId: 'fictional-b-only' }];
      fixtureTransaction(f.db, () =>
        f.db
          .prepare(`UPDATE ${clinicalTables[kind]} SET extra_json=? WHERE id=?`)
          .run(JSON.stringify(extra), f.recordId),
      );
    });
    const p = f.preview({ ...f.request, selection: b.selection });
    const reviewed = f.preview({
      ...p.request,
      decisions: [
        {
          recordId: f.recordId,
          action: 'link',
          targetRecordId: target,
          reviewedSplit: true,
          splitMapping: p.records[0]!.mapping,
          remainingMapping: p.records[0]!.remainingMapping,
        },
      ],
    });
    assert.deepEqual(reviewed.records[0]!.blockers, []);
    f.apply(reviewed);
    assert.deepEqual(
      f.db.prepare(`SELECT * FROM ${clinicalTables[kind]} WHERE id=?`).get(target),
      before,
    );
    const extra = JSON.parse(String(f.row().extra_json));
    assert.equal(extra.import.personId, 'patient');
    // A kept its owner; only the linked target received B's contribution.
    assert.deepEqual(ownershipCorrections(f.db, kind, f.recordId), []);
    assert.equal(ownershipCorrections(f.db, kind, target).at(-1)?.action, 'link');
    assert.equal(extra.import.identityAttributions, undefined);
    assert.equal(extra.import.reviewedReportSources, undefined);
    assert.equal(extra.import.corrections, undefined);
    assert.equal(extra.import.sourceRecordId, f.envelope.provenance.sourceRecordId);
    assert.equal(
      f.db
        .prepare('SELECT entity_id FROM evidence WHERE entity_type=? AND source_record_id=?')
        .get(kind, b.sourceRecordId)!.entity_id,
      target,
    );
  });

test('same-owner report confirmation adds no name, source or standing report authority', async (t) => {
  const f = fixture(t),
    report = await confirmedReport(f, 'same-owner');
  const self = getNote(f.db, 'person-note:self');
  const p = f.preview({
    ...f.request,
    selection: report.selection,
    destination: { noteId: self.id, expectedVersion: self.version },
  });
  const counts = () =>
    f.db
      .prepare(
        "SELECT title,COUNT(*) n FROM manual_batches WHERE title IN ('Report ownership default','Record ownership source','Remembered name correction','Identity receipt supersession') GROUP BY title",
      )
      .all();
  const before = counts();
  const receipt = f.apply(p);
  assert.equal(receipt.moved, 0);
  assert.deepEqual(counts(), before);
});

test('unrelated groups retain the first receipt when a later publication fails and create a new Person only once', async (t) => {
  const { attachRecordDurability, rebuildRecordDatabase } = await import('../record-versions.ts');
  const journal = memoryJournal();
  const f = fixture(t, 'observation', journal);
  const other = destinationMatch(f);
  transaction(f.db, () => {
    const row = f.db.prepare('SELECT extra_json FROM observations WHERE id=?').get(other)!;
    const extra = JSON.parse(String(row.extra_json));
    extra.import.acceptedMapping.testLabel = 'Ultraviolet intensity';
    fixtureTransaction(f.db, () =>
      f.db
        .prepare('UPDATE observations SET label=?,extra_json=? WHERE id=?')
        .run('Ultraviolet intensity', JSON.stringify(extra), other),
    );
  });
  let publications = 0;
  attachRecordDurability(f.db, {
    profileId: f.profileId,
    storage: {
      ...journal.storage,
      publishHead(bytes) {
        publications++;
        if (publications === 2) throw new Error('Fictional later group failure');
        journal.storage.publishHead(bytes);
      },
    },
  });
  const p = f.preview({
    ...f.request,
    selection: {
      type: 'records',
      records: [
        { kind: f.kind, recordId: f.recordId },
        { kind: f.kind, recordId: other },
      ],
    },
    destination: { newPerson: { fullName: 'Fictional Shared Destination' } },
  });
  assert.equal(p.commitGroups.length, 2);
  const before = Number(f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n),
    id = randomUUID(),
    result = f.apply(p, id);
  assert.equal(result.moved, 1);
  assert.equal(result.groups?.filter((g) => g.status === 'committed').length, 1);
  assert.equal(result.groups?.filter((g) => g.status === 'needs_review').length, 1);
  assert.equal(
    Number(f.db.prepare("SELECT COUNT(*) n FROM notes WHERE kind='person'").get()!.n),
    before + 1,
  );
  assert.deepEqual(f.apply(p, id), { ...result, replayed: true });
  assert.equal(publications, 2);
  const path = join(f.root, 'group-rebuilt.sqlite');
  rebuildRecordDatabase(path, { profileId: f.profileId, storage: journal.storage });
  const rebuilt = openDatabase(path, f.profileId);
  try {
    assert.deepEqual(getRecordOwnershipReceipt(rebuilt, f.profileId, id), {
      ...result,
      replayed: true,
    });
  } finally {
    rebuilt.close();
  }
  const remaining = result.groups!.find((g) => g.status === 'needs_review')!;
  const dest = f.db
    .prepare('SELECT id,version FROM notes WHERE person_id=?')
    .get(result.destinationPersonId)!;
  const retry = f.preview({
    selection: {
      type: 'records',
      records: remaining.recordIds.map((recordId) => ({ kind: f.kind, recordId })),
    },
    destination: { noteId: String(dest.id), expectedVersion: Number(dest.version) },
  });
  const decisions = retry.records
    .filter((r) => r.matches.length)
    .map((r) => ({ recordId: r.recordId, action: 'keep_both' as const }));
  f.apply(f.preview({ ...retry.request, decisions }));
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?')
      .get(result.destinationPersonId)!.n,
    2,
  );
});

test('split publication restores from durable versions with attachment metadata, activity and both histories intact', async (t) => {
  const { attachRecordDurability, rebuildRecordDatabase, queryRecordHistory } =
    await import('../record-versions.ts');
  const journal = memoryJournal(),
    f = fixture(t, 'medication', journal),
    b = attachedReport(f);
  transaction(f.db, () => {
    fixtureTransaction(f.db, () =>
      f.db
        .prepare("UPDATE medication_preferences SET status='current' WHERE medication_id=?")
        .run(f.recordId),
    );
    fixtureTransaction(f.db, () =>
      f.db
        .prepare(
          "INSERT INTO assets(id,original_name,stored_path,mime_type,bytes,sha256,created_at,attribution,source_file_id) VALUES('fictional-asset','fictional.png','fictional-retained-path','image/png',1,'fictional-hash','2026-01-01','provider-evidence',?)",
        )
        .run(b.original.id),
    );
    fixtureTransaction(f.db, () =>
      f.db
        .prepare(
          "INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,body_location,event_date,person_id,created_at) VALUES('fictional-attachment','fictional-asset','medication',?,'Fictional caption','Left wrist','2026-01-12','patient','2026-01-12')",
        )
        .run(f.recordId),
    );
  });
  attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
  const p = f.preview({ ...f.request, selection: b.selection });
  const reviewed = f.preview({
    ...p.request,
    decisions: [
      {
        recordId: f.recordId,
        action: 'keep_both',
        reviewedSplit: true,
        splitMapping: p.records[0]!.mapping,
        remainingMapping: p.records[0]!.remainingMapping,
      },
    ],
  });
  const id = randomUUID();
  journal.failNextPublication();
  assert.throws(() => f.apply(reviewed, id));
  assert.equal(
    f.db.prepare("SELECT owner_id FROM attachments WHERE id='fictional-attachment'").get()!
      .owner_id,
    f.recordId,
  );
  const result = f.apply(reviewed, id),
    dest = result.outcomes[0]!.destinationRecordId;
  const path = join(f.root, 'split-rebuild.sqlite');
  rebuildRecordDatabase(path, { profileId: f.profileId, storage: journal.storage });
  const rebuilt = openDatabase(path, f.profileId);
  try {
    attachRecordDurability(rebuilt, { profileId: f.profileId, storage: journal.storage });
    const attachment = rebuilt.prepare('SELECT * FROM attachments WHERE owner_id=?').get(dest)!;
    assert.equal(attachment.caption, 'Fictional caption');
    assert.equal(attachment.body_location, 'Left wrist');
    assert.equal(attachment.event_date, '2026-01-12');
    assert.equal(attachment.person_id, f.person.personId);
    assert.equal(
      rebuilt
        .prepare('SELECT status FROM medication_preferences WHERE medication_id=?')
        .get(f.recordId)!.status,
      'current',
    );
    assert.equal(
      rebuilt.prepare('SELECT status FROM medication_preferences WHERE medication_id=?').get(dest)!
        .status,
      'not_current',
    );
    assert.ok(
      queryRecordHistory(rebuilt, {
        profileId: f.profileId,
        entity: 'medications',
        recordId: f.recordId,
      }).entries.length >= 2,
    );
    assert.deepEqual(getRecordOwnershipReceipt(rebuilt, f.profileId, id), {
      ...result,
      replayed: true,
    });
  } finally {
    rebuilt.close();
  }
});

test('ambiguous legacy contribution contents require explicit review and stale attachment approval cannot publish', (t) => {
  const f = fixture(t),
    b = attachedReport(f);
  transaction(f.db, () =>
    f.db
      .prepare(
        "DELETE FROM manual_batches WHERE title='Accepted clinical contribution' AND json_extract(coverage_json,'$.sourceRecordId')=?",
      )
      .run(b.sourceRecordId),
  );
  const p = f.preview({ ...f.request, selection: b.selection });
  assert.ok(p.records[0]!.blockers.some((b) => b.includes('incomplete or disagree')));
  const first = f.preview({
    ...p.request,
    decisions: [
      {
        recordId: f.recordId,
        action: 'keep_both',
        reviewedSplit: true,
        splitMapping: {
          ...p.records[0]!.mapping,
          testLabel: 'Reviewed fictional reach',
          valueText: '12',
        },
        remainingMapping: p.records[0]!.remainingMapping,
      },
    ],
  });
  assert.deepEqual(first.records[0]!.blockers, []);
  transaction(f.db, () =>
    f.db
      .prepare("UPDATE evidence SET role='reviewed' WHERE source_record_id=?")
      .run(b.sourceRecordId),
  );
  assert.throws(() => f.apply(first), { code: 'OWNERSHIP_CHANGED' });
  assert.equal(f.row().person_id, 'patient');
});

test('relationships require explicit withdrawal and undo preserves later clinical edits and prior receipts', async (t) => {
  const { previewClinicalRelationship, applyClinicalRelationship, clinicalRelationshipProjection } =
    await import('../clinical-relationships.ts');
  const f = fixture(t),
    other = destinationMatch(f),
    self = getNote(f.db, 'person-note:self');
  f.apply(
    f.preview({
      selection: { type: 'records', records: [{ kind: f.kind, recordId: other }] },
      destination: { noteId: self.id, expectedVersion: self.version },
      decisions: [{ recordId: other, action: 'keep_both' }],
    }),
  );
  const r = previewClinicalRelationship(f.db, f.root, f.profileId, {
    left: { kind: f.kind, recordId: f.recordId },
    right: { kind: f.kind, recordId: other },
    action: 'display_preference',
    mode: 'prefer_left',
    attestation: 'same_recorded_event',
    reason: 'Fictional reviewed event',
  });
  const relationship = applyClinicalRelationship(f.db, f.root, f.profileId, {
    request: r.request,
    scope: r.scope,
    version: r.version,
    previewToken: r.previewToken,
    operationId: randomUUID(),
  });
  const p = f.preview();
  assert.ok(p.records[0]!.blockers.some((b) => b.includes('withdraw')));
  const result = f.apply(
    f.preview({
      ...p.request,
      relationshipDecisions: [{ decisionId: relationship.receipt.decisionId, action: 'withdraw' }],
    }),
  );
  assert.equal(
    clinicalRelationshipProjection(f.db, f.profileId, { kind: f.kind, recordId: f.recordId })
      .relationships[0]!.status,
    'withdrawn',
  );
  const { correctClinicalRecord } = await import('../record-corrections.ts');
  transaction(f.db, () =>
    correctClinicalRecord(
      f.db,
      {
        kind: f.kind,
        recordId: f.recordId,
        set: { valueText: '14.00' },
        reason: 'Fictional later original-supported correction',
      },
      randomUUID(),
    ),
  );
  const currentSelf = getNote(f.db, self.id);
  f.apply(
    f.preview({
      selection: { type: 'records', records: [{ kind: f.kind, recordId: f.recordId }] },
      destination: { noteId: self.id, expectedVersion: currentSelf.version },
      decisions: [{ recordId: f.recordId, action: 'keep_both' }],
    }),
  );
  assert.equal(f.row().value_text, '14.00');
  assert.equal(f.row().person_id, 'patient');
  assert.equal(
    getRecordOwnershipReceipt(f.db, f.profileId, result.operationId).destinationPersonId,
    f.person.personId,
  );
});

test('finished historical note links retain their tuple and explain the current ownership destination and former annotation', (t) => {
  const f = fixture(t),
    dest = destinationMatch(f);
  let note = createNote(f.db, {
    kind: 'historical',
    title: 'Fictional earlier annotation',
    content: 'Original ownership understanding.',
    links: [{ targetType: f.kind, targetId: f.recordId }],
  });
  note = finishNote(f.db, note.id, note);
  const before = f.db.prepare('SELECT * FROM note_links WHERE note_id=?').all(note.id);
  f.apply(
    f.preview({
      ...f.request,
      decisions: [{ recordId: f.recordId, action: 'link', targetRecordId: dest }],
    }),
  );
  const after = getNote(f.db, note.id);
  assert.equal(after.status, 'finished');
  assert.equal(after.ownerPersonId, 'patient');
  assert.equal(after.links[0]!.ownershipRedirect, true);
  assert.ok(after.links[0]!.appUrl?.includes(encodeURIComponent(dest)));
  assert.deepEqual(f.db.prepare('SELECT * FROM note_links WHERE note_id=?').all(note.id), before);
  const backlink = relatedNotes(f.db, f.kind, dest).find((n) => n.id === note.id)!;
  assert.equal(backlink.ownerPersonId, 'patient');
  assert.equal(backlink.ownershipRedirect, true);
});

test('historical references compose reclassification before and after an ownership link', async (t) => {
  const { correctClinicalRecord } = await import('../record-corrections.ts');
  const { resolveClinicalReference } = await import('../clinical-references.ts');
  const { attachRecordDurability } = await import('../record-versions.ts');
  const journal = memoryJournal();
  const f = fixture(t, 'procedure', journal),
    dest = destinationMatch(f);
  attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
  transaction(f.db, () =>
    correctClinicalRecord(
      f.db,
      {
        kind: 'procedure',
        recordId: f.recordId,
        set: { kind: 'observation', testLabel: 'Fictional reach', valueText: '12.00', unit: 'cm' },
        reason: 'Fictional earlier classification review',
      },
      randomUUID(),
    ),
  );
  const note = createNote(f.db, {
    title: 'Fictional original result annotation',
    links: [{ targetType: 'observation', targetId: f.recordId }],
  });
  for (const recordId of [f.recordId])
    transaction(f.db, () =>
      correctClinicalRecord(
        f.db,
        {
          kind: 'observation',
          recordId,
          set: {
            kind: 'procedure',
            procedureLabel: 'Fictional procedure',
            procedureCategory: 'clinical_procedure',
          },
          reason: 'Fictional classification review',
        },
        randomUUID(),
      ),
    );
  f.apply(
    f.preview({
      ...f.request,
      selection: { type: 'records', records: [{ kind: 'procedure', recordId: f.recordId }] },
      decisions: [{ recordId: f.recordId, action: 'link', targetRecordId: dest }],
    }),
  );
  assert.deepEqual(resolveClinicalReference(f.db, 'observation', f.recordId), {
    kind: 'procedure',
    recordId: dest,
    redirected: true,
  });
  assert.equal(getNote(f.db, note.id).links[0]!.missing, false);
  assert.ok(relatedNotes(f.db, 'procedure', dest).some((n) => n.id === note.id));
  transaction(f.db, () =>
    correctClinicalRecord(
      f.db,
      {
        kind: 'procedure',
        recordId: dest,
        set: {
          kind: 'document',
          documentTitle: 'Fictional reclassified document',
          text: 'Fictional evidence',
        },
        reason: 'Fictional later classification review',
      },
      randomUUID(),
    ),
  );
  for (const kind of ['observation', 'procedure'])
    assert.deepEqual(resolveClinicalReference(f.db, kind, f.recordId), {
      kind: 'document',
      recordId: dest,
      redirected: true,
    });
  assert.ok(relatedNotes(f.db, 'document', dest).some((n) => n.id === note.id));
  assert.equal(resolveClinicalReference(f.db, 'medication', f.recordId), null);
  const { clinicalRecordHistory } = await import('../clinical-history.ts');
  const history = clinicalRecordHistory(f.db, {
    profileId: f.profileId,
    kind: 'observation',
    recordId: f.recordId,
  });
  assert.equal(history.navigation?.recordId, dest);
  assert.equal(history.currentKind, 'document');
  assert.deepEqual(new Set(history.kinds), new Set(['procedure', 'observation']));
  assert.ok(history.entries.some((entry) => entry.entity === 'observations' && !entry.deleted));
});

test('a partial correction challenges a prior report default and a later confirmation with the same timestamp can renew it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) });
  const f = fixture(t),
    report = await confirmedReport(f, 'default-then-partial');
  f.apply(f.preview({ ...f.request, selection: report.selection }));
  const selected = String(
    f.db
      .prepare('SELECT id FROM observations WHERE source_record_id=?')
      .get(report.review.records[0]!.id)!.id,
  );
  const p = f.preview({
    selection: { type: 'records', records: [{ kind: 'observation', recordId: selected }] },
    destination: { noteId: f.another.id, expectedVersion: f.another.version },
  });
  assert.equal(p.reportHolds.length, 1);
  f.apply(p);
  assert.equal(
    f.db
      .prepare('SELECT person_id FROM observations WHERE source_record_id=?')
      .get(report.review.records[1]!.id)!.person_id,
    f.person.personId,
  );
  const later = report.propose([report.value('default-then-partial-later')]);
  const review = reviewIntake(
    f.db,
    f.root,
    f.profileId,
    report.original.id,
    later.proposals.at(-1)!.id,
  );
  assert.equal(review.records[0]!.identityReview?.blocking, true);
  assert.equal(review.records[0]!.identityAttribution, undefined);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM observations WHERE person_id=?').get(f.another.personId)!
      .n,
    1,
  );
  // Keeping old evidence is not permission to revive a challenged standing assignment (identity-review.md).
  const { getIntakeIdentityScope, confirmIntakeIdentityScope } =
    await import('../intake-identity.ts');
  const scope = await getIntakeIdentityScope(
    f.db,
    f.root,
    f.profileId,
    report.original.id,
    report.selection.groupId,
  );
  const person = getNote(f.db, f.person.id);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, report.original.id, {
    scope,
    version: scope.intakeVersion,
    operationId: randomUUID(),
    outcome: 'this_is_person',
    attestation: 'reviewed_original_and_membership',
    personSelection: { noteId: person.id, expectedVersion: person.version },
    printedName: 'Robin Lane',
  });
  const held = JSON.parse(
    String(
      f.db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Report ownership default hold'",
        )
        .get()!.coverage_json,
    ),
  );
  assert.equal(
    getIntake(f.db, f.root, f.profileId, report.original.id).workflow!.identityConfirmations!.at(
      -1,
    )!.at,
    held.at,
  );
  const renewed = reviewIntake(
    f.db,
    f.root,
    f.profileId,
    report.original.id,
    later.proposals.at(-1)!.id,
  );
  assert.equal(
    renewed.records[0]!.identityReview?.blocking,
    false,
    renewed.records[0]!.identityReview?.message,
  );
  assert.equal(renewed.records[0]!.mapping.personId, f.person.personId);
});

for (const partial of [false, true])
  test(`correction-derived name support follows only report B through another move and rebuild (partial=${partial})`, async (t) => {
    const { attachRecordDurability, rebuildRecordDatabase } = await import('../record-versions.ts');
    const { prepareOwnershipEvidence } = await import('../record-ownership.ts');
    const { effectiveKnownNames } = await import('../name-associations.ts');
    const journal = memoryJournal(),
      f = fixture(t, 'observation', journal),
      a = await confirmedReport(f, 'transfer-a'),
      b = await confirmedReport(f, 'transfer-b');
    attachRecordDurability(f.db, { profileId: f.profileId, storage: journal.storage });
    const first = f.preview({
      ...f.request,
      selection: b.selection,
      destination: { noteId: f.another.id, expectedVersion: f.another.version },
    });
    const approved = f.preview({
      ...first.request,
      nameDecisions: [{ key: first.names[0]!.key, outcome: 'both' }],
    });
    const firstId = randomUUID();
    f.apply(approved, firstId);
    const remembered = getNote(f.db, f.another.id).person.sourceKnownNames!;
    assert.equal(
      remembered[0]!.intakeId,
      b.original.id,
      'never copy report A just because its spelling was remembered first',
    );
    assert.notEqual(remembered[0]!.intakeId, a.original.id);
    const path = join(f.root, 'name-support-rebuilt.sqlite');
    rebuildRecordDatabase(path, { profileId: f.profileId, storage: journal.storage });
    const db = openDatabase(path, f.profileId);
    try {
      attachRecordDurability(db, { profileId: f.profileId, storage: journal.storage });
      const bIds = b.review.records.map((r) =>
        String(db.prepare('SELECT id FROM observations WHERE source_record_id=?').get(r.id)!.id),
      );
      const input: OwnershipRequest = {
        ...f.request,
        selection: partial
          ? { type: 'records', records: [{ kind: 'observation', recordId: bIds[0]! }] }
          : b.selection,
      };
      await prepareOwnershipEvidence(db, f.root, f.profileId, input);
      const p = previewRecordOwnership(db, f.root, f.profileId, input);
      assert.equal(p.names.length, 1);
      assert.equal(p.names[0]!.noteId, f.another.id);
      assert.equal(p.names[0]!.support.length, 2);
      assert.equal(p.names[0]!.support.filter((s) => s.affected).length, partial ? 1 : 2);
      assert.equal(p.names[0]!.unknownSupport, false);
      assert.equal(p.names[0]!.independentSupport, partial);
      const reviewed = partial
        ? previewRecordOwnership(db, f.root, f.profileId, {
            ...input,
            nameDecisions: [{ key: p.names[0]!.key, outcome: 'both' }],
          })
        : p;
      const operationId = randomUUID();
      const request = {
        operationId,
        request: reviewed.request,
        version: reviewed.version,
        scopeToken: reviewed.scopeToken,
      };
      const receipt = commitRecordOwnership(db, f.root, f.profileId, request);
      assert.deepEqual(commitRecordOwnership(db, f.root, f.profileId, request), {
        ...receipt,
        replayed: true,
      });
      assert.equal(
        effectiveKnownNames(db, f.another.id, getNote(db, f.another.id).person).includes(
          'Robin Lane',
        ),
        partial,
      );
      assert.ok(
        effectiveKnownNames(
          db,
          'person-note:self',
          getNote(db, 'person-note:self').person,
        ).includes('Robin Lane'),
      );
      if (partial) {
        const remaining = previewRecordOwnership(db, f.root, f.profileId, {
          ...input,
          selection: { type: 'records', records: [{ kind: 'observation', recordId: bIds[1]! }] },
          destination: { noteId: f.person.id, expectedVersion: getNote(db, f.person.id).version },
        });
        assert.equal(
          remaining.names[0]!.support.length,
          1,
          'superseding one contribution cannot revoke a sibling from the same correction',
        );
        assert.equal(remaining.names[0]!.proposed, 'destination');
      }
    } finally {
      db.close();
    }
  });

test('reviewed ownership correction may create the Person named by a mistaken learned Self alias', async (t) => {
  const f = fixture(t),
    r = await confirmedReport(f, 'new-person-corrected-alias');
  const p = f.preview({
    selection: r.selection,
    destination: { newPerson: { fullName: 'Robin Lane' } },
  });
  assert.equal(p.names[0]!.proposed, 'destination');
  assert.deepEqual(p.blockers, []);
  const receipt = f.apply(p);
  assert.notEqual(receipt.destinationPersonId, 'patient');
  const { effectiveKnownNames } = await import('../name-associations.ts');
  assert.ok(
    !effectiveKnownNames(
      f.db,
      'person-note:self',
      getNote(f.db, 'person-note:self').person,
    ).includes('Robin Lane'),
  );
});

test('name transfer uses its exact supporting report instead of every historical group membership', async (t) => {
  const { previewOwnershipNames, commitOwnershipNames } = await import('../ownership-names.ts');
  const f = fixture(t),
    b = await confirmedReport(f, 'exact-name-report');
  transaction(f.db, () => {
    const row = f.db.prepare('SELECT id FROM source_files WHERE id=?').get(b.original.id)!;
    const details = JSON.parse(readIntakeEnvelopeText(f.db, { id: String(row.id) })!);
    const historical = structuredClone(b.group);
    historical.id = 'fictional-former-group';
    historical.versions.push({
      ...structuredClone(historical.versions.at(-1)!),
      id: 'fictional-empty-version',
      members: [],
    });
    details.intake.workflow.reportGroups.push(historical);
    writeIntakeFixtureEnvelope(f.db, b.original.id, details);
  });
  const names = previewOwnershipNames(
    f.db,
    new Set(b.review.records.map((r) => r.id)),
    new Set(['patient']),
    { ...f.request, selection: b.selection },
  );
  assert.equal(names.length, 1);
  transaction(f.db, () =>
    commitOwnershipNames(f.db, names, f.another.id, 'fictional-exact-report-name'),
  );
  const scopes = f.db
    .prepare(
      "SELECT json_extract(coverage_json,'$.groupId') groupId FROM manual_batches WHERE title='Ownership name support'",
    )
    .all();
  assert.equal(scopes.length, b.review.records.length);
  assert.ok(scopes.every((s) => s.groupId === b.group.id));
});

// Reviewed correction scope is a snapshot, never permission to move evidence
// discovered later. See docs/import/identity-review.md#correcting-accepted-person-assignments.
test('a concurrent report member invalidates the pinned whole-report correction', async (t) => {
  const f = fixture(t),
    report = await confirmedReport(f, 'concurrent-member', 2);
  const preview = f.preview({ ...f.request, selection: report.selection });
  assert.deepEqual(preview.blockers, []);
  const before = f.db.prepare('SELECT id,person_id FROM observations ORDER BY id').all();
  report.propose([report.value('concurrent-member-2')]);
  assert.throws(() => f.apply(preview), { code: 'OWNERSHIP_CHANGED' });
  assert.deepEqual(f.db.prepare('SELECT id,person_id FROM observations ORDER BY id').all(), before);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Record ownership event'")
      .get()!.n,
    0,
  );
});

test('archiving the destination after preview rejects the correction without moving records', async (t) => {
  const { setVisibility } = await import('../visibility.ts');
  const f = fixture(t),
    preview = f.preview(),
    before = f.row();
  setVisibility(f.db, 'person', f.person.personId!, { archived: true, version: 0 });
  assert.throws(() => f.apply(preview), { code: 'OWNERSHIP_DESTINATION' });
  assert.deepEqual(f.row(), before);
});

// An open acceptance editor cannot apply approval captured before a correction.
test('ownership correction permanently invalidates an in-flight clinical review token', (t) => {
  const f = fixture(t),
    pinned = reviewIntake(f.db, f.root, f.profileId, f.original.id);
  f.apply(f.preview());
  assert.throws(
    () =>
      importIntake(f.db, f.root, f.profileId, f.original.id, {
        version: pinned.version,
        reviewToken: pinned.reviewToken,
        decisions: [{ recordId: pinned.records[0]!.id, action: 'accept', mapping: {} }],
      }),
    { code: 'REVIEW_CHANGED' },
  );
  assert.equal(f.row().person_id, f.person.personId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});

test('missing legacy name-support evidence stays unknown and cannot establish sole name authority', async (t) => {
  const f = fixture(t),
    report = await confirmedReport(f, 'unknown-legacy-support', 1);
  // Simulate an actual older journal with no support entry. Do not synthesize
  // an entry whose independent flags happen to be absent.
  fixtureTransaction(f.db, () =>
    f.db.prepare("DELETE FROM manual_batches WHERE title='Remembered name support'").run(),
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Remembered name support'")
      .get()!.n,
    0,
  );
  const preview = f.preview({ ...f.request, selection: report.selection });
  assert.equal(preview.names.length, 1);
  assert.equal(preview.names[0]!.unknownSupport, true);
  assert.equal(preview.names[0]!.proposed, 'unresolved');
  f.apply(preview);
  const later = await laterPrintedNameReview(f, 'after-unknown-legacy-support');
  assert.equal(later.review.records[0]!.identityReview?.blocking, true);
});

test('a mixed-owner report previews both prior owners and moves only its reviewed members', async (t) => {
  const f = fixture(t),
    report = await confirmedReport(f, 'mixed-owner-report', 2);
  const reportRecordIds = report.review.records.map((record) =>
    String(f.db.prepare('SELECT id FROM observations WHERE source_record_id=?').get(record.id)!.id),
  );
  const rowsBefore = f.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const one = f.preview({
    ...f.request,
    selection: {
      type: 'records',
      records: [{ kind: 'observation', recordId: reportRecordIds[0]! }],
    },
  });
  f.apply(one);
  const preview = f.preview({
    ...f.request,
    selection: report.selection,
    destination: { noteId: f.another.id, expectedVersion: f.another.version },
  });
  assert.deepEqual(
    new Set(preview.records.map((record) => record.owner.personId)),
    new Set(['patient', f.person.personId]),
  );
  assert.equal(preview.records.length, 2);
  assert.equal(preview.reportDefault, true);
  const receipt = f.apply(preview);
  assert.equal(receipt.moved, 2);
  for (const id of reportRecordIds)
    assert.equal(
      f.db.prepare('SELECT person_id FROM observations WHERE id=?').get(id)!.person_id,
      f.another.personId,
    );
  assert.equal(f.row().person_id, 'patient', 'the unrelated source stays with Self');
  for (const before of rowsBefore) {
    const after = f.db.prepare('SELECT * FROM observations WHERE id=?').get(before.id!)!;
    for (const [field, value] of Object.entries(before))
      if (!['extra_json', 'person_id'].includes(field))
        assert.deepEqual(after[field], value, field);
  }
});

test('native selected record pages all attached originals, refuses an off-page source race and retains complete authority through recovery', async (t) => {
  const {
    previewNativeRecordOwnership,
    commitNativeRecordOwnership,
    nativeOwnershipReportPlan,
    clearNativeOwnershipPlans,
  } = await import('../record-ownership-native.ts');
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts');
  const { ownershipReceiptReference, replayOwnershipReceiptReference } =
    await import('../ownership-outcome-page.ts');
  const { rebuildRecordDatabase, attachRecordDurability } = await import('../record-versions.ts');
  const { ownershipIdentityIssueIncluded } = await import('../ownership-identity-snapshots.ts');
  const journal = memoryJournal(),
    f = fixture(t, 'observation', journal),
    b = attachedReport(f),
    c = attachedReport(f, 'c');
  for (const original of [f.original, b.original, c.original])
    await buildIntakeCollectionEnvelope(f.db, { id: original.id });
  t.after(() => clearNativeOwnershipPlans(f.db));
  const preview = await previewNativeRecordOwnership(f.db, f.root, f.profileId, f.request);
  assert.ok('reportEvidence' in preview);
  const plan = nativeOwnershipReportPlan(f.db, f.profileId, preview.reportEvidence.token),
    record = plan.page('records').items[0]!;
  assert.ok('mapping' in record);
  assert.ok(!Array.isArray(record.contributions));
  assert.equal(record.contributions.total, 3);
  assert.equal(record.contributions.selectedTotal, 3);
  const ids: string[] = [];
  let after = -1;
  for (;;) {
    const page = plan.contributionPage(record.contributions.key, null, after, 1, 65536);
    assert.equal(page.items.length, 1);
    ids.push((page.items[0] as { sourceRecordId: string }).sourceRecordId);
    if (page.complete) break;
    after = Number(page.after);
  }
  assert.ok(ids.includes(b.sourceRecordId));
  assert.ok(ids.includes(c.sourceRecordId));
  await plan.prepareSourceSnapshots();
  const oldHash = String(
    f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(c.original.id)!.sha256,
  );
  fixtureTransaction(f.db, () =>
    f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('f'.repeat(64), c.original.id),
  );
  await assert.rejects(
    commitNativeRecordOwnership(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      request: preview.request,
      version: preview.version,
      scopeToken: preview.scopeToken,
    }),
  );
  assert.equal(f.row().person_id, 'patient');
  fixtureTransaction(f.db, () =>
    f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(oldHash, c.original.id),
  );
  const fresh = await previewNativeRecordOwnership(f.db, f.root, f.profileId, f.request),
    operationId = randomUUID(),
    command = {
      operationId,
      request: fresh.request,
      version: fresh.version,
      scopeToken: fresh.scopeToken,
    };
  const receipt = await commitNativeRecordOwnership(f.db, f.root, f.profileId, command);
  assert.equal(receipt.moved, 1);
  assert.equal(f.row().person_id, f.person.personId);
  const sourceAuthorities = f.db
    .prepare("SELECT coverage_json FROM manual_batches WHERE title='Record ownership source'")
    .all()
    .map((row) => JSON.parse(String(row.coverage_json)));
  assert.equal(sourceAuthorities.length, 3);
  assert.deepEqual(sourceAuthorities.map((row) => row.sourceRecordId).sort(), ids.sort());
  assert.equal(replayOwnershipReceiptReference(f.db, f.profileId, command)?.replayed, true);
  const restoredPath = join(f.root, 'ownership-restored.sqlite');
  rebuildRecordDatabase(restoredPath, { profileId: f.profileId, storage: journal.storage });
  const restored = openDatabase(restoredPath, f.profileId);
  try {
    attachRecordDurability(restored, { profileId: f.profileId, storage: journal.storage });
    attachPersonalDurability(restored, {
      root: f.root,
      profileId: f.profileId,
      recordStorage: journal.storage,
    });
    assert.equal(
      restored.prepare('SELECT person_id FROM observations WHERE id=?').get(f.recordId)!.person_id,
      f.person.personId,
    );
    assert.equal(ownershipReceiptReference(restored, f.profileId, operationId)?.moved, 1);
    for (const row of sourceAuthorities)
      assert.equal(
        ownershipIdentityIssueIncluded(restored, row.identityIssues, 'unreviewed'),
        false,
      );
  } finally {
    restored.close();
  }
});

test('native selected-record evidence pages complete report-default holds and publishes them without moving unselected records', async (t) => {
  const {
    previewNativeRecordOwnership,
    commitNativeRecordOwnership,
    nativeOwnershipReportPlan,
    clearNativeOwnershipPlans,
  } = await import('../record-ownership-native.ts');
  const { buildIntakeCollectionEnvelope } = await import('../intake-envelope-build.ts');
  const f = fixture(t),
    report = await confirmedReport(f, 'native-single-token-hold', 3, 2, 'R');
  const recordId = String(
      f.db
        .prepare('SELECT id FROM observations WHERE source_record_id=?')
        .get(report.review.records[0]!.id)!.id,
    ),
    otherId = String(
      f.db
        .prepare('SELECT id FROM observations WHERE source_record_id=?')
        .get(report.review.records[1]!.id)!.id,
    );
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [{ kind: 'observation', recordId }] },
    destination: { noteId: f.person.id, expectedVersion: f.person.version },
  };
  const oracle = f.preview(request);
  assert.equal(oracle.reportHolds.length, 1);
  await buildIntakeCollectionEnvelope(f.db, { id: report.original.id });
  const preview = await previewNativeRecordOwnership(f.db, f.root, f.profileId, request);
  assert.ok('reportEvidence' in preview);
  assert.equal(preview.reportHoldsIncluded, false);
  assert.equal('reportHolds' in preview, false);
  assert.equal(preview.reportEvidence.reportHoldTotal, 1);
  const plan = nativeOwnershipReportPlan(f.db, f.profileId, preview.reportEvidence.token),
    page = plan.page('holds', -1, 1, 65536);
  assert.deepEqual(page.items, oracle.reportHolds);
  assert.equal(page.complete, true);
  await commitNativeRecordOwnership(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    request: preview.request,
    scopeToken: preview.scopeToken,
    version: preview.version,
  });
  assert.equal(
    f.db.prepare('SELECT person_id FROM observations WHERE id=?').get(recordId)!.person_id,
    f.person.personId,
  );
  assert.equal(
    f.db.prepare('SELECT person_id FROM observations WHERE id=?').get(otherId)!.person_id,
    'patient',
  );
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Report ownership default hold'")
      .get()!.n,
    1,
  );
  clearNativeOwnershipPlans(f.db);
});
