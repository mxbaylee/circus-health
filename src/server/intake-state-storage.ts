import {
  currentTransactionToken,
  observeTransactionOutcome,
  rejectCurrentTransaction,
  transaction,
  type Database,
} from './database.ts';
import { recordDurabilityStatus } from './record-versions.ts';
import {
  applyIntakeChanges,
  intakeChanges,
  normalizeIntakeJson,
  serializeIntakeJson,
  type IntakeJson,
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
interface Cache {
  committed: Map<string, Basis>;
  candidates: Map<string, Basis>;
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

/** Internal primitive only; production intake readers/writers have not cut over. */
export function createIntakeStateStorage(
  db: Database,
  identity: IntakeStateIdentity,
  options: { limits?: Partial<Limits> } = {},
) {
  identity = validateIntakeIdentity(identity);
  const caps = limits(options.limits);
  // The allocation namespace stays fixed so older payload formats are refused
  // at their existing head, never mistaken for an uninitialized new namespace.
  const prefix = intakeNamespace(identity);
  const headKey = `${prefix}head`;
  let closed = false;
  const counters = {
    coldReconstructions: 0,
    ancestorReads: 0,
    candidateCopies: 0,
    patchOperations: 0,
    normalizedStateBytes: 0,
    candidateCopyBytes: 0,
    framesWritten: 0,
    frameBytesWritten: 0,
    readCopies: 0,
    readCopyBytes: 0,
    serializedReadBytes: 0,
  };
  const get = (key: string) => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
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
  function load(): Basis | undefined {
    ready();
    const head = parseIntakeHead(get(headKey), identity, caps);
    const cache = cacheFor(db);
    const token = currentTransactionToken(db);
    const candidate = token === cache.token ? cache.candidates.get(prefix) : undefined;
    const remembered = candidate ?? cache.committed.get(prefix);
    if (!head) {
      if (db.prepare('SELECT 1 FROM app_meta WHERE key GLOB ? LIMIT 1').get(`${prefix}*`))
        invalid('missing head with retained evidence');
      return undefined;
    }
    if (remembered && same(remembered.head, head)) return remembered;
    counters.coldReconstructions++;
    const reconstructed = reconstructIntakeEvidence(identity, caps, head, get, () => {
      counters.ancestorReads++;
    });
    const result: Basis = {
      head: reconstructed.head,
      value: reconstructed.value,
      semanticBytes: reconstructed.semanticBytes,
    };
    if (token) {
      cache.token = token;
      cache.candidates.set(prefix, result);
    } else cache.committed.set(prefix, result);
    return result;
  }
  function normalized(next: unknown): { value: IntakeJson; fingerprint: string } {
    const value = normalizeIntakeJson(next);
    const serialized = serializeIntakeJson(value);
    counters.normalizedStateBytes += Buffer.byteLength(serialized);
    return { value, fingerprint: digest(serialized) };
  }
  function stageNormalized(
    value: IntakeJson,
    fingerprint: string,
    operationId: string,
  ): IntakeStateResult {
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
    const changes = before ? intakeChanges(before.value, value) : [{ op: 'set', path: [], value }];
    counters.patchOperations += changes.length;
    const candidate = before ? normalizeIntakeJson(before.value) : undefined;
    if (before) {
      counters.candidateCopies++;
      counters.candidateCopyBytes += before.semanticBytes;
    }
    const oldUsage = before?.head.usage ?? {
      bytes: 0,
      frames: 0,
      nodes: 0,
      operations: 0,
      stringWork: 0,
    };
    const remaining = budget(caps, oldUsage);
    const applied = applyIntakeChanges(candidate, changes, remaining);
    const serializedValue = serializeIntakeJson(applied);
    const semanticBytes = Buffer.byteLength(serializedValue);
    if (digest(serializedValue) !== fingerprint) invalid('candidate mismatch');
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
      counters.framesWritten++;
      counters.frameBytesWritten += Buffer.byteLength(entry.serialized);
    }
    immutable(receiptKey, receipt);
    db.prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(headKey, serializedHead);
    const cache = cacheFor(db);
    cache.token = token;
    cache.candidates.set(prefix, { head, value: applied, semanticBytes });
    return result;
  }
  return {
    counters,
    read(): IntakeJson | undefined {
      const basis = load();
      if (!basis) return undefined;
      counters.readCopies++;
      counters.readCopyBytes += basis.semanticBytes;
      return normalizeIntakeJson(basis.value);
    },
    readSerialized(): string | undefined {
      const basis = load();
      if (!basis) return undefined;
      counters.serializedReadBytes += basis.semanticBytes;
      return serializeIntakeJson(basis.value);
    },
    stage(next: unknown, operationId: string): IntakeStateResult {
      try {
        const { value, fingerprint } = normalized(next);
        return stageNormalized(value, fingerprint, operationId);
      } catch (error) {
        if (currentTransactionToken(db)) rejectCurrentTransaction(db, error);
        clearIntakeStateCache(db);
        throw error;
      }
    },
    mutate(next: unknown, operationId: string): IntakeStateResult {
      if (currentTransactionToken(db) || db.isTransaction) invalid('mutate owns outer transaction');
      const { value, fingerprint } = normalized(next);
      uuid(operationId);
      try {
        // The transaction layer can return a retained result without invoking
        // its callback. Validate selected authority before that replay shortcut.
        load();
        return transaction(db, () => stageNormalized(value, fingerprint, operationId), {
          operationId,
          fingerprint: `${prefix}${fingerprint}`,
          actor: 'intake-state',
        });
      } catch (error) {
        clearIntakeStateCache(db);
        throw error;
      }
    },
    close() {
      closed = true;
      clearIntakeStateCache(db);
    },
  };
}
