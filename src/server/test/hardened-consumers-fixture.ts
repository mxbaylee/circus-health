// Invoked only by the opt-in hardened-container check with a disposable archive.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { exportPdf } from '../note-exports.ts';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { writeProfileRegistry } from '../profile-registry.ts';
import { attachPersonalDurability, exportCuration } from '../portable.ts';
import { createNote } from '../notes.ts';
import { uploadAsset } from '../assets.ts';
import { createBackup, restoreBackup } from '../recovery.ts';

const root = '/archive';
const profileId = 'cedar';
assert.equal(process.env.CRS_FICTIONAL_CONSUMER_CHECK, '1');
assert.equal(readdirSync(join(root, 'data')).length, 0, 'Use an empty disposable archive');
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /NoNewPrivs:\s+1/);
assert.match(status, /CapEff:\s+0+\b/);
assert.match(readFileSync('/proc/self/limits', 'utf8'), /Max core file size\s+0\s+0/);
assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '512');
const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')
  .trim()
  .split(' ')
  .map(Number);
assert.equal(quota! / period!, 2);
const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
for (const [path, mib] of [
  ['/run/health', 1024],
  ['/tmp', 128],
] as const) {
  const mount = mounts.find((line) => line.split(' ')[4] === path)!;
  assert.ok(mount);
  for (const flag of ['noexec', 'nosuid', 'nodev'])
    assert.ok(mount.split(' ')[5]!.split(',').includes(flag));
  assert.match(mount, / - tmpfs /);
  const filesystem = statfsSync(path);
  assert.equal(filesystem.blocks * filesystem.bsize, mib * 1024 * 1024);
}
const sharedMemory = statfsSync('/dev/shm');
assert.equal(sharedMemory.blocks * sharedMemory.bsize, 128 * 1024 * 1024);
const pdf = await exportPdf(
  '<!doctype html><html><body><h1>Fictional hardened note export</h1><p>No personal content.</p></body></html>',
);
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
assert.ok(pdf.length > 1000);

const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
const assetBytes = Buffer.concat([pdf, Buffer.alloc(20 * 1024 * 1024 - pdf.length, 32)]);
for (let index = 0; index < 7; index++)
  uploadAsset(
    db,
    root,
    profileId,
    assetBytes,
    `fictional-capacity-${index}.pdf`,
    'application/pdf',
  );
attachPersonalDurability(db, { root, profileId });
createNote(db, { title: 'Fictional backup consumer', content: 'Seven retained fictional PDFs.' });
exportCuration(db, root, profileId);
writeProfileRegistry(root, [{ id: profileId, placebo: true }]);
const beforeTemporary = readdirSync('/tmp').sort();
let receipt;
try {
  // Exercise the retained contributor API; the operator CLI is intentionally retired.
  receipt = await createBackup(db, root, profileId);
} finally {
  db.close();
}
assert.equal(receipt.files, 7);
const manifest = JSON.parse(readFileSync(join(receipt.path, 'manifest.json'), 'utf8')) as {
  files: { bytes: number }[];
};
const originalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
const temporary = statfsSync('/tmp');
assert.ok(originalBytes > temporary.blocks * temporary.bsize);
assert.deepEqual(readdirSync('/tmp').sort(), beforeTemporary);
assert.ok(
  !readdirSync(join(root, 'data/backups')).some((name) =>
    name.startsWith('.health-backup-projection-'),
  ),
);
const restored = restoreBackup(receipt.path, '/archive/restored');
assert.equal(restored.files, 7);
console.log(
  JSON.stringify({
    pdfBytes: pdf.length,
    backupOriginalBytes: originalBytes,
    backupFiles: 7,
    restoredFiles: restored.files,
    temporaryBytes: temporary.blocks * temporary.bsize,
  }),
);
