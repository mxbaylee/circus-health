import type { Database } from './database.ts';
import type { SQLInputValue } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash } from './assets.ts';
import { revision, transaction } from './database.ts';
import { durableWrite } from './portable.ts';
import { profilePaths } from './profile-storage.ts';

export const SYNTHETIC_PLACEBO_SEED = 'circus-health-synthetic-v1';
const stamp = '2026-06-15T12:00:00.000Z';
const json = (value: unknown) => JSON.stringify(value);
function insert(db: Database, table: string, row: Record<string, SQLInputValue | undefined>) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).run(...columns.map((column) => row[column] ?? null));
}
function randomFor(seed: string) {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.codePointAt(0)!;
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const rounded = (value: number, places = 1) => Number(value.toFixed(places));
const sourceRecordId = (id: string) => `synthetic-source:${id}`;
const evidenceId = (type: string, id: string) => `synthetic-evidence:${type}:${id}`;
const counts = (db: Database) =>
  Object.fromEntries(
    [
      'providers',
      'source_files',
      'source_records',
      'test_types',
      'observations',
      'reports',
      'medications',
      'medication_preferences',
      'procedures',
      'documents',
      'people',
      'notes',
      'note_links',
      'evidence',
    ].map((table) => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]),
  );

function fixture(name: string, seed: string) {
  const random = randomFor(seed);
  const labDates = ['2024-02-12', '2025-02-18', '2026-05-30'];
  const series = [
    {
      id: 'ferritin',
      label: 'Ferritin',
      unit: 'ng/mL',
      category: 'Laboratory',
      values: [24, 31, 42].map((value) => rounded(value + random() * 3)),
    },
    {
      id: 'vitamin-d',
      label: 'Vitamin D',
      unit: 'ng/mL',
      category: 'Laboratory',
      values: [28, 34, 39].map((value) => rounded(value + random() * 2)),
    },
    {
      id: 'a1c',
      label: 'Hemoglobin A1c',
      unit: '%',
      category: 'Laboratory',
      values: [5.3, 5.4, 5.2].map((value) => rounded(value + random() * 0.1)),
    },
    {
      id: 'ldl',
      label: 'LDL cholesterol',
      unit: 'mg/dL',
      category: 'Laboratory',
      values: [112, 104, 96].map((value) => Math.round(value + random() * 4)),
    },
  ];
  const records: Array<
    {
      id: string;
      label: string;
      date: string;
      providerId: string;
      patient: string;
      fictional: true;
    } & (
      | { kind: 'report' }
      | { kind: 'observation'; value: number; unit: string; reportId: string }
      | { kind: 'medication'; dose: string; route: string; frequency: string; status: string }
      | { kind: 'procedure'; category: string }
      | { kind: 'document'; clinician: string; text: string }
      | { kind: 'history'; relative: string; relationship: string; detail: string }
    )
  > = [];
  for (const date of labDates)
    records.push({
      id: `report-${date}`,
      kind: 'report',
      label: `Wellness laboratory report ${date}`,
      date,
      providerId: 'synthetic-harbor-clinic',
      patient: name,
      fictional: true,
    });
  for (const test of series)
    for (const [index, date] of labDates.entries())
      records.push({
        id: `${test.id}-${date}`,
        kind: 'observation',
        label: test.label,
        date,
        value: test.values[index],
        unit: test.unit,
        reportId: `report-${date}`,
        providerId: 'synthetic-harbor-clinic',
        patient: name,
        fictional: true,
      });
  records.push(
    {
      id: 'med-levothyroxine',
      kind: 'medication',
      label: 'Levothyroxine 25 mcg tablet',
      date: '2025-11-03',
      dose: '25 mcg',
      route: 'oral',
      frequency: 'each morning',
      status: 'active',
      providerId: 'synthetic-harbor-clinic',
      patient: name,
      fictional: true,
    },
    {
      id: 'med-naproxen',
      kind: 'medication',
      label: 'Naproxen 500 mg tablet',
      date: '2024-07-09',
      dose: '500 mg',
      route: 'oral',
      frequency: 'twice daily as needed',
      status: 'completed',
      providerId: 'synthetic-ridge-orthopedics',
      patient: name,
      fictional: true,
    },
    {
      id: 'med-cetirizine',
      kind: 'medication',
      label: 'Cetirizine 10 mg tablet',
      date: '2026-04-02',
      dose: '10 mg',
      route: 'oral',
      frequency: 'daily as needed',
      status: 'active',
      providerId: 'synthetic-harbor-clinic',
      patient: name,
      fictional: true,
    },
    {
      id: 'procedure-ankle-repair',
      kind: 'procedure',
      label: 'Left ankle ligament repair',
      date: '2022-09-21',
      category: 'surgery',
      providerId: 'synthetic-ridge-orthopedics',
      patient: name,
      fictional: true,
    },
    {
      id: 'procedure-knee-mri',
      kind: 'procedure',
      label: 'Right knee MRI',
      date: '2025-08-14',
      category: 'imaging',
      providerId: 'synthetic-ridge-orthopedics',
      patient: name,
      fictional: true,
    },
    {
      id: 'document-wellness-plan',
      kind: 'document',
      label: 'Wellness visit plan',
      date: '2026-05-30',
      clinician: 'Dr. Rowan Rivera',
      text: 'Continue regular movement, repeat wellness laboratory testing in one year, and review current medicines at each visit.',
      providerId: 'synthetic-harbor-clinic',
      patient: name,
      fictional: true,
    },
    {
      id: 'family-history',
      kind: 'history',
      label: 'Fictional family history',
      date: '2025-05-08',
      relative: 'Juniper Example',
      relationship: 'Sibling',
      detail: 'Reports a fictional family pattern of high cholesterol.',
      providerId: 'synthetic-harbor-clinic',
      patient: name,
      fictional: true,
    },
  );
  return {
    format: 'circus-health-synthetic-placebo-v1',
    fictional: true,
    seed,
    patient: name,
    generatedAt: stamp,
    providers: [
      { id: 'synthetic-harbor-clinic', name: 'Harbor Family Clinic (Fictional)' },
      { id: 'synthetic-ridge-orthopedics', name: 'Ridge Orthopedics (Fictional)' },
    ],
    labDates,
    series,
    records,
  };
}

/** Seed a new, empty profile with invented records. This function never reads another profile or repository fixture. */
export function seedSyntheticPlacebo(
  db: Database,
  {
    root,
    profileId,
    name,
    seed = SYNTHETIC_PLACEBO_SEED,
  }: { root: string; profileId: string; name: string; seed?: string },
) {
  if (typeof name !== 'string' || !name.trim())
    throw new Error('Synthetic placebo name is required');
  if (typeof seed !== 'string' || !seed) throw new Error('Synthetic placebo seed is required');
  const owner = db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value;
  if (owner !== profileId)
    throw new Error('Synthetic placebo database belongs to a different profile');
  if (db.prepare("SELECT 1 FROM manual_batches WHERE id='synthetic-placebo-v1'").get())
    throw new Error('Synthetic placebo is already seeded');
  const data = fixture(name.trim(), seed);
  const lines = data.records.map((record) => json(record));
  const bytes = Buffer.from(lines.join('\n') + '\n');
  const relativePath = `${profilePaths(root, profileId).relativeRoot}/sources/synthetic-placebo/fictional-records.jsonl`;
  const absolutePath = resolve(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  durableWrite(absolutePath, bytes);
  try {
    transaction(db, () => {
      insert(db, 'manual_batches', {
        id: 'synthetic-placebo-v1',
        title: 'Generated Placebo account',
        status: 'verified',
        created_at: stamp,
        verified_at: stamp,
        notes: 'All people, providers, dates, values and source text in this batch are invented.',
        coverage_json: json({ fictional: true, generator: data.format, seed }),
      });
      for (const provider of data.providers) insert(db, 'providers', provider);
      insert(db, 'source_files', {
        id: 'synthetic-placebo-source',
        provider_id: null,
        path: relativePath,
        sha256: hash(bytes),
        bytes: bytes.length,
        mime_type: 'application/x-ndjson',
        kind: 'fictional-placebo',
        coverage_status: 'mapped',
        batch_id: 'synthetic-placebo-v1',
        details_json: json({
          fictional: true,
          seed,
          notice: 'Generated locally from an inline synthetic fixture.',
        }),
      });
      for (const [index, record] of data.records.entries())
        insert(db, 'source_records', {
          id: sourceRecordId(record.id),
          source_file_id: 'synthetic-placebo-source',
          provider_id: record.providerId,
          source_key: record.id,
          kind: record.kind,
          label: record.label,
          date_text: record.date,
          raw_json: lines[index],
          locator_json: json({ line: index + 1, jsonPointer: `/${index}` }),
          extraction_status: 'mapped',
          batch_id: 'synthetic-placebo-v1',
        });
      for (const test of data.series)
        insert(db, 'test_types', {
          id: `synthetic-test:${test.id}`,
          label: test.label,
          category: test.category,
          unit: test.unit,
          aliases_json: '[]',
          codes_json: '[]',
          context: 'Invented measurements for product exploration.',
          extra_json: json({ fictional: true, seed }),
        });
      for (const date of data.labDates) {
        const id = `synthetic-report:${date}`;
        insert(db, 'reports', {
          id,
          source_record_id: sourceRecordId(`report-${date}`),
          provider_id: 'synthetic-harbor-clinic',
          title: `Wellness laboratory report · ${date}`,
          effective_at: date,
          status: 'final',
          extra_json: json({ fictional: true }),
        });
        insert(db, 'evidence', {
          id: evidenceId('report', id),
          entity_type: 'report',
          entity_id: id,
          source_record_id: sourceRecordId(`report-${date}`),
          role: 'fictional-original',
          locator_json: json({
            line: data.records.findIndex((record) => record.id === `report-${date}`) + 1,
          }),
        });
      }
      for (const test of data.series)
        for (const [index, date] of data.labDates.entries()) {
          const id = `synthetic-observation:${test.id}:${date}`;
          insert(db, 'observations', {
            id,
            test_type_id: `synthetic-test:${test.id}`,
            provider_id: 'synthetic-harbor-clinic',
            source_record_id: sourceRecordId(`${test.id}-${date}`),
            report_id: `synthetic-report:${date}`,
            label: test.label,
            effective_at: date,
            date_precision: 'day',
            value_text: String(test.values[index]),
            value_numeric: test.values[index],
            unit: test.unit,
            reference_json: json({
              text: test.id === 'a1c' ? '4.0–5.6%' : 'Fictional reference range',
            }),
            status: 'final',
            extra_json: json({ fictional: true }),
          });
          insert(db, 'evidence', {
            id: evidenceId('observation', id),
            entity_type: 'observation',
            entity_id: id,
            source_record_id: sourceRecordId(`${test.id}-${date}`),
            role: 'fictional-original',
            locator_json: json({
              line: data.records.findIndex((record) => record.id === `${test.id}-${date}`) + 1,
            }),
          });
        }
      const medicines = data.records.filter((record) => record.kind === 'medication');
      for (const record of medicines) {
        const id = `synthetic-medication:${record.id.slice(4)}`;
        insert(db, 'medications', {
          id,
          source_record_id: sourceRecordId(record.id),
          provider_id: record.providerId,
          kind: 'order',
          label: record.label,
          status: record.status,
          dose_text: record.dose,
          route: record.route,
          frequency: record.frequency,
          start_at: record.date,
          end_at: record.status === 'completed' ? '2024-07-23' : null,
          extra_json: json({ fictional: true }),
        });
        insert(db, 'evidence', {
          id: evidenceId('medication', id),
          entity_type: 'medication',
          entity_id: id,
          source_record_id: sourceRecordId(record.id),
          role: 'fictional-original',
          locator_json: json({ line: data.records.indexOf(record) + 1 }),
        });
      }
      for (const [medicationId, status, reason] of [
        ['synthetic-medication:levothyroxine', 'current', 'Confirmed for this fictional placebo'],
        ['synthetic-medication:naproxen', 'not_current', 'Short course completed'],
        ['synthetic-medication:cetirizine', 'unknown', 'Order status does not confirm use'],
      ])
        insert(db, 'medication_preferences', {
          medication_id: medicationId,
          status,
          version: 1,
          updated_at: stamp,
          assertion_json: json({ fictional: true, reason }),
        });
      for (const record of data.records.filter((record) => record.kind === 'procedure')) {
        const id = `synthetic-${record.id}`;
        insert(db, 'procedures', {
          id,
          source_record_id: sourceRecordId(record.id),
          provider_id: record.providerId,
          label: record.label,
          effective_at: record.date,
          status: 'completed',
          category: record.category,
          extra_json: json({ fictional: true }),
        });
        insert(db, 'evidence', {
          id: evidenceId('procedure', id),
          entity_type: 'procedure',
          entity_id: id,
          source_record_id: sourceRecordId(record.id),
          role: 'fictional-original',
          locator_json: json({ line: data.records.indexOf(record) + 1 }),
        });
      }
      const documentRecord = data.records.find((record) => record.kind === 'document')!;
      insert(db, 'documents', {
        id: 'synthetic-document:wellness-plan',
        source_record_id: sourceRecordId(documentRecord.id),
        provider_id: documentRecord.providerId,
        title: documentRecord.label,
        effective_at: documentRecord.date,
        text_content: documentRecord.text,
        extra_json: json({ fictional: true }),
      });
      insert(db, 'evidence', {
        id: evidenceId('document', 'synthetic-document:wellness-plan'),
        entity_type: 'document',
        entity_id: 'synthetic-document:wellness-plan',
        source_record_id: sourceRecordId(documentRecord.id),
        role: 'fictional-original',
        locator_json: json({ line: data.records.indexOf(documentRecord) + 1 }),
      });
      insert(db, 'people', {
        id: 'synthetic-person:juniper',
        display_name: 'Juniper Example',
        relationship: 'Sibling',
        is_patient: 0,
      });
      insert(db, 'people', {
        id: 'synthetic-person:dr-rivera',
        display_name: 'Dr. Rowan Rivera',
        relationship: 'Primary care clinician',
        is_patient: 0,
      });
      insert(db, 'evidence', {
        id: evidenceId('person', 'synthetic-person:juniper'),
        entity_type: 'person',
        entity_id: 'synthetic-person:juniper',
        source_record_id: sourceRecordId('family-history'),
        role: 'fictional-original',
        locator_json: json({
          line: data.records.findIndex((record) => record.id === 'family-history') + 1,
        }),
      });
      insert(db, 'evidence', {
        id: evidenceId('person', 'synthetic-person:dr-rivera'),
        entity_type: 'person',
        entity_id: 'synthetic-person:dr-rivera',
        source_record_id: sourceRecordId('document-wellness-plan'),
        role: 'fictional-original',
        locator_json: json({
          line: data.records.findIndex((record) => record.id === 'document-wellness-plan') + 1,
        }),
      });
      insert(db, 'notes', {
        id: 'synthetic-person-note:juniper',
        kind: 'person',
        status: 'editable',
        title: 'Juniper Example',
        content: 'Fictional family contact used only in this placebo.',
        person_id: 'synthetic-person:juniper',
        profile_json: json({
          name: 'Juniper Example',
          fullName: 'Juniper Example',
          relationship: 'Sibling',
          lifeStatus: 'alive',
          tags: ['family', 'emergency contact'],
          phone: '555-0102',
        }),
        created_at: stamp,
        updated_at: stamp,
        version: 1,
      });
      insert(db, 'notes', {
        id: 'synthetic-person-note:dr-rivera',
        kind: 'person',
        status: 'editable',
        title: 'Dr. Rowan Rivera',
        content: 'Fictional clinician at Harbor Family Clinic.',
        person_id: 'synthetic-person:dr-rivera',
        profile_json: json({
          name: 'Dr. Rowan Rivera',
          relationship: 'Primary care clinician',
          lifeStatus: 'alive',
          tags: ['primary care'],
          phone: '555-0138',
        }),
        created_at: stamp,
        updated_at: stamp,
        version: 1,
      });
      insert(db, 'notes', {
        id: 'synthetic-note:questions',
        kind: 'note',
        status: 'editable',
        title: 'Questions for next wellness visit',
        content:
          'Ask whether the ferritin trend needs follow-up.\n\nConfirm the current medication list.',
        topics: 'wellness, laboratory results, medications',
        raw_thoughts: 'This note is editable so placebo changes can be tried safely.',
        pinned: 1,
        created_at: stamp,
        updated_at: stamp,
        version: 1,
        text_formats_json: json({ content: 'markdown-v1' }),
      });
      insert(db, 'notes', {
        id: 'synthetic-note:ankle-recovery',
        kind: 'historical',
        status: 'draft',
        title: 'Ankle surgery recovery',
        content: 'Completed physical therapy after the fictional ligament repair.',
        note_type: 'Recovery note',
        event_date: '2022-12-15',
        topics: 'orthopedics, recovery',
        created_at: stamp,
        updated_at: stamp,
        version: 1,
      });
      insert(db, 'notes', {
        id: 'synthetic-note:family-history',
        kind: 'historical',
        status: 'draft',
        title: 'Family history summary',
        content: 'Juniper reports a fictional family pattern of high cholesterol.',
        note_type: 'Family history',
        event_date: '2025-05-08',
        topics: 'family history',
        source_record_id: sourceRecordId('family-history'),
        created_at: stamp,
        updated_at: stamp,
        version: 1,
      });
      const links = [
        [
          'questions-ferritin',
          'synthetic-note:questions',
          'test_type',
          'synthetic-test:ferritin',
          'discuss',
        ],
        [
          'questions-medication',
          'synthetic-note:questions',
          'medication',
          'synthetic-medication:levothyroxine',
          'review',
        ],
        [
          'questions-clinician',
          'synthetic-note:questions',
          'person',
          'synthetic-person:dr-rivera',
          'discuss-with',
        ],
        [
          'questions-plan',
          'synthetic-note:questions',
          'document',
          'synthetic-document:wellness-plan',
          'related',
        ],
        [
          'ankle-procedure',
          'synthetic-note:ankle-recovery',
          'procedure',
          'synthetic-procedure-ankle-repair',
          'follows',
        ],
        [
          'family-person',
          'synthetic-note:family-history',
          'person',
          'synthetic-person:juniper',
          'reported-by',
        ],
        [
          'family-source',
          'synthetic-note:family-history',
          'source',
          sourceRecordId('family-history'),
          'source',
        ],
      ];
      for (const [id, noteId, targetType, targetId, relation] of links)
        insert(db, 'note_links', {
          id: `synthetic-link:${id}`,
          note_id: noteId,
          target_type: targetType,
          target_id: targetId,
          relation,
        });
      db.prepare(
        "UPDATE notes SET status='finished',finished_at=? WHERE id='synthetic-note:ankle-recovery'",
      ).run(stamp);
      insert(db, 'evidence', {
        id: evidenceId('note', 'synthetic-note:family-history'),
        entity_type: 'note',
        entity_id: 'synthetic-note:family-history',
        source_record_id: sourceRecordId('family-history'),
        role: 'fictional-original',
        locator_json: json({
          line: data.records.findIndex((record) => record.id === 'family-history') + 1,
        }),
      });
      db.prepare("UPDATE manual_batches SET coverage_json=? WHERE id='synthetic-placebo-v1'").run(
        json({
          fictional: true,
          generator: data.format,
          seed,
          records: data.records.length,
          observations: data.series.length * data.labDates.length,
        }),
      );
    });
  } catch (error) {
    rmSync(absolutePath, { force: true });
    throw error;
  }
  return {
    applied: true,
    seed,
    sourceFileId: 'synthetic-placebo-source',
    revision: revision(db),
    counts: counts(db),
  };
}
