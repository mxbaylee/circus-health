import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, transaction } from '../database.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { createNote, getNote } from '../notes.ts';
import { prepareOwnershipNamePlan } from '../ownership-name-plan.ts';
import { previewOwnershipNames } from '../ownership-names.ts';
import { ownershipHash } from '../ownership-journal.ts';
import type { OwnershipRequest } from '../../shared/record-ownership.ts';

test('native name plan retains complete large receipt targets, matches the legacy effect digest, pages evidence and stages atomically', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-name-plan-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  const person = createNote(db, {
    kind: 'person',
    title: 'Fictional Old',
    person: { fullName: 'Fictional Old' },
  });
  const destination = createNote(db, {
    kind: 'person',
    title: 'Fictional New',
    person: { fullName: 'Fictional New' },
  });
  const targets = Array.from({ length: 96 }, (_, i) => ({
    recordId: 'target-' + i,
    padding: 'x'.repeat(1500),
  }));
  const receipts = Array.from({ length: 3 }, (_, i) => ({
    operationId: 'confirm-' + i,
    assignedPerson: { personId: person.personId },
    confirmedPrintedName: 'Fictional Printed',
    scope: { intakeId: 'original', groupId: 'group', targets },
    unknown: { fraction: 0.001, keys: { z: 1, a: 'text' } },
  }));
  const raw = JSON.stringify({
    intake: {
      version: 0,
      workflow: {
        identityConfirmations: receipts,
        reportGroups: [{ id: 'group', versions: [{ id: 'version', members: [] }] }],
        reportAcceptances: [],
      },
    },
  });
  registerRawIntakeFixture(db, 'original', raw);
  transaction(db, () =>
    db
      .prepare(
        "INSERT INTO source_records(id,source_file_id,raw_json) VALUES('target-0','original','{}')",
      )
      .run(),
  );
  const sources = new Set(['target-0']),
    owners = new Set([person.personId!]);
  const request: OwnershipRequest = {
    selection: { type: 'records', records: [] },
    destination: { noteId: destination.id, expectedVersion: destination.version },
  };
  const legacy = previewOwnershipNames(db, sources, owners, request);
  assert.equal(legacy.length, 1);
  await buildIntakeCollectionEnvelope(db, { id: 'original' });
  await prepareIntakeLookupIndices(db);
  assert.throws(() => previewOwnershipNames(db, sources, owners, request), /addressed consumption/);
  const plan = await prepareOwnershipNamePlan(db, 'fictional', sources, owners, request);
  t.after(() => plan.close());
  assert.equal(plan.reference.digest, ownershipHash(legacy));
  assert.equal(plan.reference.total, 1);
  assert.equal(plan.reference.supportTotal, 3);
  assert.equal(plan.reference.targetTotal, 288);
  const effects = plan.effects();
  assert.equal(effects.complete, true);
  assert.equal(effects.items[0]!.supportTotal, 3);
  const key = effects.items[0]!.key;
  let after = 0,
    supports = 0,
    targetsRead = 0;
  while (true) {
    const page = plan.supports(key, after, 2);
    supports += page.items.length;
    for (const support of page.items) {
      let cursor = -1;
      while (true) {
        const targetsPage = plan.targets(key, support.ordinal, cursor, 7);
        targetsRead += targetsPage.items.length;
        if (targetsPage.complete) break;
        cursor = Number(targetsPage.after);
      }
    }
    if (page.complete) break;
    after = Number(page.after);
  }
  assert.equal(supports, 3);
  assert.equal(targetsRead, 288);
  assert.throws(() => plan.stage(destination.id, randomUUID()), /owned atomic transaction/);
  const before = db
    .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Identity receipt supersession'")
    .get()!.n;
  assert.throws(
    () =>
      transaction(db, () => {
        plan.assertForTransaction();
        plan.stage(destination.id, randomUUID());
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Identity receipt supersession'")
      .get()!.n,
    before,
  );
  const beforeChoice = plan.reference.decisionDigest;
  plan.choose(key, 'both');
  assert.notEqual(plan.reference.decisionDigest, beforeChoice);
  assert.equal(plan.effects().items[0]!.decision, 'both');
  transaction(db, () => {
    plan.assertForTransaction();
    plan.stage(destination.id, randomUUID());
  });
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM manual_batches WHERE title='Identity receipt supersession'")
      .get()!.n,
    3,
  );
  assert.throws(() => plan.effects(), /evidence changed/);
  assert.equal(getNote(db, destination.id).person.fullName, 'Fictional New');
  assert.ok(getNote(db, destination.id).person.knownNames?.includes('Fictional Printed'));
  const destinationAuthority = JSON.parse(
    String(
      db
        .prepare(
          "SELECT coverage_json FROM manual_batches WHERE title='Remembered name correction' AND json_extract(coverage_json,'$.noteId')=?",
        )
        .get(destination.id)!.coverage_json,
    ),
  );
  assert.equal(destinationAuthority.supportOperationsIncluded, false);
  assert.equal(destinationAuthority.supportOperationsReference.total, 1);
  assert.equal(destinationAuthority.supportOperationsReference.complete, true);
  assert.equal(destinationAuthority.supportOperations, undefined);
});
