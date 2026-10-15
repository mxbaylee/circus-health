/** Changed-key publication over authenticated snapshot maps. The disposable key
 * index is checked against a producer-owned seal; it never certifies evidence. */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { identityUtf8Chunks } from './intake-identity-commitment.ts';
import {
  reportSnapshotInlineTextFits,
  type ReportSnapshotMapReader,
  type ReportSnapshotMapWriter,
} from './intake-report-snapshot-catalog.ts';
import { recordIntakeWork, withIntakeWork, type IntakeHostWork } from './intake-work-accounting.ts';

type Desired = { ordinal: number; key: string; size: number; digest: string };
const tuple = ({ ordinal, key, size, digest }: Desired) =>
  JSON.stringify([ordinal, key, size, digest]) + '\n';
const invalid = (): never => {
  throw Error('Identity snapshot desired-key index changed');
};
export interface IdentitySnapshotDeltaCertificate {
  readonly format: 'health-intake-identity-delta-certificate-v1';
  readonly count: number;
  readonly sha256: string;
}
const certificates = new WeakMap<ReportSnapshotMapReader, IdentitySnapshotDeltaCertificate>();

/** Intrinsic receipt of exact certification on an immutable catalog reader.
 * Mutable writers may be validated but cannot obtain an alias certificate. */
export function identitySnapshotDeltaCertificate(reader: ReportSnapshotMapReader) {
  const mutable = reader as Partial<ReportSnapshotMapWriter>;
  if (
    typeof mutable.put === 'function' ||
    typeof mutable.delete === 'function' ||
    typeof mutable.putText === 'function'
  )
    throw Error('Mutable identity snapshot cannot certify an alias');
  const certificate = certificates.get(reader);
  if (!certificate) throw Error('Identity snapshot namespace was not certified');
  reader.assertCurrent();
  return certificate;
}

const keyValid = (key: string) => /^[\x20-\x7e]{1,4096}$/.test(key);

/** Normalize Unicode before slicing, without retaining a whole streamed value. */
function* pieces(chunks: Iterable<string>) {
  for (const piece of identityUtf8Chunks(chunks))
    for (let at = 0; at < piece.length;) {
      let end = Math.min(at + 1024, piece.length);
      if (end < piece.length && /[\uD800-\uDBFF]/.test(piece[end - 1]!)) end--;
      yield piece.slice(at, end);
      at = end;
    }
}

export interface IdentitySnapshotDelta {
  put(key: string, value: string): Promise<void>;
  /** The factory must reproduce the same bytes. Both passes are checked. */
  putText(key: string, chunks: () => Iterable<string>): Promise<void>;
  /** Flush before reading newly generated rows through the writer. */
  flush(): Promise<void>;
  finishCleanup(): Promise<void>;
  /** Exact entire namespace, including absence of any obsolete derived keys. */
  certify(reader: ReportSnapshotMapReader): Promise<void>;
  close(): void;
}

export function createIdentitySnapshotDelta(input: {
  db: DatabaseSync;
  writer: ReportSnapshotMapWriter;
  onChanged?: (key: string, bytes: number) => void;
}): IdentitySnapshotDelta {
  const scratch = disposableSqlite('fictional-identity-delta-');
  try {
    return configureIdentitySnapshotDelta(input, scratch);
  } catch (error) {
    scratch.close();
    throw error;
  }
}

function configureIdentitySnapshotDelta(
  input: Parameters<typeof createIdentitySnapshotDelta>[0],
  scratch: ReturnType<typeof disposableSqlite>,
): IdentitySnapshotDelta {
  const { db, writer } = input,
    sql = scratch.db,
    path = String(sql.prepare('PRAGMA database_list').get()!.file);
  let fileIdentity: string | undefined;
  const physical = () => {
    if (realpathSync(path) !== path) return invalid();
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) return invalid();
    const identity = [stat.dev, stat.ino].join(':');
    if (fileIdentity !== undefined && identity !== fileIdentity) return invalid();
    fileIdentity = identity;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  sql.exec(
    'CREATE TABLE desired(ordinal INTEGER NOT NULL UNIQUE,key TEXT PRIMARY KEY,size INTEGER NOT NULL,digest TEXT NOT NULL)',
  );
  const stamp = sql.prepare(
      'SELECT total_changes() AS changes,(SELECT data_version FROM pragma_data_version) AS external,(SELECT schema_version FROM pragma_schema_version) AS schema',
    ),
    tempSchema = sql.prepare('PRAGMA temp.schema_version'),
    expectedTempSchema = String(tempSchema.get()!.schema_version),
    rawStamp = () => JSON.stringify(stamp.get()) + ':' + String(tempSchema.get()!.schema_version),
    insert = sql.prepare('INSERT INTO main.desired VALUES(?,?,?,?)'),
    projection = `CASE WHEN typeof(ordinal)='integer' AND ordinal BETWEEN 0 AND 9007199254740991 THEN ordinal ELSE NULL END AS ordinal,
      CASE WHEN typeof(key)='text' AND length(CAST(key AS BLOB)) BETWEEN 1 AND 4096 AND instr(key,char(0))=0 AND key NOT GLOB '*[^ -~]*' THEN key ELSE NULL END AS key,
      CASE WHEN typeof(size)='integer' AND size BETWEEN 0 AND 9007199254740991 THEN size ELSE NULL END AS size,
      CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 AND digest NOT GLOB '*[^0-9a-f]*' THEN digest ELSE NULL END AS digest`,
    lookup = sql.prepare('SELECT ' + projection + ' FROM main.desired WHERE key=?'),
    ordered = sql.prepare('SELECT ' + projection + ' FROM main.desired ORDER BY ordinal');
  let expectedStamp = rawStamp(),
    expectedPhysical = physical(),
    count = 0,
    desiredRowsSinceYield = 0,
    expectedSeal: string | undefined,
    closed = false,
    cleaned = false,
    pending: { key: string; value: string }[] = [],
    pendingBytes = 0;
  const generatedSeal = createHash('sha256');
  const record = (metric: keyof IntakeHostWork, amount = 1) =>
    withIntakeWork(db, 'warm', () => recordIntakeWork(metric, amount));
  const guard = () => {
    if (
      closed ||
      sql.isTransaction ||
      rawStamp() !== expectedStamp ||
      physical() !== expectedPhysical
    )
      invalid();
    writer.assertCurrent();
    if (physical() !== expectedPhysical || rawStamp() !== expectedStamp) invalid();
  };
  const flush = async () => {
    guard();
    if (pending.length) await writer.putMany(pending);
    pending = [];
    pendingBytes = 0;
    guard();
  };
  const hashText = async (chunks: Iterable<string>, read: boolean) => {
    const hash = createHash('sha256');
    let size = 0,
      steps = 0;
    for (const piece of pieces(chunks)) {
      const bytes = Buffer.byteLength(piece);
      hash.update(piece);
      size += bytes;
      if (!Number.isSafeInteger(size)) throw Error('Identity snapshot value exceeds safe size');
      record('identitySnapshotDeltaHashBytes', bytes);
      if (read) record('identitySnapshotDeltaReadBytes', bytes);
      if (++steps === 64) {
        guard();
        await setImmediate();
        guard();
        steps = 0;
      }
    }
    return { size, digest: hash.digest('hex') };
  };
  const desiredRow = (raw: Record<string, unknown>): Desired => {
    const row = {
      ordinal: raw.ordinal,
      key: raw.key,
      size: raw.size,
      digest: raw.digest,
    };
    if (
      typeof row.ordinal !== 'number' ||
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal < 0 ||
      typeof row.key !== 'string' ||
      !keyValid(row.key) ||
      typeof row.size !== 'number' ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      typeof row.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.digest)
    )
      invalid();
    const value = row as Desired;
    record('identitySnapshotDeltaScratchReadBytes', Buffer.byteLength(tuple(value)));
    return value;
  };
  const checkSeal = async () => {
    guard();
    if (!expectedSeal) invalid();
    const hash = createHash('sha256');
    let ordinal = 0;
    for (const raw of ordered.iterate()) {
      guard();
      const row = desiredRow(raw);
      if (row.ordinal !== ordinal++) invalid();
      const text = tuple(row);
      hash.update(text);
      record('identitySnapshotDeltaHashBytes', Buffer.byteLength(text));
      if (ordinal % 16 === 0) {
        await setImmediate();
        guard();
      }
    }
    if (ordinal !== count || hash.digest('hex') !== expectedSeal) invalid();
    guard();
  };
  const putText = async (key: string, chunks: () => Iterable<string>) => {
    guard();
    if (++desiredRowsSinceYield === 16) {
      await setImmediate();
      desiredRowsSinceYield = 0;
      guard();
    }
    certificates.delete(writer);
    if (cleaned || expectedSeal || !keyValid(key))
      throw Error('Invalid desired identity snapshot key');
    const value = await hashText(chunks(), false),
      row: Desired = { ordinal: count, key, ...value },
      text = tuple(row);
    guard();
    const duplicate = lookup.get(key);
    if (duplicate) {
      const original = desiredRow(duplicate);
      record('identitySnapshotDeltaComparedRows');
      if (original.size !== row.size || original.digest !== row.digest)
        throw Error('Conflicting desired identity snapshot key');
      return;
    }
    const before = stamp.get()!;
    if (
      JSON.stringify(before) + ':' + expectedTempSchema !== expectedStamp ||
      physical() !== expectedPhysical
    )
      invalid();
    insert.run(row.ordinal, key, row.size, row.digest);
    const after = stamp.get()!;
    if (
      Number(after.changes) !== Number(before.changes) + 1 ||
      after.external !== before.external ||
      after.schema !== before.schema
    )
      invalid();
    // Only this synchronous insertion can advance the owned SQLite witness.
    expectedStamp = JSON.stringify(after) + ':' + expectedTempSchema;
    expectedPhysical = physical();
    generatedSeal.update(text);
    record('identitySnapshotDeltaHashBytes', Buffer.byteLength(text));
    record('identitySnapshotDeltaScratchWrittenBytes', Buffer.byteLength(text));
    record('identitySnapshotDeltaDesiredRows');
    record('identitySnapshotDeltaDesiredBytes', value.size);
    count++;
    record('identitySnapshotDeltaComparedRows');
    if (writer.get(key) !== undefined) {
      const actual = await hashText(writer.chunks(key), true);
      if (actual.size === value.size && actual.digest === value.digest) return;
    }
    const publishedHash = createHash('sha256'),
      prefix: string[] = [],
      iterator = pieces(chunks())[Symbol.iterator]();
    let size = 0,
      finished = false;
    const nextPiece = () => {
      const next = iterator.next();
      if (!next.done) {
        size += Buffer.byteLength(next.value);
        publishedHash.update(next.value);
        record('identitySnapshotDeltaHashBytes', Buffer.byteLength(next.value));
      }
      return next;
    };
    while (size <= 16 * 1024) {
      const next = nextPiece();
      if (next.done) {
        finished = true;
        break;
      }
      prefix.push(next.value);
    }
    const checkPublished = () => {
      if (size !== value.size || publishedHash.digest('hex') !== value.digest)
        throw Error('Desired identity snapshot bytes changed during publication');
    };
    if (finished && reportSnapshotInlineTextFits(prefix.join(''))) {
      checkPublished();
      const value = prefix.join(''),
        cost = Buffer.byteLength(key) + size;
      if (pending.length && (pending.length === 64 || pendingBytes + cost > 64 * 1024))
        await flush();
      pending.push({ key, value });
      pendingBytes += cost;
    } else {
      await flush();
      await writer.putText(
        key,
        (function* () {
          yield* prefix;
          for (;;) {
            const next = nextPiece();
            if (next.done) break;
            yield next.value;
          }
          checkPublished();
        })(),
      );
    }
    record('identitySnapshotDeltaChangedRows');
    record('identitySnapshotDeltaWrittenBytes', value.size);
    input.onChanged?.(key, value.size);
    guard();
  };
  const pages = async (
    reader: ReportSnapshotMapReader,
    visit: (key: string) => Promise<void>,
    expectedCount?: number,
  ) => {
    let after: string | undefined;
    for (;;) {
      guard();
      reader.assertCurrent();
      const page = reader.range({ after, items: 16, bytes: 64 * 1024 });
      if (
        page.items.length > 16 ||
        !Number.isSafeInteger(page.count) ||
        page.count < 0 ||
        (expectedCount !== undefined && page.count !== expectedCount) ||
        page.bytes < 0 ||
        page.bytes > 64 * 1024 ||
        (!page.complete && !page.items.length) ||
        (page.complete && page.after !== null)
      )
        throw Error('Invalid identity snapshot namespace page');
      let previous = after;
      for (const item of page.items) {
        if (!keyValid(item.key) || (previous !== undefined && item.key <= previous))
          throw Error('Invalid identity snapshot namespace ordering');
        await visit(item.key);
        previous = item.key;
      }
      guard();
      reader.assertCurrent();
      if (page.complete) return;
      if (page.after !== previous || page.after === after)
        throw Error('Identity snapshot namespace did not advance');
      after = page.after!;
      await setImmediate();
    }
  };
  return {
    put: (key, value) => putText(key, () => [value]),
    putText,
    flush,
    async finishCleanup() {
      if (cleaned) throw Error('Identity snapshot delta already finished');
      await flush();
      expectedSeal = generatedSeal.digest('hex');
      await checkSeal();
      await pages(writer, async (key) => {
        guard();
        const row = lookup.get(key);
        if (row) desiredRow(row);
        else {
          await writer.delete(key);
          record('identitySnapshotDeltaDeletedRows');
          guard();
        }
      });
      await checkSeal();
      cleaned = true;
    },
    async certify(reader) {
      if (!cleaned) throw Error('Identity snapshot delta is not finished');
      await checkSeal();
      certificates.delete(reader);
      const namespaceHash = createHash('sha256');
      let found = 0;
      await pages(
        reader,
        async (key) => {
          guard();
          const raw = lookup.get(key);
          if (!raw) throw Error('Unexpected retained identity snapshot key');
          const expected = desiredRow(raw),
            actual = await hashText(reader.chunks(key), true);
          if (expected.size !== actual.size || expected.digest !== actual.digest)
            throw Error('Retained identity snapshot bytes changed');
          const namespaceTuple = JSON.stringify([key, actual.size, actual.digest]) + '\n';
          namespaceHash.update(namespaceTuple);
          record('identitySnapshotDeltaHashBytes', Buffer.byteLength(namespaceTuple));
          found++;
          record('identitySnapshotDeltaCertifiedRows');
        },
        count,
      );
      if (found !== count) throw Error('Retained identity snapshot keys are missing');
      await checkSeal();
      reader.assertCurrent();
      if (
        typeof (reader as Partial<ReportSnapshotMapWriter>).put === 'function' ||
        typeof (reader as Partial<ReportSnapshotMapWriter>).delete === 'function' ||
        typeof (reader as Partial<ReportSnapshotMapWriter>).putText === 'function'
      )
        return;
      certificates.set(
        reader,
        Object.freeze({
          format: 'health-intake-identity-delta-certificate-v1',
          count,
          sha256: namespaceHash.digest('hex'),
        }),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      scratch.close();
    },
  };
}
