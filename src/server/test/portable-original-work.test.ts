import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createPortableOriginalInventory } from '../portable-original-inventory.ts';
import {
  copyPortableOriginalInventory,
  verifyPortableOriginalInventory,
} from '../portable-original-work.ts';

const profileId = 'fictional-original-work';
const path = `data/profiles/${profileId}/sources/large.txt`;
const cells = (sha256: string, bytes: number) => [
  { name: 'path', kind: 'text' as const, pieces: () => [path] },
  { name: 'sha256', kind: 'text' as const, pieces: () => [sha256] },
  { name: 'bytes', kind: 'number' as const, value: bytes },
];

test('selected original copies with bounded work and complete source and target checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-original-root-'));
  const stage = mkdtempSync(join(tmpdir(), 'fictional-original-stage-'));
  const inventory = createPortableOriginalInventory(() => {});
  try {
    ensureProfileDirectories(root, profileId);
    ensureProfileDirectories(stage, profileId);
    const original = join(root, path);
    const bytes = Buffer.from('fictional-🌿'.repeat(80_000));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(original, bytes);
    inventory.add('source_files', cells(sha256, bytes.length));
    let checks = 0;
    await copyPortableOriginalInventory(root, stage, profileId, inventory, () => {
      checks++;
    });
    assert.ok(checks > 2);
    assert.deepEqual(readFileSync(join(stage, path)), bytes);
    await verifyPortableOriginalInventory(root, profileId, inventory, () => {});
    await verifyPortableOriginalInventory(stage, profileId, inventory, () => {});
  } finally {
    inventory.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('same-byte original replacement during a yielded copy refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-original-drift-'));
  const stage = mkdtempSync(join(tmpdir(), 'fictional-original-target-'));
  const inventory = createPortableOriginalInventory(() => {});
  try {
    ensureProfileDirectories(root, profileId);
    ensureProfileDirectories(stage, profileId);
    const original = join(root, path);
    mkdirSync(dirname(original), { recursive: true });
    const bytes = Buffer.from('fictional-original-byte'.repeat(20_000));
    writeFileSync(original, bytes);
    inventory.add(
      'source_files',
      cells(createHash('sha256').update(bytes).digest('hex'), bytes.length),
    );
    let checks = 0;
    await assert.rejects(
      copyPortableOriginalInventory(root, stage, profileId, inventory, () => {
        if (++checks === 10) {
          renameSync(original, original + '.replaced');
          writeFileSync(original, bytes);
        }
      }),
      /Portable original physical source changed/,
    );
    assert.ok(checks >= 10);
  } finally {
    inventory.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('a staged directory symlink refuses before creating outside directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-original-root-'));
  const stage = mkdtempSync(join(tmpdir(), 'fictional-original-stage-'));
  const outside = mkdtempSync(join(tmpdir(), 'fictional-original-outside-'));
  const inventory = createPortableOriginalInventory(() => {});
  try {
    ensureProfileDirectories(root, profileId);
    const bytes = Buffer.from('fictional original');
    writeFileSync(join(root, path), bytes);
    inventory.add(
      'source_files',
      cells(createHash('sha256').update(bytes).digest('hex'), bytes.length),
    );
    mkdirSync(join(stage, 'data'));
    symlinkSync(outside, join(stage, 'data', 'profiles'));
    await assert.rejects(
      copyPortableOriginalInventory(root, stage, profileId, inventory, () => {}),
      /Portable original target directory changed/,
    );
    assert.equal(existsSync(join(outside, profileId)), false);
  } finally {
    inventory.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('missing staged directories are created without adopting parent churn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-original-root-'));
  const stage = mkdtempSync(join(tmpdir(), 'fictional-original-empty-stage-'));
  const inventory = createPortableOriginalInventory(() => {});
  try {
    ensureProfileDirectories(root, profileId);
    const bytes = Buffer.from('fictional nested original');
    writeFileSync(join(root, path), bytes);
    inventory.add(
      'source_files',
      cells(createHash('sha256').update(bytes).digest('hex'), bytes.length),
    );
    await copyPortableOriginalInventory(root, stage, profileId, inventory, () => {});
    assert.deepEqual(readFileSync(join(stage, path)), bytes);
  } finally {
    inventory.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});
