import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpError, openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { rebuildProfile } from '../portable.ts';
import { getObservation } from '../queries.ts';
import { exportOptions, exportSnapshot, exportHtml, exportEvidence } from '../note-exports.ts';
import type { IntakeClinicalMapping, IntakeReviewDecision } from '../../shared/intake.ts';

const envelope = (
  id: string,
  clinical: Partial<IntakeClinicalMapping>,
  origin = 'Synthetic Hospital',
) => ({
  format: 'health-record-v1',
  id,
  kind: clinical.kind === 'document' ? 'document' : 'record',
  payload: { verbatim: 'Original report remains unchanged', clinical },
  clinical,
  provenance: {
    capturedVia: 'Patient export',
    sourceSystem: origin,
    sourceRecordId: id,
    evidenceClass: 'provider_export',
    locator: 'page 1 row ' + id,
  },
  coverage: { status: 'complete_response', notes: [] },
});
const lab: IntakeClinicalMapping = {
  kind: 'observation',
  subject: 'self',
  testLabel: 'Example test',
  date: '2024-07',
  valueText: '< 12.00',
  unit: 'mg/dL',
  referenceText: '0–20',
};
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-clinical-import-'));
  const id = 'orchid';
  const paths = ensureProfileDirectories(root, id);
  const db = openDatabase(paths.database, id);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, id, db };
}
function upload(
  f: ReturnType<typeof fixture>,
  rows: unknown[],
  name = 'office.jsonl',
  provider = 'Office',
) {
  return uploadIntake(f.db, f.root, f.id, {
    filename: name,
    newProviderName: provider,
    bytes: Buffer.from(rows.map((x) => JSON.stringify(x)).join('\n')),
  });
}
type Review = ReturnType<typeof reviewIntake>;
type TestDecision = Omit<IntakeReviewDecision, 'mapping'> & {
  mapping?: IntakeReviewDecision['mapping'];
};
type AcceptedIntake = ReturnType<typeof importIntake> & {
  imported: NonNullable<ReturnType<typeof importIntake>['imported']> & {
    clinical: NonNullable<NonNullable<ReturnType<typeof importIntake>['imported']>['clinical']>;
  };
};
function accept(
  f: ReturnType<typeof fixture>,
  intake: ReturnType<typeof uploadIntake>,
  decisions?: (review: Review) => TestDecision[],
): AcceptedIntake {
  const review = reviewIntake(f.db, f.root, f.id, intake.id);
  return importIntake(f.db, f.root, f.id, intake.id, {
    version: intake.version,
    reviewToken: review.reviewToken,
    decisions: (decisions
      ? decisions(review)
      : review.records.map((record) => ({
          recordId: record.id,
          action: record.classification === 'unsupported' ? 'skip' : 'accept',
          mapping: {},
        }))) as IntakeReviewDecision[],
  }) as AcceptedIntake;
}
test('empty profile imports clinical views with literal evidence and survives SQLite loss', (t) => {
  const f = fixture(t);
  const rows = [
    envelope('lab1', lab),
    envelope('rx1', {
      kind: 'medication',
      subject: 'self',
      medicationName: 'Example medicine',
      medicationKind: 'order',
      doseText: '5 mg daily',
      date: '2024',
      status: 'active',
    }),
    envelope('proc1', {
      kind: 'procedure',
      subject: 'self',
      procedureLabel: 'Example imaging',
      procedureCategory: 'imaging',
      date: '2024-07-10',
    }),
    envelope('doc1', {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Office visit',
      date: '2024-07-10',
      text: 'Original office narrative',
    }),
  ];
  const intake = upload(f, rows);
  assert.throws(
    () => importIntake(f.db, f.root, f.id, intake.id, { version: intake.version }),
    (e: unknown) => e instanceof HttpError && e.code === 'REVIEW_REQUIRED',
  );
  const result = accept(f, intake);
  assert.equal(result.imported.clinical.added, 4);
  assert.equal(result.imported.clinical.newMedications, 1);
  const observation = f.db.prepare('SELECT * FROM observations').get() as
    | {
        value_text: string;
        value_numeric: number;
        comparator: string;
        date_precision: string;
        effective_at: string;
        source_record_id: string;
      }
    | undefined;
  assert.ok(observation);
  assert.equal(observation.value_text, '< 12.00');
  assert.equal(observation.value_numeric, 12);
  assert.equal(observation.comparator, '<');
  assert.equal(observation.date_precision, 'month');
  assert.equal(observation.effective_at, '2024-07');
  assert.equal(
    f.db.prepare('SELECT status FROM medication_preferences').get()!.status,
    'not_current',
    'old provider active flag does not replace the Inactive system default',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM evidence').get()!.n, 8);
  const acceptedSource = observation.source_record_id;
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT entity_id,role FROM evidence WHERE source_record_id=? AND entity_type='person'",
      )
      .all(acceptedSource)
      .map((row) => ({ ...row })),
    [{ entity_id: 'patient', role: 'report_subject' }],
  );
  const packet = (database: typeof f.db) => {
    const options = exportOptions(database, { type: 'person', id: 'patient' });
    return exportSnapshot(database, {
      type: 'person',
      id: 'patient',
      noteVersion: options.noteVersion,
      mode: 'provider',
    });
  };
  assert.ok(
    packet(f.db).records.some((record) => record.citations.some((c) => c.id === acceptedSource)),
  );
  assert.deepEqual(
    JSON.parse(
      f.db
        .prepare('SELECT raw_json FROM source_records WHERE id=?')
        .get(observation.source_record_id)!.raw_json as string,
    ),
    rows[0],
  );
  const rebuilt = rebuildProfile(f.root, f.id, resolve(f.root, 'rebuilt'));
  const db = openDatabase(rebuilt.database, f.id);
  assert.equal(db.prepare('SELECT value_text FROM observations').get()!.value_text, '< 12.00');
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
  assert.deepEqual(
    db
      .prepare(
        "SELECT entity_id,role FROM evidence WHERE source_record_id=? AND entity_type='person'",
      )
      .all(acceptedSource)
      .map((row) => ({ ...row })),
    [{ entity_id: 'patient', role: 'report_subject' }],
  );
  assert.ok(
    packet(db).records.some((record) => record.citations.some((c) => c.id === acceptedSource)),
  );
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  db.close();
});
test('retained unassigned clinical history stays out of a packet with a visible notice after rebuild', (t) => {
  const f = fixture(t);
  const item = upload(f, [
    envelope('accepted-self', lab),
    envelope('unassigned-history', {
      ...lab,
      subject: 'unknown',
      testLabel: 'PRIVATE UNASSIGNED HISTORY',
    }),
  ]);
  const review = reviewIntake(f.db, f.root, f.id, item.id);
  assert.equal(review.records.length, 2);
  accept(f, item, (current) =>
    current.records.map((record, index) => ({
      recordId: record.id,
      action: index === 0 ? 'accept' : 'skip',
      mapping: {},
    })),
  );
  const check = (database: typeof f.db) => {
    const source = database
      .prepare("SELECT id FROM source_records WHERE raw_json LIKE '%PRIVATE UNASSIGNED HISTORY%'")
      .get();
    assert.ok(source, 'the unmatched original remains retained');
    assert.equal(
      database
        .prepare(
          "SELECT count(*) n FROM evidence WHERE source_record_id=? AND role='report_subject'",
        )
        .get(source.id)!.n,
      0,
    );
    const options = exportOptions(database, { type: 'person', id: 'patient' });
    const snapshot = exportSnapshot(database, {
      type: 'person',
      id: 'patient',
      noteVersion: options.noteVersion,
      mode: 'provider',
    });
    assert.equal(snapshot.unassignedRawAssertionsOmitted, true);
    assert.ok(!snapshot.records.some((record) => record.id === source.id));
    assert.match(
      exportHtml(snapshot),
      /Some retained clinical assertions have no verified single-person assignment/,
    );
    assert.doesNotMatch(exportHtml(snapshot), /PRIVATE UNASSIGNED HISTORY/);
    const companion = JSON.stringify(exportEvidence(snapshot));
    assert.match(
      companion,
      /Some retained clinical assertions have no verified single-person assignment/,
    );
    assert.doesNotMatch(companion, /PRIVATE UNASSIGNED HISTORY/);
  };
  check(f.db);
  const rebuilt = rebuildProfile(f.root, f.id, resolve(f.root, 'unassigned-rebuild'));
  const db = openDatabase(rebuilt.database, f.id);
  try {
    check(db);
  } finally {
    db.close();
  }
});
test('accepted grouped observation values keep their literal fields and rebuild the numeric query projection', (t) => {
  const f = fixture(t);
  const cases = [
    {
      id: 'grouped-positive',
      label: 'Fictional grouped positive',
      valueText: '< +1,234.500 fictional-unit/mL',
    },
    {
      id: 'grouped-negative',
      label: 'Fictional grouped negative',
      valueText: '-9,876.250 fictional-unit/mL',
    },
    { id: 'ambiguous-comma', label: 'Fictional ambiguous comma', valueText: '1,23' },
    { id: 'existing-scientific', label: 'Fictional existing scientific', valueText: '> 4.20e2' },
  ];
  const accepted = accept(
    f,
    upload(
      f,
      cases.map(({ id, label, valueText }) =>
        envelope(id, {
          ...lab,
          testLabel: label,
          valueText,
          unit: 'fictional-unit/mL',
          date: '2026-09-14',
        }),
      ),
      'fictional-grouped-values.jsonl',
    ),
  );
  const records = accepted.imported.clinical.records;
  assert.ok(records, 'Acceptance must return the actual clinical destinations');
  const entity = (label: string) => {
    const destination = records.find((record) => record.title === label);
    assert.ok(destination, 'Every selected fictional observation needs a saved destination');
    return destination;
  };
  const expected = [
    ['Fictional grouped positive', '< +1,234.500 fictional-unit/mL', 1234.5, '<'],
    ['Fictional grouped negative', '-9,876.250 fictional-unit/mL', -9876.25, null],
    ['Fictional ambiguous comma', '1,23', null, null],
    ['Fictional existing scientific', '> 4.20e2', 420, '>'],
  ] as const;
  const before = expected.map(([label, valueText, value, comparator]) => {
    const dto = getObservation(f.db, entity(label).entityId);
    assert.ok('valueText' in dto, 'Saved destination must resolve to an observation DTO');
    assert.equal(dto.valueText, valueText);
    assert.equal(dto.value, value);
    assert.equal(dto.comparator, comparator);
    assert.equal(dto.unit, 'fictional-unit/mL');
    assert.equal(dto.date, '2026-09-14');
    assert.equal(dto.datePrecision, 'day');
    return dto;
  });
  const rebuilt = rebuildProfile(f.root, f.id, resolve(f.root, 'grouped-rebuilt'));
  const db = openDatabase(rebuilt.database, f.id);
  try {
    assert.deepEqual(
      expected.map(([label]) => getObservation(db, entity(label).entityId)),
      before,
    );
  } finally {
    db.close();
  }
});
test('identical unscoped copies add attribution but changed unscoped deliveries refuse reuse', (t) => {
  const f = fixture(t);
  const first = accept(f, upload(f, [envelope('same', lab)]));
  const savedReview = reviewIntake(f.db, f.root, f.id, first.id);
  assert.equal(savedReview.records[0].classification, 'duplicate');
  assert.equal(savedReview.records[0].duplicateOf?.sameSourceRecord, true);
  assert.equal(savedReview.records[0].duplicateOf?.persistedMatch, true);
  const replayBody: Parameters<typeof importIntake>[4] = {
    version: savedReview.version,
    reviewToken: savedReview.reviewToken,
    decisions: [{ recordId: savedReview.records[0].id, action: 'accept', mapping: {} }],
  };
  const replay = importIntake(f.db, f.root, f.id, first.id, replayBody);
  assert.equal(importIntake(f.db, f.root, f.id, first.id, replayBody).version, replay.version);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 1);
  const repeatedIntake = upload(
    f,
    [envelope('same', lab)],
    'renamed.jsonl',
    'Other acquiring office',
  );
  const repeatedReview = reviewIntake(f.db, f.root, f.id, repeatedIntake.id);
  assert.equal(repeatedReview.records[0].classification, 'duplicate');
  assert.equal(repeatedReview.records[0].duplicateOf?.sameSourceRecord, false);
  assert.equal(repeatedReview.records[0].duplicateOf?.persistedMatch, true);
  const repeated = accept(f, repeatedIntake);
  assert.equal(repeated.imported.clinical.duplicates, 1);
  assert.equal(repeated.imported.clinical.newMedications, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM evidence').get()!.n, 4);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 2);
  const before = f.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const changed = upload(f, [envelope('same', { ...lab, valueText: '14.2' })], 'changed.jsonl');
  const changedReview = reviewIntake(f.db, f.root, f.id, changed.id);
  assert.equal(changedReview.records[0]!.classification, 'unsupported');
  assert.throws(
    () =>
      accept(f, changed, (review) =>
        review.records.map((record) => ({ recordId: record.id, action: 'accept', mapping: {} })),
      ),
    { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM evidence').get()!.n, 4);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 2);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM record_relationships WHERE relation='source_version'")
      .get()!.n,
    0,
  );
});
test('partial and unknown envelope coverage stay visible as transcription limits', (t) => {
  const f = fixture(t);
  const partial = envelope('partial', lab);
  partial.coverage.status = 'partial';
  const unknown = envelope('unknown-coverage', { ...lab, valueText: '17' });
  unknown.coverage.status = 'unknown';
  const review = reviewIntake(f.db, f.root, f.id, upload(f, [partial, unknown]).id);
  assert.match(review.records[0].uncertainties.join(' '), /Model transcription covers only part/);
  assert.match(review.records[0].uncertainties.join(' '), /Whole-file reading progress/);
  assert.match(review.records[1].uncertainties.join(' '), /transcription coverage is unknown/);
  assert.ok(
    review.records.every((record) =>
      record.uncertainties.some((item) => item.includes('retained original remains available')),
    ),
  );
});
test('same-proposal duplicate rows stay classified without claiming a saved comparison', (t) => {
  const f = fixture(t);
  const review = reviewIntake(
    f.db,
    f.root,
    f.id,
    upload(f, [envelope('same-row', lab), envelope('same-row', lab)]).id,
  );
  assert.equal(review.records[1].classification, 'duplicate');
  assert.equal(review.records[1].duplicateOf?.persistedMatch, false);
});
test('uncertain subjects and unsupported content remain raw; safe mappings persist and reapply', (t) => {
  const f = fixture(t);
  const intake = upload(f, [
    envelope('one', lab),
    envelope('relative', { ...lab, subject: 'other' }),
    { ...envelope('unknown', {}), clinical: undefined },
  ]);
  const reviewed = reviewIntake(f.db, f.root, f.id, intake.id);
  assert.equal(reviewed.summary.unsupported, 2);
  accept(f, intake, (r) => [
    {
      recordId: r.records[0].id,
      action: 'accept',
      mapping: { testLabel: 'Reviewed example' },
      rememberRule: {
        match: { kind: 'observation', label: 'Example test' },
        set: { testLabel: 'Reviewed example' },
      },
    },
  ]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 3);
  const next = upload(f, [envelope('two', { ...lab, valueText: '17.0' })], 'next.jsonl');
  assert.equal(
    reviewIntake(f.db, f.root, f.id, next.id).records[0].mapping.testLabel,
    'Reviewed example',
  );
  accept(f, next);
  assert.equal(f.db.prepare('SELECT count(*) n FROM test_types').get()!.n, 1);
  const other = upload(f, [envelope('three', lab)], 'third.jsonl', 'Different office');
  assert.equal(
    reviewIntake(f.db, f.root, f.id, other.id).records[0].mapping.testLabel,
    'Example test',
  );
});
test('stale review and invalid edits cannot partly import; rules cannot reuse patient values', (t) => {
  const f = fixture(t);
  const intake = upload(f, [envelope('one', lab)]);
  const review = reviewIntake(f.db, f.root, f.id, intake.id);
  upload(f, [envelope('other', lab)], 'other.jsonl');
  assert.throws(
    () =>
      importIntake(f.db, f.root, f.id, intake.id, {
        version: intake.version,
        reviewToken: review.reviewToken,
      }),
    (e: unknown) => e instanceof HttpError && e.code === 'REVIEW_CHANGED',
  );
  assert.throws(
    () =>
      accept(f, intake, (r) => [
        {
          recordId: r.records[0].id,
          action: 'accept',
          mapping: { date: '2024-02-31' },
        },
      ]),
    (e: unknown) => e instanceof HttpError && e.code === 'IMPORT_MAPPING',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.throws(
    () =>
      accept(f, intake, (r) => [
        {
          recordId: r.records[0].id,
          action: 'accept',
          rememberRule: {
            match: { kind: 'observation', label: 'Example test' },
            set: { valueText: '999' },
          },
        },
      ]),
    (e: unknown) => e instanceof HttpError && e.code === 'MAPPING_RULE',
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 0);
});
test('accepting the complete review form preserves immutable metadata and recorded medication dates', (t) => {
  const f = fixture(t);
  const intake = upload(f, [
    envelope('rx', {
      kind: 'medication',
      subject: 'self',
      medicationName: 'Example medicine',
      date: '2021-03-08',
      doseText: '200 mg',
      assets: [],
      uncertainties: [],
    }),
  ]);
  const result = accept(f, intake, (r) =>
    r.records.map((record) => ({
      recordId: record.id,
      action: 'accept',
      mapping: record.mapping,
    })),
  );
  assert.equal(result.imported.clinical.added, 1);
  const row = f.db.prepare('SELECT * FROM medications').get() as
    { start_at: string | null; extra_json: string } | undefined;
  assert.ok(row);
  assert.equal(row.start_at, null);
  assert.equal(JSON.parse(row.extra_json).sourceFields.recordedDate, '2021-03-08');
  const second = upload(f, [envelope('next', lab)], 'next.jsonl');
  assert.throws(
    () =>
      accept(f, second, (r) =>
        r.records.map((record) => ({
          recordId: record.id,
          action: 'accept',
          mapping: { ...record.mapping, sourceRecordId: 'forged' },
        })),
      ),
    (e: unknown) => e instanceof HttpError && e.code === 'IMPORT_MAPPING',
  );
});
test('later review passes recover skipped content without reuploading or duplicating retained source rows', (t) => {
  const f = fixture(t);
  let intake = upload(f, [envelope('one', lab), envelope('two', { ...lab, valueText: '17.0' })]);
  accept(f, intake, (r) =>
    r.records.map((record, i) => ({
      recordId: record.id,
      action: i ? 'skip' : 'accept',
    })),
  );
  intake = { ...intake, version: intake.version + 1 };
  const review = reviewIntake(f.db, f.root, f.id, intake.id);
  assert.equal(review.summary.duplicates, 1);
  assert.equal(review.summary.additions, 1);
  const body: Parameters<typeof importIntake>[4] = {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: review.records.map((r) => ({
      recordId: r.id,
      action: 'accept' as const,
      mapping: r.mapping,
    })),
  };
  const result = importIntake(f.db, f.root, f.id, intake.id, body);
  assert.ok(result.importHistory);
  assert.equal(result.importHistory.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_records').get()!.n, 2);
  assert.equal(importIntake(f.db, f.root, f.id, intake.id, body).version, result.version);
});
test('missing document identity warns while conflicting unscoped assertions refuse acceptance', (t) => {
  const f = fixture(t);
  const untyped = {
    ...envelope('doc', { kind: 'document' }),
    clinical: undefined,
  };
  const intake = upload(f, [
    untyped,
    envelope('same', lab),
    envelope('same', { ...lab, valueText: '99' }),
  ]);
  const review = reviewIntake(f.db, f.root, f.id, intake.id);
  assert.equal(review.records[0].classification, 'addition');
  assert.equal(review.records[0].identityReview?.status, 'missing_warning');
  assert.equal(review.records[1]!.classification, 'unsupported');
  assert.equal(review.records[2]!.classification, 'unsupported');
  assert.throws(
    () =>
      accept(f, intake, (current) =>
        current.records.map((record) => ({ recordId: record.id, action: 'accept', mapping: {} })),
      ),
    { code: 'CLINICAL_SOURCE_SCOPE_COLLISION' },
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  accept(f, intake);
  assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
});
