import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test(
  'hardened application image exports a note PDF and backs up originals larger than temporary storage',
  { skip: !process.env.HEALTH_CONSUMER_TEST_IMAGE, timeout: 240000 },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-container-consumers-'));
    chmodSync(root, 0o777);
    mkdirSync(join(root, 'data'), { mode: 0o777 });
    chmodSync(join(root, 'data'), 0o777);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--ulimit',
        'core=0:0',
        '--pids-limit',
        '512',
        '--cpus',
        '2',
        '--shm-size',
        '128m',
        '--tmpfs',
        '/run/health:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700,size=1024m',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,noexec,size=128m',
        '--mount',
        `type=bind,source=${root},target=/archive`,
        '-e',
        'CIRCUS_FICTIONAL_CONSUMER_CHECK=1',
        '--entrypoint',
        'node',
        process.env.HEALTH_CONSUMER_TEST_IMAGE!,
        'src/server/test/hardened-consumers-fixture.ts',
      ],
      { encoding: 'utf8', timeout: 210000, maxBuffer: 1024 * 1024 },
    );
    const result = JSON.parse(output);
    assert.equal(result.backupFiles, 7);
    assert.equal(result.restoredFiles, 7);
    assert.ok(result.backupOriginalBytes > result.temporaryBytes);
    t.diagnostic(output.trim());
  },
);
