import type { OpticalPrescription } from '../../shared/vision.ts';

export type ExpectedOpticalRecord = {
  source: 'image' | 'pdf';
  sourceRecordId: string;
  sourceSystem: string;
  filename: string;
  documentTitle: string;
  reviewedDate: string;
  prescription: OpticalPrescription;
};

// This oracle is deliberately independent from the source renderer and the
// controlled proposal fixture. Changes to either must be reviewed against these
// literal expected values rather than regenerating truth from implementation data.
export const EXPECTED_OPTICAL_RECORDS: ExpectedOpticalRecord[] = [
  {
    source: 'image',
    sourceRecordId: 'cobalt-rx-4726',
    sourceSystem: 'Cobalt Harbor Optometry',
    filename: 'fictional-cobalt-optical-prescription.jpg',
    documentTitle: 'Cobalt Harbor spectacle prescription CH-RX-4726',
    reviewedDate: '2026-04-05',
    prescription: {
      type: 'spectacle',
      prescribedDateText: '04/05/26',
      expiresDateText: '04/05/28',
      eyes: [
        {
          side: 'right',
          sideText: 'OD',
          sph: { valueText: '+1.75' },
          cyl: { valueText: '-0.50' },
          axis: { valueText: '007' },
        },
        {
          side: 'left',
          sideText: 'OS',
          sph: { valueText: '+1.25' },
          cyl: { valueText: '-0.25' },
          axis: { valueText: '092' },
        },
      ],
      pd: { valueText: '061.5', unit: 'mm' },
      notes: 'SPH/CYL units not printed; numeric dates require review.',
    },
  },
  {
    source: 'pdf',
    sourceRecordId: 'sunward-rx-1182',
    sourceSystem: 'Sunward Optical Studio',
    filename: 'fictional-sunward-optical-prescription.pdf',
    documentTitle: 'Sunward spectacle prescription SUN-RX-1182',
    reviewedDate: '2026-11-08',
    prescription: {
      type: 'spectacle',
      prescribedDateText: '2026-11-08',
      expiresDateText: '2028-11-08',
      eyes: [
        {
          side: 'right',
          sideText: 'OD',
          sph: { valueText: '-2.25' },
          cyl: { valueText: '-1.00' },
          axis: { valueText: '003' },
          add: { valueText: '+1.50' },
        },
        {
          side: 'left',
          sideText: 'OS',
          sph: { valueText: '-1.75' },
          cyl: { valueText: '-0.75' },
          axis: { valueText: '178' },
          add: { valueText: '+1.50' },
        },
      ],
      pd: { valueText: '064', unit: 'mm' },
      notes: 'SPH/CYL units not printed.',
    },
  },
];

export function evaluateOpticalGroundTruth(
  actual: Array<{
    title: string;
    date: string | null;
    provider: string | null;
    sourceRecordId: string;
    opticalPrescription: OpticalPrescription;
    evidence: Array<{ locator: unknown }>;
  }>,
) {
  const failures: string[] = [];
  for (const expected of EXPECTED_OPTICAL_RECORDS) {
    const matches = actual.filter((record) => record.title === expected.documentTitle);
    if (matches.length !== 1) {
      failures.push(
        `${expected.sourceRecordId}: expected one accepted Vision record, received ${matches.length}`,
      );
      continue;
    }
    const record = matches[0]!;
    if (record.title !== expected.documentTitle)
      failures.push(`${expected.sourceRecordId}: document title differs`);
    if (record.date !== expected.reviewedDate)
      failures.push(`${expected.sourceRecordId}: reviewed date differs`);
    if (record.provider !== expected.sourceSystem)
      failures.push(`${expected.sourceRecordId}: original issuer attribution differs`);
    if (JSON.stringify(record.opticalPrescription) !== JSON.stringify(expected.prescription))
      failures.push(`${expected.sourceRecordId}: literal optical fields differ`);
    if (
      !record.evidence.some((evidence) =>
        JSON.stringify(evidence.locator).includes(expected.filename),
      )
    )
      failures.push(`${expected.sourceRecordId}: source locator does not name the original`);
  }
  for (const record of actual)
    if (!EXPECTED_OPTICAL_RECORDS.some((expected) => expected.documentTitle === record.title))
      failures.push(`${record.sourceRecordId}: unexpected extra Vision record`);
  return { ok: failures.length === 0, failures };
}
