import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSourceResolutionIndex,
  readSourceResolutionIndex,
} from '../intake-report-source-resolution-index.ts';
import type {
  ReportSnapshotCatalog,
  ReportSnapshotMapReader,
  ReportSnapshotMapWriter,
} from '../intake-report-snapshot-catalog.ts';
import { schemaKey, schemaOrdinal } from '../intake-envelope-schema.ts';
import { openDatabase } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeCollectionEnvelopeReader } from '../intake-collection-envelope.ts';
import { prepareLegacyReportSourceState } from '../intake-report-source-state.ts';
import { setImmediate } from 'node:timers';
import { createHash } from 'node:crypto';
import { canonicalLiteral } from '../intake-format.ts';
import { prepareReportSourceExtension } from '../intake-report-source-state.ts';
import type { ReportSourceExtensionInput } from '../intake-collection-report-source.ts';

function fixture() {
  type Value = string | ReportSnapshotMapReader;
  const maps = new WeakMap<ReportSnapshotMapReader, Map<string, Value>>();
  const published = new Map<string, ReportSnapshotMapReader>();
  let forks = 0,
    active = true;
  const check = () => assert.ok(active, 'selected authority changed');
  const reader = (values: Map<string, Value>): ReportSnapshotMapReader => {
    const result = {
      assertCurrent: check,
      get(key: string) {
        check();
        const value = values.get(key);
        return typeof value === 'string' ? value : undefined;
      },
      reference(key: string) {
        check();
        const value = values.get(key);
        return typeof value === 'object' ? value : undefined;
      },
      range({ after, items }: { after?: string; items: number }) {
        check();
        const all = [...values.entries()]
          .filter(([key]) => !after || key > after)
          .sort(([a], [b]) => a.localeCompare(b));
        const selected = all.slice(0, items);
        return {
          items: selected.map(([key, value]) => ({ key, value })),
          complete: selected.length === all.length,
          after: selected.at(-1)?.[0] ?? null,
        };
      },
      preceding(before: string) {
        check();
        const key = [...values.keys()]
          .filter((key) => key < before)
          .sort()
          .at(-1);
        if (!key) return undefined;
        return { key, value: values.get(key) as string };
      },
    } as ReportSnapshotMapReader;
    maps.set(result, values);
    return result;
  };
  const fork = async (old?: ReportSnapshotMapReader): Promise<ReportSnapshotMapWriter> => {
    check();
    forks++;
    const values = new Map(old ? maps.get(old)! : []),
      result = reader(values) as ReportSnapshotMapWriter;
    result.put = async (key, value) => {
      check();
      values.set(key, value);
    };
    result.delete = async (key) => {
      check();
      values.delete(key);
    };
    result.attach = async (key, child) => {
      check();
      values.set(key, reader(new Map(maps.get(child)!)));
    };
    result.putMany = async (entries, references = []) => {
      check();
      for (const { key, value } of entries) values.set(key, value);
      for (const { key, child } of references) values.set(key, reader(new Map(maps.get(child)!)));
    };
    return result;
  };
  return {
    catalog: {
      fork: () => fork(),
      forkReference: fork,
      assertCurrent: check,
      open: (id: string) => published.get(id),
      publish: async (id: string, map: ReportSnapshotMapWriter) => {
        check();
        published.set(id, reader(new Map(maps.get(map)!)));
      },
    } as ReportSnapshotCatalog,
    forks: () => forks,
    invalidate: () => {
      active = false;
    },
  };
}

test('retained source intersection admits cancellation even when every member is unchanged', async () => {
  const f = fixture(),
    total = 130,
    scope = {
      kind: 'anchored_report',
      reportFingerprint: 'a'.repeat(64),
      contextFingerprint: null,
    },
    header = {
      operationId: 'fictional-op',
      groupId: 'g',
      groupVersionId: 'old',
      contextId: 'old',
      source: 'Fictional source',
      sourceProviderId: 'fictional-p',
      at: '2026-01-01',
      basis: 'manual_report_label',
      scope,
    },
    record = { ...header, members: [], coverageEntries: [], extensions: [] },
    old = await f.catalog.fork(),
    latest = await f.catalog.fork(),
    resolution = await createSourceResolutionIndex(f.catalog);
  for (let ordinal = 0; ordinal < total; ordinal++)
    await latest.put(
      'm:' + schemaOrdinal(ordinal),
      JSON.stringify({ candidateId: 'fictional-' + ordinal, candidateVersionId: 'v1' }),
    );
  for (const key of [
    'coveredMembers',
    'coveredOccurrences',
    'extensions',
    'authorities',
    'latestMemberLookup',
  ])
    await old.attach(key, await f.catalog.fork());
  await old.attach('latestMembers', latest);
  await old.attach('resolution', await resolution.finish());
  await old.put(
    'meta',
    JSON.stringify({
      format: 'health-intake-report-source-state-v1',
      operationId: header.operationId,
      recordAddress: 'fictional-address',
      headerHash: createHash('sha256').update(canonicalLiteral(header)).digest('hex'),
      memberCount: 0,
      coverageCount: 0,
      extensionCount: 0,
    }),
  );
  await f.catalog.publish('fictional-state', old);
  type Row = Record<string, unknown>;
  const view = {
    field: (row: Row, name: string) =>
      name in row ? { kind: 'value', value: row[name] } : { kind: 'missing' },
    child: (row: Row, name: string) => (typeof row[name] === 'object' ? row[name] : undefined),
    info: (row: Row) => ({ shape: 'object', count: Object.keys(row).length }),
    has: (row: Row, name: string) => name in row,
    address: () => 'fictional-address',
    childCount: (row: Row, name: string) => ((row[name] ?? []) as unknown[]).length,
  } as unknown as IntakeCollectionEnvelopeReader;
  let reads = 0,
    atAbort = -1;
  const member = (ordinal: number) => ({
    candidateId: 'fictional-' + ordinal,
    candidateVersionId: 'v1',
    ordinal,
    key: String(ordinal),
    occurrenceCount: 0,
    sectionPresent: false,
  });
  const input = {
    group: {
      format: 'health-intake-report-source-group-authority-v1',
      id: 'g',
      scope: () => scope,
      reference: () => ({}),
    },
    version: { id: 'new', createdAt: '2026-01-02' },
    assertCurrent: f.catalog.assertCurrent,
    contributed: () => true,
    pendingUnaccepted: () => true,
    current: {
      memberAt(ordinal: number) {
        if (++reads === 2)
          setImmediate(() => {
            atAbort = reads;
            f.invalidate();
          });
        return member(ordinal);
      },
      member: () => undefined,
      members({ after, items }: { after?: string; items: number }) {
        const start = Number(after ?? 0),
          end = Math.min(total, start + items);
        return {
          members: Array.from({ length: end - start }, (_, at) => member(start + at)),
          complete: end === total,
          after: String(end),
        };
      },
    },
  } as unknown as Omit<ReportSourceExtensionInput, 'confirmation'>;
  await assert.rejects(
    prepareReportSourceExtension(
      f.catalog,
      view,
      record as never,
      {
        format: 'health-intake-report-source-state-v1',
        snapshotId: 'fictional-state',
        operationId: header.operationId,
        recordAddress: 'fictional-address',
      },
      input,
    ),
    /selected authority changed/,
  );
  assert.ok(atAbort > 0 && atAbort <= 64, `first host turn consumed ${atAbort} retained members`);
  assert.equal(reads, atAbort, 'cancellation consumes no further retained members');
});

test('consecutive source extensions reuse one writer without dropping empty history', async () => {
  const f = fixture(),
    index = await createSourceResolutionIndex(f.catalog),
    member = { candidateId: 'fictional', candidateVersionId: 'fictional-v1' },
    matching = await f.catalog.fork(),
    empty = await f.catalog.fork();
  await matching.put('m:' + schemaKey(member.candidateId, member.candidateVersionId), '1');
  const before = f.forks(),
    target = (ordinal: number, groupVersionId = 'group-v1') => ({
      id: 'extension-' + ordinal,
      groupVersionId,
      contextId: 'context-' + ordinal,
      ordinal,
    });
  await index.extension(target(0), matching);
  for (let ordinal = 1; ordinal <= 97; ordinal++) await index.extension(target(ordinal), empty);
  assert.equal(f.forks() - before, 1, 'one writer, not one fork per retained extension');
  const current = index.map.reference('v:' + schemaKey('group-v1'))!;
  for (let ordinal = 0; ordinal <= 97; ordinal++) {
    assert.deepEqual(
      JSON.parse(current.get('e:' + schemaOrdinal(ordinal)) as string),
      target(ordinal),
    );
    assert.ok(
      current.reference('m:' + schemaOrdinal(ordinal)),
      'even empty membership is retained',
    );
  }
  await index.extension(target(98, 'group-v2'), matching);
  await index.extension(target(99), matching);
  assert.equal(f.forks() - before, 3, 'only the most recent version writer is retained');
  const resolved = readSourceResolutionIndex(await index.finish());
  assert.deepEqual(resolved.extension('group-v1', member), target(99));
  assert.deepEqual(resolved.extension('group-v2', member), target(98, 'group-v2'));
  assert.equal(resolved.extension('group-v1', { ...member, candidateId: 'absent' }), undefined);
  f.invalidate();
  await assert.rejects(index.extension(target(100), empty), /selected authority changed/);
});

test('an all-empty extension suffix preserves the earlier matching extension', async () => {
  const f = fixture(),
    index = await createSourceResolutionIndex(f.catalog),
    member = { candidateId: 'fictional', candidateVersionId: 'fictional-v1' },
    matching = await f.catalog.fork(),
    empty = await f.catalog.fork();
  await matching.put('m:' + schemaKey(member.candidateId, member.candidateVersionId), '1');
  for (let ordinal = 0; ordinal < 65; ordinal++)
    await index.extension(
      { id: 'e' + ordinal, groupVersionId: 'v1', contextId: 'c' + ordinal, ordinal },
      ordinal === 0 ? matching : empty,
    );
  const resolved = readSourceResolutionIndex(await index.finish());
  assert.equal(resolved.extension('v1', member)?.id, 'e0');
});

test('native source index reuses a private version writer with exact immutable prior attachments', async (t) => {
  const db = openDatabase(':memory:', 'fictional');
  memoryRecordAuthority(db);
  t.after(() => db.close());
  const source = { id: 'fictional-source' };
  registerRawIntakeFixture(db, source.id, JSON.stringify({ intake: { version: 1, workflow: {} } }));
  await buildIntakeCollectionEnvelope(db, source);
  const catalog = createReportSnapshotCatalog(db, source),
    index = await createSourceResolutionIndex(catalog),
    lookup = await catalog.fork(),
    member = { candidateId: 'fictional', candidateVersionId: 'fictional-v1' };
  await lookup.put('m:' + schemaKey(member.candidateId, member.candidateVersionId), '1');
  const before = intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges,
    batches = intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches;
  await index.extension({ id: 'e0', groupVersionId: 'v1', contextId: 'c0', ordinal: 0 }, lookup);
  const firstRoot = await catalog.forkReference(index.map.reference('v:' + schemaKey('v1'))!);
  for (let ordinal = 1; ordinal < 8; ordinal++)
    await index.extension(
      { id: 'e' + ordinal, groupVersionId: 'v1', contextId: 'c' + ordinal, ordinal },
      lookup,
    );
  assert.equal(
    intakeWorkCounters(db).warm.reportSnapshotCheckpointChanges - before,
    26,
    '25 extension changes plus one historical version snapshot',
  );
  assert.equal(intakeWorkCounters(db).warm.reportSnapshotCheckpointBatches - batches, 18);
  assert.equal(firstRoot.get('e:' + schemaOrdinal(7)), undefined);
  assert.equal(JSON.parse(firstRoot.get('e:' + schemaOrdinal(0)) as string).id, 'e0');
  await index.extension({ id: 'e8', groupVersionId: 'v2', contextId: 'c8', ordinal: 8 }, lookup);
  await index.extension({ id: 'e9', groupVersionId: 'v1', contextId: 'c9', ordinal: 9 }, lookup);
  const resolved = readSourceResolutionIndex(await index.finish());
  assert.equal(resolved.extension('v1', member)?.id, 'e9');
  assert.equal(resolved.extension('v2', member)?.id, 'e8');
  assert.equal(firstRoot.get('e:' + schemaOrdinal(9)), undefined);
  await assert.rejects(
    lookup.putMany(
      [{ key: 'partial', value: 'must not publish' }],
      [{ key: 'foreign', child: await createReportSnapshotCatalog(db, source).fork() }],
    ),
    /Foreign report snapshot writer/,
  );
  assert.equal(lookup.get('partial'), undefined);
  await assert.rejects(
    lookup.putMany(
      Array.from({ length: 64 }, (_, ordinal) => ({ key: 'bounded-' + ordinal, value: 'value' })),
      [{ key: 'extra', child: index.map }],
    ),
    /bounded change batch/,
  );
  assert.equal(lookup.get('bounded-0'), undefined);
  db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('b'.repeat(64), source.id);
  await assert.rejects(
    index.extension({ id: 'e10', groupVersionId: 'v1', contextId: 'c10', ordinal: 10 }, lookup),
  );
});

test('cold source-state preparation checkpoints duplicate members even when all writes are skipped', async () => {
  const f = fixture(),
    member = { candidateId: 'fictional', candidateVersionId: 'fictional-v1' },
    confirmation = {
      operationId: 'fictional-operation',
      groupId: 'g',
      groupVersionId: 'v',
      contextId: 'c',
      source: 'Fictional source',
      sourceProviderId: 'p',
      at: '2026-01-01',
      members: Array.from({ length: 130 }, () => member),
    };
  let reads = 0,
    atAbort = -1;
  type Row = Record<string, unknown>;
  const view = {
    field(record: Row, name: string) {
      if (record === member && name === 'candidateId' && ++reads === 2)
        setImmediate(() => {
          atAbort = reads;
          f.invalidate();
        });
      return name in record ? { kind: 'value', value: record[name] } : { kind: 'missing' };
    },
    has: (record: Row, name: string) => name in record,
    child: (record: Row, name: string) =>
      typeof record[name] === 'object' ? record[name] : undefined,
    children(record: Row, name: string, options: { after?: string; items: number }) {
      const rows = (record[name] ?? []) as unknown[],
        start = Number(options.after ?? 0),
        end = Math.min(start + options.items, rows.length);
      return { records: rows.slice(start, end), complete: end === rows.length, after: String(end) };
    },
    childCount: (record: Row, name: string) => ((record[name] ?? []) as unknown[]).length,
    address: () => 'fictional-confirmation',
    recordChunks: (record: Row) => [JSON.stringify(record)],
  } as unknown as IntakeCollectionEnvelopeReader;
  await assert.rejects(
    prepareLegacyReportSourceState(f.catalog, view, confirmation as never),
    /selected authority changed/,
  );
  assert.ok(atAbort > 0 && atAbort <= 64, `first host turn consumed ${atAbort} members`);
  assert.equal(reads, atAbort, 'cancellation consumes no further duplicate members');
});
