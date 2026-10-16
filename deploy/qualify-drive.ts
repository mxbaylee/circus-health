import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, external, ROOT } from './run.ts';
import { probeDrive } from './drive-probe.ts';

export function driveContainerArguments(
  image: string,
  scratch: string,
  mode: 'write' | 'verify',
  nonce: string,
) {
  assert.ok(image && !image.startsWith('-'));
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--ulimit',
    'core=0',
    '--user',
    '1000:1000',
    '--mount',
    `type=bind,source=${scratch},target=/probe`,
    '--mount',
    `type=bind,source=${join(ROOT, 'deploy/drive-probe.ts')},target=/app/deploy/drive-probe.ts,readonly`,
    '--mount',
    `type=bind,source=${join(ROOT, 'src/server/storage-lock.ts')},target=/app/src/server/storage-lock.ts,readonly`,
    '--mount',
    `type=bind,source=${join(ROOT, 'src/server/storage-lock-holder.ts')},target=/app/src/server/storage-lock-holder.ts,readonly`,
    '--mount',
    `type=bind,source=${join(ROOT, 'src/shared/flock.ts')},target=/app/src/shared/flock.ts,readonly`,
    '--entrypoint',
    'node',
    image,
    '/app/deploy/drive-probe.ts',
    mode,
    '/probe/owned/container',
    nonce,
  ];
}

export function requireSupportedDriveProbeHost(platform: NodeJS.Platform = process.platform) {
  assert.ok(
    platform === 'darwin' || platform === 'linux',
    'Drive qualification supports macOS Docker Desktop and Linux only.',
  );
}

/** Root sees only our exclusive scratch mount. A nonce proves daemon/host mount
 * identity before creating or removing the UID 1000 subtree. No archive is mounted. */
export function driveScratchArguments(
  image: string,
  scratch: string,
  nonce: string,
  cleanup = false,
) {
  assert.ok(image && !image.startsWith('-'));
  assert.match(nonce, /^[a-f0-9-]{36}$/u);
  const script = `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('/probe/owner', 'utf8'), process.argv[1]);
assert.equal(fs.lstatSync('/probe').isDirectory(), true);
const path = '/probe/owned';
if (process.argv[2] === 'cleanup') {
  if (fs.existsSync(path)) {
    assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
    assert.ok([0, 1000].includes(fs.statSync(path).uid));
    fs.rmSync(path, { recursive: true });
  }
} else {
  fs.mkdirSync(path, { mode: 0o700 });
  fs.chownSync(path, 1000, 1000);
  // Docker Desktop's host bind mapping can report the inspecting process's
  // UID. The actual UID 1000 probe separately verifies its own view/access.
  if (process.argv[3] === 'linux') assert.equal(fs.statSync(path).uid, 1000);
}
console.log(JSON.stringify({ mountIdentity: true, ownedScratch: true }));`;
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'DAC_OVERRIDE',
    '--security-opt',
    'no-new-privileges',
    '--ulimit',
    'core=0',
    '--user',
    '0:0',
    '--mount',
    `type=bind,source=${scratch},target=/probe`,
    '--entrypoint',
    'node',
    image,
    '-e',
    script,
    nonce,
    cleanup ? 'cleanup' : 'prepare',
    process.platform,
  ];
}

/** A mount-semantics receipt is deliberately narrower than full CRS-071 acceptance. */
export async function qualifyDrive(
  env: NodeJS.ProcessEnv = process.env,
  runDocker?: (args: string[]) => unknown,
) {
  assert.equal(env.CRS_DRIVE_QUALIFICATION, '1', 'Explicit CRS_DRIVE_QUALIFICATION=1 required.');
  const data = dataDirectory(env);
  const output = external(env.CRS_QUALIFICATION_OUTPUT_DIR, 'CRS_QUALIFICATION_OUTPUT_DIR', {
    directory: true,
    data,
  });
  assert.ok(env.CRS_IMAGE, 'Supply CRS_IMAGE for an already built application image.');
  requireSupportedDriveProbeHost();
  const scratch = mkdtempSync(join(data, '.fictional-drive-qualification-'));
  // Only the outer directory permits traversal; all evidence remains owner-only.
  chmodSync(scratch, 0o711);
  const nonce = randomUUID();
  writeFileSync(join(scratch, 'owner'), nonce, { mode: 0o600, flag: 'wx' });
  const docker =
    runDocker ??
    ((args: string[]) =>
      JSON.parse(
        execFileSync('docker', args, {
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 32_768,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ));
  let prepared = false;
  let receipt;
  try {
    const host = await probeDrive(join(scratch, 'host'), nonce);
    prepared = true;
    assert.deepEqual(docker(driveScratchArguments(env.CRS_IMAGE, scratch, nonce)), {
      mountIdentity: true,
      ownedScratch: true,
    });
    const run = (mode: 'write' | 'verify') =>
      docker(driveContainerArguments(env.CRS_IMAGE!, scratch, mode, nonce));
    const container: unknown = run('write');
    const recreated: unknown = run('verify');
    assert.deepEqual(container, {
      ...host,
      filesystemType: (container as { filesystemType: number }).filesystemType,
    });
    assert.equal(typeof (container as { filesystemType: number }).filesystemType, 'number');
    assert.deepEqual(recreated, { publicationRetained: true, writerReacquired: true });
    receipt = {
      schemaVersion: 1,
      task: 'CRS-152',
      independentlyFictional: true,
      scope: 'Host and container mount semantics, publication retained after container recreation.',
      passed: true,
      host,
      container,
      recreated,
      containerUid: 1000,
      network: 'none',
      hostPlatform: process.platform,
      mountIdentityVerified: true,
      ownedScratchCleanup: true,
      powerLossQualified: false,
      remainingAcceptance: [
        'Real provider authentication persistence',
        'Actual complete import workflow',
      ],
    };
  } finally {
    // Host UIDs may differ from 1000. Remove only the nonce-proven child through
    // the same narrow mount, then remove the host-owned remainder normally.
    if (prepared)
      assert.deepEqual(docker(driveScratchArguments(env.CRS_IMAGE, scratch, nonce, true)), {
        mountIdentity: true,
        ownedScratch: true,
      });
    rmSync(scratch, { recursive: true });
  }
  const path = join(output, 'drive-' + nonce + '.json');
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await qualifyDrive()));
  } catch {
    console.error(
      'Drive qualification failed. Check opt-in, external paths, image, mount permissions and filesystem semantics.',
    );
    process.exitCode = 1;
  }
}
