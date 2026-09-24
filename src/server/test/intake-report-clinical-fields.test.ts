import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { HealthRecordEnvelope, IntakeClinicalMapping } from '../../shared/intake.ts';
import { openDatabase } from '../database.ts';
import { acceptIntakeReportSelection } from '../intake-report-acceptance.ts';
import { reviewIntake, uploadIntake } from '../intake.ts';
import { rebuildProfile } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { observations } from '../queries.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-report-field-holdout-'));
  const profileId = 'fictional-orchard-field-holdout';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db };
}

type FictionalEnvelope = HealthRecordEnvelope & { clinical: IntakeClinicalMapping };

function row(id: string, clinical: IntakeClinicalMapping): FictionalEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: {
      literal: `${clinical.testLabel} | ${clinical.valueText} | ${clinical.unit ?? ''}`,
      // Deliberately contradictory payload keys are retained evidence, not mappings.
      date: '2099-12-31',
      method: 'Unrelated fictional payload method',
      observationCategory: 'unrelated_payload_category',
    },
    clinical,
    provenance: {
      capturedVia: 'Independently fictional report export',
      sourceSystem: 'Fictional Orchard Counter',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: `fictional table row ${id}`,
    },
    coverage: { status: 'complete_response', notes: [] },
  };
}

function acceptRows(f: ReturnType<typeof fixture>, rows: HealthRecordEnvelope[]) {
  const item = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-orchard-fields.jsonl',
    bytes: Buffer.from(rows.map((entry) => JSON.stringify(entry)).join('\n')),
  });
  const review = reviewIntake(f.db, f.root, f.profileId, item.id);
  const result = acceptIntakeReportSelection(f.db, f.root, f.profileId, {
    operationId: randomUUID(),
    blocks: [
      {
        intakeId: item.id,
        proposalId: null,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: review.records.map((entry) => ({
          recordId: entry.id,
          candidateId: entry.candidateId!,
          candidateVersionId: entry.candidateVersionId!,
          mapping: {},
        })),
      },
    ],
  });
  assert.equal(result.receipt.acceptedCount, rows.length);
  return review;
}

function savedFields(db: ReturnType<typeof openDatabase>) {
  return observations(db, new URLSearchParams({ limit: '200', visibility: 'all' }), true)
    .data.map((record) => {
      const type = db
        .prepare('SELECT category,extra_json FROM test_types WHERE id=?')
        .get(record.testTypeId)!;
      const source = db
        .prepare('SELECT raw_json,locator_json FROM source_records WHERE id=?')
        .get(record.sourceRecordId)!;
      const raw = JSON.parse(String(source.raw_json)) as HealthRecordEnvelope;
      const metadata = record.extra as {
        import: { acceptedMapping: IntakeClinicalMapping; originalMapping: IntakeClinicalMapping };
      };
      return {
        sourceId: raw.id,
        record,
        category: type.category,
        method: JSON.parse(String(type.extra_json)).method as string,
        accepted: metadata.import.acceptedMapping,
        original: metadata.import.originalMapping,
        raw,
        locator: JSON.parse(String(source.locator_json)) as { originalSourceFileId: string },
        evidence: db
          .prepare(
            "SELECT source_record_id,locator_json FROM evidence WHERE entity_type='observation' AND entity_id=? ORDER BY id",
          )
          .all(record.id),
      };
    })
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

test('counted report acceptance preserves scoped clinical fields, literal glyphs and method distinctions after rebuild', (t) => {
  const f = fixture(t);
  const rows = [
    row('fictional-current', {
      kind: 'observation',
      subject: 'self',
      eventKind: 'performed',
      testLabel: 'Fictional Orchard marker',
      date: '2031-06',
      valueText: '> +002.40 µg/m²',
      unit: 'µg/m²',
      method: 'Fictional photon counter',
      observationCategory: 'laboratory',
    }),
    row('fictional-historical', {
      kind: 'observation',
      subject: 'self',
      eventKind: 'performed',
      testLabel: 'Fictional Orchard marker',
      date: '2028',
      valueText: '-00.70',
      unit: 'µg/m²',
      method: 'Fictional mechanical counter',
      observationCategory: 'laboratory',
    }),
  ];
  const review = acceptRows(f, rows);
  for (const source of rows) {
    const candidate = review.records.find((entry) => entry.mapping.date === source.clinical!.date)!;
    assert.ok(candidate);
    assert.ok('undraftedMapping' in candidate);
    const undrafted = candidate.undraftedMapping;
    assert.ok(undrafted && typeof undrafted === 'object');
    for (const key of ['date', 'method', 'observationCategory', 'valueText', 'unit'] as const) {
      assert.equal(candidate.mapping[key], source.clinical![key]);
      assert.equal(Reflect.get(undrafted, key), source.clinical![key]);
    }
  }
  const saved = savedFields(f.db);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].record.testTypeId, saved[1].record.testTypeId);
  for (const entry of saved) {
    const source = rows.find((candidate) => candidate.id === entry.sourceId)!;
    const clinical = source.clinical!;
    assert.equal(entry.record.date, clinical.date);
    assert.equal(entry.record.valueText, clinical.valueText);
    assert.equal(entry.record.unit, clinical.unit);
    assert.equal(entry.method, clinical.method);
    assert.equal(entry.category, clinical.observationCategory);
    assert.equal(entry.record.datePrecision, clinical.date!.length === 4 ? 'year' : 'month');
    for (const key of ['date', 'method', 'observationCategory', 'valueText', 'unit'] as const) {
      assert.equal(entry.accepted[key], clinical[key]);
      assert.equal(entry.original[key], clinical[key]);
    }
    assert.deepEqual(entry.raw, source);
    assert.equal(entry.evidence.length, 1);
    assert.equal(entry.evidence[0].source_record_id, entry.record.sourceRecordId);
    assert.deepEqual(JSON.parse(String(entry.evidence[0].locator_json)), {
      locator: source.provenance.locator,
      originalSourceFileId: entry.locator.originalSourceFileId,
      reviewed: true,
    });
  }
  const rebuilt = rebuildProfile(f.root, f.profileId, join(f.root, 'rebuilt'));
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(savedFields(rebuiltDb), saved);
  } finally {
    rebuiltDb.close();
  }
});

test('missing clinical fields remain unknown instead of borrowing unrelated payload fields during report acceptance or rebuild', (t) => {
  const f = fixture(t);
  const source = row('fictional-unknown', {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Fictional undated marker',
    valueText: '07.00',
    unit: '',
  });
  const review = acceptRows(f, [source]);
  for (const key of ['date', 'method', 'observationCategory'] as const) {
    assert.equal(review.records[0].mapping[key], '');
  }
  const saved = savedFields(f.db);
  assert.equal(saved[0].record.date, null);
  assert.equal(saved[0].method, '');
  assert.equal(saved[0].category, 'Unspecified');
  for (const key of ['date', 'method', 'observationCategory'] as const) {
    assert.equal(saved[0].accepted[key], '');
  }
  assert.deepEqual(saved[0].raw, source);
  const rebuilt = rebuildProfile(f.root, f.profileId, join(f.root, 'rebuilt'));
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(savedFields(rebuiltDb), saved);
  } finally {
    rebuiltDb.close();
  }
});
