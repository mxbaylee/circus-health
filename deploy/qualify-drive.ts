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
    '/probe/container',
    nonce,
  ];
}

/** A mount-semantics receipt is deliberately narrower than full CRS-071 acceptance. */
export async function qualifyDrive(env: NodeJS.ProcessEnv = process.env) {
  assert.equal(env.CRS_DRIVE_QUALIFICATION, '1', 'Explicit CRS_DRIVE_QUALIFICATION=1 required.');
  const data = dataDirectory(env);
  const output = external(env.CRS_QUALIFICATION_OUTPUT_DIR, 'CRS_QUALIFICATION_OUTPUT_DIR', {
    directory: true,
    data,
  });
  assert.ok(env.CRS_IMAGE, 'Supply CRS_IMAGE for an already built application image.');
  const scratch = mkdtempSync(join(data, '.fictional-drive-qualification-'));
  chmodSync(scratch, 0o700);
  const nonce = randomUUID();
  try {
    const host = await probeDrive(join(scratch, 'host'), nonce);
    const run = (mode: 'write' | 'verify') =>
      JSON.parse(
        execFileSync('docker', driveContainerArguments(env.CRS_IMAGE!, scratch, mode, nonce), {
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 32_768,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    const container: unknown = run('write');
    const recreated: unknown = run('verify');
    assert.deepEqual(container, {
      ...host,
      filesystemType: (container as { filesystemType: number }).filesystemType,
    });
    assert.equal(typeof (container as { filesystemType: number }).filesystemType, 'number');
    assert.deepEqual(recreated, { publicationRetained: true, writerReacquired: true });
    const receipt = {
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
      powerLossQualified: false,
      remainingAcceptance: [
        'Real provider authentication persistence',
        'Actual complete import workflow',
      ],
    };
    const path = join(output, 'drive-' + nonce + '.json');
    writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
