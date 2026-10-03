import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { currentTransactionToken, json, rejectCurrentTransaction } from './database.ts';
import { normalizeIntakeJson, type IntakeJson } from './intake-state-codec.ts';
import { createIntakeStateStorage } from './intake-state-storage.ts';
import {
  intakeNamespace,
  limits,
  parseIntakeHead,
  validateIntakeIdentity,
  type IntakeStateIdentity,
} from './intake-state-evidence.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  recordIntakeSerialization,
  recordIntakeWork,
  withIntakeWork,
} from './intake-work-accounting.ts';

export const INTAKE_ENVELOPE_FORMAT = 'health-intake-envelope-v1';
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
export function compactIntakeMetadata(value: unknown): Record<string, unknown> {
  envelope(value);
  return Object.fromEntries(
    Object.entries(value.intake).filter(([name]) => metadataFields.has(name)),
  );
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
function compact(value: unknown, mode: Mode, raw?: string): string {
  if (mode === 'raw') {
    if (raw === undefined) return fail('raw metadata requires exact text');
    const intakes = members(raw)
      .filter((member) => member.name === 'intake')
      .map((member) => {
        const retained = member.value.startsWith('{')
          ? '{' +
            members(member.value)
              .filter((entry) => metadataFields.has(entry.name))
              .map((entry) => `${entry.key}:${entry.value}`)
              .join(',') +
            '}'
          : 'null';
        return `${member.key}:${retained}`;
      });
    return `{"intakeAuthority":${recordIntakeSerialization(JSON.stringify({ format: INTAKE_ENVELOPE_FORMAT, mode }))},${intakes.join(',')}}`;
  }
  return recordIntakeSerialization(
    JSON.stringify({
      intakeAuthority: { format: INTAKE_ENVELOPE_FORMAT, mode },
      intake: compactIntakeMetadata(value),
    }),
  );
}
/** Validate the explicit current representation, never recognize legacy inline state. */
export function intakeEnvelopeMode(raw: unknown): Mode {
  const value = parse(raw);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'intake,intakeAuthority' ||
    !object(value.intakeAuthority) ||
    Object.keys(value.intakeAuthority).sort().join(',') !== 'format,mode' ||
    value.intakeAuthority.format !== INTAKE_ENVELOPE_FORMAT ||
    !['normalized', 'raw'].includes(String(value.intakeAuthority.mode)) ||
    !object(value.intake) ||
    Object.keys(value.intake).some((name) => !metadataFields.has(name))
  )
    return fail('unsupported or duplicated original authority');
  return value.intakeAuthority.mode as Mode;
}

/** Pure representation check shared with pre-publication copy/recovery validation. */
export function validateIntakeEnvelopeRepresentation(
  detailsJson: string,
  state: unknown,
): { value: Record<string, unknown>; text: string } {
  const mode = intakeEnvelopeMode(detailsJson);
  let value: unknown, text: string;
  if (mode === 'raw') {
    if (!object(state) || Object.keys(state).join(',') !== 'raw' || typeof state.raw !== 'string')
      return fail('raw mode requires its sole exact text');
    text = state.raw;
    value = parse(text);
  } else {
    value = state;
    text = JSON.stringify(state);
    if (typeof text !== 'string') return fail('missing selected envelope');
    recordIntakeSerialization(text);
    recordIntakeWork('envelopeSerializationCalls');
    recordIntakeWork('envelopeSerializedBytes', Buffer.byteLength(text));
  }
  envelope(value);
  if (compact(value, mode, text) !== detailsJson)
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
}
/** Small selected-head validation lets warm derived readers avoid loading intake views. */
export function intakeEnvelopeAuthorityBinding(
  db: DatabaseSync,
  source: IntakeEnvelopeSource,
): IntakeEnvelopeBinding {
  if (source.kind !== 'intake_original') {
    readNonIntakeEnvelope(source.details_json);
    return { key: null, head: null };
  }
  intakeEnvelopeMode(source.details_json);
  const selected = identity(db, source);
  const status = recordDurabilityStatus(db);
  if (!status?.configured || status.dirty) fail('requires configured current accepted authority');
  const key = intakeNamespace(selected) + 'head';
  const head = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
  if (!parseIntakeHead(head, selected, limits())) return fail('missing selected intake head');
  return { key, head: head as string };
}

export function readIntakeEnvelope(
  db: DatabaseSync,
  input: IntakeEnvelopeSource,
  sourceDTO = false,
): unknown {
  return withIntakeWork(db, 'warm', () => {
    const source = selectedSource(db, input);
    if (source.kind !== 'intake_original') return readNonIntakeEnvelope(source.details_json);
    intakeEnvelopeAuthorityBinding(db, source);
    const state = createIntakeStateStorage(db, identity(db, source)).read();
    const selected = validateIntakeEnvelopeRepresentation(source.details_json!, state);
    recordIntakeWork('envelopeHydrations');
    if (sourceDTO) {
      recordIntakeWork('sourceDTOHydrations');
      recordIntakeWork('sourceDTOEnvelopeBytes', Buffer.byteLength(selected.text));
    }
    return selected.value;
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
    intakeEnvelopeAuthorityBinding(db, source);
    const serialized = createIntakeStateStorage(db, identity(db, source)).readSerialized();
    if (serialized === undefined) return fail('missing selected envelope');
    const text = validateIntakeEnvelopeRepresentation(source.details_json!, parse(serialized)).text;
    recordIntakeWork('envelopeTextReads');
    return text;
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
      readIntakeEnvelope(db, source);
      if (intakeEnvelopeMode(source.details_json) === 'raw') {
        recordIntakeWork('rawNormalizations');
        // The selected raw text was already validated above; conversion volume is
        // accounted by the existing primitive normalization/serialization hooks.
      }
      const state = normalizeIntakeJson(next);
      envelope(state);
      const detailsJson = compact(state, 'normalized');
      createIntakeStateStorage(db, identity(db, source)).stage(state, randomUUID());
      if (detailsJson !== source.details_json)
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(detailsJson, source.id);
      const serialized = recordIntakeSerialization(JSON.stringify(state));
      recordIntakeWork('envelopeSerializationCalls');
      recordIntakeWork('envelopeSerializedBytes', Buffer.byteLength(serialized));
      return serialized;
    } catch (error) {
      rejectCurrentTransaction(db, error);
      throw error;
    }
  });
}
