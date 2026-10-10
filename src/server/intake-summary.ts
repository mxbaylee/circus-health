import type { Intake, IntakeMetadata, IntakeAcceptedRecord } from '../shared/intake.ts';
import type {
  IntakePackageFailurePage,
  IntakeReviewSummary,
  IntakeSummaryPins,
  IntakeSummaryV2,
  IntakeUnitDetail,
  IntakeAcceptedDestinations,
  IntakePlanHeader,
  IntakeFilenameReference,
  IntakeFilenameFragment,
  IntakePackageFailureField,
  IntakePackageFailureFieldReference,
  IntakePackageFailureFieldFragment,
} from '../shared/intake-summary.ts';
import { HttpError, type Database } from './database.ts';
import { type IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  readVerifiedWorkflowSummary,
  openSelectedAcceptedDestinations,
} from './intake-workflow-state.ts';
import { summaryFilename } from './intake-summary-name.ts';

const FIELD_BYTES = 16 * 1024;
const invalid = (field: string): never => {
  throw new HttpError(
    409,
    'INTAKE_SUMMARY_UNAVAILABLE',
    `The selected intake ${field} could not be read. Refresh this file.`,
  );
};
function value(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
): unknown {
  const result = view.field(record, field, { bytes: FIELD_BYTES });
  if (result.kind === 'fragmented') return invalid(field);
  return result.kind === 'value' ? result.value : undefined;
}
function text(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: string,
  optional = false,
): string | undefined {
  const result = value(view, record, field);
  if (optional && (result === undefined || result === null)) return undefined;
  return typeof result === 'string' ? result : invalid(field);
}
const failureLocationFields = ['originalFilename', 'filename', 'locator'] as const;
function failureLocation(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  field: IntakePackageFailureField,
  key: string,
  source: IntakeEnvelopeSource,
  pins: IntakeSummaryPins,
) {
  const selected = view.field(record, field, { bytes: FIELD_BYTES });
  if (selected.kind === 'missing') return undefined;
  if (selected.kind === 'value') {
    if (selected.value === null && field !== 'originalFilename') return undefined;
    if (typeof selected.value !== 'string') return invalid(field);
    return { value: selected.value };
  }
  if (!selected.bytes || view.fieldFragment(record, field, { bytes: 4096 }).text[0] !== '"')
    return invalid(field);
  return {
    reference: {
      format: 'health-intake-package-failure-field-reference-v1' as const,
      intakeId: source.id,
      key,
      field,
      pins: { ...pins },
      bytes: selected.bytes,
    },
  };
}
function selection(db: Database, source: IntakeEnvelopeSource) {
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake');
  if (!intake) return invalid('header');
  const version = intakeSourceVersion(db, source.id);
  const pins: IntakeSummaryPins = {
    sourceHash: source.sha256!,
    logicalRoot: view.logical.root?.hash || '',
    domainVersion: view.logical.domainVersion,
    version: version.version,
  };
  if (!pins.sourceHash || !pins.logicalRoot || version.rawVersion !== pins.domainVersion)
    return invalid('binding');
  return { view, intake, pins };
}

/** Read the exact selected JSON string syntax; the continuation never grants
 * authority for a different field, source or accepted root. */
export function collectionIntakeFilenameFragment(
  db: Database,
  source: IntakeEnvelopeSource,
  input: { reference: IntakeFilenameReference; cursor?: string; limit?: number },
): IntakeFilenameFragment {
  const { view, intake, pins } = selection(db, source);
  const file = db
    .prepare("SELECT sha256,mime_type FROM source_files WHERE id=? AND kind='intake_original'")
    .get(source.id);
  if (!file || file.sha256 !== source.sha256) return invalid('source');
  const filename = summaryFilename(db, {
    view,
    intake,
    pins,
    id: source.id,
    mimeType: String(file.mime_type || ''),
  });
  const expected = filename.filenameReference,
    actual = input.reference;
  if (
    !expected ||
    !actual ||
    typeof actual !== 'object' ||
    !actual.pins ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.keys(actual.pins).length !== Object.keys(expected.pins).length ||
    (['format', 'intakeId', 'field', 'scalarHash', 'bytes'] as const).some(
      (key) => actual[key] !== expected[key],
    ) ||
    (['sourceHash', 'logicalRoot', 'domainVersion', 'version'] as const).some(
      (key) => actual.pins[key] !== expected.pins[key],
    )
  )
    throw new HttpError(
      409,
      'INTAKE_FILENAME_CHANGED',
      'The original filename selection changed. Refresh this file.',
    );
  const limit = input.limit ?? 32768;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 4096 ||
    limit > 32768 ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 8192))
  )
    throw new HttpError(
      400,
      'INTAKE_FILENAME_WINDOW',
      'Read an exact bounded original filename fragment.',
    );
  const fragment = view.fieldFragment(intake, 'originalName', {
    after: input.cursor,
    bytes: limit,
  });
  if (Buffer.byteLength(fragment.text) > limit) return invalid('filename fragment');
  return {
    format: 'health-intake-filename-fragment-v1',
    reference: expected,
    encoding: 'json-string',
    text: fragment.text,
    complete: fragment.complete,
    nextCursor: fragment.after,
  };
}

export interface IntakeSummaryOptions {
  durability: Intake['durability'];
  mappingVersion?: string;
  /** Providers must read checked selected roots; never recount the whole workflow here. */
  review?: (view: IntakeCollectionEnvelopeReader, pins: IntakeSummaryPins) => IntakeReviewSummary;
  activePlan?: (
    view: IntakeCollectionEnvelopeReader,
    pins: IntakeSummaryPins,
  ) => IntakeSummaryV2['activePlan'];
}

/** A negative lookup is authoritative only with the selected complete index. */
export function collectionActiveIntakePlanHeader(
  view: IntakeCollectionEnvelopeReader,
): IntakeSummaryV2['activePlan'] {
  const intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!intake) return invalid('header');
  if (view.has(intake, 'workflow') && !workflow) return invalid('workflow');
  if (workflow && view.has(workflow, 'plans') && !view.child(workflow, 'plans'))
    return invalid('plans');
  if (!workflow || view.childCount(workflow, 'plans') === 0) return { state: 'exact', plan: null };
  let record: IntakeEnvelopeRecord | undefined;
  try {
    record = view.lookup('active-plan-first', []);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('semantic indexes are incomplete or stale')
    )
      return { state: 'pending', plan: null };
    throw error;
  }
  if (!record) return { state: 'exact', plan: null };
  if (text(view, record, 'format', true) === 'health-intake-package-plan-v2')
    return { state: 'pending', plan: null };
  const selectedPins = view.child(record, 'pins');
  if (!selectedPins || text(view, record, 'status') !== 'active') return invalid('active plan');
  const pins: IntakePlanHeader['pins'] = {
    sourceHash: text(view, selectedPins, 'sourceHash')!,
    backend: text(view, selectedPins, 'backend')!,
    model: text(view, selectedPins, 'model', true) ?? null,
    reasoningEffort: text(view, selectedPins, 'reasoningEffort', true) ?? null,
    instructionVersion: text(view, selectedPins, 'instructionVersion')!,
    mappingVersion: text(view, selectedPins, 'mappingVersion')!,
  };
  const metadata = text(view, selectedPins, 'reviewedMetadataVersion', true);
  if (metadata !== undefined) pins.reviewedMetadataVersion = metadata;
  return {
    state: 'exact',
    plan: {
      format: 'health-intake-plan-header-v1',
      id: text(view, record, 'id')!,
      createdAt: text(view, record, 'createdAt')!,
      status: 'active',
      pins,
      unitCount:
        text(view, record, 'format', true) === 'health-intake-direct-plan-v2'
          ? Number(value(view, record, 'unitCount'))
          : view.childCount(record, 'units'),
      batchCount: view.childCount(record, 'batches'),
    },
  };
}

/** Native summary performs fixed selected field reads and exact collection-header counts. */
export function collectionIntakeSummary(
  db: Database,
  source: IntakeEnvelopeSource,
  options: IntakeSummaryOptions,
): IntakeSummaryV2 {
  const file = db
    .prepare(
      `SELECT f.id,f.sha256,f.mime_type,f.bytes,f.provider_id,p.name AS provider
    FROM source_files f LEFT JOIN providers p ON p.id=f.provider_id WHERE f.id=? AND f.kind='intake_original'`,
    )
    .get(source.id);
  if (!file || file.sha256 !== source.sha256) return invalid('source');
  const { view, intake, pins } = selection(db, source),
    workflow = view.child(intake, 'workflow');
  const metadataRecord = view.child(intake, 'metadata');
  let metadata: IntakeMetadata | undefined;
  const sourceLabel = metadataRecord && text(view, metadataRecord, 'source', true),
    sourceProviderId = metadataRecord && text(view, metadataRecord, 'sourceProviderId', true);
  if (metadataRecord) {
    const topics = view.field(metadataRecord, 'topics', { bytes: FIELD_BYTES });
    if (
      topics.kind === 'value' &&
      Array.isArray(topics.value) &&
      topics.value.every((item) => typeof item === 'string')
    )
      metadata = {
        source: sourceLabel || null,
        ...(sourceProviderId ? { sourceProviderId } : {}),
        careArea: text(view, metadataRecord, 'careArea', true) || null,
        documentType: text(view, metadataRecord, 'documentType', true) || null,
        topics: topics.value as string[],
      };
  } else metadata = { source: null, careArea: null, documentType: null, topics: [] };
  const state = text(view, intake, 'state');
  if (
    ![
      'ready',
      'pending_conversion',
      'conversion_proposed',
      'needs_review',
      'imported',
      'kept_original',
    ].includes(state!)
  )
    return invalid('state');
  const visibility = db
    .prepare(
      `SELECT archived,version FROM visibility_events WHERE target_type='source_file' AND target_id=? ORDER BY version DESC LIMIT 1`,
    )
    .get(source.id);
  const count = (record: IntakeEnvelopeRecord | undefined, field: string) => {
    if (record && view.has(record, field) && !view.child(record, field)) return invalid(field);
    return { total: record ? view.childCount(record, field) : 0 };
  };
  const path = `/intakes/${encodeURIComponent(source.id)}`;
  const acquisition = view.child(intake, 'acquisition');
  const result: IntakeSummaryV2 = {
    format: 'health-intake-summary-v2',
    id: source.id,
    providerId: sourceProviderId || String(file.provider_id || ''),
    provider: sourceLabel || String(file.provider || ''),
    acquisition: acquisition
      ? {
          providerId: text(view, acquisition, 'providerId')!,
          provider: text(view, acquisition, 'provider')!,
        }
      : { providerId: String(file.provider_id || ''), provider: String(file.provider || '') },
    parentSourceFileId: text(view, intake, 'parentSourceFileId', true) || null,
    metadata,
    metadataState: metadata ? 'complete' : 'unloaded',
    archived: Boolean(visibility?.archived),
    visibilityVersion: Number(visibility?.version || 0),
    ...summaryFilename(db, {
      view,
      intake,
      pins,
      id: source.id,
      mimeType: String(file.mime_type || ''),
    }),
    createdAt: text(view, intake, 'createdAt')!,
    mimeType: String(file.mime_type || ''),
    bytes: Number(file.bytes),
    sha256: pins.sourceHash,
    state: state as Intake['state'],
    version: pins.version,
    contentUrl: `/api/sources/${encodeURIComponent(source.id)}/content`,
    pins,
    review:
      options.review?.(view, pins) ??
      (options.mappingVersion
        ? readVerifiedWorkflowSummary(db, source, { mappingVersion: options.mappingVersion })
        : { state: 'pending', counts: null }),
    activePlan: options.activePlan?.(view, pins) ?? collectionActiveIntakePlanHeader(view),
    collections: {
      proposals: count(intake, 'proposals'),
      importHistory: count(intake, 'importHistory'),
      reportGroups: count(workflow, 'reportGroups'),
      candidates: count(workflow, 'candidates'),
      questions: count(workflow, 'questions'),
      plans: count(workflow, 'plans'),
      packageFailures: { ...count(intake, 'packageFailures'), href: path + '/package-failures' },
    },
    links: {
      original: `/api/sources/${encodeURIComponent(source.id)}/content`,
      review: path + '/review',
      reports: `/intakes/import-feed?intakeId=${encodeURIComponent(source.id)}`,
      sourceText: path + '/source-text',
      package: path + '/package',
      plan: path + '/plan',
    },
    durability: options.durability,
  };
  // A provider cannot silently change selected state underneath a returned header.
  view.info(intake);
  if (intakeSourceVersion(db, source.id).version !== pins.version) return invalid('source version');
  return result;
}

type FailureCursor = {
  format: 'health-intake-failures-cursor-v1';
  intakeId: string;
  pins: IntakeSummaryPins;
  after: string;
};
export function collectionIntakePackageFailures(
  db: Database,
  source: IntakeEnvelopeSource,
  options: { cursor?: string; limit?: number } = {},
): IntakePackageFailurePage {
  const { view, intake, pins } = selection(db, source),
    failures = view.child(intake, 'packageFailures');
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new HttpError(400, 'PACKAGE_WINDOW', 'Choose between 1 and 50 processing issues.');
  let after: string | undefined;
  if (options.cursor) {
    let cursor: FailureCursor;
    try {
      if (options.cursor.length > 4096) throw Error();
      cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString()) as FailureCursor;
      if (
        cursor.format !== 'health-intake-failures-cursor-v1' ||
        cursor.intakeId !== source.id ||
        typeof cursor.after !== 'string'
      )
        throw Error();
    } catch {
      throw new HttpError(400, 'PACKAGE_CURSOR', 'The processing issues page address is invalid.');
    }
    if (JSON.stringify(cursor.pins) !== JSON.stringify(pins))
      throw new HttpError(
        409,
        'PACKAGE_CURSOR_CHANGED',
        'Processing issues changed. Begin again with the first page.',
      );
    after = cursor.after;
  }
  const page = failures
    ? view.fields(failures, { after, items: limit, bytes: 64 * 1024 })
    : { fields: [], total: 0, complete: true, after: null };
  const entries: IntakePackageFailurePage['entries'] = [];
  for (const field of page.fields) {
    const record = view.child(failures!, field.name);
    if (!record) return invalid('processing issue');
    const failure = {} as IntakePackageFailurePage['entries'][number]['failure'];
    for (const name of [
      'sourceFileId',
      'sourceHash',
      'operationKey',
      'contentUrl',
      'reasonCode',
      'detail',
      'status',
      'scope',
      'retryAction',
    ] as const)
      Object.assign(failure, { [name]: text(view, record, name) });
    const fieldReferences: Partial<
      Record<IntakePackageFailureField, IntakePackageFailureFieldReference>
    > = {};
    for (const name of failureLocationFields) {
      const location = failureLocation(view, record, name, field.name, source, pins);
      if (name === 'originalFilename' && !location) return invalid(name);
      if (location && 'value' in location) failure[name] = location.value;
      if (location && 'reference' in location) fieldReferences[name] = location.reference;
    }
    const memberId = text(view, record, 'memberId', true);
    if (memberId !== undefined) failure.memberId = memberId;
    const ordinal = value(view, record, 'ordinal');
    if (ordinal !== undefined) {
      if (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0)
        return invalid('issue ordinal');
      failure.ordinal = ordinal as number;
    }
    if (
      failure.sourceFileId !== source.id ||
      failure.sourceHash !== pins.sourceHash ||
      failure.status !== 'pending' ||
      failure.scope !== 'incomplete' ||
      !['inventory', 'read_member', 'read_structure'].includes(failure.retryAction)
    )
      return invalid('issue binding');
    entries.push({
      key: field.name,
      failure,
      ...(Object.keys(fieldReferences).length ? { fieldReferences } : {}),
    });
  }
  return {
    format: 'health-intake-package-failure-page-v1',
    intakeId: source.id,
    pins,
    entries,
    total: page.total,
    complete: page.complete,
    nextCursor: page.after
      ? Buffer.from(
          JSON.stringify({
            format: 'health-intake-failures-cursor-v1',
            intakeId: source.id,
            pins,
            after: page.after,
          } satisfies FailureCursor),
        ).toString('base64url')
      : null,
  };
}

/** A retained long location is read only from the same selected root and issue key. */
export function collectionIntakePackageFailureFieldFragment(
  db: Database,
  source: IntakeEnvelopeSource,
  input: { reference: IntakePackageFailureFieldReference; cursor?: string; limit?: number },
): IntakePackageFailureFieldFragment {
  const { view, intake, pins } = selection(db, source);
  const actual = input.reference;
  if (
    !actual ||
    typeof actual !== 'object' ||
    Array.isArray(actual) ||
    !failureLocationFields.includes(actual.field) ||
    actual.format !== 'health-intake-package-failure-field-reference-v1' ||
    actual.intakeId !== source.id ||
    typeof actual.key !== 'string' ||
    !actual.key ||
    !actual.pins ||
    typeof actual.pins !== 'object' ||
    Object.keys(actual).length !== 6 ||
    Object.keys(actual.pins).length !== 4 ||
    (['sourceHash', 'logicalRoot', 'domainVersion', 'version'] as const).some(
      (key) => actual.pins[key] !== pins[key],
    )
  )
    throw new HttpError(409, 'PACKAGE_FAILURE_CHANGED', 'Refresh this unfinished operation.');
  const failures = view.child(intake, 'packageFailures'),
    record = failures && view.child(failures, actual.key);
  if (
    !record ||
    text(view, record, 'sourceFileId') !== source.id ||
    text(view, record, 'sourceHash') !== pins.sourceHash ||
    text(view, record, 'status') !== 'pending' ||
    text(view, record, 'scope') !== 'incomplete'
  )
    throw new HttpError(409, 'PACKAGE_FAILURE_CHANGED', 'Refresh this unfinished operation.');
  const location = failureLocation(view, record, actual.field, actual.key, source, pins),
    expected = location && 'reference' in location ? location.reference : undefined;
  if (!expected || expected.bytes !== actual.bytes)
    throw new HttpError(409, 'PACKAGE_FAILURE_CHANGED', 'Refresh this unfinished operation.');
  const limit = input.limit ?? 32768;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 4096 ||
    limit > 32768 ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 8192))
  )
    throw new HttpError(400, 'PACKAGE_FAILURE_WINDOW', 'Read a bounded exact location fragment.');
  const fragment = view.fieldFragment(record, actual.field, {
    after: input.cursor,
    bytes: limit,
  });
  if (Buffer.byteLength(fragment.text) > limit) return invalid('processing issue fragment');
  return {
    format: 'health-intake-package-failure-field-fragment-v1',
    reference: expected,
    encoding: 'json-string',
    text: fragment.text,
    complete: fragment.complete,
    nextCursor: fragment.after,
  };
}

/** Exact retained unit notes, with no plan/unit/history hydration. */
export function collectionIntakeUnitDetail(
  db: Database,
  source: IntakeEnvelopeSource,
  request: { planId: string; unitId: string; version: number },
  implicit?: (planId: string, unitId: string) => IntakeUnitDetail['unit'] | undefined,
): IntakeUnitDetail {
  const { view, intake, pins } = selection(db, source);
  if (request.version !== pins.version)
    throw new HttpError(
      409,
      'PLAN_CHANGED',
      'This processing record changed. Refresh reader observations.',
    );
  const workflow = view.child(intake, 'workflow'),
    plan = workflow && view.find('plan', workflow, request.planId);
  if (!plan) return invalid('selected plan');
  let unit: IntakeUnitDetail['unit'];
  if (
    ['health-intake-package-plan-v2', 'health-intake-direct-plan-v2'].includes(
      text(view, plan, 'format', true) ?? '',
    )
  ) {
    const selected = implicit?.(request.planId, request.unitId);
    if (!selected || selected.id !== request.unitId) return invalid('selected package unit');
    unit = {
      id: selected.id,
      ...(selected.pages ? { pages: selected.pages } : {}),
      ...(selected.coverage ? { coverage: selected.coverage } : {}),
    };
  } else {
    const record = view.find('unit', plan, request.unitId);
    if (!record) return invalid('selected unit');
    const pages = value(view, record, 'pages'),
      coverage = view.child(record, 'coverage');
    if (
      pages !== undefined &&
      (!Array.isArray(pages) ||
        pages.length > 50 ||
        pages.some((page) => !Number.isSafeInteger(page) || page < 1))
    )
      return invalid('selected pages');
    unit = { id: request.unitId, ...(pages ? { pages: pages as number[] } : {}) };
    if (coverage) {
      const kind = text(view, coverage, 'kind'),
        unitId = text(view, coverage, 'unitId'),
        note = view.field(coverage, 'notes', { bytes: 32 * 1024 });
      if (
        unitId !== request.unitId ||
        !['inspected', 'extracted', 'context', 'unreadable'].includes(kind!) ||
        note.kind !== 'value' ||
        typeof note.value !== 'string'
      )
        return invalid('selected coverage');
      unit.coverage = {
        unitId,
        kind: kind as NonNullable<IntakeUnitDetail['unit']['coverage']>['kind'],
        notes: note.value,
      };
    } else if (view.has(record, 'coverage')) return invalid('selected coverage');
  }
  view.info(intake);
  if (intakeSourceVersion(db, source.id).version !== pins.version) return invalid('source version');
  return {
    format: 'health-intake-unit-detail-v1',
    intakeId: source.id,
    planId: request.planId,
    version: pins.version,
    pins,
    unit,
  };
}

/** A selected receipt record has a per-value budget; the surrounding history is never read. */
function selectedRecordValue(
  view: IntakeCollectionEnvelopeReader,
  initial: IntakeEnvelopeRecord,
): unknown {
  let remaining = 64 * 1024,
    nodes = 4096;
  const charge = (value: unknown) => {
    remaining -= Buffer.byteLength(JSON.stringify(value));
    if (remaining < 0) return invalid('saved record details');
    return value;
  };
  const read = (record: IntakeEnvelopeRecord, depth = 0): unknown => {
    if (--nodes < 0 || depth > 32) return invalid('saved record details');
    const info = view.info(record);
    if (info.shape === 'scalar') {
      const field = view.field(record, 'value', { bytes: Math.max(1, remaining) });
      return field.kind === 'value' ? charge(field.value) : invalid('saved record field');
    }
    if (info.count > nodes) return invalid('saved record details');
    if (info.shape === 'array') {
      const result: unknown[] = [];
      let after: string | undefined;
      do {
        const page = view.propertyRecords(record, { after, items: 50, bytes: 32 * 1024 });
        for (const child of page.records) result.push(read(child, depth + 1));
        if (page.complete) break;
        if (!page.after || page.after === after) return invalid('saved record item');
        after = page.after;
      } while (true);
      if (result.length !== info.count) return invalid('saved record item count');
      remaining -= 2 + info.count;
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let after: string | undefined;
    do {
      const page = view.fields(record, { after, items: 50, bytes: 32 * 1024 });
      for (const field of page.fields) {
        charge(field.name);
        remaining -= 2;
        const child = view.child(record, field.name);
        if (child) result[field.name] = read(child, depth + 1);
        else {
          const cell = view.field(record, field.name, { bytes: Math.max(1, remaining) });
          if (cell.kind !== 'value') return invalid('saved record field');
          result[field.name] = charge(cell.value);
        }
      }
      if (page.complete) break;
      if (!page.after || page.after === after) return invalid('saved record page');
      after = page.after;
    } while (true);
    return result;
  };
  const result = read(initial);
  if (remaining < 0) return invalid('saved record details');
  return result;
}

export function collectionIntakeAcceptedDestinations(
  db: Database,
  source: IntakeEnvelopeSource,
  request: { groupId: string; proposalId: string | null; recordIds: readonly string[] },
): IntakeAcceptedDestinations {
  if (
    typeof request.groupId !== 'string' ||
    !request.groupId ||
    request.groupId.length > 4096 ||
    (request.proposalId !== null &&
      (typeof request.proposalId !== 'string' || request.proposalId.length > 4096)) ||
    !Array.isArray(request.recordIds) ||
    request.recordIds.length > 100 ||
    request.recordIds.some((id) => typeof id !== 'string' || !id || id.length > 4096)
  )
    throw new HttpError(
      400,
      'INTAKE_RECORD_SELECTION',
      'Choose at most 100 exact saved record IDs.',
    );
  const { view, select } = openSelectedAcceptedDestinations(db, source),
    version = intakeSourceVersion(db, source.id).version;
  const records: IntakeAcceptedRecord[] = [];
  for (const id of new Set(request.recordIds)) {
    const record = select(request.proposalId, request.groupId, id);
    if (!record) continue;
    const selected = selectedRecordValue(view, record) as IntakeAcceptedRecord;
    if (
      !selected ||
      selected.recordId !== id ||
      typeof selected.entityId !== 'string' ||
      !['observation', 'medication', 'procedure', 'document'].includes(selected.kind) ||
      !['added', 'matched', 'updated'].includes(selected.outcome) ||
      typeof selected.optical !== 'boolean' ||
      typeof selected.title !== 'string' ||
      (selected.identityAttribution?.groupId &&
        selected.identityAttribution.groupId !== request.groupId)
    )
      return invalid('saved record identity');
    records.push(selected);
  }
  if (intakeSourceVersion(db, source.id).version !== version)
    return invalid('saved record version');
  return {
    format: 'health-intake-accepted-destinations-v1',
    intakeId: source.id,
    version,
    groupId: request.groupId,
    proposalId: request.proposalId,
    records,
  };
}
