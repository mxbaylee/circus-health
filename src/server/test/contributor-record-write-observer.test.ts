import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  captureContributorRecordReadOwner,
  captureContributorRecordWriteWitness,
  closeContributorRecordReadOwner,
  closeContributorRecordWriteWitness,
  contributorAuthorityPath,
  contributorRecordWriteWitnessSequence,
  openContributorRecordStorage,
  takeContributorRecordOwnPublication,
} from '../contributor-record-storage.ts';
import { unlockPhysicalIdentity } from '../encrypted-unlock-physical.ts';
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

test('ordinary contributor publication receipts are factory-owned and one-use', (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-publication-receipt-'))),
    profileId = 'fictional-publication-receipt';
  ensureProfileDirectories(root, profileId);
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const name = 'objects/' + randomUUID(),
    bytes = Buffer.from('Fictional ordinary object.'),
    first = 'fictional-first-head\n';
  storage.writeImmutable(name, bytes);
  storage.publishHead(Buffer.from(first));
  const owner = captureContributorRecordReadOwner(storage);
  assert.ok(owner);
  try {
    assert.equal(
      takeContributorRecordOwnPublication({}, owner, { head: first, previous: null }),
      undefined,
    );
    assert.equal(
      takeContributorRecordOwnPublication(storage, {} as never, { head: first, previous: null }),
      undefined,
    );
    assert.deepEqual(
      takeContributorRecordOwnPublication(storage, owner, { head: first, previous: null }),
      [
        {
          name,
          identity: unlockPhysicalIdentity(join(contributorAuthorityPath(root, profileId), name))
            .value,
        },
      ],
    );
    assert.equal(
      takeContributorRecordOwnPublication(storage, owner, { head: first, previous: null }),
      undefined,
    );
  } finally {
    closeContributorRecordReadOwner(owner);
  }
  assert.throws(
    () => storage.writeImmutable(name, Buffer.from('different')),
    /immutable collision/,
  );
  const second = 'fictional-second-head\n';
  storage.publishHead(Buffer.from(second));
  const failed = captureContributorRecordReadOwner(storage);
  assert.ok(failed);
  try {
    assert.equal(
      takeContributorRecordOwnPublication(storage, failed, { head: second, previous: first }),
      undefined,
      'a failed immutable write invalidates the ordinary receipt without failing publication',
    );
  } finally {
    closeContributorRecordReadOwner(failed);
  }
  const nextName = 'objects/' + randomUUID(),
    third = 'fictional-third-head\n';
  storage.writeImmutable(nextName, bytes);
  storage.publishHead(Buffer.from(third));
  const wrong = captureContributorRecordReadOwner(storage);
  assert.ok(wrong);
  try {
    assert.equal(
      takeContributorRecordOwnPublication(storage, wrong, { head: third, previous: null }),
      undefined,
    );
    assert.equal(
      takeContributorRecordOwnPublication(storage, wrong, { head: third, previous: second }),
      undefined,
      'a mismatched claim cannot reuse the consumed factory receipt',
    );
  } finally {
    closeContributorRecordReadOwner(wrong);
  }
});
