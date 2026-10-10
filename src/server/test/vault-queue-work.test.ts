import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { observeVaultQueueWork } from './helpers/vault-queue-work.ts';

test('queue I/O observation preserves and counts both realpath entry points', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'fictional-queue-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.realpathSync,
    native = original.native,
    expected = native(root);
  const result = observeVaultQueueWork(() => [fs.realpathSync(root), fs.realpathSync.native(root)]);
  assert.deepEqual(result.value, [expected, expected]);
  assert.equal(result.work.other.metadataChecks, 2);
  assert.equal(fs.realpathSync, original);
  assert.equal(fs.realpathSync.native, native);
  const failure = new Error('Fictional observed operation failure');
  assert.throws(
    () =>
      observeVaultQueueWork(() => {
        assert.equal(fs.realpathSync.native(root), expected);
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(fs.realpathSync, original);
  assert.equal(fs.realpathSync.native, native);
});
