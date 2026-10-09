import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { setImmediate } from 'node:timers';
import { mkdtempSync, rmSync } from 'node:fs';
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
} from '../intake-lookup-projection.ts';
import {
  openIntakeIdentityReference,
  intakeIdentityTargetMembership,
} from '../intake-identity-reference.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
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
} from '../intake-lookup-state.ts';

const summaryOptions = { mappingVersion: 'fictional-v1', isSourceContextVersion: () => false };

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
  });
async function fixture(t: test.TestContext, raw: string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  registerRawIntakeFixture(db, 'original', raw);
  const source = { id: 'original' };
  const selected = db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(source.id)!;
  const identity = {
    profileId: 'fictional',
    intakeId: source.id,
    sourceHash: String(selected.sha256),
  };
  await buildIntakeCollectionEnvelope(db, source);
  return { db, source, identity };
}

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
  assert.throws(() => maximumIntakeDiscoveryOrder(db), /native source projection binding/);
  assert.throws(() => indexedIntakeIdentityConfirmations(db), /native source projection binding/);
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
  let checkpoints = 0;
  await assert.rejects(
    prepareIntakeLookupIndices(db, {
      onCheckpoint() {
        checkpoints++;
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
