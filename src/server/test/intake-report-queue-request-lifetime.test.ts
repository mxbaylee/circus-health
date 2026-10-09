import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { setImmediate as immediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { createApp } from '../index.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { listIntakeReportQueue } from '../intake-report-queue.ts';
import {
  clearPreparedCollectionQueues,
  getIntakeReportQueueGroupRead,
  listIntakeReportQueueRead,
  prepareCollectionQueueRead,
} from '../intake-queue-native.ts';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function fixture(t: test.TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-report-read-life-')));
  const profileId = 'fictional-report-read-life';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const app = createApp({
    root,
    databases: new Map([[profileId, db]]),
    intakeBatchOptions: { authorized: () => false },
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/profiles/${profileId}/intakes/report-queue`;
  t.after(() => {
    app.close();
    clearPreparedCollectionQueues(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, app, base, root, profileId };
}

async function nativeReport(f: Awaited<ReturnType<typeof fixture>>) {
  const source = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-report.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-report-record',
        kind: 'document',
        payload: { text: 'Fictional selected report' },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'fictional-report-record',
          evidenceClass: 'provider_export',
          locator: 'page 1',
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional report',
          date: '2026-01-01',
        },
      }),
    ),
  });
  const groupId = listIntakeReportQueue(f.db, f.root, f.profileId).groups[0]!.groupId;
  await buildIntakeCollectionEnvelope(f.db, { id: source.id, sha256: source.sha256 });
  return { source, groupId };
}

for (const path of ['', '/fictional-group'])
  test(`disconnected ${path ? 'group' : 'page'} GET leaves no queued clinical work`, async (t) => {
    const f = await fixture(t);
    const held = gate();
    const entered = gate();
    const owner = runExclusiveClinicalOperation(f.db, async () => {
      entered.open();
      await held.wait;
    });
    t.after(held.open);
    await entered.wait;

    const route = new URL(f.base + path).pathname;
    const arrived = gate();
    const disconnected = gate();
    f.app.server.on('request', (request, response) => {
      if (request.url !== route) return;
      arrived.open();
      response.once('close', () => {
        assert.equal(response.writableFinished, false);
        disconnected.open();
      });
    });
    const events: string[] = [];
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql) => {
      if (
        sql === "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original'"
      )
        events.push('abandoned-get-work');
      return prepare(sql);
    };

    const controller = new AbortController();
    const abandoned = fetch(f.base + path, { signal: controller.signal });
    await arrived.wait;
    controller.abort();
    await assert.rejects(abandoned, { name: 'AbortError' });
    await disconnected.wait;
    const successor = runExclusiveClinicalOperation(f.db, async () => {
      events.push('successor-owner');
    });
    held.open();
    await Promise.all([owner, successor]);
    assert.deepEqual(events, ['successor-owner']);
  });

test('ordinary parsed report GET remains live through its response', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.data);
});

test('already-aborted report read performs no queue SQL', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let queries = 0;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    if (sql === "SELECT id,kind,sha256,details_json FROM source_files WHERE kind='intake_original'")
      queries++;
    return prepare(sql);
  };
  await assert.rejects(
    listIntakeReportQueueRead(
      f.db,
      f.root,
      f.profileId,
      {},
      {
        signal: controller.signal,
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(queries, 0);
});

test(
  'native preparation cancellation releases its owner and keeps the selected source',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const { source, groupId } = await nativeReport(f);
    const controller = new AbortController();
    let entered = false;
    let preparationScans = 0;
    let scratchPath: string | undefined;
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      const result = originalExec.call(this, sql);
      if (sql.startsWith('CREATE TABLE sources(id TEXT PRIMARY KEY,logical TEXT,seen INTEGER)'))
        scratchPath = this.location() ?? undefined;
      return result;
    };
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql) => {
      if (!entered && sql.includes('SELECT f.id FROM source_files f')) {
        entered = true;
        setImmediate(() => controller.abort());
      }
      if (sql.includes('SELECT f.id FROM source_files f')) preparationScans++;
      return prepare(sql);
    };
    try {
      await assert.rejects(
        getIntakeReportQueueGroupRead(
          f.db,
          f.root,
          f.profileId,
          groupId,
          {},
          {
            signal: controller.signal,
          },
        ),
        { name: 'AbortError' },
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(entered, true);
    assert.ok(scratchPath, 'native queue preparation started its disposable scratch');
    assert.equal(existsSync(scratchPath), false, 'cancelled preparation released the scratch');
    const afterCancellation = preparationScans;
    await immediate();
    assert.equal(
      preparationScans,
      afterCancellation,
      'cancelled owner left no detached queue work',
    );
    assert.equal(
      f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(source.id)?.sha256,
      source.sha256,
    );
    const resumed = await getIntakeReportQueueGroupRead(f.db, f.root, f.profileId, groupId);
    assert.ok(preparationScans > afterCancellation, 'successor re-prepared after the cancellation');
    assert.ok('format' in resumed && resumed.format === 'health-intake-report-detail-v2');
  },
);

test(
  'disconnected active native group GET releases preparation before its successor',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const { source, groupId } = await nativeReport(f);
    let scratchPath: string | undefined;
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      const result = originalExec.call(this, sql);
      if (sql.startsWith('CREATE TABLE sources(id TEXT PRIMARY KEY,logical TEXT,seen INTEGER)'))
        scratchPath = this.location() ?? undefined;
      return result;
    };
    const controller = new AbortController();
    let entered = false;
    let preparationScans = 0;
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql) => {
      if (sql.includes('SELECT f.id FROM source_files f')) {
        preparationScans++;
        if (!entered) {
          entered = true;
          setImmediate(() => controller.abort());
        }
      }
      return prepare(sql);
    };
    const route = new URL(f.base + '/' + encodeURIComponent(groupId)).pathname;
    const disconnected = gate();
    f.app.server.on('request', (request, response) => {
      if (request.url !== route) return;
      response.once('close', () => {
        assert.equal(response.writableFinished, false);
        disconnected.open();
      });
    });
    try {
      const abandoned = fetch(f.base + '/' + encodeURIComponent(groupId), {
        signal: controller.signal,
      });
      await assert.rejects(abandoned, { name: 'AbortError' });
      await disconnected.wait;
      assert.equal(entered, true);
      const successor = runExclusiveClinicalOperation(f.db, async () => {
        assert.equal(
          f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(source.id)?.sha256,
          source.sha256,
        );
      });
      await successor;
      assert.ok(scratchPath, 'active native GET allocated disposable preparation');
      assert.equal(existsSync(scratchPath), false, 'cancelled GET released its scratch');
      const afterCancellation = preparationScans;
      await immediate();
      assert.equal(
        preparationScans,
        afterCancellation,
        'no detached read continued after successor',
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
  },
);

test(
  'cancellation after queue preparation returns no detail and permits a fresh detail',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const { groupId } = await nativeReport(f);
    await prepareCollectionQueueRead(f.db, f.root, f.profileId);
    const controller = new AbortController();
    let detailStarted = false;
    const originalExec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      const result = originalExec.call(this, sql);
      if (
        !detailStarted &&
        sql.startsWith('CREATE TABLE sources(id TEXT PRIMARY KEY,pin TEXT,seen INTEGER')
      ) {
        detailStarted = true;
        controller.abort();
      }
      return result;
    };
    try {
      await assert.rejects(
        getIntakeReportQueueGroupRead(
          f.db,
          f.root,
          f.profileId,
          groupId,
          {},
          {
            signal: controller.signal,
          },
        ),
        { name: 'AbortError' },
      );
    } finally {
      DatabaseSync.prototype.exec = originalExec;
    }
    assert.equal(detailStarted, true);
    const detail = await getIntakeReportQueueGroupRead(f.db, f.root, f.profileId, groupId);
    assert.ok('format' in detail && detail.format === 'health-intake-report-detail-v2');
  },
);
