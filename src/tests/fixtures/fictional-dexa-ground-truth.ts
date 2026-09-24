export const FICTIONAL_REPORT_SOURCE_SYSTEM = 'Juniper Ridge Imaging Sandbox';

type ExpectedDexaResult = {
  sourceRecordId: string;
  testLabel: string;
  valueText: string;
  unit: string;
  observationCategory: 'bone_density' | 'body_composition';
};

// This known answer is intentionally independent from the source renderer and
// controlled proposal builder. A source or proposal change must be reviewed
// against these 28 explicitly enumerated expected results.
export const EXPECTED_DEXA_RESULTS: ExpectedDexaResult[] = [
  {
    sourceRecordId: 'dexa-l1-bmd',
    testLabel: 'L1 bone mineral density',
    valueText: '0.912',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-l2-bmd',
    testLabel: 'L2 bone mineral density',
    valueText: '0.945',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-l3-bmd',
    testLabel: 'L3 bone mineral density',
    valueText: '0.988',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-l4-bmd',
    testLabel: 'L4 bone mineral density',
    valueText: '1.021',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-spine-total-bmd',
    testLabel: 'Lumbar spine total bone mineral density',
    valueText: '0.968',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-spine-t-score',
    testLabel: 'Lumbar spine T-score',
    valueText: '-1.2',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-spine-z-score',
    testLabel: 'Lumbar spine Z-score',
    valueText: '-0.4',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-neck-bmd',
    testLabel: 'Left femoral neck bone mineral density',
    valueText: '0.742',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-total-bmd',
    testLabel: 'Left total hip bone mineral density',
    valueText: '0.811',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-neck-t-score',
    testLabel: 'Left femoral neck T-score',
    valueText: '-1.6',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-total-t-score',
    testLabel: 'Left total hip T-score',
    valueText: '-1.1',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-neck-z-score',
    testLabel: 'Left femoral neck Z-score',
    valueText: '-0.7',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-left-total-z-score',
    testLabel: 'Left total hip Z-score',
    valueText: '-0.4',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-neck-bmd',
    testLabel: 'Right femoral neck bone mineral density',
    valueText: '0.756',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-total-bmd',
    testLabel: 'Right total hip bone mineral density',
    valueText: '0.824',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-neck-t-score',
    testLabel: 'Right femoral neck T-score',
    valueText: '-1.5',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-total-t-score',
    testLabel: 'Right total hip T-score',
    valueText: '-1.0',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-neck-z-score',
    testLabel: 'Right femoral neck Z-score',
    valueText: '-0.6',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-right-total-z-score',
    testLabel: 'Right total hip Z-score',
    valueText: '-0.3',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-radius-bmd',
    testLabel: 'One-third radius bone mineral density',
    valueText: '0.689',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-radius-t-score',
    testLabel: 'One-third radius T-score',
    valueText: '-0.8',
    unit: 'T-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-radius-z-score',
    testLabel: 'One-third radius Z-score',
    valueText: '+0.1',
    unit: 'Z-score',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-total-body-bmd',
    testLabel: 'Total body bone mineral density',
    valueText: '1.087',
    unit: 'g/cm2',
    observationCategory: 'bone_density',
  },
  {
    sourceRecordId: 'dexa-lean-mass',
    testLabel: 'Total lean mass',
    valueText: '42.37',
    unit: 'kg',
    observationCategory: 'body_composition',
  },
  {
    sourceRecordId: 'dexa-fat-mass',
    testLabel: 'Total fat mass',
    valueText: '18.62',
    unit: 'kg',
    observationCategory: 'body_composition',
  },
  {
    sourceRecordId: 'dexa-body-fat',
    testLabel: 'Total body fat',
    valueText: '29.8',
    unit: '%',
    observationCategory: 'body_composition',
  },
  {
    sourceRecordId: 'dexa-android-gynoid',
    testLabel: 'Android to gynoid fat ratio',
    valueText: '0.78',
    unit: 'ratio',
    observationCategory: 'body_composition',
  },
  {
    sourceRecordId: 'dexa-visceral-area',
    testLabel: 'Visceral adipose tissue area',
    valueText: '64.3',
    unit: 'cm2',
    observationCategory: 'body_composition',
  },
];

const dexaSources = [
  {
    assetKey: 'standaloneDexa',
    assetRefs: ['fixture:standalone-dexa'],
    assetNames: ['fictional-dexa-report.pdf'],
    primary: true,
    locatorTokens: ['fictional-dexa-report.pdf', 'page'],
  },
  {
    assetKey: 'zipDexaPrimary',
    assetRefs: ['fixture:zip-dexa-primary'],
    assetNames: ['dexa-report.pdf'],
    primary: true,
    locatorTokens: ['ZIP member', 'person-a/dexa-report.pdf', 'page'],
  },
  {
    assetKey: 'zipDexaRedundant',
    assetRefs: ['fixture:zip-dexa-redundant'],
    assetNames: ['dexa-report-copy.pdf'],
    primary: true,
    locatorTokens: ['ZIP member', 'redundant/person-a/dexa-report-copy.pdf', 'page'],
  },
];

const dexaRecords = EXPECTED_DEXA_RESULTS.map((result) => ({
  sourceRecordId: result.sourceRecordId,
  expected: {
    kind: 'observation',
    subject: 'self',
    testLabel: result.testLabel,
    date: '2026-08-14T09:40',
    valueText: result.valueText,
    unit: result.unit,
    eventKind: 'performed',
    observationCategory: result.observationCategory,
  },
  expectedOccurrences: 3,
  sources: dexaSources,
  literalPaths: ['date', 'valueText', 'unit'],
  classificationPaths: ['kind', 'eventKind', 'observationCategory'],
  payloadFacts: [
    { label: 'report scope', tokens: ['DEXA-FX-2048', 'Fern Example'] },
    { label: 'order date role', tokens: ['ordered', '2026-08-01'] },
    { label: 'performed date role', tokens: ['performed', '2026-08-14', '09:40'] },
    { label: 'final date role', tokens: ['finalized', '2026-08-15', '16:20'] },
  ],
}));

const procedureRecords = [
  {
    sourceRecordId: 'surgery-left-ankle-performed',
    expected: {
      kind: 'procedure',
      subject: 'other',
      procedureLabel: 'Left ankle arthroscopy',
      procedureCategory: 'surgery',
      date: '2026-07-02',
      status: 'completed',
      eventKind: 'performed',
    },
    cue: ['PERFORMED AND COMPLETED'],
  },
  {
    sourceRecordId: 'surgery-right-shoulder-order',
    expected: {
      kind: 'procedure',
      subject: 'other',
      procedureLabel: 'Right shoulder arthroscopy',
      procedureCategory: 'surgery',
      date: '2026-10-19',
      status: 'planned',
      eventKind: 'order',
    },
    cue: ['ORDER ONLY', 'NOT PERFORMED'],
  },
].map((record) => ({
  sourceRecordId: record.sourceRecordId,
  expected: record.expected,
  sources: [
    {
      assetKey: 'zipSurgery',
      assetRefs: ['fixture:zip-surgery'],
      assetNames: ['surgery-summary.pdf'],
      primary: true,
      locatorTokens: ['ZIP member', 'person-b/surgery-summary.pdf', 'page'],
    },
  ],
  literalPaths: ['date'],
  classificationPaths: ['kind', 'procedureCategory', 'status', 'eventKind'],
  payloadFacts: [
    { label: 'other subject report scope', tokens: ['SURG-FX-883', 'Rowan Ember'] },
    { label: 'performed versus order cue', tokens: record.cue },
  ],
}));

export const FICTIONAL_REPORT_GROUND_TRUTH = {
  fixture: 'circus-fictional-dexa-v1',
  sourceSystem: FICTIONAL_REPORT_SOURCE_SYSTEM,
  unsupportedSourceRecordIds: [] as string[],
  excludedSourceRecordIds: [] as string[],
  records: [...dexaRecords, ...procedureRecords],
};

export const FICTIONAL_DEXA_ACCEPTED_GROUND_TRUTH = {
  ...FICTIONAL_REPORT_GROUND_TRUTH,
  records: dexaRecords,
};
