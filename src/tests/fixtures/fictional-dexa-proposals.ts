import { createHash } from 'node:crypto';
import type { HealthRecordEnvelope, IntakeReportReference } from '../../shared/intake.ts';
import {
  DEXA_SOURCE_SYSTEM,
  DEXA_SUBJECT,
  FICTIONAL_DEXA_SOURCE_RESULTS,
  FICTIONAL_SURGERY_SOURCE_EVENTS,
  SURGERY_SUBJECT,
  type FictionalDexaSourceResult,
} from './fictional-dexa-source-generator.ts';

export type FictionalReportAssets = {
  standaloneDexa: string;
  zipDexaPrimary: string;
  zipDexaPrimaryMemberId: string;
  zipDexaRedundant: string;
  zipDexaRedundantMemberId: string;
  zipSurgery: string;
  zipSurgeryMemberId: string;
};

const defaultAssets: FictionalReportAssets = {
  standaloneDexa: 'fixture:standalone-dexa',
  zipDexaPrimary: 'fixture:zip-dexa-primary',
  zipDexaPrimaryMemberId: 'fixture:member-dexa-primary',
  zipDexaRedundant: 'fixture:zip-dexa-redundant',
  zipDexaRedundantMemberId: 'fixture:member-dexa-redundant',
  zipSurgery: 'fixture:zip-surgery',
  zipSurgeryMemberId: 'fixture:member-surgery',
};

function sectionPage(section: FictionalDexaSourceResult['section']) {
  return section === 'Spine' || section === 'Left hip'
    ? 1
    : section === 'Right hip' || section === 'Forearm'
      ? 2
      : 3;
}

function envelopeId(sourceRecordId: string, locator: string) {
  return `${sourceRecordId}:${createHash('sha256').update(locator).digest('hex').slice(0, 10)}`;
}

function dexaReport(result: FictionalDexaSourceResult, memberId?: string): IntakeReportReference {
  return {
    key: 'DEXA-FX-2048',
    title: 'Fictional DEXA bone density and body composition report',
    anchor: { locator: 'page 1 report heading', text: 'DEXA REPORT DEXA-FX-2048' },
    subject: { locator: 'page 1 subject line', text: `Subject: ${DEXA_SUBJECT}` },
    ...(memberId ? { memberId } : {}),
    section: {
      key: result.section.toLowerCase().replaceAll(' ', '-'),
      title: result.section,
      anchor: {
        locator: `page ${sectionPage(result.section)} section heading`,
        text: `SECTION: ${result.section}`,
      },
    },
  };
}

function dexaEnvelope(
  result: FictionalDexaSourceResult,
  locator: string,
  asset: string,
  memberId?: string,
): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id: envelopeId(result.id, locator),
    kind: 'record',
    payload: {
      reportScope: `DEXA-FX-2048 for ${DEXA_SUBJECT}`,
      sourceDateRoles: 'Ordered 2026-08-01; Performed 2026-08-14 09:40; Finalized 2026-08-15 16:20',
      printedResult: `${result.label} | ${result.valueText} ${result.unit} | category ${result.category}`,
    },
    provenance: {
      capturedVia: 'Independently fictional benchmark delivery',
      sourceSystem: DEXA_SOURCE_SYSTEM,
      sourceRecordId: result.id,
      evidenceClass: 'provider_export',
      locator,
    },
    coverage: { status: 'complete_response', notes: [] },
    report: dexaReport(result, memberId),
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: result.label,
      date: '2026-08-14T09:40',
      valueText: result.valueText,
      unit: result.unit,
      eventKind: 'performed',
      observationCategory: result.category,
      assets: [asset],
      uncertainties: [],
    },
  };
}

function surgeryEnvelope(
  event: (typeof FICTIONAL_SURGERY_SOURCE_EVENTS)[number],
  asset: string,
  memberId: string,
): HealthRecordEnvelope {
  const locator = `ZIP member person-b/surgery-summary.pdf page 1 record ${event.id}`;
  return {
    format: 'health-record-v1',
    id: envelopeId(event.id, locator),
    kind: 'record',
    payload: {
      reportScope: `SURG-FX-883 for ${SURGERY_SUBJECT}`,
      printedEvent: `${event.label} | ${event.cue} | date ${event.date}`,
    },
    provenance: {
      capturedVia: 'Independently fictional mixed-person benchmark delivery',
      sourceSystem: DEXA_SOURCE_SYSTEM,
      sourceRecordId: event.id,
      evidenceClass: 'provider_export',
      locator,
    },
    coverage: { status: 'complete_response', notes: [] },
    report: {
      key: 'SURG-FX-883',
      title: 'Fictional surgery summary',
      anchor: { locator: 'page 1 report heading', text: 'SURGERY SUMMARY SURG-FX-883' },
      subject: { locator: 'page 1 subject line', text: `Subject: ${SURGERY_SUBJECT}` },
      memberId,
    },
    clinical: {
      kind: 'procedure',
      subject: 'other',
      procedureLabel: event.label,
      procedureCategory: 'surgery',
      date: event.date,
      status: event.status,
      eventKind: event.eventKind,
      assets: [asset],
      uncertainties: [],
    },
  };
}

export function fictionalStandaloneDexaEnvelopes(
  assets: FictionalReportAssets = defaultAssets,
): HealthRecordEnvelope[] {
  return FICTIONAL_DEXA_SOURCE_RESULTS.map((result) =>
    dexaEnvelope(
      result,
      `fictional-dexa-report.pdf page ${sectionPage(result.section)} record ${result.id}`,
      assets.standaloneDexa,
    ),
  );
}

export function fictionalMixedZipEnvelopes(
  assets: FictionalReportAssets = defaultAssets,
): HealthRecordEnvelope[] {
  const primary = FICTIONAL_DEXA_SOURCE_RESULTS.map((result) =>
    dexaEnvelope(
      result,
      `ZIP member person-a/dexa-report.pdf page ${sectionPage(result.section)} record ${result.id}`,
      assets.zipDexaPrimary,
      assets.zipDexaPrimaryMemberId,
    ),
  );
  const redundant = FICTIONAL_DEXA_SOURCE_RESULTS.map((result) =>
    dexaEnvelope(
      result,
      `ZIP member redundant/person-a/dexa-report-copy.pdf page ${sectionPage(result.section)} record ${result.id}`,
      assets.zipDexaRedundant,
      assets.zipDexaRedundantMemberId,
    ),
  );
  const surgery = FICTIONAL_SURGERY_SOURCE_EVENTS.map((event) =>
    surgeryEnvelope(event, assets.zipSurgery, assets.zipSurgeryMemberId),
  );
  return [...primary, ...redundant, ...surgery];
}

export function fictionalAllReportEnvelopes(assets: FictionalReportAssets = defaultAssets) {
  return [...fictionalStandaloneDexaEnvelopes(assets), ...fictionalMixedZipEnvelopes(assets)];
}
