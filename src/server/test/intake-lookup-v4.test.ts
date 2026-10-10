import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate } from 'node:timers';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, transaction, json } from '../database.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import {
  maximumIntakeDiscoveryOrder,
  retainedIntakeAcceptance,
  indexedIntakeIdentityConfirmations,
  iterateIntakeIdentityReferences,
  readIntakeIdentityReference,
  retainedIntakeAcceptanceReference,
  intakeLookupCounters,
  clearIntakeLookupCache,
  intakeLookupProjectionGeneration,
  nativeIntakeReceiptAppendBasis,
  retainNativeIntakeReceiptAppend,
  nativeIntakeLookupCatalogHeadBindingsEqual,
} from '../intake-lookup-projection.ts';
import {
  openIntakeIdentityReference,
  intakeIdentityTargetMembership,
} from '../intake-identity-reference.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  openIntakeCollectionEnvelope,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeEnvelopeMutation } from '../intake-envelope-mutation.ts';
import { proposalLookupIndexContributions } from '../intake-lookup-proposal.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { ownershipIntakeScopes } from '../ownership-intake-scopes.ts';
import {
  prepareIntakeLookupIndices,
  intakeDiscoveryRevision,
  assertIntakeDiscoveryRevision,
  preparedIntakeLookupReadToken,
  preparedIntakeDiscoveryRevision,
  INTAKE_LOOKUP_INDEX_COLLECTION,
  INTAKE_LOOKUP_INDEX_POLICY,
} from '../intake-lookup-state.ts';

const summaryOptions = { mappingVersion: 'fictional-v1', isSourceContextVersion: () => false };

for (const mode of ['warm', 'cold', 'unprepared'] as const)
  test(`a claimed complete ${mode} native index cannot erase a genuine discovery maximum`, async (t) => {
    const f = await fixture(
      t,
      JSON.stringify({
        intake: {
          version: 0,
          workflow: {
            format: 'health-intake-workflow-v1',
            reportGroups: [{ id: 'fictional-discovery-group', discoveryOrder: 7, versions: [] }],
          },
        },
      }),
    );
    await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
    await prepareIntakeLookupIndices(f.db);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    const view = openIntakeCollectionEnvelope(f.db, f.source),
      collections = selectedEnvelopeStore(f.db, f.source).collections,
      operationId = randomUUID();
    collections.commitMaintenance(
      collections.prepare(collections.openView(), {
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 0,
        changes: [
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'put',
            key: 'complete',
            value: JSON.stringify(view.logical),
          },
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'put',
            key: 'policy',
            value: INTAKE_LOOKUP_INDEX_POLICY,
          },
          {
            area: 'builds',
            collection: INTAKE_LOOKUP_INDEX_COLLECTION,
            op: 'delete',
            key: schemaKey('lookup-discovery-maximum'),
          },
        ],
      }),
    );
    const current = openIntakeCollectionEnvelope(f.db, f.source),
      intake = current.child(current.root(), 'intake')!,
      workflow = current.child(intake, 'workflow')!,
      group = current.childAt(workflow, 'reportGroups', 0)!;
    assert.equal(current.field(group, 'discoveryOrder').kind, 'value');
    assert.equal(JSON.parse([...current.fieldChunks(group, 'discoveryOrder')].join('')), 7);
    if (mode !== 'warm') clearIntakeLookupCache(f.db);
    let answer: number | null;
    try {
      if (mode !== 'unprepared') await prepareIntakeLookupIndices(f.db);
      answer = maximumIntakeDiscoveryOrder(f.db);
    } catch (error) {
      assert.match(
        String(error),
        /lookup.*(?:incomplete|unavailable|changed)|native catalog.*changed|semantic indexes/i,
      );
      return;
    }
    assert.equal(answer, 7, 'A disposable completeness claim cannot supply a false negative');
  });

for (const mode of ['direct', 'fallback'] as const)
  test(`native receipt hydration keeps its original ${mode} earliest-source selection`, async (t) => {
    const receipt = (marker: string) =>
      JSON.stringify({
        intake: {
          version: 0,
          workflow: {
            format: 'health-intake-workflow-v1',
            reportAcceptances: [{ receipt: { operationId: 'fictional-target' }, marker }],
          },
        },
      });
    const f = await fixture(t, receipt('first'));
    registerRawIntakeFixture(f.db, 'fictional-competing-original', receipt('second'));
    await buildIntakeCollectionEnvelope(f.db, { id: 'fictional-competing-original' });
    await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
    await buildVerifiedWorkflowSummary(
      f.db,
      { id: 'fictional-competing-original' },
      summaryOptions,
    );
    if (mode === 'direct') await prepareIntakeLookupIndices(f.db);
    assert.equal(!!preparedIntakeLookupReadToken(f.db), mode === 'direct');
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-target'), {
      receipt: { operationId: 'fictional-target' },
      marker: 'first',
    });
    assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
    const original = StatementSync.prototype.get;
    let changed = false;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(original, this, parameters);
      if (
        !changed &&
        this.sourceSQL ===
          (mode === 'direct'
            ? 'SELECT total_changes() AS count'
            : 'SELECT id,kind,sha256,details_json FROM source_files WHERE id=?') &&
        new Error().stack?.includes('recordChunks')
      ) {
        changed = true;
        transaction(f.db, () =>
          f.db
            .prepare('UPDATE source_files SET rowid=0 WHERE id=?')
            .run('fictional-competing-original'),
        );
      }
      return row;
    } as typeof StatementSync.prototype.get;
    try {
      assert.throws(
        () => retainedIntakeAcceptance(f.db, 'fictional-target'),
        /native catalog frontier changed|projection answer witness changed/,
      );
    } finally {
      StatementSync.prototype.get = original;
    }
    assert.equal(changed, true, 'The competing original must change during payload hydration');
    await prepareIntakeLookupIndices(f.db);
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-target'), {
      receipt: { operationId: 'fictional-target' },
      marker: 'second',
    });
    assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
  });

for (const mode of ['native-only', 'mixed'] as const)
  test(`native fallback maximum refuses a late selected-head change in ${mode} lookup`, async (t) => {
    const f = await fixture(
      t,
      '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":13}]}}}',
    );
    if (mode === 'mixed')
      registerRawIntakeFixture(
        f.db,
        'fictional-legacy-cast',
        '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":11}]}}}',
      );
    await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 13);
    const reader = openIntakeCollectionEnvelope(f.db, f.source);
    const intake = reader.child(reader.root(), 'intake')!;
    const workflow = reader.child(intake, 'workflow')!;
    const group = reader.childAt(workflow, 'reportGroups', 0)!;
    const operationId = randomUUID();
    const mutation = prepareIntakeEnvelopeFieldMutation(f.db, f.source, {
      reader,
      record: group,
      field: 'discoveryOrder',
      jsonText: '23',
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
    });
    const original = StatementSync.prototype.get;
    let changed = false;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(original, this, parameters);
      if (!changed && this.sourceSQL === "SELECT CAST(json_extract(?,'$') AS INTEGER) n") {
        changed = true;
        transaction(f.db, () => stageIntakeEnvelopeFieldMutation(f.db, f.source, mutation));
      }
      return row;
    } as typeof StatementSync.prototype.get;
    try {
      assert.throws(() => maximumIntakeDiscoveryOrder(f.db), /projection answer witness changed/);
    } finally {
      StatementSync.prototype.get = original;
    }
    assert.equal(changed, true);
    await prepareIntakeLookupIndices(f.db);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 23);
  });

for (const count of [1, 8])
  test(`warm lookup preparation reads only changed retained sources among ${count} originals`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-scope-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
    const authority = memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    for (let index = 0; index < count; index++) {
      const id = `fictional-source-${index}`;
      const raw = JSON.stringify({
        intake: {
          version: 0,
          workflow: {
            format: 'health-intake-workflow-v1',
            reportGroups: [{ discoveryOrder: index + 1 }],
            reportAcceptances: [
              { receipt: { operationId: `fictional-acceptance-${index}` }, marker: id },
              { receipt: { operationId: 'fictional-duplicate' }, marker: id },
            ],
          },
        },
      });
      registerRawIntakeFixture(db, id, raw);
      await buildIntakeCollectionEnvelope(db, { id });
      await buildVerifiedWorkflowSummary(db, { id }, summaryOptions);
    }
    // Cold work is outside the measured window. Every source now has a selected,
    // complete lookup policy and unchanged source/collection binding.
    await prepareIntakeLookupIndices(db);
    assert.equal(maximumIntakeDiscoveryOrder(db), count);
    assert.deepEqual(retainedIntakeAcceptance(db, `fictional-acceptance-${count - 1}`), {
      receipt: { operationId: `fictional-acceptance-${count - 1}` },
      marker: `fictional-source-${count - 1}`,
    });
    const beforeWork = { ...intakeWorkCounters(db).warm };
    const beforeLookup = { ...intakeLookupCounters(db) };
    const beforeObjects = authority.objects.size;
    const beforeSequence = recordDurabilityStatus(db)?.sequence;
    const beforeTransactions = Number(
      db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n,
    );

    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalIterate = StatementSync.prototype.iterate;
    const sourceStatements = new WeakSet<StatementSync>();
    let sourceScans = 0;
    let sourceRows = 0;
    let rowsAtFirstTurn = -1;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (
        this === db &&
        sql.includes("FROM source_files WHERE kind='intake_original' ORDER BY rowid")
      ) {
        sourceStatements.add(statement);
        sourceScans++;
      }
      return statement;
    };
    StatementSync.prototype.iterate = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['iterate']>
    ) {
      const iterator = Reflect.apply(originalIterate, this, parameters) as ReturnType<
        StatementSync['iterate']
      >;
      if (!sourceStatements.has(this)) return iterator;
      return (function* () {
        for (const row of iterator) {
          sourceRows++;
          yield row;
        }
      })();
    } as typeof StatementSync.prototype.iterate;
    let result: Awaited<ReturnType<typeof prepareIntakeLookupIndices>>;
    try {
      const firstTurn = new Promise<void>((resolve) =>
        setImmediate(() => {
          rowsAtFirstTurn = sourceRows;
          resolve();
        }),
      );
      result = await prepareIntakeLookupIndices(db);
      await firstTurn;
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
      StatementSync.prototype.iterate = originalIterate;
    }
    const afterWork = { ...intakeWorkCounters(db).warm };
    const afterLookup = { ...intakeLookupCounters(db) };
    t.diagnostic(
      JSON.stringify({
        count,
        sourceScans,
        sourceRows,
        rowsAtFirstTurn,
        reused: result.reused,
        nodeReads: afterWork.collectionNodeReads - beforeWork.collectionNodeReads,
        witnessQueries:
          afterWork.collectionReadWitnessQueries - beforeWork.collectionReadWitnessQueries,
        readBytes: afterWork.collectionReadBytes - beforeWork.collectionReadBytes,
      }),
    );
    assert.equal(result.prepared, 0);
    assert.equal(afterLookup.projectionWrites, beforeLookup.projectionWrites);
    assert.equal(authority.objects.size, beforeObjects);
    assert.equal(recordDurabilityStatus(db)?.sequence, beforeSequence);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n),
      beforeTransactions,
    );
    assert.equal(maximumIntakeDiscoveryOrder(db), count);
    assert.deepEqual(retainedIntakeAcceptance(db, `fictional-acceptance-${count - 1}`), {
      receipt: { operationId: `fictional-acceptance-${count - 1}` },
      marker: `fictional-source-${count - 1}`,
    });
    // One selected lookup must not reread a growing unrelated source catalog.
    // Existing code returns 3 rows for one source and 24 for eight sources.
    assert.ok(sourceRows <= 3, `${sourceRows} warm original rows for ${count} sources`);
    const selected = await countedNativeSourceRead(db, () =>
      retainedIntakeAcceptance(db, 'fictional-duplicate'),
    );
    const late = await countedNativeSourceRead(db, () =>
      retainedIntakeAcceptance(db, `fictional-acceptance-${count - 1}`),
    );
    const missing = await countedNativeSourceRead(db, () =>
      retainedIntakeAcceptance(db, 'fictional-missing'),
    );
    const maximum = await countedNativeSourceRead(db, () => maximumIntakeDiscoveryOrder(db));
    assert.deepEqual(selected.value, {
      receipt: { operationId: 'fictional-duplicate' },
      marker: 'fictional-source-0',
    });
    assert.deepEqual(late.value, {
      receipt: { operationId: `fictional-acceptance-${count - 1}` },
      marker: `fictional-source-${count - 1}`,
    });
    assert.equal(missing.value, null);
    assert.equal(maximum.value, count);
    const lookupReads = {
      selected: selected.reads,
      late: late.reads,
      missing: missing.reads,
      maximum: maximum.reads,
    };
    const afterLookupWork = { ...intakeWorkCounters(db).warm };
    t.diagnostic(
      JSON.stringify({
        count,
        lookupReads,
        nativeNodeReads: afterLookupWork.collectionNodeReads - afterWork.collectionNodeReads,
        nativeWitnessQueries:
          afterLookupWork.collectionReadWitnessQueries - afterWork.collectionReadWitnessQueries,
        nativeReadBytes: afterLookupWork.collectionReadBytes - afterWork.collectionReadBytes,
      }),
    );
    assert.equal(intakeLookupCounters(db).projectionWrites, beforeLookup.projectionWrites);
    assert.equal(authority.objects.size, beforeObjects);
    assert.equal(recordDurabilityStatus(db)?.sequence, beforeSequence);
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n),
      beforeTransactions,
    );
    for (const [operation, reads] of Object.entries(lookupReads))
      assert.equal(
        reads.catalogRows,
        0,
        `${operation} enumerated ${reads.catalogRows} unrelated original rows after preparation`,
      );
  });
async function fixture(t: test.TestContext, raw: string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const authority = memoryRecordAuthority(db);
  registerRawIntakeFixture(db, 'original', raw);
  const source = { id: 'original' };
  const selected = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(source.id)!;
  const identity = {
    profileId: 'fictional',
    intakeId: source.id,
    sourceHash: String(selected.sha256),
  };
  await buildIntakeCollectionEnvelope(db, source);
  return { db, source, identity, authority };
}

test('a forged receipt append proof cannot preserve old private receipt rows', async (t) => {
  const raw = JSON.stringify({
    intake: {
      version: 0,
      workflow: {
        format: 'health-intake-workflow-v1',
        reportAcceptances: [{ receipt: { operationId: 'fictional-old' } }],
      },
    },
  });
  const f = await fixture(t, raw);
  await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
  await prepareIntakeLookupIndices(f.db);
  const source = {
    ...f.source,
    sha256: String(
      f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(f.source.id)!.sha256,
    ),
  };
  const before = openIntakeCollectionEnvelope(f.db, source);
  const basis = nativeIntakeReceiptAppendBasis(f.db, source, JSON.stringify(before.logical));
  assert.ok(basis);
  const workflow = before.child(before.child(before.root(), 'intake')!, 'workflow')!;
  const prepared = await prepareIntakeEnvelopeMutation(f.db, source, {
    reader: before,
    operationId: randomUUID(),
    requestDigest: createHash('sha256').update(raw).digest('hex'),
    domainVersion: 1,
    changes: [
      {
        op: 'append',
        record: workflow,
        field: 'reportAcceptances',
        jsonText: '{"receipt":{"operationId":"fictional-new"}}',
      },
    ],
  });
  assert.ok(prepared.prepared);
  transaction(f.db, () =>
    selectedEnvelopeStore(f.db, source).collections.stage(prepared.prepared!),
  );
  const after = openIntakeCollectionEnvelope(f.db, source);
  retainNativeIntakeReceiptAppend(
    f.db,
    basis,
    {},
    after,
    source,
    JSON.stringify(before.logical),
    JSON.stringify(after.logical),
  );
  let changedVisits = 0;
  await prepareIntakeLookupIndices(f.db, {
    onCheckpoint: ({ sourceId, visited }) => {
      if (sourceId === source.id) changedVisits = Math.max(changedVisits, visited);
    },
  });
  assert.equal(changedVisits, 3, 'A forged proof leaves the original full contribution pass');
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-old'), {
    receipt: { operationId: 'fictional-old' },
  });
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-new'), {
    receipt: { operationId: 'fictional-new' },
  });
});

async function lookupSourceRows(db: DatabaseSync, run: () => Promise<unknown>) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalGet = StatementSync.prototype.get;
  const originalAll = StatementSync.prototype.all;
  const originalIterate = StatementSync.prototype.iterate;
  const statements = new WeakSet<StatementSync>();
  let rows = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (
      this === db &&
      sql.includes("FROM source_files WHERE kind='intake_original'") &&
      sql.includes('ORDER BY rowid')
    )
      statements.add(statement);
    return statement;
  };
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const row = Reflect.apply(originalGet, this, parameters);
    if (statements.has(this) && row) rows++;
    return row;
  } as typeof StatementSync.prototype.get;
  StatementSync.prototype.all = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['all']>
  ) {
    const result = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync['all']>;
    if (statements.has(this)) rows += result.length;
    return result;
  } as typeof StatementSync.prototype.all;
  StatementSync.prototype.iterate = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['iterate']>
  ) {
    const iterator = Reflect.apply(originalIterate, this, parameters) as ReturnType<
      StatementSync['iterate']
    >;
    if (!statements.has(this)) return iterator;
    return (function* () {
      for (const row of iterator) {
        rows++;
        yield row;
      }
    })();
  } as typeof StatementSync.prototype.iterate;
  try {
    await run();
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.get = originalGet;
    StatementSync.prototype.all = originalAll;
    StatementSync.prototype.iterate = originalIterate;
  }
  return rows;
}

async function countedNativeSourceRead<T>(db: DatabaseSync, run: () => T) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalIterate = StatementSync.prototype.iterate;
  const originalGet = StatementSync.prototype.get;
  const originalAll = StatementSync.prototype.all;
  const statements = new WeakSet<StatementSync>();
  const catalogStatements = new WeakSet<StatementSync>();
  const reads = {
    statements: 0,
    rows: 0,
    iterated: 0,
    pointed: 0,
    bulk: 0,
    catalogQueries: 0,
    catalogRows: 0,
  };
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (this === db && /\bsource_files\b/i.test(sql)) {
      statements.add(statement);
      reads.statements++;
      if (
        /\bFROM\s+(?:(?:main|temp)\.)?source_files\b/i.test(sql) &&
        !/\b(?:f\.)?id\s*(?:=|IN\b)/i.test(sql)
      ) {
        catalogStatements.add(statement);
        reads.catalogQueries++;
      }
    }
    return statement;
  };
  StatementSync.prototype.iterate = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['iterate']>
  ) {
    const iterator = Reflect.apply(originalIterate, this, parameters) as ReturnType<
      StatementSync['iterate']
    >;
    if (!statements.has(this)) return iterator;
    const catalog = catalogStatements.has(this);
    return (function* () {
      for (const row of iterator) {
        reads.rows++;
        reads.iterated++;
        if (catalog) reads.catalogRows++;
        yield row;
      }
    })();
  } as typeof StatementSync.prototype.iterate;
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const row = Reflect.apply(originalGet, this, parameters);
    if (statements.has(this) && row) {
      reads.rows++;
      reads.pointed++;
      if (catalogStatements.has(this)) reads.catalogRows++;
    }
    return row;
  } as typeof StatementSync.prototype.get;
  StatementSync.prototype.all = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['all']>
  ) {
    const rows = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync['all']>;
    if (statements.has(this)) {
      reads.rows += rows.length;
      reads.bulk += rows.length;
      if (catalogStatements.has(this)) reads.catalogRows += rows.length;
    }
    return rows;
  } as typeof StatementSync.prototype.all;
  try {
    return { value: run(), reads };
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.iterate = originalIterate;
    StatementSync.prototype.get = originalGet;
    StatementSync.prototype.all = originalAll;
  }
}

async function countAcceptanceIdentityGets<T>(db: DatabaseSync, run: () => Promise<T>) {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalGet = StatementSync.prototype.get;
  const statements = new WeakSet<StatementSync>();
  let gets = 0;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (this === db && sql.includes("typeof(json_extract(?,'$')) type")) statements.add(statement);
    return statement;
  };
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    if (statements.has(this)) gets++;
    return Reflect.apply(originalGet, this, parameters);
  } as typeof StatementSync.prototype.get;
  try {
    return { result: await run(), gets };
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.get = originalGet;
  }
}

test('unrelated SQL recertification does not traverse retained acceptance bodies again', async (t) => {
  const observed: Array<{ count: number; renewedGets: number }> = [];
  for (const count of [1, 65]) {
    const raw = JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          reportGroups: [{ discoveryOrder: 4 }],
          reportAcceptances: Array.from({ length: count }, (_, index) => ({
            receipt: { operationId: `fictional-receipt-${index}` },
            marker: `fictional-${index}`,
          })),
        },
      },
    });
    const f = await fixture(t, raw);
    await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
    const cold = await countAcceptanceIdentityGets(f.db, () => prepareIntakeLookupIndices(f.db));
    assert.equal(cold.gets, count);
    assert.equal(cold.result.prepared, 0);
    const beforeObjects = f.authority.objects.size;
    const beforeSequence = recordDurabilityStatus(f.db)?.sequence;
    f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-recertification', count);
    const beforeLookup = { ...intakeLookupCounters(f.db) };
    const beforeWork = { ...intakeWorkCounters(f.db).warm };
    const beforeTransactions = Number(
      f.db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n,
    );
    const renewed = await countAcceptanceIdentityGets(f.db, () => prepareIntakeLookupIndices(f.db));
    const afterWork = { ...intakeWorkCounters(f.db).warm };
    t.diagnostic(
      JSON.stringify({
        count,
        coldReceiptIdentityGets: cold.gets,
        renewedReceiptIdentityGets: renewed.gets,
        renewedNodeReads: afterWork.collectionNodeReads - beforeWork.collectionNodeReads,
        renewedWitnessQueries:
          afterWork.collectionReadWitnessQueries - beforeWork.collectionReadWitnessQueries,
        renewedReadBytes: afterWork.collectionReadBytes - beforeWork.collectionReadBytes,
      }),
    );
    assert.equal(renewed.result.prepared, 0);
    assert.equal(intakeLookupCounters(f.db).projectionWrites, beforeLookup.projectionWrites);
    assert.equal(f.authority.objects.size, beforeObjects);
    assert.equal(recordDurabilityStatus(f.db)?.sequence, beforeSequence);
    assert.equal(
      Number(f.db.prepare('SELECT COUNT(*) AS n FROM __record_transactions').get()!.n),
      beforeTransactions,
    );
    observed.push({ count, renewedGets: renewed.gets });
  }
  for (const { count, renewedGets } of observed)
    assert.equal(
      renewedGets,
      0,
      `${count} unchanged receipts were traversed after SQL recertification`,
    );
});

test('recertification derives a changed acceptance without revisiting 65 unchanged receipts', async (t) => {
  const raw = JSON.stringify({
    intake: {
      version: 0,
      workflow: {
        format: 'health-intake-workflow-v1',
        reportAcceptances: Array.from({ length: 65 }, (_, index) => ({
          receipt: { operationId: `fictional-history-${index}` },
        })),
      },
    },
  });
  const f = await fixture(t, raw);
  await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
  const changedSource = { id: 'fictional-changing-source' };
  registerRawIntakeFixture(
    f.db,
    changedSource.id,
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[{"receipt":{"operationId":"fictional-old"},"marker":"changing"}]}}}',
  );
  await buildIntakeCollectionEnvelope(f.db, changedSource);
  await buildVerifiedWorkflowSummary(f.db, changedSource, summaryOptions);
  await prepareIntakeLookupIndices(f.db);
  const reader = openIntakeCollectionEnvelope(f.db, changedSource);
  const intake = reader.child(reader.root(), 'intake')!;
  const workflow = reader.child(intake, 'workflow')!;
  const acceptance = reader.childAt(workflow, 'reportAcceptances', 0)!;
  const receipt = reader.child(acceptance, 'receipt')!;
  const operationId = randomUUID();
  transaction(f.db, () => {
    stageIntakeEnvelopeFieldMutation(
      f.db,
      changedSource,
      prepareIntakeEnvelopeFieldMutation(f.db, changedSource, {
        reader,
        record: receipt,
        field: 'operationId',
        jsonText: '"fictional-new"',
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 0,
      }),
    );
  });
  const beforeLookup = { ...intakeLookupCounters(f.db) };
  const renewed = await countAcceptanceIdentityGets(f.db, () => prepareIntakeLookupIndices(f.db));
  t.diagnostic(JSON.stringify({ renewedReceiptIdentityGets: renewed.gets }));
  assert.ok(renewed.gets > 0 && renewed.gets <= 2);
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-old'), null);
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-new'), {
    receipt: { operationId: 'fictional-new' },
    marker: 'changing',
  });
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-history-64'), {
    receipt: { operationId: 'fictional-history-64' },
  });
  assert.ok(intakeLookupCounters(f.db).projectionWrites > beforeLookup.projectionWrites);
});

test('native catalog prunes a removed original without retaining its acceptance', async (t) => {
  const f = await lookupProofFixture(t);
  const removed = { id: 'fictional-removed' };
  registerRawIntakeFixture(
    f.db,
    removed.id,
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[{"receipt":{"operationId":"fictional-removed-operation"}}]}}}',
  );
  await buildIntakeCollectionEnvelope(f.db, removed);
  await buildVerifiedWorkflowSummary(f.db, removed, summaryOptions);
  registerRawIntakeFixture(
    f.db,
    'fictional-tail',
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[]}}}',
  );
  await prepareIntakeLookupIndices(f.db);
  assert.ok(retainedIntakeAcceptance(f.db, 'fictional-removed-operation'));
  const original = f.db.prepare('SELECT rowid,* FROM source_files WHERE id=?').get(removed.id)!;
  transaction(f.db, () => {
    f.db.prepare('DELETE FROM source_files WHERE id=?').run(removed.id);
    f.db
      .prepare(
        `INSERT INTO source_files(id,provider_id,path,sha256,bytes,mime_type,kind,
          coverage_status,batch_id,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        original.id,
        original.provider_id,
        original.path,
        original.sha256,
        original.bytes,
        original.mime_type,
        original.kind,
        original.coverage_status,
        original.batch_id,
        original.details_json,
      );
  });
  assert.ok(
    Number(f.db.prepare('SELECT rowid FROM source_files WHERE id=?').get(removed.id)!.rowid) >
      Number(original.rowid),
  );
  await prepareIntakeLookupIndices(f.db);
  assert.ok(retainedIntakeAcceptance(f.db, 'fictional-removed-operation'));
  f.db.prepare('DELETE FROM source_files WHERE id=?').run(removed.id);
  await prepareIntakeLookupIndices(f.db);
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-removed-operation'), null);
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
    receipt: { operationId: 'fictional-proof' },
    marker: 'retained',
  });
});

test('mixed legacy and native acceptance order survives a native catalog build', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-mixed-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    'fictional-legacy',
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":11}],"reportAcceptances":[{"receipt":{"operationId":"fictional-duplicate"},"marker":"legacy"}]}}}',
  );
  const native = { id: 'fictional-native' };
  registerRawIntakeFixture(
    db,
    native.id,
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":13}],"reportAcceptances":[{"receipt":{"operationId":"fictional-duplicate"},"marker":"native"},{"receipt":{"operationId":"fictional-native-only"},"marker":"only"}]}}}',
  );
  await buildIntakeCollectionEnvelope(db, native);
  await buildVerifiedWorkflowSummary(db, native, summaryOptions);
  await prepareIntakeLookupIndices(db);
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-duplicate'), {
    receipt: { operationId: 'fictional-duplicate' },
    marker: 'legacy',
  });
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-native-only'), {
    receipt: { operationId: 'fictional-native-only' },
    marker: 'only',
  });
  assert.equal(maximumIntakeDiscoveryOrder(db), 13);
});

const lookupProofFixture = async (t: test.TestContext) => {
  const f = await fixture(
    t,
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          reportGroups: [{ discoveryOrder: 7 }],
          reportAcceptances: [{ receipt: { operationId: 'fictional-proof' }, marker: 'retained' }],
        },
      },
    }),
  );
  await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
  await prepareIntakeLookupIndices(f.db);
  return f;
};

function rewriteLookupBuildHead(f: Awaited<ReturnType<typeof lookupProofFixture>>) {
  const { collections } = createIntakeStateStorage(f.db, f.identity);
  const before = collections.binding(collections.openView())!;
  const operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
      changes: [
        { area: 'builds', collection: 'fictional.progress', op: 'put', key: 'one', value: 'done' },
      ],
    }),
  );
  const after = collections.binding(collections.openView())!;
  assert.notDeepEqual(after, before, 'The control must rewrite the physical collection head');
  assert.deepEqual(after.logical, before.logical);
}

test('maintenance-only native head rewrites renew lookup without scanning originals', async (t) => {
  const f = await lookupProofFixture(t);
  const before = await prepareIntakeLookupIndices(f.db);
  const token = preparedIntakeLookupReadToken(f.db)!;
  rewriteLookupBuildHead(f);
  assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
  assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(f.db, token, [f.source.id]), true);
  assert.equal(preparedIntakeDiscoveryRevision(f.db), before.discoveryRevision);
  const objects = f.authority.objects.size;
  assert.equal(
    await lookupSourceRows(f.db, async () => {
      assert.deepEqual(await prepareIntakeLookupIndices(f.db), {
        prepared: 0,
        reused: before.reused,
        discoveryRevision: before.discoveryRevision,
      });
    }),
    0,
  );
  assert.notEqual(preparedIntakeLookupReadToken(f.db), token);
  assert.equal(f.authority.objects.size, objects);
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
    receipt: { operationId: 'fictional-proof' },
    marker: 'retained',
  });
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
});

for (const change of ['unrelated-sql', 'sql-aba', 'rollback', 'source-write'] as const)
  test(`maintenance-only head equality does not forgive an unknown ${change}`, async (t) => {
    const f = await lookupProofFixture(t);
    const before = await prepareIntakeLookupIndices(f.db);
    const token = preparedIntakeLookupReadToken(f.db)!;
    rewriteLookupBuildHead(f);
    const write = () =>
      f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-unknown', 'changed');
    if (change === 'source-write')
      f.db.prepare('UPDATE source_files SET details_json=details_json WHERE id=?').run(f.source.id);
    else if (change === 'rollback')
      assert.throws(
        () =>
          transaction(f.db, () => {
            write();
            throw Error('fictional rollback');
          }),
        /fictional rollback/,
      );
    else {
      write();
      if (change === 'sql-aba')
        f.db.prepare('DELETE FROM app_meta WHERE key=?').run('fictional-unknown');
    }
    assert.equal(
      nativeIntakeLookupCatalogHeadBindingsEqual(f.db, token, [f.source.id]),
      change !== 'rollback',
      'Rollback discards the catalog; other unknown writes cannot be excused by equal heads',
    );
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    assert.equal(preparedIntakeDiscoveryRevision(f.db), undefined);
    assert.ok(
      (await lookupSourceRows(f.db, async () => {
        const result = await prepareIntakeLookupIndices(f.db);
        assert.equal(result.discoveryRevision, before.discoveryRevision);
      })) >= 2,
    );
    assert.notEqual(preparedIntakeLookupReadToken(f.db), token);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
  });

test('maintenance-only renewal does not credit an unrelated write inside its owned transaction', async (t) => {
  const f = await lookupProofFixture(t);
  f.db.exec('CREATE TEMP TABLE fictional_unowned_maintenance(value TEXT)');
  const before = await prepareIntakeLookupIndices(f.db);
  const token = preparedIntakeLookupReadToken(f.db)!;
  const original = StatementSync.prototype.run;
  let changed = false;
  StatementSync.prototype.run = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['run']>
  ) {
    const result = Reflect.apply(original, this, parameters);
    if (
      !changed &&
      this.sourceSQL ===
        'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ) {
      changed = true;
      f.db.prepare('INSERT INTO fictional_unowned_maintenance VALUES(?)').run('unowned');
    }
    return result;
  } as typeof StatementSync.prototype.run;
  try {
    rewriteLookupBuildHead(f);
  } finally {
    StatementSync.prototype.run = original;
  }
  assert.equal(changed, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fictional_unowned_maintenance').get()!.n, 1);
  assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(f.db, token, [f.source.id]), true);
  assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
  assert.equal(preparedIntakeDiscoveryRevision(f.db), before.discoveryRevision);
  assert.ok(
    (await lookupSourceRows(f.db, async () => {
      assert.equal(
        (await prepareIntakeLookupIndices(f.db)).discoveryRevision,
        before.discoveryRevision,
      );
    })) >= 2,
  );
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
});

for (const change of [
  'capture-preinsert',
  'dirty-preinsert',
  'reentrant-clear',
  'retained-clear-replay',
] as const)
  test(`maintenance bookkeeping refuses ${change} callback write substitution`, async (t) => {
    const f = await lookupProofFixture(t);
    f.db.exec('CREATE TEMP TABLE fictional_bookkeeping_substitution(value TEXT)');
    let armed = false;
    let changed = false;
    let retainedClear: StatementSync | undefined;
    const substitute = () => {
      changed = true;
      if (change === 'capture-preinsert')
        f.db
          .prepare('INSERT INTO temp.__record_changed VALUES(?,?)')
          .run('app_meta', '["revision"]');
      else if (change === 'dirty-preinsert')
        f.db.prepare('INSERT INTO temp.__intake_lookup_dirty VALUES(?)').run(f.source.id);
      else if (change === 'retained-clear-replay') retainedClear!.run();
      else f.db.prepare('DELETE FROM temp.__record_changed').run();
      f.db.prepare('INSERT INTO fictional_bookkeeping_substitution VALUES(?)').run('unowned');
    };
    if (change === 'reentrant-clear')
      f.db.setAuthorizer((action, name, _detail, schema) => {
        if (
          armed &&
          !changed &&
          action === constants.SQLITE_DELETE &&
          name === '__record_changed' &&
          schema === 'temp'
        )
          substitute();
        return constants.SQLITE_OK;
      });
    const before = await prepareIntakeLookupIndices(f.db);
    const originalRun = StatementSync.prototype.run;
    const originalGet = StatementSync.prototype.get;
    StatementSync.prototype.run = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['run']>
    ) {
      const result = Reflect.apply(originalRun, this, parameters);
      if (
        armed &&
        change === 'retained-clear-replay' &&
        !retainedClear &&
        this.sourceSQL === 'DELETE FROM temp.__record_changed'
      )
        retainedClear = this;
      if (
        armed &&
        !changed &&
        change === 'capture-preinsert' &&
        this.sourceSQL === 'DELETE FROM temp.__record_changed'
      )
        substitute();
      if (
        armed &&
        !changed &&
        change === 'retained-clear-replay' &&
        retainedClear &&
        this.sourceSQL ===
          'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      )
        substitute();
      return result;
    } as typeof StatementSync.prototype.run;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const result = Reflect.apply(originalGet, this, parameters);
      if (
        armed &&
        !changed &&
        change === 'dirty-preinsert' &&
        result === undefined &&
        this.sourceSQL === 'SELECT 1 FROM temp.__intake_lookup_dirty WHERE source_id=?' &&
        (parameters as unknown[])[0] === f.source.id
      )
        substitute();
      return result;
    } as typeof StatementSync.prototype.get;
    armed = true;
    try {
      if (change === 'capture-preinsert')
        assert.throws(() => rewriteLookupBuildHead(f), /unexpected accepted key/);
      else if (change === 'retained-clear-replay')
        assert.throws(() => rewriteLookupBuildHead(f), /missing prepared write/);
      else rewriteLookupBuildHead(f);
    } finally {
      armed = false;
      StatementSync.prototype.run = originalRun;
      StatementSync.prototype.get = originalGet;
    }
    assert.equal(changed, true);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) n FROM fictional_bookkeeping_substitution').get()!.n,
      change === 'capture-preinsert' || change === 'retained-clear-replay' ? 0 : 1,
    );
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    assert.equal(preparedIntakeDiscoveryRevision(f.db), undefined);
    assert.ok(
      (await lookupSourceRows(f.db, async () => {
        assert.equal(
          (await prepareIntakeLookupIndices(f.db)).discoveryRevision,
          before.discoveryRevision,
        );
      })) >= 2,
    );
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
      receipt: { operationId: 'fictional-proof' },
      marker: 'retained',
    });
  });

for (const change of ['source-order', 'source-hash', 'source-kind', 'source-delete'] as const)
  test(`maintenance-only head equality refuses a changed ${change} binding`, async (t) => {
    const f = await lookupProofFixture(t);
    const token = preparedIntakeLookupReadToken(f.db)!;
    rewriteLookupBuildHead(f);
    if (change === 'source-order')
      f.db.prepare('UPDATE source_files SET rowid=rowid+100 WHERE id=?').run(f.source.id);
    else if (change === 'source-hash')
      f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('b'.repeat(64), f.source.id);
    else if (change === 'source-kind')
      f.db.prepare('UPDATE source_files SET kind=? WHERE id=?').run('document', f.source.id);
    else f.db.prepare('DELETE FROM source_files WHERE id=?').run(f.source.id);
    assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(f.db, token, [f.source.id]), false);
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    assert.equal(preparedIntakeDiscoveryRevision(f.db), undefined);
  });

test('maintenance-only renewal does not preserve a changed logical receipt', async (t) => {
  const f = await lookupProofFixture(t);
  const before = await prepareIntakeLookupIndices(f.db);
  const token = preparedIntakeLookupReadToken(f.db)!;
  rewriteLookupBuildHead(f);
  const reader = openIntakeCollectionEnvelope(f.db, f.source);
  const intake = reader.child(reader.root(), 'intake')!;
  const workflow = reader.child(intake, 'workflow')!;
  const acceptance = reader.childAt(workflow, 'reportAcceptances', 0)!;
  const receipt = reader.child(acceptance, 'receipt')!;
  const operationId = randomUUID();
  transaction(f.db, () =>
    stageIntakeEnvelopeFieldMutation(
      f.db,
      f.source,
      prepareIntakeEnvelopeFieldMutation(f.db, f.source, {
        reader,
        record: receipt,
        field: 'operationId',
        jsonText: '"fictional-after-maintenance"',
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 0,
      }),
    ),
  );
  assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(f.db, token, [f.source.id]), false);
  assert.equal(preparedIntakeDiscoveryRevision(f.db), undefined);
  assert.ok(
    (await lookupSourceRows(f.db, async () => {
      const after = await prepareIntakeLookupIndices(f.db);
      assert.notEqual(after.discoveryRevision, before.discoveryRevision);
    })) >= 2,
  );
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-proof'), null);
  assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-after-maintenance'), {
    receipt: { operationId: 'fictional-after-maintenance' },
    marker: 'retained',
  });
});

test('maintenance-only renewal retains its interval across the bounded head equality read', async (t) => {
  const f = await lookupProofFixture(t);
  rewriteLookupBuildHead(f);
  const original = StatementSync.prototype.get;
  let changed = false;
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const result = Reflect.apply(original, this, parameters);
    if (
      !changed &&
      this.sourceSQL.startsWith(
        'SELECT rowid source_order,id,kind,sha256,details_json FROM main.source_files',
      )
    ) {
      changed = true;
      f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-late-equality', 'changed');
    }
    return result;
  } as typeof StatementSync.prototype.get;
  try {
    assert.ok((await lookupSourceRows(f.db, () => prepareIntakeLookupIndices(f.db))) >= 2);
  } finally {
    StatementSync.prototype.get = original;
  }
  assert.equal(changed, true);
  assert.ok(preparedIntakeLookupReadToken(f.db));
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
  assert.equal(retainedIntakeAcceptance(f.db, 'fictional-missing'), null);
});

for (const change of [
  'main',
  'temp',
  'temp-schema',
  'registry',
  'lookup-cache',
  'rollback',
  'peer',
] as const)
  test(`warm lookup preparation expires its exact proof after ${change}`, async (t) => {
    const f = await lookupProofFixture(t);
    const before = await prepareIntakeLookupIndices(f.db);
    if (change === 'main')
      f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-proof', 'changed');
    if (change === 'temp') {
      f.db.exec('CREATE TEMP TABLE fictional_lookup_proof(value INTEGER)');
      await prepareIntakeLookupIndices(f.db);
      f.db.exec('INSERT INTO fictional_lookup_proof VALUES(1)');
    }
    if (change === 'temp-schema')
      f.db.exec('CREATE TEMP TABLE fictional_lookup_proof(value INTEGER)');
    if (change === 'registry') clearIntakeCollectionCache(f.db);
    if (change === 'lookup-cache') clearIntakeLookupCache(f.db);
    if (change === 'rollback')
      assert.throws(
        () =>
          transaction(f.db, () => {
            f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-proof', 'rolled back');
            throw Error('fictional rollback');
          }),
        /fictional rollback/,
      );
    if (change === 'peer') {
      const peer = new DatabaseSync(f.db.location()!);
      try {
        peer.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-proof', 'peer changed');
      } finally {
        peer.close();
      }
    }
    const maximum = await countedNativeSourceRead(f.db, () => maximumIntakeDiscoveryOrder(f.db));
    const retained = await countedNativeSourceRead(f.db, () =>
      retainedIntakeAcceptance(f.db, 'fictional-proof'),
    );
    const missing = await countedNativeSourceRead(f.db, () =>
      retainedIntakeAcceptance(f.db, 'fictional-missing'),
    );
    assert.equal(maximum.value, 7);
    assert.deepEqual(retained.value, {
      receipt: { operationId: 'fictional-proof' },
      marker: 'retained',
    });
    assert.equal(missing.value, null);
    assert.ok(maximum.reads.catalogRows >= 1);
    assert.ok(retained.reads.catalogRows >= 1);
    assert.ok(missing.reads.catalogRows >= 1);
    t.diagnostic(
      JSON.stringify({
        change,
        preprepareCatalogRows: [
          maximum.reads.catalogRows,
          retained.reads.catalogRows,
          missing.reads.catalogRows,
        ],
      }),
    );
    assert.ok(
      (await lookupSourceRows(f.db, async () => {
        const result = await prepareIntakeLookupIndices(f.db);
        assert.equal(result.discoveryRevision, before.discoveryRevision);
        assert.equal(result.prepared, 0);
      })) >= 2,
    );
    assert.equal(await lookupSourceRows(f.db, () => prepareIntakeLookupIndices(f.db)), 0);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
      receipt: { operationId: 'fictional-proof' },
      marker: 'retained',
    });
  });

test('warm lookup preparation checks cancellation and callback changes before reuse', async (t) => {
  const f = await lookupProofFixture(t);
  const objects = f.authority.objects.size;
  await assert.rejects(
    prepareIntakeLookupIndices(f.db, {
      assertRunning: () => {
        throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  let changed = false;
  assert.ok(
    (await lookupSourceRows(f.db, () =>
      prepareIntakeLookupIndices(f.db, {
        assertRunning: () => {
          if (changed) return;
          changed = true;
          f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-callback', 'changed');
        },
      }),
    )) >= 2,
  );
  assert.equal(f.authority.objects.size, objects);
});

for (const change of ['sql', 'collection-registry', 'lookup-registry'] as const)
  test(`lookup preparation never certifies a ${change} change after final frontier validation`, async (t) => {
    const f = await lookupProofFixture(t);
    clearIntakeLookupCache(f.db);
    const original = StatementSync.prototype.get;
    let completedScans = 0;
    let changed = false;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(original, this, parameters);
      if (this.sourceSQL.includes('AS lookup_rowid') && row === undefined) completedScans++;
      return row;
    } as typeof StatementSync.prototype.get;
    try {
      await assert.rejects(
        prepareIntakeLookupIndices(f.db, {
          assertRunning: () => {
            if (completedScans !== 2 || changed) return;
            changed = true;
            if (change === 'sql')
              f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-tail', 'changed');
            else if (change === 'collection-registry') clearIntakeCollectionCache(f.db);
            else clearIntakeLookupCache(f.db);
          },
        }),
        /frontier changed/,
      );
    } finally {
      StatementSync.prototype.get = original;
    }
    assert.equal(changed, true);
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    assert.ok((await lookupSourceRows(f.db, () => prepareIntakeLookupIndices(f.db))) >= 2);
    assert.equal(await lookupSourceRows(f.db, () => prepareIntakeLookupIndices(f.db)), 0);
  });

for (const target of ['collection', 'lookup'] as const)
  test(`warm lookup preparation checks entry ${target} registry invalidation`, async (t) => {
    const f = await lookupProofFixture(t);
    const original = StatementSync.prototype.get;
    let armed = true;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const result = Reflect.apply(original, this, parameters);
      if (armed && this.sourceSQL.startsWith('SELECT total_changes() AS changes')) {
        armed = false;
        if (target === 'collection') clearIntakeCollectionCache(f.db);
        else clearIntakeLookupCache(f.db);
      }
      return result;
    } as typeof StatementSync.prototype.get;
    try {
      assert.ok((await lookupSourceRows(f.db, () => prepareIntakeLookupIndices(f.db))) >= 2);
      assert.equal(armed, false);
    } finally {
      StatementSync.prototype.get = original;
    }
  });

test('warm lookup preparation retains detached results and refuses accepted-head or profile drift', async (t) => {
  const f = await lookupProofFixture(t);
  const result = await prepareIntakeLookupIndices(f.db);
  const expected = result.discoveryRevision;
  result.discoveryRevision = 'fictional forged result';
  result.reused = 999;
  assert.deepEqual(await prepareIntakeLookupIndices(f.db), {
    prepared: 0,
    reused: 1,
    discoveryRevision: expected,
  });
  const head = f.authority.objects.get('head')!;
  f.authority.objects.delete('head');
  await assert.rejects(prepareIntakeLookupIndices(f.db), /recovery|authority|head/i);
  f.authority.objects.set('head', head);
  await prepareIntakeLookupIndices(f.db);
  f.db.prepare("UPDATE app_meta SET value='foreign-profile' WHERE key='owner_profile_id'").run();
  await assert.rejects(prepareIntakeLookupIndices(f.db));
});

test('discarding a native lookup cache removes its private address scratch', async (t) => {
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('circus-intake-lookup-addresses-')),
  );
  const f = await lookupProofFixture(t);
  const created = readdirSync(tmpdir()).filter(
    (name) => name.startsWith('circus-intake-lookup-addresses-') && !before.has(name),
  );
  assert.equal(created.length, 1);
  clearIntakeLookupCache(f.db);
  for (const name of created) assert.equal(existsSync(join(tmpdir(), name)), false);
});

for (const target of ['maximum', 'receipt'] as const)
  test(`native ${target} catalog refuses a SQL change during its selected point read`, async (t) => {
    const f = await lookupProofFixture(t);
    const original = StatementSync.prototype.get;
    let changed = false;
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(original, this, parameters);
      if (
        !changed &&
        this.sourceSQL.includes('FROM main.source_files') &&
        this.sourceSQL.includes('WHERE id=?')
      ) {
        changed = true;
        f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional-point-change', target);
      }
      return row;
    } as typeof StatementSync.prototype.get;
    try {
      assert.throws(
        () =>
          target === 'maximum'
            ? maximumIntakeDiscoveryOrder(f.db)
            : retainedIntakeAcceptance(f.db, 'fictional-proof'),
        /frontier changed/,
      );
    } finally {
      StatementSync.prototype.get = original;
    }
    assert.equal(changed, true);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
      receipt: { operationId: 'fictional-proof' },
      marker: 'retained',
    });
  });

for (const change of ['cancel', 'sql'] as const)
  test(`interrupted native catalog ${change} cannot certify a missing acceptance`, async (t) => {
    const f = await lookupProofFixture(t);
    clearIntakeLookupCache(f.db);
    let checkpoints = 0;
    if (change === 'cancel')
      await assert.rejects(
        prepareIntakeLookupIndices(f.db, {
          onCheckpoint: () => {
            checkpoints++;
            throw Error('fictional catalog cancellation');
          },
        }),
        /fictional catalog cancellation/,
      );
    else
      await assert.rejects(
        prepareIntakeLookupIndices(f.db, {
          onCheckpoint: () => {
            checkpoints++;
            if (checkpoints === 1)
              f.db
                .prepare('INSERT INTO app_meta VALUES(?,?)')
                .run('fictional-catalog-change', 'yes');
          },
        }),
        /frontier changed/,
      );
    assert.ok(checkpoints >= 1);
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    const missing = await countedNativeSourceRead(f.db, () =>
      retainedIntakeAcceptance(f.db, 'fictional-missing'),
    );
    assert.equal(missing.value, null);
    assert.ok(missing.reads.catalogRows >= 1);
    assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
    assert.deepEqual(retainedIntakeAcceptance(f.db, 'fictional-proof'), {
      receipt: { operationId: 'fictional-proof' },
      marker: 'retained',
    });
  });

test('native lookup reproduces raw SQLite-first ancestors, duplicate receipt fields, scalar conversions and integer casts', async (t) => {
  const raw = `{"intake":{"version":0,"workflow":{
    "reportGroups":[{"discoveryOrder":"009fictional","discoveryOrder":700},null,{}],
    "reportAcceptances":[{"receipt":{"operationId":"raw-first","operationId":"raw-last"},"marker":"first"},{"receipt":{"operationId":"raw-first"},"marker":"second"},{"receipt":{"operationId":"\\ud800"},"marker":"surrogate"}],
    "identityConfirmations":[null,1,true,false,"fictional scalar","17",{"marker":"kept"}]
  }},"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":999}]}}}`;
  const { db, source } = await fixture(t, raw);
  assert.throws(() => maximumIntakeDiscoveryOrder(db), /semantic indexes.*incomplete/);
  await buildVerifiedWorkflowSummary(db, source, summaryOptions);
  const maximum = db
    .prepare(
      "SELECT MAX(CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER)) n FROM json_each(?,'$.intake.workflow.reportGroups') j",
    )
    .get(raw)!.n;
  assert.equal(maximumIntakeDiscoveryOrder(db), maximum);
  const retained = db
    .prepare(
      "SELECT j.value FROM json_each(?,'$.intake.workflow.reportAcceptances') j WHERE json_extract(j.value,'$.receipt.operationId')=? LIMIT 1",
    )
    .get(raw, 'raw-first')!;
  assert.deepEqual(retainedIntakeAcceptance(db, 'raw-first'), JSON.parse(String(retained.value)));
  assert.equal(retainedIntakeAcceptance(db, 'raw-last'), null);
  await prepareIntakeLookupIndices(db);
  assert.deepEqual(retainedIntakeAcceptance(db, 'raw-first'), JSON.parse(String(retained.value)));
  assert.equal(retainedIntakeAcceptance(db, 'raw-last'), null);
  for (const operation of ['\ud800', '\ufffd', '\ufffd'.repeat(3)]) {
    const expected = db
      .prepare(
        "SELECT j.value FROM json_each(?,'$.intake.workflow.reportAcceptances') j WHERE json_extract(j.value,'$.receipt.operationId')=? LIMIT 1",
      )
      .get(raw, operation);
    assert.deepEqual(
      retainedIntakeAcceptance(db, operation),
      expected ? JSON.parse(String(expected.value)) : null,
    );
  }
  const acceptanceReference = retainedIntakeAcceptanceReference(db, 'raw-first');
  assert.equal(acceptanceReference?.mode, 'native');
  const identities = db
    .prepare("SELECT value FROM json_each(?,'$.intake.workflow.identityConfirmations')")
    .all(raw)
    .map((row) => json(row.value));
  assert.deepEqual(indexedIntakeIdentityConfirmations(db), identities);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM __record_intake_lookup_payloads').get()!.n, 0);
  clearIntakeLookupCache(db);
  assert.deepEqual(
    Array.from(iterateIntakeIdentityReferences(db), readIntakeIdentityReference),
    identities,
  );
});

test('prepared native maximum still refuses an unsafe losing contributor', async (t) => {
  const f = await fixture(
    t,
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":7}]}}}',
  );
  await buildVerifiedWorkflowSummary(f.db, f.source, summaryOptions);
  registerRawIntakeFixture(
    f.db,
    'fictional-negative',
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":[{"discoveryOrder":-9007199254740992}]}}}',
  );
  await buildIntakeCollectionEnvelope(f.db, { id: 'fictional-negative' });
  await buildVerifiedWorkflowSummary(f.db, { id: 'fictional-negative' }, summaryOptions);
  await prepareIntakeLookupIndices(f.db);
  assert.throws(() => maximumIntakeDiscoveryOrder(f.db), /safe|integer|range/i);
});

test('tampered unrelated native metadata refuses before a negative acceptance lookup', async (t) => {
  const f = await lookupProofFixture(t);
  registerRawIntakeFixture(
    f.db,
    'fictional-other',
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[{"receipt":{"operationId":"fictional-unrelated"}}]}}}',
  );
  await buildIntakeCollectionEnvelope(f.db, { id: 'fictional-other' });
  await buildVerifiedWorkflowSummary(f.db, { id: 'fictional-other' }, summaryOptions);
  await prepareIntakeLookupIndices(f.db);
  f.db
    .prepare('UPDATE source_files SET details_json=? WHERE id=?')
    .run(
      '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[{"receipt":{"operationId":"fictional-unrelated"}}],"reportAcceptances":{"bad":true}}}}',
      'fictional-other',
    );
  await assert.rejects(
    prepareIntakeLookupIndices(f.db),
    /unsupported or duplicated original authority/,
  );
  assert.throws(
    () => retainedIntakeAcceptance(f.db, 'fictional-missing'),
    /unsupported or duplicated original authority/,
  );
});

test('native addressed identity headers choose last inner fields and stream complete large target membership', async (t) => {
  const targets = Array.from({ length: 96 }, (_, i) => ({
    recordId: 'record-' + i,
    padding: 'x'.repeat(1500),
  }));
  const receipt =
    '{"operationId":"hidden","operationId":"shown","confirmedPrintedName":"Old Fictional","confirmedPrintedName":"New Fictional","scope":{"intakeId":"original","groupId":"group","targets":[],"targets":' +
    JSON.stringify(targets) +
    '}}';
  const raw =
    '{"intake":{"version":0,"workflow":{"identityConfirmations":[' +
    receipt +
    ']}},"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","identityConfirmations":[]}}}';
  const { db, source } = await fixture(t, raw);
  await buildVerifiedWorkflowSummary(db, source, summaryOptions);
  const [reference] = iterateIntakeIdentityReferences(db);
  assert.ok(reference);
  assert.equal(openIntakeIdentityReference(reference).header.operationId, 'shown');
  assert.equal(openIntakeIdentityReference(reference).header.printedName, 'New Fictional');
  assert.deepEqual(intakeIdentityTargetMembership(reference, new Set(['record-0'])), {
    count: 96,
    affected: true,
    moves: false,
  });
  assert.deepEqual(
    intakeIdentityTargetMembership(reference, new Set(targets.map((target) => target.recordId))),
    { count: 96, affected: true, moves: true },
  );
  assert.throws(() => readIntakeIdentityReference(reference), /requires addressed consumption/);
  assert.equal(reference.mode, 'native');
  if (reference.mode === 'native') {
    const selected = reference.view.subtree(reference.record, { fieldSelection: 'last' });
    const scope = selected.child(selected.root(), 'scope')!;
    const tail = selected.childAt(scope, 'targets', 95)!;
    const ids = openIntakeIdentityReference(reference).targetIds();
    assert.equal(ids.next().value, 'record-0');
    assert.throws(
      () =>
        transaction(db, () => {
          const operationId = randomUUID();
          const mutation = prepareIntakeEnvelopeFieldMutation(db, source, {
            reader: selected,
            record: tail,
            field: 'recordId',
            jsonText: '"changed"',
            operationId,
            requestDigest: createHash('sha256').update(operationId).digest('hex'),
            domainVersion: 0,
          });
          stageIntakeEnvelopeFieldMutation(db, source, mutation);
          assert.throws(() => ids.next(), /stale logical envelope/);
          throw Error('fictional identity rollback');
        }),
      /fictional identity rollback/,
    );
    assert.equal(intakeIdentityTargetMembership(reference, new Set(['record-0'])).count, 96);
  }
  const work = intakeWorkCounters(db);
  assert.equal(work.warm.envelopeHydrations, 0);
});

test('native point lookups have no workflow recount or auxiliary churn writes; local logical edits become pending and rollback restores completeness', async (t) => {
  const groups = Array.from({ length: 48 }, (_, i) => ({
    id: 'g' + i,
    discoveryOrder: i,
    unknown: 'x'.repeat(1800),
    versions: [],
  }));
  const raw = JSON.stringify({
    intake: {
      version: 0,
      workflow: {
        format: 'health-intake-workflow-v1',
        reportGroups: groups,
        reportAcceptances: [{ receipt: { operationId: 'op' }, marker: 'retained' }],
      },
    },
  });
  const { db, source, identity } = await fixture(t, raw);
  await buildVerifiedWorkflowSummary(db, source, summaryOptions);
  assert.equal(maximumIntakeDiscoveryOrder(db), 47);
  const before = { ...intakeLookupCounters(db) };
  const workBefore = intakeWorkCounters(db);
  for (let i = 0; i < 5; i++) {
    assert.equal(maximumIntakeDiscoveryOrder(db), 47);
    assert.equal((retainedIntakeAcceptance(db, 'op') as { marker: string }).marker, 'retained');
  }
  assert.equal(intakeLookupCounters(db).contributionItemsVisited, before.contributionItemsVisited);
  assert.equal(intakeLookupCounters(db).projectionWrites, before.projectionWrites);
  assert.equal(
    intakeWorkCounters(db).warm.materializationReads,
    workBefore.warm.materializationReads,
  );
  const storage = createIntakeStateStorage(db, identity);
  const operationId = randomUUID();
  storage.collections.commitMaintenance(
    storage.collections.prepare(storage.collections.openView(), {
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: 0,
      changes: [
        { area: 'builds', collection: 'fictional.progress', op: 'put', key: 'one', value: 'done' },
      ],
    }),
  );
  assert.equal(maximumIntakeDiscoveryOrder(db), 47);
  assert.equal(intakeLookupCounters(db).projectionWrites, before.projectionWrites);
  // Disposable cache rows must not become evidence for native maxima/receipts.
  db.prepare('INSERT INTO __record_intake_lookup_groups VALUES(?,0,9000)').run(source.id);
  db.prepare('INSERT INTO __record_intake_lookup_payloads VALUES(?,?)').run(
    'fake',
    '{"marker":"fake"}',
  );
  db.prepare('INSERT INTO __record_intake_lookup_acceptances VALUES(?,?,?)').run(
    source.id,
    'op',
    'fake',
  );
  assert.equal(maximumIntakeDiscoveryOrder(db), 47);
  assert.equal((retainedIntakeAcceptance(db, 'op') as { marker: string }).marker, 'retained');
  db.prepare('UPDATE __record_intake_lookup_sources SET identity_first=NULL WHERE source_id=?').run(
    source.id,
  );
  // The projection event witness can refuse this forgery before native binding is read.
  const forgedProjection = /native source projection binding|disposable projection mutation/;
  assert.throws(() => maximumIntakeDiscoveryOrder(db), forgedProjection);
  assert.throws(() => indexedIntakeIdentityConfirmations(db), forgedProjection);
  clearIntakeLookupCache(db);
  assert.equal(maximumIntakeDiscoveryOrder(db), 47);
  const reader = openIntakeCollectionEnvelope(db, source);
  const intake = reader.child(reader.root(), 'intake')!;
  const workflow = reader.child(intake, 'workflow')!;
  const group = reader.childAt(workflow, 'reportGroups', 0)!;
  assert.throws(
    () =>
      transaction(db, () => {
        const operationId = randomUUID();
        const mutation = prepareIntakeEnvelopeFieldMutation(db, source, {
          reader,
          record: group,
          field: 'discoveryOrder',
          jsonText: '900',
          operationId,
          requestDigest: createHash('sha256').update(operationId).digest('hex'),
          domainVersion: 0,
        });
        stageIntakeEnvelopeFieldMutation(db, source, mutation);
        assert.throws(() => maximumIntakeDiscoveryOrder(db), /semantic indexes.*stale/);
        throw Error('fictional lookup rollback');
      }),
    /fictional lookup rollback/,
  );
  assert.equal(maximumIntakeDiscoveryOrder(db), 47);
});

test('ownership report scopes use JS-last groups and stream all versions without hydrating operational intake', async (t) => {
  const group = (id: string, recordId: string) => ({
    id,
    report: { subject: { text: id + ' Subject' } },
    versions: [{ members: [{ occurrences: [{ recordId }] }] }, { members: [] }],
  });
  const raw =
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportGroups":' +
    JSON.stringify([group('hidden', 'record')]) +
    ',"reportGroups":' +
    JSON.stringify([group('shown', 'record')]) +
    '}}}';
  const { db } = await fixture(t, raw);
  assert.deepEqual(Array.from(ownershipIntakeScopes(db, 'original', 'record')), [
    { id: 'shown', subjectText: 'shown Subject' },
  ]);
  assert.deepEqual(
    Array.from(ownershipIntakeScopes(db, 'original', 'record', { latestOnly: true })),
    [],
  );
  assert.deepEqual(
    Array.from(
      ownershipIntakeScopes(db, 'original', 'record', {
        latestOnly: true,
        exactGroups: new Set(['shown']),
      }),
    ),
    [{ id: 'shown', subjectText: 'shown Subject' }],
  );
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, 0);
});

test('explicit lookup preparation alone publishes complete cold indexes, interrupts safely, reuses current state and binds the global frontier', async (t) => {
  const raw = JSON.stringify({
    intake: {
      version: 0,
      workflow: {
        format: 'health-intake-workflow-v1',
        reportGroups: [{ discoveryOrder: 4 }, { discoveryOrder: 18 }, { discoveryOrder: 2 }],
        reportAcceptances: [{ receipt: { operationId: 'one' }, marker: 'first' }],
        identityConfirmations: Array.from({ length: 17 }, (_, i) => ({ marker: i })),
        candidates: Array.from({ length: 24 }, (_, i) => ({
          id: 'unrelated-' + i,
          versions: [],
          padding: 'x'.repeat(1000),
        })),
      },
    },
  });
  const { db, source } = await fixture(t, raw);
  const before = intakeWorkCounters(db);
  const frontier = intakeDiscoveryRevision(db);
  clearIntakeLookupCache(db);
  let checkpoints = 0;
  await assert.rejects(
    prepareIntakeLookupIndices(db, {
      onCheckpoint() {
        checkpoints++;
        assert.equal(intakeLookupProjectionGeneration(db), undefined);
        assert.throws(() => maximumIntakeDiscoveryOrder(db), /semantic indexes.*incomplete/);
        throw Error('fictional cold interruption');
      },
    }),
    /fictional cold interruption/,
  );
  assert.equal(checkpoints, 1);
  assert.equal(intakeDiscoveryRevision(db), frontier);
  assert.throws(() => maximumIntakeDiscoveryOrder(db), /semantic indexes.*incomplete/);
  const built = await prepareIntakeLookupIndices(db);
  assert.equal(built.prepared, 1);
  assert.equal(built.reused, 0);
  assert.equal(built.discoveryRevision, frontier);
  assert.equal(maximumIntakeDiscoveryOrder(db), 18);
  assert.deepEqual(retainedIntakeAcceptance(db, 'one'), {
    receipt: { operationId: 'one' },
    marker: 'first',
  });
  assert.equal(indexedIntakeIdentityConfirmations(db).length, 17);
  assert.equal(intakeWorkCounters(db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, before.warm.materializationReads);
  const reused = await prepareIntakeLookupIndices(db, {
    onCheckpoint() {
      throw Error('current index must not rebuild');
    },
  });
  assert.equal(reused.prepared, 0);
  assert.equal(reused.reused, 1);
  const view = openIntakeCollectionEnvelope(db, source);
  const intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow')!;
  const group = view.childAt(workflow, 'reportGroups', 1)!;
  assert.throws(
    () =>
      transaction(db, () => {
        const operationId = randomUUID();
        stageIntakeEnvelopeFieldMutation(
          db,
          source,
          prepareIntakeEnvelopeFieldMutation(db, source, {
            reader: view,
            record: group,
            field: 'discoveryOrder',
            jsonText: '90',
            operationId,
            requestDigest: createHash('sha256').update(operationId).digest('hex'),
            domainVersion: 0,
          }),
        );
        try {
          assertIntakeDiscoveryRevision(db, built.discoveryRevision);
        } catch {
          /* A caught refusal must still abort. */
        }
      }),
    /source frontier changed/,
  );
  assert.equal(maximumIntakeDiscoveryOrder(db), 18);
  assertIntakeDiscoveryRevision(db, built.discoveryRevision);
});

test('proposal discovery publication examines only appended SQL-first groups and preserves shadowed raw scopes', async (t) => {
  for (const shadowed of [false, true]) {
    const groups = Array.from({ length: 24 }, (_, i) => ({ discoveryOrder: i }));
    const workflow = JSON.stringify({
      reportGroups: groups,
      reportAcceptances: [],
      identityConfirmations: [],
    });
    const raw = shadowed
      ? '{"intake":{"version":0,"workflow":' +
        workflow +
        ',"workflow":{"reportGroups":[],"reportAcceptances":[],"identityConfirmations":[]}}}'
      : '{"intake":{"version":0,"workflow":' + workflow + '}}';
    const { db, source } = await fixture(t, raw);
    await prepareIntakeLookupIndices(db);
    const before = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' });
    const writer = openIntakeCollectionEnvelope(db, source);
    const workflowRecord = writer.child(writer.child(writer.root(), 'intake')!, 'workflow')!;
    const operationId = randomUUID();
    let visited = 0;
    const prepared = await prepareIntakeEnvelopeMutation(db, source, {
      reader: writer,
      operationId,
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      domainVersion: writer.logical.domainVersion + 1,
      changes: [
        {
          op: 'append',
          record: workflowRecord,
          field: 'reportGroups',
          jsonText: '{"discoveryOrder":"00041fictional"}',
        },
      ],
      prepareDerived: async (derived) => {
        const after = derived.reader.subtree(derived.reader.root(), { fieldSelection: 'first' });
        const lastWorkflow = derived.reader.child(
          derived.reader.child(derived.reader.root(), 'intake')!,
          'workflow',
        )!;
        const changed = derived.reader.childAt(
          lastWorkflow,
          'reportGroups',
          derived.reader.childCount(lastWorkflow, 'reportGroups') - 1,
        )!;
        const originalBefore = before.childAt;
        before.childAt = () => {
          throw Error('warm update must not walk old groups');
        };
        const originalAfter = after.childAt;
        after.childAt = (...args) => {
          visited++;
          return originalAfter(...args);
        };
        if (!shadowed) {
          assert.throws(
            () => [
              ...proposalLookupIndexContributions(db, before, after, [], {
                source,
                unchangedLookupScopes: true,
              }),
            ],
            /unaccounted/,
          );
        }
        visited = 0;
        const contributions = [
          ...proposalLookupIndexContributions(
            db,
            before,
            after,
            [derived.reader.address(changed)],
            { source, unchangedLookupScopes: true },
          ),
        ];
        before.childAt = originalBefore;
        return [
          ...contributions.map((entry) => ({
            area: 'builds' as const,
            collection: 'lookup.indexes',
            op: 'put' as const,
            key: schemaKey(entry.index, ...entry.key),
            value: after.address(entry.target!),
          })),
          {
            area: 'builds',
            collection: 'lookup.indexes',
            op: 'put',
            key: 'complete',
            value: JSON.stringify(derived.logical),
          },
        ];
      },
    });
    assert.equal(visited, shadowed ? 0 : 1);
    assert.equal(maximumIntakeDiscoveryOrder(db), 23);
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(prepared.prepared!));
    const emitted = Array.from(
      (await import('../intake-collection-envelope.ts')).iterateIntakeEnvelopeText(db, source),
    ).join('');
    const oracle = db
      .prepare(
        "SELECT MAX(CAST(json_extract(j.value,'$.discoveryOrder') AS INTEGER)) n FROM json_each(?,'$.intake.workflow.reportGroups') j",
      )
      .get(emitted)!.n;
    assert.equal(maximumIntakeDiscoveryOrder(db), oracle);
    assert.equal(oracle, shadowed ? 23 : 41);
  }
});

test('native acceptance delta retains SQL-first duplicate operation bytes and appends ordered identity points without reading historical receipts', async (t) => {
  const { acceptanceLookupIndexContributions } = await import('../intake-lookup-proposal.ts');
  for (const shadowed of [false, true]) {
    const initial = {
      reportGroups: [{ discoveryOrder: 7 }],
      reportAcceptances: [{ receipt: { operationId: 'old' }, marker: 'old-first' }],
      identityConfirmations: [{ marker: 'old-identity' }],
    };
    const raw =
      '{"intake":{"version":0,"workflow":' +
      JSON.stringify(initial) +
      (shadowed ? ',"workflow":' + JSON.stringify(initial) : '') +
      '}}';
    const { db, source } = await fixture(t, raw);
    await prepareIntakeLookupIndices(db);
    const before = openIntakeCollectionEnvelope(db, source, { fieldSelection: 'first' }),
      view = openIntakeCollectionEnvelope(db, source);
    const workflow = view.child(view.child(view.root(), 'intake')!, 'workflow')!;
    let visited = 0;
    const appended = [
      { receipt: { operationId: 'old' }, marker: 'old-second' },
      { receipt: { operationId: 'new' }, marker: 'new-first' },
      { receipt: { operationId: 'new' }, marker: 'new-second' },
      { receipt: { operationId: '\ud800' }, marker: 'unqueryable' },
      { receipt: { operationId: '�' }, marker: 'replacement' },
    ];
    const prepared = await prepareIntakeEnvelopeMutation(db, source, {
      reader: view,
      operationId: randomUUID(),
      requestDigest: createHash('sha256').update(raw).digest('hex'),
      domainVersion: 1,
      changes: [
        ...appended.map((item) => ({
          op: 'append' as const,
          record: workflow,
          field: 'reportAcceptances',
          jsonText: JSON.stringify(item),
        })),
        {
          op: 'append',
          record: workflow,
          field: 'identityConfirmations',
          jsonText: '{"marker":"new-identity"}',
        },
      ],
      async prepareDerived(derived) {
        const after = derived.reader.subtree(derived.reader.root(), { fieldSelection: 'first' }),
          lastWorkflow = derived.reader.child(
            derived.reader.child(derived.reader.root(), 'intake')!,
            'workflow',
          )!;
        const reportAcceptanceAddresses = Array.from({ length: appended.length }, (_, i) =>
          derived.reader.address(derived.reader.childAt(lastWorkflow, 'reportAcceptances', i + 1)!),
        );
        const identityReceiptAddresses = [
          derived.reader.address(derived.reader.childAt(lastWorkflow, 'identityConfirmations', 1)!),
        ];
        const oldChildAt = before.childAt;
        before.childAt = () => {
          throw Error('warm acceptance must not read old receipts');
        };
        const nextChildAt = after.childAt;
        after.childAt = (...args) => {
          visited++;
          return nextChildAt(...args);
        };
        const entries = [
          ...acceptanceLookupIndexContributions(db, before, after, [], {
            source,
            reportAcceptanceAddresses,
            identityReceiptAddresses,
          }),
        ];
        before.childAt = oldChildAt;
        return [
          ...entries.map((entry) => ({
            area: 'builds' as const,
            collection: 'lookup.indexes',
            op: 'put' as const,
            key: schemaKey(entry.index, ...entry.key),
            value: entry.target ? after.address(entry.target) : 'null',
          })),
          {
            area: 'builds',
            collection: 'lookup.indexes',
            op: 'put',
            key: 'complete',
            value: JSON.stringify(derived.logical),
          },
        ];
      },
    });
    transaction(db, () => selectedEnvelopeStore(db, source).collections.stage(prepared.prepared!));
    assert.equal(visited, shadowed ? 0 : 6);
    const emitted = [
      ...(await import('../intake-collection-envelope.ts')).iterateIntakeEnvelopeText(db, source),
    ].join('');
    for (const operation of ['old', 'new', '�']) {
      const oracle = db
        .prepare(
          "SELECT j.value FROM json_each(?,'$.intake.workflow.reportAcceptances') j WHERE json_extract(j.value,'$.receipt.operationId')=? LIMIT 1",
        )
        .get(emitted, operation);
      assert.deepEqual(
        retainedIntakeAcceptance(db, operation),
        oracle ? JSON.parse(String(oracle.value)) : null,
      );
    }
    assert.equal([...iterateIntakeIdentityReferences(db)].length, shadowed ? 1 : 2);
    assert.equal(maximumIntakeDiscoveryOrder(db), 7);
  }
});
