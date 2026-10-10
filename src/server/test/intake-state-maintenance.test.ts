import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clinicalReviewRevision,
  openDatabase,
  revision,
  transaction,
  observeTransactionOutcome,
  type TransactionOutcome,
  type Database,
} from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  recordDurabilityStatus,
  type RecordStorage,
} from '../record-versions.ts';
import {
  clearIntakeStateCache,
  createIntakeStateStorage,
  type IntakeCollectionChange,
} from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { intakeSourcePinKey } from '../intake-source-pin.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { readIntakeEnvelopeMaterialized } from '../intake-authority.ts';
import { reviewIntake, uploadIntake } from '../intake.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import {
  clearIntakeMaintenancePublications,
  prepareIntakeMaintenancePublication,
  type IntakeMaintenanceWrite,
} from '../intake-state-maintenance.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-intake-maintenance-'));
  const identity = {
    profileId: 'fictional-maintenance',
    intakeId: 'fictional-package',
    sourceHash: '4'.repeat(64),
  };
  const objects = new Map<string, Buffer>();
  let failPublication = false;
  const backend: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, value) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
    },
    publishHead(value) {
      objects.set('head', Buffer.from(value));
      if (failPublication) throw Error('fictional uncertain publication');
    },
  };
  const db = openDatabase(join(root, 'current.sqlite'), identity.profileId);
  const databases: Database[] = [db];
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, 'fictional.zip', identity.sourceHash, 0, 'intake_original', '{}');
  db.prepare(
    'INSERT INTO notes(id,kind,status,title,content,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    'fictional-note',
    'note',
    'editable',
    'Fictional note',
    'Retained',
    '2026-10-03',
    '2026-10-03',
  );
  attachRecordDurability(db, { profileId: identity.profileId, storage: backend });
  const store = () => createIntakeStateStorage(db, identity).collections;
  const initial = store().prepare(store().openView(), {
    operationId: randomUUID(),
    requestDigest: digest('initial'),
    domainVersion: 1,
    changes: [{ area: 'logical', collection: 'facts', op: 'put', key: 'review', value: 'pending' }],
  });
  transaction(db, () => store().stage(initial));
  t.after(() => {
    for (const item of databases) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    identity,
    store,
    uncertain: () => {
      failPublication = true;
    },
    rebuild: () => {
      failPublication = false;
      const path = join(root, randomUUID() + '.sqlite');
      rebuildRecordDatabase(path, { profileId: identity.profileId, storage: backend });
      const next = openDatabase(path, identity.profileId);
      databases.push(next);
      attachRecordDurability(next, { profileId: identity.profileId, storage: backend });
      return next;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function prepare(f: Fixture, changes?: IntakeCollectionChange[], domainVersion = 1) {
  const operationId = randomUUID();
  const requestDigest = digest(operationId);
  const prepared = f.store().prepare(f.store().openView(), {
    operationId,
    requestDigest,
    domainVersion,
    changes: changes ?? [
      { area: 'builds', collection: 'inventory', op: 'append', value: 'fictional member' },
    ],
  });
  return { prepared, operationId, requestDigest };
}

/** Use real codec/staging output for transaction-boundary fault injection.
 * Rollback exposes no selected or durable candidate; no storage author test
 * hook or hand-forged tree is needed to exercise a misclassified caller write. */
function candidate(f: Fixture, changes?: IntakeCollectionChange[], domainVersion = 1) {
  const p = prepare(f, changes, domainVersion);
  const description = f.store().inspectPrepared(p.prepared);
  const writes: IntakeMaintenanceWrite[] = [];
  const rollback = new Error('fictional candidate probe rollback');
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.store().stage(p.prepared);
        for (const row of f.db.prepare('SELECT entity,record_id FROM __record_changed').iterate()) {
          assert.equal(row.entity, 'app_meta');
          const [key] = JSON.parse(String(row.record_id)) as [string];
          const value = f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
          assert.equal(typeof value, 'string');
          writes.push({ key, value: value as string });
        }
        throw rollback;
      }),
    (error) => error === rollback,
  );
  assert.ok(description.beforeHead);
  return {
    identity: f.identity,
    beforeHead: description.beforeHead,
    afterHead: description.afterHead,
    writes,
    result: description.result,
    operationId: p.operationId,
    fingerprint: `fictional-maintenance:${p.requestDigest}`,
  };
}
type Candidate = ReturnType<typeof candidate>;
function write(db: Database, c: Candidate) {
  for (const row of c.writes)
    db.prepare(
      'INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(row.key, row.value);
  return structuredClone(c.result);
}
function operation(
  c: Candidate,
  capability: ReturnType<typeof prepareIntakeMaintenancePublication>,
) {
  return { operationId: c.operationId, fingerprint: c.fingerprint, intakeMaintenance: capability };
}

test('only successful verified maintenance emits its trusted outcome marker', (t) => {
  const f = fixture(t),
    outcomes: TransactionOutcome[] = [];
  const stop = observeTransactionOutcome(f.db, (outcome) => outcomes.push(outcome));
  t.after(stop);
  f.store().commitMaintenance(prepare(f).prepared);
  assert.equal(outcomes.at(-1)?.intakeMaintenance, true);
  assert.equal(outcomes.at(-1)?.committed, true);
  assert.equal(outcomes.at(-1)?.succeeded, true);
  transaction(f.db, () => {}, { actor: 'intake-maintenance' });
  assert.equal(outcomes.at(-1)?.intakeMaintenance, undefined);
  assert.throws(() => transaction(f.db, () => {}, { intakeMaintenance: {} as never }));
  assert.equal(outcomes.at(-1)?.intakeMaintenance, undefined);
  assert.equal(outcomes.at(-1)?.committed, false);
  const staged = prepare(f);
  f.uncertain();
  assert.throws(
    () => f.store().commitMaintenance(staged.prepared),
    /fictional uncertain publication/,
  );
  assert.equal(outcomes.at(-1)?.intakeMaintenance, undefined);
  assert.equal(outcomes.at(-1)?.succeeded, false);
});

test('actual auxiliary checkpoints and no-op receipts preserve clinical revision and survive rebuild', (t) => {
  const f = fixture(t);
  const before = f.store().binding(f.store().openView())!;
  const clinical = clinicalReviewRevision(f.db);
  const general = revision(f.db);
  const first = prepare(f);
  const result = f.store().commitMaintenance(first.prepared);
  const noop = prepare(f, []);
  f.store().commitMaintenance(noop.prepared);
  assert.equal(clinicalReviewRevision(f.db), clinical);
  assert.equal(revision(f.db), general + 2);
  assert.deepEqual(f.store().binding(f.store().openView())!.logical, before.logical);
  assert.deepEqual(f.store().replay(first.operationId, first.requestDigest), result);
  const rebuilt = f.rebuild();
  const recovered = createIntakeStateStorage(rebuilt, f.identity).collections;
  assert.equal(clinicalReviewRevision(rebuilt), clinical);
  assert.deepEqual(recovered.replay(first.operationId, first.requestDigest), result);
  assert.equal(
    recovered.range(recovered.openView(), 'builds', 'inventory', { items: 10, bytes: 1000 }).items
      .length,
    1,
  );
  // The global revision is a real clinical review-token input. Ordinary edits
  // must still stale that input; a capability is not a general actor exemption.
  transaction(rebuilt, () => {
    rebuilt.prepare("UPDATE notes SET content='Reviewed change' WHERE id='fictional-note'").run();
  });
  assert.equal(clinicalReviewRevision(rebuilt), clinical + 1);
});

for (const fault of [
  'clinical',
  'restored-clinical',
  'source-pin',
  'foreign-key',
  'missing-write',
  'wrong-readback',
  'schema',
] as const) {
  test(`auxiliary guard rejects ${fault} and rolls back the selected candidate`, (t) => {
    const f = fixture(t);
    const c = candidate(f);
    const capability = prepareIntakeMaintenancePublication(f.db, c);
    const before = revision(f.db);
    const clinical = clinicalReviewRevision(f.db);
    assert.throws(
      () =>
        transaction(
          f.db,
          () => {
            if (fault === 'missing-write') {
              const omitted = c.writes.find(
                (row) => row.key !== intakeNamespace(f.identity) + 'head',
              )!;
              write(f.db, { ...c, writes: c.writes.filter((row) => row !== omitted) });
            } else write(f.db, c);
            if (fault === 'clinical' || fault === 'restored-clinical') {
              f.db
                .prepare("UPDATE notes SET content='Unapproved change' WHERE id='fictional-note'")
                .run();
              if (fault === 'restored-clinical')
                f.db.prepare("UPDATE notes SET content='Retained' WHERE id='fictional-note'").run();
            } else if (fault === 'source-pin') {
              f.db
                .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
                .run(intakeSourcePinKey(f.identity.intakeId), '{}');
            } else if (fault === 'foreign-key') {
              f.db
                .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
                .run('fictional-unrelated', 'changed');
            } else if (fault === 'wrong-readback') {
              f.db
                .prepare('UPDATE app_meta SET value=? WHERE key=?')
                .run('{}', intakeNamespace(f.identity) + 'head');
            } else if (fault === 'schema')
              f.db.exec('CREATE TEMP TABLE fictional_injected(value TEXT)');
            return c.result;
          },
          operation(c, capability),
        ),
      /Intake maintenance publication/,
    );
    assert.equal(revision(f.db), before);
    assert.equal(clinicalReviewRevision(f.db), clinical);
    assert.equal(
      f.db.prepare("SELECT content FROM notes WHERE id='fictional-note'").get()!.content,
      'Retained',
    );
    assert.equal(
      f.db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(intakeNamespace(f.identity) + 'head')!.value,
      c.beforeHead,
    );
    assert.equal(f.store().replay(c.operationId, digest(c.operationId)), undefined);
  });
}

test('maintenance rejects domain changes, forged, foreign, expired, stale and consumed capabilities', (t) => {
  const f = fixture(t);
  const domain = candidate(
    f,
    [{ area: 'logical', collection: 'facts', op: 'put', key: 'review', value: 'changed' }],
    2,
  );
  assert.throws(() => prepareIntakeMaintenancePublication(f.db, domain), /changed logical state/);
  const c = candidate(f);
  const capability = prepareIntakeMaintenancePublication(f.db, c);
  const other = fixture(t);
  assert.throws(
    () => transaction(other.db, () => write(other.db, c), operation(c, capability)),
    /foreign/,
  );
  assert.throws(
    () => transaction(f.db, () => write(f.db, c), operation(c, {} as typeof capability)),
    /foreign/,
  );
  clearIntakeMaintenancePublications(f.db);
  assert.throws(() => transaction(f.db, () => write(f.db, c), operation(c, capability)), /expired/);
  const stale = prepareIntakeMaintenancePublication(f.db, c);
  const another = prepare(f);
  f.store().commitMaintenance(another.prepared);
  assert.throws(() => transaction(f.db, () => write(f.db, c), operation(c, stale)), /stale/);
  const current = candidate(f);
  const once = prepareIntakeMaintenancePublication(f.db, current);
  transaction(f.db, () => write(f.db, current), operation(current, once));
  assert.throws(
    () => transaction(f.db, () => write(f.db, current), operation(current, once)),
    /consumed/,
  );
});

test('an uncertain auxiliary publication cannot reuse its preparation and rebuild preserves its exact result', (t) => {
  const f = fixture(t);
  const p = prepare(f);
  const clinical = clinicalReviewRevision(f.db);
  f.uncertain();
  assert.throws(() => f.store().commitMaintenance(p.prepared), /fictional uncertain publication/);
  assert.throws(() => f.store().commitMaintenance(p.prepared));
  const rebuilt = f.rebuild();
  const recovered = createIntakeStateStorage(rebuilt, f.identity).collections;
  assert.equal(clinicalReviewRevision(rebuilt), clinical);
  assert.ok(recovered.replay(p.operationId, p.requestDigest));
  assert.equal(
    recovered.range(recovered.openView(), 'builds', 'inventory', { items: 10, bytes: 1000 }).items
      .length,
    1,
  );
});

test('a real pending clinical review keeps its exact token across the legacy bridge and inventory checkpoints', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-review-checkpoint-'));
  const profileId = 'fictional-review-checkpoint';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const document = {
    format: 'health-record-v1',
    id: 'fictional-review-document',
    kind: 'document',
    payload: { transcript: 'Independently fictional source transcript.', date: null },
    subject: 'unknown',
    uncertainties: ['The date is unknown'],
    provenance: {
      capturedVia: 'Fictional export',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator: 'fictional source record 1',
    },
    coverage: { status: 'partial', notes: ['Fictional scope remains partial'] },
  };
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-review.jsonl',
    newProviderName: 'Fictional source',
    bytes: Buffer.from(JSON.stringify(document)),
  });
  const before = reviewIntake(db, root, profileId, source.id);
  assert.equal(before.records.length, 1);
  assert.ok(before.reviewToken);
  const clinical = clinicalReviewRevision(db);
  const identity = { profileId, intakeId: source.id, sourceHash: source.sha256 };
  const store = createIntakeStateStorage(db, identity).collections;
  const status = recordDurabilityStatus(db);
  assert.ok(status?.configured && !status.dirty && !status.conflicted);
  assert.ok(db.prepare('SELECT head_json FROM __record_state WHERE singleton=1').get());
  // The completed review and this direct bridge are separate operations.
  ensureIntakeFrontierObserver(db);
  const envelope = readIntakeEnvelopeMaterialized(db, { id: source.id }).value as {
    intake: { version: number };
  };
  store.commitMaintenance(
    store.prepareLegacyBridge({
      operationId: randomUUID(),
      requestDigest: digest('fictional review bridge'),
      domainVersion: envelope.intake.version,
    }),
  );
  for (let ordinal = 0; ordinal < 3; ordinal++) {
    store.commitMaintenance(
      store.prepare(store.openView(), {
        operationId: randomUUID(),
        requestDigest: digest('fictional checkpoint ' + ordinal),
        domainVersion: envelope.intake.version,
        changes: [
          {
            area: 'builds',
            collection: 'fictional.inventory',
            op: 'append',
            value: String(ordinal),
          },
        ],
      }),
    );
    const after = reviewIntake(db, root, profileId, source.id);
    assert.equal(after.reviewToken, before.reviewToken);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.records, before.records);
    assert.equal(clinicalReviewRevision(db), clinical);
  }
  transaction(db, () => {
    db.prepare("UPDATE providers SET name='Fictional revised source' WHERE id=?").run(
      source.providerId,
    );
  });
  assert.notEqual(reviewIntake(db, root, profileId, source.id).reviewToken, before.reviewToken);
  clearIntakeStateCache(db);
  const workBefore = intakeWorkCounters(db);
  assert.equal(intakeSourceVersion(db, source.id).version, before.version);
  transaction(db, () => {
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      intakeSourcePinKey(source.id),
      JSON.stringify({
        revisionId: 'fictional-source-text',
        dependencyToken: 'fictional-dependency',
        requiresInterpretation: true,
        version: 2,
      }),
    );
  });
  const pinned = intakeSourceVersion(db, source.id);
  assert.equal(pinned.rawVersion, envelope.intake.version);
  assert.equal(pinned.version, before.version + 2);
  assert.equal(pinned.sourcePin?.revisionId, 'fictional-source-text');
  const workAfter = intakeWorkCounters(db);
  assert.equal(workAfter.warm.envelopeHydrations, workBefore.warm.envelopeHydrations);
  assert.equal(workAfter.primitive.coldReconstructions, workBefore.primitive.coldReconstructions);
});

for (const count of [4, 48])
  test(`maintenance metadata SQL is prepared per phase, not per affected row: ${count} entries`, (t) => {
    const f = fixture(t);
    const changes: IntakeCollectionChange[] = Array.from({ length: count }, (_, index) => ({
      area: 'builds',
      collection: 'fictional.preparation',
      op: 'put',
      key: `entry-${String(index).padStart(4, '0')}`,
      value: `Fictional reviewed entry ${index}`,
    }));
    const c = candidate(f, changes);
    const sql = 'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?';
    const prepare = f.db.prepare;
    let preparations = 0;
    const reads: string[] = [];
    const probe = t.mock.method(f.db, 'prepare', function (this: Database, query: string) {
      const statement = prepare.call(this, query);
      if (query === sql) {
        preparations++;
        const get = statement.get;
        statement.get = (...args: unknown[]) => {
          reads.push(String(args[0]));
          return Reflect.apply(get, statement, args) as ReturnType<typeof get>;
        };
      }
      return statement;
    });
    let prepareCount = 0,
      prepareReads = 0,
      publishCount = 0,
      publishReads = 0;
    const clinical = clinicalReviewRevision(f.db);
    try {
      const capability = prepareIntakeMaintenancePublication(f.db, c);
      prepareCount = preparations;
      prepareReads = reads.length;
      const nodes = c.writes.filter((row) => row.key !== intakeNamespace(f.identity) + 'head');
      assert.equal(prepareReads, nodes.length + 3, 'every new node plus head/owner/pin is read');
      assert.deepEqual(
        reads.slice(3),
        nodes.map((row) => row.key),
        'all immutable collision checks remain ordered',
      );
      preparations = 0;
      reads.length = 0;
      const result = transaction(f.db, () => write(f.db, c), operation(c, capability));
      assert.deepEqual(result, c.result);
      publishCount = preparations;
      publishReads = reads.length;
      assert.equal(
        publishReads,
        c.writes.length + 6,
        'entry, source, every changed row and final HEAD remain checked',
      );
      assert.equal(clinicalReviewRevision(f.db), clinical);
      for (const row of c.writes)
        assert.equal(
          f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(row.key)?.value,
          row.value,
        );
    } finally {
      probe.mock.restore();
    }
    const rebuilt = f.rebuild();
    for (const row of c.writes)
      assert.equal(
        rebuilt.prepare('SELECT value FROM app_meta WHERE key=?').get(row.key)?.value,
        row.value,
      );
    assert.equal(clinicalReviewRevision(rebuilt), clinical);
    t.diagnostic(
      JSON.stringify({
        count,
        writes: c.writes.length,
        prepareCount,
        prepareReads,
        publishCount,
        publishReads,
      }),
    );
    assert.equal(prepareCount, 1, 'one lazy length-check statement for preparation');
    assert.equal(
      publishCount,
      2,
      'independent statements for entry and readback; none cross phases',
    );
  });

test('metadata statement scopes tolerate nested preparation and do not outlive TEMP rebinding', (t) => {
  const f = fixture(t);
  const c = candidate(f);
  let entered = false;
  let nested: ReturnType<typeof prepareIntakeMaintenancePublication> | undefined;
  f.db.function('fictional_nested_metadata', (value) => {
    if (!entered) {
      entered = true;
      nested = prepareIntakeMaintenancePublication(f.db, c);
    }
    return value;
  });
  f.db.exec(`CREATE TEMP VIEW app_meta AS SELECT key,
    CASE WHEN key='owner_profile_id' THEN fictional_nested_metadata(value) ELSE value END AS value
    FROM main.app_meta`);
  const capability = prepareIntakeMaintenancePublication(f.db, c);
  assert.equal(entered, true);
  assert.ok(nested, 'nested validation completes with an independent statement scope');
  f.db.exec('DROP VIEW temp.app_meta');
  const result = transaction(f.db, () => write(f.db, c), operation(c, capability));
  assert.deepEqual(result, c.result);
  assert.throws(() => transaction(f.db, () => write(f.db, c), operation(c, nested!)), /stale/);
});

test('metadata statements never replace later size and immutable collision checks with earlier values', (t) => {
  const f = fixture(t);
  const c = candidate(f);
  let calls = 0;
  const target = c.writes.find((row) => row.key !== intakeNamespace(f.identity) + 'head')!;
  const prepare = f.db.prepare;
  const probe = t.mock.method(f.db, 'prepare', function (this: Database, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === 'SELECT length(CAST(value AS BLOB)) AS bytes FROM app_meta WHERE key=?') {
      const get = statement.get;
      statement.get = (...args: unknown[]) => {
        calls++;
        if (String(args[0]) === target.key) {
          // A later read must see a row which did not exist at phase entry.
          prepare
            .call(f.db, 'INSERT INTO app_meta(key,value) VALUES(?,?)')
            .run(target.key, 'changed fictional node');
        }
        return Reflect.apply(get, statement, args) as ReturnType<typeof get>;
      };
    }
    return statement;
  });
  try {
    assert.throws(() => prepareIntakeMaintenancePublication(f.db, c), /immutable collision/);
    assert.ok(calls > 3);
  } finally {
    probe.mock.restore();
    f.db.prepare('DELETE FROM app_meta WHERE key=?').run(target.key);
  }
});
