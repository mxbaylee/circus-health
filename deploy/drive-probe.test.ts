import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDrive, verifyDrivePublication } from './drive-probe.ts';
import {
  driveContainerArguments,
  driveScratchArguments,
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

test('supported hosts include Linux with separately owned UID 1000 scratch', () => {
  assert.doesNotThrow(() => requireSupportedDriveProbeHost('darwin'));
  assert.doesNotThrow(() => requireSupportedDriveProbeHost('linux'));
  assert.throws(() => requireSupportedDriveProbeHost('win32'), /macOS Docker Desktop and Linux/u);
  const nonce = randomUUID();
  const prepare = driveScratchArguments('fictional-image', '/fictional/owned', nonce);
  const cleanup = driveScratchArguments('fictional-image', '/fictional/owned', nonce, true);
  assert.ok(prepare.includes('0:0'));
  assert.ok(prepare.includes('none'));
  assert.ok(prepare.includes('type=bind,source=/fictional/owned,target=/probe'));
  assert.ok(prepare.includes('prepare'));
  assert.ok(cleanup.includes('cleanup'));
  assert.equal(prepare.filter((value) => value.startsWith('type=bind,')).length, 1);
  assert.throws(() => driveScratchArguments('fictional-image', '/fictional/owned', '../bad'));
});

test('failed preparation and UID 1000 probes clean only their nonce-owned scratch', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-drive-failure-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'),
    output = join(root, 'receipts');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(data, 'untouched'), 'fictional sentinel');
  const initialMode = statSync(data).mode;
  for (const failPrepare of [true, false]) {
    let cleaned = false;
    await assert.rejects(
      qualifyDrive(
        {
          CRS_DRIVE_QUALIFICATION: '1',
          CRS_DATA_DIR: data,
          CRS_QUALIFICATION_OUTPUT_DIR: output,
          CRS_IMAGE: 'fictional-image',
        },
        (args) => {
          const mount = args.find((value) => value.startsWith('type=bind,source='))!;
          const scratch = mount.slice('type=bind,source='.length).split(',')[0]!;
          assert.match(readFileSync(join(scratch, 'owner'), 'utf8'), /^[a-f0-9-]{36}$/u);
          if (args.at(-2) === 'prepare') {
            mkdirSync(join(scratch, 'owned'), { mode: 0o700 });
            if (failPrepare) throw new Error('Fictional preparation failure');
            return { mountIdentity: true, ownedScratch: true };
          }
          if (args.at(-2) === 'cleanup') {
            rmSync(join(scratch, 'owned'), { recursive: true });
            cleaned = true;
            return { mountIdentity: true, ownedScratch: true };
          }
          throw new Error('Fictional UID 1000 probe failure');
        },
      ),
      /Fictional/,
    );
    assert.equal(cleaned, true);
    assert.deepEqual(readdirSync(data), ['untouched']);
    assert.equal(statSync(data).mode, initialMode);
    assert.equal(readFileSync(join(data, 'untouched'), 'utf8'), 'fictional sentinel');
    assert.deepEqual(readdirSync(output), []);
    assert.equal(existsSync(join(data, 'owned')), false);
  }
});
