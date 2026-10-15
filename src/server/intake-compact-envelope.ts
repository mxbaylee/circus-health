import type { EnvelopeCellReader } from './intake-collection-envelope.ts';
import { toUSVString } from 'node:util';
import { schemaKey, type SchemaControl, type SchemaTarget } from './intake-envelope-schema.ts';
import {
  cellChunks,
  header,
  iterateSchemaRecordValue,
  orderEntries,
} from './intake-schema-record-stream.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { intakeCopyTrimmedPieceSteps } from './intake-copy-json.ts';
import { prepareIntakeCopyPieceSpoolSteps } from './intake-copy-json.ts';
import { prepareIntakeJsonCanonicalSteps } from './intake-json-canonical.ts';
import { INTAKE_ENVELOPE_FORMAT, type IntakeEnvelopeProjectionFormat } from './intake-authority.ts';
import {
  compactIntakeScalar,
  COMPACT_SCALAR_BYTES,
  type IntakeCompactScalarField,
} from './intake-compact-scalar.ts';
import { parseIntakeFilenameFacts } from './intake-filename-facts.ts';
import type { IntakeStateIdentity } from './intake-state-evidence.ts';
import type { IntakeTreeRef } from './intake-state-tree.ts';
import type { IntakeReferencedSourceLabel } from './intake-referenced-envelope-codec.ts';
export {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
  parseIntakeReferencedEnvelope,
  type IntakeReferencedEnvelope,
  type IntakeReferencedSourceLabel,
} from './intake-referenced-envelope-codec.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from './intake-referenced-envelope-codec.ts';

const fail = (reason: string): never => {
  throw Error(`Intake collection envelope: ${reason}`);
};

/** Bounded descriptor grammar over a selected graph; the caller must prove the
 * graph and same-commit source/HEAD binding before publishing its result. */
export function* projectIntakeReferencedEnvelopeSteps(
  store: EnvelopeCellReader,
  control: SchemaControl,
  identity: IntakeStateIdentity,
  storageSequence: number,
  logicalRoot: IntakeTreeRef,
): Generator<void, string> {
  if (control.format !== 'health-intake-record-envelope-v1') fail('referenced schema');
  store.check();
  const member = function* (
    record: string,
    name: string,
  ): Generator<void, SchemaTarget | undefined> {
    if (header(store, record).shape !== 'object') fail('referenced field parent');
    const wanted = schemaKey(name);
    let selected: SchemaTarget | undefined;
    let count = 0;
    for (const entry of orderEntries(store, record)) {
      if (++count % 64 === 0) {
        store.check();
        yield;
      }
      if (
        entry.name !== undefined &&
        (yield* hashIntakeJsonScalarSteps(cellChunks(store, 'n:' + entry.name))).hash === wanted
      )
        selected = entry.target;
    }
    return selected;
  };
  const intake = yield* member(control.root, 'intake');
  if (!intake || intake.type !== 'record') return fail('referenced intake');
  const metadata = yield* member(intake.id, 'metadata');
  let sourceLabel: IntakeReferencedSourceLabel = { kind: 'missing' };
  if (metadata) {
    if (metadata.type === 'record') {
      if (header(store, metadata.id).shape === 'object') {
        const source = yield* member(metadata.id, 'source');
        if (source) {
          if (source.type !== 'cell') fail('referenced source label');
          sourceLabel = yield* label(source.id);
        }
      }
    }
  }
  store.check();
  return encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity,
      mode: control.mode,
      storageSequence,
      logicalRoot,
      sourceLabel,
    },
  });

  function* label(id: string): Generator<void, IntakeReferencedSourceLabel> {
    let bytes = 0,
      units = 0,
      preview = '';
    const pieces = function* () {
      for (const piece of cellChunks(store, 'c:' + id)) {
        bytes += Buffer.byteLength(piece);
        yield piece;
      }
    };
    const scalarSteps = hashIntakeJsonScalarSteps(pieces(), [], (unit) => {
      if (units++ < 120) preview += unit;
    });
    let scalar: ReturnType<typeof hashIntakeJsonScalarSteps> extends Generator<void, infer T>
      ? T
      : never;
    try {
      for (;;) {
        const next = scalarSteps.next();
        if (next.done) {
          scalar = next.value;
          break;
        }
        store.check();
        yield;
      }
    } finally {
      scalarSteps.return(undefined as never);
    }
    if (scalar.kind === 'null') return { kind: 'null' };
    if (scalar.kind !== 'string') fail('referenced source label');
    if (units > 120 && /[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
    const rawPreview = preview,
      shown = toUSVString(rawPreview);
    if (shown.length > 120) preview = shown.slice(0, 120);
    else preview = shown;
    return {
      kind: 'string',
      scalarHash: scalar.hash,
      bytes,
      preview,
      truncated: units > 120 || shown !== rawPreview,
    };
  }
}

/** This is a selector over an already authenticated selected graph, not an
 * authority check or a way to publish a source projection. */
export function* selectedIntakeFieldPiecesSteps(
  store: EnvelopeCellReader,
  control: SchemaControl,
  path: readonly string[],
): Generator<string | void, boolean> {
  if (
    control.format !== 'health-intake-record-envelope-v1' ||
    (control.mode !== 'raw' && control.mode !== 'normalized') ||
    !/^[a-f0-9]{64}$/.test(control.root) ||
    path.length < 1 ||
    path.length > 8 ||
    path.some((name) => typeof name !== 'string' || Buffer.byteLength(name) > 256)
  )
    fail('selected field path');
  store.check();
  let record = control.root;
  for (let depth = 0; depth < path.length; depth++) {
    if (header(store, record).shape !== 'object') fail('selected field parent');
    const wanted = schemaKey(path[depth]!);
    let selected: SchemaTarget | undefined;
    let count = 0;
    for (const entry of orderEntries(store, record)) {
      if (++count % 64 === 0) {
        store.check();
        yield;
      }
      if (
        entry.name !== undefined &&
        (yield* hashIntakeJsonScalarSteps(cellChunks(store, 'n:' + entry.name))).hash === wanted
      )
        selected = entry.target;
    }
    if (!selected) {
      store.check();
      return false;
    }
    if (depth < path.length - 1) {
      if (selected.type !== 'record') fail('selected field parent');
      record = selected.id;
      continue;
    }
    const pieces =
      selected.type === 'cell'
        ? cellChunks(store, 'c:' + selected.id)
        : iterateSchemaRecordValue(store, selected.id);
    for (const piece of intakeCopyTrimmedPieceSteps(pieces)) {
      store.check();
      if (typeof piece === 'string' && Buffer.byteLength(piece) > 16 * 1024)
        fail('selected field piece budget');
      yield piece;
    }
    store.check();
    return true;
  }
  return fail('selected field path');
}

/** The exact selected source-row projection grammar, emitted without retaining
 * the resulting metadata. Call only with an authenticated selected graph. */
export function* schemaCompactMetadataPiecesSteps(
  store: EnvelopeCellReader,
  control: SchemaControl,
  format: IntakeEnvelopeProjectionFormat,
): Generator<string | void> {
  const metadata = new Map(
    [
      'originalName',
      'acquisition',
      'metadata',
      'receivedMimeType',
      'createdAt',
      'parentSourceFileId',
      'locator',
      'derivative',
    ].map((name) => [schemaKey(name), name]),
  );
  const nameHash = function* (entry: { name?: string }): Generator<void, string | undefined> {
    return entry.name === undefined
      ? undefined
      : (yield* hashIntakeJsonScalarSteps(cellChunks(store, 'n:' + entry.name))).hash;
  };
  const key = (entry: { prefix: string }) => {
    let result = '',
      started = false,
      escaped = false;
    for (const piece of cellChunks(store, 'c:' + entry.prefix))
      for (const char of piece) {
        if (!started) {
          if (/[\s{,]/.test(char)) continue;
          if (char !== '"') fail('property prefix');
          started = true;
        }
        result += char;
        if (result.length > 4096) fail('known metadata key spelling');
        if (result.length === 1) continue;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') return result;
      }
    return fail('metadata property key');
  };
  function* selectedValue(item: SchemaTarget): Generator<string> {
    if (item.type === 'cell') yield* cellChunks(store, 'c:' + item.id);
    else yield* iterateSchemaRecordValue(store, item.id);
  }
  function* intakePieces(id: string): Generator<string | void> {
    yield '{';
    let first = true;
    for (const entry of orderEntries(store, id)) {
      const field = metadata.get((yield* nameHash(entry)) ?? '');
      if (!field) continue;
      if (!first) yield ',';
      first = false;
      yield (control.mode === 'raw' ? key(entry) : JSON.stringify(field)) + ':';
      const cell = entry.target.type === 'cell' ? store.get('c:' + entry.target.id) : undefined;
      let stringCell = false;
      if (cell && typeof cell !== 'string') {
        const pieces = cellChunks(store, 'c:' + entry.target.id);
        try {
          stringCell = pieces.next().value?.trimStart().startsWith('"') ?? false;
        } finally {
          pieces.return(undefined);
        }
      }
      if (
        format !== INTAKE_ENVELOPE_FORMAT &&
        ['originalName', 'locator'].includes(field) &&
        cell &&
        typeof cell !== 'string' &&
        cell.bytes > COMPACT_SCALAR_BYTES &&
        stringCell
      ) {
        if (!store.byteBinding) return fail('compact scalar requires checked evidence');
        const raw = store.get('q:' + entry.target.id);
        if (typeof raw !== 'string') return fail('prepare compact scalar facts before projection');
        const facts = parseIntakeFilenameFacts(raw);
        if (facts.binding !== store.byteBinding(cell) || facts.bytes !== cell.bytes)
          fail('compact scalar facts binding');
        yield JSON.stringify(compactIntakeScalar(field as IntakeCompactScalarField, facts));
      } else yield* intakeCopyTrimmedPieceSteps(selectedValue(entry.target));
    }
    yield '}';
  }
  let turns = 0;
  yield '{"intakeAuthority":' + JSON.stringify({ format, mode: control.mode }) + ',';
  let last: string | undefined,
    firstIntake = true;
  for (const entry of orderEntries(store, control.root)) {
    if (++turns % 64 === 0) yield;
    if ((yield* nameHash(entry)) !== schemaKey('intake')) continue;
    const retainedObject =
      entry.target.type === 'record' && header(store, entry.target.id).shape === 'object';
    if (!retainedObject && control.mode !== 'raw') fail('selected intake record');
    last = retainedObject ? entry.target.id : undefined;
    if (control.mode !== 'raw') continue;
    if (!firstIntake) yield ',';
    firstIntake = false;
    yield key(entry) + ':';
    if (retainedObject)
      for (const piece of intakePieces(entry.target.id)) {
        yield piece;
        if (++turns % 16 === 0) yield;
      }
    else yield 'null';
  }
  if (!last) return fail('missing intake record');
  if (control.mode !== 'raw') {
    yield '"intake":';
    const spool = yield* prepareIntakeCopyPieceSpoolSteps(intakePieces(last));
    try {
      const normalized = yield* prepareIntakeJsonCanonicalSteps(spool.pieces(), {
        mode: 'stringify',
      });
      try {
        for (const piece of normalized.chunks()) {
          yield piece;
          if (++turns % 16 === 0) yield;
        }
      } finally {
        normalized.close();
      }
    } finally {
      spool.close();
    }
  }
  yield '}';
}
