export const FICTIONAL_CLINICAL_CONFORMANCE_ASSET = 'fixture:fictional-clinical-conformance-report';

export const FICTIONAL_CLINICAL_CONFORMANCE_REPEATED = [
  {
    testLabel: 'Fictional measured reach',
    valueText: '17.4',
    unit: 'fictional spans',
  },
  {
    testLabel: 'Fictional measured balance',
    valueText: '+3.2',
    unit: 'fictional marks',
  },
] as const;

const observations = [
  {
    sourceRecordId: 'fx-stack-a1',
    testLabel: 'Fictional composition marker A',
    valueText: '+1.25',
    date: '2041-04-05',
    page: 2,
  },
  {
    sourceRecordId: 'fx-stack-a2',
    testLabel: 'Fictional composition marker A',
    valueText: '+1.10',
    date: '2040-04-06',
    page: 2,
  },
  {
    sourceRecordId: 'fx-stack-b1',
    testLabel: 'Fictional composition marker B',
    valueText: '42.8',
    date: '2041-04-05',
    page: 2,
  },
  {
    sourceRecordId: 'fx-stack-b2',
    testLabel: 'Fictional composition marker B',
    valueText: '41.9',
    date: '2040-04-06',
    page: 2,
  },
  {
    sourceRecordId: 'fx-appendix-a',
    testLabel: 'Fictional appendix marker',
    valueText: '2.10',
    date: null,
    page: 3,
  },
  {
    sourceRecordId: 'fx-appendix-b',
    testLabel: 'Fictional appendix marker',
    valueText: '2.00',
    date: null,
    page: 3,
  },
] as const;

const source = (page: number, sourceRecordId: string) => [
  {
    assetKey: 'conformancePdf',
    assetRefs: [FICTIONAL_CLINICAL_CONFORMANCE_ASSET],
    assetNames: ['fictional-clinical-conformance-report.pdf'],
    primary: true,
    locatorTokens: ['fictional-clinical-conformance-report.pdf', `page ${page}`, sourceRecordId],
  },
];

const observationRecords = observations.map((record) => ({
  sourceRecordId: record.sourceRecordId,
  expected: {
    kind: 'observation',
    subject: 'unknown',
    testLabel: record.testLabel,
    date: record.date,
    valueText: record.valueText,
    unit: 'fictional units',
    eventKind: 'performed',
    observationCategory: 'body_composition',
    method: 'Fictional prism absorptiometry',
  },
  sources: source(record.page, record.sourceRecordId),
  literalPaths: ['date', 'valueText', 'unit', 'method'],
  classificationPaths: ['kind', 'eventKind', 'observationCategory'],
  payloadFacts: [
    { label: 'report subject', tokens: ['CLIN-FX-4107', 'Saffron Example'] },
    { label: 'result-domain role', tokens: ['RESULT DOMAIN TOKEN', 'body_composition'] },
    { label: 'modality role', tokens: ['ACQUISITION MODALITY', 'Fictional prism absorptiometry'] },
  ],
  ...(record.page === 3
    ? {
        issue: {
          kind: 'date',
          field: 'date',
          textAnchor:
            'APPENDIX ORDER: the two values have no stated current/prior order and do not continue page 1',
          choices: [] as Array<{ value: unknown }>,
        },
      }
    : {}),
}));

const procedureRecords = [
  {
    sourceRecordId: 'fx-procedure-current',
    expected: {
      kind: 'procedure',
      subject: 'unknown',
      procedureLabel: 'Fictional prism scan',
      procedureCategory: 'imaging',
      date: '2041-04-05',
      eventKind: 'performed',
    },
    cue: ['performed for Subject: Saffron Example'],
  },
  {
    sourceRecordId: 'fx-procedure-history',
    expected: {
      kind: 'procedure',
      subject: 'unknown',
      procedureLabel: 'Fictional arc scan',
      procedureCategory: 'imaging',
      date: '2039-03-04',
      eventKind: 'historical_mention',
    },
    cue: ['HISTORY ONLY', 'is mentioned'],
  },
].map((record) => ({
  sourceRecordId: record.sourceRecordId,
  expected: record.expected,
  sources: source(4, record.sourceRecordId),
  literalPaths: ['date'],
  classificationPaths: ['kind', 'procedureCategory', 'eventKind'],
  payloadFacts: [
    { label: 'report subject', tokens: ['CLIN-FX-4107', 'Saffron Example'] },
    { label: 'procedure role', tokens: record.cue },
  ],
}));

export const FICTIONAL_CLINICAL_CONFORMANCE_STABLE_IDS = [
  ...observations.map((record) => record.sourceRecordId),
  ...procedureRecords.map((record) => record.sourceRecordId),
] as const;

export const FICTIONAL_CLINICAL_CONFORMANCE_GROUND_TRUTH = {
  fixture: 'circus-fictional-clinical-conformance-v1',
  sourceSystem: 'Northstar Fictional Metrics Sandbox',
  unsupportedSourceRecordIds: [] as string[],
  excludedSourceRecordIds: [] as string[],
  records: [...observationRecords, ...procedureRecords],
};
