import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import { CLINICAL_INSTRUCTIONS } from '../clinical-instructions.ts';
import { mappingFrom } from '../clinical-import.ts';
import { INTAKE_SCHEMA_INSTRUCTIONS, validateJSONL } from '../intake-format.ts';

const hostInstructions = readFileSync(
  new URL('../assistant-instructions.md', import.meta.url),
  'utf8',
);
const schema = JSON.parse(
  readFileSync(
    new URL('../../shared/schemas/health-record-v1.schema.json', import.meta.url),
    'utf8',
  ),
) as {
  properties: {
    clinical: { description: string };
    contextId: { description: string };
  };
};

test('the fictional clinical example puts role and classification in clinical', () => {
  const match = /Example \(fictional\): clinical=(\{[^}]+\})\./.exec(CLINICAL_INSTRUCTIONS);
  assert.ok(match);
  const clinical = JSON.parse(match[1]) as Record<string, unknown>;
  assert.deepEqual(clinical, {
    kind: 'observation',
    subject: 'unknown',
    eventKind: 'performed',
    status: 'FINAL',
    observationCategory: 'laboratory',
    testLabel: 'Fictional result',
    valueText: '+1.20',
    unit: 'fictional units',
  });
  assert.equal(INTAKE_SCHEMA_INSTRUCTIONS.includes(CLINICAL_INSTRUCTIONS), true);
});

test('host and public schema guidance keep mappings separate from literal payload', () => {
  for (const text of [CLINICAL_INSTRUCTIONS, hostInstructions]) {
    assert.match(text, /payload\.eventKind/);
    assert.match(text, /clinical\.eventKind/);
    assert.match(text, /clinical\.observationCategory/);
    assert.match(text, /clinical\.documentCategory/);
    assert.match(text, /clinical\.visitSpecialty/);
    assert.match(text, /clinical\.eventKind:\s*"unknown"/);
    assert.match(text, /omit unsupported|Omit classification fields/);
  }
  assert.doesNotMatch(hostInstructions, /For a result, use eventKind:performed/);
  assert.match(schema.properties.clinical.description, /inside clinical/);
  assert.match(
    schema.properties.clinical.description,
    /payload fields remain untouched literal evidence/,
  );
});

test('production guidance keeps an unresolved fictional visual mark out of exact literal fields', () => {
  for (const text of [hostInstructions, INTAKE_SCHEMA_INSTRUCTIONS]) {
    assert.match(text, /clipped, unreadable, or otherwise unresolved source region/i);
    assert.match(text, /do not encode one tentative guess as an exact literal\s+payload field/i);
    assert.match(text, /retain the original and exact locator/i);
    assert.match(text, /coverage partial or unknown/i);
    assert.match(text, /alternatives may remain only when explicitly qualified as uncertain/i);
    assert.match(text, /never copy\s+them into clinical mappings/i);
    assert.match(text, /identity or Self suggestions/i);
    assert.match(text, /report or subject\s+anchors/i);
    assert.match(text, /People evidence/i);
    assert.match(text, /provenance, source suggestions, or metadata suggestions/i);
  }

  const payload = {
    text: 'A fictional decorative mark is present at the lower edge.',
    transcriptionNotes: [
      'The decorative mark is clipped and remains unreadable in the retained original.',
    ],
  };
  const validation = validateJSONL(
    Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-clipped-decoration-context',
        kind: 'context',
        payload,
        provenance: {
          capturedVia: 'Fictional image transcription',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'fictional image lower margin',
        },
        coverage: {
          status: 'partial',
          notes: ['The clipped decoration remains unresolved in the exact original.'],
        },
      }),
    ),
  );
  assert.equal(validation.valid, true);
  if (!validation.valid) assert.fail('The independently fictional context envelope must validate');
  assert.deepEqual(validation.entries[0]!.value.payload, payload);
  assert.equal('clinical' in validation.entries[0]!.value, false);
  assert.equal('people' in validation.entries[0]!.value, false);
  assert.equal(validation.entries[0]!.value.coverage.status, 'partial');
});

test('shared context guidance distinguishes report-wide facts from row and column scope', () => {
  for (const text of [CLINICAL_INSTRUCTIONS, hostInstructions, INTAKE_SCHEMA_INSTRUCTIONS]) {
    assert.match(text, /report, section or table-column/i);
    assert.match(text, /clinical\.date/);
    assert.match(text, /clinical\.method/);
    assert.match(text, /clinical\.unit/);
    assert.match(text, /clinical\.observationCategory/);
    assert.match(text, /report-wide method, modality, unit or (?:classification|category)/i);
    assert.match(text, /may apply across|can apply across/i);
    assert.match(text, /current and historical columns keep their own dates/i);
    assert.match(text, /spelling and glyphs/i);
    assert.match(text, /historical\s+measurement-date column alone/i);
    assert.match(text, /undated mention remains valid/i);
    assert.match(text, /historical mention\s+is never a performed event/i);
  }
  assert.match(schema.properties.contextId.description, /report-wide method or category can span/);
  assert.match(schema.properties.contextId.description, /specific fact cannot/);
  assert.match(schema.properties.clinical.description, /same original, member, report/);
  assert.match(schema.properties.clinical.description, /specific facts do not cross/);
});

test('host mapping preserves fictional date, method, category and printed value-unit glyphs', () => {
  const value: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'fictional-moonrise-column-result',
    kind: 'record',
    contextId: 'fictional-moonrise-context',
    payload: {
      printedResult: 'Fictional marker | <+01.20 µg/cm²',
      column: 'Current measurement',
    },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      date: '2027-04',
      testLabel: 'Fictional Moonrise marker',
      valueText: '<+01.20 µg/cm²',
      unit: 'µg/cm²',
      method: 'Fictional dual-photon method',
      observationCategory: 'fictional_body_composition',
      uncertainties: [],
    },
    provenance: {
      capturedVia: 'Independently fictional contract test',
      sourceSystem: 'Fictional Moonrise Imaging',
      sourceRecordId: 'moonrise-current-marker',
      evidenceClass: 'provider_export',
      locator: 'fictional report page 2 current column row 3',
    },
    coverage: { status: 'complete_response', notes: [] },
  };

  const mapping = mappingFrom({ value });
  assert.deepEqual(
    {
      date: mapping.date,
      method: mapping.method,
      observationCategory: mapping.observationCategory,
      valueText: mapping.valueText,
      unit: mapping.unit,
    },
    {
      date: '2027-04',
      method: 'Fictional dual-photon method',
      observationCategory: 'fictional_body_composition',
      valueText: '<+01.20 µg/cm²',
      unit: 'µg/cm²',
    },
  );
});

test('host preserves a fictional report-wide method without crossing column dates', () => {
  const observation = (id: string, column: string, date: string | null): HealthRecordEnvelope => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    contextId: 'fictional-starlight-report-context',
    payload: { column, reportMethod: 'Fictional prism scan' },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      date,
      testLabel: `Fictional ${column} marker`,
      valueText: '7.0',
      unit: 'qu',
      method: 'Fictional prism scan',
      uncertainties: [],
    },
    provenance: {
      capturedVia: 'Independently fictional contract test',
      sourceSystem: 'Fictional Starlight Imaging',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: `fictional ${column} column`,
    },
    coverage: { status: 'complete_response', notes: [] },
  });

  const current = mappingFrom({
    value: observation('fictional-starlight-current', 'current', '2028-03'),
  });
  const history = mappingFrom({
    value: observation('fictional-starlight-history', 'history', '2026'),
  });
  const unknownDate = mappingFrom({
    value: observation('fictional-starlight-unknown', 'undated', null),
  });

  assert.deepEqual(
    [current.method, history.method, unknownDate.method],
    ['Fictional prism scan', 'Fictional prism scan', 'Fictional prism scan'],
  );
  assert.deepEqual([current.date, history.date, unknownDate.date], ['2028-03', '2026', '']);
});

test('host preserves an explicit undated historical mention without inventing one from a date column', () => {
  const historicalMention: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'fictional-undated-prior-scan',
    kind: 'record',
    payload: { text: 'Prior fictional prism scan is explicitly mentioned.' },
    clinical: {
      kind: 'procedure',
      subject: 'unknown',
      eventKind: 'historical_mention',
      date: null,
      procedureLabel: 'Fictional prior prism scan',
      procedureCategory: 'imaging',
      uncertainties: ['The source does not state the earlier scan date.'],
    },
    provenance: {
      capturedVia: 'Independently fictional contract test',
      sourceSystem: 'Fictional Starlight Imaging',
      sourceRecordId: 'fictional-undated-prior-scan',
      evidenceClass: 'provider_export',
      locator: 'fictional report history sentence',
    },
    coverage: { status: 'complete_response', notes: [] },
  };
  const datedObservation: HealthRecordEnvelope = {
    format: 'health-record-v1',
    id: 'fictional-history-column-only',
    kind: 'record',
    payload: { column: 'Historical measurement 2024' },
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      date: '2024',
      testLabel: 'Fictional historical marker',
      valueText: '3.0',
      uncertainties: [],
    },
    provenance: {
      capturedVia: 'Independently fictional contract test',
      sourceSystem: 'Fictional Starlight Imaging',
      sourceRecordId: 'fictional-history-column-only',
      evidenceClass: 'provider_export',
      locator: 'fictional historical column',
    },
    coverage: { status: 'complete_response', notes: [] },
  };

  const mention = mappingFrom({ value: historicalMention });
  const measurement = mappingFrom({ value: datedObservation });
  assert.deepEqual(
    [mention.kind, mention.eventKind, mention.date],
    ['procedure', 'historical_mention', ''],
  );
  assert.deepEqual(
    [measurement.kind, measurement.eventKind, measurement.date],
    ['observation', 'performed', '2024'],
  );
});

test('clarification remains proposal-only and does not authorize acceptance', () => {
  assert.match(CLINICAL_INSTRUCTIONS, /proposal submission never autoaccepts records/);
  assert.match(hostInstructions, /A proposal never autoaccepts a record/);
  assert.doesNotMatch(hostInstructions, /default .*performed/i);
});
