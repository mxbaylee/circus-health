/** Explicit collection-backed reading progress. It is not clinical coverage. */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  prepareReadingPendingIndex,
  beginReadingPendingIndexUpdate,
} from './intake-reading-pending-index.ts';
import { HttpError, observeDatabaseClose, type Database } from './database.ts';
import { assertIntakeOwner, getIntakeEvidenceHeader } from './intake.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import { readPackagePlanScope, readPackageUnitPage } from './intake-package-plan.ts';
import { nextPendingPagedPackageUnit } from './intake-package-batch.ts';
import { readRetainedPlanScope } from './intake-retained-plan.ts';
import { readDirectPlanScope } from './intake-direct-plan.ts';
import {
  decisionIndexRank,
  decisionIndexCount,
  type IntakeDecisionIndex,
} from './intake-reading-state.ts';
import { openCollectionModelIntakeBackend } from './intake-model-collection-backend.ts';
import { modelIntakeRecordReference } from './intake-model-context-v4.ts';
import { intakeSourceVersion, intakeSourceMetadata } from './intake-state-access.ts';
import { iterateIntakeSourceAncestry } from './intake-source-ancestry.ts';
import {
  selectedEnvelopeStore,
  openIntakeCollectionEnvelope,
} from './intake-collection-envelope.ts';
import { createEnvelopeBuildWriter } from './intake-envelope-build.ts';
import { schemaOrdinal } from './intake-envelope-schema.ts';
import {
  readVerifiedWorkflowSummary,
  readVerifiedWorkflowReadingFacts,
} from './intake-workflow-state.ts';
import {
  conversionReadDetails,
  conversionDeferredReceipt,
  conversionReadDescriptor as descriptor,
  conversionWindowKey as windowKey,
  conversionJSONScope as jsonScope,
  conversionScopeKey as scopeKey,
  type ReadArgs,
  type ReadWindow,
  type ConversionCheckpoint,
} from './intake-continuation.ts';
import type { IntakeExtractionCoverage } from '../shared/intake.ts';
import {
  openLegacyReadingSession,
  prepareLegacyReadingUpdate,
  legacyReadingUnitKey,
  prepareLegacyReadingTargets,
} from './intake-reading-legacy.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const POLICY = 'health-intake-reading-ledger-v2';
type RetainedUnit = NonNullable<
  ReturnType<NonNullable<ReturnType<typeof readRetainedPlanScope>>['unitById']>
>;
declare const scopeBrand: unique symbol;
export interface CollectionConversionScope {
  readonly [scopeBrand]: true;
  readonly intakeId: string;
  readonly profileId: string;
  readonly sourceHash: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly inventoryId: string;
  readonly unitId: string;
  readonly ledgerId: string;
  readonly version: number;
}
export interface CollectionConversionCheckpoint {
  format: 'health-intake-conversion-checkpoint-v2';
  intakeId: string;
  profileId: string;
  sourceHash: string;
  sessionId: string;
  planId: string;
  inventoryId: string;
  activeUnitId: string;
  ledgerId: string;
  version: number;
  turns: number;
  modelRequests: number;
  measuredModelTokens: number;
  modelUsageIncomplete: boolean;
  unmeasuredRequests: number;
  usableModelResponses: number;
}
interface LedgerState {
  format: typeof POLICY;
  binding: string;
  seen: number;
  distinct: number;
  pending: number;
  next: number;
  nextGroup: number;
  front: number;
  last: string | null;
}
const scopes = new WeakMap<
  CollectionConversionScope,
  {
    db: Database;
    root: string;
    logical: string | undefined;
    plan:
      | { kind: 'package'; scope: NonNullable<ReturnType<typeof readPackagePlanScope>> }
      | { kind: 'direct'; scope: NonNullable<ReturnType<typeof readDirectPlanScope>> }
      | { kind: 'retained'; scope: NonNullable<ReturnType<typeof readRetainedPlanScope>> };
    unit: {
      id: string;
      kind: string;
      memberId?: string;
      sourceFileId?: string;
      sourceHash?: string;
      locator?: string;
    };
    retainedUnit?: RetainedUnit;
    pages?: RetainedUnit['pages'];
    ordinal: number;
    planAddress: string;
  }
>();
function owner(scope: CollectionConversionScope) {
  const value = scopes.get(scope);
  if (!value) throw Error('Foreign collection conversion scope');
  const current = intakeSourceVersion(value.db, scope.intakeId);
  if (current.logicalBinding !== value.logical || current.version !== scope.version)
    throw new HttpError(
      409,
      'CONVERSION_CHANGED',
      'This intake changed. Refresh the current unit scope.',
    );
  return value;
}
const SCOPE_CACHE_BYTES = 256 * 1024;
const scopeCaches = new WeakMap<
  Database,
  {
    stamp: string;
    bytes: number;
    values: Map<string, { scope: CollectionConversionScope; bytes: number }>;
  }
>();
const observedScopeDatabases = new WeakSet<Database>();
function retainedScopeBytes(scope: CollectionConversionScope) {
  const value = owner(scope);
  if (value.plan.kind !== 'retained' || !value.retainedUnit || !value.logical) return undefined;
  const unit = value.retainedUnit,
    plan = value.plan.scope,
    records = [
      unit.record,
      unit.coverageRecord,
      unit.exceptionRecord,
      unit.memberRecord,
      plan.record,
      plan.pinsRecord,
      plan.indexRecord,
    ];
  return (
    plan.retainedMetadataBytes() +
    Buffer.byteLength(
      JSON.stringify([
        scope,
        value.logical,
        value.unit,
        value.ordinal,
        value.planAddress,
        {
          id: unit.id,
          kind: unit.kind,
          status: unit.status,
          ordinal: unit.ordinal,
          attemptCount: unit.attemptCount,
          processingException: unit.processingException,
          pages: { count: unit.pages.count, uniqueCount: unit.pages.uniqueCount },
        },
        records.map((record) => (record ? plan.reader.address(record) : null)),
      ]),
    )
  );
}
/** Call after source capture has selected its new pins. Units can be selected
 * explicitly for manual reads; omitted unitId uses the checked first gap. */
export function openCollectionConversion(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: { sessionId: string; unitId?: string },
): CollectionConversionScope | undefined {
  if (!options.sessionId || Buffer.byteLength(options.sessionId) > 200)
    throw Error('Invalid conversion session identity');
  try {
    const stamp = reviewReadStamp(db);
    if (!stamp) scopeCaches.delete(db);
    const key = JSON.stringify([
      root,
      profileId,
      intakeId,
      options.sessionId,
      options.unitId ?? null,
    ]);
    if (!stamp || Buffer.byteLength(key) > 4096)
      return openSelectedConversion(db, root, profileId, intakeId, options);
    let cache = scopeCaches.get(db);
    if (!cache || cache.stamp !== stamp) {
      cache = { stamp, bytes: 0, values: new Map() };
      scopeCaches.set(db, cache);
      if (!observedScopeDatabases.has(db)) {
        observedScopeDatabases.add(db);
        observeDatabaseClose(db, () => scopeCaches.delete(db));
      }
    }
    const cached = cache.values.get(key);
    if (cached) {
      const source = getIntakeEvidenceHeader(db, root, profileId, intakeId),
        selected = owner(cached.scope),
        durability = recordDurabilityStatus(db);
      if (!durability?.configured || durability.dirty)
        throw Error('The reading scope requires current accepted authority');
      if (
        source.workflowState !== 'selected' ||
        source.sourceHash !== cached.scope.sourceHash ||
        source.version !== cached.scope.version ||
        selected.root !== root ||
        !selected.logical
      )
        throw new HttpError(409, 'CONVERSION_CHANGED', 'The selected reading source changed');
      if (reviewReadStamp(db) === stamp) {
        cache.values.delete(key);
        cache.values.set(key, cached);
        return cached.scope;
      }
      scopeCaches.delete(db);
      return openSelectedConversion(db, root, profileId, intakeId, options);
    }
    const scope = openSelectedConversion(db, root, profileId, intakeId, options);
    if (!scope) return undefined;
    const metadataBytes = retainedScopeBytes(scope);
    if (metadataBytes === undefined) return scope;
    const bytes = metadataBytes + Buffer.byteLength(key);
    if (bytes <= SCOPE_CACHE_BYTES && reviewReadStamp(db) === stamp) {
      cache.values.set(key, { scope, bytes });
      cache.bytes += bytes;
      while (cache.values.size > 2 || cache.bytes > SCOPE_CACHE_BYTES) {
        const first = cache.values.keys().next().value!;
        cache.bytes -= cache.values.get(first)!.bytes;
        cache.values.delete(first);
      }
    }
    return scope;
  } catch (error) {
    scopeCaches.delete(db);
    throw error;
  }
}
function openSelectedConversion(
  db: Database,
  root: string,
  profileId: string,
  intakeId: string,
  options: { sessionId: string; unitId?: string },
): CollectionConversionScope | undefined {
  const selectedStore = selectedEnvelopeStore(db, { id: intakeId }).collections;
  const nativeSelected =
    selectedStore.get(selectedStore.openView(), 'logical', 'package.selection', 'active') !==
    undefined;
  const native = nativeSelected ? readPackagePlanScope(db, root, profileId, intakeId) : undefined;
  const direct =
    !native &&
    selectedStore.get(selectedStore.openView(), 'logical', 'direct.selection', 'active') !==
      undefined
      ? readDirectPlanScope(db, profileId, intakeId)
      : undefined;
  const retained = native || direct ? undefined : readRetainedPlanScope(db, profileId, intakeId);
  if (!native && !direct && !retained) return undefined;
  const plan = native
    ? { kind: 'package' as const, scope: native }
    : direct
      ? { kind: 'direct' as const, scope: direct }
      : { kind: 'retained' as const, scope: retained! };
  let retainedUnit: RetainedUnit | undefined;
  let pages: RetainedUnit['pages'] | undefined;
  let unit:
    | {
        id: string;
        kind: string;
        memberId?: string;
        sourceFileId?: string;
        sourceHash?: string;
        locator?: string;
      }
    | undefined;
  let ordinal: number;
  if (native) {
    unit = options.unitId
      ? native.unitById(options.unitId)
      : nextPendingPagedPackageUnit(db, root, profileId, intakeId);
    if (!unit) return undefined;
    const member = native.inventory.byUnit(unit.id);
    if (!member) throw Error('Conversion unit has no inventory occurrence');
    ordinal = member.ordinal;
  } else if (direct) {
    let selected = options.unitId ? direct.unitById(options.unitId) : undefined;
    if (!options.unitId) {
      let low = 0,
        high = direct.unitCount;
      const accounted = direct.decisionIndex('accounted'),
        skipped = direct.decisionIndex('readingSkipped');
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        const covered =
          decisionIndexRank(selectedStore, accounted, schemaOrdinal(mid + 1)) +
          decisionIndexRank(selectedStore, skipped, schemaOrdinal(mid + 1));
        if (covered > mid + 1) throw Error('Overlapping direct reading-accounting indexes');
        if (covered === mid + 1) low = mid + 1;
        else high = mid;
      }
      selected = direct.unitAt(low);
    }
    if (!selected) return undefined;
    if (!options.unitId && (direct.accountedKind(selected.id) || selected.processingException))
      throw Error('Direct reading-accounting index disagrees with unit scope');
    unit = {
      id: selected.id,
      kind: selected.kind!,
      sourceFileId: intakeId,
      sourceHash: direct.plan.pins.sourceHash,
      locator: selected.locator?.slice(0, 2000),
    };
    ordinal = selected.ordinal;
    if (selected.kind === 'pdf') {
      const values = selected.pages;
      if (
        !Array.isArray(values) ||
        !values.every((value) => Number.isSafeInteger(value) && value > 0)
      )
        throw Error('Direct PDF page recipe is unavailable');
      const unique = [...new Set(values)];
      pages = {
        count: values.length,
        uniqueCount: unique.length,
        pageAt: (at) => values[at],
        uniquePageAt: (at) => unique[at],
        pageOrdinal: (value) => {
          const at = unique.indexOf(value);
          return at < 0 ? undefined : at;
        },
      };
    }
  } else {
    const selected = retained!;
    if (selected.status !== 'active') return undefined;
    let unitId = options.unitId;
    if (!unitId) {
      const collections = selectedEnvelopeStore(db, { id: intakeId }).collections;
      const accounted = selected.decisionIndex('accounted'),
        skipped = selected.decisionIndex('readingSkipped');
      const rank = (index: IntakeDecisionIndex, n: number) =>
        decisionIndexRank(collections, index, schemaOrdinal(n));
      let low = 0,
        high = selected.unitCount;
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2),
          covered = rank(accounted, mid + 1) + rank(skipped, mid + 1);
        if (covered > mid + 1) throw Error('Overlapping retained reading-accounting indexes');
        if (covered === mid + 1) low = mid + 1;
        else high = mid;
      }
      if (low === selected.unitCount) return undefined;
      const record = selected.reader.childAt(selected.record, 'units', low)!;
      const id = selected.reader.field(record, 'id', { bytes: 8192 });
      if (id.kind !== 'value' || typeof id.value !== 'string')
        throw Error('Retained unit identity is unavailable');
      unitId = id.value;
    }
    retainedUnit = selected.unitById(unitId);
    if (!retainedUnit) return undefined;
    if (!options.unitId && (selected.accountedKind(unitId) || retainedUnit.processingException))
      throw Error('Retained reading-accounting index disagrees with unit scope');
    const field = (name: string) => {
      const value = retainedUnit!.reader.field(retainedUnit!.record, name, { bytes: 65536 });
      if (value.kind === 'missing') return undefined;
      if (value.kind !== 'value' || typeof value.value !== 'string')
        throw Error('Retained unit identity field is unavailable: ' + name);
      return value.value;
    };
    unit = {
      id: unitId,
      kind: retainedUnit.kind,
      memberId: field('memberId'),
      sourceFileId: field('sourceFileId'),
      sourceHash: field('sourceHash'),
    };
    // Direct units use their selected source identity; only package children
    // need the retained occurrence locator join.
    if (unit.memberId) unit.locator = field('locator');
    ordinal = retainedUnit.ordinal;
    pages = retainedUnit.pages;
  }
  const version = intakeSourceVersion(db, intakeId);
  const sourceHash = selectedEnvelopeStore(db, { id: intakeId }).source.sha256;
  if (!sourceHash) throw Error('Conversion source hash is unavailable');
  const inventoryId = native
    ? native.inventory.inventoryId
    : direct
      ? 'direct:' +
        hash([direct.reader.address(direct.record), direct.pinsHash, direct.plan.sourceIndex.id])
      : 'retained:' + hash([retained!.reader.address(retained!.record), retained!.pinsHash]);
  const scope = Object.freeze({
    intakeId,
    profileId,
    sourceHash,
    sessionId: options.sessionId,
    planId: plan.scope.planId,
    inventoryId,
    unitId: unit.id,
    ledgerId: hash([
      POLICY,
      profileId,
      intakeId,
      plan.scope.planId,
      inventoryId,
      options.sessionId,
      unit.id,
    ]),
    version: version.version,
  }) as CollectionConversionScope;
  scopes.set(scope, {
    db,
    root,
    logical: version.logicalBinding,
    plan,
    unit,
    retainedUnit,
    pages,
    ordinal,
    planAddress: (() => {
      if (plan.kind !== 'package') return plan.scope.reader.address(plan.scope.record);
      const view = openIntakeCollectionEnvelope(db, { id: intakeId });
      const flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
      const record = view.find('plan', flow, plan.scope.planId);
      if (!record) throw Error('Reading plan occurrence is unavailable');
      return view.address(record);
    })(),
  });
  return scope;
}

/** Presentation for an already selected scope. The caller independently chooses
 * the first pending unit; a manually selected resume unit need not be that unit. */
export function collectionConversionUnitLabel(scope: CollectionConversionScope) {
  const selected = owner(scope);
  let locator = selected.unit.locator;
  if (selected.retainedUnit) {
    const { reader, record } = selected.retainedUnit;
    const value = reader.field(record, 'locator', { bytes: 2000 });
    locator =
      value.kind === 'value' && typeof value.value === 'string' ? value.value : scope.unitId;
  }
  owner(scope);
  return { id: scope.unitId, locator: locator?.slice(0, 2000) || scope.unitId };
}
const collectionName = (scope: CollectionConversionScope) => 'reading.' + scope.ledgerId;
const sessionName = (scope: CollectionConversionScope) =>
  'reading.session.' + hash([scope.sessionId, scope.intakeId, scope.sourceHash]);
/** Point lookup for an acknowledged child, independent of the displayed unit. */
export function collectionConversionSourceUnit(scope: CollectionConversionScope, sourceId: string) {
  const { db } = owner(scope);
  const raw = text(scope, sessionName(scope), 'sourceUnit:' + hash(sourceId));
  if (!raw) return undefined;
  const route = JSON.parse(raw) as { planId: string; unitId: string; sourceHash: string };
  if (route.planId !== scope.planId) return undefined;
  if (
    db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(sourceId)?.sha256 !==
    route.sourceHash
  )
    throw new HttpError(
      409,
      'CONVERSION_CHANGED',
      'The child source differs from its acknowledged reading evidence',
    );
  return route.unitId;
}
function legacyContext(scope: CollectionConversionScope) {
  const value = owner(scope);
  return {
    db: value.db,
    intakeId: scope.intakeId,
    sourceHash: scope.sourceHash,
    sessionId: scope.sessionId,
    unitKey: legacyReadingUnitKey(value.planAddress, scope.unitId),
    assertCurrent: () => {
      owner(scope);
    },
  };
}
// Unit ledgers share their source/session totals and imported pending targets.
// Serialize only their asynchronous publication; reading source bytes remains
// independent. This queue grants no authority and retains no idle session keys.
const readingUpdates = new WeakMap<Database, Map<string, Promise<void>>>();
async function withReadingSession<T>(
  scope: CollectionConversionScope,
  options: { assertRunning?: () => void },
  action: () => Promise<T>,
): Promise<T> {
  const { db } = owner(scope);
  options.assertRunning?.();
  let pending = readingUpdates.get(db);
  if (!pending) readingUpdates.set(db, (pending = new Map()));
  const key = JSON.stringify([scope.profileId, scope.intakeId, scope.sourceHash, scope.sessionId]);
  const previous = pending.get(key);
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(key, tail);
  try {
    await previous;
    options.assertRunning?.();
    owner(scope);
    assertIntakeOwner(db, scope.profileId);
    if (selectedEnvelopeStore(db, { id: scope.intakeId }).source.sha256 !== scope.sourceHash)
      throw new Error('The reading source changed');
    return await action();
  } finally {
    release();
    if (pending.get(key) === tail) {
      pending.delete(key);
      if (!pending.size) readingUpdates.delete(db);
    }
  }
}
/** Explicit asynchronous preparation after selecting a changed plan. The reader
 * itself refuses missing target proof instead of guessing an empty history. */
export function prepareLegacyCollectionReadingTargets(
  scope: CollectionConversionScope,
  options: { assertRunning?: () => void; onCheckpoint?: () => void | Promise<void> } = {},
) {
  return withReadingSession(scope, options, () =>
    prepareLegacyReadingTargets(
      { ...legacyContext(scope), root: owner(scope).root, profileId: scope.profileId },
      options,
    ),
  );
}
/** Selected source/session aggregate. An older header without pending accounting
 * reports null until an explicit complete rebuild; absence is a fresh session. */
export function readCollectionConversionSessionTotals(
  db: Database,
  profileId: string,
  intakeId: string,
  sessionId: string,
) {
  assertIntakeOwner(db, profileId);
  if (!sessionId || Buffer.byteLength(sessionId) > 200)
    throw Error('Invalid conversion session identity');
  const selected = selectedEnvelopeStore(db, { id: intakeId }),
    collections = selected.collections;
  const sourceHash = selected.source.sha256;
  if (!sourceHash) throw Error('Reading session source hash is unavailable');
  const name = 'reading.session.' + hash([sessionId, intakeId, sourceHash]),
    view = collections.openView();
  const raw = collections.get(view, 'builds', name, 'counts');
  if (raw !== undefined && typeof raw !== 'string')
    throw Error('Fragmented reading session counts');
  const totals =
    raw === undefined
      ? { seen: 0, distinct: 0, pending: 0 }
      : (JSON.parse(raw) as { seen: number; distinct: number; pending?: number });
  if (
    ![
      totals.seen,
      totals.distinct,
      ...(totals.pending === undefined ? [] : [totals.pending]),
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw Error('Invalid reading session counts');
  return {
    sourceHash,
    sessionId,
    seen: totals.seen,
    distinct: totals.distinct,
    pending: totals.pending ?? null,
    binding: hash([
      intakeId,
      sourceHash,
      sessionId,
      collections.collection(view, 'builds', name)?.root ?? null,
    ]),
  };
}
/** Constant-work host dispatch proof. Equal counters cannot hide replaced windows. */
export function collectionConversionLedgerBinding(scope: CollectionConversionScope): string {
  const collections = store(scope),
    selected = collections.openView();
  return hash([
    binding(scope),
    collections.collection(selected, 'builds', collectionName(scope))?.root ?? null,
    collections.collection(selected, 'builds', sessionName(scope))?.root ?? null,
  ]);
}
const binding = (scope: CollectionConversionScope) =>
  hash([
    POLICY,
    scope.profileId,
    scope.intakeId,
    scope.sourceHash,
    scope.planId,
    scope.inventoryId,
    scope.unitId,
    scope.sessionId,
  ]);
const initial = (scope: CollectionConversionScope): LedgerState => ({
  format: POLICY,
  binding: binding(scope),
  seen: 0,
  distinct: 0,
  pending: 0,
  next: 0,
  nextGroup: 0,
  front: 0,
  last: null,
});
function store(scope: CollectionConversionScope) {
  const { db } = owner(scope);
  return selectedEnvelopeStore(db, { id: scope.intakeId }).collections;
}
function text(
  scope: CollectionConversionScope,
  collection: string,
  key: string,
  budget = 32768,
): string | undefined {
  const collections = store(scope),
    value = collections.get(collections.openView(), 'builds', collection, key);
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > budget)
      throw Error('Reading ledger cell exceeds its declared budget');
    return value;
  }
  if (value.bytes > budget) throw Error('Reading ledger cell exceeds its declared budget');
  let after: string | undefined,
    result = '';
  do {
    const page = collections.readBytes(value, { after, items: 16, bytes: 16384 });
    for (const chunk of page.chunks)
      result += new TextDecoder('utf-8', { fatal: true }).decode(chunk);
    if (page.complete) return result;
    if (!page.after || page.after === after) throw Error('Reading ledger cell failed to advance');
    after = page.after;
  } while (true);
}
function state(scope: CollectionConversionScope): LedgerState {
  const raw = text(scope, collectionName(scope), 'state');
  const collections = store(scope);
  if (
    raw === undefined &&
    collections.collection(collections.openView(), 'builds', collectionName(scope))
  )
    throw Error('Selected reading ledger has no complete state');
  const value = raw ? (JSON.parse(raw) as LedgerState) : initial(scope);
  if (
    value.format !== POLICY ||
    value.binding !== binding(scope) ||
    ![value.seen, value.distinct, value.pending, value.next, value.nextGroup, value.front].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw Error('Reading ledger binding or counters are invalid');
  return value;
}
export function createCollectionCheckpoint(
  scope: CollectionConversionScope,
): CollectionConversionCheckpoint {
  owner(scope);
  state(scope);
  return {
    format: 'health-intake-conversion-checkpoint-v2',
    intakeId: scope.intakeId,
    profileId: scope.profileId,
    sourceHash: scope.sourceHash,
    sessionId: scope.sessionId,
    planId: scope.planId,
    inventoryId: scope.inventoryId,
    activeUnitId: scope.unitId,
    ledgerId: scope.ledgerId,
    version: scope.version,
    turns: 0,
    modelRequests: 0,
    measuredModelTokens: 0,
    modelUsageIncomplete: false,
    unmeasuredRequests: 0,
    usableModelResponses: 0,
  };
}
function checkCheckpoint(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
) {
  owner(scope);
  if (
    checkpoint.format !== 'health-intake-conversion-checkpoint-v2' ||
    checkpoint.intakeId !== scope.intakeId ||
    checkpoint.profileId !== scope.profileId ||
    checkpoint.sourceHash !== scope.sourceHash ||
    checkpoint.planId !== scope.planId ||
    checkpoint.inventoryId !== scope.inventoryId ||
    checkpoint.sessionId !== scope.sessionId ||
    checkpoint.activeUnitId !== scope.unitId ||
    checkpoint.ledgerId !== scope.ledgerId
  )
    throw Error('Conversion checkpoint does not select this reading ledger');
}
function* entries(scope: CollectionConversionScope, collection: string, prefix: string) {
  let after = prefix;
  do {
    const collections = store(scope);
    const page = collections.range(collections.openView(), 'builds', collection, {
      after,
      items: 64,
      bytes: 32768,
    });
    for (const entry of page.items) {
      if (!entry.key.startsWith(prefix)) return;
      if (typeof entry.value !== 'string') throw Error('Fragmented reading ledger index');
      yield { key: entry.key, value: entry.value };
    }
    if (page.complete) return;
    if (!page.after || page.after === after) throw Error('Reading ledger scope failed to advance');
    after = page.after;
  } while (true);
}
function ancestors(window: ReadWindow): string[] {
  const pointer = window.args.jsonPointer || '';
  if (typeof pointer !== 'string' || pointer.length > 4000)
    throw Error('Invalid reading JSON pointer');
  const values = [''];
  for (let i = 1; i < pointer.length; i++) if (pointer[i] === '/') values.push(pointer.slice(0, i));
  if (pointer) values.push(pointer);
  return values;
}
const ancestorKey = (window: ReadWindow, pointer: string) => hash([jsonScope(window), pointer]);
function checkReadScope(scope: CollectionConversionScope, args: ReadArgs) {
  const { db, unit, pages } = owner(scope);
  if (!args.memberId && args.id === (unit.sourceFileId || scope.intakeId) && !unit.memberId) {
    intakeSourceMetadata(db, args.id);
    if (
      unit.sourceHash &&
      db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(args.id)?.sha256 !==
        unit.sourceHash
    )
      throw Error('Retained unit source hash changed');
    if (args.unitId && args.unitId !== unit.id)
      throw Error('Read belongs to a different retained unit');
    if (pages && unit.kind === 'pdf' && pages.pageOrdinal(args.page || 1) === undefined)
      throw Error('Read page does not belong to the selected unit');
    return;
  }
  if (args.id === scope.intakeId && (args.memberId === unit.memberId || args.unitId === unit.id))
    return;
  if (typeof args.id !== 'string' || args.memberId)
    throw Error('Read does not belong to the selected unit');
  const child = intakeSourceMetadata(db, args.id);
  const sourceHash = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(args.id)?.sha256;
  const assetHash = text(scope, collectionName(scope), 'asset:' + hash(args.id));
  if (assetHash && assetHash === sourceHash) return;
  if (
    child.parentSourceFileId !== scope.intakeId ||
    !intakeMetadataScalarMatches(child.locator, unit.locator)
  )
    throw Error('Read does not belong to the retained package occurrence');
  if (sourceHash !== unit.sourceHash) throw Error('Retained child source hash changed');
}

declare const descendantReadBrand: unique symbol;
export interface CollectionDescendantRead {
  readonly [descendantReadBrand]: true;
}
type DescendantEvidence = { sourceHash: string; ancestry: string };
const descendantReads = new WeakMap<
  CollectionDescendantRead,
  {
    db: Database;
    root: string;
    scope: string;
    sourceId: string;
    evidence: DescendantEvidence;
  }
>();
const descendantBinding = (scope: CollectionConversionScope) => {
  const logical = owner(scope).logical;
  if (!logical) throw Error('Manual descendant reading requires selected logical authority');
  // This is an original-byte capability. Source capture may advance the separate
  // material-text pin, but domainVersion and the complete logical root must match.
  return hash([binding(scope), logical]);
};
const descendantKey = (sourceId: string) => 'manual-source:' + hash(sourceId);
async function inspectDescendant(
  scope: CollectionConversionScope,
  sourceId: string,
  options: { assertRunning?: () => void },
) {
  const { db, plan, unit } = owner(scope);
  descendantBinding(scope);
  if (
    sourceId === scope.intakeId ||
    plan.kind === 'package' ||
    unit.memberId ||
    unit.kind === 'package_member'
  )
    throw Error('A manual descendant read cannot replace a package occurrence');
  const readStamp = db.prepare(
    'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
  );
  readStamp.setReadBigInts(true);
  const readTempSchema = db.prepare('PRAGMA temp.schema_version');
  readTempSchema.setReadBigInts(true);
  const stamp = () => {
    if (db.isTransaction) throw Error('Prepare descendant reading outside a transaction');
    const row = readStamp.get()!;
    return `${row.changes}:${row.external}:${row.schema}:${readTempSchema.get()!.schema_version}`;
  };
  const before = stamp();
  const assertCurrent = () => {
    options.assertRunning?.();
    owner(scope);
    assertIntakeOwner(db, scope.profileId);
    if (stamp() !== before) throw Error('Retained descendant evidence changed during preparation');
  };
  assertCurrent();
  const sourceHash = db
    .prepare("SELECT sha256 FROM source_files WHERE id=? AND kind='intake_original'")
    .get(sourceId)?.sha256;
  if (typeof sourceHash !== 'string') throw Error('Retained descendant source is unavailable');
  const digest = createHash('sha256');
  const walk = iterateIntakeSourceAncestry(db, scope.profileId, sourceId, {
    stopAt: scope.intakeId,
    assertRunning: assertCurrent,
  });
  let count = 0;
  for (;;) {
    const next = walk.next();
    if (next.done) {
      if (!next.value) throw Error('Read does not belong to this retained delivery');
      break;
    }
    digest.update(JSON.stringify([next.value.id, next.value.parentId ?? null]));
    if (++count % 64 === 0) {
      await setImmediate();
      assertCurrent();
    }
  }
  assertCurrent();
  return { evidence: { sourceHash, ancestry: digest.digest('hex') }, assertCurrent };
}
/** The manual host issues this before reading original bytes. It authorizes a
 * pinned descendant source only; no read or extraction evidence is created. */
export async function prepareManualCollectionDescendantRead(
  scope: CollectionConversionScope,
  sourceId: string,
  options: { assertRunning?: () => void } = {},
): Promise<CollectionDescendantRead> {
  const checked = await inspectDescendant(scope, sourceId, options);
  checked.assertCurrent();
  const capability = Object.freeze({}) as CollectionDescendantRead;
  descendantReads.set(capability, {
    db: owner(scope).db,
    root: owner(scope).root,
    scope: descendantBinding(scope),
    sourceId,
    evidence: checked.evidence,
  });
  return capability;
}
async function checkedDescendant(
  scope: CollectionConversionScope,
  args: ReadArgs,
  options: ReadingUpdateOptions,
) {
  const sourceId = args.id;
  if (typeof sourceId !== 'string') throw Error('Reading source identity is unavailable');
  let expected: DescendantEvidence | undefined;
  if (options.descendantRead) {
    const capability = descendantReads.get(options.descendantRead);
    if (
      !capability ||
      capability.db !== owner(scope).db ||
      capability.root !== owner(scope).root ||
      capability.scope !== descendantBinding(scope) ||
      capability.sourceId !== sourceId
    )
      throw Error('Foreign manual descendant reading capability');
    expected = capability.evidence;
  } else {
    const raw = text(scope, collectionName(scope), descendantKey(sourceId));
    if (raw !== undefined) expected = JSON.parse(raw) as DescendantEvidence;
  }
  if (!expected) return undefined;
  if (args.memberId || (args.unitId && args.unitId !== scope.unitId))
    throw Error('Manual descendant read belongs to a different occurrence');
  const checked = await inspectDescendant(scope, sourceId, options);
  checked.assertCurrent();
  if (
    checked.evidence.sourceHash !== expected.sourceHash ||
    checked.evidence.ancestry !== expected.ancestry
  )
    throw Error('Retained descendant reading source changed');
  return checked;
}

/** Only acknowledged provider-visible reads enter this ledger. Preparation is
 * forked and bounded; interruption leaves the prior selected receipt intact. */
async function updateCollectionConversionRead(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
  tool: string,
  args: ReadArgs,
  result: unknown,
  options: ReadingUpdateOptions = {},
  mode: 'acknowledge' | 'defer' = 'acknowledge',
): Promise<boolean> {
  checkCheckpoint(scope, checkpoint);
  const details = conversionReadDetails(tool, args, result);
  if (!details) return false;
  // Inventory selects discoverable units; it supplies no literal member read.
  // Native plans already retain complete unit order without enqueuing metadata.
  if (details.inventory) return false;
  const descendant = await checkedDescendant(scope, args, options);
  if (!descendant) checkReadScope(scope, args);
  const { db } = owner(scope),
    collections = store(scope),
    selected = collectionName(scope),
    before = state(scope),
    next = { ...before };
  let sourceRoute: { key: string; value: string } | undefined;
  const oldRoot = collections.collection(collections.openView(), 'builds', selected)?.root?.hash;
  const oldLegacy = openLegacyReadingSession(legacyContext(scope));
  const legacyRoot =
    oldLegacy &&
    collections.collection(collections.openView(), 'builds', oldLegacy.name)?.root?.hash;
  const pendingIndex = beginReadingPendingIndexUpdate(
    db,
    scope.intakeId + ':' + selected,
    oldRoot ?? '',
  );
  const legacyIndex =
    oldLegacy &&
    beginReadingPendingIndexUpdate(db, scope.intakeId + ':' + oldLegacy.name, legacyRoot ?? '');
  const legacy = await prepareLegacyReadingUpdate(legacyContext(scope), {
    ...options,
    onPendingRemoved: (key) => legacyIndex?.change(key, null),
  });
  const build = 'reading.build.' + randomUUID();
  const current = () => {
    options.assertRunning?.();
    owner(scope);
    legacy?.assertCurrent();
    if (collections.collection(collections.openView(), 'builds', selected)?.root?.hash !== oldRoot)
      throw Error('Reading ledger changed during preparation');
  };
  const commit = (changes: Parameters<typeof collections.prepare>[1]['changes']) => {
    current();
    const id = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId: id,
        requestDigest: hash(id),
        domainVersion: intakeSourceVersion(db, scope.intakeId).rawVersion,
        changes,
      }),
    );
  };
  if (oldRoot)
    commit([
      {
        area: 'builds',
        collection: build,
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: selected,
      },
    ]);
  const writer = createEnvelopeBuildWriter(
    db,
    { id: scope.intakeId },
    build,
    intakeSourceVersion(db, scope.intakeId).rawVersion,
    { assertRunning: current, onCheckpoint: options.onCheckpoint },
  );
  if (descendant) await writer.put(descendantKey(args.id!), JSON.stringify(descendant.evidence));
  const has = (key: string) =>
    writer.peek(key) !== undefined ||
    !!legacy?.has(key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1));
  const groupId = (value: ReadWindow) => hash([value.args.id, value.args.memberId || null]);
  const group = (id: string) => {
    const raw = writer.peek('group:' + id);
    return raw
      ? (JSON.parse(raw) as { priority: string; pending: number })
      : { priority: '1:' + schemaOrdinal(next.nextGroup++), pending: 0 };
  };
  const supplied = (window: ReadWindow) =>
    ancestors(window).some((pointer) => has('supplied:' + ancestorKey(window, pointer)));
  const window = async (value: ReadWindow) => {
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 32768)
      throw Error('Reading window exceeds supported argument budget');
    await writer.cell('window:' + windowKey(value), raw);
  };
  const mark = async (value: ReadWindow) => {
    const key = windowKey(value);
    if (!has('seen:' + key)) {
      await writer.put('seen:' + key, '1');
      await legacy?.markSeen(value);
      next.seen++;
    }
    await window(value);
  };
  const removePending = async (value: ReadWindow) => {
    await legacy?.removeWindow(windowKey(value));
    const key = windowKey(value),
      ordinal = writer.peek('pending:' + key);
    if (ordinal === undefined) return;
    pendingIndex?.change(key, null);
    await writer.remove('pending:' + key);
    const id = groupId(value),
      local = group(id);
    await writer.remove('local:' + id + ':' + ordinal);
    local.pending--;
    if (local.pending < 0) throw Error('Invalid local reading count');
    if (!local.pending) await writer.remove('groups:' + local.priority);
    await writer.put('group:' + id, JSON.stringify(local));
    for (const pointer of ancestors(value))
      await writer.remove('desc:' + ancestorKey(value, pointer) + ':' + key);
    next.pending--;
    const priority = writer.peek('deferred-priority:' + key);
    if (priority !== undefined) {
      await writer.remove('deferred-order:' + priority);
      await writer.remove('deferred-priority:' + key);
      await writer.remove('deferred:' + key);
    }
  };
  const enqueue = async (tool: string, args: ReadArgs) => {
    const value = descriptor(tool, args),
      key = windowKey(value);
    if (has('seen:' + key) || has('pending:' + key) || supplied(value)) return;
    pendingIndex?.change(key, value);
    await window(value);
    const ordinal = schemaOrdinal(next.next++);
    await writer.put('pending:' + key, ordinal);
    const id = groupId(value),
      local = group(id);
    await writer.put('local:' + id + ':' + ordinal, key);
    if (!local.pending) await writer.put('groups:' + local.priority, id);
    local.pending++;
    await writer.put('group:' + id, JSON.stringify(local));
    for (const pointer of ancestors(value))
      await writer.put('desc:' + ancestorKey(value, pointer) + ':' + key, key);
    next.pending++;
  };
  const supply = async (value: ReadWindow) => {
    await mark(value);
    await writer.put('supplied:' + ancestorKey(value, value.args.jsonPointer || ''), '1');
    await legacy?.supply(value);
    await writer.flush();
    for (const item of entries(
      scope,
      build,
      'desc:' + ancestorKey(value, value.args.jsonPointer || '') + ':',
    )) {
      const raw = text(scope, build, 'window:' + item.value);
      if (!raw) throw Error('Missing pending reading window');
      await removePending(JSON.parse(raw) as ReadWindow);
    }
  };
  const finish = async (fresh: boolean) => {
    if (
      ![next.seen, next.distinct, next.pending, next.next, next.nextGroup, next.front].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw Error('Reading ledger counter overflow');
    await writer.put('state', JSON.stringify(next));
    await writer.flush();
    const sessionRaw = text(scope, sessionName(scope), 'counts');
    if (!sessionRaw && (before.seen || before.distinct || before.pending))
      throw Error('Selected reading session totals are unavailable');
    const totals = sessionRaw
      ? (JSON.parse(sessionRaw) as { seen: number; distinct: number; pending?: number })
      : { seen: 0, distinct: 0, pending: 0 };
    totals.seen += next.seen - before.seen;
    totals.distinct += next.distinct - before.distinct;
    if (totals.pending !== undefined) totals.pending += next.pending - before.pending;
    if (
      ![
        totals.seen,
        totals.distinct,
        ...(totals.pending === undefined ? [] : [totals.pending]),
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw Error('Reading session count overflow');
    if (legacy && sourceRoute) await legacy.sourceRoute(sourceRoute.key, sourceRoute.value);
    const sessionChange = legacy
      ? await legacy.finish(totals)
      : {
          area: 'builds' as const,
          collection: sessionName(scope),
          op: 'put' as const,
          key: 'counts',
          value: JSON.stringify(totals),
        };
    if (descendant) {
      const checked = await checkedDescendant(scope, args, options);
      if (!checked) throw Error('Retained descendant reading authority is unavailable');
      checked.assertCurrent();
    }
    commit([
      {
        area: 'builds',
        collection: selected,
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: build,
      },
      sessionChange,
      ...(!legacy && sourceRoute
        ? [
            {
              area: 'builds' as const,
              collection: sessionName(scope),
              op: 'put' as const,
              key: 'sourceUnit:' + sourceRoute.key,
              value: sourceRoute.value,
            },
          ]
        : []),
    ]);
    const selectedRoot = collections.collection(collections.openView(), 'builds', selected)?.root
      ?.hash;
    pendingIndex?.finish(selectedRoot ?? '');
    if (legacy && oldLegacy) {
      const nextRoot = collections.collection(collections.openView(), 'builds', oldLegacy.name)
        ?.root?.hash;
      legacyIndex?.finish(nextRoot ?? '');
    }
    checkpoint.version = scope.version;
    return fresh;
  };
  const { current: read, original, structure, readable, value } = details;
  if (structure && supplied(read)) {
    pendingIndex?.unchanged();
    legacyIndex?.unchanged();
    return false;
  }
  const fresh = !has('seen:' + windowKey(read));
  if (mode === 'defer') {
    const key = windowKey(read);
    if (!fresh || has('deferred-priority:' + key)) {
      pendingIndex?.unchanged();
      legacyIndex?.unchanged();
      return false;
    }
    await enqueue(tool, read.args);
    const priority = schemaOrdinal(Number.MAX_SAFE_INTEGER - next.front++);
    await writer.put('deferred-priority:' + key, priority);
    await writer.put('deferred-order:' + priority, key);
    await writer.cell(
      'deferred:' + key,
      JSON.stringify(conversionDeferredReceipt(tool, args, result)),
    );
    return finish(false);
  }
  await mark(read);
  await removePending(read);
  if (tool === 'health_intake_plan' && args.action === 'read_unit' && args.unitId === scope.unitId)
    await legacy?.readUnit();
  if (readable) {
    const childId = args.id !== scope.intakeId ? args.id : value.sourceFileId;
    if (typeof childId === 'string' && childId !== scope.intakeId) {
      if (!descendant) checkReadScope(scope, { id: childId });
      const sourceHash = db
        .prepare('SELECT sha256 FROM source_files WHERE id=?')
        .get(childId)?.sha256;
      if (typeof sourceHash !== 'string')
        throw Error('Acknowledged child source hash is unavailable');
      sourceRoute = {
        key: hash(childId),
        value: JSON.stringify({ planId: scope.planId, unitId: scope.unitId, sourceHash }),
      };
    }
    await legacy?.markRead(scopeKey([args.id, args.memberId || null, original.page || null]));
    if (args.memberId) await legacy?.markRead(scopeKey([args.id, args.memberId, null]));
    await writer.put(
      'read:' + scopeKey([args.id, args.memberId || null, original.page || null]),
      '1',
    );
    if (args.memberId) await writer.put('read:' + scopeKey([args.id, args.memberId, null]), '1');
  }
  if (structure) {
    const sourceScope = scopeKey([args.id, args.memberId || null, null]);
    if (!structure.jsonPointer && structure.jsonOffset === 0) {
      await writer.put('json:' + sourceScope, '1');
      await legacy?.markJSON(sourceScope);
    }
    if (!has('json:' + sourceScope))
      await enqueue(tool, { ...args, jsonPointer: '', jsonOffset: 0, offset: 0 });
    if (structure.jsonOffset > 0)
      await enqueue(tool, {
        ...args,
        jsonPointer: structure.jsonPointer,
        jsonOffset: 0,
        offset: 0,
      });
    if (structure.literalComplete === true)
      await supply(
        descriptor(tool, { ...args, jsonPointer: structure.jsonPointer, jsonOffset: 0, offset: 0 }),
      );
    else {
      for (const child of structure.children || []) {
        if (child.jsonPointer === null) {
          if (child.literalComplete !== true && structure.nextOffset !== null)
            await enqueue(tool, {
              ...args,
              jsonPointer: structure.jsonPointer,
              offset: structure.nextOffset,
            });
          continue;
        }
        const childArgs = { ...args, jsonPointer: child.jsonPointer, jsonOffset: 0, offset: 0 };
        if (child.literalComplete === true) await supply(descriptor(tool, childArgs));
        else if (child.literalComplete === false && Number.isSafeInteger(child.nextOffset))
          await enqueue(tool, { ...childArgs, offset: child.nextOffset! });
        else if (['array', 'object'].includes(child.type || '') || structure.nextOffset !== null)
          await enqueue(tool, childArgs);
      }
      if (structure.nextJSONOffset !== null)
        await enqueue(tool, {
          ...args,
          jsonPointer: structure.jsonPointer,
          jsonOffset: structure.nextJSONOffset,
          offset: 0,
        });
      if (!structure.children?.length && structure.nextOffset !== null)
        await enqueue(tool, {
          ...args,
          jsonPointer: structure.jsonPointer,
          offset: structure.nextOffset,
        });
    }
  } else {
    const selected = owner(scope),
      pageUnit = selected.pages;
    const isSelectedPDF =
      pageUnit &&
      selected.unit.kind === 'pdf' &&
      args.id === (selected.unit.sourceFileId || scope.intakeId);
    if (isSelectedPDF) {
      const ordinal = pageUnit.pageOrdinal(original.page || args.page || 1);
      if (ordinal === undefined) throw Error('Acknowledged page is outside the selected unit');
      if (readable && !legacy) await writer.put('page:' + schemaOrdinal(ordinal), '1');
      await writer.flush();
      const rank = (n: number) =>
        collections.rank(collections.openView(), 'builds', build, 'page:' + schemaOrdinal(n)) -
        collections.rank(collections.openView(), 'builds', build, 'page:') +
        (legacy?.readPageRank(n) ?? 0);
      let low = 0,
        high = pageUnit.uniqueCount;
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2),
          read = rank(mid + 1);
        if (read > mid + 1) throw Error('Invalid retained page reading index');
        if (read === mid + 1) low = mid + 1;
        else high = mid;
      }
      if (low < pageUnit.uniqueCount)
        await enqueue(tool, { ...args, page: pageUnit.uniquePageAt(low)!, offset: 0 });
    } else if ((original.page || 0) > 1) await enqueue(tool, { ...args, page: 1, offset: 0 });
    if ((original.offset || 0) > 0) await enqueue(tool, { ...args, offset: 0 });
    if (original.nextOffset !== null && original.nextOffset !== undefined)
      await enqueue(tool, { ...args, offset: original.nextOffset });
    if (!isSelectedPDF && original.nextPage !== null && original.nextPage !== undefined)
      await enqueue(tool, { ...args, page: original.nextPage, offset: 0 });
    for (const asset of original.assets || [])
      if (asset.id !== args.id && asset.id !== value.sourceFileId && !asset.derivative) {
        const metadata = intakeSourceMetadata(db, asset.id);
        if (
          metadata.parentSourceFileId !== args.id &&
          metadata.parentSourceFileId !== value.sourceFileId
        )
          throw Error('Supplied asset does not belong to the acknowledged source');
        const sourceHash = db
          .prepare('SELECT sha256 FROM source_files WHERE id=?')
          .get(asset.id)?.sha256;
        if (typeof sourceHash !== 'string') throw Error('Supplied asset hash is unavailable');
        await writer.put('asset:' + hash(asset.id), sourceHash);
        await enqueue('health_intake_read', { id: asset.id });
      }
  }
  if (readable) {
    next.last = windowKey(read);
    await legacy?.markLast(read);
    const id = groupId(read),
      local = group(id);
    if (local.pending) await writer.remove('groups:' + local.priority);
    local.priority = '0:' + schemaOrdinal(Number.MAX_SAFE_INTEGER - next.front++);
    if (local.pending) await writer.put('groups:' + local.priority, id);
    await writer.put('group:' + id, JSON.stringify(local));
  }
  if (fresh) next.distinct++;
  return finish(fresh);
}

type ReadingUpdateOptions = {
  assertRunning?: () => void;
  onCheckpoint?: () => void | Promise<void>;
  descendantRead?: CollectionDescendantRead;
};
export function recordCollectionConversionRead(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
  tool: string,
  args: ReadArgs,
  result: unknown,
  options: ReadingUpdateOptions = {},
) {
  return withReadingSession(scope, options, () =>
    updateCollectionConversionRead(scope, checkpoint, tool, args, result, options),
  );
}
/** A host read is not counted until a valid provider response acknowledges it. */
export async function deferCollectionConversionRead(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
  tool: string,
  args: ReadArgs,
  result: unknown,
  options: ReadingUpdateOptions = {},
) {
  const receipt = conversionDeferredReceipt(tool, args, result);
  if (!receipt) return null;
  if (Buffer.byteLength(JSON.stringify(receipt)) > 1024 * 1024)
    throw Error('Deferred read metadata exceeds the supported receipt budget');
  return withReadingSession(scope, options, async () => {
    await updateCollectionConversionRead(scope, checkpoint, tool, args, result, options, 'defer');
    const key = windowKey({ tool, args: receipt.args });
    return text(scope, collectionName(scope), 'deferred-priority:' + key) === undefined
      ? null
      : { format: 'health-intake-deferred-read-v2' as const, key };
  });
}
export async function acknowledgeCollectionConversionRead(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
  key: string,
  options: ReadingUpdateOptions = {},
) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid deferred read reference');
  return withReadingSession(scope, options, async () => {
    const raw = text(scope, collectionName(scope), 'deferred:' + key, 1024 * 1024);
    if (!raw) {
      if (text(scope, collectionName(scope), 'seen:' + key) !== undefined) return false;
      const window = readCollectionConversionWindow(scope, key);
      if (
        ancestors(window).some(
          (pointer) =>
            text(scope, collectionName(scope), 'supplied:' + ancestorKey(window, pointer)) !==
            undefined,
        )
      )
        return false;
      throw Error('Deferred read receipt is unavailable');
    }
    const receipt = JSON.parse(raw) as NonNullable<ReturnType<typeof conversionDeferredReceipt>>;
    if (windowKey({ tool: receipt.tool, args: receipt.args }) !== key)
      throw Error('Deferred reading receipt conflicts');
    return updateCollectionConversionRead(
      scope,
      checkpoint,
      receipt.tool,
      receipt.args,
      receipt.result,
      options,
    );
  });
}

export function readCollectionConversionWindow(
  scope: CollectionConversionScope,
  key: string,
): ReadWindow {
  if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid reading window reference');
  const raw = text(scope, collectionName(scope), 'window:' + key);
  const value = raw
    ? (JSON.parse(raw) as ReadWindow)
    : openLegacyReadingSession(legacyContext(scope))?.window(key);
  if (!value) throw Error('Reading window is unavailable');
  if (windowKey(value) !== key) throw Error('Reading window reference conflicts');
  return value;
}

export function collectionConversionResumeContext(
  scope: CollectionConversionScope,
  checkpoint: CollectionConversionCheckpoint,
  options: { mappingVersion: string },
) {
  checkCheckpoint(scope, checkpoint);
  const { db, root, plan, ordinal, unit: selectedUnit, retainedUnit } = owner(scope),
    ledger = state(scope),
    collections = store(scope);
  const legacy = openLegacyReadingSession(legacyContext(scope));
  const pendingCount = ledger.pending + (legacy?.pending() ?? 0) + (legacy?.unmatched() ?? 0);
  const unit =
    plan.kind === 'package'
      ? readPackageUnitPage(db, root, scope.profileId, scope.intakeId, {
          offset: ordinal,
          limit: 1,
          inlineBytes: 0,
          bytes: 8000,
        }).units[0]
      : plan.kind === 'direct'
        ? {
            ...plan.scope.unitAt(ordinal)!.metadata,
            id: selectedUnit.id,
            kind: selectedUnit.kind,
            sourceFileId: selectedUnit.sourceFileId,
            pageCount: owner(scope).pages?.count ?? 0,
          }
        : {
            format: 'health-intake-retained-unit-reference-v1' as const,
            id: selectedUnit.id,
            kind: selectedUnit.kind,
            sourceFileId: selectedUnit.sourceFileId ?? null,
            memberId: selectedUnit.memberId ?? null,
            planId: scope.planId,
            version: scope.version,
            record: (() => {
              const backend = openCollectionModelIntakeBackend(
                db,
                { id: scope.intakeId },
                { mappingVersion: options.mappingVersion },
              );
              return modelIntakeRecordReference(
                backend,
                'units',
                backend.resolve(retainedUnit!.reader.address(retainedUnit!.record)),
              );
            })(),
            pageCount: retainedUnit!.pages.count,
          };
  const unitCount = plan.kind === 'package' ? plan.scope.plan.unitCount : plan.scope.unitCount;
  const windows: Array<
    ReadWindow | { format: 'health-intake-reading-window-reference-v1'; key: string; bytes: number }
  > = [];
  let bytes = 0;
  function* pendingEntries() {
    yield* entries(scope, collectionName(scope), 'deferred-order:');
    for (const group of entries(scope, collectionName(scope), 'groups:'))
      for (const item of entries(scope, collectionName(scope), 'local:' + group.value + ':')) {
        if (text(scope, collectionName(scope), 'deferred-priority:' + item.value) === undefined)
          yield item;
      }
    yield* legacy?.pendingEntries() ?? [];
  }
  for (const item of pendingEntries()) {
    const value = readCollectionConversionWindow(scope, item.value),
      size = Buffer.byteLength(JSON.stringify(value));
    const output =
      size > 2048
        ? {
            format: 'health-intake-reading-window-reference-v1' as const,
            key: item.value,
            bytes: size,
          }
        : value;
    const cost = Buffer.byteLength(JSON.stringify(output));
    if (windows.length === 12 || bytes + cost > 8000) break;
    windows.push(output);
    bytes += cost;
  }
  const count = (kind: 'accounted' | 'readingSkipped') => {
    const index = plan.scope.decisionIndex(kind);
    return decisionIndexCount(collections, index);
  };
  const accountedUnits = count('accounted'),
    skippedUnits = count('readingSkipped');
  if (accountedUnits + skippedUnits > unitCount)
    throw Error('Invalid package reading accounting roots');
  const sessionRaw = text(scope, sessionName(scope), 'counts');
  if (!sessionRaw && (ledger.seen || ledger.distinct || ledger.pending))
    throw Error('Selected reading session totals are unavailable');
  const totals = sessionRaw
    ? (JSON.parse(sessionRaw) as { seen: number; distinct: number })
    : { seen: 0, distinct: 0 };
  const view = openIntakeCollectionEnvelope(db, { id: scope.intakeId }),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow');
  return {
    format: 'health-intake-conversion-resume-v2' as const,
    intakeId: scope.intakeId,
    sourceHash: scope.sourceHash,
    version: scope.version,
    mappingVersion: options.mappingVersion,
    planId: scope.planId,
    unit,
    currentWindow: (() => {
      const key = ledger.last ?? legacy?.lastWindowKey();
      if (!key) return null;
      const window = readCollectionConversionWindow(scope, key),
        bytes = Buffer.byteLength(JSON.stringify(window));
      return bytes > 2048
        ? { format: 'health-intake-reading-window-reference-v1' as const, key, bytes }
        : window;
    })(),
    reading: {
      totalUnits: unitCount,
      accountedUnits,
      remainingUnits: unitCount - accountedUnits - skippedUnits,
      readWindows: totals.seen,
      distinctReads: totals.distinct,
      pendingReadWindows: pendingCount,
    },
    pendingWindows: {
      total: pendingCount,
      items: windows,
      complete: windows.length === pendingCount,
    },
    ...(legacy
      ? {
          importedCheckpoint: {
            unmatchedWindows: legacy.unmatched(),
            state: legacy.unmatched() ? ('pending_unmatched' as const) : ('retained' as const),
          },
        }
      : {}),
    retainedCandidateCount: workflow ? view.childCount(workflow, 'candidates') : 0,
    workflow: readVerifiedWorkflowSummary(db, { id: scope.intakeId }, options),
    readingFacts: readVerifiedWorkflowReadingFacts(db, { id: scope.intakeId }, options),
    coverage: 'reading_progress_only' as const,
  };
}

/** Each extracted claim checks its own retained unit ledger. The caller may
 * supply at most fifty scopes for a manual multi-unit batch. */
export function assertCollectionConversionCoverage(
  scopes: readonly CollectionConversionScope[],
  input: { planId: string; coverage?: readonly IntakeExtractionCoverage[] },
) {
  if (scopes.length > 50 || (input.coverage?.length || 0) > 50)
    throw Error('Oversized reading coverage scope');
  for (const coverage of input.coverage || []) {
    if (coverage.kind !== 'extracted') continue;
    const scope = scopes.find(
      (item) => item.planId === input.planId && item.unitId === coverage.unitId,
    );
    if (!scope)
      throw new HttpError(
        409,
        'CONVERSION_COVERAGE_PENDING',
        'Choose the selected unit reading ledger before claiming extracted coverage',
      );
    const { unit, pages } = owner(scope),
      ledger = state(scope);
    const legacy = openLegacyReadingSession(legacyContext(scope));
    const scopeRead = (page: number | null = null) =>
      text(
        scope,
        collectionName(scope),
        'read:' + scopeKey([unit.sourceFileId || scope.intakeId, unit.memberId || null, page]),
      ) ||
      legacy?.has(
        'read',
        scopeKey([unit.sourceFileId || scope.intakeId, unit.memberId || null, page]),
      );
    let read = !!scopeRead();
    if (pages && unit.kind === 'pdf') {
      const collections = store(scope),
        selected = collections.openView();
      const readPages =
        collections.rank(selected, 'builds', collectionName(scope), 'page;') -
        collections.rank(selected, 'builds', collectionName(scope), 'page:') +
        (legacy?.readPages() ?? 0);
      if (readPages > pages.uniqueCount) throw Error('Invalid retained page reading count');
      read = readPages === pages.uniqueCount;
    }
    if (
      (!read && ['package_member', 'image', 'pdf'].includes(unit.kind)) ||
      ledger.pending ||
      legacy?.pending()
    )
      throw new HttpError(
        409,
        'CONVERSION_COVERAGE_PENDING',
        'Read every remaining window in this member before claiming extracted coverage',
      );
  }
}

/** A child plan keeps its own source and unit authority. Its direct reads remain
 * in the parent's conversation ledger, as they did in the legacy checkpoint. */
export async function assertCollectionChildConversionCoverage(
  parent: CollectionConversionScope,
  targets: readonly CollectionConversionScope[],
  input: { planId: string; coverage: readonly IntakeExtractionCoverage[] },
  options: { assertRunning?: () => void } = {},
) {
  if (targets.length > 50 || input.coverage.length > 50)
    throw Error('Oversized child reading coverage scope');
  if (!input.coverage.some((item) => item.kind === 'extracted')) return;
  const { db } = owner(parent),
    collections = store(parent),
    name = collectionName(parent),
    legacy = openLegacyReadingSession(legacyContext(parent));
  const root = (collection: string) =>
    collections.collection(collections.openView(), 'builds', collection)?.root?.hash ?? '';
  const before = root(name),
    legacyBefore = legacy ? root(legacy.name) : '';
  const descendantChecks: Array<() => void> = [];
  const check = () => {
    options.assertRunning?.();
    assertIntakeOwner(db, parent.profileId);
    owner(parent);
    for (const target of targets) owner(target);
    for (const assertCurrent of descendantChecks) assertCurrent();
    if (root(name) !== before || (legacy && root(legacy.name) !== legacyBefore))
      throw new HttpError(
        409,
        'CONVERSION_CHANGED',
        'Reading evidence changed. Retry this exact coverage claim.',
      );
  };
  const nativePending = await prepareReadingPendingIndex(
    db,
    parent.intakeId + ':' + name,
    before,
    function* () {
      for (const entry of entries(parent, name, 'pending:')) {
        const key = entry.key.slice('pending:'.length);
        yield { key, window: readCollectionConversionWindow(parent, key) };
      }
    },
    check,
  );
  const legacyPending =
    legacy &&
    (await prepareReadingPendingIndex(
      db,
      parent.intakeId + ':' + legacy.name,
      legacyBefore,
      function* () {
        for (const entry of legacy.entries('legacy.pending:')) {
          const key = entry.key.slice('legacy.pending:'.length).split(':')[0]!;
          const window = legacy.window(key);
          if (!window) throw Error('Imported pending child read is unavailable');
          yield { key, window };
        }
      },
      check,
    ));
  const pending = [nativePending, ...(legacyPending ? [legacyPending] : [])];
  const seen = (key: string) => !!text(parent, name, 'seen:' + key) || !!legacy?.has('seen', key);
  const read = (source: string, page: number | null) => {
    const key = scopeKey([source, null, page]);
    return !!text(parent, name, 'read:' + key) || !!legacy?.has('read', key);
  };
  await checkChildCoverageTargets(targets, input, {
    parentId: parent.intakeId,
    profileId: parent.profileId,
    sessionId: parent.sessionId,
    check,
    async checkSource(sourceId) {
      const descendant = await checkedDescendant(parent, { id: sourceId }, options);
      if (descendant) descendantChecks.push(descendant.assertCurrent);
      else checkReadScope(parent, { id: sourceId });
    },
    read,
    seen,
    pending,
  });
}

/** A retained legacy conversation may create a native plan only for its child.
 * Read the real selected child units without reconstructing a legacy intake. */
export async function assertLegacyCollectionChildConversionCoverage(
  checkpoint: ConversionCheckpoint,
  sessionId: string,
  targets: readonly CollectionConversionScope[],
  input: { planId: string; coverage: readonly IntakeExtractionCoverage[] },
  options: { assertRunning?: () => void } = {},
) {
  if (!targets.length || !input.coverage.some((item) => item.kind === 'extracted')) return;
  const { db } = owner(targets[0]!);
  const root = intakeSourceVersion(db, checkpoint.intakeId);
  const seenCount = checkpoint.seen.length,
    pendingCount = checkpoint.pending.length,
    readCount = checkpoint.readScopes.length,
    last = checkpoint.lastWindow;
  const check = () => {
    options.assertRunning?.();
    assertIntakeOwner(db, checkpoint.profileId);
    const current = intakeSourceVersion(db, checkpoint.intakeId);
    if (
      current.logicalBinding !== root.logicalBinding ||
      current.version !== root.version ||
      checkpoint.seen.length !== seenCount ||
      checkpoint.pending.length !== pendingCount ||
      checkpoint.readScopes.length !== readCount ||
      checkpoint.lastWindow !== last ||
      db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(checkpoint.intakeId)?.sha256 !==
        checkpoint.sourceHash
    )
      throw new HttpError(
        409,
        'CONVERSION_CHANGED',
        'Reading evidence changed. Retry this exact coverage claim.',
      );
    for (const target of targets) owner(target);
  };
  const { checkIntakeSourceAncestry } = await import('./intake-source-ancestry.ts');
  // The legacy checkpoint already owns its complete pending array. Index it
  // once for this bounded claim; do not persist or promote completion IDs.
  const pendingId = 'legacy-child:' + sessionId;
  const binding = randomUUID();
  const pending = await prepareReadingPendingIndex(
    db,
    pendingId,
    binding,
    function* () {
      for (let ordinal = 0; ordinal < checkpoint.pending.length; ordinal++)
        yield { key: String(ordinal), window: checkpoint.pending[ordinal]! };
    },
    check,
  );
  await checkChildCoverageTargets(targets, input, {
    parentId: checkpoint.intakeId,
    profileId: checkpoint.profileId,
    sessionId,
    check,
    checkSource: async (sourceId) => {
      if (
        !(await checkIntakeSourceAncestry(db, checkpoint.profileId, sourceId, {
          stopAt: checkpoint.intakeId,
          assertRunning: check,
        }))
      )
        throw new HttpError(
          403,
          'CONVERSION_SCOPE',
          'Child evidence no longer belongs to this conversion',
        );
    },
    read: (sourceId, page) => checkpoint.readScopes.includes(scopeKey([sourceId, null, page])),
    seen: (key) => checkpoint.seen.includes(key),
    pending: [pending],
  });
}

async function checkChildCoverageTargets(
  targets: readonly CollectionConversionScope[],
  input: { planId: string; coverage: readonly IntakeExtractionCoverage[] },
  evidence: {
    parentId: string;
    profileId: string;
    sessionId: string;
    check: () => void;
    checkSource: (sourceId: string) => void | Promise<void>;
    read: (sourceId: string, page: number | null) => boolean;
    seen: (key: string) => boolean;
    pending: readonly Awaited<ReturnType<typeof prepareReadingPendingIndex>>[];
  },
) {
  if (targets.length > 50 || input.coverage.length > 50)
    throw Error('Oversized child reading coverage scope');
  const { check, read, seen, pending } = evidence;
  const refuse = () => {
    throw new HttpError(
      409,
      'CONVERSION_COVERAGE_PENDING',
      'Read every remaining window in this child source before claiming extracted coverage',
    );
  };
  for (const coverage of input.coverage) {
    if (coverage.kind !== 'extracted') continue;
    const target = targets.find(
      (scope) => scope.planId === input.planId && scope.unitId === coverage.unitId,
    );
    if (!target || target.intakeId === evidence.parentId) refuse();
    const selected = owner(target!),
      { unit, pages } = selected,
      sourceId = unit.sourceFileId || target!.intakeId;
    if (
      sourceId !== target!.intakeId ||
      target!.profileId !== evidence.profileId ||
      target!.sessionId !== evidence.sessionId
    )
      refuse();
    // This proves the child still belongs to this exact retained member or
    // addressed asset and that its bytes match the original read-source pin.
    await evidence.checkSource(sourceId);
    check();
    if (unit.kind === 'pdf') {
      if (!pages) refuse();
      for (let ordinal = 0; ordinal < pages!.uniqueCount; ordinal++) {
        check();
        const page = pages!.uniquePageAt(ordinal)!;
        if (!read(sourceId, page) || pending.some((index) => index.page(sourceId, page))) refuse();
        if (ordinal % 32 === 31) await setImmediate();
      }
    } else {
      if (['image', 'package_member'].includes(unit.kind) && !read(sourceId, null)) refuse();
      if (pending.some((index) => index.unit(sourceId, unit.id))) refuse();
      if (
        ['text', 'html'].includes(unit.kind) &&
        !seen(
          windowKey(
            descriptor('health_intake_plan', {
              id: sourceId,
              action: 'read_unit',
              unitId: unit.id,
            }),
          ),
        )
      ) {
        const end =
          selected.plan.kind === 'direct'
            ? selected.plan.scope.unitById(unit.id)?.end
            : selected.retainedUnit &&
              (() => {
                const field = selected.retainedUnit!.reader.field(
                  selected.retainedUnit!.record,
                  'end',
                  { bytes: 128 },
                );
                if (field.kind === 'missing') return undefined;
                if (field.kind !== 'value' || typeof field.value !== 'number')
                  throw Error('Child unit end is unavailable');
                return field.value;
              })();
        // A parent member read is a different evidence scope. With no direct
        // child read, an empty child pending index proves nothing about its tail.
        if (!read(sourceId, null) || pending.some((index) => index.text(sourceId, end))) refuse();
      }
    }
  }
  check();
}
import { intakeMetadataScalarMatches } from './intake-compact-scalar.ts';
