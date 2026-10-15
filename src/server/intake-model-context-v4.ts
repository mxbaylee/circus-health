import type { Database } from './database.ts';
import { HttpError } from './database.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES,
  MODEL_INTAKE_SECTIONS,
  type ModelIntakeSection,
} from './intake-model-context.ts';
import type { WorkflowCounts } from './intake-workflow-reader.ts';

export interface ModelIntakePinsV2 {
  sourceId: string;
  sourceHash: string;
  logicalRoot: string;
  domainVersion: number;
  version: number;
  sourceTextPin: string;
  mappingVersion: string;
}
export type ModelSectionDescriptor =
  { state: 'pending' } | { state: 'complete'; root: string; count: number };
export type ModelFieldDescriptor = {
  key: string;
  name: string | null;
  keyFormat?: 'field';
  nameFragment?: { key: string; root: string; bytes: number };
} & (
  | { kind: 'value'; value: unknown }
  | { kind: 'record'; record: IntakeEnvelopeRecord }
  | { kind: 'children'; count: number; root: string }
  | { kind: 'fragment'; bytes: number; root: string }
);
export interface ModelFieldPage {
  root: string;
  fields: ModelFieldDescriptor[];
  complete: boolean;
  after: string | null;
}
/** All lookups and negative lookups must verify current selected authority. */
export interface ModelIntakeSectionBackend {
  /** Relevant roots only: receipt/history/incomplete-build heads are excluded. */
  readonly pins: ModelIntakePinsV2;
  readonly summary: { state: 'exact'; counts: WorkflowCounts } | { state: 'pending'; counts: null };
  section(section: ModelIntakeSection): ModelSectionDescriptor;
  sectionPage(
    section: ModelIntakeSection,
    options: { after?: string; items: number; bytes: number },
  ): {
    root: string;
    entries: {
      tag: string;
      records: IntakeEnvelopeRecord[];
      value?: unknown;
      externalValue?: { key: string; bytes: number; root: string };
      externalValues?: Record<string, { key: string; bytes: number; root: string }>;
    }[];
    complete: boolean;
    after: string | null;
  };
  externalFragment?(
    section: ModelIntakeSection,
    key: string,
    options: { after?: string; bytes: number },
  ): {
    root: string;
    jsonText: string;
    totalBytes: number;
    complete: boolean;
    after: string | null;
  };
  address(record: IntakeEnvelopeRecord): string;
  /** Resolve only records proven to belong to this selected source and logical scope. */
  resolve(address: string): IntakeEnvelopeRecord;
  recordRoot(record: IntakeEnvelopeRecord): string;
  fields(
    record: IntakeEnvelopeRecord,
    options: { after?: string; items: number; bytes: number },
  ): ModelFieldPage;
  children(
    record: IntakeEnvelopeRecord,
    fieldKey: string,
    options: { after?: string; items: number; bytes: number; keyFormat?: 'field' | 'name' },
  ): {
    root: string;
    records: IntakeEnvelopeRecord[];
    total: number;
    complete: boolean;
    after: string | null;
  };
  /** Addressed range read, never a full-value read or a replay from byte zero. */
  fragment(
    record: IntakeEnvelopeRecord,
    fieldKey: string,
    options: { after?: string; bytes: number; keyFormat?: 'field' | 'name' },
  ): {
    root: string;
    jsonText: string;
    totalBytes: number;
    complete: boolean;
    after: string | null;
  };
}

type Cursor = ModelIntakePinsV2 & {
  format: 'health-intake-model-cursor-v2';
  section: ModelIntakeSection;
  mode: 'section' | 'record' | 'children' | 'fragment' | 'externalFragment';
  scopeRoot: string;
  record?: string;
  field?: string;
  fieldFormat?: 'field' | 'name';
  after?: string;
};
export type ModelIntakeContextRequestV2 = {
  format: 'health-intake-model-context-request-v2';
  section: ModelIntakeSection;
} & (
  | { freshStart: true; cursor?: never; version?: never; mappingVersion?: never }
  | { freshStart?: never; cursor: string; version: number; mappingVersion: string }
);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const invalid = (message: string): never => {
  throw new HttpError(400, 'MODEL_CONTEXT_CURSOR', message);
};
const stale = (): never => {
  throw new HttpError(
    409,
    'MODEL_CONTEXT_CHANGED',
    'This model context changed. Discard previously assembled pages and partial fields. Begin the named section again with freshStart true and no cursor or version pins. Never combine pages across pins.',
  );
};
const encode = (cursor: Cursor): string => {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  if (encoded.length > 8192)
    return invalid('The model context cursor exceeds its bounded representation');
  return encoded;
};
function decode(text: string): Cursor {
  if (typeof text !== 'string' || text.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(text))
    return invalid('Expected a version 2 model context cursor');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return invalid('Invalid model context cursor');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('Invalid model context cursor');
  const cursor = value as Cursor;
  const allowed = new Set([
    'format',
    'sourceId',
    'sourceHash',
    'logicalRoot',
    'domainVersion',
    'version',
    'sourceTextPin',
    'mappingVersion',
    'section',
    'mode',
    'scopeRoot',
    'record',
    'field',
    'fieldFormat',
    'after',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    cursor.format !== 'health-intake-model-cursor-v2' ||
    !MODEL_INTAKE_SECTIONS.includes(cursor.section) ||
    !['section', 'record', 'children', 'fragment', 'externalFragment'].includes(cursor.mode) ||
    ['sourceId', 'sourceHash', 'logicalRoot', 'sourceTextPin', 'mappingVersion', 'scopeRoot'].some(
      (key) => typeof Reflect.get(value, key) !== 'string',
    ) ||
    !Number.isSafeInteger(cursor.version) ||
    !Number.isSafeInteger(cursor.domainVersion) ||
    cursor.version < 0 ||
    cursor.domainVersion < 0 ||
    (['record', 'children', 'fragment'].includes(cursor.mode) &&
      typeof cursor.record !== 'string') ||
    (['children', 'fragment', 'externalFragment'].includes(cursor.mode) &&
      typeof cursor.field !== 'string') ||
    (cursor.mode === 'externalFragment' && cursor.record !== undefined) ||
    (cursor.after !== undefined && typeof cursor.after !== 'string') ||
    (cursor.fieldFormat !== undefined &&
      (!['field', 'name'].includes(cursor.fieldFormat) ||
        !['children', 'fragment'].includes(cursor.mode)))
  )
    return invalid('Invalid model context cursor fields');
  return cursor;
}
function samePins(cursor: ModelIntakePinsV2, pins: ModelIntakePinsV2): boolean {
  return (
    cursor.sourceId === pins.sourceId &&
    cursor.sourceHash === pins.sourceHash &&
    cursor.logicalRoot === pins.logicalRoot &&
    cursor.domainVersion === pins.domainVersion &&
    cursor.version === pins.version &&
    cursor.sourceTextPin === pins.sourceTextPin &&
    cursor.mappingVersion === pins.mappingVersion
  );
}
function checkedPage(
  complete: boolean,
  after: string | null,
  previous: string | undefined,
  count: number,
): void {
  if ((complete && after !== null) || (!complete && (!after || after === previous || count < 1)))
    throw Error('Model context page did not prove progress or completion');
}

/** V2 uses explicit cursors; v1 integer offsets retain their existing meaning. */
/** Addressed scopes are independently complete; they do not claim a section total. */
export function modelIntakeRecordReference(
  backend: ModelIntakeSectionBackend,
  section: ModelIntakeSection,
  record: IntakeEnvelopeRecord,
) {
  return {
    kind: record.kind,
    cursor: encode({
      ...backend.pins,
      format: 'health-intake-model-cursor-v2',
      section,
      mode: 'record',
      record: backend.address(record),
      scopeRoot: backend.recordRoot(record),
    }),
  };
}

export function modelIntakeContextV2(
  backend: ModelIntakeSectionBackend,
  request: ModelIntakeContextRequestV2,
) {
  const allowed = new Set([
    'format',
    'section',
    'freshStart',
    'cursor',
    'version',
    'mappingVersion',
  ]);
  if (
    request.format !== 'health-intake-model-context-request-v2' ||
    !MODEL_INTAKE_SECTIONS.includes(request.section) ||
    Object.keys(request).some((key) => !allowed.has(key))
  )
    return invalid(
      'Use the explicit version 2 context format and a named section; legacy offsets are not version 2 cursors',
    );
  const pins = backend.pins;
  const base = {
    format: 'health-intake-model-context-v2',
    pins,
    summary: backend.summary,
    section: request.section,
    scopeInstructions:
      'A complete page covers only its named scope. Follow every record, child collection and fragment cursor needed for the complete clinical scope. Reassemble jsonText fragments in cursor order before parsing. No page or extracted model claim establishes clinical acceptance.',
  };
  let cursor: Cursor;
  const descriptor = backend.section(request.section);
  if (request.freshStart === true) {
    if ('cursor' in request || 'version' in request || 'mappingVersion' in request)
      return invalid('A fresh version 2 section requires no cursor or version pins');
    if (descriptor.state === 'pending')
      return {
        ...base,
        state: 'pending' as const,
        logicalTotal: null,
        items: [],
        nextCursor: null,
        complete: false,
      };
    cursor = {
      ...pins,
      format: 'health-intake-model-cursor-v2',
      section: request.section,
      mode: 'section',
      scopeRoot: descriptor.root,
    };
  } else {
    cursor = decode(request.cursor);
    if (
      request.version !== pins.version ||
      request.mappingVersion !== pins.mappingVersion ||
      request.section !== cursor.section ||
      !samePins(cursor, pins)
    )
      return stale();
  }
  const next = (after: string | null) => (after === null ? null : encode({ ...cursor, after }));
  const reference = (record: IntakeEnvelopeRecord) =>
    modelIntakeRecordReference(backend, request.section, record);
  let response: Record<string, unknown>;
  if (cursor.mode === 'section') {
    if (descriptor.state !== 'complete' || descriptor.root !== cursor.scopeRoot) return stale();
    const page = backend.sectionPage(request.section, {
      after: cursor.after,
      items: 8,
      bytes: 12 * 1024,
    });
    if (page.root !== descriptor.root) return stale();
    checkedPage(page.complete, page.after, cursor.after, page.entries.length);
    response = {
      ...base,
      state: 'ready',
      scope: 'section',
      logicalTotal: descriptor.count,
      items: page.entries.map((entry) => ({
        tag: entry.tag,
        ...(entry.value === undefined ? {} : { value: entry.value }),
        ...(entry.externalValue
          ? {
              valueFragment: {
                bytes: entry.externalValue.bytes,
                cursor: encode({
                  ...pins,
                  format: 'health-intake-model-cursor-v2',
                  section: request.section,
                  mode: 'externalFragment',
                  field: entry.externalValue.key,
                  scopeRoot: entry.externalValue.root,
                }),
              },
            }
          : {}),
        ...(entry.externalValues
          ? {
              valueFragments: Object.fromEntries(
                Object.entries(entry.externalValues).map(([name, value]) => [
                  name,
                  {
                    bytes: value.bytes,
                    cursor: encode({
                      ...pins,
                      format: 'health-intake-model-cursor-v2',
                      section: request.section,
                      mode: 'externalFragment',
                      field: value.key,
                      scopeRoot: value.root,
                    }),
                  },
                ]),
              ),
            }
          : {}),
        records: entry.records.map(reference),
      })),
      nextCursor: next(page.after),
      complete: page.complete,
    };
  } else if (cursor.mode === 'externalFragment') {
    if (!backend.externalFragment || descriptor.state !== 'complete') return stale();
    const page = backend.externalFragment(request.section, cursor.field!, {
      after: cursor.after,
      bytes: 4096,
    });
    if (page.root !== cursor.scopeRoot) return stale();
    checkedPage(page.complete, page.after, cursor.after, page.jsonText.length);
    response = {
      ...base,
      state: 'ready',
      scope: 'fragment',
      totalBytes: page.totalBytes,
      jsonText: page.jsonText,
      nextCursor: next(page.after),
      complete: page.complete,
    };
  } else {
    const record = backend.resolve(cursor.record!);
    if (cursor.mode === 'record') {
      if (backend.recordRoot(record) !== cursor.scopeRoot) return stale();
      const page = backend.fields(record, { after: cursor.after, items: 8, bytes: 12 * 1024 });
      if (page.root !== cursor.scopeRoot) return stale();
      checkedPage(page.complete, page.after, cursor.after, page.fields.length);
      const fields = page.fields.map((field) => {
        const header = {
          name: field.name,
          key: field.key,
          ...(field.keyFormat ? { keyFormat: field.keyFormat } : {}),
          ...(field.nameFragment
            ? {
                nameFragment: {
                  bytes: field.nameFragment.bytes,
                  cursor: encode({
                    ...pins,
                    format: 'health-intake-model-cursor-v2',
                    section: request.section,
                    mode: 'fragment',
                    record: cursor.record!,
                    field: field.nameFragment.key,
                    fieldFormat: 'name',
                    scopeRoot: field.nameFragment.root,
                  }),
                },
              }
            : {}),
        };
        if (field.kind === 'value') return { ...header, kind: 'value', value: field.value };
        if (field.kind === 'record')
          return { ...header, kind: 'record', record: reference(field.record) };
        return {
          ...header,
          kind: field.kind,
          ...(field.kind === 'children' ? { total: field.count } : { bytes: field.bytes }),
          cursor: encode({
            ...pins,
            format: 'health-intake-model-cursor-v2',
            section: request.section,
            mode: field.kind === 'children' ? 'children' : 'fragment',
            record: cursor.record!,
            field: field.key,
            ...(field.keyFormat ? { fieldFormat: field.keyFormat } : {}),
            scopeRoot: field.root,
          }),
        };
      });
      response = {
        ...base,
        state: 'ready',
        scope: 'record',
        recordKind: record.kind,
        fields,
        nextCursor: next(page.after),
        complete: page.complete,
      };
    } else if (cursor.mode === 'children') {
      const page = backend.children(record, cursor.field!, {
        keyFormat: cursor.fieldFormat,
        after: cursor.after,
        items: 8,
        bytes: 12 * 1024,
      });
      if (page.root !== cursor.scopeRoot) return stale();
      checkedPage(page.complete, page.after, cursor.after, page.records.length);
      response = {
        ...base,
        state: 'ready',
        scope: 'children',
        total: page.total,
        items: page.records.map(reference),
        nextCursor: next(page.after),
        complete: page.complete,
      };
    } else {
      const page = backend.fragment(record, cursor.field!, {
        keyFormat: cursor.fieldFormat,
        after: cursor.after,
        bytes: 4 * 1024,
      });
      if (page.root !== cursor.scopeRoot) return stale();
      checkedPage(page.complete, page.after, cursor.after, page.jsonText.length);
      response = {
        ...base,
        state: 'ready',
        scope: 'fragment',
        totalBytes: page.totalBytes,
        jsonText: page.jsonText,
        nextCursor: next(page.after),
        complete: page.complete,
      };
    }
  }
  if (size(response) > MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES)
    throw Error('Selected model context backend exceeded its bounded page budget');
  return response;
}

/** Actual db/source entry point; the host supplies its checked index and mapping providers. */
export function readCollectionModelIntakeContext(
  db: Database,
  source: IntakeEnvelopeSource,
  openBackend: (view: IntakeCollectionEnvelopeReader) => ModelIntakeSectionBackend,
  request: ModelIntakeContextRequestV2,
) {
  const view = openIntakeCollectionEnvelope(db, source);
  const backend = openBackend(view);
  const root = view.logical.root?.hash || '';
  if (
    backend.pins.sourceId !== source.id ||
    backend.pins.sourceHash !== source.sha256 ||
    backend.pins.logicalRoot !== root ||
    backend.pins.domainVersion !== view.logical.domainVersion
  )
    throw Error('Model context backend is not bound to the selected intake source');
  return modelIntakeContextV2(backend, request);
}

export type ModelCurrentUnitScopeV2 =
  | { state: 'pending'; total: null; items: readonly unknown[] }
  | { state: 'exact'; total: number; items: readonly unknown[] };

/** Small evidence context: no section traversal is hidden in summary construction. */
export function modelIntakeEvidenceContextV2(
  backend: ModelIntakeSectionBackend,
  currentUnits: ModelCurrentUnitScopeV2 = { state: 'pending', total: null, items: [] },
) {
  if (
    currentUnits.items.length > 8 ||
    (currentUnits.state === 'exact' &&
      (!Number.isSafeInteger(currentUnits.total) || currentUnits.total < currentUnits.items.length))
  )
    throw Error('Invalid bounded current-unit scope');
  const result = {
    format: 'health-intake-model-evidence-context-v2',
    pins: backend.pins,
    summary: backend.summary,
    currentUnits: {
      ...currentUnits,
      complete: currentUnits.state === 'exact' && currentUnits.total === currentUnits.items.length,
    },
    sections: MODEL_INTAKE_SECTIONS.map((section) => ({ section, ...backend.section(section) })),
    paging:
      'Use the version 2 context cursor protocol. Start each required section with freshStart and no cursor or pins; follow every nested scope and fragment cursor with the returned exact version and mappingVersion. Pending coverage is not complete.',
    identitySafety:
      'Equal clinical values do not prove one event. Compare complete occurrence, report, question and accepted-evidence scopes under the same pins before proposing a relationship.',
  };
  if (size(result) > 16 * 1024)
    throw Error('Model evidence context exceeded its bounded byte budget');
  return result;
}
