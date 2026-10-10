import { clearNativeIdentityPreviews } from './intake-identity-preview-cache.ts';
import { setImmediate } from 'node:timers/promises';
import { terminalStatement } from './database-terminal-statements.ts';
import { clearPreparedClinicalReviewRead } from './intake-clinical-review-read-cache.ts';
import { clearCollectionQueueReviews } from './intake-report-group-collection.ts';
import { clearReviewIssueScratch } from './intake-review-issue-scratch.ts';
import {
  currentTransactionToken,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import { createTransactionOutcomeIssuer } from './transaction-observer-issuer.ts';
const outcomes = createTransactionOutcomeIssuer();
export const intakeStateTerminalOutcome = outcomes.recognizes;
import { recordDurabilityStatus, recordTerminalSelectionAttempted } from './record-versions.ts';
import { clearIntakeCollectionCache, createIntakeCollections } from './intake-state-collections.ts';
import { clearIntakeMaintenancePublications } from './intake-state-maintenance.ts';
import { clearIntakeLegacyBridgeProofs } from './intake-state-migration.ts';
export type {
  IntakeCollectionView,
  PreparedIntakeCollectionMutation,
  IntakeCollectionArea,
  IntakeCollectionChange,
  IntakeCollectionMutation,
  IntakeCollectionDescriptor,
  IntakeByteValue,
  IntakeCollectionValue,
} from './intake-state-collections.ts';
import {
  createIntakePrimitiveCounters,
  recordIntakeWork,
  withIntakeWork,
} from './intake-work-accounting.ts';
import {
  applyIntakeChangesIsolated,
  cloneValidatedIntakeJson,
  freezeValidatedIntakeJson,
  freezeValidatedIntakeJsonSteps,
  intakeChanges,
  normalizeIntakeJson,
  serializeIntakeJson,
  type IntakeJson,
  type IntakeChange,
} from './intake-state-codec.ts';

import {
  HEAD_BYTES,
  invalid,
  digest,
  exact,
  uuid,
  decode,
  limits,
  budget,
  validateIntakeIdentity,
  intakeNamespace,
  parseIntakeHead,
  reconstructIntakeEvidence,
  reconstructIntakeEvidenceSteps,
  checkIntakeResult,
  frameIntakeChanges,
  type Basis,
  type Limits,
  type IntakeStateIdentity,
  type IntakeStateResult,
  type Head,
} from './intake-state-evidence.ts';
export type { IntakeStateIdentity, IntakeStateResult } from './intake-state-evidence.ts';
export interface IntakePreparedMaterialization {
  /** Recursively immutable at runtime. Use read() when a mutable view is needed. */
  readonly value: IntakeJson;
  readonly serialized: string;
  readonly fingerprint: string;
  readonly semanticBytes: number;
}
export interface IntakeStateMaterialization extends IntakePreparedMaterialization {
  readonly selectedHead: string;
}
declare const preparedBrand: unique symbol;
export interface PreparedIntakeState {
  readonly [preparedBrand]: true;
}
interface CachedBasis extends Basis {
  materialization: IntakeStateMaterialization;
}
interface Preparation {
  db: Database;
  prefix: string;
  caps: string;
  cache: Cache;
  materialization: IntakePreparedMaterialization;
}
const preparations = new WeakMap<PreparedIntakeState, Preparation>();
interface Cache {
  committed: Map<string, CachedBasis>;
  candidates: Map<string, CachedBasis>;
  prepared: Map<PreparedIntakeState, Preparation>;
  token?: object;
  dispose: () => void;
}
const caches = new WeakMap<Database, Cache>();
const terminalCleanups = new WeakMap<Database, { pending: boolean; selected: boolean }>();
/** Refusal cleanup can invoke mutable session methods, so it runs only after
 * the terminal owner has closed its native rollback and callback barrier. */
export function withIntakeStateTerminalCleanup<T>(db: Database, run: () => T): T {
  if (terminalCleanups.has(db)) throw Error('Nested terminal intake cleanup');
  const cleanup = { pending: false, selected: false };
  terminalCleanups.set(db, cleanup);
  try {
    return run();
  } finally {
    terminalCleanups.delete(db);
    if (cleanup.pending && !cleanup.selected) {
      if (db.isTransaction) throw Error('Terminal intake cleanup requires completed rollback');
      try {
        clearIntakeCaches(db, false);
      } catch {
        // Disposable outcome cleanup cannot change the original refusal.
      }
    }
  }
}
/** Legacy materializations share the connection lifecycle with v4 pages. Large
 * v3 values remain readable, but are not retained as an unbounded warm cache. */
function remember(cache: Cache, target: Map<string, CachedBasis>, key: string, value: CachedBasis) {
  target.delete(key);
  if (value.semanticBytes > 16 * 1024 * 1024) return;
  target.set(key, value);
  const retainedBytes = () =>
    [...cache.committed.values(), ...cache.candidates.values()].reduce(
      (sum, entry) => sum + entry.semanticBytes,
      0,
    );
  while (cache.committed.size + cache.candidates.size > 64 || retainedBytes() > 32 * 1024 * 1024) {
    const oldest = cache.committed.size ? cache.committed : cache.candidates;
    oldest.delete(oldest.keys().next().value!);
  }
}
export function clearIntakeStateCache(db: Database): void {
  clearIntakeCaches(db, true);
}
function clearIntakeCaches(
  db: Database,
  releaseReviewScratch: boolean,
  preparedToken?: object,
): void {
  const terminal = terminalCleanups.get(db);
  if (terminal) {
    terminal.pending = true;
    const token = currentTransactionToken(db);
    terminal.selected ||= !!token && recordTerminalSelectionAttempted(token);
    const cache = caches.get(db);
    cache?.committed.clear();
    cache?.candidates.clear();
    if (cache) {
      for (const prepared of cache.prepared.keys()) preparations.delete(prepared);
      cache.prepared.clear();
      cache.token = undefined;
    }
    return;
  }
  clearNativeIdentityPreviews(db);
  clearPreparedClinicalReviewRead(db);
  clearCollectionQueueReviews(db);
  if (releaseReviewScratch) clearReviewIssueScratch(db);
  clearIntakeCollectionCache(db);
  clearIntakeMaintenancePublications(db, preparedToken);
  clearIntakeLegacyBridgeProofs(db);
  const cache = caches.get(db);
  if (!cache) return;
  cache.committed.clear();
  cache.candidates.clear();
  for (const prepared of cache.prepared.keys()) preparations.delete(prepared);
  cache.prepared.clear();
  cache.dispose();
  caches.delete(db);
}
function cacheFor(db: Database): Cache {
  let cache = caches.get(db);
  if (!cache) {
    cache = { committed: new Map(), candidates: new Map(), prepared: new Map(), dispose: () => {} };
    const owned = cache;
    owned.dispose = outcomes.observe(db, (outcome) => {
      const terminal = terminalCleanups.get(db);
      if (terminal) {
        terminal.selected ||= outcome.committed || recordTerminalSelectionAttempted(outcome.token);
        if (!outcome.succeeded) {
          if (!outcome.committed && !recordTerminalSelectionAttempted(outcome.token))
            terminal.pending = true;
          // A post-selection failure is not permission to call mutable cleanup
          // after the original roster. Invalidate only private prepared maps.
          owned.committed.clear();
          owned.candidates.clear();
          for (const prepared of owned.prepared.keys()) preparations.delete(prepared);
          owned.prepared.clear();
          owned.token = undefined;
          return;
        }
        if (outcome.token !== owned.token) return;
        // No mutable session/scope disposal, including a catch path, is allowed
        // after a successful terminal publication.
        for (const [key, candidate] of owned.candidates)
          remember(owned, owned.committed, key, candidate);
        owned.candidates.clear();
        owned.token = undefined;
        return;
      }
      try {
        if (!outcome.succeeded) {
          // A rollback invalidates cached/prepared state, but does not own
          // caller-held review sessions. Their original physical proofs must
          // survive for a retry; their normal authority guards still run.
          clearIntakeCaches(
            db,
            false,
            outcome.prepared && !outcome.committed ? outcome.token : undefined,
          );
          return;
        }
        if (outcome.token !== owned.token) return;
        if (outcome.succeeded) {
          for (const [key, candidate] of owned.candidates)
            remember(owned, owned.committed, key, candidate);
          owned.candidates.clear();
          owned.token = undefined;
        } else clearIntakeStateCache(db);
      } catch {
        clearIntakeStateCache(db);
      }
    });
    caches.set(db, owned);
  }
  return cache;
}

/** Selected production intake state, with independent handle and connection work counters. */
export function createIntakeStateStorage(
  db: Database,
  identity: IntakeStateIdentity,
  options: { limits?: Partial<Limits> } = {},
) {
  identity = validateIntakeIdentity(identity);
  const caps = limits(options.limits);
  const capsBinding = JSON.stringify(caps);
  // The allocation namespace stays fixed so older payload formats are refused
  // at their existing head, never mistaken for an uninitialized new namespace.
  const prefix = intakeNamespace(identity);
  const headKey = `${prefix}head`;
  let closed = false;
  const { counters, count } = createIntakePrimitiveCounters(db);
  const readMeta = db.prepare('SELECT value FROM app_meta WHERE key=?'),
    readBoundedMeta = db.prepare(
      'SELECT length(CAST(value AS BLOB)) AS bytes, CASE WHEN length(CAST(value AS BLOB))<=? THEN value END AS value FROM app_meta WHERE key=?',
    ),
    readSource = db.prepare('SELECT sha256,kind FROM source_files WHERE id=?'),
    insertMeta = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
  const get = (key: string, maxBytes?: number) => {
    const row =
      maxBytes === undefined
        ? terminalStatement(db, readMeta.sourceSQL, readMeta).get(key)
        : terminalStatement(db, readBoundedMeta.sourceSQL, readBoundedMeta).get(maxBytes, key);
    count('metadataReads');
    if (maxBytes !== undefined && row && (typeof row.bytes !== 'number' || row.bytes > maxBytes))
      invalid('collection stored row bytes');
    const value = row?.value;
    if (typeof value === 'string') count('metadataReadBytes', Buffer.byteLength(value));
    return value;
  };
  function ready() {
    if (closed || !db.isOpen) {
      clearIntakeStateCache(db);
      invalid('closed');
    }
    if (get('owner_profile_id') !== identity.profileId) invalid('database owner');
    const source = terminalStatement(db, readSource.sourceSQL, readSource).get(identity.intakeId);
    if (!source || source.sha256 !== identity.sourceHash || source.kind !== 'intake_original')
      invalid('original source');
    const durability = recordDurabilityStatus(db);
    if (!durability?.configured || durability.dirty) {
      clearIntakeStateCache(db);
      invalid('accepted authority requires configured current projection');
    }
    // V4 also uses the existing outcome observer, including cache/preparation
    // invalidation after rollback or uncertain durable publication.
    cacheFor(db);
  }
  function immutable(key: string, serialized: string, maxBytes?: number): boolean {
    const old = get(key, maxBytes);
    if (old !== undefined) {
      if (old !== serialized) invalid('immutable collision');
      return false;
    }
    terminalStatement(db, insertMeta.sourceSQL, insertMeta, false, 'none').run(key, serialized);
    return true;
  }
  function cachedBasis(basis: Basis, selectedHead: string): CachedBasis {
    freezeValidatedIntakeJson(basis.value);
    recordIntakeWork('materializationsCreated');
    return {
      ...basis,
      materialization: Object.freeze({
        value: basis.value,
        serialized: basis.serialized,
        fingerprint: basis.fingerprint,
        semanticBytes: basis.semanticBytes,
        selectedHead,
      }),
    };
  }
  async function cachedBasisAsync(
    basis: Basis,
    selectedHead: string,
    assertCurrent: () => void,
  ): Promise<CachedBasis> {
    const steps = freezeValidatedIntakeJsonSteps(basis.value);
    try {
      for (;;) {
        assertCurrent();
        const next = withIntakeWork(db, 'reconstruction', () => steps.next());
        assertCurrent();
        if (next.done) break;
        await setImmediate();
      }
    } finally {
      steps.return(undefined as never);
    }
    assertCurrent();
    return withIntakeWork(db, 'reconstruction', () => cachedBasis(basis, selectedHead));
  }
  function load(): CachedBasis | undefined {
    ready();
    const selectedHead = get(headKey);
    const head = parseIntakeHead(selectedHead, identity, caps);
    const cache = cacheFor(db);
    const token = currentTransactionToken(db);
    const candidate = token === cache.token ? cache.candidates.get(prefix) : undefined;
    const remembered = candidate ?? cache.committed.get(prefix);
    if (!head) {
      if (db.prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1').get(`${prefix}*`))
        invalid('missing head with retained evidence');
      return undefined;
    }
    if (remembered && remembered.materialization.selectedHead === selectedHead) {
      count('warmLoads');
      return remembered;
    }
    count('coldReconstructions');
    const reconstructed = withIntakeWork(db, 'reconstruction', () =>
      reconstructIntakeEvidence(identity, caps, head, get, () => {
        count('ancestorReads');
      }),
    );
    const result = cachedBasis(
      {
        head: reconstructed.head,
        value: reconstructed.value,
        semanticBytes: reconstructed.semanticBytes,
        serialized: reconstructed.serialized,
        fingerprint: reconstructed.fingerprint,
      },
      selectedHead as string,
    );
    if (token) {
      cache.token = token;
      remember(cache, cache.candidates, prefix, result);
    } else remember(cache, cache.committed, prefix, result);
    return result;
  }
  async function replayAsync(
    head: Head,
    assertCurrent: () => void,
    onFrameRead?: () => void,
  ): Promise<ReturnType<typeof reconstructIntakeEvidence>> {
    const steps = reconstructIntakeEvidenceSteps(identity, caps, head, get, onFrameRead);
    try {
      for (;;) {
        assertCurrent();
        const next = withIntakeWork(db, 'reconstruction', () => steps.next());
        assertCurrent();
        if (next.done) return next.value;
        await setImmediate();
      }
    } finally {
      steps.return(undefined as never);
    }
  }
  async function loadAsync(assertCurrent: () => void): Promise<CachedBasis | undefined> {
    assertCurrent();
    ready();
    const selectedHead = get(headKey);
    const head = parseIntakeHead(selectedHead, identity, caps);
    const cache = cacheFor(db);
    const token = currentTransactionToken(db);
    const candidate = token === cache.token ? cache.candidates.get(prefix) : undefined;
    const remembered = candidate ?? cache.committed.get(prefix);
    if (!head) {
      if (db.prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1').get(`${prefix}*`))
        invalid('missing head with retained evidence');
      assertCurrent();
      return undefined;
    }
    if (remembered && remembered.materialization.selectedHead === selectedHead) {
      count('warmLoads');
      assertCurrent();
      return remembered;
    }
    count('coldReconstructions');
    const reconstructed = await replayAsync(head, assertCurrent, () => count('ancestorReads'));
    assertCurrent();
    if (get(headKey) !== selectedHead) invalid('selected head changed during cold replay');
    assertCurrent();
    const result = await cachedBasisAsync(
      {
        head: reconstructed.head,
        value: reconstructed.value,
        semanticBytes: reconstructed.semanticBytes,
        serialized: reconstructed.serialized,
        fingerprint: reconstructed.fingerprint,
      },
      selectedHead as string,
      assertCurrent,
    );
    assertCurrent();
    if (token) {
      cache.token = token;
      remember(cache, cache.candidates, prefix, result);
    } else remember(cache, cache.committed, prefix, result);
    return result;
  }
  function normalized(next: unknown): IntakePreparedMaterialization {
    const value = normalizeIntakeJson(next, undefined, true);
    const serialized = serializeIntakeJson(value);
    const semanticBytes = Buffer.byteLength(serialized);
    count('normalizedStateBytes', semanticBytes);
    freezeValidatedIntakeJson(value);
    return Object.freeze({ value, serialized, fingerprint: digest(serialized), semanticBytes });
  }
  function legacyMaterialization(head: Head): IntakeStateMaterialization {
    ready();
    const raw = JSON.stringify(head),
      cache = cacheFor(db),
      key = prefix + 'legacy';
    const prior = cache.committed.get(key) ?? cache.committed.get(prefix);
    if (prior?.materialization.selectedHead === raw) return prior.materialization;
    const reconstructed = withIntakeWork(db, 'reconstruction', () =>
      reconstructIntakeEvidence(identity, caps, head, get),
    );
    const result = cachedBasis(reconstructed, raw);
    remember(cache, cache.committed, key, result);
    return result.materialization;
  }
  async function legacyMaterializationAsync(
    head: Head,
    assertCurrent: () => void,
  ): Promise<IntakeStateMaterialization> {
    assertCurrent();
    ready();
    const raw = JSON.stringify(head),
      cache = cacheFor(db),
      key = prefix + 'legacy';
    const prior = cache.committed.get(key) ?? cache.committed.get(prefix);
    if (prior?.materialization.selectedHead === raw) {
      assertCurrent();
      return prior.materialization;
    }
    const reconstructed = await replayAsync(head, assertCurrent);
    assertCurrent();
    const result = await cachedBasisAsync(reconstructed, raw, assertCurrent);
    assertCurrent();
    remember(cache, cache.committed, key, result);
    return result.materialization;
  }
  function inspected(prepared: PreparedIntakeState): IntakePreparedMaterialization {
    ready();
    const entry = preparations.get(prepared);
    if (
      !entry ||
      entry.db !== db ||
      entry.prefix !== prefix ||
      entry.caps !== capsBinding ||
      entry.cache !== caches.get(db)
    )
      invalid('foreign or expired prepared state');
    recordIntakeWork('preparedStateReuses');
    return entry.materialization;
  }
  function stageNormalized(
    intended: IntakePreparedMaterialization,
    operationId: string,
  ): IntakeStateResult {
    const { value, fingerprint } = intended;
    ready();
    uuid(operationId);
    const token = currentTransactionToken(db);
    if (!token || !db.isTransaction) invalid('stage requires application transaction');
    const receiptKey = `${prefix}operation:${operationId}`;
    const prior = get(receiptKey);
    if (prior !== undefined) {
      const receipt = decode(prior, HEAD_BYTES);
      exact(receipt, ['fingerprint', 'result']);
      if (receipt.fingerprint !== fingerprint) invalid('operation replay conflict');
      checkIntakeResult(identity, receipt.result, operationId);
      load();
      return { ...receipt.result };
    }
    const before = load();
    const changes: IntakeChange[] = before
      ? intakeChanges(before.value, value)
      : [{ op: 'set', path: [], value }];
    count('patchOperations', changes.length);
    const oldUsage = before?.head.usage ?? {
      bytes: 0,
      frames: 0,
      nodes: 0,
      operations: 0,
      stringWork: 0,
    };
    const remaining = budget(caps, oldUsage);
    const applied = applyIntakeChangesIsolated(before?.value, changes, remaining);
    const serializedValue =
      before?.value === applied ? before.serialized : serializeIntakeJson(applied);
    const semanticBytes = Buffer.byteLength(serializedValue);
    recordIntakeWork('candidateVerificationCalls');
    recordIntakeWork('candidateVerificationBytes', semanticBytes);
    if (serializedValue !== intended.serialized) invalid('candidate mismatch');
    const evidence = frameIntakeChanges(
      identity,
      changes,
      fingerprint,
      operationId,
      caps,
      before?.head,
      remaining,
    );
    const { head, serializedHead, frames: staged, receipt, result } = evidence;
    // Validate everything before the first SQL write. The outer transaction publishes all rows together.
    for (const entry of staged) {
      immutable(entry.key, entry.serialized);
      if (get(entry.key) !== entry.serialized) invalid('staged readback');
      count('framesWritten');
      count('frameBytesWritten', Buffer.byteLength(entry.serialized));
    }
    immutable(receiptKey, receipt);
    db.prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(headKey, serializedHead);
    const cache = cacheFor(db);
    cache.token = token;
    remember(
      cache,
      cache.candidates,
      prefix,
      cachedBasis(
        {
          head,
          value: applied,
          semanticBytes,
          serialized: serializedValue,
          fingerprint,
        },
        serializedHead,
      ),
    );
    return result;
  }
  return {
    collections: createIntakeCollections({
      db,
      identity,
      prefix,
      ready,
      get,
      immutable,
      legacyMaterialization,
      legacyMaterializationAsync,
      invalidate: () => clearIntakeStateCache(db),
    }),
    counters,
    prepare(next: unknown): PreparedIntakeState {
      return withIntakeWork(db, 'warm', () => {
        try {
          ready();
          const materialization = normalized(next);
          const prepared = Object.freeze({}) as PreparedIntakeState;
          preparations.set(prepared, {
            db,
            prefix,
            caps: capsBinding,
            cache: cacheFor(db),
            materialization,
          });
          const cache = cacheFor(db);
          cache.prepared.set(prepared, preparations.get(prepared)!);
          // An explicitly prepared legacy value can still use its existing
          // per-value v3 budget; do not retain other preparations alongside it.
          while (
            cache.prepared.size > 1 &&
            (cache.prepared.size > 8 ||
              [...cache.prepared.values()].reduce(
                (sum, entry) => sum + entry.materialization.semanticBytes,
                0,
              ) >
                32 * 1024 * 1024)
          ) {
            const oldest = cache.prepared.keys().next().value!;
            cache.prepared.delete(oldest);
            preparations.delete(oldest);
          }
          return prepared;
        } catch (error) {
          if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
          clearIntakeStateCache(db);
          throw error;
        }
      });
    },
    inspectPrepared(prepared: PreparedIntakeState): IntakePreparedMaterialization {
      return withIntakeWork(db, 'warm', () => inspected(prepared));
    },
    readMaterialization(): IntakeStateMaterialization | undefined {
      return withIntakeWork(db, 'warm', () => {
        const basis = load();
        if (!basis) return undefined;
        recordIntakeWork('materializationReads');
        return basis.materialization;
      });
    },
    async readMaterializationAsync(
      assertCurrent: () => void,
    ): Promise<IntakeStateMaterialization | undefined> {
      const basis = await loadAsync(assertCurrent);
      if (!basis) return undefined;
      recordIntakeWork('materializationReads');
      assertCurrent();
      return basis.materialization;
    },
    stagePrepared(prepared: PreparedIntakeState, operationId: string): IntakeStateResult {
      return withIntakeWork(db, 'warm', () => {
        try {
          return stageNormalized(inspected(prepared), operationId);
        } catch (error) {
          if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
          clearIntakeStateCache(db);
          throw error;
        }
      });
    },
    read(): IntakeJson | undefined {
      return withIntakeWork(db, 'warm', () => {
        const basis = load();
        if (!basis) return undefined;
        count('readCopies');
        count('readCopyBytes', basis.semanticBytes);
        return cloneValidatedIntakeJson(basis.value);
      });
    },
    readSerialized(): string | undefined {
      return withIntakeWork(db, 'warm', () => {
        const basis = load();
        if (!basis) return undefined;
        count('serializedReadBytes', basis.semanticBytes);
        return basis.serialized;
      });
    },
    stage(next: unknown, operationId: string): IntakeStateResult {
      return withIntakeWork(db, 'warm', () => {
        try {
          return stageNormalized(normalized(next), operationId);
        } catch (error) {
          if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
          clearIntakeStateCache(db);
          throw error;
        }
      });
    },
    mutate(next: unknown, operationId: string): IntakeStateResult {
      return withIntakeWork(db, 'warm', () => {
        if (currentTransactionToken(db) || db.isTransaction)
          invalid('mutate owns outer transaction');
        const intended = normalized(next);
        const { fingerprint } = intended;
        uuid(operationId);
        try {
          // The transaction layer can return a retained result without invoking
          // its callback. Validate selected authority before that replay shortcut.
          load();
          return transaction(db, () => stageNormalized(intended, operationId), {
            operationId,
            fingerprint: `${prefix}${fingerprint}`,
            actor: 'intake-state',
          });
        } catch (error) {
          clearIntakeStateCache(db);
          throw error;
        }
      });
    },
    close() {
      closed = true;
      clearIntakeStateCache(db);
    },
  };
}
