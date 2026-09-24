import { createHash } from 'node:crypto';
import type { HealthRecordEnvelope, IntakeReportReference } from '../../shared/intake.ts';
import {
  CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR,
  CLINICAL_CONFORMANCE_AMBIGUOUS_RESULTS,
  CLINICAL_CONFORMANCE_BARE_DATE_LINE,
  CLINICAL_CONFORMANCE_CONTROL_LINE,
  CLINICAL_CONFORMANCE_CURRENT_DATE,
  CLINICAL_CONFORMANCE_MODALITY,
  CLINICAL_CONFORMANCE_MODALITY_LINE,
  CLINICAL_CONFORMANCE_PRIOR_DATE,
  CLINICAL_CONFORMANCE_PROCEDURES,
  CLINICAL_CONFORMANCE_REPEATED_RESULTS,
  CLINICAL_CONFORMANCE_REPORT_KEY,
  CLINICAL_CONFORMANCE_SOURCE_SYSTEM,
  CLINICAL_CONFORMANCE_STACKED_RESULTS,
  CLINICAL_CONFORMANCE_SUBJECT,
  CLINICAL_CONFORMANCE_TITLE_LINE,
} from './fictional-clinical-conformance-source-generator.ts';
import { FICTIONAL_CLINICAL_CONFORMANCE_ASSET } from './fictional-clinical-conformance-ground-truth.ts';

const contextId = 'fictional-clinical-conformance-context';
const filename = 'fictional-clinical-conformance-report.pdf';

const envelopeId = (key: string, locator: string) =>
  `${key}:${createHash('sha256').update(locator).digest('hex').slice(0, 10)}`;

function report(
  page: number,
  section?: { title: string; anchorText: string },
): IntakeReportReference {
  return {
    key: CLINICAL_CONFORMANCE_REPORT_KEY,
    title: 'Fictional prism scan results',
    anchor: {
      locator: `${filename} page 1 report heading`,
      text: CLINICAL_CONFORMANCE_TITLE_LINE,
    },
    subject: {
      locator: `${filename} page 1 subject line`,
      text: `Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
    },
    ...(section
      ? {
          section: {
            key: section.title.toLowerCase().replaceAll(' ', '-'),
            title: section.title,
            anchor: {
              locator: `${filename} page ${page} section ${section.title}`,
              text: section.anchorText,
            },
          },
        }
      : {}),
  };
}

function provenance(sourceRecordId: string | null, locator: string) {
  return {
    capturedVia: 'Independently fictional clinical conformance fixture',
    sourceSystem: CLINICAL_CONFORMANCE_SOURCE_SYSTEM,
    sourceRecordId,
    evidenceClass: 'provider_export' as const,
    locator,
  };
}

function repeatedEnvelope(
  result: (typeof CLINICAL_CONFORMANCE_REPEATED_RESULTS)[number],
  page: number,
): HealthRecordEnvelope {
  const locator = `${filename} page ${page} measured result ${result.label}`;
  return {
    format: 'health-record-v1',
    id: envelopeId(`repeated-${page}-${result.label}`, locator),
    kind: 'record',
    contextId,
    payload: {
      reportScope: `${CLINICAL_CONFORMANCE_REPORT_KEY} for Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
      reportTitle: CLINICAL_CONFORMANCE_TITLE_LINE,
      panel:
        'PATIENT MEASURED RESULTS - these are measured results, not demographics or reference rows',
      printedResult: `${result.label} | ${result.valueText} ${result.unit}`,
      dateSupport: 'No date is supplied for this measured-results panel.',
    },
    provenance: provenance(null, locator),
    coverage: { status: 'complete_response', notes: [] },
    report: report(page, {
      title: 'Patient measured results',
      anchorText: 'PATIENT MEASURED RESULTS',
    }),
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      testLabel: result.label,
      valueText: result.valueText,
      unit: result.unit,
      assets: [FICTIONAL_CLINICAL_CONFORMANCE_ASSET],
      uncertainties: [],
    },
  };
}

function stackedEnvelope(
  result: (typeof CLINICAL_CONFORMANCE_STACKED_RESULTS)[number],
  index: number,
): HealthRecordEnvelope {
  const locator = `${filename} page 2 record ${result.id}`;
  const date =
    index % 2 === 0 ? CLINICAL_CONFORMANCE_CURRENT_DATE : CLINICAL_CONFORMANCE_PRIOR_DATE;
  return {
    format: 'health-record-v1',
    id: envelopeId(result.id, locator),
    kind: 'record',
    contextId,
    payload: {
      reportScope: `${CLINICAL_CONFORMANCE_REPORT_KEY} for Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
      reportTitle: CLINICAL_CONFORMANCE_TITLE_LINE,
      dateRoles: `COLUMN ORDER: CURRENT (${CLINICAL_CONFORMANCE_CURRENT_DATE}), PRIOR (${CLINICAL_CONFORMANCE_PRIOR_DATE}); page 2 continues CURRENT, then PRIOR`,
      resultDomain: 'RESULT DOMAIN TOKEN: body_composition',
      modality: CLINICAL_CONFORMANCE_MODALITY_LINE,
      printedResult: `${result.id} | ${result.label} | ${result.valueText} fictional units`,
    },
    provenance: provenance(result.id, locator),
    coverage: { status: 'complete_response', notes: [] },
    report: report(2, {
      title: 'Dated table continuation',
      anchorText: 'DATED TABLE CONTINUATION',
    }),
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      testLabel: result.label,
      date,
      valueText: result.valueText,
      unit: 'fictional units',
      observationCategory: 'body_composition',
      method: CLINICAL_CONFORMANCE_MODALITY,
      assets: [FICTIONAL_CLINICAL_CONFORMANCE_ASSET],
      uncertainties: [],
    },
  };
}

function ambiguousEnvelope(
  result: (typeof CLINICAL_CONFORMANCE_AMBIGUOUS_RESULTS)[number],
): HealthRecordEnvelope {
  const locator = `${filename} page 3 record ${result.id}`;
  return {
    format: 'health-record-v1',
    id: envelopeId(result.id, locator),
    kind: 'record',
    contextId,
    payload: {
      reportScope: `${CLINICAL_CONFORMANCE_REPORT_KEY} for Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
      reportTitle: CLINICAL_CONFORMANCE_TITLE_LINE,
      resultDomain: 'RESULT DOMAIN TOKEN: body_composition',
      modality: CLINICAL_CONFORMANCE_MODALITY_LINE,
      ambiguity: CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR,
      printedResult: `${result.id} | ${result.label} | ${result.valueText} fictional units`,
    },
    provenance: provenance(result.id, locator),
    coverage: { status: 'complete_response', notes: [] },
    report: report(3, {
      title: 'Ambiguous appendix',
      anchorText: 'AMBIGUOUS APPENDIX',
    }),
    reviewIssues: [
      {
        id: `date-${result.id}`,
        kind: 'date',
        field: 'date',
        prompt: 'The appendix does not establish which table date applies to this result.',
        textAnchor: CLINICAL_CONFORMANCE_AMBIGUITY_ANCHOR,
        page: 3,
        choices: [],
      },
    ],
    clinical: {
      kind: 'observation',
      subject: 'unknown',
      eventKind: 'performed',
      testLabel: result.label,
      valueText: result.valueText,
      unit: 'fictional units',
      observationCategory: 'body_composition',
      method: CLINICAL_CONFORMANCE_MODALITY,
      assets: [FICTIONAL_CLINICAL_CONFORMANCE_ASSET],
      uncertainties: [],
    },
  };
}

function procedureEnvelope(
  procedure: (typeof CLINICAL_CONFORMANCE_PROCEDURES)[number],
): HealthRecordEnvelope {
  const locator = `${filename} page 4 record ${procedure.id}`;
  const printedEvent =
    procedure.eventKind === 'performed'
      ? `${procedure.label} was performed for Subject: ${CLINICAL_CONFORMANCE_SUBJECT} | date ${procedure.date}`
      : `HISTORY ONLY: prior ${procedure.label} for Subject: ${CLINICAL_CONFORMANCE_SUBJECT} is mentioned | date ${procedure.date}`;
  return {
    format: 'health-record-v1',
    id: envelopeId(procedure.id, locator),
    kind: 'record',
    contextId,
    payload: {
      reportScope: `${CLINICAL_CONFORMANCE_REPORT_KEY} for Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
      reportTitle: CLINICAL_CONFORMANCE_TITLE_LINE,
      procedureCategory: 'PROCEDURE CATEGORY TOKEN: imaging',
      printedEvent,
    },
    provenance: provenance(procedure.id, locator),
    coverage: { status: 'complete_response', notes: [] },
    report: report(4, {
      title: 'Procedure timeline',
      anchorText: 'PROCEDURE TIMELINE',
    }),
    clinical: {
      kind: 'procedure',
      subject: 'unknown',
      eventKind: procedure.eventKind,
      procedureLabel: procedure.label,
      procedureCategory: 'imaging',
      date: procedure.date,
      assets: [FICTIONAL_CLINICAL_CONFORMANCE_ASSET],
      uncertainties: [],
    },
  };
}

export function fictionalClinicalConformanceContext(): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id: contextId,
    kind: 'context',
    contextId,
    payload: {
      title: CLINICAL_CONFORMANCE_TITLE_LINE,
      subject: `Subject: ${CLINICAL_CONFORMANCE_SUBJECT}`,
      reportKey: CLINICAL_CONFORMANCE_REPORT_KEY,
      resultDomain: 'RESULT DOMAIN TOKEN: body_composition',
      modality: CLINICAL_CONFORMANCE_MODALITY_LINE,
      noProcedureControls: [CLINICAL_CONFORMANCE_CONTROL_LINE, CLINICAL_CONFORMANCE_BARE_DATE_LINE],
    },
    provenance: provenance(null, `${filename} pages 1-4 report context`),
    coverage: {
      status: 'partial',
      notes: ['Shared context is separate from the sixteen clinical occurrences.'],
    },
    report: report(1),
  };
}

export function fictionalClinicalConformanceEnvelopes(): HealthRecordEnvelope[] {
  return [
    fictionalClinicalConformanceContext(),
    ...[1, 2, 3, 4].flatMap((page) =>
      CLINICAL_CONFORMANCE_REPEATED_RESULTS.map((result) => repeatedEnvelope(result, page)),
    ),
    ...CLINICAL_CONFORMANCE_STACKED_RESULTS.map(stackedEnvelope),
    ...CLINICAL_CONFORMANCE_AMBIGUOUS_RESULTS.map(ambiguousEnvelope),
    ...CLINICAL_CONFORMANCE_PROCEDURES.map(procedureEnvelope),
  ];
}
