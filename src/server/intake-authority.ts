import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  prepareIntakeJsonCanonical,
  type IntakeJsonCanonicalWork,
} from './intake-json-canonical.ts';
import { prepareIntakeJsonLexical, type IntakeJsonLexicalSpan } from './intake-json-lexical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import {
  COMPACT_SCALAR_BYTES,
  compactIntakeScalarSteps,
  isIntakeCompactScalar,
  type IntakeCompactScalarField,
} from './intake-compact-scalar.ts';
import type { DatabaseSync } from 'node:sqlite';
import {
  currentTransactionToken,
  json,
  rejectCurrentTransaction,
  type Database,
} from './database.ts';
import {
  cloneValidatedIntakeJson,
  normalizeIntakeJson,
  type IntakeJson,
} from './intake-state-codec.ts';
import { createIntakeStateStorage } from './intake-state-storage.ts';
import { parseSchemaControl } from './intake-envelope-schema.ts';
import {
  INTAKE_LEGACY_BRIDGE_CONTROL,
  assertIntakeLegacyBridgeReadWitness,
  type IntakeLegacyBridgeReadWitness,
} from './intake-state-migration.ts';
import {
  intakeNamespace,
  limits,
  parseIntakeHead,
  parseIntakeCollectionHead,
  COLLECTION_FORMAT,
  integer,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  recordIntakePrimitiveWork,
  recordIntakeSerialization,
  recordIntakeWork,
  withIntakeWork,
} from './intake-work-accounting.ts';

export const INTAKE_ENVELOPE_FORMAT = 'health-intake-envelope-v1';
export const INTAKE_COMPACT_ENVELOPE_FORMAT = 'health-intake-envelope-v2';
export type IntakeEnvelopeProjectionFormat =
  typeof INTAKE_ENVELOPE_FORMAT | typeof INTAKE_COMPACT_ENVELOPE_FORMAT;
export interface IntakeEnvelopeSource {
  id: string;
  kind?: string;
  sha256?: string;
  details_json?: string | null;
}
type Mode = 'normalized' | 'raw';
const metadataFields = new Set([
  'originalName',
  'acquisition',
  'metadata',
  'receivedMimeType',
  'createdAt',
  'parentSourceFileId',
  'locator',
  'derivative',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (reason: string): never => {
  throw Error(`Intake envelope authority: ${reason}`);
};
function parse(raw: unknown): unknown {
  if (typeof raw !== 'string') return fail('missing serialized evidence');
  try {
    recordIntakeWork('jsonParseCalls');
    recordIntakeWork('jsonParseBytes', Buffer.byteLength(raw));
    return JSON.parse(raw);
  } catch {
    return fail('invalid serialized evidence');
  }
}
function envelope(value: unknown): asserts value is Record<string, unknown> & {
  intake: Record<string, unknown>;
} {
  if (!object(value) || !object(value.intake)) return fail('missing original intake envelope');
  const workflow = value.intake.workflow;
  if (
    workflow !== undefined &&
    (!object(workflow) ||
      (workflow.format !== undefined && workflow.format !== 'health-intake-workflow-v1'))
  )
    fail('unsupported or incomplete workflow');
}

/** Preserve existing SQL metadata paths without retaining operational state. */
export function compactIntakeMetadata(
  value: unknown,
  format: IntakeEnvelopeProjectionFormat = INTAKE_ENVELOPE_FORMAT,
): Record<string, unknown> {
  envelope(value);
  return Object.fromEntries(
    Object.entries(value.intake)
      .filter(([name]) => metadataFields.has(name))
      .map(([name, item]) => [name, compactScalarValue(name, JSON.stringify(item), format, item)]),
  );
}
function compactScalarValue(
  name: string,
  text: string,
  format: IntakeEnvelopeProjectionFormat,
  value: unknown,
): unknown {
  if (
    format !== INTAKE_COMPACT_ENVELOPE_FORMAT ||
    !['originalName', 'locator'].includes(name) ||
    typeof value !== 'string' ||
    Buffer.byteLength(text) <= COMPACT_SCALAR_BYTES
  )
    return value;
  const steps = compactIntakeScalarSteps(name as IntakeCompactScalarField, [text]);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
function members(raw: string): Array<{ name: string; key: string; value: string }> {
  // Input has already passed JSON.parse. Scan lexical boundaries, preserving
  // duplicate members and escape spelling; SQLite selects first duplicates,
  // whereas operational JavaScript readers select the last.
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(raw[at] ?? '') && at < raw.length) at++;
  };
  whitespace();
  if (raw[at++] !== '{') return [];
  const result: Array<{ name: string; key: string; value: string }> = [];
  while (at < raw.length) {
    whitespace();
    if (raw[at] === '}') break;
    const start = at++;
    while (at < raw.length) {
      if (raw[at++] === '\\') at++;
      else if (raw[at - 1] === '"') break;
    }
    const key = raw.slice(start, at);
    whitespace();
    at++;
    whitespace();
    const valueStart = at;
    let depth = 0,
      quoted = false;
    while (at < raw.length) {
      const char = raw[at]!;
      if (quoted) {
        if (char === '\\') at++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && depth) depth--;
      else if (!depth && (char === ',' || char === '}')) break;
      at++;
    }
    result.push({ name: parse(key) as string, key, value: raw.slice(valueStart, at).trim() });
    if (raw[at++] !== ',') break;
  }
  return result;
}
function compact(
  value: unknown,
  mode: Mode,
  raw?: string,
  format: IntakeEnvelopeProjectionFormat = INTAKE_ENVELOPE_FORMAT,
): string {
  if (mode === 'raw') {
    if (raw === undefined) return fail('raw metadata requires exact text');
    const intakes = members(raw)
      .filter((member) => member.name === 'intake')
      .map((member) => {
        const retained = member.value.startsWith('{')
          ? '{' +
            members(member.value)
              .filter((entry) => metadataFields.has(entry.name))
              .map((entry) => {
                if (
                  format !== INTAKE_COMPACT_ENVELOPE_FORMAT ||
                  !['originalName', 'locator'].includes(entry.name) ||
                  Buffer.byteLength(entry.value) <= COMPACT_SCALAR_BYTES
                )
                  return `${entry.key}:${entry.value}`;
                const projected = compactScalarValue(
                  entry.name,
                  entry.value,
                  format,
                  parse(entry.value),
                );
                return `${entry.key}:${
                  projected && typeof projected === 'object' && isIntakeCompactScalar(projected)
                    ? JSON.stringify(projected)
                    : entry.value
                }`;
              })
              .join(',') +
            '}'
          : 'null';
        return `${member.key}:${retained}`;
      });
    return `{"intakeAuthority":${recordIntakeSerialization(JSON.stringify({ format, mode }))},${intakes.join(',')}}`;
  }
  return recordIntakeSerialization(
    JSON.stringify({
      intakeAuthority: { format, mode },
      intake: compactIntakeMetadata(value, format),
    }),
  );
}
/** Validate the explicit current representation, never recognize legacy inline state. */
export function intakeEnvelopeProjection(raw: unknown): {
  mode: Mode;
  format: IntakeEnvelopeProjectionFormat;
} {
  const value = parse(raw);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'intake,intakeAuthority' ||
    !object(value.intakeAuthority) ||
    Object.keys(value.intakeAuthority).sort().join(',') !== 'format,mode' ||
    ![INTAKE_ENVELOPE_FORMAT, INTAKE_COMPACT_ENVELOPE_FORMAT].includes(
      String(value.intakeAuthority.format),
    ) ||
    !['normalized', 'raw'].includes(String(value.intakeAuthority.mode)) ||
    !object(value.intake) ||
    Object.keys(value.intake).some((name) => !metadataFields.has(name))
  )
    return fail('unsupported or duplicated original authority');
  return {
    mode: value.intakeAuthority.mode as Mode,
    format: value.intakeAuthority.format as IntakeEnvelopeProjectionFormat,
  };
}
/** Classify a complete selected representation without decoding large metadata scalars. */
export async function prepareIntakeEnvelopeProjection(
  raw: string | Iterable<string>,
  options: {
    assertRunning?: () => void;
    onWork?: (work: Readonly<IntakeJsonCanonicalWork>) => void;
  } = {},
): Promise<{ mode: Mode; format: IntakeEnvelopeProjectionFormat }> {
  const tree = await prepareIntakeJsonCanonical(typeof raw === 'string' ? [raw] : raw, options);
  try {
    const allowed = (value: typeof tree.root, names: readonly string[]) => {
      if (tree.kind(value) !== 'object') return false;
      let count = 0;
      for (const field of tree.objectFields(value)) {
        options.assertRunning?.();
        if (!names.some((name) => field.matches(name))) return false;
        count++;
      }
      return count === names.length;
    };
    const smallString = (value: typeof tree.root | undefined): string | undefined => {
      if (!value || tree.kind(value) !== 'string') return undefined;
      let text = '';
      for (const piece of tree.pieces(value)) {
        options.assertRunning?.();
        text += piece;
        if (text.length > 128) return undefined;
      }
      return JSON.parse(text) as string;
    };
    const authority = tree.field(tree.root, 'intakeAuthority'),
      intake = tree.field(tree.root, 'intake');
    if (
      !allowed(tree.root, ['intake', 'intakeAuthority']) ||
      !authority ||
      !allowed(authority, ['format', 'mode']) ||
      !intake ||
      tree.kind(intake) !== 'object'
    )
      return fail('unsupported or duplicated original authority');
    for (const field of tree.objectFields(intake)) {
      options.assertRunning?.();
      if (![...metadataFields].some((name) => field.matches(name)))
        return fail('unsupported or duplicated original authority');
    }
    const format = smallString(tree.field(authority, 'format')),
      mode = smallString(tree.field(authority, 'mode'));
    if (
      (format !== INTAKE_ENVELOPE_FORMAT && format !== INTAKE_COMPACT_ENVELOPE_FORMAT) ||
      (mode !== 'normalized' && mode !== 'raw')
    )
      return fail('unsupported or duplicated original authority');
    options.assertRunning?.();
    return { format, mode };
  } finally {
    tree.close();
  }
}
/** Compare selected metadata exactly, including raw duplicate members and escape spelling. */
async function prepareIntakeEnvelopeRepresentation(
  detailsJson: string | (() => Iterable<string>),
  raw: string,
  expectedMode: Mode | undefined,
  options: { assertRunning?: () => void } = {},
  checkedProjection?: { mode: Mode; format: IntakeEnvelopeProjectionFormat },
): Promise<{ version: number; text: string }> {
  const details = typeof detailsJson === 'string' ? () => [detailsJson] : detailsJson;
  const projection =
    checkedProjection ?? (await prepareIntakeEnvelopeProjection(details(), options));
  if (expectedMode !== undefined && projection.mode !== expectedMode)
    return fail('selected metadata mode changed');
  const lexical = await prepareIntakeJsonLexical([raw], options);
  const selected = details()[Symbol.iterator]();
  let expected = '',
    expectedAt = 0,
    pieces = 0;
  const current = async () => {
    options.assertRunning?.();
    if (++pieces % 64 === 0) {
      await setImmediate();
      options.assertRunning?.();
    }
  };
  const compare = async (piece: string) => {
    await current();
    let at = 0;
    while (at < piece.length) {
      if (expectedAt === expected.length) {
        options.assertRunning?.();
        const next = selected.next();
        if (next.done) fail('compact metadata conflicts with selected state');
        expected = next.value;
        expectedAt = 0;
        if (!expected) continue;
      }
      const size = Math.min(piece.length - at, expected.length - expectedAt);
      if (piece.slice(at, at + size) !== expected.slice(expectedAt, expectedAt + size))
        fail('compact metadata conflicts with selected state');
      at += size;
      expectedAt += size;
    }
  };
  const compareSpan = async (start: number, end: number) => {
    for (const piece of lexical.pieces(start, end)) await compare(piece);
  };
  const scalarPieces = function* (start: number, end: number) {
    let high = '';
    for (const piece of lexical.pieces(start, end)) {
      const joined = high + piece;
      high = /[\uD800-\uDBFF]$/.test(joined) ? joined.slice(-1) : '';
      const whole = high ? joined.slice(0, -1) : joined;
      if (whole) yield whole;
    }
    if (high) yield high;
  };
  const scalar = async (span: IntakeJsonLexicalSpan, max: number): Promise<unknown> => {
    let value = '',
      long = false,
      number: number | undefined;
    const steps = hashIntakeJsonScalarSteps(
      scalarPieces(span.start, span.end),
      [],
      (unit) => {
        if (value.length < max) value += unit;
        else long = true;
      },
      (parsed) => {
        number = parsed;
      },
    );
    for (;;) {
      options.assertRunning?.();
      const next = steps.next();
      if (next.done) {
        if (next.value.kind === 'string') return long ? undefined : value;
        if (next.value.kind === 'number') return number;
        return next.value.kind === 'null' ? null : undefined;
      }
      await setImmediate();
    }
  };
  const name = (span: IntakeJsonLexicalSpan) =>
    scalar({ ...span, start: span.nameStart!, end: span.nameEnd! }, 64);
  const isLongString = async (span: IntakeJsonLexicalSpan) => {
    if (lexical.pieces(span.start, span.start + 1).next().value !== '"') return false;
    let bytes = 0,
      high = '';
    for (const piece of lexical.pieces(span.start, span.end)) {
      options.assertRunning?.();
      const combined = high + piece;
      high = /[\uD800-\uDBFF]$/.test(combined) ? combined.slice(-1) : '';
      bytes += Buffer.byteLength(high ? combined.slice(0, -1) : combined);
      if (bytes > COMPACT_SCALAR_BYTES) return true;
      await current();
    }
    return bytes + Buffer.byteLength(high) > COMPACT_SCALAR_BYTES;
  };
  try {
    if (lexical.root.shape !== 'object') return fail('missing original intake envelope');
    await compare(
      '{"intakeAuthority":' +
        JSON.stringify({ format: projection.format, mode: projection.mode }) +
        ',',
    );
    let occurrences = 0,
      lastIntake: IntakeJsonLexicalSpan | undefined;
    for (const entry of lexical.children(lexical.root)) {
      if ((await name(entry)) !== 'intake') continue;
      lastIntake = entry;
      if (occurrences++) await compare(',');
      await compareSpan(entry.nameStart!, entry.nameEnd!);
      await compare(':');
      if (entry.shape !== 'object') {
        await compare('null');
        continue;
      }
      await compare('{');
      let retained = 0;
      for (const field of lexical.children(entry)) {
        const fieldName = await name(field);
        if (typeof fieldName !== 'string' || !metadataFields.has(fieldName)) continue;
        if (retained++) await compare(',');
        await compareSpan(field.nameStart!, field.nameEnd!);
        await compare(':');
        if (
          projection.format === INTAKE_COMPACT_ENVELOPE_FORMAT &&
          (fieldName === 'originalName' || fieldName === 'locator') &&
          (await isLongString(field))
        ) {
          const steps = compactIntakeScalarSteps(fieldName, scalarPieces(field.start, field.end));
          for (;;) {
            options.assertRunning?.();
            const next = steps.next();
            if (next.done) {
              if (isIntakeCompactScalar(next.value)) await compare(JSON.stringify(next.value));
              else await compareSpan(field.start, field.end);
              break;
            }
            await setImmediate();
          }
        } else await compareSpan(field.start, field.end);
      }
      await compare('}');
    }
    await compare('}');
    if (projection.mode === 'normalized' && occurrences !== 1)
      return fail('missing original intake envelope');
    if (expectedAt < expected.length || !selected.next().done)
      fail('compact metadata conflicts with selected state');
    if (!lastIntake || lastIntake.shape !== 'object')
      return fail('missing original intake envelope');
    let workflow: IntakeJsonLexicalSpan | undefined, version: IntakeJsonLexicalSpan | undefined;
    for (const field of lexical.children(lastIntake)) {
      const fieldName = await name(field);
      if (fieldName === 'workflow') workflow = field;
      if (fieldName === 'version') version = field;
    }
    if (workflow) {
      if (workflow.shape !== 'object') return fail('unsupported or incomplete workflow');
      let format: unknown,
        formatSeen = false;
      for (const field of lexical.children(workflow)) {
        if ((await name(field)) === 'format') {
          formatSeen = true;
          format = await scalar(field, 64);
        }
      }
      if (formatSeen && format !== 'health-intake-workflow-v1')
        return fail('unsupported or incomplete workflow');
    }
    if (!version) return fail('missing legacy intake version');
    const selectedVersion = await scalar(version, 0);
    integer(selectedVersion);
    options.assertRunning?.();
    return { version: selectedVersion, text: raw };
  } finally {
    lexical.close();
  }
}
export function prepareRawIntakeEnvelopeRepresentation(
  detailsJson: string | (() => Iterable<string>),
  raw: string,
  options: { assertRunning?: () => void } = {},
): Promise<{ version: number; text: string }> {
  return prepareIntakeEnvelopeRepresentation(detailsJson, raw, 'raw', options);
}
export function prepareNormalizedIntakeEnvelopeRepresentation(
  detailsJson: string | (() => Iterable<string>),
  serialized: string,
  options: { assertRunning?: () => void } = {},
): Promise<{ version: number; text: string }> {
  return prepareIntakeEnvelopeRepresentation(detailsJson, serialized, 'normalized', options);
}
export function intakeEnvelopeMode(raw: unknown): Mode {
  return intakeEnvelopeProjection(raw).mode;
}

/** Pure representation check shared with pre-publication copy/recovery validation. */
export function validateIntakeEnvelopeRepresentation(
  detailsJson: string,
  state: unknown,
): { value: Record<string, unknown>; text: string } {
  return validateRepresentation(detailsJson, state);
}
function validateRepresentation(
  detailsJson: string,
  state: unknown,
  serialized?: string,
): { value: Record<string, unknown>; text: string } {
  const { mode, format } = intakeEnvelopeProjection(detailsJson);
  let value: unknown, text: string;
  if (mode === 'raw') {
    if (!object(state) || Object.keys(state).join(',') !== 'raw' || typeof state.raw !== 'string')
      return fail('raw mode requires its sole exact text');
    text = state.raw;
    value = parse(text);
  } else {
    value = state;
    text = serialized ?? JSON.stringify(state);
    if (typeof text !== 'string') return fail('missing selected envelope');
    if (serialized === undefined) {
      recordIntakeSerialization(text);
      recordIntakeWork('envelopeSerializationCalls');
      recordIntakeWork('envelopeSerializedBytes', Buffer.byteLength(text));
    }
  }
  envelope(value);
  if (compact(value, mode, text, format) !== detailsJson)
    fail('compact metadata conflicts with selected state');
  return { value, text };
}

function selectedSource(db: DatabaseSync, source: IntakeEnvelopeSource): IntakeEnvelopeSource {
  const row = db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(source.id);
  if (!row) return fail('missing source');
  return row as unknown as IntakeEnvelopeSource;
}
export interface PagedIntakeEnvelopeSource extends IntakeEnvelopeSource {
  metadataBytes: number;
}
export function selectedSourceHeader(
  db: Database,
  source: IntakeEnvelopeSource,
): PagedIntakeEnvelopeSource {
  const row = db
    .prepare(
      'SELECT id,kind,sha256,typeof(details_json) AS metadataType,length(CAST(details_json AS BLOB)) AS metadataBytes FROM main.source_files WHERE id=?',
    )
    .get(source.id);
  if (
    !row ||
    row.metadataType !== 'text' ||
    !Number.isSafeInteger(row.metadataBytes) ||
    Number(row.metadataBytes) < 0
  )
    return fail('missing source');
  return { ...row, metadataBytes: Number(row.metadataBytes) } as PagedIntakeEnvelopeSource;
}
export function selectedDetailsPages(
  db: Database,
  source: PagedIntakeEnvelopeSource,
  assertCurrent: () => void,
): Iterable<string> {
  const pageBytes = 64 * 1024;
  return {
    *[Symbol.iterator]() {
      const read = db.prepare(
        'SELECT substr(CAST(details_json AS BLOB),?,?) AS data FROM main.source_files WHERE id=?',
      );
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      for (let at = 0; at < source.metadataBytes; at += pageBytes) {
        assertCurrent();
        const size = Math.min(pageBytes, source.metadataBytes - at);
        const data = read.get(at + 1, size, source.id)?.data;
        assertCurrent();
        if (!(data instanceof Uint8Array) || data.length !== size)
          return fail('selected metadata page changed');
        recordIntakePrimitiveWork(db, 'metadataReads');
        recordIntakePrimitiveWork(db, 'metadataReadBytes', data.length);
        recordIntakePrimitiveWork(db, 'selectedMetadataSqlPages');
        recordIntakePrimitiveWork(db, 'selectedMetadataSqlReadBytes', data.length);
        const text = decoder.decode(data, { stream: true });
        if (text) yield text;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
      assertCurrent();
    },
  };
}
export function readNonIntakeEnvelope(raw: unknown): unknown {
  const value = json(raw);
  if (object(value) && Object.hasOwn(value, 'intakeAuthority'))
    return fail('intake authority is bound to a non-original source');
  return value;
}
function identity(db: DatabaseSync, source: IntakeEnvelopeSource): IntakeStateIdentity {
  return validateIntakeIdentity({
    profileId: db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()
      ?.value as string,
    intakeId: source.id,
    sourceHash: source.sha256 as string,
  });
}
export interface IntakeEnvelopeBinding {
  key: string | null;
  head: string | null;
  /** Present only for V4. Receipt/build churn preserves this logical binding. */
  logicalHead?: string;
}
const checkedProjectionHints = new WeakMap<
  DatabaseSync,
  { details: string; projection: { mode: Mode; format: IntakeEnvelopeProjectionFormat } }
>();
declare const selectedBridgeBrand: unique symbol;
export interface PreparedSelectedIntakeEnvelope {
  readonly [selectedBridgeBrand]: true;
}
const selectedBridgeProofs = new WeakMap<
  PreparedSelectedIntakeEnvelope,
  {
    db: Database;
    originalRead: IntakeLegacyBridgeReadWitness;
    id: string;
    sourceHash: string;
    beforeHead: string;
    metadataBytes: number;
    detailsDigest: string;
    textDigest: string;
    mode: Mode;
    version: number;
  }
>();
/** A one-use result of the actual complete selected read, never a caller digest. */
export function consumeSelectedIntakeEnvelopeForBridge(
  db: Database,
  proof: PreparedSelectedIntakeEnvelope,
  originalRead: IntakeLegacyBridgeReadWitness,
  id: string,
  beforeHead: string,
) {
  const item = selectedBridgeProofs.get(proof);
  selectedBridgeProofs.delete(proof);
  if (
    !item ||
    item.db !== db ||
    item.originalRead !== originalRead ||
    item.id !== id ||
    item.beforeHead !== beforeHead
  )
    return fail('foreign or expired selected intake proof');
  assertIntakeLegacyBridgeReadWitness(db, originalRead);
  return Object.freeze({ ...item });
}
/** Small selected-head validation lets warm derived readers avoid loading intake views. */
export function intakeEnvelopeAuthorityBinding(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
): IntakeEnvelopeBinding {
  return intakeEnvelopeAuthorityBindingChecked(db, source);
}
function intakeEnvelopeAuthorityBindingChecked(
  db: DatabaseSync,
  source: IntakeEnvelopeSource & { metadataBytes?: number },
  projection?: { mode: Mode; format: IntakeEnvelopeProjectionFormat },
): IntakeEnvelopeBinding {
  const known = checkedProjectionHints.get(db);
  const selectedProjection =
    projection ?? (known?.details === source.details_json ? known?.projection : undefined);
  if (source.kind !== 'intake_original') {
    readNonIntakeEnvelope(source.details_json);
    return { key: null, head: null };
  }
  const selected = identity(db, source);
  const status = recordDurabilityStatus(db);
  if (!status?.configured || status.dirty || status.conflicted)
    fail('requires configured current accepted authority');
  const key = intakeNamespace(selected) + 'head';
  const head = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
  if (
    typeof head === 'string' &&
    Buffer.byteLength(head) <= 4096 &&
    (parse(head) as Record<string, unknown>)?.format === COLLECTION_FORMAT
  ) {
    const checked = parseIntakeCollectionHead(head, selected)!;
    // Classification is not metadata admission. Cold giant native metadata is
    // checked cooperatively against the exact graph before presentation.
    if (
      (source.metadataBytes ??
        (typeof source.details_json === 'string' ? source.details_json.length : 0)) >
      COMPACT_SCALAR_BYTES
    ) {
      const collections = createIntakeStateStorage(db, selected).collections;
      const view = collections.openView();
      const control = collections.get(view, 'logical', 'envelope.control', 'representation');
      if (control !== INTAKE_LEGACY_BRIDGE_CONTROL) {
        parseSchemaControl(control);
        if (!collections.collection(view, 'logical', 'envelope.data'))
          fail('missing selected envelope data');
        return { key, head, logicalHead: JSON.stringify(checked.logical) };
      }
    }
    if (!selectedProjection) intakeEnvelopeMode(source.details_json);
    return { key, head, logicalHead: JSON.stringify(checked.logical) };
  }
  if (!selectedProjection) intakeEnvelopeMode(source.details_json);
  if (!parseIntakeHead(head, selected, limits())) return fail('missing selected intake head');
  return { key, head: head as string };
}
/** Reader formatting hint only; never certifies metadata or grants publication. */
export function intakeEnvelopeProjectionFormatHint(raw: unknown): IntakeEnvelopeProjectionFormat {
  if (typeof raw === 'string' && raw.length > COMPACT_SCALAR_BYTES) {
    return raw.startsWith('{"intakeAuthority":{"format":"' + INTAKE_COMPACT_ENVELOPE_FORMAT + '"')
      ? INTAKE_COMPACT_ENVELOPE_FORMAT
      : INTAKE_ENVELOPE_FORMAT;
  }
  return intakeEnvelopeProjection(raw).format;
}

type StateMaterialization = NonNullable<
  ReturnType<ReturnType<typeof createIntakeStateStorage>['readMaterialization']>
>;
export interface IntakeEnvelopeMaterialization {
  readonly mode: Mode;
  /** Internal immutable view. Public readers receive a detached mutable copy. */
  readonly value: Record<string, unknown>;
  readonly text: string;
  /** Exact text digest only when primitive serialization is the envelope text. */
  readonly fingerprint: string | null;
}
const materializedEnvelopes = new WeakMap<
  StateMaterialization,
  { detailsJson: string; envelope: IntakeEnvelopeMaterialization }
>();
function freezeEnvelope(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const child = pending.pop();
    if (!child || typeof child !== 'object') continue;
    for (const nested of Object.values(child)) pending.push(nested);
    Object.freeze(child);
    recordIntakeWork('immutableNodesFrozen');
  }
}
function selectedEnvelope(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
): { state: StateMaterialization; envelope: IntakeEnvelopeMaterialization } {
  const storage = createIntakeStateStorage(db, identity(db, source));
  const selected = intakeEnvelopeAuthorityBinding(db, source);
  const state =
    selected.logicalHead === undefined
      ? storage.readMaterialization()
      : storage.collections.readLegacyMaterialization();
  if (!state) return fail('missing selected envelope');
  const prior = materializedEnvelopes.get(state);
  if (prior && prior.detailsJson === source.details_json)
    return { state, envelope: prior.envelope };
  const representation = validateRepresentation(
    source.details_json!,
    state.value,
    state.serialized,
  );
  const mode = intakeEnvelopeMode(source.details_json);
  if (mode === 'raw') freezeEnvelope(representation.value);
  const result = Object.freeze({
    mode,
    value: representation.value,
    text: representation.text,
    fingerprint: mode === 'normalized' ? state.fingerprint : null,
  });
  materializedEnvelopes.set(state, { detailsJson: source.details_json!, envelope: result });
  return { state, envelope: result };
}
/** Internal selected original view; reuse never substitutes for current authority checks. */
export function readIntakeEnvelopeMaterialized(
  db: DatabaseSync,
  input: IntakeEnvelopeSource,
): IntakeEnvelopeMaterialization {
  return withIntakeWork(db, 'warm', () => {
    const source = selectedSource(db, input);
    if (source.kind !== 'intake_original') return fail('materialization requires an original');
    return selectedEnvelope(db, source).envelope;
  });
}

/** Build-only selected reader. The caller's original authority witness must
 * remain live across every cooperative cold-replay and metadata step. */
export async function readIntakeEnvelopeMaterializedForBuild(
  db: Database,
  input: IntakeEnvelopeSource,
  originalRead: IntakeLegacyBridgeReadWitness,
): Promise<{
  mode: Mode;
  version: number;
  text: string;
  fingerprint: string | null;
  selectedProof: PreparedSelectedIntakeEnvelope;
}> {
  const assertCurrent = () => assertIntakeLegacyBridgeReadWitness(db, originalRead);
  assertCurrent();
  const source = selectedSourceHeader(db, input);
  if (source.kind !== 'intake_original') return fail('materialization requires an original');
  let detailsDigest: string | undefined;
  const detailsPieces = () => ({
    *[Symbol.iterator]() {
      const digest = createHash('sha256');
      for (const piece of selectedDetailsPages(db, source, assertCurrent)) {
        digest.update(piece, 'utf8');
        yield piece;
      }
      const observed = digest.digest('hex');
      if (detailsDigest !== undefined && detailsDigest !== observed)
        return fail('selected metadata changed between validation passes');
      detailsDigest = observed;
    },
  });
  const details = source.metadataBytes <= 64 * 1024 ? [...detailsPieces()].join('') : undefined;
  const projection =
    details !== undefined
      ? intakeEnvelopeProjection(details)
      : await prepareIntakeEnvelopeProjection(detailsPieces(), { assertRunning: assertCurrent });
  assertCurrent();
  // Deterministic classification only. Selected SQL/head and original read
  // authority are still checked on every subsequent binding.
  if (details !== undefined) checkedProjectionHints.set(db, { details, projection });
  const binding = intakeEnvelopeAuthorityBindingChecked(db, source, projection);
  const storage = createIntakeStateStorage(db, identity(db, source));
  const state = binding.logicalHead
    ? await storage.collections.readLegacyMaterializationAsync(assertCurrent)
    : await storage.readMaterializationAsync(assertCurrent);
  if (!state) return fail('missing selected envelope');
  assertCurrent();
  let text: string;
  if (projection.mode === 'raw') {
    if (Object.keys(state.value).join(',') !== 'raw' || typeof state.value.raw !== 'string')
      return fail('raw mode requires its sole exact text');
    text = state.value.raw;
  } else text = state.serialized;
  const version =
    details !== undefined && Buffer.byteLength(text) <= 64 * 1024
      ? (() => {
          const validated = validateRepresentation(details, state.value, state.serialized);
          const intake = validated.value.intake;
          if (!object(intake)) return fail('missing original intake envelope');
          integer(intake.version);
          return intake.version as number;
        })()
      : (
          await prepareIntakeEnvelopeRepresentation(
            details ?? detailsPieces,
            text,
            projection.mode,
            { assertRunning: assertCurrent },
            projection,
          )
        ).version;
  assertCurrent();
  const current = selectedSourceHeader(db, input);
  if (
    current.metadataBytes !== source.metadataBytes ||
    current.sha256 !== source.sha256 ||
    current.kind !== source.kind
  )
    return fail('selected original changed');
  const currentBinding = intakeEnvelopeAuthorityBindingChecked(db, current, projection);
  if (currentBinding.head !== binding.head || currentBinding.logicalHead !== binding.logicalHead)
    return fail('selected head changed');
  assertCurrent();
  if (!detailsDigest || !binding.head || !source.sha256)
    return fail('incomplete selected intake proof');
  const textDigest = createHash('sha256').update(text).digest('hex');
  assertCurrent();
  const selectedProof = Object.freeze({}) as PreparedSelectedIntakeEnvelope;
  selectedBridgeProofs.set(selectedProof, {
    db,
    originalRead,
    id: source.id,
    sourceHash: source.sha256,
    beforeHead: binding.head,
    metadataBytes: source.metadataBytes,
    detailsDigest,
    textDigest,
    mode: projection.mode,
    version,
  });
  return {
    mode: projection.mode,
    version,
    text,
    fingerprint: projection.mode === 'normalized' ? state.fingerprint : null,
    selectedProof,
  };
}
export function readIntakeEnvelope(
  db: DatabaseSync,
  input: IntakeEnvelopeSource,
  sourceDTO = false,
): unknown {
  return withIntakeWork(db, 'warm', () => {
    const source = selectedSource(db, input);
    if (source.kind !== 'intake_original') return readNonIntakeEnvelope(source.details_json);
    const { state, envelope: selected } = selectedEnvelope(db, source);
    recordIntakeWork('envelopeHydrations');
    recordIntakePrimitiveWork(db, 'readCopies');
    recordIntakePrimitiveWork(db, 'readCopyBytes', Buffer.byteLength(selected.text));
    if (sourceDTO) {
      recordIntakeWork('sourceDTOHydrations');
      recordIntakeWork('sourceDTOEnvelopeBytes', Buffer.byteLength(selected.text));
    }
    return selected.mode === 'raw' ? parse(selected.text) : cloneValidatedIntakeJson(state.value);
  });
}
export function readIntakeEnvelopeText(db: DatabaseSync, input: IntakeEnvelopeSource): string {
  return withIntakeWork(db, 'warm', () => {
    const source = selectedSource(db, input);
    if (source.kind !== 'intake_original') {
      readNonIntakeEnvelope(source.details_json);
      if (typeof source.details_json !== 'string') return fail('missing source details');
      return source.details_json;
    }
    const selected = selectedEnvelope(db, source).envelope;
    recordIntakeWork('envelopeTextReads');
    return selected.text;
  });
}

export function prepareInitialIntakeEnvelope(input: Record<string, unknown> | string): {
  detailsJson: string;
  state: IntakeJson;
} {
  const mode: Mode = typeof input === 'string' ? 'raw' : 'normalized';
  const state = mode === 'raw' ? { raw: input as string } : normalizeIntakeJson(input);
  const value = mode === 'raw' ? parse(input) : state;
  envelope(value);
  return {
    detailsJson: compact(value, mode, typeof input === 'string' ? input : undefined),
    state,
  };
}
function requireTransaction(db: DatabaseSync): void {
  if (!currentTransactionToken(db) || !db.isTransaction)
    fail('writes require the existing application transaction');
}
/** The caller inserted the prepared compact source in this same transaction. */
export function initializeIntakeEnvelope(
  db: DatabaseSync,
  input: IntakeEnvelopeSource,
  next: Record<string, unknown> | string,
): void {
  return withIntakeWork(db, 'warm', () => {
    requireTransaction(db);
    try {
      const source = selectedSource(db, input);
      if (source.kind !== 'intake_original') fail('initial state requires an original');
      const prepared = prepareInitialIntakeEnvelope(next);
      if (source.details_json !== prepared.detailsJson) fail('initial compact source mismatch');
      const selected = identity(db, source);
      if (
        db
          .prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1')
          .get(intakeNamespace(selected) + '*')
      )
        fail('initial authority already exists');
      createIntakeStateStorage(db, selected).stage(prepared.state, randomUUID());
    } catch (error) {
      rejectCurrentTransaction(db, error);
      throw error;
    }
  });
}
/** Ordinary writes may normalize raw initial evidence once; they never regress to raw mode. */
export function stageIntakeEnvelope(
  db: DatabaseSync,
  input: IntakeEnvelopeSource,
  next: Record<string, unknown>,
): string {
  return withIntakeWork(db, 'warm', () => {
    requireTransaction(db);
    try {
      const source = selectedSource(db, input);
      if (source.kind !== 'intake_original') fail('operational write requires an original');
      const selected = selectedEnvelope(db, source).envelope;
      if (selected.mode === 'raw') {
        recordIntakeWork('rawNormalizations');
        // The selected raw text was already validated above; conversion volume is
        // accounted by the existing primitive normalization/serialization hooks.
      }
      const storage = createIntakeStateStorage(db, identity(db, source));
      const prepared = storage.prepare(next);
      const state = storage.inspectPrepared(prepared);
      envelope(state.value);
      const detailsJson = compact(state.value, 'normalized');
      storage.stagePrepared(prepared, randomUUID());
      if (detailsJson !== source.details_json)
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(detailsJson, source.id);
      return state.serialized;
    } catch (error) {
      rejectCurrentTransaction(db, error);
      throw error;
    }
  });
}
