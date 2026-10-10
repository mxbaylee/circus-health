import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureContributorRecordWriteWitness,
  closeContributorRecordWriteWitness,
  contributorRecordWriteWitnessSequence,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

test('original contributor write observation detects idempotent objects and same-byte HEAD publication', (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-write-observer-'))),
    profileId = 'fictional-write-observer';
  ensureProfileDirectories(root, profileId);
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const name = 'objects/' + randomUUID(),
    bytes = Buffer.from('Independently fictional immutable bytes'),
    head = Buffer.from('Independently fictional selected head');
  storage.writeImmutable(name, bytes);
  storage.publishHead(head);
  const witness = captureContributorRecordWriteWitness(storage);
  assert.ok(witness);
  t.after(() => closeContributorRecordWriteWitness(witness));
  assert.equal(contributorRecordWriteWitnessSequence(storage, witness), 0n);
  storage.writeImmutable(name, bytes);
  assert.equal(contributorRecordWriteWitnessSequence(storage, witness), 1n);
  assert.deepEqual(storage.read(name), bytes);
  assert.throws(() => contributorRecordWriteWitnessSequence({}, witness), /witness changed/);
  storage.publishHead(head);
  assert.deepEqual(storage.read('head'), head);
  assert.throws(() => contributorRecordWriteWitnessSequence(storage, witness), /witness changed/);
  const next = captureContributorRecordWriteWitness(storage);
  assert.ok(next);
  closeContributorRecordWriteWitness(next);
  assert.throws(() => contributorRecordWriteWitnessSequence(storage, next), /witness changed/);
  assert.equal(captureContributorRecordWriteWitness({}), undefined);
});
