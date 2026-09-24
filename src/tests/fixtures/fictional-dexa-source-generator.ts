import { zipFixture } from './zip.ts';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEXA_SOURCE_SYSTEM = 'Juniper Ridge Imaging Sandbox';
export const DEXA_SUBJECT = 'Fern Example';
export const SURGERY_SUBJECT = 'Rowan Ember';

export type FictionalDexaSourceResult = {
  id: string;
  section: 'Spine' | 'Left hip' | 'Right hip' | 'Forearm' | 'Whole body';
  label: string;
  valueText: string;
  unit: string;
  category: 'bone_density' | 'body_composition';
};

// These are the values printed into the independently fictional report. Expected
// benchmark truth is deliberately maintained in a separate module.
export const FICTIONAL_DEXA_SOURCE_RESULTS: FictionalDexaSourceResult[] = [
  {
    id: 'dexa-l1-bmd',
    section: 'Spine',
    label: 'L1 bone mineral density',
    valueText: '0.912',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-l2-bmd',
    section: 'Spine',
    label: 'L2 bone mineral density',
    valueText: '0.945',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-l3-bmd',
    section: 'Spine',
    label: 'L3 bone mineral density',
    valueText: '0.988',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-l4-bmd',
    section: 'Spine',
    label: 'L4 bone mineral density',
    valueText: '1.021',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-spine-total-bmd',
    section: 'Spine',
    label: 'Lumbar spine total bone mineral density',
    valueText: '0.968',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-spine-t-score',
    section: 'Spine',
    label: 'Lumbar spine T-score',
    valueText: '-1.2',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-spine-z-score',
    section: 'Spine',
    label: 'Lumbar spine Z-score',
    valueText: '-0.4',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-neck-bmd',
    section: 'Left hip',
    label: 'Left femoral neck bone mineral density',
    valueText: '0.742',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-total-bmd',
    section: 'Left hip',
    label: 'Left total hip bone mineral density',
    valueText: '0.811',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-neck-t-score',
    section: 'Left hip',
    label: 'Left femoral neck T-score',
    valueText: '-1.6',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-total-t-score',
    section: 'Left hip',
    label: 'Left total hip T-score',
    valueText: '-1.1',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-neck-z-score',
    section: 'Left hip',
    label: 'Left femoral neck Z-score',
    valueText: '-0.7',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-left-total-z-score',
    section: 'Left hip',
    label: 'Left total hip Z-score',
    valueText: '-0.4',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-neck-bmd',
    section: 'Right hip',
    label: 'Right femoral neck bone mineral density',
    valueText: '0.756',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-total-bmd',
    section: 'Right hip',
    label: 'Right total hip bone mineral density',
    valueText: '0.824',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-neck-t-score',
    section: 'Right hip',
    label: 'Right femoral neck T-score',
    valueText: '-1.5',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-total-t-score',
    section: 'Right hip',
    label: 'Right total hip T-score',
    valueText: '-1.0',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-neck-z-score',
    section: 'Right hip',
    label: 'Right femoral neck Z-score',
    valueText: '-0.6',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-right-total-z-score',
    section: 'Right hip',
    label: 'Right total hip Z-score',
    valueText: '-0.3',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-radius-bmd',
    section: 'Forearm',
    label: 'One-third radius bone mineral density',
    valueText: '0.689',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-radius-t-score',
    section: 'Forearm',
    label: 'One-third radius T-score',
    valueText: '-0.8',
    unit: 'T-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-radius-z-score',
    section: 'Forearm',
    label: 'One-third radius Z-score',
    valueText: '+0.1',
    unit: 'Z-score',
    category: 'bone_density',
  },
  {
    id: 'dexa-total-body-bmd',
    section: 'Whole body',
    label: 'Total body bone mineral density',
    valueText: '1.087',
    unit: 'g/cm2',
    category: 'bone_density',
  },
  {
    id: 'dexa-lean-mass',
    section: 'Whole body',
    label: 'Total lean mass',
    valueText: '42.37',
    unit: 'kg',
    category: 'body_composition',
  },
  {
    id: 'dexa-fat-mass',
    section: 'Whole body',
    label: 'Total fat mass',
    valueText: '18.62',
    unit: 'kg',
    category: 'body_composition',
  },
  {
    id: 'dexa-body-fat',
    section: 'Whole body',
    label: 'Total body fat',
    valueText: '29.8',
    unit: '%',
    category: 'body_composition',
  },
  {
    id: 'dexa-android-gynoid',
    section: 'Whole body',
    label: 'Android to gynoid fat ratio',
    valueText: '0.78',
    unit: 'ratio',
    category: 'body_composition',
  },
  {
    id: 'dexa-visceral-area',
    section: 'Whole body',
    label: 'Visceral adipose tissue area',
    valueText: '64.3',
    unit: 'cm2',
    category: 'body_composition',
  },
];

export const FICTIONAL_SURGERY_SOURCE_EVENTS = [
  {
    id: 'surgery-left-ankle-performed',
    label: 'Left ankle arthroscopy',
    date: '2026-07-02',
    status: 'completed',
    eventKind: 'performed',
    cue: 'PERFORMED AND COMPLETED',
  },
  {
    id: 'surgery-right-shoulder-order',
    label: 'Right shoulder arthroscopy',
    date: '2026-10-19',
    status: 'planned',
    eventKind: 'order',
    cue: 'ORDER ONLY - NOT PERFORMED',
  },
] as const;

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

function sectionPage(section: FictionalDexaSourceResult['section']) {
  return section === 'Spine' || section === 'Left hip'
    ? 1
    : section === 'Right hip' || section === 'Forearm'
      ? 2
      : 3;
}

function dexaPdfBytes() {
  return createPdf(
    [1, 2, 3].map((page) => [
      `FICTIONAL DEXA REPORT DEXA-FX-2048 - ${DEXA_SOURCE_SYSTEM}`,
      `Subject: ${DEXA_SUBJECT} | Report scope: DEXA-FX-2048 | Page ${page} of 3`,
      'Ordered 2026-08-01 | Performed 2026-08-14 09:40 | Finalized 2026-08-15 16:20',
      'All results below belong to subject Fern Example and report DEXA-FX-2048.',
      ...FICTIONAL_DEXA_SOURCE_RESULTS.filter(
        (result) => sectionPage(result.section) === page,
      ).flatMap((result, index, pageResults) => [
        ...(index === 0 || pageResults[index - 1]?.section !== result.section
          ? [`SECTION: ${result.section}`]
          : []),
        `Record ${result.id} | ${result.label} | ${result.valueText} ${result.unit} | category ${result.category}`,
      ]),
    ]),
  );
}

function surgeryPdfBytes() {
  return createPdf([
    [
      `FICTIONAL SURGERY SUMMARY SURG-FX-883 - ${DEXA_SOURCE_SYSTEM}`,
      `Subject: ${SURGERY_SUBJECT} | Report scope: SURG-FX-883`,
      ...FICTIONAL_SURGERY_SOURCE_EVENTS.map(
        (event) => `Record ${event.id} | ${event.label} | ${event.cue} | date ${event.date}`,
      ),
      'The order-only event is not a completed surgery.',
    ],
  ]);
}

function deterministicZip(path: string, members: Array<[string, Uint8Array]>) {
  writeFileSync(
    path,
    zipFixture(
      members.map(([name, data]) => ({ name, data: Buffer.from(data) })),
      { store: true },
    ),
  );
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function buildFictionalDexaSources(directory: string) {
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const dexa = dexaPdfBytes();
  const surgery = surgeryPdfBytes();
  const dexaPath = join(output, 'fictional-dexa-report.pdf');
  const zipPath = join(output, 'fictional-mixed-person-redundant.zip');
  writeFileSync(dexaPath, dexa);
  deterministicZip(zipPath, [
    ['person-a/dexa-report.pdf', dexa],
    ['redundant/person-a/dexa-report-copy.pdf', dexa],
    ['person-b/surgery-summary.pdf', surgery],
  ]);
  const zip = readFileSync(zipPath);
  const manifest = {
    fixture: 'circus-fictional-dexa-v1',
    files: [
      { filename: 'fictional-dexa-report.pdf', bytes: dexa.length, sha256: digest(dexa) },
      { filename: 'fictional-mixed-person-redundant.zip', bytes: zip.length, sha256: digest(zip) },
    ],
    zipMembers: [
      { filename: 'person-a/dexa-report.pdf', sha256: digest(dexa), subject: DEXA_SUBJECT },
      {
        filename: 'redundant/person-a/dexa-report-copy.pdf',
        sha256: digest(dexa),
        subject: DEXA_SUBJECT,
      },
      {
        filename: 'person-b/surgery-summary.pdf',
        sha256: digest(surgery),
        subject: SURGERY_SUBJECT,
      },
    ],
  };
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { directory: output, dexa, surgery, zip, dexaPath, zipPath, manifest };
}
