import type { TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createEncryptedProfiles } from '../../encrypted-profiles.ts';
import type { ImportDiagnostics } from '../../import-diagnostics.ts';

export function vaultFixture(t: TestContext, options: { diagnostics?: ImportDiagnostics } = {}) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-vault-fault-'));
  const dataDirectory = resolve(base, 'data');
  const runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory, ...options });
  t.after(() => {
    try {
      manager.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  return { base, dataDirectory, runtimeDirectory, manager };
}

export async function newProfile(
  manager: ReturnType<typeof createEncryptedProfiles>,
  name = 'Synthetic fault-test person',
) {
  const setup = manager.begin({ fullName: name, birthDate: '1982-04-17', name, placebo: false });
  const profile = await manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  return { ...setup, profile };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
