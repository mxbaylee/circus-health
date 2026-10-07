import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { IntakeStateManifest } from '../intake-state-manifest.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { collectionCellReader } from '../intake-collection-envelope.ts';
import { parseSchemaControl } from '../intake-envelope-schema.ts';
import { validateIntakeSchemaReachabilitySteps } from '../intake-envelope-schema-validation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  captureIntakeStateCopySnapshot,
  validateProductionIntakeAuthority,
} from '../intake-state-bootstrap.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext, records = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-manifest-batching-'));
  const profile = 'fictional-manifest';
  const db = openDatabase(join(directory, 'source.sqlite'), profile);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  const id = 'fictional-original';
  registerRawIntakeFixture(
    db,
    id,
    '{"intake":{"version":0,"state":"pending"' +
      (records > 1
        ? ',"workflow":' +
          JSON.stringify({
            format: 'health-intake-workflow-v1',
            candidates: Array.from({ length: records }, (_, index) => ({
              id: `fictional-candidate-${index}`,
              versions: [{ id: `fictional-version-${index}`, status: 'pending', occurrences: [] }],
            })),
          })
        : '') +
      '},"fictional":[{"label":"old","label":"new"}]}',
  );
  transaction(db, () => {
    db.prepare('UPDATE source_files SET path=? WHERE id=?').run(
      `data/profiles/${profile}/sources/fictional.txt`,
      id,
    );
  });
  await buildIntakeCollectionEnvelope(db, { id, kind: 'intake_original', sha256: 'a'.repeat(64) });
  return { db, profile, source: { id, kind: 'intake_original', sha256: 'a'.repeat(64) } };
}

// Count transaction boundaries, not runner-dependent elapsed time.
test('cold graph validation batches scratch writes without changing source evidence', async (t) => {
  const { db, profile } = await fixture(t);
  const before = JSON.stringify(captureIntakeStateCopySnapshot(db, profile));
  const prepare = DatabaseSync.prototype.prepare;
  let writes = 0;
  let autocommitWrites = 0;
  const probe = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        writes++;
        if (!this.isTransaction) autocommitWrites++;
      }
      return prepare.call(this, sql);
    },
  );
  try {
    validateProductionIntakeAuthority(db, profile);
  } finally {
    probe.mock.restore();
  }
  assert.ok(writes > 0, 'the complete validator exercised real scratch writes');
  assert.equal(autocommitWrites, 0, 'no scratch write starts a per-row transaction');
  assert.equal(JSON.stringify(captureIntakeStateCopySnapshot(db, profile)), before);
  t.diagnostic(JSON.stringify({ writes, autocommitWrites }));
});

test('scratch batching retains exact rows, duplicate refusal and disposal at different sizes', () => {
  for (const count of [64, 2048]) {
    const manifest = new IntakeStateManifest();
    const path = String(manifest.db.prepare('PRAGMA database_list').get()!.file);
    const expected = Array.from({ length: count }, (_, index) => ({
      key: `fictional-${String(index).padStart(6, '0')}`,
      value: 'Fictional scratch-only text '.repeat(48) + index,
    }));
    let autocommitWrites = 0;
    try {
      for (const row of expected) {
        if (!manifest.db.isTransaction) autocommitWrites++;
        manifest.put('source', row.key, row.value, 'fictional-namespace');
      }
      assert.deepEqual([...manifest.rows('source')], expected);
      const fingerprint = manifest.fingerprint();
      assert.throws(() => manifest.put('source', expected[0]!.key, 'replacement'), /duplicate/);
      assert.equal(manifest.fingerprint(), fingerprint);
      assert.deepEqual([...manifest.rows('source')], expected);
      assert.equal(manifest.db.prepare('PRAGMA temp_store').get()!.temp_store, 1);
      assert.equal(manifest.db.prepare('PRAGMA cache_size').get()!.cache_size, -2048);
      assert.equal(autocommitWrites, 0, 'a single private transaction covers all scratch rows');
    } finally {
      manifest.close();
      manifest.close();
    }
    assert.equal(manifest.db.isOpen, false);
    assert.equal(existsSync(dirname(path)), false, 'scratch files are discarded, not published');
  }
});

for (const finish of ['return', 'throw'] as const)
  test('schema scratch transaction closes on generator ' + finish, async (t) => {
    const { db, profile, source } = await fixture(t, 48);
    const selected = collectionCellReader(db, source);
    const control = parseSchemaControl(
      selected.collections.get(
        selected.collections.openView(),
        'logical',
        'envelope.control',
        'representation',
      ),
    );
    const before = JSON.stringify(captureIntakeStateCopySnapshot(db, profile));
    let scratch: DatabaseSync | undefined;
    const exec = DatabaseSync.prototype.exec;
    const probe = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        if (sql.includes('CREATE TABLE records(id TEXT PRIMARY KEY')) scratch = this;
        return exec.call(this, sql);
      },
    );
    const steps = validateIntakeSchemaReachabilitySteps(selected.store, control);
    let path = '';
    try {
      assert.equal(steps.next().done, false, 'exercise an actual cooperative yield');
      assert.ok(scratch);
      assert.equal(scratch.isTransaction, true);
      assert.equal(
        db.isTransaction,
        false,
        'only the private scratch database holds a transaction',
      );
      path = String(scratch.prepare('PRAGMA database_list').get()!.file);
      if (finish === 'throw')
        assert.throws(() => steps.throw(Error('fictional cancellation')), /fictional cancellation/);
      else assert.equal(steps.return(undefined).done, true);
      assert.equal(scratch.isOpen, false);
      assert.equal(existsSync(dirname(path)), false);
    } finally {
      steps.return(undefined);
      probe.mock.restore();
    }
    assert.equal(JSON.stringify(captureIntakeStateCopySnapshot(db, profile)), before);
  });
