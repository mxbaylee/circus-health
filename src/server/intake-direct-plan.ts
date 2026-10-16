/** Direct-file plans keep source metadata once and generate exact legacy units.
 * The source text/HTML indexer still has its existing CRS-232 byte admission;
 * this adapter never expands all pending units or copies that index per plan. */
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, type Database } from './database.ts';
import {
  assertIntakeOwner,
  intakeTransaction,
  withVerifiedIntakeOriginalDescriptor,
} from './intake.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  extractionPins,
  streamedExtractionPlanId,
  type EvidenceIndex,
  type EvidenceRow,
} from './intake-plan.ts';
import { workflowHash } from './intake-workflow.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import {
  prepareIntakeEnvelopeMutation,
  type IntakeEnvelopeMutation,
} from './intake-envelope-mutation.ts';
import {
  createReportSnapshotCatalog,
  type ReportSnapshotMapReader,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import {
  decisionIndexGet,
  selectedReadingStateIndex,
  type IntakeDecisionIndex,
} from './intake-reading-state.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';
import { intakeCollectionCacheGeneration } from './intake-state-collections.ts';
import type { IntakeExtractionCoverage, IntakeExtractionUnit } from '../shared/intake.ts';
import type {
  IntakeDirectPlanV2,
  IntakeDirectUnitReference,
} from '../shared/intake-direct-plan.ts';

const FORMAT = 'health-intake-direct-plan-v2';
const INDEX_POLICY = 'health-intake-direct-source-index-v1';
const RECIPE_POLICY = 'health-intake-direct-unit-v1';
const sourceIndexId = (hash: string) => 'direct:' + workflowHash([INDEX_POLICY, hash]);
const recipeName = (plan: Pick<IntakeDirectPlanV2, 'sourceIndex' | 'unitSize' | 'overlap'>) =>
  'direct.recipe.' + workflowHash([plan.sourceIndex.id, plan.unitSize, plan.overlap]);
const decisionsName = (kind: string, planId: string) =>
  'package.' + kind + '.' + workflowHash(planId);
type Kind = IntakeDirectPlanV2['sourceIndex']['kind'];
type Header = { kind: Kind; sourceHash: string; pages?: number; sections: number };
type Section = { locator: string; start?: number; end?: number; rows: number; headings: number };
type Location = { section: number; local: number };
type Recipe = {
  value: Omit<IntakeExtractionUnit, 'id' | 'status' | 'attempts'> & {
    rows?: string[];
    note?: string;
  };
  headings?: ReportSnapshotMapReader;
};
function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind !== 'value') throw Error('Missing bounded direct plan field: ' + name);
  return value.value as T;
}
function json<T>(reader: ReportSnapshotMapReader, key: string): T {
  const value = reader.get(key);
  if (typeof value !== 'string') throw Error('Missing bounded direct index entry: ' + key);
  return JSON.parse(value) as T;
}
function source(db: Database, profileId: string, id: string) {
  assertIntakeOwner(db, profileId);
  const file = db
    .prepare(
      "SELECT id,kind,sha256,details_json,provider_id,mime_type FROM source_files WHERE id=? AND kind='intake_original'",
    )
    .get(id) as
    | {
        id: string;
        kind: string;
        sha256: string;
        details_json: string;
        provider_id: string;
        mime_type: string;
      }
    | undefined;
  if (!file) throw new HttpError(404, 'NOT_FOUND', 'Source intake not found');
  return file;
}
function planValue(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
): IntakeDirectPlanV2 | undefined {
  const format = view.field(record, 'format', { bytes: 256 });
  if (format.kind !== 'value' || format.value !== FORMAT) return undefined;
  const pinsRecord = view.child(record, 'pins');
  if (!pinsRecord) throw Error('Direct plan pins are missing');
  const pins: Record<string, unknown> = {};
  for (const name of [
    'sourceHash',
    'backend',
    'model',
    'reasoningEffort',
    'connectionIdentity',
    'instructionVersion',
    'mappingVersion',
    'reviewedMetadataVersion',
  ]) {
    const value = view.field(pinsRecord, name, { bytes: 8192 });
    if (value.kind === 'value') pins[name] = value.value;
    else if (value.kind !== 'missing') throw Error('Fragmented direct plan pin');
  }
  const result: IntakeDirectPlanV2 = {
    format: FORMAT,
    id: field(view, record, 'id'),
    createdAt: field(view, record, 'createdAt'),
    status: field(view, record, 'status'),
    pins: pins as unknown as IntakeDirectPlanV2['pins'],
    sourceIndex: field(view, record, 'sourceIndex'),
    unitRecipe: field(view, record, 'unitRecipe'),
    unitSize: field(view, record, 'unitSize'),
    overlap: field(view, record, 'overlap'),
    unitCount: field(view, record, 'unitCount'),
  };
  if (
    !/^plan:[a-f0-9]{64}$/.test(result.id) ||
    !['active', 'superseded'].includes(result.status) ||
    result.unitRecipe !== RECIPE_POLICY ||
    !Number.isSafeInteger(result.unitCount) ||
    result.unitCount < 0 ||
    result.sourceIndex.id !== sourceIndexId(result.pins.sourceHash) ||
    result.sourceIndex.sourceHash !== result.pins.sourceHash
  )
    throw Error('Invalid direct plan descriptor');
  checkOptions(result.sourceIndex.kind, result);
  return result;
}
function checkOptions(kind: string, input: { unitSize?: number; overlap?: number }) {
  const unitSize = input.unitSize ?? (kind === 'pdf' ? 2 : 25),
    overlap = input.overlap ?? (kind === 'pdf' ? 0 : Math.min(1, unitSize - 1));
  if (
    !Number.isSafeInteger(unitSize) ||
    unitSize < 1 ||
    unitSize > 50 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= unitSize
  )
    throw new HttpError(
      400,
      'PLAN_INPUT',
      'Choose a unit size of 1–50 and smaller nonnegative context overlap',
    );
  return { unitSize, overlap };
}
function countWindows(length: number, size: number, overlap: number) {
  if (!Number.isSafeInteger(length) || length < 0) throw Error('Invalid direct index extent');
  return length ? 1 + Math.max(0, Math.ceil((length - size) / (size - overlap))) : 0;
}
function sectionCount(section: Section, plan: { unitSize: number; overlap: number }) {
  return section.rows
    ? countWindows(section.rows, plan.unitSize, plan.overlap)
    : countWindows((section.end ?? 0) - (section.start ?? 0), 12000, 2000);
}
function recipe(
  index: ReportSnapshotMapReader,
  plan: Pick<IntakeDirectPlanV2, 'sourceIndex' | 'unitSize' | 'overlap'>,
  location: Location,
): Recipe {
  const header = json<Header>(index, 'header');
  if (header.kind === 'pdf') {
    const start = 1 + location.local * (plan.unitSize - plan.overlap),
      end = Math.min(header.pages!, start + plan.unitSize - 1);
    if (start > end) throw Error('Direct page window is outside its source');
    return {
      value: {
        kind: 'pdf',
        locator: `pages ${start}–${end}`,
        pages: Array.from({ length: end - start + 1 }, (_, at) => start + at),
      },
    };
  }
  if (header.kind === 'image')
    return {
      value: {
        kind: 'image',
        locator: 'whole retained image',
        note: 'One host-indexed image occurrence. Read the visual original before recording an explicit disposition.',
      },
    };
  const section = index.reference('section:' + schemaOrdinal(location.section));
  if (!section) throw Error('Direct source section is missing');
  const meta = json<Section>(section, 'header');
  if (meta.rows) {
    const start = location.local * (plan.unitSize - plan.overlap),
      end = Math.min(meta.rows, start + plan.unitSize),
      rows: EvidenceRow[] = [];
    for (let at = start; at < end; at++) rows.push(json(section, 'row:' + schemaOrdinal(at)));
    if (!rows.length) throw Error('Direct row window is outside its source');
    return {
      value: {
        kind: 'html',
        locator: `${meta.locator}, rows ${start + 1}–${end}`,
        start: rows[0]!.start,
        end: rows.at(-1)!.end,
        rows: rows.map((row) => row.id),
      },
      headings: section,
    };
  }
  const start = meta.start! + location.local * 10000,
    end = Math.min(meta.end!, start + 12000);
  if (start >= end) throw Error('Direct text window is outside its source');
  return {
    value: { kind: header.kind, locator: `characters ${start}–${end}`, start, end },
    ...(meta.headings ? { headings: section } : {}),
  };
}
function* recipeChunks(value: Recipe): Generator<string> {
  const base = JSON.stringify(value.value);
  if (!value.headings) {
    yield base;
    return;
  }
  yield base.slice(0, -1) + ',"sharedHeadings":';
  yield* value.headings.chunks('headings');
  yield '}';
}
function identity(value: Recipe) {
  const digest = createHash('sha256');
  for (const chunk of recipeChunks(value)) digest.update(chunk);
  return 'unit:' + digest.digest('hex');
}
function* locations(
  index: ReportSnapshotMapReader,
  plan: Pick<IntakeDirectPlanV2, 'sourceIndex' | 'unitSize' | 'overlap'>,
) {
  const header = json<Header>(index, 'header');
  if (header.kind === 'pdf' || header.kind === 'image') {
    const count =
      header.kind === 'image' ? 1 : countWindows(header.pages!, plan.unitSize, plan.overlap);
    for (let local = 0; local < count; local++) yield { section: 0, local };
    return;
  }
  for (let section = 0; section < header.sections; section++) {
    const selected = index.reference('section:' + schemaOrdinal(section));
    if (!selected) throw Error('Direct source section is missing');
    const count = sectionCount(json(selected, 'header'), plan);
    for (let local = 0; local < count; local++) yield { section, local };
  }
}
async function saveSourceIndex(
  writer: ReportSnapshotMapWriter,
  index: EvidenceIndex,
  sourceHash: string,
  catalog: ReturnType<typeof createReportSnapshotCatalog>,
) {
  if (!['pdf', 'image', 'html', 'text'].includes(index.kind))
    throw new HttpError(
      415,
      'PLAN_UNSUPPORTED',
      'This format has no resumable text/page index yet. Originals remain available.',
    );
  await writer.put(
    'header',
    JSON.stringify({
      kind: index.kind,
      sourceHash,
      pages: index.pages,
      sections: index.sections?.length ?? 0,
    }),
  );
  // This is the existing bounded source-index creation boundary, not a workflow read.
  await writer.putText('evidence', [JSON.stringify(index)]);
  for (let ordinal = 0; ordinal < (index.sections?.length ?? 0); ordinal++) {
    const section = index.sections![ordinal]!,
      child = await catalog.fork(),
      headings = section.sharedHeadings ?? [],
      rows = section.rows ?? [];
    await child.put(
      'header',
      JSON.stringify({
        locator: section.locator,
        start: section.start,
        end: section.end,
        rows: rows.length,
        headings: headings.length,
      }),
    );
    for (let offset = 0; offset < rows.length; offset += 16)
      await child.putMany(
        rows.slice(offset, offset + 16).map((row, at) => ({
          key: 'row:' + schemaOrdinal(offset + at),
          value: JSON.stringify(row),
        })),
      );
    function* headingChunks() {
      yield '[';
      let first = true;
      for (const item of headings) {
        if (!first) yield ',';
        yield JSON.stringify(item);
        first = false;
      }
      if (rows.length)
        for (const row of rows)
          if (row.header) {
            if (!first) yield ',';
            yield JSON.stringify({ start: row.start, end: row.end });
            first = false;
          }
      yield ']';
    }
    await child.putText('headings', headingChunks());
    await writer.attach('section:' + schemaOrdinal(ordinal), child);
  }
}
async function prepareRecipe(
  db: Database,
  file: ReturnType<typeof source>,
  index: ReportSnapshotMapReader,
  plan: Pick<IntakeDirectPlanV2, 'sourceIndex' | 'unitSize' | 'overlap'>,
  options: { assertRunning?: () => void } = {},
) {
  const { collections } = selectedEnvelopeStore(db, file),
    name = recipeName(plan),
    selected = collections.openView();
  const complete = collections.get(selected, 'builds', name, 'complete');
  if (typeof complete === 'string') return { name, count: Number(complete) };
  const writer = createEnvelopeBuildWriter(
    db,
    file,
    name,
    intakeSourceVersion(db, file.id).rawVersion,
    options,
  );
  let ordinal = 0;
  for (const location of locations(index, plan)) {
    options.assertRunning?.();
    index.assertCurrent();
    const id = identity(recipe(index, plan, location)),
      value = JSON.stringify({ id, ordinal, ...location });
    await writer.put('ordinal:' + schemaOrdinal(ordinal), value);
    // Unit recipes can repeat in historical malformed indexes; first-ID semantics match find().
    if (writer.peek('id:' + id) === undefined) await writer.put('id:' + id, value);
    ordinal++;
  }
  await writer.put('complete', String(ordinal));
  await writer.flush();
  return { name, count: ordinal };
}
type DirectContext = NonNullable<ReturnType<typeof readContext>>;
const directContexts = new WeakMap<
  Database,
  {
    stamp: string;
    generation: object;
    values: Map<string, DirectContext>;
  }
>();
const directContextStamps = new WeakMap<Database, ReturnType<Database['prepare']>>();
function contextStamp(db: Database) {
  let query = directContextStamps.get(db);
  if (!query) {
    query = db.prepare(
      'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
    );
    query.setReadBigInts(true);
    directContextStamps.set(db, query);
  }
  const stamp = query.get()!;
  return `${stamp.changes}:${stamp.external}:${stamp.schema}`;
}
function freezeHeader(value: unknown) {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object' || Object.isFrozen(next)) continue;
    pending.push(...Object.values(next));
    Object.freeze(next);
  }
}
/** Bounded decoded plan headers are reusable only in the exact unchanged SQL
 * projection. Transaction-local reads never populate or reuse this cache:
 * rolling back a temporary repair need not advance total_changes(). */
function context(
  db: Database,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string } = {},
) {
  if (db.isTransaction) {
    directContexts.delete(db);
    return readContext(db, profileId, id, options);
  }
  const stamp = contextStamp(db),
    generation = intakeCollectionCacheGeneration(db),
    file = source(db, profileId, id),
    key = JSON.stringify([profileId, id, options.planId ?? null, options.recordAddress ?? null]);
  let cache = directContexts.get(db);
  if (!cache || cache.stamp !== stamp || cache.generation !== generation) {
    cache = { stamp, generation, values: new Map() };
    directContexts.set(db, cache);
  }
  const cached = cache.values.get(key);
  if (
    cached &&
    Object.keys(file).every(
      (name) => file[name as keyof typeof file] === cached.file[name as keyof typeof file],
    ) &&
    !db.isTransaction &&
    contextStamp(db) === stamp &&
    intakeCollectionCacheGeneration(db) === generation
  ) {
    cache.values.delete(key);
    cache.values.set(key, cached);
    return cached;
  }
  const value = readContext(db, profileId, id, options);
  if (
    value &&
    !db.isTransaction &&
    contextStamp(db) === stamp &&
    intakeCollectionCacheGeneration(db) === generation
  ) {
    freezeHeader(value.file);
    freezeHeader(value.plan);
    freezeHeader(value.reader.logical);
    Object.freeze(value.reader);
    Object.freeze(value.index);
    const remember = (address: string) => {
      if (Buffer.byteLength(address) > 4096) return;
      cache.values.set(address, value);
      while (cache.values.size > 32) cache.values.delete(cache.values.keys().next().value!);
    };
    remember(key);
    // An exact retained address is unambiguous even when historical plan IDs
    // repeat. Do not alias an arbitrary plan-ID lookup to another occurrence.
    remember(JSON.stringify([profileId, id, null, value.reader.address(value.record)]));
  }
  return value;
}
function readContext(
  db: Database,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string } = {},
) {
  const file = source(db, profileId, id),
    reader = openIntakeCollectionEnvelope(db, file),
    intake = reader.child(reader.root(), 'intake'),
    flow = intake && reader.child(intake, 'workflow');
  if (!flow) return undefined;
  let record = options.recordAddress
    ? reader.resolve(options.recordAddress)
    : options.planId
      ? reader.find('plan', flow, options.planId)
      : undefined;
  if (!record && options.planId === undefined && options.recordAddress === undefined) {
    const collections = selectedEnvelopeStore(db, file).collections;
    const selected = collections.get(
      collections.openView(),
      'logical',
      'direct.selection',
      'active',
    );
    if (selected !== undefined) {
      if (typeof selected !== 'string') throw Error('Invalid selected direct plan');
      record = reader.find('plan', flow, selected);
      if (!record || field(reader, record, 'status') !== 'active')
        throw Error('Selected direct plan disagrees');
    }
    if (!record) {
      let after: string | undefined;
      do {
        const page = reader.children(flow, 'plans', { after, items: 32, bytes: 32768 });
        record = page.records.find((item) => field(reader, item, 'status') === 'active');
        if (record || page.complete) break;
        after = page.after ?? undefined;
        if (!after) throw Error('Direct plan header cursor did not advance');
      } while (true);
    }
  }
  if (!record) return undefined;
  const plan = planValue(reader, record);
  if (!plan) return undefined;
  const catalog = createReportSnapshotCatalog(db, file, { catalog: 'plan.indexes' }),
    index = catalog.open(plan.sourceIndex.id);
  if (!index || json<Header>(index, 'header').sourceHash !== plan.pins.sourceHash)
    throw Error('Selected direct source index is unavailable');
  return { file, reader, record, plan, index, flow, catalog };
}

export async function prepareDirectPlanAccess(
  db: Database,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string; assertRunning?: () => void } = {},
) {
  const ctx = context(db, profileId, id, options);
  if (!ctx) return;
  const prepared = await prepareRecipe(db, ctx.file, ctx.index, ctx.plan, options);
  if (prepared.count !== ctx.plan.unitCount) throw Error('Direct plan recipe count disagrees');
}

/** Summary selection needs no unit lookup preparation or history traversal. */
export function readDirectPlanHeader(db: Database, profileId: string, id: string) {
  const ctx = context(db, profileId, id);
  if (!ctx) return undefined;
  return {
    format: 'health-intake-plan-header-v1' as const,
    id: ctx.plan.id,
    createdAt: ctx.plan.createdAt,
    status: ctx.plan.status,
    pins: ctx.plan.pins,
    unitCount: ctx.plan.unitCount,
    batchCount: ctx.reader.childCount(ctx.record, 'batches'),
  };
}

export function readDirectPlanScope(
  db: Database,
  profileId: string,
  id: string,
  options: { planId?: string; recordAddress?: string } = {},
) {
  const ctx = context(db, profileId, id, options);
  if (!ctx) return undefined;
  const { file, reader, record, plan, index } = ctx,
    { collections } = selectedEnvelopeStore(db, file),
    before = intakeSourceVersion(db, id),
    name = recipeName(plan);
  if (
    collections.get(collections.openView(), 'builds', name, 'complete') !== String(plan.unitCount)
  )
    throw Error('Prepare direct plan access before reading units');
  const assertCurrent = () => {
    assertIntakeOwner(db, profileId);
    index.assertCurrent();
  };
  const decisionIndex = (kind: string): IntakeDecisionIndex => {
    if (kind === 'readingSkipped' || kind === 'exceptions') {
      const selected = selectedReadingStateIndex(collections, reader.address(record), kind);
      if (selected) return selected;
    }
    return { area: 'logical', collection: decisionsName(kind, plan.id) };
  };
  const decision = <T>(kind: string, key: string): T | undefined => {
    const value = decisionIndexGet(collections, decisionIndex(kind), key);
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw Error('Invalid direct plan decision');
    return JSON.parse(value) as T;
  };
  const lookup = (key: string) => {
    assertCurrent();
    const raw = collections.get(collections.openView(), 'builds', name, key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw Error('Invalid direct unit lookup');
    return JSON.parse(raw) as Location & { id: string; ordinal: number };
  };
  const unit = (location: ReturnType<typeof lookup>) => {
    if (!location) return undefined;
    const initial = recipe(index, plan, location),
      saved = decision<{ batchId: string; coverageOrdinal: number; attemptCount: number }>(
        'units',
        location.id,
      );
    let coverage: IntakeExtractionCoverage | undefined;
    if (saved) {
      if (
        !Number.isSafeInteger(saved.attemptCount) ||
        saved.attemptCount < 1 ||
        !Number.isSafeInteger(saved.coverageOrdinal) ||
        saved.coverageOrdinal < 0 ||
        decisionIndexGet(
          collections,
          decisionIndex('attempts'),
          workflowHash([location.id, saved.batchId]),
        ) !== '1'
      )
        throw Error('Direct unit attempt is not retained');
      const batch = reader.find('batch', record, saved.batchId),
        retained = batch && reader.childAt(batch, 'coverage', saved.coverageOrdinal);
      if (!retained || field(reader, retained, 'unitId') !== location.id)
        throw Error('Direct unit coverage disagrees with its receipt');
      const notes = reader.field(retained, 'notes', { bytes: 32768 });
      if (notes.kind !== 'value' || typeof notes.value !== 'string')
        throw Error('Direct unit coverage notes are unavailable');
      coverage = { unitId: location.id, kind: field(reader, retained, 'kind'), notes: notes.value };
      if (!['inspected', 'extracted', 'context', 'unreadable'].includes(coverage.kind))
        throw Error('Invalid direct coverage');
    }
    const exception = decision<IntakeExtractionUnit['processingException']>(
      'exceptions',
      location.id,
    );
    if (
      exception &&
      (exception.reason !== 'processing_stalled' || typeof exception.at !== 'string')
    )
      throw Error('Invalid direct processing exception');
    const metadata: IntakeDirectUnitReference = {
      format: 'health-intake-direct-unit-reference-v1',
      intakeId: id,
      planId: plan.id,
      sourceIndexId: plan.sourceIndex.id,
      ordinal: location.ordinal,
      version: before.version,
    };
    return {
      ...initial.value,
      id: location.id,
      ordinal: location.ordinal,
      record: undefined,
      status: (coverage?.kind === 'extracted'
        ? 'completed'
        : coverage
          ? 'partial'
          : 'pending') as IntakeExtractionUnit['status'],
      attemptCount: saved?.attemptCount ?? 0,
      ...(coverage ? { coverage } : {}),
      ...(exception ? { processingException: exception } : {}),
      metadata,
      ...(initial.headings ? { sharedHeadings: { state: 'referenced' as const, metadata } } : {}),
    };
  };
  const unitById = (unitId: string) => unit(lookup('id:' + unitId));
  return {
    format: 'direct' as const,
    plan,
    planId: plan.id,
    version: before.version,
    reader,
    record,
    pinsRecord: reader.child(record, 'pins')!,
    indexRecord: undefined,
    pinsHash: workflowHash(plan.pins),
    unitCount: plan.unitCount,
    assertCurrent,
    pin: (name: string): unknown => plan.pins[name as keyof typeof plan.pins],
    unitAt: (ordinal: number) => unit(lookup('ordinal:' + schemaOrdinal(ordinal))),
    unitIdentityAt(ordinal: number) {
      const location = lookup('ordinal:' + schemaOrdinal(ordinal));
      return location ? { id: location.id, ordinal: location.ordinal } : undefined;
    },
    unitById,
    accountedKind(unitId: string) {
      const value = unitById(unitId);
      return value?.coverage && value.coverage.kind !== 'inspected' ? value.coverage.kind : null;
    },
    decisionIndex,
    decisionCollection: (kind: string) => decisionsName(kind, plan.id),
    compatibilityChanges: (): IntakeCollectionChange[] => [],
    *unitMetadataChunks(ordinal: number) {
      const location = lookup('ordinal:' + schemaOrdinal(ordinal));
      if (!location) throw Error('Direct unit not found');
      yield* recipeChunks(recipe(index, plan, location));
    },
    sourceIndexChunks: () => index.chunks('evidence'),
    metadataPage(
      ordinal: number,
      section: 'sharedHeadings' | 'sourceIndex',
      options: { after?: string; bytes: number },
    ) {
      assertCurrent();
      const location = lookup('ordinal:' + schemaOrdinal(ordinal));
      if (!location) throw new HttpError(404, 'NOT_FOUND', 'Direct extraction unit not found');
      const selected =
        section === 'sourceIndex'
          ? index.get('evidence')
          : (recipe(index, plan, location).headings?.get('headings') ?? '[]');
      if (selected === undefined) throw Error('Direct metadata is unavailable');
      const valueRoot = workflowHash([plan.sourceIndex.id, ordinal, section, selected]);
      if (typeof selected === 'string') {
        const prefix = 'inline:' + valueRoot + ':';
        if (options.after && !options.after.startsWith(prefix))
          throw new HttpError(409, 'PLAN_CHANGED', 'Refresh this metadata reference');
        const offset = options.after ? Number(options.after.slice(prefix.length)) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length)
          throw new HttpError(400, 'PLAN_METADATA', 'Invalid metadata cursor');
        let end = offset,
          used = 0;
        for (const character of selected.slice(offset)) {
          const size = Buffer.byteLength(character);
          if (used + size > options.bytes) break;
          used += size;
          end += character.length;
        }
        if (end === offset && end < selected.length)
          throw new HttpError(400, 'PLAN_METADATA', 'Metadata budget cannot fit a character');
        return {
          text: selected.slice(offset, end),
          complete: end === selected.length,
          nextCursor: end === selected.length ? null : prefix + end,
          totalBytes: Buffer.byteLength(selected),
          valueRoot,
        };
      }
      const page = collections.readBytes(selected, {
        after: options.after,
        items: 16,
        bytes: options.bytes,
      });
      const text = Buffer.concat(page.chunks).toString('utf8');
      return {
        text,
        complete: page.complete,
        nextCursor: page.after,
        totalBytes: selected.bytes,
        valueRoot,
      };
    },
  };
}

export function readDirectUnitMetadataFragment(
  db: Database,
  profileId: string,
  id: string,
  reference: IntakeDirectUnitReference,
  options: { section: 'sharedHeadings' | 'sourceIndex'; cursor?: string; bytes?: number },
) {
  if (
    !reference ||
    reference.format !== 'health-intake-direct-unit-reference-v1' ||
    reference.intakeId !== id ||
    !Number.isSafeInteger(reference.ordinal) ||
    reference.ordinal < 0 ||
    !['sharedHeadings', 'sourceIndex'].includes(options.section)
  )
    throw new HttpError(
      400,
      'PLAN_METADATA',
      'Use the metadata reference from a selected direct unit',
    );
  const scope = readDirectPlanScope(db, profileId, id, { planId: reference.planId });
  if (
    !scope ||
    scope.version !== reference.version ||
    scope.plan.sourceIndex.id !== reference.sourceIndexId
  )
    throw new HttpError(409, 'PLAN_CHANGED', 'This plan changed. Refresh its metadata reference.');
  const bytes = options.bytes ?? 32768;
  if (!Number.isSafeInteger(bytes) || bytes < 4096 || bytes > 32768)
    throw new HttpError(
      400,
      'PLAN_METADATA',
      'Choose a metadata byte budget between 4096 and 32768',
    );
  return {
    format: 'health-intake-direct-metadata-fragment-v1' as const,
    reference,
    section: options.section,
    encoding: 'json' as const,
    ...scope.metadataPage(reference.ordinal, options.section, { after: options.cursor, bytes }),
  };
}

export async function createPagedDirectPlan(
  db: Database,
  root: string,
  profileId: string,
  id: string,
  input: {
    version: number;
    operationId?: string;
    replacePlanId?: string;
    unitSize?: number;
    overlap?: number;
    assertRunning?: () => void;
  },
) {
  const file = source(db, profileId, id),
    reader = openIntakeCollectionEnvelope(db, file),
    before = intakeSourceVersion(db, id),
    intake = reader.child(reader.root(), 'intake');
  if (!intake) throw Error('Missing intake envelope');
  const flow = reader.child(intake, 'workflow'),
    { collections } = selectedEnvelopeStore(db, file),
    { version: _version, assertRunning: _assert, ...request } = input,
    fingerprint = workflowHash(request);
  if (
    input.operationId !== undefined &&
    (typeof input.operationId !== 'string' ||
      !input.operationId.trim() ||
      input.operationId.length > 200)
  )
    throw new HttpError(400, 'OPERATION_ID', 'Use a stable operation ID of at most 200 characters');
  const result = (plan: IntakeDirectPlanV2, replayed: boolean) => ({
    format: 'health-intake-direct-plan-result-v2' as const,
    intakeId: id,
    version: intakeSourceVersion(db, id).version,
    plan,
    replayed,
  });
  const prior =
    input.operationId &&
    collections.get(
      collections.openView(),
      'logical',
      'direct.commands',
      workflowHash(input.operationId),
    );
  if (prior) {
    if (typeof prior !== 'string') throw Error('Invalid direct plan command');
    const receipt = JSON.parse(prior) as { fingerprint: string; planId: string };
    if (receipt.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    const retained = flow && reader.find('plan', flow, receipt.planId),
      plan = retained && planValue(reader, retained);
    if (!plan) throw Error('Retained direct plan command is missing');
    return result(plan, true);
  }
  if (input.operationId && flow && reader.find('operation', flow, input.operationId)) {
    const operation = reader.find('operation', flow, input.operationId)!;
    if (field(reader, operation, 'fingerprint') !== fingerprint)
      throw new HttpError(
        409,
        'OPERATION_CONFLICT',
        'This operation already records a different request',
      );
    // Exact old operation replay retains its old result through the host summary.
    return {
      format: 'health-intake-retained-plan-result-v1' as const,
      intakeId: id,
      version: before.version,
      replayed: true,
    };
  }
  if (!Number.isSafeInteger(input.version) || input.version !== before.version)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  return withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id, assertRunning: input.assertRunning },
    async ({ assertRunning }) => {
      const pins = extractionPins(db, file),
        pinHash = workflowHash(pins),
        assertCurrent = () => {
          assertRunning();
          assertIntakeOwner(db, profileId);
          const current = intakeSourceVersion(db, id);
          if (
            current.version !== before.version ||
            current.logicalBinding !== before.logicalBinding ||
            workflowHash(extractionPins(db, source(db, profileId, id))) !== pinHash
          )
            throw new HttpError(
              409,
              'EXTRACTION_CONFIG_CHANGED',
              'Source or extraction settings changed. Reload before creating the plan.',
            );
        };
      const catalog = createReportSnapshotCatalog(db, file, {
          catalog: 'plan.indexes',
          assertRunning: assertCurrent,
        }),
        indexId = sourceIndexId(file.sha256);
      let index = catalog.open(indexId);
      if (!index) {
        const { indexIntakeEvidence } = await import('./intake-evidence.ts');
        const indexed = (await indexIntakeEvidence({
          db,
          root,
          profileId,
          id,
          assertRunning: assertCurrent,
        })) as EvidenceIndex;
        const writer = await catalog.fork();
        await saveSourceIndex(writer, indexed, file.sha256, catalog);
        await catalog.publish(indexId, writer);
        index = catalog.open(indexId)!;
      }
      const header = json<Header>(index, 'header'),
        options = checkOptions(header.kind, input),
        shape = {
          sourceIndex: { id: indexId, kind: header.kind, sourceHash: file.sha256 },
          ...options,
        };
      const lookup = await prepareRecipe(db, file, index, shape, { assertRunning: assertCurrent });
      const recipeKey = workflowHash([indexId, options, pins]),
        known = collections.get(collections.openView(), 'logical', 'direct.recipes', recipeKey);
      let planId: string;
      if (typeof known === 'string') planId = known;
      else {
        function* ids() {
          for (let ordinal = 0; ordinal < lookup.count; ordinal++) {
            const value = collections.get(
              collections.openView(),
              'builds',
              lookup.name,
              'ordinal:' + schemaOrdinal(ordinal),
            );
            if (typeof value !== 'string') throw Error('Direct unit identity is unavailable');
            yield (JSON.parse(value) as { id: string }).id;
          }
        }
        planId = (await streamedExtractionPlanId(db, id, pins, ids(), assertCurrent)).id;
      }
      const retained = flow && reader.find('plan', flow, planId);
      const retainedNative = retained ? planValue(reader, retained) : undefined;
      let current: IntakeEnvelopeRecord | undefined;
      if (flow) {
        const active = collections.get(
          collections.openView(),
          'logical',
          'direct.selection',
          'active',
        );
        if (active !== undefined) {
          if (typeof active !== 'string') throw Error('Invalid selected direct plan');
          current = reader.find('plan', flow, active);
          if (!current || field(reader, current, 'status') !== 'active')
            throw Error('Selected direct plan disagrees');
        }
        let after: string | undefined;
        while (!current) {
          const page = reader.children(flow, 'plans', { after, items: 32, bytes: 32768 });
          current = page.records.find((item) => field(reader, item, 'status') === 'active');
          if (current || page.complete) break;
          after = page.after ?? undefined;
          if (!after) throw Error('Plan header cursor did not advance');
        }
      }
      if (!retained && current && input.replacePlanId !== field(reader, current, 'id'))
        throw new HttpError(
          409,
          'PLAN_CHANGED',
          'Explicitly replace the prior extraction plan; completed work remains retained',
        );
      const plan: IntakeDirectPlanV2 = retainedNative || {
        format: FORMAT,
        id: planId,
        createdAt: new Date().toISOString(),
        status: 'active',
        pins,
        ...shape,
        unitRecipe: RECIPE_POLICY,
        unitCount: lookup.count,
      };
      const operation = input.operationId
          ? { id: input.operationId, fingerprint, at: new Date().toISOString() }
          : undefined,
        changes: IntakeEnvelopeMutation[] = [];
      if (flow) {
        if (!retained) {
          if (current)
            changes.push({
              op: 'set',
              record: current,
              field: 'status',
              jsonText: JSON.stringify('superseded'),
            });
          changes.push({
            op: 'append',
            record: flow,
            field: 'plans',
            jsonText: JSON.stringify(plan),
          });
        }
        if (operation)
          changes.push({
            op: 'append',
            record: flow,
            field: 'operations',
            jsonText: JSON.stringify(operation),
          });
      } else
        changes.push({
          op: 'set',
          record: intake,
          field: 'workflow',
          jsonText: JSON.stringify({
            format: 'health-intake-workflow-v1',
            plans: [plan],
            operations: operation ? [operation] : [],
          }),
        });
      const additionalLogicalChanges: IntakeCollectionChange[] = [
        ...(await catalog.finalChanges()),
        { area: 'logical', collection: 'direct.recipes', op: 'put', key: recipeKey, value: planId },
        ...(!retained || current
          ? [
              {
                area: 'logical' as const,
                collection: 'direct.selection',
                op: 'put' as const,
                key: 'active',
                value: retained ? field<string>(reader, current!, 'id') : planId,
              },
            ]
          : [
              {
                area: 'logical' as const,
                collection: 'direct.selection',
                op: 'delete' as const,
                key: 'active',
              },
            ]),
        ...(operation && (!retained || retainedNative)
          ? [
              {
                area: 'logical' as const,
                collection: 'direct.commands',
                op: 'put' as const,
                key: workflowHash(operation.id),
                value: JSON.stringify({ fingerprint, planId }),
              },
            ]
          : []),
      ];
      const operationId = randomUUID(),
        prepared = await prepareIntakeEnvelopeMutation(db, file, {
          reader,
          changes,
          additionalLogicalChanges,
          operationId,
          requestDigest: fingerprint,
          domainVersion: before.rawVersion + 1,
          assertRunning: assertCurrent,
          async prepareDerived(derived) {
            const { recordCollectionReaderCoverageTransition } =
              await import('./intake-source-reader-index.ts');
            const planAddresses: string[] = [];
            if (!retained) {
              if (current) planAddresses.push(reader.address(current));
              const stagedIntake = derived.reader.child(derived.reader.root(), 'intake')!;
              const stagedFlow = derived.reader.child(stagedIntake, 'workflow')!;
              const appended = derived.reader.childAt(
                stagedFlow,
                'plans',
                flow ? reader.childCount(flow, 'plans') : 0,
              );
              if (!appended) throw Error('New direct reader plan is missing');
              planAddresses.push(derived.reader.address(appended));
            }
            return recordCollectionReaderCoverageTransition(db, file, derived, { planAddresses });
          },
        });
      assertCurrent();
      intakeTransaction(
        db,
        () => {
          assertCurrent();
          collections.stage(prepared.prepared!);
        },
        { operationId, fingerprint },
      );
      if (retained && !retainedNative)
        return {
          format: 'health-intake-retained-plan-result-v1' as const,
          intakeId: id,
          version: intakeSourceVersion(db, id).version,
          replayed: false,
        };
      return result(plan, false);
    },
  );
}
