import type { HealthRecordEnvelope } from '../../shared/intake.ts';

type OpticalSource = {
  source: 'image' | 'pdf';
  sourceFileId: string;
  filename: string;
};

// These proposals model a deterministic image-capable provider response. They
// are hand-authored separately from the source generator and acceptance oracle;
// no real model inference is claimed by this controlled fixture.
export function controlledOpticalProposal(input: OpticalSource): HealthRecordEnvelope {
  if (input.source === 'image')
    return {
      format: 'health-record-v1',
      id: 'controlled-cobalt-optical',
      kind: 'document',
      payload: {
        literal:
          'Mara Solace; 04/05/26; OD +1.75 -0.50 x 007; OS +1.25 -0.25 x 092; PD 061.5 mm; SPH/CYL units not printed.',
      },
      clinical: {
        kind: 'document',
        subject: 'unknown',
        documentTitle: 'Cobalt Harbor spectacle prescription CH-RX-4726',
        text: 'Independently fictional spectacle prescription CH-RX-4726.',
        opticalPrescription: {
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
        assets: [input.sourceFileId],
      },
      reviewIssues: [
        {
          kind: 'date',
          field: 'date',
          prompt: 'Choose the literal interpretation of 04/05/26.',
          textAnchor: '04/05/26',
          choices: [
            { label: 'April 5, 2026', value: '2026-04-05' },
            { label: 'May 4, 2026', value: '2026-05-04' },
          ],
        },
      ],
      provenance: {
        capturedVia: 'Controlled image-capable provider fixture',
        sourceSystem: 'Cobalt Harbor Optometry',
        sourceRecordId: 'cobalt-rx-4726',
        evidenceClass: 'provider_export',
        locator: `${input.filename} full image`,
      },
      coverage: {
        status: 'complete_response',
        notes: ['Controlled fixture inspected the only image; host acceptance remains reviewed.'],
      },
    };
  return {
    format: 'health-record-v1',
    id: 'controlled-sunward-optical',
    kind: 'document',
    payload: {
      literal:
        'Elian Frost; 2026-11-08; OD -2.25 -1.00 x 003 add +1.50; OS -1.75 -0.75 x 178 add +1.50; PD 064 mm; SPH/CYL units not printed.',
    },
    clinical: {
      kind: 'document',
      subject: 'unknown',
      date: '2026-11-08',
      documentDate: '2026-11-08',
      documentTitle: 'Sunward spectacle prescription SUN-RX-1182',
      text: 'Independently fictional spectacle prescription SUN-RX-1182.',
      opticalPrescription: {
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
      assets: [input.sourceFileId],
    },
    reviewIssues: [
      {
        kind: 'date',
        field: 'date',
        prompt: 'Confirm the unambiguous printed prescription date.',
        textAnchor: '2026-11-08',
        page: 1,
        choices: [{ label: 'November 8, 2026', value: '2026-11-08' }],
      },
    ],
    provenance: {
      capturedVia: 'Controlled image-capable provider fixture',
      sourceSystem: 'Sunward Optical Studio',
      sourceRecordId: 'sunward-rx-1182',
      evidenceClass: 'provider_export',
      locator: `${input.filename} page 1`,
    },
    coverage: {
      status: 'complete_response',
      notes: ['Controlled fixture inspected the only PDF page; host acceptance remains reviewed.'],
    },
  };
}
