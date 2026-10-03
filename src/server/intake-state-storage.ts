import {
  currentTransactionToken,
  observeTransactionOutcome,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  createIntakePrimitiveCounters,
  recordIntakeWork,
  withIntakeWork,
} from './intake-work-accounting.ts';
import {
  applyIntakeChangesIsolated,
  cloneValidatedIntakeJson,
  freezeValidatedIntakeJson,
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
  checkIntakeResult,
  frameIntakeChanges,
  type Basis,
  type Limits,
  type IntakeStateIdentity,
  type IntakeStateResult,
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
  token?: object;
  dispose: () => void;
}
const caches = new WeakMap<Database, Cache>();
export function clearIntakeStateCache(db: Database): void {
  const cache = caches.get(db);
  if (!cache) return;
  cache.committed.clear();
  cache.candidates.clear();
  cache.dispose();
  caches.delete(db);
}
function cacheFor(db: Database): Cache {
  let cache = caches.get(db);
  if (!cache) {
    cache = { committed: new Map(), candidates: new Map(), dispose: () => {} };
    const owned = cache;
    owned.dispose = observeTransactionOutcome(db, (outcome) => {
      try {
        if (!outcome.succeeded) {
          clearIntakeStateCache(db);
          return;
        }
        if (outcome.token !== owned.token) return;
        if (outcome.succeeded) {
          for (const [key, candidate] of owned.candidates) owned.committed.set(key, candidate);
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
  const get = (key: string) => {
    const value = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
    count('metadataReads');
    if (typeof value === 'string') count('metadataReadBytes', Buffer.byteLength(value));
    return value;
  };
  function ready() {
    if (closed || !db.isOpen) {
      clearIntakeStateCache(db);
      invalid('closed');
    }
    if (get('owner_profile_id') !== identity.profileId) invalid('database owner');
    const source = db
      .prepare('SELECT sha256,kind FROM source_files WHERE id=?')
      .get(identity.intakeId);
    if (!source || source.sha256 !== identity.sourceHash || source.kind !== 'intake_original')
      invalid('original source');
    const durability = recordDurabilityStatus(db);
    if (!durability?.configured || durability.dirty) {
      clearIntakeStateCache(db);
      invalid('accepted authority requires configured current projection');
    }
  }
  function immutable(key: string, serialized: string) {
    const old = get(key);
    if (old !== undefined) {
      if (old !== serialized) invalid('immutable collision');
      return;
    }
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, serialized);
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
      cache.candidates.set(prefix, result);
    } else cache.committed.set(prefix, result);
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
    cache.candidates.set(
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
