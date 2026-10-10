import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClinicalReviewWork } from '../clinical-review-work.ts';
import { intakeFileIdentity, verifyIntakeFileHashWork } from '../intake-files.ts';

// This is host work with a fixed chunk count, independent of model speed.
test('cooperative original hashing closes its descriptor after cancellation and refuses physical drift', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-cooperative-file-'));
  const bytes = Buffer.alloc(40 * 256 * 1024, 'f');
  const expected = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const originalOpen = fs.openSync,
    originalClose = fs.closeSync;
  const held = new Set<number>();
  Reflect.set(fs, 'openSync', ((path, ...args) => {
    const fd = Reflect.apply(originalOpen, fs, [path, ...args]);
    if (String(path).startsWith(root)) held.add(fd);
    return fd;
  }) as typeof fs.openSync);
  Reflect.set(fs, 'closeSync', ((fd) => {
    held.delete(fd);
    return originalClose(fd);
  }) as typeof fs.closeSync);
  syncBuiltinESMExports();
  t.after(() => {
    Reflect.set(fs, 'openSync', originalOpen);
    Reflect.set(fs, 'closeSync', originalClose);
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const boundary = { capture: () => () => {} };
  const path = join(root, 'unchanged.txt');
  writeFileSync(path, bytes);
  let heartbeat = false;
  setImmediate(() => {
    heartbeat = true;
  });
  const identity = await runClinicalReviewWork(verifyIntakeFileHashWork(path, expected), boundary);
  assert.equal(heartbeat, true);
  assert.equal(identity, intakeFileIdentity(path));
  assert.equal(held.size, 0);

  const cancelled = join(root, 'cancelled.txt');
  writeFileSync(cancelled, bytes);
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await assert.rejects(
    runClinicalReviewWork(verifyIntakeFileHashWork(cancelled, expected), {
      ...boundary,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(held.size, 0, 'abandoning the generator closes the active original descriptor');

  const changed = join(root, 'changed.txt');
  writeFileSync(changed, bytes);
  setImmediate(() => {
    const fd = fs.openSync(changed, 'r+');
    try {
      fs.writeSync(fd, Buffer.from('x'), 0, 1, 0);
    } finally {
      fs.closeSync(fd);
    }
  });
  await assert.rejects(
    runClinicalReviewWork(verifyIntakeFileHashWork(changed, expected), boundary),
    /changed during verification/,
  );
  assert.equal(held.size, 0);
});
