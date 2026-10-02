import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { transaction } from '../database.ts';
import { uploadIntake, getIntakeOriginal } from '../intake.ts';
import {
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
} from '../intake-state-access.ts';
import { newProfile, vaultFixture } from './helpers/vault-fixture.ts';
test('warmed lookup cache private copy and both cache-loss rebuilds preserve scoped authority', async (t) => {
  const { manager } = vaultFixture(t),
    created = await newProfile(manager, 'Fictional lookup owner');
  const id = created.profile.id,
    state = manager.opened.get(id)!;
  const bytes = Buffer.from('Independently fictional lookup copy evidence.');
  const intake = uploadIntake(state.db, state.root, id, {
    filename: 'fictional.txt',
    bytes,
    newProviderName: 'Fictional clinic',
  });
  transaction(state.db, () => {
    const row = state.db
      .prepare('SELECT details_json FROM source_files WHERE id=?')
      .get(intake.id)!;
    const details = JSON.parse(String(row.details_json));
    details.intake.workflow = {
      reportGroups: [{ discoveryOrder: 71 }],
      reportAcceptances: [
        { receipt: { operationId: 'fictional-copy-operation' }, marker: 'retained' },
      ],
      identityConfirmations: [{ marker: 'fictional-name-support' }],
    };
    state.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(JSON.stringify(details), intake.id);
  });
  const expected = () => {
    assert.equal(maximumReportDiscoveryOrder(state.db), 71);
  };
  expected();
  const sourceHead = state.recordStorage.read('head'),
    sourceDetails = state.db
      .prepare('SELECT details_json FROM source_files WHERE id=?')
      .get(intake.id)!.details_json;
  const setup = manager.begin({ name: 'Fictional copied lookup owner', copyFrom: id });
  await manager.verify(setup.setupId, { acknowledged: true, recovery: setup.recoveryKit });
  const check = (profileId: string) => {
    const current = manager.opened.get(profileId)!;
    assert.equal(
      current.db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
      profileId,
    );
    assert.equal(maximumReportDiscoveryOrder(current.db), 71);
    assert.equal(
      (
        retainedReportAcceptance(current.db, 'fictional-copy-operation') as unknown as {
          marker: string;
        }
      ).marker,
      'retained',
    );
    assert.deepEqual(intakeIdentityConfirmations(current.db), [
      { marker: 'fictional-name-support' },
    ]);
    assert.ok(
      String(
        current.db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path,
      ).includes(profileId),
    );
    assert.deepEqual(
      getIntakeOriginal(current.db, current.root, profileId, intake.id).bytes,
      bytes,
    );
  };
  check(setup.profileId);
  assert.deepEqual(state.recordStorage.read('head'), sourceHead);
  assert.equal(
    state.db.prepare('SELECT details_json FROM source_files WHERE id=?').get(intake.id)!
      .details_json,
    sourceDetails,
  );
  for (const [profileId, recovery] of [
    [id, created.recoveryKit],
    [setup.profileId, setup.recoveryKit],
  ] as const) {
    manager.lock(profileId);
    rmSync(resolve(manager.pathFor(profileId), 'cache'), { recursive: true, force: true });
    manager.unlock(profileId, recovery);
    check(profileId);
  }
});
