import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  clearCollectionReportQueues,
  collectionQueueSourcesAsync,
  openCollectionReportQueue,
} from '../intake-report-group-collection.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import {
  execClinicalReviewMaintenance,
  runClinicalReviewMaintenance,
} from '../clinical-review-maintenance.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import { uploadIntake } from '../intake.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';

test('cold queue preparation and re-certification retain the original authority interval', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-queue-recertification-')),
    profileId = 'fictional-queue-recertification',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearCollectionReportQueues(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec('CREATE TEMP TABLE fictional_unrelated(value INTEGER)');
  execClinicalReviewMaintenance(
    db,
    'attention',
    'CREATE TEMP TABLE source_attention_counts_v1(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)',
  );
  for (const change of ['certified', 'TEMP ABA', 'policy', 'physical ABA'] as const) {
    // No pre-warming of the clinical cache pin: opening this queue is the cold boundary.
    const queue = await openCollectionReportQueue(db, root, profileId);
    try {
      if (change === 'certified')
        runClinicalReviewMaintenance(
          db,
          'attention',
          "INSERT INTO source_attention_counts_v1 VALUES('fictional',1)",
        );
      else if (change === 'TEMP ABA')
        db.exec('INSERT INTO fictional_unrelated VALUES(1); DELETE FROM fictional_unrelated');
      else if (change === 'policy') db.setAuthorizer(null);
      else withManagedPhysicalMutation(() => {});
      assert.throws(() => queue.assertCurrent(), { code: 'REPORT_QUEUE_CURSOR' });
      if (change === 'certified') {
        await queue.prepareCurrent();
        queue.assertCurrent();
      } else {
        await assert.rejects(queue.prepareCurrent(), { code: 'REPORT_QUEUE_CURSOR' });
        assert.throws(() => queue.assertCurrent(), { code: 'REPORT_QUEUE_CURSOR' });
      }
    } finally {
      queue.close();
      clearCollectionReportQueues(db);
    }
  }
});

test('collection source enumeration stops at its first bounded turn on cancellation and raw changes', async (t) => {
  const profileId = 'fictional-collection-source-binding';
  const db = openDatabase(':memory:', profileId);
  t.after(() => db.close());
  memoryRecordAuthority(db);
  transaction(db, () => {
    for (let index = 0; index < 130; index++) {
      const id = `fictional-${String(index).padStart(3, '0')}`;
      registerRawIntakeFixture(
        db,
        id,
        JSON.stringify({ intake: { version: 0, originalName: `${id}.txt` } }),
      );
      writeIntakeFixtureEnvelope(db, id, { intake: { version: 0, originalName: `${id}.txt` } });
    }
  });
  for (let index = 0; index < 130; index++)
    await buildIntakeCollectionEnvelope(db, { id: `fictional-${String(index).padStart(3, '0')}` });
  db.exec('CREATE TEMP TABLE fictional_drift(value)');
  for (const change of [
    'cancel',
    'source ABA',
    'TEMP ABA',
    'policy',
    'owner',
    'physical ABA',
  ] as const) {
    let canceled = false;
    const changed = new Promise<void>((resolve) =>
      setImmediate(() => {
        if (change === 'cancel') canceled = true;
        if (change === 'source ABA') {
          db.prepare(
            "UPDATE source_files SET path=path||'.changed' WHERE id='fictional-000'",
          ).run();
          db.prepare(
            "UPDATE source_files SET path='fictional-000.txt' WHERE id='fictional-000'",
          ).run();
        }
        if (change === 'TEMP ABA')
          db.exec('INSERT INTO fictional_drift VALUES(1); DELETE FROM fictional_drift;');
        if (change === 'policy') db.setAuthorizer(null);
        if (change === 'owner')
          db.prepare(
            "UPDATE app_meta SET value='fictional-other' WHERE key='owner_profile_id'",
          ).run();
        if (change === 'physical ABA') withManagedPhysicalMutation(() => {});
        resolve();
      }),
    );
    let rows = 0;
    await assert.rejects(
      async () => {
        for await (const _source of collectionQueueSourcesAsync(db, profileId, () => {
          if (canceled) throw Error('fictional cancellation');
        }))
          rows++;
      },
      change === 'cancel' ? /fictional cancellation/ : /Refresh this report queue|owner|profile/i,
    );
    await changed;
    assert.equal(rows, 64);
    if (change === 'owner')
      db.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(profileId);
  }
});

test(
  'cold 130-source queue refresh accepts certified maintenance and refuses source ABA',
  { timeout: 300_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-queue-staged-')),
      profileId = 'fictional-staged-queue',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearCollectionReportQueues(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    for (let index = 0; index < 130; index++) {
      const id = `fictional-${String(index).padStart(3, '0')}`;
      const source = uploadIntake(db, root, profileId, {
        filename: `${id}.txt`,
        newProviderName: 'Fictional clinic',
        bytes: Buffer.from(`Fictional retained source ${id}\n`),
      });
      await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
      await prepareCollectionPeopleIndex(db, root, profileId, source.id);
    }
    execClinicalReviewMaintenance(
      db,
      'attention',
      'CREATE TEMP TABLE source_attention_counts_v1(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)',
    );
    db.exec('CREATE TEMP TABLE fictional_drift(value)');
    const originalPrepare = DatabaseSync.prototype.prepare;
    let stagedPages = 0,
      intervention:
        'certified' | 'source ABA' | 'TEMP ABA' | 'policy' | 'owner' | 'physical ABA' | 'cancel' =
        'certified',
      scheduled = false,
      interventionDone: Promise<void> | undefined,
      interventionError: unknown;
    DatabaseSync.prototype.prepare = function (sql) {
      if (
        typeof sql === 'string' &&
        sql.startsWith('SELECT t.id,t.sha256,t.kind,t.details_json,t.pin FROM stagedSources t')
      ) {
        stagedPages++;
        if (!scheduled) {
          scheduled = true;
          interventionDone = new Promise<void>((resolve) =>
            setImmediate(() => {
              try {
                if (intervention === 'certified')
                  runClinicalReviewMaintenance(
                    db,
                    'attention',
                    "INSERT INTO source_attention_counts_v1 VALUES('fictional',1)",
                  );
                else if (intervention === 'source ABA') {
                  const first = db
                    .prepare(
                      "SELECT id FROM source_files WHERE kind='intake_original' ORDER BY id LIMIT 1",
                    )
                    .get()!;
                  db.prepare('UPDATE source_files SET path=path||? WHERE id=?').run(
                    '.changed',
                    first.id,
                  );
                  db.prepare(
                    'UPDATE source_files SET path=substr(path,1,length(path)-8) WHERE id=?',
                  ).run(first.id);
                } else if (intervention === 'TEMP ABA')
                  db.exec('INSERT INTO fictional_drift VALUES(1); DELETE FROM fictional_drift;');
                else if (intervention === 'policy') db.setAuthorizer(null);
                else if (intervention === 'owner')
                  db.prepare(
                    "UPDATE app_meta SET value='fictional-other' WHERE key='owner_profile_id'",
                  ).run();
                else if (intervention === 'physical ABA') withManagedPhysicalMutation(() => {});
                else clearCollectionReportQueues(db);
              } catch (error) {
                interventionError = error;
              } finally {
                resolve();
              }
            }),
          );
        }
      }
      return originalPrepare.call(this, sql);
    };
    t.after(() => {
      DatabaseSync.prototype.prepare = originalPrepare;
    });
    const openAfterIntervention = async () => {
      try {
        return await openCollectionReportQueue(db, root, profileId);
      } finally {
        await interventionDone;
        if (interventionError) throw interventionError;
      }
    };
    const queue = await openAfterIntervention();
    queue.close();
    assert.ok(stagedPages >= 3, 'all 130 staged sources are processed in bounded pages');
    assert.equal(
      db.prepare('SELECT count(*) count FROM source_attention_counts_v1').get()!.count,
      1,
    );
    for (const change of [
      'source ABA',
      'TEMP ABA',
      'policy',
      'owner',
      'physical ABA',
      'cancel',
    ] as const) {
      clearCollectionReportQueues(db);
      intervention = change;
      scheduled = false;
      stagedPages = 0;
      interventionDone = undefined;
      interventionError = undefined;
      await assert.rejects(openAfterIntervention(), /Refresh this report queue|owner|profile/i);
      assert.ok(stagedPages >= 1, `${change} reached staged source processing`);
      if (change === 'owner')
        db.prepare("UPDATE app_meta SET value=? WHERE key='owner_profile_id'").run(profileId);
    }
  },
);
