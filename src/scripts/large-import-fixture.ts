import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { IntakeClinicalMapping } from '../shared/intake.ts';
import {
  assertFictionalOutputPath,
  writeFictionalPdf,
  type FictionalPdfPage,
} from './fictional-pdf-writer.ts';

export interface LargeImportAssertion {
  key: string;
  reportKey: string;
  personKey: string;
  pages: number[];
  mapping: IntakeClinicalMapping & { kind: 'observation' | 'medication' | 'procedure' };
  /** Exact printed strings and original pages; classification enums remain in mapping. */
  origins: Partial<Record<keyof IntakeClinicalMapping, { page: number; literal: string }>>;
}
export interface LargeImportOracle {
  format: 'circus-fictional-large-import-oracle-v1';
  pages: 900;
  people: Array<{ key: string; name: string; birthDate: string }>;
  reports: Array<{
    key: string;
    personKey: string;
    date: string;
    firstPage: number;
    lastPage: number;
  }>;
  assertions: LargeImportAssertion[];
}

/** Independently invented truth; never runtime ownership, acceptance authority or model instructions. */
export function createLargeImportOracle(): LargeImportOracle {
  const people = [
    { key: 'fictional-cedar', name: 'Fictional Cedar Vale', birthDate: '1982-04-17' },
    { key: 'fictional-willow', name: 'Fictional Willow Brook', birthDate: '1991-09-23' },
  ];
  const reports = Array.from({ length: 6 }, (_, index) => ({
    key: `fictional-report-${index + 1}`,
    personKey: people[index % 2]!.key,
    date: `2026-${String(index + 1).padStart(2, '0')}-12`,
    firstPage: index * 150 + 1,
    lastPage: (index + 1) * 150,
  }));
  const assertions: LargeImportAssertion[] = Array.from({ length: 900 }, (_, index) => {
    const page = index + 1,
      report = reports[Math.floor(index / 150)]!;
    const label = `FXP${String(page).padStart(3, '0')}`;
    const mapping: LargeImportAssertion['mapping'] =
      index % 3 === 0
        ? {
            kind: 'observation',
            testLabel: label,
            date: report.date,
            eventKind: 'performed',
            status: 'final',
            observationCategory: 'laboratory',
            valueText: '<0.070',
            unit: 'unit-X',
            referenceText: '0.010 - 9.990',
          }
        : index % 3 === 1
          ? {
              kind: 'medication',
              medicationName: label,
              date: report.date,
              eventKind: 'order',
              medicationKind: 'order',
              dateRole: 'recorded',
              doseText: '2.50 mg',
              route: 'oral',
              frequency: 'once daily',
            }
          : {
              kind: 'procedure',
              procedureLabel: label,
              date: report.date,
              eventKind: 'performed',
              procedureCategory: 'imaging',
              status: 'completed',
            };
    const classifications: Partial<Record<keyof IntakeClinicalMapping, string>> =
      mapping.kind === 'observation'
        ? {
            kind: 'observation',
            eventKind: 'Performed',
            status: 'final',
            observationCategory: 'laboratory',
          }
        : mapping.kind === 'medication'
          ? {
              kind: 'Medication',
              eventKind: 'ORDER',
              medicationKind: 'ORDER',
              dateRole: 'recorded date',
            }
          : {
              kind: 'procedure',
              eventKind: 'Performed',
              procedureCategory: 'imaging',
              status: 'completed',
            };
    return {
      key: `fictional-assertion-${page}`,
      reportKey: report.key,
      personKey: report.personKey,
      pages: [page],
      mapping,
      origins: Object.fromEntries(
        Object.entries(mapping).map(([field, value]) => [
          field,
          { page, literal: classifications[field as keyof IntakeClinicalMapping] || String(value) },
        ]),
      ),
    };
  });
  assertions.push({
    key: 'fictional-split-row',
    reportKey: reports[0]!.key,
    personKey: people[0]!.key,
    pages: [149, 150],
    mapping: {
      kind: 'observation',
      testLabel: 'FX-CROSS-001',
      date: reports[0]!.date,
      eventKind: 'performed',
      status: 'final',
      observationCategory: 'laboratory',
      valueText: '<0.0030',
      unit: 'unit-Y',
      referenceText: '0.0010 - 0.0090',
    },
    origins: {
      kind: { page: 149, literal: 'observations' },
      status: { page: 149, literal: 'final' },
      eventKind: { page: 149, literal: 'performed' },
      observationCategory: { page: 149, literal: 'Laboratory' },
      testLabel: { page: 149, literal: 'FX-CROSS-001' },
      date: { page: 149, literal: reports[0]!.date },
      valueText: { page: 150, literal: '<0.0030' },
      unit: { page: 150, literal: 'unit-Y' },
      referenceText: { page: 150, literal: '0.0010 - 0.0090' },
    },
  });
  return {
    format: 'circus-fictional-large-import-oracle-v1',
    pages: 900,
    people,
    reports,
    assertions,
  };
}

export interface LargeImportPage {
  page: number;
  kind: 'native' | 'scan';
  reportKey: string;
  personKey: string;
  lines: string[];
}

const tableColumnWidths = [17, 9, 8, 19] as const;
const tableRule = tableColumnWidths.map((width) => '-'.repeat(width)).join('|');
function tableRow(cells: [string, string, string, string]) {
  return cells
    .map((cell, index) => {
      const text = index ? ` ${cell}` : cell;
      const width = tableColumnWidths[index]!;
      if (text.length > width) throw Error('Fictional table text exceeds its column');
      return text.padEnd(width);
    })
    .join('|');
}

export function largeImportPage(oracle: LargeImportOracle, page: number): LargeImportPage {
  if (!Number.isSafeInteger(page) || page < 1 || page > oracle.pages)
    throw Error('Invalid fictional page');
  const report = oracle.reports[Math.floor((page - 1) / 150)]!;
  const person = oracle.people.find((person) => person.key === report.personKey)!;
  const mapping = oracle.assertions[page - 1]!.mapping;
  const lines = [
    'FICTIONAL CLINICAL REPORT - independently invented software test data',
    `Report: ${report.key}. Original page ${page} of 900.`,
    `Patient: ${person.name}. DOB: ${person.birthDate}.`,
    `Report date: ${report.date}. Report pages ${report.firstPage}-${report.lastPage}.`,
    'No real people or records. Clinical labels are literal, not terminology codes.',
    '',
  ];
  if (mapping.kind === 'observation')
    lines.push(
      `Performed laboratory observation ${mapping.testLabel} on ${mapping.date}; final.`,
      `Result: ${mapping.valueText}; unit: ${mapping.unit}; reference: ${mapping.referenceText}.`,
    );
  else if (mapping.kind === 'medication')
    lines.push(
      `Medication ORDER: ${mapping.medicationName}; recorded date: ${mapping.date}.`,
      `Dose: ${mapping.doseText}; route: ${mapping.route}; frequency: ${mapping.frequency}.`,
      'An order, not reported use or administration. Start/end dates not supplied.',
    );
  else
    lines.push(
      `Performed imaging procedure ${mapping.procedureLabel} on ${mapping.date}.`,
      'Status: completed. This procedure was performed, not merely ordered.',
    );
  if (page === 149)
    lines.push(
      '',
      'Laboratory table T-001: final performed observations, event date 2026-01-12.',
      tableRow(['Analyte', 'Result', 'Unit', 'Reference interval']),
      tableRule,
      tableRow(['FX-CROSS-001', '', '', '']),
      'This row continues on original page 150; result/unit/reference follow there.',
    );
  if (page === 150)
    lines.push(
      '',
      'Laboratory table T-001: continuation of the row from original page 149.',
      tableRow(['Analyte from p149', 'Result', 'Unit', 'Reference interval']),
      tableRule,
      tableRow(['', '<0.0030', 'unit-Y', '0.0010 - 0.0090']),
      'End of continued row. This page does not repeat the analyte label.',
    );
  lines.push('', 'No specimen, method, external record identifiers or terminology codes supplied.');
  return {
    page,
    kind: page % 2 ? 'native' : 'scan',
    reportKey: report.key,
    personKey: person.key,
    lines,
  };
}

/** Fixed Courier layout and explicit raster table columns; no hidden OCR. */
export function renderLargeImportPage(page: LargeImportPage, nativeOnly = false): FictionalPdfPage {
  const fontSize = 10,
    x = 30,
    top = 752,
    spacing = 24,
    characterWidth = fontSize * 0.6;
  const canvas = createCanvas(1224, 1584),
    context = canvas.getContext('2d');
  try {
    context.font = `${fontSize * 2}px monospace`;
    for (const [index, line] of page.lines.entries()) {
      if (
        !/^[\x20-\x7e]*$/.test(line) ||
        line.length * characterWidth > 552 ||
        (!line.includes('|') && context.measureText(line).width > 1104) ||
        top - index * spacing < 40
      )
        throw Error('Fictional clinical text exceeds its visible page bounds');
    }
    if (nativeOnly || page.kind === 'native') {
      const escape = (value: string) => value.replace(/[\\()]/g, '\\$&');
      return {
        font: 'Courier',
        content: Buffer.from(
          page.lines
            .map(
              (line, index) =>
                `BT /F1 ${fontSize} Tf ${x} ${top - index * spacing} Td (${escape(line)}) Tj ET\n`,
            )
            .join(''),
        ),
      };
    }
    context.fillStyle = '#faf9f4';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#161616';
    for (const [index, line] of page.lines.entries()) {
      const baseline = (792 - top + index * spacing) * 2;
      if (!line.includes('|')) {
        context.fillText(line, x * 2, baseline);
        continue;
      }
      // Font aliases may be proportional: position cells and separators using the
      // native Courier columns, while preserving normal readable paragraph shaping.
      let start = 0;
      for (const cell of line.split('|')) {
        const text = cell.trim();
        const width =
          (start + cell.length < line.length ? cell.length : 92 - start) * characterWidth;
        if (context.measureText(text).width > width * 2)
          throw Error('Fictional clinical table cell exceeds its visible column bounds');
        if (/^-+$/.test(text)) {
          context.beginPath();
          context.moveTo((x + start * characterWidth) * 2, baseline - fontSize);
          context.lineTo((x + (start + cell.length) * characterWidth) * 2, baseline - fontSize);
          context.strokeStyle = '#161616';
          context.stroke();
        } else context.fillText(text, (x + start * characterWidth) * 2, baseline);
        if (start + cell.length < line.length)
          context.fillText('|', (x + (start + cell.length) * characterWidth) * 2, baseline);
        start += cell.length + 1;
      }
    }
    return {
      font: 'Courier',
      content: Buffer.from('q 612 0 0 792 0 0 cm /Scan Do Q\n'),
      image: { bytes: canvas.toBuffer('image/jpeg', 90), width: 1224, height: 1584 },
    };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

/** Exclusive private outputs; clean up only files this invocation created if generation fails. */
export function writeLargeImportFixture(pdfPath: string, oraclePath: string) {
  assertFictionalOutputPath(pdfPath);
  assertFictionalOutputPath(oraclePath);
  if (resolve(pdfPath) === resolve(oraclePath))
    throw Error('PDF and oracle need distinct output paths');
  const oracle = createLargeImportOracle();
  const fd = openSync(oraclePath, 'wx', 0o600),
    identity = fstatSync(fd);
  try {
    writeFileSync(fd, JSON.stringify(oracle));
    fsyncSync(fd);
    const receipt = writeFictionalPdf(pdfPath, {
      pages: oracle.pages,
      pageAt: (page) => renderLargeImportPage(largeImportPage(oracle, page)),
    });
    return {
      ...receipt,
      format: 'circus-fictional-large-import-fixture-v1' as const,
      pages: 900,
      nativePages: 450,
      scanPages: 450,
      expectedRecords: oracle.assertions.length,
    };
  } catch (error) {
    const current = existsSync(oraclePath) ? lstatSync(oraclePath) : null;
    if (current?.ino === identity.ino && current.dev === identity.dev) rmSync(oraclePath);
    throw error;
  } finally {
    closeSync(fd);
  }
}
