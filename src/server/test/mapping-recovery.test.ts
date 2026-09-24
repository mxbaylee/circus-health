import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-mapping-recovery-'));
  const paths = ensureProfileDirectories(root, 'cookie-dough');
  const db = openDatabase(paths.database, 'cookie-dough');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId: 'cookie-dough' });
  exportCuration(db, root, 'cookie-dough');
  mkdirSync(resolve(paths.root, 'mappings/nested'), { recursive: true });
  return { root, paths, db };
}
test('mapping originals survive backup/restore and portable rebuild with literal bytes and tamper rejection', async (t) => {
  const { root, paths, db } = fixture(t);
  const relativePath = paths.relativeRoot + '/mappings/nested/review.v1.json';
  const bytes = Buffer.from('{"unknownRule":1.0000,"id":12345678901234567890}\r\n');
  writeFileSync(resolve(root, relativePath), bytes);
  const saved = await createBackup(db, root, 'cookie-dough');
  const manifest = JSON.parse(readFileSync(resolve(saved.path, 'manifest.json'), 'utf8')) as {
    profileSources: { path: string }[];
  };
  assert.ok(manifest.profileSources.some((f) => f.path === relativePath));
  restoreBackup(saved.path, resolve(root, 'restored'));
  assert.deepEqual(readFileSync(resolve(root, 'restored', relativePath)), bytes);
  rebuildProfile(root, 'cookie-dough', resolve(root, 'rebuilt'));
  assert.deepEqual(readFileSync(resolve(root, 'rebuilt', relativePath)), bytes);
  writeFileSync(resolve(saved.path, 'files', relativePath), 'changed');
  assert.throws(() => restoreBackup(saved.path, resolve(root, 'tampered')), /checksum/);
});
test('mapping backup and rebuild refuse symlinks instead of including outside profile data', async (t) => {
  const { root, paths, db } = fixture(t);
  const outside = resolve(root, 'other-profile-secret.json');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, resolve(paths.root, 'mappings/leak.json'));
  await assert.rejects(createBackup(db, root, 'cookie-dough'), /symbolic links/);
  assert.throws(
    () => rebuildProfile(root, 'cookie-dough', resolve(root, 'rebuilt')),
    /symbolic links/,
  );
});
