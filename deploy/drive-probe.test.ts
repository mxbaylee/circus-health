import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDrive, verifyDrivePublication } from './drive-probe.ts';
import {
  driveContainerArguments,
  qualifyDrive,
  requireSupportedDriveProbeHost,
} from './qualify-drive.ts';

test('fictional drive probe exercises real publication and separate-process writer leases', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-drive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'probe');
  const nonce = randomUUID();
  const result = await probeDrive(directory, nonce);
  assert.equal(result.killedWriterReacquired, true);
  assert.equal(result.concurrentWriterRejected, true);
  assert.deepEqual(await verifyDrivePublication(directory, nonce), {
    publicationRetained: true,
    writerReacquired: true,
  });
  await assert.rejects(verifyDrivePublication(directory, randomUUID()));
  writeFileSync(join(directory, 'published'), 'fictional corruption');
  await assert.rejects(verifyDrivePublication(directory, nonce));
});

test('probe cannot overwrite an existing directory or leave nonce-selected paths', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-drive-existing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'untouched'), 'fictional sentinel');
  await assert.rejects(probeDrive(root, randomUUID()), { code: 'EEXIST' });
  await assert.rejects(probeDrive(join(root, 'bad'), '../not-a-nonce'));
  assert.equal(readFileSync(join(root, 'untouched'), 'utf8'), 'fictional sentinel');
});

test('container probes use UID 1000, no network and only the scratch data mount', () => {
  const args = driveContainerArguments(
    'fictional-image:latest',
    '/fictional/probe',
    'verify',
    randomUUID(),
  );
  assert.ok(args.includes('none'));
  assert.ok(args.includes('1000:1000'));
  assert.ok(args.includes('type=bind,source=/fictional/probe,target=/probe'));
  assert.ok(!args.some((arg) => arg.includes('/archive/data') || arg.includes('chatgpt')));
  assert.throws(() => driveContainerArguments('--bad', '/fictional/probe', 'write', randomUUID()));
});

test('qualification refuses to run before explicit opt-in or without an external image and output', async () => {
  await assert.rejects(qualifyDrive({}), /Explicit/u);
  await assert.rejects(
    qualifyDrive({ CRS_DRIVE_QUALIFICATION: '1', CRS_DATA_DIR: '.' }),
    /absolute/u,
  );
});

test('unsupported host is rejected before UID 1000 container scratch is created', () => {
  assert.doesNotThrow(() => requireSupportedDriveProbeHost('darwin'));
  assert.throws(() => requireSupportedDriveProbeHost('linux'), /macOS Docker Desktop only/u);
});
