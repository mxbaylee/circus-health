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
    'ALLERGY',
    'AllergyIntolerance',
    'CONDITIONS',
    'Diagnosis',
    'Encounters',
    'VISIT',
    'IMMUNIZATIONS',
    'CLINICAL_OBJECT',
  ]) {
    f.raw(kind, kind);
    assert.equal(packet(f.db).unassignedRawAssertionsOmitted, true, kind);
    assert.deepEqual(ids(f.db), []);
    f.evidence(kind, 'patient', 'report_subject');
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
  f.raw('intake', 'intake_record');
  assert.equal(packet(f.db).unassignedRawAssertionsOmitted, true);
  f.evidence('intake', 'patient', 'report_subject');
  assert.deepEqual(ids(f.db), []);
});
