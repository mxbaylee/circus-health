import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess, readRetainedPlanEvidence } from '../intake-retained-plan.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

test('retained member point evidence preserves first plan/member and oversized locator exactly', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-member-evidence-')),
    profileId = 'fictional-profile',
    db = openDatabase(join(root, 'cache.sqlite'), profileId),
    id = 'fictional-original',
    sha256 = 'c'.repeat(64);
  memoryRecordAuthority(db);
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const locator = 'Fictional ' + '🩺'.repeat(10000);
  const plan = (id: string, members: unknown[]) => ({
    id,
    status: 'active',
    index: { kind: 'zip', members },
    units: [],
    batches: [],
    packageRoles: [],
  });
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      workflow: {
        plans: [
          plan('first', [
            { memberId: 'same', sourceHash: 'first', locator },
            { memberId: 'same', sourceHash: 'second', locator: 'second' },
          ]),
          plan('later', [
            { memberId: 'same', sourceHash: 'later', locator: 'later' },
            { memberId: 'other', sourceHash: 'other', locator: 'other' },
          ]),
        ],
      },
    },
  });
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(id, 'fictional.zip', sha256, 0, 'intake_original', initial.detailsJson);
    createIntakeStateStorage(db, { profileId, intakeId: id, sourceHash: sha256 }).stage(
      initial.state,
      randomUUID(),
    );
  });
  await buildIntakeCollectionEnvelope(db, { id, sha256 });
  assert.throws(() => readRetainedPlanEvidence(db, profileId, id), /Prepare retained plan/);
  await prepareRetainedPlanAccess(db, profileId, id);
  const before = intakeWorkCounters(db).reconstruction;
  clearIntakeStateCache(db);
  const evidence = readRetainedPlanEvidence(db, profileId, id);
  assert.equal(evidence.hasMembers, true);
  assert.equal(evidence.hasMember('same'), true);
  const first = evidence.firstMember('same');
  assert.equal(first?.kind, 'retained');
  if (first?.kind !== 'retained') throw Error('Expected addressed evidence');
  assert.equal(first.view.field(first.record, 'sourceHash', { bytes: 100 }).kind, 'value');
  assert.equal(
    JSON.parse([...first.view.fieldChunks(first.record, 'sourceHash')].join('')),
    'first',
  );
  assert.equal(JSON.parse([...first.view.fieldChunks(first.record, 'locator')].join('')), locator);
  assert.equal(evidence.firstMember('absent'), undefined);
  assert.deepEqual(intakeWorkCounters(db).reconstruction, before);
});
