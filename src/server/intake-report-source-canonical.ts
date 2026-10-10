/** Exact legacy logical confirmation hashing across native owned extension references. */
import { createHash } from 'node:crypto';
import type { Database } from './database.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
} from './intake-report-snapshot-catalog.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import { withIntakeWork, recordIntakeWork } from './intake-work-accounting.ts';
function small(
  parsed: PreparedIntakeJsonCanonical,
  parent: IntakeJsonCanonicalHandle,
  name: string,
): unknown {
  const child = parsed.field(parent, name);
  if (!child) return undefined;
  let value = '';
  for (const piece of parsed.pieces(child)) {
    if (Buffer.byteLength(value) + Buffer.byteLength(piece) > 65536)
      throw Error('Invalid native source extension descriptor');
    value += piece;
  }
  return JSON.parse(value) as unknown;
}
function isNativeExtension(
  parsed: PreparedIntakeJsonCanonical,
  handle: IntakeJsonCanonicalHandle,
  original = false,
) {
  const field = parsed.field(handle, 'format'),
    members = parsed.field(handle, 'members');
  if (!field || parsed.kind(field) !== 'string' || !members || parsed.kind(members) !== 'object')
    return false;
  const expected = JSON.stringify(
    original
      ? 'health-intake-report-source-confirmation-v2'
      : 'health-intake-report-source-extension-v2',
  );
  let at = 0;
  for (const piece of parsed.pieces(field)) {
    if (piece !== expected.slice(at, at + piece.length)) return false;
    at += piece.length;
  }
  return at === expected.length;
}
function* rows(map: ReportSnapshotMapReader, prefix: string) {
  let after = prefix;
  do {
    const page = map.range({ after, items: 64, bytes: 128 * 1024 });
    for (const item of page.items) {
      if (!item.key.startsWith(prefix)) return;
      yield item;
    }
    if (page.complete) return;
    if (!page.after || page.after === after)
      throw Error('Source confirmation snapshot did not advance');
    after = page.after;
  } while (true);
}
function checkedSnapshot(
  catalog: ReportSnapshotCatalog,
  parsed: PreparedIntakeJsonCanonical,
  reference: IntakeJsonCanonicalHandle,
  operationId: unknown,
  groupVersionId: unknown,
  kind: 'members' | 'coverage',
) {
  const snapshotId = small(parsed, reference, 'snapshotId'),
    count = small(parsed, reference, kind === 'members' ? 'memberCount' : 'entryCount'),
    format = small(parsed, reference, 'format');
  if (
    typeof snapshotId !== 'string' ||
    !Number.isSafeInteger(count) ||
    (count as number) < 0 ||
    format !==
      (kind === 'members'
        ? 'health-intake-report-source-members-v1'
        : 'health-intake-report-source-coverage-v1')
  )
    throw Error('Invalid source extension reference');
  const root = catalog.open(snapshotId),
    raw = root?.get('meta');
  if (typeof raw !== 'string') throw Error('Missing selected source extension snapshot');
  const meta = JSON.parse(raw) as Record<string, unknown>;
  if (
    meta.format !== 'health-intake-report-source-extension-snapshot-v1' ||
    meta.operationId !== operationId ||
    meta.groupVersionId !== groupVersionId ||
    meta[kind === 'members' ? 'memberCount' : 'coverageEntryCount'] !== count
  )
    throw Error('Source extension reference binding mismatch');
  const map = root!.reference(kind);
  if (!map) throw Error('Incomplete source extension snapshot');
  return { map, count: count as number };
}
export async function hashCanonicalReportSourceConfirmation(
  db: Database | undefined,
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  catalog: ReportSnapshotCatalog,
): Promise<string> {
  const parsed = await prepareIntakeJsonCanonical(view.recordChunks(record), {
    assertRunning: catalog.assertCurrent,
    onWork: db ? intakeJsonCanonicalWorkObserver(db, 'warm') : undefined,
  });
  try {
    if (parsed.kind(parsed.root) !== 'object') throw Error('Invalid source confirmation');
    const operationId = small(parsed, parsed.root, 'operationId');
    function* extension(handle: IntakeJsonCanonicalHandle, original = false): Generator<string> {
      if (parsed.kind(handle) !== 'object' || !isNativeExtension(parsed, handle, original)) {
        yield* parsed.pieces(handle);
        return;
      }
      const version = small(parsed, handle, 'groupVersionId');
      let first = true;
      yield '{';
      for (const field of parsed.objectFields(handle)) {
        if (field.matches('format')) continue;
        if (!first) yield ',';
        first = false;
        yield* field.name();
        yield ':';
        if (original && field.matches('extensions')) {
          if (parsed.kind(field.value) !== 'array')
            throw Error('Invalid source extension sequence');
          yield '[';
          let initial = true;
          for (const item of parsed.arrayItems(field.value)) {
            if (!initial) yield ',';
            initial = false;
            yield* extension(item);
          }
          yield ']';
          continue;
        }
        const kind = field.matches('members')
          ? 'members'
          : field.matches('coverageEntries')
            ? 'coverage'
            : undefined;
        if (!kind) {
          yield* parsed.pieces(field.value);
          continue;
        }
        const { map, count } = checkedSnapshot(
          catalog,
          parsed,
          field.value,
          operationId,
          version,
          kind,
        );
        let seen = 0;
        yield '[';
        for (const row of rows(map, kind === 'members' ? 'm:' : 'e:')) {
          catalog.assertCurrent();
          if (seen++) yield ',';
          yield* map.chunks(row.key);
        }
        if (seen !== count) throw Error('Source extension reference count mismatch');
        yield ']';
      }
      yield '}';
    }
    function* confirmation(): Generator<string> {
      if (isNativeExtension(parsed, parsed.root, true)) {
        yield* extension(parsed.root, true);
        return;
      }
      let first = true;
      yield '{';
      for (const field of parsed.objectFields(parsed.root)) {
        if (!first) yield ',';
        first = false;
        yield* field.name();
        yield ':';
        if (!field.matches('extensions')) {
          yield* parsed.pieces(field.value);
          continue;
        }
        if (parsed.kind(field.value) !== 'array')
          throw Error('Invalid confirmation extension collection');
        yield '[';
        let initial = true;
        for (const item of parsed.arrayItems(field.value)) {
          if (!initial) yield ',';
          initial = false;
          yield* extension(item);
        }
        yield ']';
      }
      yield '}';
    }
    const hash = createHash('sha256');
    if (db) withIntakeWork(db, 'warm', () => recordIntakeWork('hashCalls'));
    for (const piece of confirmation()) {
      catalog.assertCurrent();
      if (db)
        withIntakeWork(db, 'warm', () => recordIntakeWork('hashedBytes', Buffer.byteLength(piece)));
      hash.update(piece);
    }
    return hash.digest('hex');
  } finally {
    parsed.close();
  }
}
