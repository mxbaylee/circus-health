import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, HttpError } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake } from '../intake.ts';
import {
  buildDurablePackageInventory,
  readDurablePackageInventory,
} from '../intake-package-state.ts';
import { createPagedPackagePlan, readPackagePlanScope } from '../intake-package-plan.ts';
import { inventoryIntakePackagePaged } from '../intake-package.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';

// Nested fictional paths make every odd member descriptor exceed the 3072-byte
// inline record, so each inventory build appends several byte chunks for it.
const longName = Array.from({ length: 400 }, (_, i) => `fold-${String(i).padStart(3, '0')}`)
  .concat('fictional-long.txt')
  .join('/');
const members = 12,
  memberName = (ordinal: number) =>
    ordinal % 2 ? `fictional-${ordinal}/${longName}` : `fictional-${ordinal}.txt`;

function fixture(t: test.TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-plan-race-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture(
      Array.from({ length: members }, (_, ordinal) => ({
        name: memberName(ordinal),
        data: 'fictional ' + ordinal,
      })),
    ),
  });
  return { db, root, profileId, intake, id: intake.id };
}

/** Build the record envelope first so racing callers reach the inventory together. */
async function preparedFixture(t: test.TestContext) {
  const f = fixture(t);
  const file = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  await buildIntakeCollectionEnvelope(f.db, file as never);
  return { ...f, version: intakeSourceVersion(f.db, f.id).version };
}

function assertInventoryIntact(f: ReturnType<typeof fixture>) {
  const inventory = readDurablePackageInventory({
    ...f,
    rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
  });
  assert.ok(inventory);
  assert.equal(inventory.summary.members, members);
  // Every descriptor parses; a doubled chunk append fails JSON.parse here.
  for (let ordinal = 0; ordinal < members; ordinal++)
    assert.equal(inventory.member(ordinal)!.filename, memberName(ordinal));
  return inventory;
}

test('concurrent inventory builders share one lane and publish an intact multi-chunk inventory', async (t) => {
  const f = fixture(t),
    context = { ...f, rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion };
  const [first, second] = await Promise.all([
    buildDurablePackageInventory(context),
    buildDurablePackageInventory(context),
  ]);
  // The second builder waits for the first and reuses its published inventory
  // instead of appending a second copy of each multi-chunk descriptor.
  assert.deepEqual([first.reused, second.reused], [false, true]);
  assert.equal(second.inventory.inventoryId, first.inventory.inventoryId);
  assert.equal(assertInventoryIntact(f).inventoryId, first.inventory.inventoryId);
});

test('concurrent package plan creations publish one intact inventory and a consistent plan', async (t) => {
  const f = await preparedFixture(t),
    input = { version: f.version, operationId: 'fictional-race-plan' };
  const results = await Promise.allSettled([
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input),
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input),
  ]);
  const plans = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  assert.ok(plans.length >= 1, 'at least one plan creation succeeds');
  for (const result of results)
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof HttpError, String(result.reason));
      assert.equal(result.reason.status, 409);
    }
  assert.equal(new Set(plans.map((value) => value.plan.id)).size, 1);
  const inventory = assertInventoryIntact(f);
  assert.ok(plans.every((value) => value.plan.inventory.id === inventory.inventoryId));
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.inventory.summary.members,
    members,
  );
  const replay = await createPagedPackagePlan(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.plan.id, plans[0]!.plan.id);
});

test('package plan creation racing the inventory read publishes one intact inventory', async (t) => {
  const f = await preparedFixture(t);
  const [created, read] = await Promise.all([
    createPagedPackagePlan(f.db, f.root, f.profileId, f.id, {
      version: f.version,
      operationId: 'fictional-race-plan-read',
    }),
    inventoryIntakePackagePaged({ db: f.db, root: f.root, profileId: f.profileId, id: f.id }),
  ]);
  const inventory = assertInventoryIntact(f);
  assert.equal(created.plan.inventory.id, inventory.inventoryId);
  assert.equal(read.inventoryId, inventory.inventoryId);
});
