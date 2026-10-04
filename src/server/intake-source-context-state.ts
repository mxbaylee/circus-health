/** Explicit native legacy-context preparation. Original files and selected
 * envelope records remain authority; these maps are source-bound derived work. */
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Database } from './database.ts';
import type { IntakeEnvelopeDerivedPreparation } from './intake-envelope-mutation.ts';
import type { NativeProposalAffected } from './intake-collection-proposals.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { assertIntakeOwner } from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import { intakeEnvelopeAuthorityBinding, type IntakeEnvelopeSource } from './intake-authority.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  buildIntakeCollectionEnvelope,
  createEnvelopeBuildWriter,
} from './intake-envelope-build.ts';
import { sourceContextEnvelope } from './clinical-import.ts';
import { MAX_INTAKE_BYTES, validateJSONL, type IntakeEntry } from './intake-format.ts';
import { intakeCandidateVersionIdForRevision, workflowHash } from './intake-workflow.ts';
import { profileOriginal } from './profile-storage.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { recordIntakeWork } from './intake-work-accounting.ts';
import {
  readIntakeFileSync,
  recordIntakeFileHash,
  createIntakeFileWorkCounters,
  withIntakeFileWork,
} from './intake-file-work.ts';

const POLICY = 'health-intake-source-context-v2';
const MAPS = [
  'unresolved',
  'references',
  'versionReferences',
  'allowed',
  'active',
  'eligibility',
  'contexts',
  'membership',
  'sources',
  'control',
] as const;
type MapKind = (typeof MAPS)[number];
type Ref = { versionId: string; sourceId: string; count: number };
const refPrefix = (id: string) => workflowHash(id) + ':';
const refKey = (id: string, sourceId: string) => refPrefix(id) + workflowHash(sourceId);
export type SourceContextPendingReason =
  'not_prepared' | 'source_evidence_unavailable' | 'source_changed' | 'selection_changed';
export class SourceContextClassificationPending extends Error {
  readonly reason: SourceContextPendingReason;
  constructor(reason: SourceContextPendingReason) {
    super('Source context classification requires preparation: ' + reason);
    this.name = 'SourceContextClassificationPending';
    this.reason = reason;
  }
}
type SourceRow = IntakeEnvelopeSource & {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
  details_json: string;
};
interface Witness {
  id: string;
  signature: string;
  physical: string;
  revision: string | null;
}
export type SelectedSourceContextClassification =
  | { state: 'pending'; reason: SourceContextPendingReason }
  | {
      state: 'ready';
      logical: IntakeCollectionEnvelopeReader['logical'];
      collection: string;
      isSourceContextVersion(id: string): boolean;
      assertCurrent(): void;
    };
function source(db: Database, profileId: string, id: string): SourceRow {
  assertIntakeOwner(db, profileId);
  const row = db
    .prepare(
      "SELECT id,kind,path,sha256,bytes,details_json FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as unknown as SourceRow | undefined;
  if (!row) throw Error('Source intake not found');
  intakeEnvelopeAuthorityBinding(db, row);
  return row;
}
function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind === 'missing') return undefined;
  if (value.kind !== 'value') throw new SourceContextClassificationPending('not_prepared');
  return value.value as T;
}
function truthy(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): boolean {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind === 'missing') return false;
  if (value.kind === 'value') return !!value.value;
  let token = '',
    quoted = false;
  scan: for (const piece of view.fieldChunks(record, name))
    for (const char of piece) {
      if (quoted) return char !== '"';
      if (/^[\x20\t\r\n]$/.test(char)) continue;
      token = char;
      if (char === '"') {
        quoted = true;
        continue;
      }
      break scan;
    }
  // Objects/arrays are truthy regardless of size. Fragmented numeric tokens
  // still obey binary64 zero/underflow semantics without retaining the token.
  if (token === '{' || token === '[') return true;
  const counted = function* () {
    for (const piece of view.fieldChunks(record, name)) {
      recordIntakeWork('hashedBytes', Buffer.byteLength(piece));
      yield piece;
    }
  };
  recordIntakeWork('hashCalls');
  const scalar = hashIntakeJsonScalar(counted());
  if (scalar.kind === 'null') return false;
  if (scalar.kind === 'boolean')
    return scalar.hash !== createHash('sha256').update('[false]').digest('hex');
  if (scalar.kind === 'number')
    return scalar.hash !== createHash('sha256').update('[0]').digest('hex');
  return scalar.bytes > 4;
}
function* records(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
) {
  let after: string | undefined;
  do {
    const page = view.children(record, name, { after, items: 32, bytes: 32768 });
    yield* page.records;
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Source context cursor did not advance');
    after = page.after;
  } while (true);
}
const physical = (path: string) => {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
};
const signature = (row: SourceRow) =>
  JSON.stringify([
    row.id,
    row.kind,
    row.path,
    row.sha256,
    row.bytes,
    row.kind === 'intake_original' ? null : !!JSON.parse(row.details_json)?.validation?.valid,
  ]);
const name = (
  root: string,
  profileId: string,
  file: SourceRow,
  view: Pick<IntakeCollectionEnvelopeReader, 'logical'>,
) =>
  'source.context.' +
  workflowHash([POLICY, resolve(root), profileId, file.id, file.sha256, view.logical]);
function readInline(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Error('Source context descriptor is not inline');
  return value;
}
function row(db: Database, id: string): SourceRow | undefined {
  return db
    .prepare('SELECT id,kind,path,sha256,bytes,details_json FROM source_files WHERE id=?')
    .get(id) as unknown as SourceRow | undefined;
}
function checkWitness(db: Database, root: string, profileId: string, witness: Witness) {
  const current = row(db, witness.id);
  if (!current || signature(current) !== witness.signature)
    throw new SourceContextClassificationPending('source_changed');
  try {
    if (physical(profileOriginal(root, current.path, profileId)) !== witness.physical)
      throw new SourceContextClassificationPending('source_changed');
  } catch (error) {
    if (error instanceof SourceContextClassificationPending) throw error;
    throw new SourceContextClassificationPending('source_evidence_unavailable');
  }
}

export interface SourceContextDerivedPreparation extends IntakeEnvelopeDerivedPreparation {
  affected: NativeProposalAffected;
  /** Owned command compiler family; never infer this from arbitrary user input. */
  impact: 'proposal' | 'questions' | 'metadata';
  assertRunning?: () => void;
  incomingProposal?: {
    id: string;
    entries: readonly IntakeEntry[];
    sha256: string;
    bytes: number;
    path: string;
    sourceTextDependencyToken?: string | null;
    sourceTextRevisionId?: string | null;
  };
}
export type PreparedSourceContextDerived =
  | { state: 'pending'; reason: SourceContextPendingReason }
  | {
      state: 'ready';
      changes: readonly IntakeCollectionChange[];
      additionalVersionIds?: Iterable<string>;
      isSourceContextVersion(id: string, reader?: IntakeCollectionEnvelopeReader): boolean;
      assertCurrent(): void;
      assertPublicationCurrent(): void;
    };

/** Compose these auxiliary changes with the prospective domain publication.
 * The closed metadata/question compiler families cannot change classification
 * inputs. Proposal changes require the addressed selector participant below. */
export async function prepareSourceContextClassificationDerived(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: SourceContextDerivedPreparation,
): Promise<PreparedSourceContextDerived> {
  input.assertRunning?.();
  const prior = readSelectedSourceContextClassification(db, root, profileId, id);
  if (prior.state !== 'ready') return prior;
  if (input.impact === 'proposal')
    return prepareProposalDerived(db, root, profileId, id, input, prior);
  if (
    input.affected.candidateChanges.length ||
    input.affected.proposalIds.length ||
    input.affected.reportGroupAddresses.length ||
    (input.impact === 'metadata' && input.affected.questionAddresses.length)
  )
    throw Error('Source context retag requires a closed metadata/question command');
  const file = source(db, profileId, id),
    collection = name(root, profileId, file, input),
    assertCurrent = () => {
      input.assertRunning?.();
      prior.assertCurrent();
    };
  assertCurrent();
  return {
    state: 'ready',
    assertCurrent,
    assertPublicationCurrent: assertCurrent,
    isSourceContextVersion(versionId, reader) {
      assertCurrent();
      if (reader && JSON.stringify(reader.logical) !== JSON.stringify(input.reader.logical))
        throw new SourceContextClassificationPending('selection_changed');
      return prior.isSourceContextVersion(versionId);
    },
    changes: MAPS.map((kind) => ({
      area: 'builds',
      collection: collection + '.' + kind,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: prior.collection + '.' + kind,
    })),
  };
}

/** Point reads never start a file parse or an N-source stat refresh. Physical
 * changes of a positive witness require explicit asynchronous preparation. */
export function readSelectedSourceContextClassification(
  db: Database,
  root: string,
  profileId: string,
  id: string,
): SelectedSourceContextClassification {
  const file = source(db, profileId, id),
    store = selectedEnvelopeStore(db, file).collections,
    representation = store.get(store.openView(), 'logical', 'envelope.control', 'representation');
  if (
    typeof representation !== 'string' ||
    JSON.parse(representation).format !== 'health-intake-record-envelope-v1'
  )
    return { state: 'pending', reason: 'not_prepared' };
  const version = intakeSourceVersion(db, id),
    view = openIntakeCollectionEnvelope(db, file),
    collection = name(root, profileId, file, view);
  const complete = readInline(
    store.get(store.openView(), 'builds', collection + '.control', 'complete'),
  );
  if (complete === undefined) return { state: 'pending', reason: 'not_prepared' };
  if (complete !== 'ready') return { state: 'pending', reason: 'source_evidence_unavailable' };
  const roots = MAPS.map((kind) =>
    store.collection(store.openView(), 'builds', collection + '.' + kind),
  );
  if (roots.some((root) => root === undefined)) return { state: 'pending', reason: 'not_prepared' };
  const auxiliaryPin = JSON.stringify(roots);
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.version !== version.version || current.logicalBinding !== version.logicalBinding)
      throw new SourceContextClassificationPending('selection_changed');
    if (
      JSON.stringify(
        MAPS.map((kind) => store.collection(store.openView(), 'builds', collection + '.' + kind)),
      ) !== auxiliaryPin
    )
      throw new SourceContextClassificationPending('selection_changed');
  };
  return {
    state: 'ready',
    logical: view.logical,
    collection,
    assertCurrent,
    isSourceContextVersion(versionId) {
      assertCurrent();
      const selected = readInline(
        store.get(store.openView(), 'builds', collection + '.membership', versionId),
      );
      if (selected === undefined) return false;
      const raw = readInline(
        store.get(store.openView(), 'builds', collection + '.sources', selected),
      );
      if (!raw) throw new SourceContextClassificationPending('not_prepared');
      checkWitness(db, root, profileId, JSON.parse(raw) as Witness);
      return true;
    },
  };
}

/** One explicit asynchronous phase reproduces the old unresolved/allowed/
 * referenced fallback using disk collections. Damaged inputs remain pending;
 * their repair must cross this preparation boundary before a negative is trusted. */
export async function prepareSelectedSourceContextClassification(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: {
    assertRunning?: () => void;
    refresh?: boolean;
    onWork?: (work: ReturnType<typeof createIntakeFileWorkCounters>) => void;
  } = {},
): Promise<SelectedSourceContextClassification> {
  const work = createIntakeFileWorkCounters();
  try {
    return await prepareClassification(db, root, profileId, id, options, work);
  } finally {
    options.onWork?.({ ...work });
  }
}
async function prepareClassification(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  options: { assertRunning?: () => void; refresh?: boolean },
  work: ReturnType<typeof createIntakeFileWorkCounters>,
): Promise<SelectedSourceContextClassification> {
  const file = source(db, profileId, id),
    store = selectedEnvelopeStore(db, file).collections;
  const control = store.get(store.openView(), 'logical', 'envelope.control', 'representation');
  if (
    typeof control !== 'string' ||
    JSON.parse(control).format !== 'health-intake-record-envelope-v1'
  )
    await buildIntakeCollectionEnvelope(db, file, { assertRunning: options.assertRunning });
  const version = intakeSourceVersion(db, id),
    view = openIntakeCollectionEnvelope(db, file),
    collection = name(root, profileId, file, view);
  const assertCurrent = () => {
    options.assertRunning?.();
    assertIntakeOwner(db, profileId);
    const current = intakeSourceVersion(db, id);
    if (current.version !== version.version || current.logicalBinding !== version.logicalBinding)
      throw new SourceContextClassificationPending('selection_changed');
  };
  function* entries(map: string) {
    let after: string | undefined;
    do {
      const page = store.range(store.openView(), 'builds', map, { after, items: 32, bytes: 32768 });
      yield* page.items;
      if (page.complete) return;
      if (!page.after || page.after === after)
        throw Error('Source context map cursor did not advance');
      after = page.after;
    } while (true);
  }
  if (!options.refresh) {
    const prior = readSelectedSourceContextClassification(db, root, profileId, id);
    if (prior.state === 'ready') {
      let unchanged = true;
      for (const entry of entries(collection + '.eligibility')) {
        assertCurrent();
        const selected = row(db, entry.key);
        if (!selected || signature(selected) !== entry.value) {
          unchanged = false;
          break;
        }
        await setImmediate();
      }
      for (const entry of entries(collection + '.sources')) {
        assertCurrent();
        try {
          checkWitness(db, root, profileId, JSON.parse(readInline(entry.value)!) as Witness);
        } catch {
          unchanged = false;
          break;
        }
        await setImmediate();
      }
      if (unchanged) {
        assertCurrent();
        return prior;
      }
    }
  }
  // A completed preparation is immutable for this selection. Explicit refresh
  // uses a new attempt map then atomically selects its result below.
  const attempt = collection + '.' + randomUUID().slice(0, 12);
  const writers = Object.fromEntries(
    MAPS.map((kind) => [
      kind,
      createEnvelopeBuildWriter(db, file, attempt + '.' + kind, view.logical.domainVersion, {
        assertRunning: assertCurrent,
      }),
    ]),
  ) as Record<MapKind, ReturnType<typeof createEnvelopeBuildWriter>>;
  for (const writer of Object.values(writers)) {
    await writer.put('initializing', '1');
    await writer.remove('initializing');
  }
  const intake = view.child(view.root(), 'intake');
  if (!intake) throw Error('Missing intake envelope');
  const flow = view.child(intake, 'workflow');
  if (flow)
    for (const candidate of records(view, flow, 'candidates'))
      for (const entry of records(view, candidate, 'versions')) {
        assertCurrent();
        if (truthy(view, entry, 'sourceContext')) continue;
        const versionId = field<string>(view, entry, 'id');
        if (!versionId) throw Error('Missing candidate version ID');
        await writers.unresolved.put(
          versionId,
          String(Number(writers.unresolved.peek(versionId) ?? 0) + 1),
        );
      }
  await writers.unresolved.flush();
  // Legacy membership is keyed by version ID, including explicitly marked
  // duplicate occurrences when any occurrence of that ID remains unresolved.
  if (flow)
    for (const candidate of records(view, flow, 'candidates'))
      for (const entry of records(view, candidate, 'versions')) {
        assertCurrent();
        const versionId = field<string>(view, entry, 'id');
        if (!versionId) throw Error('Missing candidate version ID');
        for (const occurrence of records(view, entry, 'occurrences')) {
          const sourceId = field<string | null>(view, occurrence, 'proposalId') || id;
          const key = refKey(versionId, sourceId),
            prior = writers.versionReferences.peek(key);
          const ref: Ref = prior ? JSON.parse(prior) : { versionId, sourceId, count: 0 };
          if (ref.versionId !== versionId || ref.sourceId !== sourceId)
            throw Error('Source context reference collision');
          ref.count++;
          await writers.versionReferences.put(key, JSON.stringify(ref));
          if (writers.unresolved.peek(versionId) !== undefined)
            await writers.references.put(
              sourceId,
              String(Number(writers.references.peek(sourceId) ?? 0) + 1),
            );
        }
      }
  await writers.references.flush();
  const unresolved =
    store.collection(store.openView(), 'builds', attempt + '.unresolved')?.root?.count ?? 0;
  {
    await writers.allowed.put(id, 'null');
    for (const proposal of records(view, intake, 'proposals')) {
      assertCurrent();
      const proposalId = field<string>(view, proposal, 'id');
      if (!proposalId) throw Error('Missing proposal ID');
      if (writers.allowed.peek(proposalId) !== undefined) continue;
      const revision =
        field<string | null>(view, proposal, 'sourceTextDependencyToken') ||
        field<string | null>(view, proposal, 'sourceTextRevisionId') ||
        null;
      await writers.allowed.put(proposalId, JSON.stringify(revision));
    }
  }
  await writers.allowed.flush();
  let referencedCount = 0;
  for (const entry of entries(attempt + '.references'))
    if (writers.allowed.peek(entry.key) !== undefined) {
      referencedCount++;
    }
  let unavailable = false;
  for (const entry of entries(attempt + '.allowed')) {
    assertCurrent();
    if (!unresolved || (referencedCount && writers.references.peek(entry.key) === undefined))
      continue;
    await writers.active.put(entry.key, '1');
    const selected = entry.key === id ? file : row(db, entry.key);
    const validation = entry.key === id ? view.child(intake, 'validation') : undefined;
    const valid =
      entry.key === id
        ? validation && field(view, validation, 'valid')
        : selected
          ? JSON.parse(selected.details_json)?.validation?.valid
          : false;
    if (!selected) {
      unavailable = true;
      continue;
    }
    await writers.eligibility.put(selected.id, signature(selected));
    if (!valid || selected.bytes > MAX_INTAKE_BYTES) continue;
    const revision =
      entry.key === id ? null : (JSON.parse(readInline(entry.value)!) as string | null);
    let path: string, identity: string;
    try {
      path = profileOriginal(root, selected.path, profileId);
      identity = physical(path);
    } catch {
      assertCurrent();
      unavailable = true;
      continue;
    }
    const witness: Witness = {
      id: selected.id,
      signature: signature(selected),
      physical: identity,
      revision,
    };
    const cache = 'source.context.file.' + workflowHash([resolve(root), profileId, witness]);
    if (store.get(store.openView(), 'builds', cache + '.control', 'complete') !== 'ready') {
      let parsed: ReturnType<typeof validateJSONL>;
      try {
        parsed = withIntakeFileWork(work, () => {
          const bytes = readIntakeFileSync(path);
          recordIntakeFileHash(bytes);
          if (
            bytes.length !== selected.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== selected.sha256 ||
            physical(path) !== identity
          )
            throw new SourceContextClassificationPending('source_changed');
          return validateJSONL(bytes);
        });
      } catch {
        assertCurrent();
        unavailable = true;
        continue;
      }
      if (!parsed.valid) {
        unavailable = true;
        continue;
      }
      const cacheWriter = createEnvelopeBuildWriter(
        db,
        file,
        cache + '.versions',
        view.logical.domainVersion,
        { assertRunning: assertCurrent },
      );
      await cacheWriter.put('initializing', '1');
      await cacheWriter.remove('initializing');
      for (const record of parsed.entries)
        if (sourceContextEnvelope(record.value)) {
          const versionId = withIntakeFileWork(work, () =>
            intakeCandidateVersionIdForRevision(record, revision),
          );
          await cacheWriter.put(versionId, '1');
        }
      await cacheWriter.flush();
      assertCurrent();
      try {
        checkWitness(db, root, profileId, witness);
      } catch {
        unavailable = true;
        continue;
      }
      const cacheControl = createEnvelopeBuildWriter(
        db,
        file,
        cache + '.control',
        view.logical.domainVersion,
        { assertRunning: assertCurrent },
      );
      await cacheControl.put('complete', 'ready');
      await cacheControl.flush();
    }
    await writers.sources.put(selected.id, JSON.stringify(witness));
    for (const version of entries(cache + '.versions')) {
      assertCurrent();
      await writers.contexts.put(
        refKey(version.key, selected.id),
        JSON.stringify({ versionId: version.key, sourceId: selected.id }),
      );
      if (
        writers.unresolved.peek(version.key) !== undefined &&
        writers.membership.peek(version.key) === undefined
      )
        await writers.membership.put(version.key, selected.id);
    }
    await setImmediate();
  }
  for (const writer of Object.values(writers)) await writer.flush();
  // Check every source used by this explicit phase again before publication.
  for (const entry of entries(attempt + '.sources')) {
    assertCurrent();
    try {
      checkWitness(db, root, profileId, JSON.parse(readInline(entry.value)!) as Witness);
    } catch {
      unavailable = true;
    }
    await setImmediate();
  }
  await writers.control.put('complete', unavailable ? 'pending' : 'ready');
  await writers.control.put('referencedCount', String(referencedCount));
  await writers.control.flush();
  assertCurrent();
  const operationId = randomUUID();
  store.commitMaintenance(
    store.prepare(store.openView(), {
      operationId,
      requestDigest: workflowHash([attempt, 'select']),
      domainVersion: view.logical.domainVersion,
      changes: MAPS.map((kind) => ({
        area: 'builds' as const,
        collection: collection + '.' + kind,
        op: 'adoptCollection' as const,
        fromArea: 'builds' as const,
        fromCollection: attempt + '.' + kind,
      })),
    }),
  );
  return readSelectedSourceContextClassification(db, root, profileId, id);
}

/** Incremental selector closure. All retained sets, reverse references and
 * genuine fan-out use authenticated disk maps; input events are the bounded
 * owned proposal compiler's complete addressed change list. */
async function prepareProposalDerived(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: SourceContextDerivedPreparation,
  prior: Extract<SelectedSourceContextClassification, { state: 'ready' }>,
): Promise<PreparedSourceContextDerived> {
  const file = source(db, profileId, id),
    before = openIntakeCollectionEnvelope(db, file),
    store = selectedEnvelopeStore(db, file).collections,
    destination = name(root, profileId, file, input),
    attempt = 'source.context.delta.' + randomUUID(),
    assertCurrent = () => {
      input.assertRunning?.();
      prior.assertCurrent();
    };
  const commit = (changes: IntakeCollectionChange[]) => {
    assertCurrent();
    const operationId = randomUUID();
    store.commitMaintenance(
      store.prepare(store.openView(), {
        operationId,
        requestDigest: workflowHash(operationId),
        domainVersion: before.logical.domainVersion,
        changes,
      }),
    );
  };
  commit(
    MAPS.map((kind) => ({
      area: 'builds',
      collection: attempt + '.' + kind,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: prior.collection + '.' + kind,
    })),
  );
  const writers = Object.fromEntries(
    [...MAPS, 'dirtyVersions', 'dirtySources', 'changedAddresses', 'changedVersions', 'fanout'].map(
      (kind) => [
        kind,
        createEnvelopeBuildWriter(db, file, attempt + '.' + kind, before.logical.domainVersion, {
          assertRunning: assertCurrent,
        }),
      ],
    ),
  ) as Record<
    MapKind | 'dirtyVersions' | 'dirtySources' | 'changedAddresses' | 'changedVersions' | 'fanout',
    ReturnType<typeof createEnvelopeBuildWriter>
  >;
  for (const kind of [
    'dirtyVersions',
    'dirtySources',
    'changedAddresses',
    'changedVersions',
    'fanout',
  ] as const) {
    await writers[kind].put('initializing', '1');
    await writers[kind].remove('initializing');
    await writers[kind].flush();
  }
  function* entries(collection: string, prefix = '') {
    let after: string | undefined = prefix || undefined;
    do {
      assertCurrent();
      const page = store.range(store.openView(), 'builds', collection, {
        after,
        items: 32,
        bytes: 32768,
      });
      for (const item of page.items) {
        if (prefix && !item.key.startsWith(prefix)) return;
        yield { key: item.key, value: readInline(item.value)! };
      }
      if (page.complete) return;
      if (!page.after || page.after === after)
        throw Error('Source context delta cursor did not advance');
      after = page.after;
    } while (true);
  }
  const count = (kind: MapKind, key: string) => Number(writers[kind].peek(key) ?? 0);
  const setCount = async (kind: MapKind, key: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw Error('Invalid source context reference count');
    if (value) await writers[kind].put(key, String(value));
    else await writers[kind].remove(key);
  };
  let referencedCount = Number(writers.control.peek('referencedCount'));
  if (!Number.isSafeInteger(referencedCount) || referencedCount < 0)
    return { state: 'pending', reason: 'not_prepared' };
  const oldMode = referencedCount > 0,
    oldAny =
      (store.collection(store.openView(), 'builds', prior.collection + '.unresolved')?.root
        ?.count ?? 0) > 0;
  const changeSourceReference = async (sourceId: string, delta: number) => {
    const old = count('references', sourceId),
      next = old + delta;
    if (writers.allowed.peek(sourceId) !== undefined)
      referencedCount += Number(next > 0) - Number(old > 0);
    await setCount('references', sourceId, next);
    await writers.dirtySources.put(sourceId, '1');
  };
  // Subtract each affected ID's complete old reverse range once, including
  // references retained on explicitly marked duplicate version occurrences.
  for (const change of input.affected.candidateChanges) {
    assertCurrent();
    if (writers.changedVersions.peek(change.candidateVersionId) !== undefined) continue;
    await writers.changedVersions.put(change.candidateVersionId, '1');
    await writers.dirtyVersions.put(change.candidateVersionId, '1');
    if (count('unresolved', change.candidateVersionId))
      for (const item of entries(
        prior.collection + '.versionReferences',
        refPrefix(change.candidateVersionId),
      )) {
        const ref = JSON.parse(item.value) as Ref;
        if (ref.versionId !== change.candidateVersionId)
          throw Error('Source context reference identity');
        await changeSourceReference(ref.sourceId, -ref.count);
      }
  }
  const applyVersion = async (
    view: IntakeCollectionEnvelopeReader,
    record: IntakeEnvelopeRecord,
    versionId: string,
    delta: 1 | -1,
  ) => {
    if (record.kind !== 'version' || field(view, record, 'id') !== versionId)
      throw Error('Source context affected version identity');
    if (!truthy(view, record, 'sourceContext'))
      await setCount('unresolved', versionId, count('unresolved', versionId) + delta);
    for (const occurrence of records(view, record, 'occurrences')) {
      assertCurrent();
      const sourceId = field<string | null>(view, occurrence, 'proposalId') || id,
        key = refKey(versionId, sourceId),
        raw = writers.versionReferences.peek(key),
        ref: Ref = raw ? JSON.parse(raw) : { versionId, sourceId, count: 0 };
      if (ref.versionId !== versionId || ref.sourceId !== sourceId)
        throw Error('Source context reference collision');
      ref.count += delta;
      if (!Number.isSafeInteger(ref.count) || ref.count < 0)
        throw Error('Invalid source context version reference count');
      if (ref.count) await writers.versionReferences.put(key, JSON.stringify(ref));
      else await writers.versionReferences.remove(key);
    }
  };
  for (const change of input.affected.candidateChanges) {
    assertCurrent();
    if (writers.changedAddresses.peek(change.versionAddress) !== undefined) continue;
    await writers.changedAddresses.put(change.versionAddress, '1');
    if (change.kind === 'update')
      await applyVersion(
        before,
        before.resolve(change.versionAddress),
        change.candidateVersionId,
        -1,
      );
    await applyVersion(
      input.reader,
      input.reader.resolve(change.versionAddress),
      change.candidateVersionId,
      1,
    );
  }
  await writers.versionReferences.flush();
  await writers.unresolved.flush();
  await writers.changedVersions.flush();
  for (const changed of entries(attempt + '.changedVersions'))
    if (count('unresolved', changed.key))
      for (const item of entries(attempt + '.versionReferences', refPrefix(changed.key))) {
        const ref = JSON.parse(item.value) as Ref;
        if (ref.versionId !== changed.key) throw Error('Source context reference identity');
        await changeSourceReference(ref.sourceId, ref.count);
      }
  const intake = input.reader.child(input.reader.root(), 'intake');
  if (!intake) throw Error('Missing staged source context intake');
  for (const proposalId of input.affected.proposalIds) {
    assertCurrent();
    if (writers.allowed.peek(proposalId) !== undefined) continue;
    const proposal = input.reader.find('proposal', intake, proposalId);
    if (!proposal) throw Error('Missing staged source context proposal');
    const revision =
      field<string | null>(input.reader, proposal, 'sourceTextDependencyToken') ||
      field<string | null>(input.reader, proposal, 'sourceTextRevisionId') ||
      null;
    await writers.allowed.put(proposalId, JSON.stringify(revision));
    if (count('references', proposalId)) referencedCount++;
    await writers.dirtySources.put(proposalId, '1');
  }
  await writers.allowed.flush();
  await writers.references.flush();
  const any =
    (store.collection(store.openView(), 'builds', attempt + '.unresolved')?.root?.count ?? 0) > 0;
  if (oldMode !== referencedCount > 0 || oldAny !== any)
    for (const entry of entries(attempt + '.allowed'))
      await writers.dirtySources.put(entry.key, '1');
  await writers.dirtySources.flush();
  let incomingWitness: Witness | undefined;
  const checkPreparedWitness = (witness: Witness) => {
    if (input.incomingProposal?.id === witness.id && !row(db, witness.id)) {
      if (
        physical(profileOriginal(root, input.incomingProposal.path, profileId)) !== witness.physical
      )
        throw new SourceContextClassificationPending('source_changed');
    } else checkWitness(db, root, profileId, witness);
  };
  for (const dirty of entries(attempt + '.dirtySources')) {
    assertCurrent();
    const sourceId = dirty.key,
      allowed = writers.allowed.peek(sourceId),
      active =
        any && allowed !== undefined && (!referencedCount || count('references', sourceId) > 0),
      wasActive = writers.active.peek(sourceId) !== undefined;
    if (active && wasActive) {
      const previous = writers.eligibility.peek(sourceId),
        current = row(db, sourceId);
      if (!previous || !current || signature(current) !== previous)
        return { state: 'pending', reason: 'source_changed' };
      const raw = writers.sources.peek(sourceId);
      if (raw) {
        const witness = JSON.parse(raw) as Witness;
        if (signature(current) !== witness.signature)
          return { state: 'pending', reason: 'source_changed' };
        let refreshed: Witness;
        try {
          const path = profileOriginal(root, current.path, profileId),
            identity = physical(path);
          if (identity === witness.physical) continue;
          if (current.bytes > MAX_INTAKE_BYTES)
            return { state: 'pending', reason: 'source_evidence_unavailable' };
          const bytes = readIntakeFileSync(path);
          recordIntakeFileHash(bytes);
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (bytes.length !== current.bytes || digest !== current.sha256)
            return { state: 'pending', reason: 'source_evidence_unavailable' };
          if (physical(path) !== identity) return { state: 'pending', reason: 'source_changed' };
          refreshed = { ...witness, physical: identity };
          checkPreparedWitness(refreshed);
        } catch (error) {
          if (error instanceof SourceContextClassificationPending)
            return { state: 'pending', reason: error.reason };
          return { state: 'pending', reason: 'source_evidence_unavailable' };
        }
        assertCurrent();
        // Recovery can rematerialize identical retained bytes at a new inode.
        // Reuse their proven classification only after verifying those bytes;
        // the fresh witness still fences replacement before publication.
        const oldCache = 'source.context.file.' + workflowHash([resolve(root), profileId, witness]),
          newCache = 'source.context.file.' + workflowHash([resolve(root), profileId, refreshed]);
        if (store.get(store.openView(), 'builds', oldCache + '.control', 'complete') !== 'ready')
          return { state: 'pending', reason: 'not_prepared' };
        commit(
          ['versions', 'control'].map((kind) => ({
            area: 'builds',
            collection: newCache + '.' + kind,
            op: 'adoptCollection',
            fromArea: 'builds',
            fromCollection: oldCache + '.' + kind,
          })),
        );
        await writers.sources.put(sourceId, JSON.stringify(refreshed));
      }
    }
    if (active === wasActive) continue;
    if (!active) {
      const raw = writers.sources.peek(sourceId);
      if (raw) {
        const witness = JSON.parse(raw) as Witness,
          cache = 'source.context.file.' + workflowHash([resolve(root), profileId, witness]);
        for (const entry of entries(cache + '.versions')) {
          await writers.contexts.remove(refKey(entry.key, sourceId));
          await writers.dirtyVersions.put(entry.key, '1');
        }
      }
      await writers.sources.remove(sourceId);
      await writers.eligibility.remove(sourceId);
      await writers.active.remove(sourceId);
      continue;
    }
    await writers.active.put(sourceId, '1');
    const incoming = input.incomingProposal?.id === sourceId ? input.incomingProposal : undefined,
      selected = row(db, sourceId),
      revision = JSON.parse(allowed!) as string | null;
    if (
      incoming &&
      revision !== (incoming.sourceTextDependencyToken || incoming.sourceTextRevisionId || null)
    )
      throw Error('Incoming proposal source context revision differs from selected first proposal');
    const selectedRow =
      selected ??
      (incoming
        ? ({
            id: sourceId,
            kind: 'intake_proposal',
            path: incoming.path,
            sha256: incoming.sha256,
            bytes: incoming.bytes,
            details_json: '{"validation":{"valid":true}}',
          } as SourceRow)
        : undefined);
    if (!selectedRow) return { state: 'pending', reason: 'source_evidence_unavailable' };
    await writers.eligibility.put(sourceId, signature(selectedRow));
    if (
      incoming &&
      (selectedRow.sha256 !== incoming.sha256 ||
        selectedRow.bytes !== incoming.bytes ||
        selectedRow.path !== incoming.path ||
        selectedRow.kind !== 'intake_proposal')
    )
      throw Error('Incoming source context original binding changed');
    const validation = sourceId === id ? input.reader.child(intake, 'validation') : undefined,
      valid = incoming
        ? true
        : sourceId === id
          ? validation && field(input.reader, validation, 'valid')
          : JSON.parse(selectedRow.details_json)?.validation?.valid;
    if (!valid || selectedRow.bytes > MAX_INTAKE_BYTES) continue;
    let witness: Witness, path: string;
    try {
      path = profileOriginal(root, selectedRow.path, profileId);
      witness = {
        id: sourceId,
        signature: signature(selectedRow),
        physical: physical(path),
        revision,
      };
    } catch {
      return { state: 'pending', reason: 'source_evidence_unavailable' };
    }
    const cache = 'source.context.file.' + workflowHash([resolve(root), profileId, witness]);
    if (store.get(store.openView(), 'builds', cache + '.control', 'complete') !== 'ready') {
      let parsedEntries: readonly IntakeEntry[];
      try {
        const bytes = readIntakeFileSync(path);
        recordIntakeFileHash(bytes);
        if (
          bytes.length !== selectedRow.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== selectedRow.sha256 ||
          physical(path) !== witness.physical
        )
          return { state: 'pending', reason: 'source_changed' };
        if (incoming) parsedEntries = incoming.entries;
        else {
          const parsed = validateJSONL(bytes);
          if (!parsed.valid) return { state: 'pending', reason: 'source_evidence_unavailable' };
          parsedEntries = parsed.entries;
        }
      } catch {
        return { state: 'pending', reason: 'source_evidence_unavailable' };
      }
      const cacheWriter = createEnvelopeBuildWriter(
        db,
        file,
        cache + '.versions',
        before.logical.domainVersion,
        { assertRunning: assertCurrent },
      );
      await cacheWriter.put('initializing', '1');
      await cacheWriter.remove('initializing');
      for (const record of parsedEntries)
        if (sourceContextEnvelope(record.value))
          await cacheWriter.put(intakeCandidateVersionIdForRevision(record, revision), '1');
      await cacheWriter.flush();
      checkPreparedWitness(witness);
      const control = createEnvelopeBuildWriter(
        db,
        file,
        cache + '.control',
        before.logical.domainVersion,
        { assertRunning: assertCurrent },
      );
      await control.put('complete', 'ready');
      await control.flush();
    }
    checkPreparedWitness(witness);
    if (incoming) incomingWitness = witness;
    await writers.sources.put(sourceId, JSON.stringify(witness));
    for (const entry of entries(cache + '.versions')) {
      await writers.contexts.put(
        refKey(entry.key, sourceId),
        JSON.stringify({ versionId: entry.key, sourceId }),
      );
      await writers.dirtyVersions.put(entry.key, '1');
    }
    await setImmediate();
  }
  await writers.contexts.flush();
  await writers.sources.flush();
  await writers.dirtyVersions.flush();
  for (const dirty of entries(attempt + '.dirtyVersions')) {
    assertCurrent();
    let selected: string | undefined;
    if (count('unresolved', dirty.key))
      for (const entry of entries(attempt + '.contexts', refPrefix(dirty.key))) {
        const context = JSON.parse(entry.value) as { versionId: string; sourceId: string };
        if (context.versionId !== dirty.key) throw Error('Source context member identity');
        const raw = writers.sources.peek(context.sourceId);
        if (!raw) return { state: 'pending', reason: 'not_prepared' };
        checkPreparedWitness(JSON.parse(raw) as Witness);
        selected = context.sourceId;
        break;
      }
    const old = readInline(
      store.get(store.openView(), 'builds', prior.collection + '.membership', dirty.key),
    );
    if (selected) await writers.membership.put(dirty.key, selected);
    else await writers.membership.remove(dirty.key);
    if ((selected !== undefined) !== (old !== undefined)) await writers.fanout.put(dirty.key, '1');
  }
  await writers.control.put('referencedCount', String(referencedCount));
  for (const writer of Object.values(writers)) await writer.flush();
  const finalCheck = () => {
    assertCurrent();
    if (incomingWitness) checkPreparedWitness(incomingWitness);
  };
  const assertPublicationCurrent = () => {
    finalCheck();
    if (incomingWitness) checkWitness(db, root, profileId, incomingWitness);
    for (const entry of entries(attempt + '.dirtySources')) {
      const raw = writers.sources.peek(entry.key);
      if (raw) checkWitness(db, root, profileId, JSON.parse(raw) as Witness);
    }
  };
  finalCheck();
  return {
    state: 'ready',
    assertCurrent: finalCheck,
    assertPublicationCurrent,
    changes: MAPS.map((kind) => ({
      area: 'builds',
      collection: destination + '.' + kind,
      op: 'adoptCollection',
      fromArea: 'builds',
      fromCollection: attempt + '.' + kind,
    })),
    additionalVersionIds: (function* () {
      for (const item of entries(attempt + '.fanout')) yield item.key;
    })(),
    isSourceContextVersion(versionId, reader) {
      finalCheck();
      if (reader && JSON.stringify(reader.logical) !== JSON.stringify(input.reader.logical))
        throw new SourceContextClassificationPending('selection_changed');
      const selected = writers.membership.peek(versionId);
      if (selected === undefined) return false;
      const raw = writers.sources.peek(selected);
      if (!raw) throw new SourceContextClassificationPending('not_prepared');
      checkPreparedWitness(JSON.parse(raw) as Witness);
      return true;
    },
  };
}
