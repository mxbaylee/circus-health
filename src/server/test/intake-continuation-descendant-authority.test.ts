import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { openDatabase, transaction } from '../database.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess } from '../intake-retained-plan.ts';
import {
  openCollectionConversion,
  prepareManualCollectionDescendantRead,
} from '../intake-continuation-collection.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext, descendant: boolean) {
  const profileId = 'fictional-ancestry';
  const db = openDatabase(':memory:', profileId);
  memoryRecordAuthority(db);
  t.after(() => db.close());
  transaction(db, () => {
    registerRawIntakeFixture(
      db,
      'fictional-root',
      JSON.stringify({
        intake: {
          version: 0,
          workflow: {
            plans: [
              {
                id: 'fictional-plan',
                status: 'active',
                units: [{ id: 'fictional-unit', kind: 'text', status: 'pending' }],
              },
            ],
          },
        },
      }),
    );
    registerRawIntakeFixture(db, 'fictional-unrelated', JSON.stringify({ intake: { version: 0 } }));
    for (let n = 0; n < 65; n++) {
      registerRawIntakeFixture(
        db,
        'fictional-chain-' + n,
        JSON.stringify({
          intake: {
            version: 0,
            parentSourceFileId:
              n === 64
                ? descendant
                  ? 'fictional-root'
                  : 'fictional-unrelated'
                : 'fictional-chain-' + (n + 1),
          },
        }),
      );
    }
  });
  await buildIntakeCollectionEnvelope(db, { id: 'fictional-root' });
  await prepareRetainedPlanAccess(db, profileId, 'fictional-root');
  const scope = openCollectionConversion(db, '/private/tmp', profileId, 'fictional-root', {
    sessionId: 'fictional-session',
  });
  assert.ok(scope);
  return { db, scope };
}

test('manual descendant capability preserves a complete real source ancestry across a host turn', async (t) => {
  const { scope } = await fixture(t, true);
  let turned = false;
  const host = setImmediate().then(() => {
    turned = true;
  });
  const capability = await prepareManualCollectionDescendantRead(scope, 'fictional-chain-0');
  await host;
  assert.ok(turned);
  assert.ok(capability);
});

test('manual descendant capability refuses a TEMP source shadow installed after a checked ancestry prefix', async (t) => {
  const { db, scope } = await fixture(t, false);
  await assert.rejects(
    prepareManualCollectionDescendantRead(scope, 'fictional-chain-0'),
    /does not belong/,
  );
  const before = db.prepare('SELECT total_changes() n').get()!.n;
  const columns = db
    .prepare('PRAGMA main.table_info(source_files)')
    .all()
    .map((row) =>
      row.name === 'details_json'
        ? "CASE WHEN id='fictional-chain-64' THEN json_set(details_json,'$.intake.parentSourceFileId','fictional-root') ELSE details_json END AS details_json"
        : '"' + row.name + '"',
    )
    .join(',');
  const host = setImmediate().then(() => {
    db.exec('CREATE TEMP VIEW source_files AS SELECT ' + columns + ' FROM main.source_files');
  });
  await assert.rejects(
    prepareManualCollectionDescendantRead(scope, 'fictional-chain-0'),
    /Retained descendant evidence changed/,
  );
  await host;
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n, before);
  assert.equal(
    db.prepare("SELECT count(*) n FROM temp.sqlite_master WHERE name='source_files'").get()!.n,
    1,
  );
});
