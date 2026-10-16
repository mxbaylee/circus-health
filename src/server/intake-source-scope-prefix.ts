import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral, parseLiteralJSON } from './intake-format.ts';
import type {
  ClinicalOriginalScope,
  ClinicalSourceScopeGroup,
  ClinicalSourceScopeVersion,
  ClinicalSourceScopeBoundary,
} from './clinical-source-scope.ts';

export type SourceScopePrefixMetric =
  | 'clinicalSourceScopePrefixVerifiedGroups'
  | 'clinicalSourceScopePrefixRowsRead'
  | 'clinicalSourceScopePrefixMatchedGroups'
  | 'clinicalSourceScopePrefixTextBytesRead'
  | 'clinicalSourceScopePrefixTextBytesWritten'
  | 'clinicalSourceScopePrefixScratchWitnessReads'
  | 'hashCalls'
  | 'hashedBytes'
  | 'serializationCalls'
  | 'serializedBytes'
  | 'jsonParseCalls'
  | 'jsonParseBytes';
const TABLE = 'clinical_source_scope_verified_prefix_v1';
type Evaluate = (
  group: ClinicalSourceScopeGroup,
  current: ClinicalSourceScopeVersion | undefined,
) => Generator<void, boolean, void>;

/** Collection-scope-owned derived rows shared by handles; never selected source authority. */
export function createClinicalSourceScopePrefix(input: {
  sql: DatabaseSync;
  scope: ClinicalOriginalScope;
  groupAt(ordinal: number): ClinicalSourceScopeGroup;
  /** Undefined means the original uncached path, including caller transactions. */
  proof(): string | undefined;
  assertOpen(): void;
  rowBytes: number;
  work?(metric: SourceScopePrefixMetric, count: number): void;
}) {
  const rowBytes = Math.min(input.rowBytes, 256 * 1024);
  const work = (metric: SourceScopePrefixMetric, count = 1) => input.work?.(metric, count);
  const serialize = (value: unknown) => {
    const text = JSON.stringify(value);
    work('serializationCalls');
    work('serializedBytes', Buffer.byteLength(text));
    return text;
  };
  const canonical = (value: unknown) => {
    const text = canonicalLiteral(value);
    work('serializationCalls');
    work('serializedBytes', typeof text === 'string' ? Buffer.byteLength(text) : 0);
    return text;
  };
  const boundaryMatches = (
    group: ClinicalSourceScopeGroup,
    boundary: ClinicalSourceScopeBoundary,
  ) =>
    group.sourceFileId === boundary.sourceFileId &&
    group.sourceHash === boundary.sourceHash &&
    canonical(group.report?.anchor) === canonical(boundary.anchor) &&
    canonical(group.report?.subject) === canonical(boundary.subject) &&
    group.memberId === boundary.memberId;
  const nonce = randomUUID(),
    key = randomBytes(32);
  let frontier = 0,
    complete = false,
    closed = false,
    disabled = false,
    busy = false,
    overlapEpoch = 0;
  let pinned: string | undefined;
  let groups: Iterator<ClinicalSourceScopeGroup> | undefined;
  let initialized = false;
  const fail = (): never => {
    throw Error('Clinical source scope prefix authority changed');
  };
  const current = () => {
    input.assertOpen();
    if (closed) return fail();
    const state = input.proof();
    if (pinned !== undefined && state !== pinned) return fail();
    return state;
  };
  const version = function* (group: ClinicalSourceScopeGroup) {
    return input.scope.versionWork
      ? yield* input.scope.versionWork(group)
      : input.scope.version(group);
  };
  const original = function* (evaluate: Evaluate): Generator<void, boolean, void> {
    for (const group of input.scope.groups()) {
      yield;
      const selected = yield* version(group);
      if (yield* evaluate(group, selected)) return true;
    }
    return false;
  };
  // The epoch only requests re-verification. It never certifies a SQL change.
  const overlappingOriginal = function* (evaluate: Evaluate): Generator<void, boolean, void> {
    const traversal = original(evaluate);
    try {
      for (;;) {
        let next: IteratorResult<void, boolean>;
        try {
          next = traversal.next();
        } finally {
          overlapEpoch++;
        }
        if (next.done) return next.value;
        yield;
      }
    } finally {
      try {
        traversal.return(false);
      } finally {
        overlapEpoch++;
      }
    }
  };
  const init = () => {
    if (initialized) return;
    input.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      scope TEXT NOT NULL, ordinal INTEGER NOT NULL, header TEXT NOT NULL,
      version TEXT NOT NULL, mac TEXT NOT NULL, PRIMARY KEY(scope,ordinal)
    )`);
    initialized = true;
  };
  const mac = (ordinal: number, header: string, selected: string) => {
    const text = serialize([nonce, ordinal, header, selected]);
    work('hashCalls');
    work('hashedBytes', Buffer.byteLength(text));
    return createHmac('sha256', key).update(text).digest('hex');
  };
  const textBytes = (header: string, version: string, mac: string) =>
    Buffer.byteLength(nonce) +
    Buffer.byteLength(header) +
    Buffer.byteLength(version) +
    Buffer.byteLength(mac);
  let stampStatement: ReturnType<DatabaseSync['prepare']> | undefined;
  const stamp = () => {
    work('clinicalSourceScopePrefixScratchWitnessReads');
    stampStatement ??= input.sql.prepare('SELECT total_changes() AS changes');
    stampStatement.setReadBigInts(true);
    return stampStatement.get()!.changes;
  };
  const rows = () =>
    input.sql
      .prepare(
        `SELECT
    CASE WHEN typeof(scope)='text' AND length(CAST(scope AS BLOB))=36 THEN scope END AS scope,
    CASE WHEN typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 9007199254740991 THEN ordinal END AS ordinal,
    CASE WHEN typeof(header)='text' AND typeof(version)='text'
      AND length(CAST(header AS BLOB))+length(CAST(version AS BLOB))<=?
      THEN header END AS header,
    CASE WHEN typeof(header)='text' AND typeof(version)='text'
      AND length(CAST(header AS BLOB))+length(CAST(version AS BLOB))<=?
      THEN version END AS version,
    CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac END AS mac
    FROM ${TABLE} WHERE scope=? ORDER BY ordinal`,
      )
      .iterate(rowBytes, rowBytes, nonce);
  const decoded = (row: Record<string, unknown>, ordinal: number) => {
    work('clinicalSourceScopePrefixRowsRead');
    if (
      typeof row.header === 'string' &&
      typeof row.version === 'string' &&
      typeof row.mac === 'string'
    )
      work('clinicalSourceScopePrefixTextBytesRead', textBytes(row.header, row.version, row.mac));
    if (
      row.scope !== nonce ||
      row.ordinal !== ordinal ||
      typeof row.header !== 'string' ||
      typeof row.version !== 'string' ||
      typeof row.mac !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.mac) ||
      Buffer.byteLength(row.header) + Buffer.byteLength(row.version) > rowBytes ||
      !timingSafeEqual(
        Buffer.from(row.mac, 'hex'),
        Buffer.from(mac(ordinal, row.header, row.version), 'hex'),
      )
    )
      return fail();
    return { header: row.header, version: row.version };
  };
  // Pin scratch changes only while verifying: unrelated legitimate evaluation
  // work may use this same owned scratch between complete authenticated passes.
  const authenticate = function* (): Generator<void, void, void> {
    // An overlapping original traversal may write other policy scratch tables.
    // Restart iteratively and require one entire stable authenticated pass;
    // an epoch change alone grants no row, negative lookup or SQL authority.
    for (;;) {
      current();
      const before = stamp(),
        epoch = overlapEpoch;
      let ordinal = 0,
        restart = false;
      for (const row of rows()) {
        if (stamp() !== before) {
          if (overlapEpoch === epoch) fail();
          restart = true;
          break;
        }
        decoded(row, ordinal++);
        yield;
        if (closed) fail();
        if (stamp() !== before) {
          if (overlapEpoch === epoch) fail();
          restart = true;
          break;
        }
      }
      if (restart) continue;
      if (ordinal !== frontier || stamp() !== before) fail();
      current();
      return;
    }
  };
  const recheckScratch = function* (checked: {
    stamp: unknown;
    epoch: number;
  }): Generator<void, void, void> {
    if (closed) fail();
    if (stamp() === checked.stamp) return;
    if (overlapEpoch === checked.epoch) fail();
    yield* authenticate();
    checked.stamp = stamp();
    checked.epoch = overlapEpoch;
  };
  const signature = (selected: ClinicalSourceScopeVersion | undefined) =>
    serialize(selected ? { present: true, id: selected.id } : { present: false });
  const close = () => {
    if (closed) return;
    closed = true;
    key.fill(0);
    groups?.return?.();
    groups = undefined;
  };
  return {
    close,
    *some(
      boundary: ClinicalSourceScopeBoundary,
      evaluate: Evaluate,
    ): Generator<void, boolean, void> {
      let returned = false,
        ownsPrefix = false;
      const overlapping = busy;
      try {
        input.assertOpen();
        if (closed) fail();
        const admission = input.proof();
        if (pinned !== undefined && admission !== pinned) fail();
        // An interleaved handle keeps its independent original traversal. It
        // cannot advance, release or cancel another call's shared prefix work.
        if (overlapping) {
          const result = yield* overlappingOriginal(evaluate);
          current();
          returned = true;
          return result;
        }
        busy = true;
        ownsPrefix = true;
        if (admission === undefined || disabled) {
          const result = yield* original(evaluate);
          if (pinned !== undefined) current();
          else input.assertOpen();
          returned = true;
          return result;
        }
        if (pinned === undefined) pinned = admission;
        current();
        init();
        yield* authenticate();
        let ordinal = 0;
        const checked = { stamp: stamp(), epoch: overlapEpoch };
        for (const row of rows()) {
          yield* recheckScratch(checked);
          const retained = decoded(row, ordinal++);
          work('jsonParseCalls');
          work('jsonParseBytes', Buffer.byteLength(retained.header));
          const header = parseLiteralJSON(retained.header) as ClinicalSourceScopeGroup;
          if (retained.version !== '{"present":false}' && boundaryMatches(header, boundary)) {
            current();
            work('clinicalSourceScopePrefixMatchedGroups');
            const group = input.groupAt(ordinal - 1),
              selected = yield* version(group);
            if (serialize(group) !== retained.header || signature(selected) !== retained.version)
              fail();
            current();
            if (yield* evaluate(group, selected)) {
              yield* authenticate();
              current();
              returned = true;
              return true;
            }
            // Evaluation may write separate scratch policy rows. Verify the
            // complete signed prefix before continuing instead of crediting SQL.
            yield* authenticate();
            checked.stamp = stamp();
            checked.epoch = overlapEpoch;
          }
          yield;
          yield* recheckScratch(checked);
        }
        if (ordinal !== frontier) fail();
        yield* authenticate();
        while (!complete) {
          current();
          groups ??= input.scope.groups()[Symbol.iterator]();
          const next = groups.next();
          if (next.done) {
            complete = true;
            break;
          }
          const group = next.value,
            selected = yield* version(group);
          work('clinicalSourceScopePrefixVerifiedGroups');
          current();
          const header = serialize(group);
          const selectedSignature = signature(selected);
          if (Buffer.byteLength(header) + Buffer.byteLength(selectedSignature) > rowBytes) {
            disabled = true;
            groups.return?.();
            groups = undefined;
            const result = yield* original(evaluate);
            current();
            returned = true;
            return result;
          }
          const seal = mac(frontier, header, selectedSignature);
          input.sql
            .prepare(`INSERT INTO ${TABLE} VALUES (?,?,?,?,?)`)
            .run(nonce, frontier, header, selectedSignature, seal);
          work(
            'clinicalSourceScopePrefixTextBytesWritten',
            textBytes(header, selectedSignature, seal),
          );
          frontier++;
          yield;
          current();
          if (selected && boundaryMatches(group, boundary) && (yield* evaluate(group, selected))) {
            yield* authenticate();
            current();
            returned = true;
            return true;
          }
        }
        yield* authenticate();
        current();
        returned = true;
        return false;
      } finally {
        if (ownsPrefix) busy = false;
        if (!returned && !overlapping) close();
      }
    },
  };
}
