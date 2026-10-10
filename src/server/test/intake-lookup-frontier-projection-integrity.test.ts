import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { buildVerifiedWorkflowSummary } from '../intake-workflow-state.ts';
import {
  openIntakeCollectionEnvelope,
  prepareIntakeEnvelopeFieldMutation,
  stageIntakeEnvelopeFieldMutation,
} from '../intake-collection-envelope.ts';
import {
  intakeDiscoveryRevision,
  prepareIntakeLookupIndices,
  preparedIntakeDiscoveryRevision,
  preparedIntakeLookupReadToken,
} from '../intake-lookup-state.ts';
import {
  maximumIntakeDiscoveryOrder,
  nativeIntakeLookupCatalogHeadBindingsEqual,
  retainedIntakeAcceptance,
} from '../intake-lookup-projection.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

test('a forged disposable projection cannot override a complete native lookup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-frontier-integrity-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    'fictional-selected',
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          reportGroups: [{ discoveryOrder: 3 }],
          reportAcceptances: [{ receipt: { operationId: 'fictional-operation' }, marker: 'real' }],
        },
      },
    }),
  );
  await buildIntakeCollectionEnvelope(db, { id: 'fictional-selected' });
  await buildVerifiedWorkflowSummary(
    db,
    { id: 'fictional-selected' },
    {
      mappingVersion: 'fictional-v1',
      isSourceContextVersion: () => false,
    },
  );
  await prepareIntakeLookupIndices(db);
  assert.equal(maximumIntakeDiscoveryOrder(db), 3);
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-operation'), {
    receipt: { operationId: 'fictional-operation' },
    marker: 'real',
  });

  db.prepare(
    `INSERT INTO __record_intake_lookup_sources
      VALUES('forged-source',0,'intake_original',NULL,NULL,NULL)`,
  ).run();
  db.prepare('INSERT INTO __record_intake_lookup_groups VALUES(?,0,999)').run('forged-source');
  db.prepare('INSERT INTO __record_intake_lookup_payloads VALUES(?,?)').run(
    'forged-payload',
    JSON.stringify({ receipt: { operationId: 'fictional-operation' }, marker: 'forged' }),
  );
  db.prepare('INSERT INTO __record_intake_lookup_acceptances VALUES(?,?,?)').run(
    'forged-source',
    'fictional-operation',
    'forged-payload',
  );

  const maximum = maximumIntakeDiscoveryOrder(db);
  const receipt = retainedIntakeAcceptance(db, 'fictional-operation');
  t.diagnostic(
    JSON.stringify({ maximum, receiptMarker: (receipt as { marker?: string })?.marker }),
  );
  assert.notEqual(maximum, 999);
  assert.notDeepEqual(receipt, {
    receipt: { operationId: 'fictional-operation' },
    marker: 'forged',
  });
  db.exec('CREATE TEMP TABLE source_files(id TEXT PRIMARY KEY)');
  assert.throws(() => maximumIntakeDiscoveryOrder(db), /protected lookup TEMP shadow/);
  db.exec('DROP TABLE source_files; CREATE TEMP TABLE app_meta(key TEXT PRIMARY KEY,value TEXT)');
  assert.throws(
    () => retainedIntakeAcceptance(db, 'fictional-operation'),
    /protected lookup TEMP shadow/,
  );
  db.exec('DROP TABLE app_meta; CREATE TEMP TABLE SOURCE_FILES(id TEXT PRIMARY KEY)');
  assert.throws(() => maximumIntakeDiscoveryOrder(db), /protected lookup TEMP shadow/);
});

test('a forged disposable projection cannot create an answer with no originals', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-empty-frontier-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(maximumIntakeDiscoveryOrder(db), 0);
  db.prepare(
    `INSERT INTO __record_intake_lookup_sources
      VALUES('forged-source',0,'intake_original',NULL,NULL,NULL)`,
  ).run();
  db.prepare('INSERT INTO __record_intake_lookup_groups VALUES(?,0,999)').run('forged-source');
  assert.equal(maximumIntakeDiscoveryOrder(db), 0);
  assert.equal(retainedIntakeAcceptance(db, 'fictional-missing'), null);
});

for (const replacement of [
  'function',
  'uppercase-function',
  'authorizer',
  'unowned-source',
  'temp-shadow',
  'uppercase-temp-shadow',
  'peer',
] as const)
  test(`replacing the managed frontier ${replacement} immediately invalidates prepared lookup proof`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-frontier-function-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
    memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    registerRawIntakeFixture(db, 'fictional-source', '{"intake":{"version":0}}');
    await buildIntakeCollectionEnvelope(db, { id: 'fictional-source' });
    const prepared = await prepareIntakeLookupIndices(db);
    assert.ok(preparedIntakeLookupReadToken(db));
    assert.equal(preparedIntakeDiscoveryRevision(db), prepared.discoveryRevision);
    if (replacement === 'function' || replacement === 'uppercase-function') {
      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name LIKE '__intake_frontier_meta_update_%' LIMIT 1",
        )
        .get()?.sql;
      const functionName = String(trigger).match(
        /SELECT\s+(__intake_frontier_event_[a-f0-9]+)/,
      )?.[1];
      assert.ok(functionName);
      db.function(
        replacement === 'uppercase-function' ? functionName.toUpperCase() : functionName,
        (_table: unknown, _op: unknown, _before: unknown, _after: unknown) => null,
      );
    } else if (replacement === 'authorizer') db.setAuthorizer(() => constants.SQLITE_OK);
    else if (replacement === 'unowned-source')
      db.prepare('UPDATE source_files SET details_json=details_json WHERE id=?').run(
        'fictional-source',
      );
    else if (replacement === 'temp-shadow')
      db.exec('CREATE TEMP TABLE source_files(id TEXT PRIMARY KEY)');
    else if (replacement === 'uppercase-temp-shadow')
      db.exec('CREATE TEMP TABLE SOURCE_FILES(id TEXT PRIMARY KEY)');
    else {
      const peer = new DatabaseSync(join(root, 'cache.sqlite'));
      try {
        peer.prepare("INSERT INTO app_meta(key,value) VALUES('fictional-peer-marker','1')").run();
      } finally {
        peer.close();
      }
    }
    assert.equal(preparedIntakeLookupReadToken(db), undefined);
    assert.equal(preparedIntakeDiscoveryRevision(db), undefined);
  });

test('a new logical head cannot reuse the old complete discovery digest', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-frontier-logical-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = { id: 'fictional-source' };
  registerRawIntakeFixture(
    db,
    source.id,
    '{"intake":{"version":0,"workflow":{"format":"health-intake-workflow-v1","reportAcceptances":[{"receipt":{"operationId":"fictional-before"}}]}}}',
  );
  await buildIntakeCollectionEnvelope(db, source);
  await buildVerifiedWorkflowSummary(db, source, {
    mappingVersion: 'fictional-v1',
    isSourceContextVersion: () => false,
  });
  const prepared = await prepareIntakeLookupIndices(db);
  const token = preparedIntakeLookupReadToken(db);
  assert.ok(token);
  assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(db, token, [source.id]), true);
  const reader = openIntakeCollectionEnvelope(db, source);
  const intake = reader.child(reader.root(), 'intake')!;
  const workflow = reader.child(intake, 'workflow')!;
  const acceptance = reader.childAt(workflow, 'reportAcceptances', 0)!;
  const receipt = reader.child(acceptance, 'receipt')!;
  const operationId = randomUUID();
  transaction(db, () => {
    stageIntakeEnvelopeFieldMutation(
      db,
      source,
      prepareIntakeEnvelopeFieldMutation(db, source, {
        reader,
        record: receipt,
        field: 'operationId',
        jsonText: '"fictional-after"',
        operationId,
        requestDigest: createHash('sha256').update(operationId).digest('hex'),
        domainVersion: 0,
      }),
    );
  });
  assert.equal(nativeIntakeLookupCatalogHeadBindingsEqual(db, token, [source.id]), false);
  assert.notEqual(intakeDiscoveryRevision(db), prepared.discoveryRevision);
  assert.equal(preparedIntakeDiscoveryRevision(db), undefined);
});

test('mixed lookup rederives legacy rows after disposable projection mutation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-mixed-frontier-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    'fictional-legacy',
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          reportGroups: [{ discoveryOrder: 11 }],
          reportAcceptances: [
            { receipt: { operationId: 'fictional-duplicate' }, marker: 'legacy' },
          ],
        },
      },
    }),
  );
  registerRawIntakeFixture(
    db,
    'fictional-native',
    JSON.stringify({
      intake: {
        version: 0,
        workflow: {
          format: 'health-intake-workflow-v1',
          reportGroups: [{ discoveryOrder: 13 }],
          reportAcceptances: [
            { receipt: { operationId: 'fictional-duplicate' }, marker: 'native' },
          ],
        },
      },
    }),
  );
  await buildIntakeCollectionEnvelope(db, { id: 'fictional-native' });
  await buildVerifiedWorkflowSummary(
    db,
    { id: 'fictional-native' },
    {
      mappingVersion: 'fictional-v1',
      isSourceContextVersion: () => false,
    },
  );
  await prepareIntakeLookupIndices(db);
  assert.equal(maximumIntakeDiscoveryOrder(db), 13);
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-duplicate'), {
    receipt: { operationId: 'fictional-duplicate' },
    marker: 'legacy',
  });
  db.prepare('UPDATE __record_intake_lookup_groups SET discovery_order=999 WHERE source_id=?').run(
    'fictional-legacy',
  );
  db.prepare('UPDATE __record_intake_lookup_sources SET source_order=999 WHERE source_id=?').run(
    'fictional-legacy',
  );
  db.prepare('UPDATE __record_intake_lookup_acceptances SET operation_id=? WHERE source_id=?').run(
    'fictional-other',
    'fictional-legacy',
  );
  db.prepare(
    `UPDATE __record_intake_lookup_payloads SET payload=? WHERE hash IN
      (SELECT hash FROM __record_intake_lookup_acceptances WHERE source_id=?)`,
  ).run(
    JSON.stringify({ receipt: { operationId: 'fictional-duplicate' }, marker: 'forged' }),
    'fictional-legacy',
  );
  assert.equal(maximumIntakeDiscoveryOrder(db), 13);
  assert.deepEqual(retainedIntakeAcceptance(db, 'fictional-duplicate'), {
    receipt: { operationId: 'fictional-duplicate' },
    marker: 'legacy',
  });
  assert.equal(retainedIntakeAcceptance(db, 'fictional-other'), null);
});
