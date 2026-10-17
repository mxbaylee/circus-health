import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  openContributorRecordStorage,
  observeContributorRecordStorageWork,
  captureContributorRecordReadOwner,
  closeContributorRecordReadOwner,
  contributorRecordReadOwnerHeadBytes,
  captureContributorRecordWriteWitness,
  closeContributorRecordWriteWitness,
  stageContributorRecordFactoryObject,
  prepareContributorRecordHeadPublication,
  installContributorRecordHeadPublication,
  closeContributorRecordHeadPublication,
} from '../contributor-record-storage.ts';

test('factory accounting includes ordinary and private transports once without granting ownership', (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-storage-work-')));
  ensureProfileDirectories(root, 'fictional');
  const storage = openContributorRecordStorage(root, 'fictional', { initialize: true });
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => observeContributorRecordStorageWork({ ...storage }), /factory unavailable/);
  const work = observeContributorRecordStorageWork(storage, 2);
  assert.throws(() => observeContributorRecordStorageWork(storage), /already active/);
  const first = 'objects/' + randomUUID();
  const bytes = Buffer.from('Independently fictional transport bytes.');
  storage.writeImmutable(first, bytes);
  storage.writeImmutable(first, bytes); // Count the successful logical retry.
  assert.throws(() => storage.writeImmutable(first, Buffer.from('different')), /collision/);
  assert.deepEqual(storage.read(first), bytes);
  assert.equal(storage.read('objects/' + randomUUID()), null);
  storage.publishHead(Buffer.from('fictional initial head'));
  const original = captureContributorRecordReadOwner(storage)!;
  assert.equal(
    contributorRecordReadOwnerHeadBytes(storage, original).toString(),
    'fictional initial head',
  );
  closeContributorRecordReadOwner(original);
  const staged = Buffer.from('Independently fictional staged transport.');
  const reference = {
    name: 'objects/' + randomUUID(),
    bytes: staged.length,
    sha256: createHash('sha256').update(staged).digest('hex'),
  };
  const writer = captureContributorRecordWriteWitness(storage)!;
  stageContributorRecordFactoryObject(storage, writer, reference, staged);
  closeContributorRecordWriteWitness(writer);
  const publication = prepareContributorRecordHeadPublication(storage, reference)!;
  installContributorRecordHeadPublication(storage, publication);
  closeContributorRecordHeadPublication(publication);
  const head = Buffer.from(JSON.stringify(reference) + '\n');
  assert.deepEqual(work.snapshot(), {
    reads: 4,
    readBytes: bytes.length + Buffer.byteLength('fictional initial head') + staged.length,
    immutableWrites: 3,
    immutableBytes: 2 * bytes.length + staged.length,
    headWrites: 2,
    headBytes: Buffer.byteLength('fictional initial head') + head.length,
  });
  assert.deepEqual(work.events(), {
    events: [
      { name: first, bytes: bytes.length },
      { name: first, bytes: bytes.length },
    ],
    count: 2,
    dropped: 1,
  });
  const detached = work.events();
  detached.events[0]!.bytes = 0;
  const detachedCounts = work.snapshot();
  detachedCounts.reads = 0;
  assert.equal(work.events().events[0]!.bytes, bytes.length);
  assert.equal(work.snapshot().reads, 4);
  work.close();
  work.close();
  storage.read(first);
  assert.equal(work.snapshot().reads, 4);
  const next = observeContributorRecordStorageWork(storage);
  storage.read(first);
  work.close(); // An old handle cannot detach the new observation.
  storage.read(first);
  assert.equal(next.snapshot().reads, 2);
  next.close();
});
