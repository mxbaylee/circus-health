import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultStorageTotals } from '../vault-storage-totals.ts';
import type { VaultMetadata } from '../vault-store.ts';
test('storage breakdown counts shared objects once and keeps runtime separate', (t) => {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-storage-totals-')),
    profile = resolve(base, 'profile'),
    runtime = resolve(base, 'runtime');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const dir of ['vault/objects', 'vault/versions', 'cache'])
    mkdirSync(resolve(profile, dir), { recursive: true });
  mkdirSync(runtime);
  writeFileSync(resolve(profile, 'vault/objects/abcd.enc'), Buffer.alloc(17));
  writeFileSync(resolve(profile, 'vault/versions/one.enc'), Buffer.alloc(23));
  writeFileSync(resolve(profile, 'cache/sqlite.enc'), Buffer.alloc(31));
  writeFileSync(resolve(runtime, 'database.sqlite'), Buffer.alloc(400));
  const totals = vaultStorageTotals(
    profile,
    {
      format: 'circus-health-vault-index-v1',
      profileId: 'fictional-profile',
      revision: 1,
      objects: { abcd: { bytes: 17, sha256: 'a'.repeat(64) } },
      files: { 'sources/clinic/a.pdf': 'abcd', 'attachments/photo.pdf': 'abcd' },
      recordsHead: null,
    } satisfies VaultMetadata,
    runtime,
  );
  assert.equal(totals.storedBytes, 71);
  assert.equal(totals.runtimeBytes, 400);
  assert.equal(totals.breakdown.find((r) => r.id === 'sources')?.bytes, 17);
  assert.equal(totals.breakdown.find((r) => r.id === 'attachments')?.bytes, 0);
  assert.equal(
    totals.breakdown.reduce((n, r) => n + r.bytes, 0),
    totals.storedBytes,
  );
});
