import { mkdtempSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Callers remove this directory after closing the runtime. Linux contributor
// tests exercise the deployment guard against a real tmpfs, never bypass it.
export function createTestRuntimeDirectory(): string {
  const parent = process.platform === 'linux' ? '/dev/shm' : tmpdir();
  if (process.platform === 'linux') {
    try {
      if (statfsSync(parent).type !== 0x01021994) throw new Error('not a tmpfs');
      return mkdtempSync(resolve(parent, 'circus-runtime-test-'));
    } catch (cause) {
      throw new Error('Runtime tests require a writable tmpfs mounted at /dev/shm', { cause });
    }
  }
  return mkdtempSync(resolve(parent, 'circus-runtime-test-'));
}
