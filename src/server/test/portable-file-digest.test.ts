import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, lstatSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableFileDigestAsync } from '../portable.ts';
import { createPortableWorkCounters, withPortableWork } from '../portable-work.ts';

const BLOCK = 64 * 1024;

for (const size of [0, 1, BLOCK, BLOCK + 1, 4 * BLOCK + 17]) {
  test(`portable file digest proves once per resumed read at ${size} bytes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-digest-work-'));
    try {
      const path = join(root, 'fictional.bin'),
        bytes = Buffer.alloc(size, 0x66),
        counters = createPortableWorkCounters();
      writeFileSync(path, bytes);
      let checks = 0;
      const result = await withPortableWork(counters, () =>
        portableFileDigestAsync(path, () => {
          checks++;
        }),
      );
      const yields = Math.ceil(size / BLOCK),
        stamp = lstatSync(path, { bigint: true });
      assert.equal(result.bytes, size);
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
      for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'] as const)
        assert.equal(result.stamp[key], String(stamp[key]));
      assert.equal(counters.fileHashBytes, size);
      assert.equal(counters.maxReadBufferBytes, size ? BLOCK : 0);
      assert.equal(counters.backupYields, yields);
      // Entry, each native read (including EOF), and final complete-file proof.
      assert.equal(checks, yields + 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('portable file digest takes a fresh proof before each read and after EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-digest-order-')),
    original = fs.readSync,
    events: string[] = [];
  try {
    const path = join(root, 'fictional.bin');
    writeFileSync(path, Buffer.alloc(BLOCK + 1, 0x66));
    fs.readSync = ((...args: Parameters<typeof original>) => {
      events.push('read');
      const result = original(...args);
      if (result) setImmediate(() => events.push('resume'));
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    await portableFileDigestAsync(path, () => events.push('proof'));
    assert.deepEqual(events, [
      'proof',
      'proof',
      'read',
      'resume',
      'proof',
      'read',
      'resume',
      'proof',
      'read',
      'proof',
    ]);
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ['source replacement', 'cancellation'] as const) {
  test(`portable file digest refuses resumed-turn ${failure} before the next read`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-digest-resume-')),
      original = fs.readSync,
      controller = new AbortController(),
      primary = new Error(`fictional ${failure}`);
    let reads = 0,
      changed = false;
    try {
      const path = join(root, 'fictional.bin'),
        source = join(root, 'fictional-authority'),
        replacement = join(root, 'fictional-replacement');
      writeFileSync(path, Buffer.alloc(2 * BLOCK, 0x66));
      writeFileSync(source, 'fictional');
      writeFileSync(replacement, 'fictional');
      const initial = lstatSync(source, { bigint: true });
      fs.readSync = ((...args: Parameters<typeof original>) => {
        const result = original(...args);
        if (++reads === 1)
          setImmediate(() => {
            changed = true;
            if (failure === 'cancellation') controller.abort(primary);
            else renameSync(replacement, source);
          });
        return result;
      }) as typeof original;
      syncBuiltinESMExports();
      await assert.rejects(
        portableFileDigestAsync(path, () => {
          controller.signal.throwIfAborted();
          const current = lstatSync(source, { bigint: true });
          if (current.dev !== initial.dev || current.ino !== initial.ino) throw primary;
        }),
        (error) => error === primary,
      );
      assert.equal(changed, true);
      assert.equal(reads, 1, 'no read occurs before the fresh resumed-turn proof');
    } finally {
      fs.readSync = original;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('portable file digest retains final named-file identity verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-digest-final-')),
    original = fs.readSync;
  try {
    const path = join(root, 'fictional.bin'),
      replacement = join(root, 'fictional-replacement');
    writeFileSync(path, 'fictional');
    writeFileSync(replacement, 'fictional');
    fs.readSync = ((...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (!result) renameSync(replacement, path);
      return result;
    }) as typeof original;
    syncBuiltinESMExports();
    await assert.rejects(
      portableFileDigestAsync(path, () => {}),
      /source file changed/,
    );
  } finally {
    fs.readSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable file digest refuses a pathname replacement performed by a resumed checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-digest-callback-'));
  try {
    const path = join(root, 'fictional.bin'),
      replacement = join(root, 'fictional-replacement');
    writeFileSync(path, 'fictional');
    writeFileSync(replacement, 'fictional');
    let checks = 0;
    await assert.rejects(
      portableFileDigestAsync(path, () => {
        if (++checks === 3) renameSync(replacement, path);
      }),
      /source file changed/,
    );
    assert.equal(checks, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['resumed proof', 'terminal proof', 'native read'] as const) {
  test(`portable file digest closes its descriptor after a thrown ${stage}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-digest-cleanup-')),
      originalRead = fs.readSync,
      originalClose = fs.closeSync,
      primary = new Error(`fictional ${stage}`);
    let checks = 0,
      closes = 0;
    try {
      const path = join(root, 'fictional.bin');
      writeFileSync(path, 'fictional');
      fs.closeSync = ((...args: Parameters<typeof originalClose>) => {
        closes++;
        return originalClose(...args);
      }) as typeof originalClose;
      if (stage === 'native read')
        fs.readSync = (() => {
          throw primary;
        }) as typeof originalRead;
      syncBuiltinESMExports();
      await assert.rejects(
        portableFileDigestAsync(path, () => {
          if (++checks === (stage === 'resumed proof' ? 3 : stage === 'terminal proof' ? 4 : -1))
            throw primary;
        }),
        (error) => error === primary,
      );
      assert.equal(closes, 1);
    } finally {
      fs.readSync = originalRead;
      fs.closeSync = originalClose;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('portable file digest keeps its initial cancellation and terminal checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-digest-terminal-'));
  try {
    const initial = new Error('fictional initial cancellation'),
      terminal = new Error('fictional terminal refusal'),
      path = join(root, 'fictional.bin');
    await assert.rejects(
      portableFileDigestAsync(path, () => {
        throw initial;
      }),
      (error) => error === initial,
    );
    writeFileSync(path, '');
    let checks = 0;
    await assert.rejects(
      portableFileDigestAsync(path, () => {
        if (++checks === 3) throw terminal;
      }),
      (error) => error === terminal,
    );
    assert.equal(checks, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
