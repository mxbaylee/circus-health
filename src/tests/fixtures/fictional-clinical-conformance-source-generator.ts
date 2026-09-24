import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CLINICAL_CONFORMANCE_SOURCE_SYSTEM = 'Northstar Fictional Metrics Sandbox';
export const CLINICAL_CONFORMANCE_SUBJECT = 'Saffron Example';
export const CLINICAL_CONFORMANCE_REPORT_KEY = 'CLIN-FX-4107';
export const CLINICAL_CONFORMANCE_MODALITY = 'Fictional prism absorptiometry';
export const CLINICAL_CONFORMANCE_CURRENT_DATE = '2041-04-05';
export const CLINICAL_CONFORMANCE_PRIOR_DATE = '2040-04-06';

export const CLINICAL_CONFORMANCE_REPEATED_RESULTS = [
  {
    label: 'Fictional measured reach',
    valueText: '17.4',
    unit: 'fictional spans',
  },
  {
    label: 'Fictional measured balance',
    valueText: '+3.2',
    unit: 'fictional marks',
  },
] as const;

export const CLINICAL_CONFORMANCE_STACKED_RESULTS = [
  {
    id: 'fx-stack-a1',
    label: 'Fictional composition marker A',
    valueText: '+1.25',
  },
  {
    id: 'fx-stack-a2',
    label: 'Fictional composition marker A',
    valueText: '+1.10',
  },
  {
    id: 'fx-stack-b1',
    label: 'Fictional composition marker B',
    valueText: '42.8',
  },
  {
    id: 'fx-stack-b2',
    label: 'Fictional composition marker B',
    valueText: '41.9',
  },
] as const;

export const CLINICAL_CONFORMANCE_AMBIGUOUS_RESULTS = [
  {
    id: 'fx-appendix-a',
    label: 'Fictional appendix marker',
    valueText: '2.10',
  },
  {
    id: 'fx-appendix-b',
    label: 'Fictional appendix marker',
    valueText: '2.00',
  },
] as const;

export const CLINICAL_CONFORMANCE_PROCEDURES = [
  {
    id: 'fx-procedure-current',
    label: 'Fictional prism scan',
    date: '2041-04-05',
    eventKind: 'performed',
  },
  {
    id: 'fx-procedure-history',
    label: 'Fictional arc scan',
    date: '2039-03-04',
    eventKind: 'historical_mention',
  },
] as const;

export const CLINICAL_CONFORMANCE_TITLE_LINE =
  'FICTIONAL PRISM SCAN RESULTS CLIN-FX-4107 - Northstar Fictional Metrics Sandbox';
export const CLINICAL_CONFORMANCE_MODALITY_LINE =
  'ACQUISITION MODALITY: Fictional prism absorptiometry';
export const CLINICAL_CONFORMANCE_CONTROL_LINE =
  'REFERENCE ONLY: Fictional orbit scan | date 2038-02-03 | no performed event is stated';
export const CLINICAL_CONFORMANCE_BARE_DATE_LINE =
  'MEASUREMENT HISTORY DATE ONLY: 2037-01-02 | no procedure or scan event is identified';
export const CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR =
  'APPENDIX ORDER: the two values have no stated current/prior order and do not continue page 1';

const repeatedPanel = () => [
  'PATIENT MEASURED RESULTS - these are measured results, not demographics or reference rows',
  ...CLINICAL_CONFORMANCE_REPEATED_RESULTS.map(
    (result) => `Measured result | ${result.label} | ${result.valueText} ${result.unit}`,
  ),
];

export function fictionalClinicalConformancePages(): string[][] {
  const common = (page: number) => [
    CLINICAL_CONFORMANCE_TITLE_LINE,
    `Subject: ${CLINICAL_CONFORMANCE_SUBJECT} | Report: ${CLINICAL_CONFORMANCE_REPORT_KEY} | Page ${page} of 4`,
    ...repeatedPanel(),
  ];
  return [
    [
      ...common(1),
      'DATED TABLE ONLY - the domain, modality and dates below do not apply to the measured-results panel',
      'RESULT DOMAIN TOKEN: body_composition',
      CLINICAL_CONFORMANCE_MODALITY_LINE,
      `COLUMN ORDER: CURRENT (${CLINICAL_CONFORMANCE_CURRENT_DATE}), PRIOR (${CLINICAL_CONFORMANCE_PRIOR_DATE})`,
      CLINICAL_CONFORMANCE_CONTROL_LINE,
      'No dated-table result rows appear on this page.',
    ],
    [
      ...common(2),
      'DATED TABLE CONTINUATION - each stacked pair keeps page 1 order: CURRENT, then PRIOR',
      'RESULT DOMAIN TOKEN: body_composition',
      CLINICAL_CONFORMANCE_MODALITY_LINE,
      ...CLINICAL_CONFORMANCE_STACKED_RESULTS.map(
        (result) => `Record ${result.id} | ${result.label} | ${result.valueText} fictional units`,
      ),
    ],
    [
      ...common(3),
      'AMBIGUOUS APPENDIX - result domain and modality apply, but table dates do not',
      'RESULT DOMAIN TOKEN: body_composition',
      CLINICAL_CONFORMANCE_MODALITY_LINE,
      CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR,
      ...CLINICAL_CONFORMANCE_AMBIGUOUS_RESULTS.map(
        (result) => `Record ${result.id} | ${result.label} | ${result.valueText} fictional units`,
      ),
    ],
    [
      ...common(4),
      'PROCEDURE CATEGORY TOKEN: imaging',
      'PROCEDURE TIMELINE',
      `Record fx-procedure-current | Fictional prism scan was performed for Subject: ${CLINICAL_CONFORMANCE_SUBJECT} | date 2041-04-05`,
      `Record fx-procedure-history | HISTORY ONLY: prior Fictional arc scan for Subject: ${CLINICAL_CONFORMANCE_SUBJECT} is mentioned | date 2039-03-04`,
      CLINICAL_CONFORMANCE_BARE_DATE_LINE,
    ],
  ];
}

function escapePdf(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function createPdf(pages: string[][]) {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = `BT /F1 9 Tf 42 750 Td ${lines
      .map((line, lineIndex) => `${lineIndex ? '0 -15 Td ' : ''}(${escapePdf(line)}) Tj`)
      .join(' ')} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    if (!index) continue;
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function buildFictionalClinicalConformanceSource(directory: string) {
  const output = resolve(directory);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const pdf = createPdf(fictionalClinicalConformancePages());
  const pdfPath = join(output, 'fictional-clinical-conformance-report.pdf');
  writeFileSync(pdfPath, pdf, { mode: 0o600 });
  chmodSync(pdfPath, 0o600);
  const manifest = {
    fixture: 'circus-fictional-clinical-conformance-v1',
    filename: 'fictional-clinical-conformance-report.pdf',
    pages: 4,
    bytes: pdf.length,
    sha256: digest(pdf),
  };
  const manifestPath = join(output, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  return { directory: output, pdf, pdfPath, manifest, manifestPath };
}
