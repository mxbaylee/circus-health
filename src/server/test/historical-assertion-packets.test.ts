import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { createNote } from '../notes.ts';
import { exportSnapshot, exportOptions, exportHtml, exportEvidence } from '../note-exports.ts';
import { sourceAssertionOwnership } from '../source-assertion-ownership.ts';
import { sourceRecords, getSourceRecord } from '../queries.ts';
import { setVisibility } from '../visibility.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-historical-owners-'));
  const profileId = 'fictional-household';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Independently fictional historical family archive.');
  const path = `${paths.relativeRoot}/sources/fictional/original.txt`;
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), original);
  db.exec("INSERT INTO providers VALUES('issuer','Fictional Clinic')");
  db.prepare('INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES(?,?,?,?,?)').run(
    'family-file',
    'issuer',
    path,
    createHash('sha256').update(original).digest('hex'),
    original.length,
  );
  const managed = createNote(db, { kind: 'person', title: 'Fictional Morgan' }).personId!;
  const clinician = createNote(db, { kind: 'person', title: 'Fictional Dr. River' }).personId!;
  function raw(id: string, kind: string, subject?: string) {
    db.prepare(
      'INSERT INTO source_records(id,source_file_id,provider_id,kind,raw_json) VALUES(?,?,?,?,?)',
    ).run(
      id,
      'family-file',
      'issuer',
      kind,
      JSON.stringify({ data: { display: `PRIVATE ${id}`, patientName: 'Fictional Morgan' } }),
    );
    if (subject) evidence(id, subject, 'report_subject');
  }
  function evidence(id: string, person: string, role: string) {
    db.prepare(
      'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,?,?,?,?)',
    ).run(`${id}:${person}:${role}`, 'person', person, id, role);
  }
  return { db, root, profileId, managed, clinician, raw, evidence };
}
function packet(db: Database, personId = 'patient') {
  const input = { type: 'person', id: personId };
  return exportSnapshot(db, {
    ...input,
    mode: 'provider',
    noteVersion: exportOptions(db, input).noteVersion,
  });
}
function ids(db: Database, personId = 'patient') {
  return packet(db, personId)
    .records.filter((r) => r.type === 'source')
    .map((r) => r.id);
}

test('historical raw kinds use the same case-insensitive inclusion and omission boundary', (t) => {
  const f = fixture(t);
  for (const kind of [
    'clinical_object',
    'allergy',
    'allergies',
    'allergyintolerance',
    'condition',
    'conditions',
    'diagnosis',
    'diagnoses',
    'encounter',
    'encounters',
    'visit',
    'visits',
    'immunization',
    'immunizations',
  ].flatMap((kind) => [kind, kind.toUpperCase()])) {
    f.raw(kind, kind);
    assert.equal(sourceAssertionOwnership(f.db, kind).state, 'unassigned');
    assert.equal(sourceAssertionOwnership(f.db, kind).packetRole, 'additional_assertion');
    assert.equal(packet(f.db).unassignedRawAssertionsOmitted, true, kind);
    assert.deepEqual(ids(f.db), []);
    f.evidence(kind, 'patient', 'report_subject');
    assert.equal(sourceAssertionOwnership(f.db, kind).state, 'single');
    assert.equal(sourceAssertionOwnership(f.db, kind).ownerPersonId, 'patient');
    assert.ok(ids(f.db).includes(kind), kind);
    assert.equal(packet(f.db).unassignedRawAssertionsOmitted, false, kind);
    // Isolate each spelling; prior accepted assertions must not mask an omission.
    f.db.prepare('DELETE FROM evidence WHERE source_record_id=?').run(kind);
    f.db.prepare('DELETE FROM source_records WHERE id=?').run(kind);
  }
});

test('a dangling historical report subject remains omitted and generically disclosed', (t) => {
  const f = fixture(t);
  f.raw('dangling', 'condition', 'missing-person');
  const snapshot = packet(f.db);
  assert.deepEqual(ids(f.db), []);
  assert.equal(snapshot.unassignedRawAssertionsOmitted, true);
  assert.doesNotMatch(exportHtml(snapshot), /PRIVATE dangling|missing-person/);
  assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), /PRIVATE dangling|missing-person/);
});

test('legacy mixed-family ownership stays exact and nonidentifying through source-only rebuild', (t) => {
  const f = fixture(t);
  f.raw('self', 'CLINICAL_OBJECT', 'patient');
  f.raw('managed', 'Allergy', f.managed);
  f.raw('conflicting', 'condition', 'patient');
  f.evidence('conflicting', f.managed, 'report_subject');
  f.evidence('self', f.clinician, 'source');
  f.raw('mention-only', 'visit');
  f.evidence('mention-only', f.clinician, 'source');
  f.raw('no-proof', 'immunization');
  // Old raw payloads and copied mapping-looking fields cannot stand in for an
  // accepted, exact source occurrence. The original remains available to review.
  f.db.prepare('UPDATE source_records SET raw_json=? WHERE id=?').run(
    JSON.stringify({
      clinical: { subject: 'self' },
      import: { acceptedMapping: { personId: f.managed } },
      identityConfirmations: [{ outcome: 'this_is_me' }],
      display: 'PRIVATE no-proof',
    }),
    'no-proof',
  );
  const check = (db: Database) => {
    assert.deepEqual(ids(db), ['self']);
    assert.deepEqual(ids(db, f.managed), ['managed']);
    assert.deepEqual(ids(db, f.clinician), []);
    for (const person of ['patient', f.managed, f.clinician]) {
      const snapshot = packet(db, person);
      assert.equal(snapshot.unassignedRawAssertionsOmitted, true);
      assert.doesNotMatch(exportHtml(snapshot), /PRIVATE (conflicting|mention-only|no-proof)/);
      assert.doesNotMatch(
        JSON.stringify(exportEvidence(snapshot)),
        /PRIVATE (conflicting|mention-only|no-proof)/,
      );
    }
    assert.equal(db.prepare('SELECT count(*) n FROM source_records').get()!.n, 5);
  };
  check(f.db);
  attachPersonalDurability(f.db, { root: f.root, profileId: f.profileId });
  exportCuration(f.db, f.root, f.profileId);
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'rebuilt'));
  const database = openDatabase(rebuilt.database, f.profileId);
  try {
    check(database);
  } finally {
    database.close();
  }
});

test('unprojected intake rows remain notice-only and nonclinical source kinds do not create omissions', (t) => {
  const f = fixture(t);
  f.raw('context', 'context');
  assert.equal(packet(f.db).unassignedRawAssertionsOmitted, false);
  for (const kind of ['intake_record', 'intake_document', 'INTAKE_RECORD', 'INTAKE_DOCUMENT']) {
    f.raw(kind, kind);
    assert.equal(packet(f.db).unassignedRawAssertionsOmitted, true);
    f.evidence(kind, 'patient', 'report_subject');
    assert.deepEqual(ids(f.db), []);
    assert.equal(packet(f.db).unassignedRawAssertionsOmitted, false);
  }
});

test('real persisted identity receipts and accepted mappings do not assign a neighboring historical assertion', async (t) => {
  const f = fixture(t);
  const { getNote, saveNote } = await import('../notes.ts');
  const intake = await import('../intake.ts');
  const { getIntakeIdentityReview, confirmIntakeIdentityScope } =
    await import('../intake-identity.ts');
  const self = getNote(f.db, 'person-note:self');
  saveNote(f.db, self.id, {
    version: self.version,
    person: { ...self.person, fullName: 'Fictional Iris Meadow', birthDate: '1982-04-17' },
  });
  const item = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-mixed-history.txt',
    newProviderName: 'Fictional History Clinic',
    bytes: Buffer.from(
      'Fictional history report\nPatient: Fictional Iris Meadow\nFictional count 12.00\nSeparate unresolved historical assertion',
    ),
  });
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    summary: 'One fictional observation',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-count',
      kind: 'record',
      payload: { literal: '12.00' },
      provenance: {
        capturedVia: null,
        sourceSystem: 'Fictional History Clinic',
        sourceRecordId: 'fictional-count',
        evidenceClass: 'provider_export',
        locator: 'page 1 count',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional count',
        valueText: '12.00',
        unit: 'mg',
        date: '2026-03-02',
      },
      report: {
        key: 'history',
        title: 'Fictional history report',
        anchor: { locator: 'page 1 heading', text: 'Fictional history report' },
        subject: { locator: 'page 1 patient', text: 'Fictional Iris Meadow' },
      },
    }),
  });
  const identity = await getIntakeIdentityReview(
    f.db,
    f.root,
    f.profileId,
    item.id,
    proposed.workflow!.reportGroups![0]!.id,
  );
  assert.ok(identity.scope);
  await confirmIntakeIdentityScope(f.db, f.root, f.profileId, item.id, {
    version: identity.scope.intakeVersion,
    operationId: 'fictional-exact-identity',
    scope: identity.scope,
    outcome: 'this_is_me',
    attestation: 'confirmed_displayed_report_subject',
  });
  const proposalId = proposed.proposals[0]!.id;
  const review = intake.reviewIntake(f.db, f.root, f.profileId, item.id, proposalId);
  intake.importIntake(f.db, f.root, f.profileId, item.id, {
    version: review.version,
    proposalId,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  f.raw('neighbor', 'condition');
  f.db.prepare('UPDATE source_records SET source_file_id=? WHERE id=?').run(item.id, 'neighbor');
  const check = (db: Database) => {
    const receipt = intake.getIntake(db, f.root, f.profileId, item.id).workflow!
      .identityConfirmations![0]!;
    assert.equal(receipt.operationId, 'fictional-exact-identity');
    assert.ok(
      (receipt.scope.assignmentTargets || receipt.scope.targets).some(
        (target) => target.recordId === review.records[0]!.id,
      ),
    );
    const accepted = db
      .prepare(
        "SELECT coverage_json FROM manual_batches WHERE title='Accepted clinical contribution'",
      )
      .get();
    assert.ok(accepted, 'use an actual accepted contribution, not receipt-shaped raw data');
    assert.equal(JSON.parse(String(accepted.coverage_json)).sourceRecordId, review.records[0]!.id);
    const snapshot = packet(db);
    assert.ok(snapshot.records.some((record) => record.type === 'observation'));
    assert.equal(snapshot.unassignedRawAssertionsOmitted, true);
    assert.ok(!snapshot.records.some((record) => record.id === 'neighbor'));
    assert.doesNotMatch(exportHtml(snapshot), /PRIVATE neighbor/);
    assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), /PRIVATE neighbor/);
  };
  check(f.db);
  exportCuration(f.db, f.root, f.profileId);
  const rebuilt = rebuildProfile(f.root, f.profileId, resolve(f.root, 'receipt-rebuild'));
  const db = openDatabase(rebuilt.database, f.profileId);
  try {
    check(db);
  } finally {
    db.close();
  }
});

test('the generic notice clears only after the final eligible ambiguity is resolved', (t) => {
  const f = fixture(t);
  f.raw('first', 'allergy');
  f.raw('last', 'condition');
  const check = (omitted: boolean) => {
    for (const person of ['patient', f.managed]) {
      const snapshot = packet(f.db, person);
      assert.equal(snapshot.unassignedRawAssertionsOmitted, omitted);
      if (omitted) {
        assert.doesNotMatch(exportHtml(snapshot), /PRIVATE last/);
        assert.doesNotMatch(JSON.stringify(exportEvidence(snapshot)), /PRIVATE last/);
      }
    }
  };
  check(true);
  // Fixture transitions model the packet after authority exists; they are not
  // an implementation of the deferred reviewed-assignment write path.
  f.evidence('first', 'patient', 'report_subject');
  check(true);
  assert.deepEqual(ids(f.db), ['first']);
  assert.deepEqual(ids(f.db, f.managed), []);
  f.evidence('last', f.managed, 'report_subject');
  check(false);
  assert.deepEqual(ids(f.db), ['first']);
  assert.deepEqual(ids(f.db, f.managed), ['last']);
});

test('ownership assessments preserve exact subjects, bound references and never write or approve', (t) => {
  const f = fixture(t);
  f.raw('missing-owner', 'allergy');
  f.evidence('missing-owner', f.clinician, 'source');
  f.raw('dangling-owner', 'condition', 'absent');
  f.raw('mixed-owner', 'visit', 'patient');
  f.evidence('mixed-owner', f.managed, 'report_subject');
  f.raw('duplicate-owner', 'immunization', f.managed);
  // Current storage rejects duplicate exact subjects; the assessment still counts distinct owners.
  assert.throws(
    () =>
      f.db
        .prepare(
          'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,?,?,?,?)',
        )
        .run(
          'same-owner-second-evidence',
          'person',
          f.managed,
          'duplicate-owner',
          'report_subject',
        ),
    /UNIQUE constraint failed/,
  );
  f.raw('many-owners', 'condition');
  for (let i = 0; i < 105; i++) f.evidence('many-owners', `missing-${i}`, 'report_subject');
  const beforePacket = ids(f.db, f.managed);
  const beforeChanges = f.db.prepare('SELECT total_changes() n').get()!.n;
  const missing = sourceAssertionOwnership(f.db, 'missing-owner');
  assert.equal(missing.state, 'unassigned');
  assert.equal(missing.ownerPersonId, null);
  assert.equal(missing.subjects.total, 0);
  assert.equal(missing.originalIntegrity, 'not_checked');
  assert.equal(missing.assignmentAuthority, 'read_only');
  assert.equal(missing.sourceRecordUrl, '/source-records/missing-owner?fileView=reference');
  assert.equal(
    getSourceRecord(f.db, missing.sourceRecordId, { fileView: 'reference' }).file?.id,
    'family-file',
  );
  assert.equal(sourceAssertionOwnership(f.db, 'dangling-owner').state, 'dangling');
  assert.equal(sourceAssertionOwnership(f.db, 'dangling-owner').ownerPersonId, null);
  assert.equal(sourceAssertionOwnership(f.db, 'mixed-owner').state, 'conflicting');
  assert.equal(sourceAssertionOwnership(f.db, 'mixed-owner').ownerPersonId, null);
  const duplicate = sourceAssertionOwnership(f.db, 'duplicate-owner');
  assert.equal(duplicate.state, 'single');
  assert.equal(duplicate.subjects.total, 1);
  assert.equal(duplicate.ownerPersonId, f.managed);
  const many = sourceAssertionOwnership(f.db, 'many-owners');
  assert.equal(many.state, 'conflicting');
  assert.equal(many.subjects.items.length, 100);
  assert.equal(many.subjects.limit, 100);
  assert.equal(many.subjects.total, 105);
  assert.equal(many.subjects.truncated, true);
  assert.ok(many.subjects.items.every((s) => !s.personExists));
  assert.deepEqual(ids(f.db, f.managed), beforePacket);
  assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, beforeChanges);
  assert.throws(() => sourceAssertionOwnership(f.db, 'not-retained'), {
    status: 404,
    code: 'NOT_FOUND',
  });
});

test('unresolved source filtering shares packet scope and composes with pagination and visibility', (t) => {
  const f = fixture(t);
  for (const [id, kind] of [
    ['a-allergy', 'ALLERGY'],
    ['b-dangling', 'condition'],
    ['c-intake', 'INTAKE_RECORD'],
    ['d-unsupported', 'person'],
    ['e-represented', 'visit'],
    ['f-private', 'condition'],
    ['g-unknown-provider', 'condition'],
    ['h-owned', 'allergy'],
    ['i-archived', 'condition'],
  ])
    f.raw(id!, kind!);
  f.evidence('b-dangling', 'not-a-person', 'report_subject');
  f.evidence('h-owned', 'patient', 'report_subject');
  f.db
    .prepare(
      'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,?,?,?,?)',
    )
    .run('normalized', 'observation', 'normalized-observation', 'e-represented', 'source');
  f.db.exec("INSERT INTO providers VALUES('personal','Personal notes')");
  f.db.exec("UPDATE source_records SET provider_id='personal' WHERE id='f-private'");
  f.db.exec("UPDATE source_records SET provider_id=NULL WHERE id='g-unknown-provider'");
  setVisibility(f.db, 'source', 'i-archived', { archived: true, version: 0 });
  const query = (extra = '') =>
    sourceRecords(f.db, new URLSearchParams('ownership=unresolved' + extra));
  assert.deepEqual(
    query().data.map((r) => r.id),
    ['a-allergy', 'b-dangling', 'c-intake'],
  );
  const first = query('&limit=2');
  assert.equal(first.total, 3);
  assert.equal(first.complete, false);
  assert.deepEqual(
    first.data.map((r) => r.id),
    ['a-allergy', 'b-dangling'],
  );
  assert.deepEqual(
    query('&limit=2&offset=2').data.map((r) => r.id),
    ['c-intake'],
  );
  assert.deepEqual(query('&providerId=personal').data, []);
  assert.deepEqual(query('&sourceFileId=missing').data, []);
  assert.equal(query('&sourceFileId=family-file').total, 3);
  assert.deepEqual(
    query('&visibility=archived').data.map((r) => r.id),
    ['i-archived'],
  );
  assert.equal(sourceAssertionOwnership(f.db, 'c-intake').packetRole, 'notice_only');
  for (const id of ['d-unsupported', 'e-represented', 'f-private', 'g-unknown-provider'])
    assert.equal(sourceAssertionOwnership(f.db, id).packetRole, 'outside_scope');
  assert.equal(packet(f.db).unassignedRawAssertionsOmitted, true);
  for (const invalid of [
    'ownership=',
    'ownership=single',
    'ownership=unresolved&ownership=unresolved',
  ])
    assert.throws(() => sourceRecords(f.db, new URLSearchParams(invalid)), {
      status: 400,
      code: 'INVALID_OWNERSHIP_FILTER',
    });
});
