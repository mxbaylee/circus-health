import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import {
  attachRecordDurability,
  captureRecordAuthorityWitness,
  recordAuthorityWitnessCurrent,
} from '../record-versions.ts';
import { beginManagedPhysicalMutation } from '../clinical-review-physical-epoch.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

test('record witness binds private storage configuration, exact accepted HEAD and managed mutation interval', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-record-witness-'));
  const db = openDatabase(join(root, 'projection.sqlite'), 'fictional-witness');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => captureRecordAuthorityWitness(db), /unavailable/);
  const authority = memoryRecordAuthority(db);
  const initial = captureRecordAuthorityWitness(db);
  assert.equal(recordAuthorityWitnessCurrent(db, initial), true);
  assert.equal(recordAuthorityWitnessCurrent(db, {} as never), false);
  const head = authority.objects.get('head')!;
  authority.objects.delete('head');
  assert.equal(recordAuthorityWitnessCurrent(db, initial), false);
  authority.objects.set('head', head);
  const epoch = captureRecordAuthorityWitness(db);
  const finish = beginManagedPhysicalMutation();
  assert.equal(recordAuthorityWitnessCurrent(db, epoch), false);
  finish();
  assert.equal(
    recordAuthorityWitnessCurrent(db, epoch),
    false,
    'a managed physical ABA never restamps a witness',
  );
  const storage = captureRecordAuthorityWitness(db);
  attachRecordDurability(db, { profileId: authority.profileId, storage: authority.storage });
  assert.equal(
    recordAuthorityWitnessCurrent(db, storage),
    false,
    'reattaching even equal storage creates a new private configuration',
  );
  assert.equal(recordAuthorityWitnessCurrent(db, captureRecordAuthorityWitness(db)), true);
});
