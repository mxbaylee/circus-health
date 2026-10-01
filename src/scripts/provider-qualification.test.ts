import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  qualificationAnswers,
  qualificationSourceSystem,
  qualificationPerson,
  qualificationBirthDate,
  answersForQualification,
  exactQualificationPage,
  type QualificationRecord,
  gradeProviderQualification,
  writeProviderQualificationPdf,
} from './provider-qualification-fixture.ts';
import {
  summarizeQualificationDiagnostics,
  qualificationSchedule,
  summarizeQualificationCache,
  verifyQualificationConnection,
} from './qualify-provider-pdf.ts';
import { gradeQualificationDelivery } from './provider-qualification-delivery.ts';
import {
  acceptedQualificationRecord,
  qualificationAcceptanceRequest,
} from './provider-qualification-acceptance.ts';
import type { IntakeImportFeedBlock } from '../shared/intake.ts';
import type { Observation, Medication, Procedure } from '../shared/api.ts';
import type { ImportDiagnosticExport } from '../server/import-diagnostics.ts';

const originalId = 'fictional-original';
const exactRecords = (scenario: 'quick' | 'long' = 'quick'): QualificationRecord[] =>
  answersForQualification(scenario).map((answer) => ({
    id: answer.marker,
    kind: answer.kind,
    mapping: { testLabel: '', medicationName: '', procedureLabel: '', ...answer.fields },
    evidence: [
      {
        label: 'Original source',
        locator: `page ${answer.page}, row ${answer.marker}`,
        contentUrl: `/api/sources/${originalId}/content`,
      },
    ],
  }));

test('provider fixture has four independent pages and scan-only pages without hidden answers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-provider-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fictional.pdf');
  const receipt = writeProviderQualificationPdf(path);
  assert.equal(receipt.expectedRecords, 64);
  const task = getDocument({
    data: Uint8Array.from(readFileSync(path)),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 4);
    for (let number = 1; number <= 4; number++) {
      const page = await document.getPage(number);
      const content = (await page.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ');
      if (number % 2) {
        assert.ok(
          content
            .replace(/\s+/g, '')
            .includes(`Issuing software/system: ${qualificationSourceSystem}.`.replace(/\s+/g, '')),
          content,
        );
        for (const answer of qualificationAnswers.filter((answer) => answer.page === number))
          assert.ok(content.includes(answer.marker));
        assert.doesNotMatch(content, new RegExp(`FXP${number + 1}R`));
      } else {
        assert.equal(content, '', 'scan answers must be visible pixels only');
        assert.ok((await page.getOperatorList()).fnArray.includes(OPS.paintImageXObject));
      }
    }
  } finally {
    await task.destroy();
  }
});

test('tiny diagnostics fixture has one page and four literal fictional observations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-tiny-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'tiny.pdf');
  const receipt = writeProviderQualificationPdf(path, 'tiny');
  assert.equal(receipt.pages, 1);
  assert.equal(receipt.expectedRecords, 4);
  const answers = answersForQualification('tiny');
  assert.deepEqual(
    answers.map((answer) => answer.marker),
    ['FXP1R01', 'FXP1R02', 'FXP1R03', 'FXP1R04'],
  );
  assert.ok(answers.every((answer) => answer.kind === 'observation'));
  const task = getDocument({
    data: Uint8Array.from(readFileSync(path)),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items
      .flatMap((item) => ('str' in item ? [item.str] : []))
      .join(' ');
    for (const answer of answers) assert.ok(text.includes(answer.marker));
  } finally {
    await task.destroy();
  }
});

test('qualification oracle rejects omissions, duplicate rows, hallucinations and literal-field errors', () => {
  assert.equal(gradeProviderQualification(exactRecords(), originalId).passed, true);
  const incorrect = exactRecords();
  incorrect.splice(0, 1);
  incorrect.push({ ...incorrect[0], id: 'fictional-duplicate' });
  incorrect.push({
    ...incorrect[1],
    id: 'fictional-extra',
    mapping: { ...incorrect[1].mapping, testLabel: 'FICTIONAL-HALLUCINATION' },
  });
  incorrect[2].mapping.valueText = '9.999';
  incorrect[3].mapping.subject = 'unknown';
  incorrect[4].mapping.date = '2026-02-09';
  const grade = gradeProviderQualification(incorrect, originalId);
  assert.equal(grade.passed, false);
  assert.deepEqual(grade.missing, ['FXP1R01']);
  assert.deepEqual(grade.duplicate, ['FXP1R02']);
  assert.deepEqual(grade.unexpected, ['fictional-extra']);
  assert.deepEqual(
    grade.mismatches.map((entry) => entry.fields),
    [['valueText'], ['subject'], ['date']],
  );
  assert.equal(grade.pages[1].exact, 16);
});

test('qualification usage totals preserve unreported cache values and recorder loss as unknown', () => {
  const snapshot: ImportDiagnosticExport = {
    schemaVersion: 1,
    generatedAt: '',
    exportId: '',
    consoleScopeId: '',
    retainedEvents: 4,
    droppedEvents: 0,
    coverage: 'bounded_metadata_only',
    events: [1, 2, 3, 4].map((sequence) => ({
      schemaVersion: 1,
      sequence,
      timestamp: '',
      monotonicMs: sequence,
      event: sequence % 2 ? 'model.request.started' : 'model.request.completed',
      context: {},
      fields: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cachedInputTokens: sequence === 2 ? 5 : null,
        pdfParts: 1,
        imageParts: 0,
      },
    })),
  };
  assert.equal(summarizeQualificationDiagnostics(snapshot).totalTokens, 60);
  assert.equal(summarizeQualificationDiagnostics(snapshot).cachedInputTokens, null);
  assert.equal(summarizeQualificationDiagnostics(snapshot, 2).totalTokens, 30);
  assert.equal(summarizeQualificationDiagnostics(snapshot).wirePdfParts, 2);
  assert.equal(summarizeQualificationDiagnostics(snapshot).wireImageParts, 0);
  assert.equal(summarizeQualificationDiagnostics(snapshot, 1).totalTokens, null);
  snapshot.droppedEvents = 1;
  assert.equal(summarizeQualificationDiagnostics(snapshot).totalTokens, null);
  snapshot.droppedEvents = 0;
  snapshot.events = [];
  assert.equal(summarizeQualificationDiagnostics(snapshot).totalTokens, null);
});

test('qualification probes PDF and images separately and requires a negative capability receipt for fallback', async () => {
  const calls: Array<{ image: boolean; pdf: boolean }> = [];
  const image = {
    available: true,
    backend: 'litellm',
    model: 'fictional',
    capabilities: { tools: true, images: true, pdf: null },
  };
  const native = { ...image, capabilities: { ...image.capabilities, pdf: true } };
  const result = await verifyQualificationConnection(
    'pdf',
    async (options) => {
      calls.push(options);
      return options.pdf ? native : image;
    },
    async () => image,
  );
  assert.deepEqual(calls, [
    { image: true, pdf: false },
    { image: false, pdf: true },
  ]);
  assert.equal(result.capabilities.pdf, true);
  const error = new Error('Fictional provider failure');
  const probe = async (options: { pdf: boolean }) => {
    if (options.pdf) throw error;
    return image;
  };
  const fallback = await verifyQualificationConnection('pdf', probe, async () => ({
    ...image,
    capabilities: { ...image.capabilities, pdf: false },
  }));
  assert.equal(fallback.capabilities.pdf, false);
  await assert.rejects(
    verifyQualificationConnection('pdf', probe, async () => ({ ...image, available: false })),
    error,
  );
});

test('long qualification contains 100 independent mixed pages with fixed literal known answers', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-long-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fictional.pdf');
  const receipt = writeProviderQualificationPdf(path, 'long');
  assert.equal(receipt.pages, 100);
  assert.equal(receipt.expectedRecords, 400);
  assert.deepEqual(receipt.expectedKinds, ['observation', 'medication', 'procedure']);
  const answers = answersForQualification('long');
  assert.deepEqual(answers[398].fields, {
    subject: 'self',
    medicationName: 'FXP100R03',
    medicationKind: 'order',
    eventKind: 'order',
    dateRole: 'recorded',
    date: '2026-04-16',
    doseText: '101 mg',
    route: 'oral',
    frequency: 'once daily',
    startDate: '',
    endDate: '',
    sourceSystem: qualificationSourceSystem,
  });
  assert.equal(answers[399].fields.procedureLabel, 'FXP100R04');
  assert.equal(answers[0].fields.valueText, '<0.01');
  const task = getDocument({
    data: Uint8Array.from(readFileSync(path)),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 100);
    for (const pageNumber of [1, 2, 99, 100]) {
      const page = await document.getPage(pageNumber);
      const contents = (await page.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ');
      if (pageNumber % 2) {
        assert.match(contents, new RegExp(`MEDICATION FXP${pageNumber}R03`));
        assert.match(contents, new RegExp(`PROCEDURE FXP${pageNumber}R04`));
        assert.match(contents, /1982-04-17/);
        const first = answersForQualification('long').find((answer) => answer.page === pageNumber)!;
        const compactText = contents.replace(/\s+/g, '');
        assert.ok(
          compactText.includes(
            `Result: ${first.fields.valueText}; Unit: ${first.fields.unit}.`.replace(/\s+/g, ''),
          ),
        );
        assert.ok(
          compactText.includes(
            `Issuing software/system: ${qualificationSourceSystem}.`.replace(/\s+/g, ''),
          ),
        );
      } else {
        assert.equal(contents, '');
        assert.ok((await page.getOperatorList()).fnArray.includes(OPS.paintImageXObject));
      }
    }
  } finally {
    await task.destroy();
  }
});

test('provenance oracle rejects wrong original IDs, wrong pages, broad ranges and missing locators', () => {
  const records = exactRecords('long');
  assert.equal(gradeProviderQualification(records, originalId, 'long').passed, true);
  const incorrect = structuredClone(records);
  incorrect[0].evidence![0].locator = 'pages 1-2';
  incorrect[1].evidence![0].locator = 'page 9';
  incorrect[2].evidence![0].contentUrl = '/api/sources/some-other-original/content';
  incorrect[3].evidence = [];
  incorrect[4].evidence![0].locator = 'page 2 and page 3';
  incorrect[5].evidence![0].locator = 'Original';
  incorrect[6].mapping.medicationKind = 'reported_use';
  incorrect[7].mapping.procedureCategory = 'surgery';
  const grade = gradeProviderQualification(incorrect, originalId, 'long');
  assert.equal(grade.passed, false);
  assert.deepEqual(
    grade.mismatches.map((item) => item.fields),
    Array.from({ length: 6 }, () => ['originalPageProvenance']).concat([
      ['medicationKind'],
      ['procedureCategory'],
    ]),
  );
  assert.equal(grade.pages[0].exact, 0);
  assert.equal(grade.pages[99].exact, 4);
  const evidence = records[0].evidence![0];
  for (const locator of [
    'pages 1, 3',
    'pages 1 through 3',
    'p. 1-3',
    'pages 1 / 3',
    'pages 1; 3',
    'pages 1 + 2',
    'page 1 or 2',
    'pages 1 thru 3',
    'possibly page 1',
    'page 1?',
  ])
    assert.equal(exactQualificationPage({ ...evidence, locator }, originalId), null);
  assert.equal(exactQualificationPage({ ...evidence, locator: 'Page 1, row 4' }, originalId), 1);
  assert.equal(
    exactQualificationPage(
      { ...evidence, contentUrl: evidence.contentUrl + '#page=7' },
      originalId,
    ),
    null,
  );
});

test('accepted-record oracle checks public projected fields and durable original provenance', () => {
  const retained = exactRecords()[0];
  const publicRecord = {
    id: 'accepted-fictional',
    label: 'FXP1R01',
    date: '2026-01-01',
    valueText: '<0.01',
    value: 0.01,
    comparator: '<',
    datePrecision: 'day',
    status: 'final',
    unit: 'mg/dL',
    reference: { text: '0.01 - 9.99' },
    extra: { import: { acceptedMapping: retained.mapping } },
    evidence: [
      {
        id: 'evidence',
        sourceRecordId: 'source-record',
        role: 'source',
        locator: {
          locator: 'page 1 row FXP1R01',
          originalSourceFileId: originalId,
          reviewed: true,
        },
      },
    ],
  } as Observation;
  const records = exactRecords();
  records[0] = acceptedQualificationRecord('observation', publicRecord);
  assert.equal(gradeProviderQualification(records, originalId).passed, true);
  records[0] = acceptedQualificationRecord('observation', { ...publicRecord, valueText: '1.00' });
  assert.deepEqual(gradeProviderQualification(records, originalId).mismatches[0].fields, [
    'valueText',
  ]);
  records[0] = acceptedQualificationRecord('observation', { ...publicRecord, evidence: [] });
  assert.deepEqual(gradeProviderQualification(records, originalId).mismatches[0].fields, [
    'originalPageProvenance',
  ]);
});

test('explicit acceptance consolidates feed blocks and rejects blocked, duplicate or stale selections', () => {
  const record = (id: string) => ({
    ...exactRecords()[0],
    id,
    candidateId: 'candidate-' + id,
    candidateVersionId: 'version-' + id,
    selectable: true,
    queueState: 'pending',
  });
  const block = {
    intakeId: originalId,
    proposalId: 'proposal',
    intakeVersion: 7,
    reviewToken: 'review-token',
    records: [record('one')],
  } as unknown as IntakeImportFeedBlock;
  const second = { ...block, records: [record('two')] } as unknown as IntakeImportFeedBlock;
  const request = qualificationAcceptanceRequest([block, second]);
  assert.equal(request.blocks.length, 1);
  assert.deepEqual(
    request.blocks[0].selections.map((item) => item.recordId),
    ['one', 'two'],
  );
  assert.ok(request.blocks[0].selections.every((item) => Object.keys(item.mapping).length === 0));
  assert.throws(() => qualificationAcceptanceRequest([block, block]), /duplicate exact versions/);
  assert.throws(
    () => qualificationAcceptanceRequest([block, { ...second, intakeVersion: 8 }]),
    /changed while paginating/,
  );
  assert.throws(
    () =>
      qualificationAcceptanceRequest([
        { ...block, records: [{ ...block.records[0], selectable: false }] },
      ]),
    /individually resolved/,
  );
});

test('cache matrix counterbalances settings and never converts unavailable usage into savings', () => {
  const schedule = qualificationSchedule(true, 'on');
  assert.equal(schedule.length, 8);
  assert.deepEqual(
    schedule.slice(0, 4).map((item) => item.cache),
    ['off', 'on', 'on', 'off'],
  );
  assert.deepEqual(
    schedule.slice(4).map((item) => item.configurationPosition),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    qualificationSchedule(false, 'off').map((item) => item.cache),
    ['off', 'off'],
  );
  const base = {
    mode: 'pdf' as const,
    elapsedMs: 400,
    grade: gradeProviderQualification(exactRecords(), originalId),
    diagnostics: { cachedInputTokens: null } as ReturnType<
      typeof summarizeQualificationDiagnostics
    >,
  };
  const summary = summarizeQualificationCache([
    { ...base, cache: 'off' },
    { ...base, cache: 'on', elapsedMs: 100 },
    {
      ...base,
      cache: 'on',
      elapsedMs: 200,
      diagnostics: { ...base.diagnostics, cachedInputTokens: 12 },
    },
  ]);
  assert.equal(summary[0].causalSavingsEstablished, false);
  assert.equal(summary[0].conditions[1].medianElapsedMs, 150);
  assert.equal(summary[0].conditions[1].reportedCachedInputTokens, null);
  assert.equal(summary[1].conditions[0].medianElapsedMs, null);
});

test('single-format qualification schedules one PDF-first import without extra cache or raster runs', () => {
  assert.deepEqual(qualificationSchedule(false, 'off', 'auto'), [
    { mode: 'pdf', cache: 'off', configurationPosition: 1 },
  ]);
  assert.deepEqual(qualificationSchedule(false, 'on', 'png'), [
    { mode: 'png', cache: 'on', configurationPosition: 1 },
  ]);
  assert.equal(qualificationSchedule(true, 'off', 'pdf').length, 4);
});

test('mixed accepted projections expose medication and procedure errors independently of retained mappings', () => {
  const records = exactRecords('long');
  const medication = {
    id: records[2].id,
    label: 'FXP1R03',
    kind: 'order',
    sourceRecordedDate: '2026-01-01',
    doseText: '2 mg',
    route: 'oral',
    frequency: 'once daily',
    startAt: null,
    endAt: null,
    extra: { import: { acceptedMapping: records[2].mapping } },
    evidence: [
      {
        id: 'med-evidence',
        sourceRecordId: 'med-source',
        role: 'source',
        locator: { locator: 'page 1 row FXP1R03', originalSourceFileId: originalId },
      },
    ],
  } as Medication;
  const procedure = {
    id: records[3].id,
    label: 'FXP1R04',
    category: 'imaging',
    date: '2026-01-01',
    status: 'completed',
    extra: { import: { acceptedMapping: records[3].mapping } },
    evidence: [
      {
        id: 'procedure-evidence',
        sourceRecordId: 'procedure-source',
        role: 'source',
        locator: { locator: 'page 1 row FXP1R04', originalSourceFileId: originalId },
      },
    ],
  } as Procedure;
  records[2] = acceptedQualificationRecord('medication', medication);
  records[3] = acceptedQualificationRecord('procedure', procedure);
  assert.equal(gradeProviderQualification(records, originalId, 'long').passed, true);
  records[2] = acceptedQualificationRecord('medication', {
    ...medication,
    kind: 'reported_use',
    doseText: '20 mg',
    startAt: '2026-01-01',
  });
  records[3] = acceptedQualificationRecord('procedure', {
    ...procedure,
    category: 'surgery',
    date: '2026-01-02',
  });
  assert.deepEqual(
    gradeProviderQualification(records, originalId, 'long').mismatches.map((item) => item.fields),
    [
      ['medicationKind', 'doseText', 'startDate'],
      ['procedureCategory', 'date'],
    ],
  );
  const duplicateIds = exactRecords();
  duplicateIds[1].id = duplicateIds[0].id;
  assert.equal(gradeProviderQualification(duplicateIds, originalId).passed, false);
  assert.deepEqual(gradeProviderQualification(duplicateIds, originalId).duplicateIds, ['FXP1R01']);
});

test('qualification rejects unsupported codes, external IDs, abnormality, dates and cross-kind assertions', () => {
  const mutations: Array<[number, Record<string, unknown>, string[]]> = [
    [0, { code: '12345-6', codeSystem: 'LOINC' }, ['code', 'codeSystem']],
    [0, { specimen: 'serum', method: 'mass spectrometry' }, ['specimen', 'method']],
    [0, { sourceRecordId: 'external-chart-42' }, ['sourceRecordId']],
    [0, { status: 'abnormal' }, ['status']],
    [
      0,
      { abnormality: 'high', patientId: 'patient-42', collectionTime: '09:30' },
      ['abnormality', 'patientId', 'collectionTime'],
    ],
    [
      0,
      { eventKind: 'order', observationCategory: 'vital_sign' },
      ['eventKind', 'observationCategory'],
    ],
    [
      0,
      { dateRole: 'start', startDate: '2026-01-01', documentDate: '2026-02-01' },
      ['dateRole', 'startDate', 'documentDate'],
    ],
    [0, { doseText: '20 mg', medicationKind: 'administration' }, ['doseText', 'medicationKind']],
    [0, { sourceSystem: 'Unprinted issuer' }, ['sourceSystem']],
    [
      0,
      { opticalPrescription: { sphere: '+2.0' }, visitSpecialty: 'cardiology' },
      ['visitSpecialty', 'opticalPrescription'],
    ],
    [
      0,
      { assets: ['some-other-source'], uncertainties: ['possibly normal'] },
      ['assets', 'uncertainties'],
    ],
    [0, { code: 12345 }, ['code']],
    [
      2,
      { status: 'active', method: 'injection', endDate: '2026-03-01' },
      ['status', 'method', 'endDate'],
    ],
    [3, { code: 'fictional-CPT', procedureCategory: 'surgery' }, ['procedureCategory', 'code']],
  ];
  for (const [index, changed, expected] of mutations) {
    const records = exactRecords('long');
    Object.assign(records[index].mapping, changed);
    const grade = gradeProviderQualification(records, originalId, 'long');
    assert.equal(grade.passed, false, JSON.stringify(changed));
    assert.deepEqual(
      [...grade.mismatches[0].fields].sort(),
      [...expected].sort(),
      JSON.stringify(changed),
    );
  }
  const valid = exactRecords('long');
  for (const record of valid)
    Object.assign(record.mapping, {
      kind: record.kind,
      label: record.id,
      documentTitle: 'host-envelope-' + record.id,
      documentDate: record.mapping.date,
      text: '{"source":"retained literal transcription"}',
      mappingOrigins: { documentTitle: 'envelope', text: 'payload' },
      assets: [originalId],
      uncertainties: [],
      opticalPrescription: null,
    });
  valid[0].mapping.medicationKind = 'unknown';
  valid[0].mapping.procedureCategory = 'unspecified';
  valid[0].mapping.dateRole = 'recorded';
  assert.equal(
    gradeProviderQualification(valid, originalId, 'long').passed,
    true,
    'host defaults and payload text are not new clinical assertions',
  );
});

test('accepted numeric, comparator, precision and status corruption cannot hide behind correct retained mapping', () => {
  const records = exactRecords();
  const correct = {
    id: 'accepted',
    label: 'FXP1R01',
    date: '2026-01-01',
    datePrecision: 'day',
    valueText: '<0.01',
    value: 0.01,
    comparator: '<',
    unit: 'mg/dL',
    status: 'final',
    reference: { text: '0.01 - 9.99' },
    extra: { import: { acceptedMapping: records[0].mapping } },
    evidence: [
      {
        id: 'evidence',
        sourceRecordId: 'internal-source-row',
        role: 'source',
        locator: { locator: 'page 1', originalSourceFileId: originalId },
      },
    ],
  } as Observation;
  records[0] = acceptedQualificationRecord('observation', {
    ...correct,
    value: 99,
    comparator: '=',
    datePrecision: 'month',
    status: 'abnormal',
  });
  assert.deepEqual(gradeProviderQualification(records, originalId).mismatches[0].fields, [
    'status',
    'publicNumericValue',
    'publicComparator',
    'publicDatePrecision',
  ]);
  records[0] = acceptedQualificationRecord('observation', {
    ...correct,
    value: null,
    comparator: null,
  });
  assert.deepEqual(gradeProviderQualification(records, originalId).mismatches[0].fields, [
    'publicNumericValue',
    'publicComparator',
  ]);
});

const deliveryAttribution = (readPages: number[]) => ({
  schemaVersion: 1,
  omittedImports: 0,
  omittedChats: 0,
  unavailableChats: 0,
  exportBounds: { partial: false },
  imports: [
    {
      importId: 'salted-original',
      historicalReadsUnknown: false,
      truncated: false,
      untrackedReadScopes: 0,
      untrackedReadWindows: 0,
      pages: Array.from({ length: 100 }, (_, index) => ({
        sourceId: 'salted-original',
        memberId: null,
        page: index + 1,
        hostReads: readPages.includes(index + 1) ? 1 : 0,
        acknowledgedReads: readPages.includes(index + 1) ? 1 : 0,
        requestExposure: {
          attempts: readPages.includes(index + 1) ? 1 : 0,
          responses: readPages.includes(index + 1) ? 1 : 0,
        },
        activeCoverage: { extracted: 1 },
        proposedOccurrences: 4,
      })),
    },
  ],
});

test('correct 400 answers and complete plan coverage do not substitute for exact-page provider delivery', () => {
  assert.equal(gradeProviderQualification(exactRecords('long'), originalId, 'long').passed, true);
  const firstOnly = gradeQualificationDelivery(deliveryAttribution([1]), 100);
  assert.equal(firstOnly.passed, false);
  assert.equal(firstOnly.status, 'incomplete');
  assert.deepEqual(firstOnly.acknowledgedPages, [1]);
  assert.equal(firstOnly.missingPages!.length, 99);
  const complete = deliveryAttribution(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(gradeQualificationDelivery(complete, 100).passed, true);
  complete.imports[0].pages[1].acknowledgedReads = 0;
  complete.imports[0].pages[2].requestExposure.responses = 0;
  complete.imports[0].pages[3].sourceId = 'other-file';
  assert.deepEqual(gradeQualificationDelivery(complete, 100).missingPages, [2, 3, 4]);
  const broad = deliveryAttribution([]);
  Object.assign(broad.imports[0].pages[0], {
    page: null,
    hostReads: 1,
    acknowledgedReads: 1,
    requestExposure: { attempts: 1, responses: 1 },
  });
  assert.equal(gradeQualificationDelivery(broad, 100).missingPages!.length, 100);
  const truncated = deliveryAttribution([1]);
  truncated.exportBounds.partial = true;
  assert.equal(gradeQualificationDelivery(truncated, 100).status, 'unknown');
  assert.equal(gradeQualificationDelivery(truncated, 100).acknowledgedPages, null);
  assert.equal(gradeQualificationDelivery(undefined, 100).status, 'unknown');
});

test('qualification stages permit pending unknown identity only before review and preserve strict literal fields', () => {
  const pending = exactRecords('long');
  for (const record of pending) record.mapping.subject = 'unknown';
  const extracted = gradeProviderQualification(pending, originalId, 'long', 'extracted');
  assert.equal(extracted.passed, true);
  assert.equal(extracted.stage, 'extracted');
  assert.equal(extracted.exactRecords, 400);
  const accepted = gradeProviderQualification(pending, originalId, 'long', 'accepted');
  assert.equal(accepted.passed, false);
  assert.equal(accepted.mismatches.length, 400);
  assert.ok(accepted.mismatches.every((item) => item.fields.join(',') === 'subject'));
  for (const subject of ['other', '', undefined]) {
    const changed = structuredClone(pending);
    changed[0].mapping.subject = subject as QualificationRecord['mapping']['subject'];
    assert.deepEqual(
      gradeProviderQualification(changed, originalId, 'long', 'extracted').mismatches,
      [{ marker: 'FXP1R01', fields: ['subject'] }],
    );
  }
  for (const field of ['valueText', 'unit', 'date', 'sourceSystem'] as const) {
    const changed = structuredClone(pending);
    changed[0].mapping[field] = 'unsupported';
    assert.deepEqual(
      gradeProviderQualification(changed, originalId, 'long', 'extracted').mismatches,
      [{ marker: 'FXP1R01', fields: [field] }],
    );
  }
  for (const identity of [
    { fullName: 'Different Fictional Person', birthDate: qualificationBirthDate },
    { fullName: qualificationPerson, birthDate: '1990-01-01' },
  ]) {
    const changed = structuredClone(pending);
    changed[0].identityReview = {
      status: 'confirmation_required',
      conflicts: [],
      evidencedIdentity: identity,
    };
    assert.deepEqual(
      gradeProviderQualification(changed, originalId, 'long', 'extracted').mismatches,
      [{ marker: 'FXP1R01', fields: ['subjectIdentity'] }],
    );
  }
  const missing = pending.slice(0, 80);
  assert.equal(gradeProviderQualification(missing, originalId, 'long', 'extracted').passed, false);
  assert.equal(
    gradeProviderQualification(missing, originalId, 'long', 'extracted').missing.length,
    320,
  );
});
