import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { openDatabase, transaction } from '../database.ts';
import { collectionQueueSourcesAsync } from '../intake-report-group-collection.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';

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
