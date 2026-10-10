import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { intakeLocatorKey } from '../intake-locator-key.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { withManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-locator-key-'));
  const db = openDatabase(join(root, 'profile.sqlite'), 'fictional-locator');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TEMP TABLE fictional_locator_probe(value TEXT); INSERT INTO fictional_locator_probe VALUES ('original')",
  );
  return db;
}
const giant = 'fictional locator\\"\n'.repeat(10000);

test('locator hashing keeps installed read policy and bounds whole-source assertions', async (t) => {
  const db = fixture(t);
  let policyReads = 0,
    sourceChecks = 0;
  db.setAuthorizer((action) => {
    if (action === constants.SQLITE_READ) policyReads++;
    return constants.SQLITE_OK;
  });
  assert.equal(
    await intakeLocatorKey(db, giant, () => {
      sourceChecks++;
    }),
    schemaKey(giant),
  );
  assert.equal(sourceChecks, 3);
  assert.ok(policyReads > 0);
});

for (const mode of [
  'saved-noop',
  'rollback',
  'policy-aba',
  'physical-epoch',
  'entry-write',
] as const) {
  test(`locator hashing refuses ${mode} without retaining its observer`, async (t) => {
    const db = fixture(t);
    const savedNoop = db.prepare("UPDATE fictional_locator_probe SET value='changed' WHERE 0");
    const mutate = () => {
      if (mode === 'saved-noop') assert.equal(savedNoop.run().changes, 0);
      else if (mode === 'rollback')
        db.exec("BEGIN; UPDATE fictional_locator_probe SET value='changed'; ROLLBACK");
      else if (mode === 'policy-aba') {
        db.setAuthorizer(() => constants.SQLITE_OK);
        db.setAuthorizer(null);
      } else if (mode === 'physical-epoch') withManagedPhysicalMutation(() => {});
      else db.prepare("UPDATE fictional_locator_probe SET value='original'").run();
    };
    let first = true;
    const tick = mode === 'entry-write' ? undefined : setImmediate(mutate);
    try {
      await assert.rejects(
        intakeLocatorKey(db, giant, () => {
          if (mode === 'entry-write' && first) {
            first = false;
            mutate();
          }
        }),
        { code: 'SOURCE_CHANGED' },
      );
    } finally {
      if (tick) clearImmediate(tick);
    }
    assert.equal(db.prepare('SELECT value FROM fictional_locator_probe').get()!.value, 'original');
    db.prepare("UPDATE fictional_locator_probe SET value='after refusal'").run();
    assert.equal(await intakeLocatorKey(db, 'new selection', () => {}), schemaKey('new selection'));
  });
}
