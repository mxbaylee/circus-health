import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observeTransactionOutcome } from './database.ts';
import {
  readSourceTextProjection,
  reconcileSourceTextProjection,
  sourceTextProjectionCounters,
} from './source-text-projection.ts';

const FUNCTION = '__source_details_search_text';

export interface SourceDetailsSearchLimits {
  maxEvaluations: number;
  maxReconstructedUtf16Units: number;
  maxReconstructedBytes: number;
}
export const SOURCE_DETAILS_SEARCH_LIMITS: Readonly<SourceDetailsSearchLimits> = Object.freeze({
  maxEvaluations: 100_000,
  maxReconstructedUtf16Units: 268_435_456,
  maxReconstructedBytes: 536_870_912,
});

/** These counters measure query consumption separately from projection maintenance.
 * A candidate is reconstructed again for the page query; no reconstructed strings
 * are cached across candidates, statements, requests, sessions or profiles. */
export interface SourceDetailsSearchCounters {
  requests: number;
  completedRequests: number;
  failedRequests: number;
  activeRequests: number;
  evaluations: number;
  reconstructions: number;
  reconstructedUtf16Units: number;
  reconstructedBytes: number;
  peakTextBytes: number;
  retainedEntries: number;
  peakRetainedEntries: number;
  bindingReads: number;
  queryProjectionRowsRead: number;
  queryProjectionReadBytes: number;
  queryAuthorityReads: number;
  queryAuthorityBytes: number;
  dtoRows: number;
  dtoDetailsBytes: number;
}
interface Scope {
  token: string;
  profile: string;
  failed: boolean;
  evaluating: boolean;
  evaluations: number;
  units: number;
  bytes: number;
  limits: SourceDetailsSearchLimits;
  unobserve: () => void;
}
interface Connection {
  active?: Scope;
  counters: SourceDetailsSearchCounters;
}
const connections = new WeakMap<DatabaseSync, Connection>();
const registered = new WeakSet<DatabaseSync>();

function connectionFor(db: DatabaseSync): Connection {
  const old = connections.get(db);
  if (old) return old;
  const connection: Connection = {
    counters: {
      requests: 0,
      completedRequests: 0,
      failedRequests: 0,
      activeRequests: 0,
      evaluations: 0,
      reconstructions: 0,
      reconstructedUtf16Units: 0,
      reconstructedBytes: 0,
      peakTextBytes: 0,
      retainedEntries: 0,
      peakRetainedEntries: 0,
      bindingReads: 0,
      queryProjectionRowsRead: 0,
      queryProjectionReadBytes: 0,
      queryAuthorityReads: 0,
      queryAuthorityBytes: 0,
      dtoRows: 0,
      dtoDetailsBytes: 0,
    },
  };
  connections.set(db, connection);
  return connection;
}

export function sourceDetailsSearchCounters(db: DatabaseSync): SourceDetailsSearchCounters {
  return connectionFor(db).counters;
}

/** Invalidate an outstanding plan on lock/close/session invalidation. The installed
 * dispatcher contains no query, source text, profile identity or operational view. */
export function clearSourceDetailsSearchCache(db: DatabaseSync): void {
  const connection = connections.get(db);
  if (connection?.active) {
    connection.active.unobserve();
    connection.active.profile = '';
    connection.active = undefined;
    connection.counters.activeRequests = 0;
    connection.counters.failedRequests++;
  }
  connections.delete(db);
}

export interface SourceDetailsSearchPlan {
  joins: string;
  predicate: string;
  parameters: string[];
  /** Always dispose in finally, passing any count/page/DTO error from catch. */
  dispose(error?: unknown): void;
}

/** Selected DTOs retain the current complete source envelope. Account for those
 * page-only authority reads separately from candidate text reconstruction. */
export function recordSourceDetailsSearchDTORead(db: DatabaseSync, raw: unknown): void {
  const connection = connections.get(db);
  if (!connection?.active) return;
  connection.counters.dtoRows++;
  if (typeof raw === 'string') connection.counters.dtoDetailsBytes += Buffer.byteLength(raw);
}

/** Keep SQLite itself responsible for LIKE, including wildcards, case, Unicode
 * and embedded NUL behavior. Only its text operand changes. The projection's
 * selected profile/source/hash/head and transactional dirty tracking establish
 * freshness on every reconstruction, without parsing operational intake views. */
export function createSourceDetailsSearch(
  db: DatabaseSync,
  query: string,
  options: { limits?: Partial<SourceDetailsSearchLimits> } = {},
): SourceDetailsSearchPlan {
  const connection = connectionFor(db);
  if (connection.active) throw Error('Source details search already has an active request');
  connection.counters.requests++;
  const limits = { ...SOURCE_DETAILS_SEARCH_LIMITS };
  try {
    for (const key of Object.keys(options.limits ?? {}) as (keyof SourceDetailsSearchLimits)[]) {
      const value = options.limits![key];
      if (
        !Object.hasOwn(SOURCE_DETAILS_SEARCH_LIMITS, key) ||
        value === undefined ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > SOURCE_DETAILS_SEARCH_LIMITS[key]
      )
        throw Error(`Invalid source details search limit: ${key}`);
      limits[key] = value;
    }
    // Schema repair and initial authoritative reconstruction happen before the
    // outer SQL statement starts; warm reads need no source JSON hydration.
    reconcileSourceTextProjection(db);
    if (!registered.has(db)) {
      db.function(FUNCTION, (token, sourceId) => {
        const current = connections.get(db);
        const scope = current?.active;
        if (!scope || token !== scope.token)
          throw Error('Source details search request is no longer active');
        current.counters.evaluations++;
        try {
          if (scope.evaluating) throw Error('Reentrant source details search');
          if (++scope.evaluations > scope.limits.maxEvaluations)
            throw Error('Source details search evaluation limit exceeded');
          scope.evaluating = true;
          current.counters.bindingReads++;
          if (
            !db
              .prepare("SELECT 1 FROM app_meta WHERE key='owner_profile_id' AND value=?")
              .get(scope.profile)
          )
            throw Error('Source details search profile binding changed');
          if (typeof sourceId !== 'string') throw Error('Invalid source search identity');
          const before = sourceTextProjectionCounters(db);
          const reads = {
            rows: before.projectionRowsRead,
            bytes: before.projectionReadBytes,
            authorityReads: before.authorityReads,
            authorityBytes: before.authorityBytes,
          };
          let text: string;
          try {
            text = readSourceTextProjection(db, sourceId);
          } finally {
            const after = sourceTextProjectionCounters(db);
            current.counters.queryProjectionRowsRead += after.projectionRowsRead - reads.rows;
            current.counters.queryProjectionReadBytes += after.projectionReadBytes - reads.bytes;
            current.counters.queryAuthorityReads += after.authorityReads - reads.authorityReads;
            current.counters.queryAuthorityBytes += after.authorityBytes - reads.authorityBytes;
          }
          const size = Buffer.byteLength(text);
          current.counters.reconstructions++;
          current.counters.reconstructedUtf16Units += text.length;
          current.counters.reconstructedBytes += size;
          current.counters.peakTextBytes = Math.max(current.counters.peakTextBytes, size);
          scope.units += text.length;
          scope.bytes += size;
          if (
            scope.units > scope.limits.maxReconstructedUtf16Units ||
            scope.bytes > scope.limits.maxReconstructedBytes
          )
            throw Error('Source details search reconstruction limit exceeded');
          return text;
        } catch (error) {
          scope.failed = true;
          throw error;
        } finally {
          scope.evaluating = false;
        }
      });
      registered.add(db);
    }
  } catch (error) {
    connection.counters.failedRequests++;
    throw error;
  }
  const scope: Scope = {
    token: randomUUID(),
    profile: db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!
      .value as string,
    failed: false,
    evaluating: false,
    evaluations: 0,
    units: 0,
    bytes: 0,
    limits,
    unobserve: () => {},
  };
  connection.active = scope;
  connection.counters.activeRequests = 1;
  scope.unobserve = observeTransactionOutcome(db, () => clearSourceDetailsSearchCache(db));
  return {
    joins: '',
    predicate: `(f.path LIKE ? OR ${FUNCTION}(?,f.id) LIKE ?)`,
    parameters: [`%${query}%`, scope.token, `%${query}%`],
    dispose(error?: unknown) {
      if (connection.active !== scope) return;
      scope.unobserve();
      scope.profile = '';
      connection.active = undefined;
      connection.counters.activeRequests = 0;
      if (scope.failed || error !== undefined) connection.counters.failedRequests++;
      else connection.counters.completedRequests++;
    },
  };
}
