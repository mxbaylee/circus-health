import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  clearPreparedCollectionQueues,
  prepareCollectionQueueRead,
} from '../intake-queue-native.ts';

async function preparedQueue(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-queue-lifecycle-')));
  const profileId = 'fictional-queue-owner';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPreparedCollectionQueues(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-first.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-first',
        kind: 'document',
        payload: { text: 'Independently fictional source.' },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'fictional-first',
          evidenceClass: 'provider_export',
          locator: 'page 1',
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional first',
          date: '2026-01-01',
        },
      }),
    ),
  });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareCollectionQueueRead(db, root, profileId);
  return { db, root, profileId, sourceId: source.id };
}

async function addSecondSource(fixture: Awaited<ReturnType<typeof preparedQueue>>) {
  const { db, root, profileId } = fixture;
  const another = uploadIntake(db, root, profileId, {
    filename: 'fictional-second.txt',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from('Another independently fictional source.'),
  });
  await buildIntakeCollectionEnvelope(db, { id: another.id });
}

test('profile cleanup during retained queue preparation preserves the cancellation cause', async (t) => {
  const fixture = await preparedQueue(t);
  const { db, root, profileId } = fixture;
  await addSecondSource(fixture);
  let canceled = false;
  await assert.rejects(
    prepareCollectionQueueRead(db, root, profileId, {
      assertRunning() {
        if (canceled) return;
        canceled = true;
        clearPreparedCollectionQueues(db);
        db.close();
        throw Error('fictional profile locked');
      },
    }),
    /fictional profile locked/,
  );
  assert.equal(canceled, true);
});

test('cache clear drains its active scratch and permits a fresh queue read', async (t) => {
  const originalExec = DatabaseSync.prototype.exec;
  let scratchPath: string | undefined;
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql.startsWith('CREATE TABLE sources(id TEXT PRIMARY KEY,logical TEXT,seen INTEGER)'))
      scratchPath = this.location() ?? undefined;
    return result;
  };
  let fixture: Awaited<ReturnType<typeof preparedQueue>>;
  try {
    fixture = await preparedQueue(t);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  const { db, root, profileId } = fixture;
  assert.ok(scratchPath, 'the retained queue owns a scratch database');
  await addSecondSource(fixture);
  let canceled = false;
  await assert.rejects(
    prepareCollectionQueueRead(db, root, profileId, {
      assertRunning() {
        if (canceled) return;
        canceled = true;
        clearPreparedCollectionQueues(db);
        throw Error('fictional preparation cancelled');
      },
    }),
    /fictional preparation cancelled/,
  );
  assert.equal(canceled, true);
  assert.equal(existsSync(scratchPath), false, 'the active scratch closes after cancellation');
  await prepareCollectionQueueRead(db, root, profileId);
});

test('unchanged warm queue preparation does not enumerate original source bindings', async (t) => {
  const { db, root, profileId } = await preparedQueue(t);
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalIterate = StatementSync.prototype.iterate;
  const counted = new WeakSet<StatementSync>();
  let rows = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (this === db && sql.startsWith('SELECT f.id,f.sha256 FROM source_files f'))
      counted.add(statement);
    return statement;
  };
  StatementSync.prototype.iterate = function* (...args) {
    for (const row of Reflect.apply(originalIterate, this, args)) {
      if (counted.has(this)) rows++;
      yield row;
    }
    return undefined;
  };
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.iterate = originalIterate;
  });
  await prepareCollectionQueueRead(db, root, profileId);
  assert.equal(rows, 0);
  // A supported policy replacement has no SQL change count, but revokes the private proof.
  db.setAuthorizer(null);
  await prepareCollectionQueueRead(db, root, profileId);
  assert.equal(rows, 2, 'revoked warm proof requires both complete source binding checks');
});
