/** Internal V3 read scope. It does not publish or present descriptor facts. */
import { HttpError, type Database } from './database.ts';
import { validateIntakeIdentity, type IntakeStateIdentity } from './intake-state-evidence.ts';
import type { IntakeReferencedEnvelope } from './intake-referenced-envelope-codec.ts';
import { parseIntakeReferencedEnvelope } from './intake-referenced-envelope-codec.ts';
import {
  assertIntakeLegacyBridgeReadWitnessForSource,
  captureIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
} from './intake-state-migration.ts';
import { createIntakeStateStorage } from './intake-state-storage.ts';
import { ensureIntakeFrontierObserver } from './intake-lookup-frontier-observer.ts';
import { parseIntakeFilenameFacts } from './intake-filename-facts.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  createSchemaEnvelopeReader,
  type EnvelopeCellReader,
  type IntakeCollectionEnvelopeReader,
} from './intake-collection-envelope.ts';
import { parseSchemaControl, schemaKey } from './intake-envelope-schema.ts';
import type { IntakeFilenameReferenceV2, IntakeFilenameV3 } from '../shared/intake-summary.ts';
import {
  captureRecordAcceptedIntakeHeadRead,
  closeRecordAcceptedIntakeHeadRead,
  recordAcceptedIntakeCurrentSourceDescriptor,
  recordAcceptedIntakeCurrentSourceSummaryFacts,
  recordAcceptedIntakeCurrentSourcePinVersion,
  recordAcceptedIntakeCurrentSourceVisibility,
  recordAcceptedIntakeSourcePair,
} from './record-versions.ts';
import type { AcceptedNativeIntakeSourceFormatScope } from './intake-accepted-source-format.ts';

export type ReferencedEnvelopeRead = Readonly<{ kind: 'referenced-envelope-read' }>;
export interface ReferencedEnvelopeCurrentSelection {
  identity: IntakeStateIdentity;
  storageSequence: number;
  logicalRoot: string;
  domainVersion: number;
  sourceVersionId: string;
}
type Field = 'intake.originalName' | 'intake.metadata.source';
export type ReferencedEnvelopeCurrentField =
  | Field
  | 'intake.metadata.sourceProviderId'
  | 'intake.metadata.careArea'
  | 'intake.metadata.documentType'
  | 'intake.metadata.topics'
  | 'intake.acquisition.providerId'
  | 'intake.acquisition.provider'
  | 'intake.state'
  | 'intake.createdAt'
  | 'intake.parentSourceFileId';
type Part =
  | { kind: 'inline'; text: string; bytes: number }
  | { kind: 'bytes'; chunk: Buffer; bytes: number; after: string | null; complete: boolean };
const scopes = new WeakMap<
  ReferencedEnvelopeRead,
  {
    db: Database;
    identity: IntakeStateIdentity;
    descriptor: IntakeReferencedEnvelope;
    sourceVersionId: string;
    sourceDetails: string;
    original: ReturnType<typeof captureIntakeLegacyBridgeReadWitness>;
    originalOwned: boolean;
    accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>>;
    collections: ReturnType<typeof createIntakeStateStorage>['collections'];
    keys: Map<Field, string | null>;
    currentKeys: Map<ReferencedEnvelopeCurrentField, string | null>;
    current?: {
      storageSequence: number;
      logicalRoot: NonNullable<IntakeReferencedEnvelope['intakeAuthority']['logicalRoot']>;
      domainVersion: number;
    };
    assertRunning: () => void;
  }
>();

/** One cold accepted replay per scope; later parts retain the same original proof. */
async function captureReferencedEnvelopeReadInternal(
  db: Database,
  identity: IntakeStateIdentity,
  sourceVersionId: string,
  assertRunning: () => void,
  selection: 'current' | 'historical',
  borrowed?: ReturnType<AcceptedNativeIntakeSourceFormatScope['borrowHead']>,
): Promise<ReferencedEnvelopeRead> {
  if (selection !== 'current' && selection !== 'historical')
    throw Error('Referenced envelope read selection invalid');
  assertRunning();
  identity = Object.freeze(validateIntakeIdentity(identity));
  ensureIntakeFrontierObserver(db);
  const original =
    borrowed?.original ?? captureIntakeLegacyBridgeReadWitness(db, identity.intakeId);
  let accepted: Awaited<ReturnType<typeof captureRecordAcceptedIntakeHeadRead>> | undefined =
    borrowed?.accepted;
  try {
    const current = () => {
      assertRunning();
      assertIntakeLegacyBridgeReadWitnessForSource(db, original, identity.intakeId);
    };
    current();
    const request = Object.freeze({ identity: Object.freeze({ ...identity }), sourceVersionId });
    if (!accepted)
      accepted = await captureRecordAcceptedIntakeHeadRead(db, identity, current, request);
    current();
    const pair = recordAcceptedIntakeSourcePair(db, accepted, identity, request);
    if (selection === 'current')
      recordAcceptedIntakeCurrentSourceDescriptor(db, accepted, identity, request);
    const descriptor = parseIntakeReferencedEnvelope(pair.sourceDetails);
    if (JSON.stringify(descriptor.intakeAuthority.identity) !== JSON.stringify(identity))
      throw Error('Referenced envelope identity changed');
    const scope = Object.freeze({ kind: 'referenced-envelope-read' }) as ReferencedEnvelopeRead;
    const collections = createIntakeStateStorage(db, identity).collections;
    const selectedHead =
      selection === 'current'
        ? collections.acceptedCurrentEnvelopeSelection(original, accepted)
        : undefined;
    scopes.set(scope, {
      db,
      identity,
      descriptor,
      sourceVersionId,
      sourceDetails: pair.sourceDetails,
      original,
      originalOwned: !borrowed,
      accepted,
      collections,
      keys: new Map(),
      currentKeys: new Map(),
      current: selectedHead,
      assertRunning: current,
    });
    return scope;
  } catch (error) {
    try {
      if (accepted) closeRecordAcceptedIntakeHeadRead(accepted);
    } finally {
      if (!borrowed) disposeIntakeLegacyBridgeReadWitness(original);
    }
    throw error;
  }
}

export async function captureReferencedEnvelopeRead(
  db: Database,
  identity: IntakeStateIdentity,
  sourceVersionId: string,
  assertRunning: () => void,
  selection: 'current' | 'historical',
): Promise<ReferencedEnvelopeRead> {
  return captureReferencedEnvelopeReadInternal(
    db,
    identity,
    sourceVersionId,
    assertRunning,
    selection,
  );
}

/** Reuse the format scope's original owner, signed pair and physical roster. */
export async function captureReferencedEnvelopeReadFromFormat(
  db: Database,
  scope: AcceptedNativeIntakeSourceFormatScope,
  assertRunning: () => void,
  selection: 'current' | 'historical',
): Promise<ReferencedEnvelopeRead> {
  const borrowed = scope.borrowHead();
  try {
    return await captureReferencedEnvelopeReadInternal(
      db,
      borrowed.identity,
      borrowed.sourceVersionId,
      assertRunning,
      selection,
      borrowed,
    );
  } catch (error) {
    closeRecordAcceptedIntakeHeadRead(borrowed.accepted);
    throw error;
  }
}

/** The summary may read current signed V4 fields only through this retained
 * selection. A historical descriptor root is never substituted for it. */
export function referencedEnvelopeCurrentSelection(
  scope: ReferencedEnvelopeRead,
): ReferencedEnvelopeCurrentSelection {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  data.assertRunning();
  const current = data.collections.acceptedCurrentEnvelopeSelection(data.original, data.accepted);
  if (
    current.storageSequence !== data.current.storageSequence ||
    current.domainVersion !== data.current.domainVersion ||
    JSON.stringify(current.logicalRoot) !== JSON.stringify(data.current.logicalRoot)
  )
    throw Error('Referenced current envelope selection changed');
  return {
    identity: data.identity,
    storageSequence: current.storageSequence,
    logicalRoot: current.logicalRoot.hash,
    domainVersion: current.domainVersion,
    sourceVersionId: data.sourceVersionId,
  };
}

export async function referencedEnvelopeCurrentSourceFacts(scope: ReferencedEnvelopeRead) {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  referencedEnvelopeCurrentSelection(scope);
  const request = { identity: data.identity, sourceVersionId: data.sourceVersionId };
  const facts = await recordAcceptedIntakeCurrentSourceSummaryFacts(
    data.db,
    data.accepted,
    data.identity,
    request,
  );
  const visibility = await recordAcceptedIntakeCurrentSourceVisibility(
    data.db,
    data.accepted,
    data.identity,
    request,
  );
  const sourcePinVersion = await recordAcceptedIntakeCurrentSourcePinVersion(
    data.db,
    data.accepted,
    data.identity,
    request,
  );
  referencedEnvelopeCurrentSelection(scope);
  return { ...facts, visibility, sourcePinVersion };
}

/** Compare mapping-rule provider IDs without turning a giant selected scalar
 * into a host string. Both possible fallbacks are checked under this read cap. */
export async function referencedEnvelopeProviderSelector(
  scope: ReferencedEnvelopeRead,
): Promise<Readonly<{ exact(): string | null | undefined; matches(candidate: string): boolean }>> {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  const selected = await referencedEnvelopeCurrentStringField(
    scope,
    'intake.metadata.sourceProviderId',
  );
  let provider:
    { kind: 'value'; value: string } | { kind: 'reference'; bytes: number; hash: string } | null;
  let scalar = false;
  if (selected.kind === 'value' && selected.value) {
    provider = selected;
    scalar = true;
  } else if (selected.kind === 'reference') {
    provider = { kind: 'reference', bytes: selected.bytes, hash: selected.scalarHash };
    scalar = true;
  } else {
    const request = { identity: data.identity, sourceVersionId: data.sourceVersionId };
    provider = (
      await recordAcceptedIntakeCurrentSourceSummaryFacts(
        data.db,
        data.accepted,
        data.identity,
        request,
      )
    ).providerId;
  }
  referencedEnvelopeCurrentSelection(scope);
  const current = () => {
    referencedEnvelopeCurrentSelection(scope);
    recordAcceptedIntakeCurrentSourceDescriptor(data.db, data.accepted, data.identity, {
      identity: data.identity,
      sourceVersionId: data.sourceVersionId,
    });
  };
  return Object.freeze({
    exact(): string | null | undefined {
      current();
      return provider?.kind === 'value' ? provider.value : provider ? undefined : null;
    },
    matches(candidate: string): boolean {
      current();
      if (typeof candidate !== 'string' || !provider) return false;
      if (provider.kind === 'value') return provider.value === candidate;
      if (scalar) return hashIntakeJsonScalar([JSON.stringify(candidate)]).hash === provider.hash;
      return (
        Buffer.byteLength(candidate) === provider.bytes &&
        createHash('sha256').update(candidate).digest('hex') === provider.hash
      );
    },
  });
}

/** Parent relationships compare against a proposed source ID. The V4 cell is
 * the accepted value; a giant retained string need not be assembled to match. */
export async function referencedEnvelopeParentSelector(scope: ReferencedEnvelopeRead): Promise<
  Readonly<{
    kind(): 'missing' | 'null' | 'value' | 'reference';
    exact(): string | null | undefined;
    matches(candidate: string): boolean;
  }>
> {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  const parent = await referencedEnvelopeCurrentStringField(scope, 'intake.parentSourceFileId');
  const current = () => {
    referencedEnvelopeCurrentSelection(scope);
    recordAcceptedIntakeCurrentSourceDescriptor(data.db, data.accepted, data.identity, {
      identity: data.identity,
      sourceVersionId: data.sourceVersionId,
    });
  };
  current();
  return Object.freeze({
    kind(): 'missing' | 'null' | 'value' | 'reference' {
      current();
      return parent.kind;
    },
    exact(): string | null | undefined {
      current();
      return parent.kind === 'value' ? parent.value : parent.kind === 'null' ? null : undefined;
    },
    matches(candidate: string): boolean {
      current();
      if (typeof candidate !== 'string') return false;
      if (parent.kind === 'value') return parent.value === candidate;
      if (parent.kind === 'reference')
        return hashIntakeJsonScalar([JSON.stringify(candidate)]).hash === parent.scalarHash;
      return false;
    },
  });
}

/** Fixed small fields are selected from the accepted current V4 head, not the
 * older V4 root paired with a source descriptor. Missing remains distinct. */
export function referencedEnvelopeCurrentField(
  scope: ReferencedEnvelopeRead,
  field: ReferencedEnvelopeCurrentField,
): unknown {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  data.assertRunning();
  const selected = data.collections.acceptedCurrentEnvelopeSelection(data.original, data.accepted);
  if (
    selected.storageSequence !== data.current.storageSequence ||
    selected.domainVersion !== data.current.domainVersion ||
    JSON.stringify(selected.logicalRoot) !== JSON.stringify(data.current.logicalRoot)
  )
    throw Error('Referenced current envelope selection changed');
  const resolved = data.collections.historicalEnvelopeFieldCellKey(
    data.original,
    data.accepted,
    selected.storageSequence,
    selected.logicalRoot,
    field,
  );
  if (resolved.mode !== data.descriptor.intakeAuthority.mode)
    throw Error('Referenced current envelope mode changed');
  if (!resolved.key) return undefined;
  let after: string | undefined;
  let lexical = '';
  let bytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let partCount = 0; partCount < 6; partCount++) {
    const part = data.collections.historicalEnvelopeCellPart(
      data.original,
      data.accepted,
      selected.storageSequence,
      selected.logicalRoot,
      resolved.key,
      after,
    );
    if (!part) throw Error('Referenced current envelope field disappeared');
    if (part.kind === 'inline') {
      if (after !== undefined || part.bytes > 16 * 1024)
        throw Error('Referenced current envelope field exceeds bounded read');
      lexical = part.text;
      break;
    }
    bytes += part.chunk.length;
    if (bytes > 16 * 1024 || !part.chunk.length)
      throw Error('Referenced current envelope field exceeds bounded read');
    lexical += decoder.decode(part.chunk, { stream: !part.complete });
    if (part.complete) break;
    if (!part.after || part.after === after)
      throw Error('Referenced current envelope field cursor did not advance');
    after = part.after;
    if (partCount === 5) throw Error('Referenced current envelope field part limit');
  }
  data.assertRunning();
  return JSON.parse(lexical);
}

/** Each part is addressed under the captured accepted current root, including
 * after a later source descriptor's historical root differs from current. */
export function referencedEnvelopeCurrentFieldPart(
  scope: ReferencedEnvelopeRead,
  field: ReferencedEnvelopeCurrentField,
  after?: string,
): Part | undefined {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  data.assertRunning();
  const selected = data.collections.acceptedCurrentEnvelopeSelection(data.original, data.accepted);
  if (
    selected.storageSequence !== data.current.storageSequence ||
    selected.domainVersion !== data.current.domainVersion ||
    JSON.stringify(selected.logicalRoot) !== JSON.stringify(data.current.logicalRoot)
  )
    throw Error('Referenced current envelope selection changed');
  let key = data.currentKeys.get(field);
  if (key === undefined) {
    const resolved = data.collections.historicalEnvelopeFieldCellKey(
      data.original,
      data.accepted,
      selected.storageSequence,
      selected.logicalRoot,
      field,
    );
    if (resolved.mode !== data.descriptor.intakeAuthority.mode)
      throw Error('Referenced current envelope mode changed');
    key = resolved.key;
    data.currentKeys.set(field, key);
  }
  if (key === null) {
    if (after !== undefined) throw Error('Referenced current envelope missing field cursor');
    return undefined;
  }
  const part = data.collections.historicalEnvelopeCellPart(
    data.original,
    data.accepted,
    selected.storageSequence,
    selected.logicalRoot,
    key,
    after,
  );
  data.assertRunning();
  return part;
}

/** A display scalar is exact only while its decoded value fits the small-field
 * budget. Large accepted values remain addressable by their field path. */
async function readReferencedEnvelopeCurrentStringField(
  scope: ReferencedEnvelopeRead,
  field: ReferencedEnvelopeCurrentField,
  maxValueUnits: number | undefined,
): Promise<
  | { kind: 'missing' }
  | { kind: 'null' }
  | { kind: 'value'; value: string }
  | { kind: 'reference'; bytes: number; scalarHash: string }
> {
  const first = referencedEnvelopeCurrentFieldPart(scope, field);
  if (!first) return { kind: 'missing' };
  let value: string | undefined = '';
  let lexicalBytes = first.kind === 'inline' ? first.bytes : 0;
  const pieces = function* (): Generator<string> {
    if (first.kind === 'inline') {
      yield first.text;
      return;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let part: Part = first;
    let after: string | undefined;
    let total = 0;
    for (;;) {
      if (part.kind !== 'bytes' || !part.chunk.length)
        throw Error('Referenced current envelope scalar part unavailable');
      total += part.chunk.length;
      lexicalBytes += part.chunk.length;
      if (total > part.bytes) throw Error('Referenced current envelope scalar bytes changed');
      yield decoder.decode(part.chunk, { stream: !part.complete });
      if (part.complete) {
        if (total !== part.bytes) throw Error('Referenced current envelope scalar incomplete');
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
      }
      if (!part.after || part.after === after)
        throw Error('Referenced current envelope scalar cursor did not advance');
      after = part.after;
      const next = referencedEnvelopeCurrentFieldPart(scope, field, after);
      if (!next) throw Error('Referenced current envelope scalar part disappeared');
      part = next;
    }
  };
  const steps = hashIntakeJsonScalarSteps(pieces(), [], (unit) => {
    if (value === undefined) return;
    if (maxValueUnits !== undefined && value.length >= maxValueUnits) value = undefined;
    else value += unit;
  });
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) {
        referencedEnvelopeCurrentFieldPart(scope, field);
        if (next.value.kind === 'null') return { kind: 'null' };
        if (next.value.kind !== 'string')
          throw Error('Referenced current envelope field is not a string');
        return value !== undefined &&
          (maxValueUnits === undefined || Buffer.byteLength(value) <= maxValueUnits)
          ? { kind: 'value', value }
          : { kind: 'reference', bytes: lexicalBytes, scalarHash: next.value.hash };
      }
      await setImmediate();
      referencedEnvelopeCurrentFieldPart(scope, field);
    }
  } finally {
    steps.return(undefined as never);
  }
}

export function referencedEnvelopeCurrentStringField(
  scope: ReferencedEnvelopeRead,
  field: ReferencedEnvelopeCurrentField,
) {
  return readReferencedEnvelopeCurrentStringField(scope, field, 16 * 1024);
}

/** A source ID must be complete before it can address the next ancestry edge.
 * This retains only that ID, yielding while reading its accepted V4 cell. */
export async function referencedEnvelopeCurrentExactStringField(
  scope: ReferencedEnvelopeRead,
  field: ReferencedEnvelopeCurrentField,
): Promise<string | null | undefined> {
  const selected = await readReferencedEnvelopeCurrentStringField(scope, field, undefined);
  if (selected.kind === 'reference') throw Error('Referenced exact source field unavailable');
  return selected.kind === 'value' ? selected.value : selected.kind === 'null' ? null : undefined;
}

/** The ordinary V4 schema reader is confined to one accepted-current scope.
 * Its store never falls back to a fresh V1 source projection or SQL baseline. */
export function referencedEnvelopeCurrentView(
  scope: ReferencedEnvelopeRead,
): IntakeCollectionEnvelopeReader {
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  const check = () => {
    if (scopes.get(scope) !== data) throw Error('Referenced current envelope scope closed');
    data.assertRunning();
    const selected = data.collections.acceptedCurrentEnvelopeSelection(
      data.original,
      data.accepted,
    );
    if (
      selected.storageSequence !== data.current!.storageSequence ||
      selected.domainVersion !== data.current!.domainVersion ||
      JSON.stringify(selected.logicalRoot) !== JSON.stringify(data.current!.logicalRoot)
    )
      throw Error('Referenced current envelope selection changed');
  };
  return currentEnvelopeView(data, check);
}

function currentEnvelopeView(
  data: NonNullable<ReturnType<typeof scopes.get>>,
  check: () => void,
): IntakeCollectionEnvelopeReader {
  if (!data.current) throw Error('Referenced current envelope scope unavailable');
  check();
  const view = data.collections.openView(
    JSON.stringify({ root: data.current.logicalRoot, domainVersion: data.current.domainVersion }),
  );
  const control = data.collections.get(view, 'logical', 'envelope.control', 'representation');
  if (typeof control !== 'string') throw Error('Referenced current envelope control unavailable');
  const schema = parseSchemaControl(control);
  if (schema.mode !== data.descriptor.intakeAuthority.mode)
    throw Error('Referenced current envelope mode changed');
  const store: EnvelopeCellReader = {
    check,
    get: (key) => {
      check();
      return data.collections.get(view, 'logical', 'envelope.data', key);
    },
    range: (after, items, bytes, prefix) => {
      check();
      return data.collections.range(view, 'logical', 'envelope.data', {
        after,
        items,
        bytes,
        prefix,
      });
    },
    chunks: (value, after, bytes = 4096) => {
      check();
      return data.collections.readBytes(value, { after, items: 64, bytes });
    },
    byteBinding: (value) => {
      check();
      return data.collections.byteValueBinding(value);
    },
  };
  check();
  return createSchemaEnvelopeReader(
    store,
    schema,
    {
      root: data.current.logicalRoot,
      domainVersion: data.current.domainVersion,
    },
    (name, key) => {
      check();
      const manifest = data.collections.get(view, 'builds', 'envelope.indexes', 'complete');
      if (
        typeof manifest !== 'string' ||
        manifest !==
          JSON.stringify({
            root: data.current!.logicalRoot,
            domainVersion: data.current!.domainVersion,
          }) ||
        data.collections.get(view, 'builds', 'envelope.indexes', 'policy') !==
          'health-intake-workflow-index-v6'
      )
        throw Error('semantic indexes are incomplete or stale');
      const value = data.collections.get(
        view,
        'builds',
        'envelope.indexes',
        schemaKey(name, ...key),
      );
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw Error('semantic index target');
      return value;
    },
  );
}

/** This fixed synchronous projection keeps one accepted-head proof open while
 * structural fields are read. No reader or record handle escapes its closure. */
export function referencedEnvelopeCurrentSummaryStructure(scope: ReferencedEnvelopeRead): {
  state: unknown;
  createdAt: unknown;
  parent: unknown;
  counts: {
    proposals: number;
    importHistory: number;
    reportGroups: number;
    candidates: number;
    questions: number;
    plans: number;
    packageFailures: number;
  };
} {
  const unavailable = (field: string): never => {
    throw new HttpError(
      409,
      'INTAKE_SUMMARY_UNAVAILABLE',
      `The selected intake ${field} could not be read. Refresh this file.`,
    );
  };
  const data = scopes.get(scope);
  if (!data || !data.current) throw Error('Referenced current envelope scope unavailable');
  const current = data.current;
  const selection = referencedEnvelopeCurrentSelection(scope);
  const methods = (
    [
      'acceptedCurrentEnvelopeSelection',
      'openView',
      'get',
      'range',
      'readBytes',
      'byteValueBinding',
      'historicalEnvelopeFieldCellKey',
      'historicalEnvelopeCellPart',
    ] as const
  ).map((name) => [name, Object.getOwnPropertyDescriptor(data.collections, name)?.value] as const);
  const check = () => {
    if (scopes.get(scope) !== data || data.current !== current)
      throw Error('Referenced current envelope scope closed');
    if (
      methods.some(
        ([name, method]) =>
          !method || Object.getOwnPropertyDescriptor(data.collections, name)?.value !== method,
      )
    )
      throw Error('Referenced current envelope methods changed');
    data.assertRunning();
  };
  try {
    const view = currentEnvelopeView(data, check);
    const intake = view.child(view.root(), 'intake');
    if (!intake) return unavailable('header');
    const workflow = view.child(intake, 'workflow');
    if (view.has(intake, 'workflow') && !workflow) return unavailable('workflow');
    const state = referencedEnvelopeCurrentField(scope, 'intake.state');
    const createdAt = referencedEnvelopeCurrentField(scope, 'intake.createdAt');
    const parent = referencedEnvelopeCurrentField(scope, 'intake.parentSourceFileId');
    const count = (record: typeof intake | undefined, field: string) => {
      if (record && view.has(record, field) && !view.child(record, field))
        return unavailable(field);
      return record ? view.childCount(record, field) : 0;
    };
    const counts = {
      proposals: count(intake, 'proposals'),
      importHistory: count(intake, 'importHistory'),
      reportGroups: count(workflow, 'reportGroups'),
      candidates: count(workflow, 'candidates'),
      questions: count(workflow, 'questions'),
      plans: count(workflow, 'plans'),
      packageFailures: count(intake, 'packageFailures'),
    };
    check();
    return { state, createdAt, parent, counts };
  } finally {
    check();
    const selected = referencedEnvelopeCurrentSelection(scope);
    if (
      selected.storageSequence !== selection.storageSequence ||
      selected.domainVersion !== selection.domainVersion ||
      selected.logicalRoot !== selection.logicalRoot ||
      selected.sourceVersionId !== selection.sourceVersionId
    )
      throw Error('Referenced current envelope selection changed');
  }
}

/** No arbitrary cell address can be supplied by the reader of a V3 field. */
export function referencedEnvelopeFieldPart(
  scope: ReferencedEnvelopeRead,
  field: Field,
  after?: string,
): Part | undefined {
  const data = scopes.get(scope);
  if (!data) throw Error('Referenced envelope read scope closed');
  data.assertRunning();
  const request = { identity: data.identity, sourceVersionId: data.sourceVersionId };
  const authority = data.descriptor.intakeAuthority;
  let key = data.keys.get(field);
  if (key === undefined) {
    const resolved = data.collections.historicalEnvelopeFieldCellKey(
      data.original,
      data.accepted,
      authority.storageSequence,
      authority.logicalRoot,
      field,
    );
    if (resolved.mode !== authority.mode)
      throw Error('Referenced envelope historical mode changed');
    key = resolved.key;
    data.keys.set(field, key);
  }
  if (key === null) {
    if (after !== undefined) throw Error('Referenced envelope missing field cursor');
    data.assertRunning();
    if (
      recordAcceptedIntakeSourcePair(data.db, data.accepted, data.identity, request)
        .sourceDetails !== data.sourceDetails
    )
      throw Error('Referenced envelope accepted source changed');
    return undefined;
  }
  const part = data.collections.historicalEnvelopeCellPart(
    data.original,
    data.accepted,
    authority.storageSequence,
    authority.logicalRoot,
    key,
    after,
  );
  data.assertRunning();
  return part;
}

export function referencedEnvelopeFilenameReference(
  scope: ReferencedEnvelopeRead,
): IntakeFilenameReferenceV2 {
  const data = scopes.get(scope);
  if (!data) throw Error('Referenced envelope read scope closed');
  const authority = data.descriptor.intakeAuthority;
  const resolved = data.collections.historicalEnvelopeFieldCellKey(
    data.original,
    data.accepted,
    authority.storageSequence,
    authority.logicalRoot,
    'intake.originalName',
  );
  if (resolved.mode !== authority.mode || !resolved.key)
    throw Error('Referenced envelope original filename unavailable');
  const selected = data.collections.historicalEnvelopeFilenameFacts(
    data.original,
    data.accepted,
    authority.storageSequence,
    authority.logicalRoot,
    resolved.key,
  );
  const facts = parseIntakeFilenameFacts(selected.facts);
  if (facts.binding !== selected.binding || facts.bytes !== selected.bytes)
    throw Error('Referenced envelope filename facts changed');
  data.keys.set('intake.originalName', resolved.key);
  data.assertRunning();
  return {
    format: 'health-intake-filename-reference-v2',
    intakeId: data.identity.intakeId,
    field: 'originalName',
    pins: {
      sourceHash: data.identity.sourceHash,
      logicalRoot: authority.logicalRoot.hash,
      storageSequence: authority.storageSequence,
      sourceVersionId: data.sourceVersionId,
      fieldBinding: selected.binding,
    },
    scalarHash: facts.scalarHash,
    bytes: facts.bytes,
  };
}

/** Filename presentation follows the accepted historical cell and its signed
 * facts. The MIME policy is derived from accepted source bytes, not a prefix
 * of a possibly giant selected SQL value. */
export function referencedEnvelopeFilenamePresentation(
  scope: ReferencedEnvelopeRead,
): IntakeFilenameV3 {
  const data = scopes.get(scope);
  if (!data) throw Error('Referenced envelope read scope closed');
  const mime = recordAcceptedIntakeSourcePair(data.db, data.accepted, data.identity, {
    identity: data.identity,
    sourceVersionId: data.sourceVersionId,
  }).sourceFacts.mimePredicates;
  const authority = data.descriptor.intakeAuthority;
  const resolved = data.collections.historicalEnvelopeFieldCellKey(
    data.original,
    data.accepted,
    authority.storageSequence,
    authority.logicalRoot,
    'intake.originalName',
  );
  if (resolved.mode !== authority.mode || !resolved.key)
    throw Error('Referenced envelope original filename unavailable');
  const part = referencedEnvelopeFieldPart(scope, 'intake.originalName');
  if (!part) throw Error('Referenced envelope original filename missing');
  let filename: string | undefined;
  let preview: string;
  let suffix: string;
  let reference: IntakeFilenameReferenceV2 | undefined;
  if (part.kind === 'inline') {
    if (Buffer.byteLength(part.text) !== part.bytes)
      throw Error('Referenced envelope filename scalar invalid');
    const parsed: unknown = JSON.parse(part.text);
    if (typeof parsed !== 'string') throw Error('Referenced envelope filename is not text');
    filename = parsed;
    preview = parsed;
    suffix = parsed.slice(-64);
  } else {
    reference = referencedEnvelopeFilenameReference(scope);
    const selected = data.collections.historicalEnvelopeFilenameFacts(
      data.original,
      data.accepted,
      authority.storageSequence,
      authority.logicalRoot,
      resolved.key,
    );
    const facts = parseIntakeFilenameFacts(selected.facts);
    if (
      facts.binding !== selected.binding ||
      facts.bytes !== selected.bytes ||
      facts.scalarHash !== reference.scalarHash
    )
      throw Error('Referenced envelope filename facts changed');
    preview = facts.preview;
    suffix = facts.suffix;
    if (!facts.truncated) filename = preview;
  }
  const retainOnly =
    mime.retainOnlyMime === 'retain' ||
    (mime.retainOnlyMime === 'filename' &&
      /\.(dcm|dicom|mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|webm)$/i.test(suffix));
  const packageSource = mime.packageMime || /\.zip$/i.test(suffix);
  referencedEnvelopeCurrentSelection(scope);
  return filename !== undefined
    ? { filename, retainOnly, packageSource }
    : {
        filenamePreview: preview,
        filenameTruncated: true,
        filenameReference: reference!,
        retainOnly,
        packageSource,
      };
}

export function referencedEnvelopeFilenameFragment(
  scope: ReferencedEnvelopeRead,
  after: string | undefined,
  limit: number,
): { text: string; complete: boolean; after: string | null } {
  const invalidCursor = (): never => {
    throw new HttpError(
      400,
      'INTAKE_FILENAME_WINDOW',
      'Read a bounded original filename fragment.',
    );
  };
  if (!Number.isSafeInteger(limit) || limit < 4096 || limit > 16384) invalidCursor();
  let base: string | undefined;
  let offset = 0;
  if (after !== undefined) {
    if (
      typeof after !== 'string' ||
      after.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(after) ||
      Buffer.from(after, 'base64url').toString('base64url') !== after
    )
      invalidCursor();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
    } catch {
      invalidCursor();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidCursor();
    const item = parsed as { base?: unknown; offset?: unknown };
    if (
      Object.keys(item).sort().join(',') !== 'base,offset' ||
      (item.base !== null && (typeof item.base !== 'string' || !/^[0-9]{16}$/.test(item.base))) ||
      !Number.isSafeInteger(item.offset) ||
      (item.offset as number) < 0 ||
      (item.offset as number) > 32768
    )
      invalidCursor();
    base = item.base === null ? undefined : (item.base as string);
    offset = item.offset as number;
  }
  const chunks: { chunk: Buffer; after: string | null }[] = [];
  let cursor = base;
  let complete = false;
  let size = 0;
  while (size < offset + limit + 4 && !complete && chunks.length < 6) {
    let part: Part | undefined;
    try {
      part = referencedEnvelopeFieldPart(scope, 'intake.originalName', cursor);
    } catch (error) {
      if (
        after !== undefined &&
        error instanceof Error &&
        error.message === 'Invalid intake state: historical envelope byte cursor'
      )
        invalidCursor();
      throw error;
    }
    if (!part || part.kind !== 'bytes') throw Error('Referenced filename is not fragmented');
    if (!part.chunk.length || (!part.complete && !part.after))
      throw Error('Referenced filename fragment did not advance');
    chunks.push({ chunk: part.chunk, after: part.after });
    size += part.chunk.length;
    complete = part.complete;
    cursor = part.after ?? undefined;
  }
  if (!chunks.length || offset >= size) invalidCursor();
  const bytes = Buffer.concat(chunks.map((item) => item.chunk));
  if ((bytes[offset]! & 0xc0) === 0x80) invalidCursor();
  let end = Math.min(offset + limit, bytes.length);
  let text: string | undefined;
  for (let attempt = 0; attempt <= 3 && end > offset; attempt++, end--) {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(offset, end),
      );
      break;
    } catch {
      /* a bounded page may end inside one UTF-8 scalar */
    }
  }
  if (text === undefined) throw Error('Referenced filename UTF-8 fragment');
  if (complete && end === bytes.length) return { text, complete: true, after: null };
  let consumed = 0;
  for (let index = 0; index < chunks.length; index++) {
    const next = consumed + chunks[index]!.chunk.length;
    if (end === next && chunks[index]!.after) {
      return {
        text,
        complete: false,
        after: Buffer.from(JSON.stringify({ base: chunks[index]!.after, offset: 0 })).toString(
          'base64url',
        ),
      };
    }
    if (end < next) {
      const drop = Math.max(0, index - 1);
      const dropped = chunks.slice(0, drop).reduce((sum, item) => sum + item.chunk.length, 0);
      return {
        text,
        complete: false,
        after: Buffer.from(
          JSON.stringify({
            base: drop ? chunks[drop - 1]!.after : (base ?? null),
            offset: end - dropped,
          }),
        ).toString('base64url'),
      };
    }
    consumed = next;
  }
  throw Error('Referenced filename fragment cursor');
}

export function closeReferencedEnvelopeRead(scope: ReferencedEnvelopeRead): void {
  const data = scopes.get(scope);
  if (!data) return;
  scopes.delete(scope);
  try {
    data.assertRunning();
    const pair = recordAcceptedIntakeSourcePair(data.db, data.accepted, data.identity, {
      identity: data.identity,
      sourceVersionId: data.sourceVersionId,
    });
    if (pair.sourceDetails !== data.sourceDetails)
      throw Error('Referenced envelope accepted source changed');
  } finally {
    try {
      closeRecordAcceptedIntakeHeadRead(data.accepted);
    } finally {
      if (data.originalOwned) disposeIntakeLegacyBridgeReadWitness(data.original);
    }
  }
}
