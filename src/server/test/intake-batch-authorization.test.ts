import assert from 'node:assert/strict';
import test from 'node:test';
import { intakeBatchOwnerCurrent, type IntakeBatchOwner } from '../intake-batches.ts';
import { withVaultIntakeBatchAuthorization } from '../vault-app.ts';

test('a caller-created batch owner cannot enter background vault authorization', async () => {
  const forged = Object.freeze({}) as IntakeBatchOwner;
  let called = false;
  assert.equal(intakeBatchOwnerCurrent(forged), undefined);
  await assert.rejects(
    withVaultIntakeBatchAuthorization(forged, async () => {
      called = true;
    }),
    { code: 'PROFILE_LOCKED' },
  );
  assert.equal(called, false);
});
