import { IMPORT_GROUND_TRUTH } from './import-ground-truth.ts';

type DataObject = Record<string, unknown>;
interface Mapping extends DataObject {}
interface ActualRow extends DataObject {
  extra?: { import?: { acceptedMapping?: Mapping; originalMapping?: Mapping } };
  provenance?: DataObject;
  clinical?: Mapping;
  mapping?: Mapping;
  asset?: DataObject;
}
interface SourceExpectation {
  assetKey: string;
  assetNames?: string[];
  assetRefs?: string[];
  primary?: boolean;
  locatorTokens: string[];
}
interface IssueExpectation {
  kind: string;
  field: string;
  textAnchor: string;
  choices: Array<{ value: unknown }>;
}
interface RecordExpectation {
  sourceRecordId: string;
  expected: DataObject;
  sources: SourceExpectation[];
  expectedOccurrences?: number;
  literalPaths?: string[];
  classificationPaths?: string[];
  forbiddenPaths?: string[];
  optionalPaths?: string[];
  optionalExpectedPaths?: string[];
  supportedFields?: Record<string, unknown[] | undefined>;
  fieldAlternatives?: Record<string, unknown[] | undefined>;
  payloadFacts?: Array<{ label: string; tokens?: string[]; alternatives?: string[][] }>;
  minimumAssets?: number;
  issue?: IssueExpectation;
}
interface GroundTruth {
  fixture: string;
  sourceSystem: string;
  records: RecordExpectation[];
  unsupportedSourceRecordIds: string[];
  excludedSourceRecordIds?: string[];
}
type AssetBindings = Record<string, unknown>;
interface EvaluationOptions {
  truth?: GroundTruth;
  stage?: 'proposal' | 'accepted';
  assetBindings?: AssetBindings;
}
interface Evidence {
  locator: unknown;
  contentUrl: unknown;
  sourceFileId: unknown;
}
type Candidate = ReturnType<typeof candidate>;

const object = (value: unknown): value is DataObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown): ActualRow[] =>
  (Array.isArray(value)
    ? value
    : Array.isArray((value as DataObject)?.data)
      ? (value as DataObject).data
      : []) as ActualRow[];

function get(value: unknown, path: string): unknown {
  return path.split('.').reduce((current, key) => (current as DataObject)?.[key], value);
}

function equal(expected: unknown, actual: unknown) {
  if (expected === null) return actual == null || actual === '';
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function queryMapping(row: ActualRow, kind: unknown): Mapping {
  const retained = row.extra?.import?.acceptedMapping || row.extra?.import?.originalMapping;
  if (object(retained)) return retained;
  if (kind === 'observation')
    return {
      kind,
      subject: 'self',
      testLabel: row.testLabel || row.label,
      date: row.date ?? row.effective_at,
      valueText: row.valueText ?? row.value_text,
      unit: row.unit,
      referenceText: row.referenceText,
      eventKind: row.eventKind,
    };
  if (kind === 'medication')
    return {
      kind,
      subject: 'self',
      medicationName: row.medicationName || row.label,
      medicationKind: row.medicationKind || row.kind,
      dateRole: row.dateRole,
      date: row.date || row.sourceRecordedDate,
      doseText: row.doseText ?? row.dose_text,
      route: row.route,
      frequency: row.frequency,
      status: row.status,
      eventKind: row.eventKind,
    };
  if (kind === 'procedure')
    return {
      kind,
      subject: 'self',
      procedureLabel: row.procedureLabel || row.label,
      procedureCategory: row.procedureCategory || row.category,
      date: row.date ?? row.effective_at,
      status: row.status,
      eventKind: row.eventKind,
    };
  return {
    kind: 'document',
    subject: 'self',
    documentTitle: row.documentTitle || row.title,
    documentDate: row.documentDate || row.date || row.effective_at,
    date: row.date || row.effective_at,
    documentCategory: row.documentCategory,
    visitSpecialty: row.visitSpecialty,
    opticalPrescription: row.opticalPrescription,
    eventKind: row.eventKind,
  };
}

function contentSourceId(url: unknown) {
  const match = String(url || '').match(/\/api\/sources\/([^/]+)\/content(?:$|[?#])/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function evidenceOf(row: ActualRow) {
  const evidence: Evidence[] = [];
  const add = (locator: unknown, contentUrl: unknown, sourceFileId: unknown) => {
    const locatorObject = object(locator) ? locator : null;
    evidence.push({
      locator: locatorObject?.locator || locator,
      contentUrl,
      sourceFileId:
        sourceFileId || locatorObject?.originalSourceFileId || contentSourceId(contentUrl),
    });
  };
  if (row.provenance?.locator)
    add(
      row.provenance.locator,
      row.provenance.contentUrl,
      row.provenance.sourceFileId || row.provenance.originalSourceFileId,
    );
  for (const item of rows(row.evidence))
    add(item.locator || item.label || item.path, item.contentUrl || item.url, item.sourceFileId);
  return evidence;
}

function sourceIdOf(row: ActualRow, mapping: Mapping) {
  return (
    row.provenance?.sourceRecordId ||
    mapping.sourceRecordId ||
    row.providerSourceRecordId ||
    row.extra?.import?.acceptedMapping?.sourceRecordId ||
    row.extra?.import?.originalMapping?.sourceRecordId ||
    null
  );
}

function candidate(row: ActualRow, kind?: string) {
  const mapping = object(row.clinical)
    ? row.clinical
    : object(row.mapping)
      ? row.mapping
      : row.format === 'health-record-v1'
        ? {}
        : queryMapping(row, kind || row.kind);
  return {
    mapping,
    payload: row.payload ?? null,
    sourceRecordId: sourceIdOf(row, mapping),
    sourceSystem: row.provenance?.sourceSystem || mapping.sourceSystem || row.provider || null,
    evidence: evidenceOf(row),
    assets: rows(mapping.assets).filter(Boolean),
    attachments: rows(row.attachments).map((item) => ({
      caption: item.caption || item.locator || null,
      originalName: item.asset?.originalName || item.originalName || null,
      sourceFileId: item.asset?.sourceFileId || item.sourceFileId || null,
      contentUrl: item.asset?.contentUrl || item.contentUrl || null,
    })),
    issues: rows(row.reviewIssues || row.clinical?.reviewIssues || row.issues),
    currentStatus: row.currentStatus || row.current_status || null,
    raw: row,
  };
}

function tableCandidates(value: DataObject) {
  return [
    ...rows(value.observations).map((row) => candidate(row, 'observation')),
    ...rows(value.medications).map((row) => candidate(row, 'medication')),
    ...rows(value.procedures).map((row) => candidate(row, 'procedure')),
    ...rows(value.documents).map((row) => candidate(row, 'document')),
  ];
}

function selectActual(input: unknown, stage: 'proposal' | 'accepted') {
  const actual = input as DataObject;
  if (stage === 'accepted') {
    const selected = (actual.accepted || actual.queries || actual) as DataObject;
    const tabular = tableCandidates(selected);
    if (tabular.length) return tabular;
    return rows(selected.records || selected).map((row) => candidate(row));
  }
  const selected = (actual.proposals || actual.review || actual) as DataObject | ActualRow[];
  if (Array.isArray(selected))
    return selected.flatMap((value) =>
      Array.isArray(value?.records)
        ? value.records.map((row: ActualRow) => candidate(row))
        : [candidate(value)],
    );
  return rows(selected.records || selected.entries).map((row) => candidate(row));
}

function issueMatches(expected: IssueExpectation, issues: ActualRow[]) {
  return issues.some((issue) => {
    if (
      issue.kind !== expected.kind ||
      issue.field !== expected.field ||
      issue.textAnchor !== expected.textAnchor
    )
      return false;
    const values = new Set(rows(issue.choices).map((choice) => choice.value));
    return expected.choices.every((choice) => values.has(choice.value));
  });
}

function flatten(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (!object(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child))
      return child.flatMap((item, index) => flatten(item, `${path}.${index}`));
    return object(child) ? flatten(child, path) : [[path, child]];
  });
}

const present = (value: unknown) => value != null && value !== '';
const containsTokens = (value: unknown, tokens: string[]) => {
  const text = String(value || '').toLowerCase();
  return tokens.every((token) => text.includes(String(token).toLowerCase()));
};

function bindingValues(bindings: AssetBindings | undefined, key: string) {
  const value = bindings?.[key];
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function sourceLocatorMatches(match: Candidate, source: SourceExpectation) {
  return (
    match.evidence.some((item) => containsTokens(item.locator, source.locatorTokens)) ||
    match.attachments.some((item) => containsTokens(item.caption, source.locatorTokens)) ||
    match.assets.some((asset) => containsTokens(asset, source.locatorTokens))
  );
}

function boundLinkedAssetMatches(
  match: Candidate,
  source: SourceExpectation,
  bindings: AssetBindings | undefined,
) {
  if (source.primary) return false;
  const bound = new Set(bindingValues(bindings, source.assetKey).map(String));
  return match.assets.some((asset) => bound.has(String(asset)));
}

function sourceAssetMatches(
  match: Candidate,
  source: SourceExpectation,
  bindings: AssetBindings | undefined,
  stage: 'proposal' | 'accepted',
) {
  const explicitRefs = new Set([
    ...(source.assetRefs || []),
    ...bindingValues(bindings, source.assetKey),
  ]);
  const assetRefs = new Set(match.assets.map(String));
  const locatorEvidence = match.evidence.filter((item) =>
    containsTokens(item.locator, source.locatorTokens),
  );
  if (
    locatorEvidence.some(
      (item) =>
        item.sourceFileId &&
        (stage === 'accepted' ||
          assetRefs.has(String(item.sourceFileId)) ||
          explicitRefs.has(String(item.sourceFileId))),
    )
  )
    return true;
  if ([...explicitRefs].some((ref) => assetRefs.has(String(ref)))) return true;
  return match.attachments.some((item) => {
    if (!containsTokens(item.caption, source.locatorTokens)) return false;
    const id = item.sourceFileId || contentSourceId(item.contentUrl);
    if (id && (assetRefs.has(String(id)) || explicitRefs.has(String(id)))) return true;
    return (source.assetNames || []).includes(item.originalName as string);
  });
}

function supportedClinicalPath(expected: RecordExpectation, path: string, value: unknown) {
  const required = new Set(flatten(expected.expected).map(([expectedPath]) => expectedPath));
  if (required.has(path)) return true;
  if (
    path === 'label' ||
    path === 'sourceSystem' ||
    path === 'sourceRecordId' ||
    path.startsWith('assets.') ||
    path.startsWith('uncertainties.') ||
    path.startsWith('mappingOrigins.')
  )
    return true;
  if (expected.supportedFields?.[path]?.some((supported) => equal(supported, value))) return true;
  if (
    [
      'dateRole',
      'medicationKind',
      'procedureCategory',
      'documentTitle',
      'documentDate',
      'text',
    ].includes(path)
  )
    return true;
  return (expected.optionalPaths || []).some(
    (optional) => path === optional || path.startsWith(`${optional}.`),
  );
}

export function evaluateImportGroundTruth(actual: unknown, options: EvaluationOptions = {}) {
  const truth: GroundTruth = options.truth || IMPORT_GROUND_TRUTH;
  const stage = options.stage || 'proposal';
  const candidates = selectActual(actual, stage);
  const groups = Map.groupBy(
    candidates.filter((item) => item.sourceRecordId),
    (item) => item.sourceRecordId,
  );
  const checks: Array<{ category: string; ok: boolean; detail: string; recordId: unknown }> = [];
  const failures: Array<{ category: string; detail: string; recordId: unknown }> = [];
  const records: Array<{ sourceRecordId: string; matched: boolean; occurrences?: number }> = [];
  const check = (category: string, ok: boolean, detail: string, recordId: unknown = null) => {
    checks.push({ category, ok, detail, recordId });
    if (!ok) failures.push({ category, detail, recordId });
  };

  for (const expected of truth.records) {
    const matches = groups.get(expected.sourceRecordId) || [];
    check(
      'recall',
      matches.length > 0,
      'expected provider record is present',
      expected.sourceRecordId,
    );
    if (!matches.length) {
      records.push({ sourceRecordId: expected.sourceRecordId, matched: false });
      continue;
    }

    const wantedOccurrences = stage === 'accepted' ? 1 : expected.expectedOccurrences || 1;
    check(
      stage === 'accepted' ? 'deduplication' : 'source_occurrence',
      matches.length === wantedOccurrences,
      `${stage} must contain ${wantedOccurrences} clinical occurrence(s); received ${matches.length}`,
      expected.sourceRecordId,
    );

    const literal = new Set(expected.literalPaths || []);
    const classification = new Set(expected.classificationPaths || []);
    for (const [occurrenceIndex, actualRecord] of matches.entries()) {
      for (const [path, value] of flatten(expected.expected)) {
        const alternatives = expected.fieldAlternatives?.[path];
        const category = literal.has(path)
          ? 'literal_fidelity'
          : classification.has(path)
            ? 'classification'
            : 'field_accuracy';
        const optionalMissing =
          expected.optionalExpectedPaths?.includes(path) &&
          !present(get(actualRecord.mapping, path));
        check(
          category,
          !!optionalMissing ||
            (alternatives
              ? alternatives.some((alternative) =>
                  equal(alternative, get(actualRecord.mapping, path)),
                )
              : equal(value, get(actualRecord.mapping, path))),
          alternatives
            ? `${path} must equal one supported source timestamp ${JSON.stringify(alternatives)}; received ${JSON.stringify(get(actualRecord.mapping, path))}`
            : `${path} must equal ${JSON.stringify(value)}; received ${JSON.stringify(get(actualRecord.mapping, path))}`,
          expected.sourceRecordId,
        );
      }
      if (stage === 'proposal') {
        const semanticSegments = flatten({
          payload: actualRecord.payload,
          provenance: actualRecord.raw.provenance,
        }).map(([path, value]) => `${path} ${JSON.stringify(value)}`);
        for (const fact of expected.payloadFacts || [])
          check(
            'field_accuracy',
            (fact.alternatives || [fact.tokens]).some((tokens) =>
              semanticSegments.some((segment) => containsTokens(segment, tokens!)),
            ),
            `occurrence ${occurrenceIndex + 1} payload/provenance must retain ${fact.label} without requiring a particular key shape`,
            expected.sourceRecordId,
          );
      }
      for (const path of expected.forbiddenPaths || [])
        check(
          'unsupported_fields',
          !present(get(actualRecord.mapping, path)),
          `${path} must remain absent because the source prints no unit`,
          expected.sourceRecordId,
        );
      for (const [path, value] of flatten(actualRecord.mapping))
        if (present(value) && !supportedClinicalPath(expected, path, value))
          check(
            'unsupported_fields',
            false,
            `unsupported clinical field ${path} was invented`,
            expected.sourceRecordId,
          );
      check(
        'attribution',
        actualRecord.sourceSystem === truth.sourceSystem,
        `sourceSystem must be the explicitly printed issuing system ${JSON.stringify(truth.sourceSystem)}`,
        expected.sourceRecordId,
      );
      check(
        'attribution',
        !!actualRecord.sourceRecordId && actualRecord.evidence.some((item) => item.locator),
        'provider sourceRecordId and source evidence locator must both be present',
        expected.sourceRecordId,
      );
      if (expected.minimumAssets)
        check(
          'source_occurrence',
          actualRecord.assets.length + actualRecord.attachments.length >= expected.minimumAssets,
          `retain at least ${expected.minimumAssets} linked original assets; received ${actualRecord.assets.length + actualRecord.attachments.length}`,
          expected.sourceRecordId,
        );
    }

    for (const source of expected.sources) {
      const occurrences = matches.filter(
        (match) =>
          (sourceLocatorMatches(match, source) ||
            boundLinkedAssetMatches(match, source, options.assetBindings)) &&
          sourceAssetMatches(match, source, options.assetBindings, stage),
      );
      check(
        'source_occurrence',
        occurrences.length > 0,
        `retain an occurrence at ${source.locatorTokens.join(' / ')} backed by the matching supplied ${source.assetKey} asset`,
        expected.sourceRecordId,
      );
    }
    if (expected.issue)
      check(
        'review_issue',
        issueMatches(
          expected.issue,
          matches.flatMap((match) => match.issues),
        ),
        'ambiguous prescribed date must remain unresolved with both supported choices',
        expected.sourceRecordId,
      );
    records.push({
      sourceRecordId: expected.sourceRecordId,
      matched: true,
      occurrences: matches.length,
    });
  }

  const expectedIds = new Set(truth.records.map((record) => record.sourceRecordId));
  for (const item of candidates) {
    if (
      item.mapping?.kind &&
      truth.unsupportedSourceRecordIds.includes(item.sourceRecordId as string)
    )
      check(
        'unsupported_projection',
        false,
        'untrusted text instruction became a clinical projection',
        item.sourceRecordId,
      );
    else if (
      item.mapping?.kind &&
      truth.excludedSourceRecordIds?.includes(item.sourceRecordId as string)
    )
      check(
        'extra_record',
        false,
        'in-process routing copy became a separate clinical event',
        item.sourceRecordId,
      );
    else if (item.mapping?.kind && !expectedIds.has(item.sourceRecordId as string))
      check(
        'extra_record',
        false,
        `unexpected clinical record ${JSON.stringify(item.sourceRecordId)}`,
        item.sourceRecordId,
      );
  }

  if (stage === 'accepted') {
    const medication = groups.get('gt-medication-historical-order')?.[0];
    if (medication)
      check(
        'personal_use',
        medication.currentStatus === 'not_current',
        `historical provider order must remain inactive for personal use; received ${JSON.stringify(medication.currentStatus)}`,
        'gt-medication-historical-order',
      );
  }

  const byCategory = Object.fromEntries(
    [...new Set(checks.map((item) => item.category))].map((category) => {
      const selected = checks.filter((item) => item.category === category);
      return [
        category,
        {
          passed: selected.filter((item) => item.ok).length,
          total: selected.length,
        },
      ];
    }),
  );
  return {
    fixture: truth.fixture,
    stage,
    passed: failures.length === 0,
    score: checks.length ? checks.filter((item) => item.ok).length / checks.length : 0,
    summary: {
      expectedRecords: truth.records.length,
      matchedRecords: records.filter((record) => record.matched).length,
      unmatchedRecords: records
        .filter((record) => !record.matched)
        .map((record) => record.sourceRecordId),
      extraRecords: failures.filter((item) => item.category === 'extra_record').length,
      failedChecks: failures.length,
    },
    categories: byCategory,
    records,
    failures,
  };
}

export function parseProviderOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Provider output is empty');
  try {
    return JSON.parse(trimmed);
  } catch {
    const values = trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Provider output line ${index + 1} is not JSON: ${(error as Error).message}`,
          );
        }
      });
    return values;
  }
}
