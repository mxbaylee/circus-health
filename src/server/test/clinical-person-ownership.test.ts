import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { createNote } from '../notes.ts';
import {
  clinicalList,
  clinicalPerson,
  documents,
  getObservation,
  observations,
  setMedicationCurrentStatus,
  testTypes,
  trends,
} from '../queries.ts';
import { historicalNotes, historicalNoteOptions, getHistoricalNote } from '../historical-notes.ts';
import { visionPrescriptions } from '../vision.ts';
import { relatedRecordIds } from '../related-records.ts';
import { duplicateRecord, previewDuplicateDecision } from '../duplicate-review.ts';
import { exportOptions, exportSnapshot } from '../note-exports.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-clinical-owner-'));
  const db = openDatabase(join(root, 'database.sqlite'), 'fictional-owner');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = createNote(db, {
    kind: 'person',
    title: 'Rowan Example',
    person: { fullName: 'Rowan Example' },
  });
  const family = person.personId!;
  db.exec(
    "INSERT INTO source_files(id,path,sha256,bytes) VALUES('file','fictional.json','fictional',1); INSERT INTO source_records(id,source_file_id,raw_json) VALUES('raw','file','{}'); INSERT INTO test_types(id,label) VALUES('shared','Fictional count')",
  );
  for (const [suffix, personId, value] of [
    ['self', 'patient', 10],
    ['family', family, 90],
  ] as const) {
    const extra = JSON.stringify({
      sourceFields: { type: 'Progress Notes' },
      import: {
        personId,
        identity: suffix,
        acceptedMapping: {
          subject: suffix === 'self' ? 'self' : 'other',
          kind: 'observation',
          testLabel: 'Fictional count',
          opticalPrescription: {
            type: 'spectacle',
            eyes: [{ side: 'right', sph: { valueText: '+1.00' } }],
          },
        },
      },
    });
    db.prepare(
      "INSERT INTO observations(id,test_type_id,person_id,source_record_id,label,value_text,value_numeric,effective_at,extra_json) VALUES(?,'shared',?,'raw','Fictional count',?,?,'2026-01-01',?)",
    ).run('obs-' + suffix, personId, String(value), value, extra);
    db.prepare(
      "INSERT INTO medications(id,person_id,source_record_id,kind,label) VALUES(?,?,'raw','order','Fictional medication')",
    ).run('med-' + suffix, personId);
    db.prepare(
      "INSERT INTO procedures(id,person_id,source_record_id,label) VALUES(?,?,'raw','Fictional procedure')",
    ).run('proc-' + suffix, personId);
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title,effective_at,extra_json) VALUES(?,'raw','Fictional progress note','2026-01-01',?)",
    ).run('doc-' + suffix, extra);
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES(?,'observation',?,'raw')",
    ).run('evidence-' + suffix, 'obs-' + suffix);
  }
  return { db, family, person };
}

test('Self collections and trends exclude family records; explicit owner filters and details retain reachability', (t) => {
  const { db, family, person } = fixture(t);
  for (const [personId, suffix, value] of [
    ['patient', 'self', 10],
    [family, 'family', 90],
  ] as const) {
    const params = new URLSearchParams(personId === 'patient' ? {} : { personId });
    assert.deepEqual(
      observations(db, params).data.map((row) => row.id),
      ['obs-' + suffix],
    );
    assert.equal(testTypes(db, params)[0]?.count, 1);
    params.set('ids', 'shared');
    assert.deepEqual(
      trends(db, params)[0]?.points.map((row) => row.value),
      [value],
    );
    assert.deepEqual(
      clinicalList(db, 'procedures', params).data.map((row) => row.id),
      ['proc-' + suffix],
    );
    params.set('status', 'archived');
    assert.deepEqual(
      clinicalList(db, 'medications', params).data.map((row) => row.id),
      ['med-' + suffix],
      'unknown status OR cannot bypass owner',
    );
    assert.deepEqual(
      documents(db, params).data.map((row) => row.id),
      ['doc-' + suffix],
    );
  }
  const detail = getObservation(db, 'obs-family');
  assert.ok(!('reclassifiedTo' in detail));
  assert.equal(detail.personId, family);
  assert.deepEqual(clinicalPerson(db, family), {
    personId: family,
    noteId: person.id,
    name: 'Rowan Example',
  });
});

test('historical and optical documents use durable import ownership and default to Self', (t) => {
  const { db, family } = fixture(t);
  for (const [personId, suffix] of [
    ['patient', 'self'],
    [family, 'family'],
  ] as const) {
    const params = new URLSearchParams(personId === 'patient' ? {} : { personId });
    assert.deepEqual(
      historicalNotes(db, params).data.map((row) => row.id),
      ['doc-' + suffix],
    );
    assert.equal(historicalNoteOptions(db, params).sources[0]?.count, 1);
    assert.deepEqual(
      visionPrescriptions(db, params).data.map((row) => row.id),
      ['doc-' + suffix],
    );
    assert.equal(getHistoricalNote(db, 'doc-' + suffix).personId, personId);
  }
});

test('family current medication assertions stay on that record and outside Self collections', (t) => {
  const { db, family } = fixture(t);
  setMedicationCurrentStatus(db, 'med-family', {
    status: 'current',
    version: 0,
    visibilityVersion: 0,
  });
  assert.equal(clinicalList(db, 'medications', new URLSearchParams()).total, 0);
  assert.deepEqual(
    clinicalList(db, 'medications', new URLSearchParams({ personId: family })).data.map(
      (row) => row.id,
    ),
    ['med-family'],
  );
});

test('related record discovery and saved pair decisions cannot combine different owners', (t) => {
  const { db, family } = fixture(t);
  for (const [personId, suffix] of [
    ['patient', 'self'],
    [family, 'family'],
  ] as const) {
    const found = relatedRecordIds(db, {
      kind: 'observation',
      identity: 'incoming',
      mapping: {
        kind: 'observation',
        subject: personId === 'patient' ? 'self' : 'other',
        personId,
        testLabel: 'Fictional count',
      },
    });
    assert.deepEqual(
      found.matches.map((row) => row.id),
      ['obs-' + suffix],
    );
    assert.equal(duplicateRecord(db, 'observation', 'obs-' + suffix).mapping.personId, personId);
  }
  assert.throws(
    () =>
      previewDuplicateDecision(db, {
        kind: 'observation',
        recordId: 'obs-self',
        otherRecordId: 'obs-family',
        outcome: 'same_event',
        reason: 'Fictional test',
      }),
    { code: 'DUPLICATE_PERSON' },
  );
});

test('Self print selections exclude family documents and direct family clinical exports fail explicitly', (t) => {
  const { db } = fixture(t);
  const note = createNote(db, { kind: 'historical', title: 'Fictional Self appointment' });
  const options = exportOptions(db, { type: 'note', id: note.id });
  assert.ok(options.choices.some((choice) => choice.id === 'doc-self'));
  assert.ok(!options.choices.some((choice) => choice.id === 'doc-family'));
  assert.throws(() => exportOptions(db, { type: 'document', id: 'doc-family' }), {
    code: 'EXPORT_SUBJECT',
  });
  assert.throws(
    () =>
      exportSnapshot(db, {
        type: 'note',
        id: note.id,
        noteVersion: note.version,
        mode: 'brief',
        selected: ['document:doc-family'],
      }),
    { code: 'EXPORT_SUBJECT' },
  );
});
