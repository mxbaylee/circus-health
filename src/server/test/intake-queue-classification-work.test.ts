import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { openDatabase, transaction } from '../database.ts';
import { hasNativeIntakeQueue } from '../intake-queue-native.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

test('queue classification yields across legacy originals and refuses interrupted authority', async (t) => {
  const profileId = 'fictional-queue-classification';
  const db = openDatabase(':memory:', profileId);
  t.after(() => db.close());
  memoryRecordAuthority(db);
  transaction(db, () => {
    for (let index = 0; index < 130; index++)
      registerRawIntakeFixture(
        db,
        `fictional-${index}`,
        JSON.stringify({ intake: { version: 0, originalName: 'fictional.txt' } }),
      );
  });
  let turns = 0;
  setImmediate(() => turns++);
  assert.equal(await hasNativeIntakeQueue(db, profileId), false);
  assert.ok(turns > 0);
  for (const mode of ['cancel', 'source ABA', 'TEMP ABA', 'method'] as const) {
    let stopped = false;
    const change = new Promise<void>((resolve) =>
      setImmediate(() => {
        if (mode === 'cancel') stopped = true;
        if (mode === 'source ABA')
          transaction(db, () => {
            db.exec(
              "UPDATE source_files SET path=path||'.changed'; UPDATE source_files SET path=id||'.txt'",
            );
          });
        if (mode === 'TEMP ABA')
          db.exec('CREATE TEMP TABLE fictional_shadow(value); DROP TABLE fictional_shadow');
        if (mode === 'method') db.setAuthorizer(null);
        resolve();
      }),
    );
    await assert.rejects(
      hasNativeIntakeQueue(db, profileId, () => {
        if (stopped) throw Error('fictional cancellation');
      }),
      mode === 'cancel' ? /fictional cancellation/ : /Refresh this report queue/,
    );
    await change;
  }
  await buildIntakeCollectionEnvelope(db, { id: 'fictional-129' });
  assert.equal(await hasNativeIntakeQueue(db, profileId), true);
  db.exec('CREATE TEMP TABLE source_files(id TEXT)');
  await assert.rejects(hasNativeIntakeQueue(db, profileId), /Refresh this report queue/);
});
