import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  acquireLauncherLock,
  applicationImage,
  Cancelled,
  dataDirectory,
  Docker,
  external,
  lease,
  main,
  publicOrigin,
  ROOT,
} from './run.ts';

type Call = { args: string[]; env?: NodeJS.ProcessEnv; cleanup?: boolean; capture?: boolean };
function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'circus-launch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'fictional archive', 'data');
  mkdirSync(data, { recursive: true });
  const config = join(root, 'fictional model.yaml');
  writeFileSync(config, 'model_list: []\n');
  const state = join(root, 'state');
  const env = {
    CRS_DATA_DIR: data,
    CRS_STATE_DIR: state,
    CRS_LITELLM_CONFIG: config,
    CRS_MODEL: 'fictional-alias',
  };
  return { root, data, config, state, env };
}
class FakeDocker extends Docker {
  calls: Call[] = [];
  fail: ((args: string[]) => boolean) | undefined;
  constructor() {
    super('unused', false);
  }
  override async run(
    args: string[],
    options: { env?: NodeJS.ProcessEnv; cleanup?: boolean; capture?: boolean } = {},
  ): Promise<string> {
    this.calls.push({ args, ...options });
    if (this.fail?.(args)) throw new Error('Fictional Docker failure');
    return JSON.stringify({
      response_model: 'fictional-upstream',
      images: false,
      promptCache: false,
      pdf: true,
    });
  }
}

test('launcher preserves credentials, validates runtime, derives archive image and tears down its own stack', async (t) => {
  const f = fixture(t),
    docker = new FakeDocker();
  await main('run', { ...f.env, CRS_PORT: '5180', CRS_IMPORT_DIAGNOSTICS: 'true' }, () => docker);
  const key = readFileSync(join(f.state, 'proxy-key'), 'utf8');
  assert.equal(statSync(join(f.state, 'proxy-key')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(docker.calls).includes(key.trim()));
  const up = docker.calls.find((c) => c.args.includes('up'))!;
  assert.equal(up.env!.CRS_DATA_DIR, f.data);
  assert.equal(up.env!.CRS_MODEL, 'fictional-alias');
  assert.equal(up.env!.CRS_IMPORT_DIAGNOSTICS, 'true');
  assert.equal(up.env!.CRS_STATE_DIR, f.state);
  assert.equal(up.env!.CRS_LITELLM_CONFIG, f.config);
  assert.match(up.env!.CRS_BUILD_REVISION!, /^(?:[a-f0-9]{40}|[a-f0-9]{64}|unknown)$/);
  assert.ok(['clean', 'dirty', 'unknown'].includes(up.env!.CRS_BUILD_WORKTREE!));
  const build = docker.calls.find((c) => c.args.includes('build') && c.args.includes('health'))!;
  assert.equal(build.env!.CRS_BUILD_REVISION, up.env!.CRS_BUILD_REVISION);
  assert.equal(build.env!.CRS_BUILD_WORKTREE, up.env!.CRS_BUILD_WORKTREE);
  assert.equal(up.env!.CRS_RESPONSE_MODEL, 'fictional-upstream');
  assert.equal(up.env!.CRS_IMAGES, 'false');
  assert.equal(up.env!.CRS_PROMPT_CACHE, 'false');
  assert.equal(up.env!.CRS_PDF, 'auto');
  assert.equal(up.env!.CRS_PUBLIC_ORIGIN, 'http://localhost:5180');
  assert.match(up.env!.CRS_IMAGE!, /^circus-health:[a-f0-9]{12}$/u);
  assert.ok(up.args.includes('--abort-on-container-exit'));
  const preflight = docker.calls.find((c) =>
    c.args.some((arg) => arg.includes('validateRuntimeDirectory')),
  )!;
  assert.ok(preflight.args.includes('--no-deps'));
  assert.ok(docker.calls.indexOf(preflight) < docker.calls.indexOf(up));
  assert.ok(docker.calls.at(-1)!.args.includes('down'));
  for (const pdf of ['auto', 'true', 'false'])
    await main('run', { ...f.env, CRS_PDF: pdf }, () => docker);
  assert.equal(readFileSync(join(f.state, 'proxy-key'), 'utf8'), key);
  await assert.rejects(
    main('run', { ...f.env, CRS_PDF: 'maybe' }, () => docker),
    /CRS_PDF must/,
  );
});

test('failed daemon preflight never transfers writer domain; runtime failure still cleans its stack', async (t) => {
  const f = fixture(t),
    docker = new FakeDocker();
  writeFileSync(join(f.data, '.health-writer-domain'), 'darwin\n');
  docker.fail = (args) => args[0] === 'info';
  await assert.rejects(main('run', f.env, () => docker));
  assert.equal(readFileSync(join(f.data, '.health-writer-domain'), 'utf8'), 'darwin\n');
  assert.equal(existsSync(join(f.data, '.health-writer.lock')), false);
  writeFileSync(join(f.data, '.health-writer-domain'), 'linux\n');
  docker.fail = (args) => args.some((arg) => arg.includes('validateRuntimeDirectory'));
  await assert.rejects(main('run', f.env, () => docker));
  assert.equal(
    docker.calls.some((c) => c.args.includes('up')),
    false,
  );
  assert.ok(docker.calls.at(-1)!.args.includes('down'));
});

test('ChatGPT login isolates auth, never opens an archive or forwards provider env', async (t) => {
  const f = fixture(t),
    docker = new FakeDocker();
  await main('login-chatgpt', { CRS_STATE_DIR: f.state }, () => docker);
  assert.equal(docker.calls.length, 1);
  const args = docker.calls[0]!.args;
  for (const flag of ['--read-only', '--cap-drop', '--pids-limit', '--cpus', '--security-opt'])
    assert.ok(args.includes(flag));
  assert.ok(args.includes('CHATGPT_TOKEN_DIR=/var/lib/litellm/chatgpt'));
  assert.ok(!args.includes('--env-file'));
  assert.deepEqual(args.slice(-2), ['-u', '/opt/circus/login.py']);
  assert.equal(statSync(f.state).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.state, 'chatgpt')).mode & 0o777, 0o700);
  assert.equal(existsSync(join(f.state, 'proxy-key')), false);
  assert.equal(existsSync(join(f.data, '.health-writer.lock')), false);
});

test('path validation rejects Git trees, symlink escapes and overlapping secrets', (t) => {
  const f = fixture(t);
  const code = join(f.root, 'code');
  mkdirSync(join(code, '.git'), { recursive: true });
  mkdirSync(join(code, 'data'));
  const link = join(f.root, 'data');
  symlinkSync(join(code, 'data'), link);
  assert.throws(() => dataDirectory({ CRS_DATA_DIR: link }), /outside Git/);
  writeFileSync(join(f.data, 'secret'), 'fictional');
  assert.throws(() => external(join(f.data, 'secret'), 'secret', { data: f.data }), /separate/);
  assert.throws(
    () => external(join(f.root, 'fictional archive'), 'state', { directory: true, data: f.data }),
    /separate/,
  );
  assert.throws(() => external('relative', 'config'), /absolute/);
});

test('origins, image tags and retired settings fail closed', async () => {
  assert.equal(publicOrigin({}, '5180'), 'http://localhost:5180');
  assert.equal(
    publicOrigin({ CRS_PUBLIC_ORIGIN: 'https://circus.example.test' }, '5180'),
    'https://circus.example.test',
  );
  for (const origin of [
    'https://circus.example.test/path',
    'https://user:secret@circus.example.test',
    'https://circus.example.test?',
    'https://circus.example.test#',
    'http://untrusted.example',
    'https://circus.example.test:0',
    'https://circus.example.test:65536',
    'https://CIRCUS.example.test',
  ])
    assert.throws(() => publicOrigin({ CRS_PUBLIC_ORIGIN: origin }, '5180'));
  assert.equal(applicationImage({}, 'build'), 'circus-health:build');
  for (const image of ['bad tag', '--option', 'https://example.test/image', 'image@sha256:abc'])
    assert.throws(() => applicationImage({ CRS_IMAGE: image }, 'build'));
  await assert.rejects(main('run', { RUNTIME: 'docker' }), /Retired options/);
});

test('nonempty incidental env and symlinked proxy keys cannot override Compose', async (t) => {
  const f = fixture(t),
    docker = new FakeDocker();
  mkdirSync(f.state);
  writeFileSync(join(f.state, 'empty.env'), 'CRS_PORT=1\n');
  await assert.rejects(
    main('run', f.env, () => docker),
    /empty regular file/,
  );
  assert.ok(!docker.calls.some((c) => c.args[0] === 'compose'));
  rmSync(join(f.state, 'empty.env'));
  rmSync(join(f.state, 'proxy-key'));
  const other = join(f.root, 'other-key');
  writeFileSync(other, `sk-${'a'.repeat(64)}\n`);
  symlinkSync(other, join(f.state, 'proxy-key'));
  await assert.rejects(
    main('run', f.env, () => docker),
    /proxy-key is invalid/,
  );
});

test('kernel leases serialize launchers, preserve inode and retain macOS writer reservation', async (t) => {
  const f = fixture(t),
    docker = new FakeDocker();
  const lock = acquireLauncherLock(f.data);
  const inode = statSync(join(f.data, '.health-launcher.lock')).ino;
  try {
    assert.throws(() => acquireLauncherLock(f.data), /active Docker launcher/);
    await assert.rejects(
      main('run', f.env, () => docker),
      /active Docker launcher/,
    );
    assert.ok(!docker.calls.some((c) => c.args[0] === 'compose'));
  } finally {
    lock.release();
  }
  const next = acquireLauncherLock(f.data);
  next.release();
  assert.equal(statSync(join(f.data, '.health-launcher.lock')).ino, inode);
  writeFileSync(join(f.data, '.health-writer-domain'), 'darwin\n');
  const writer = lease(f.data, 'darwin')!;
  try {
    assert.throws(() => lease(f.data, 'darwin'), /active writer/);
    assert.equal(readFileSync(join(f.data, '.health-writer-domain'), 'utf8'), 'linux\n');
  } finally {
    writer.release();
  }
});

test('Docker reports cleanup failures explicitly and uses bounded forced shutdown', async (t) => {
  const f = fixture(t);
  const docker = new Docker(process.execPath, false);
  docker.stopGraceMs = 100;
  docker.terminateGraceMs = 100;
  docker.killGraceMs = 5000;
  docker.cleanupTimeoutMs = 100;
  await assert.rejects(
    docker.run(['-e', 'process.exit(3)'], { cleanup: true }),
    /containers may still be running/,
  );
  const ready = join(f.root, 'ready');
  const program = `const fs=require('node:fs'); process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},100);`;
  const running = docker.run(['-e', program]);
  const rejected = assert.rejects(running, Cancelled);
  t.after(() => docker.forward('SIGKILL'));
  for (let attempt = 0; attempt < 2000 && !existsSync(ready); attempt++) await delay(10);
  assert.ok(existsSync(ready));
  docker.stop('SIGINT');
  await rejected;
  assert.equal(docker.child, undefined);
  const cleanup = new Docker(process.execPath, false);
  cleanup.cleanupTimeoutMs = 100;
  cleanup.terminateGraceMs = 100;
  cleanup.killGraceMs = 5000;
  await assert.rejects(
    cleanup.run(['-e', program], { cleanup: true }),
    /containers may still be running/,
  );
});

test('signals reach Docker descendants; repeated terminal signals cannot interrupt cleanup', async (t) => {
  const f = fixture(t);
  const ready = join(f.root, 'ready'),
    stopped = join(f.root, 'stopped'),
    cleanupReady = join(f.root, 'cleanup-ready'),
    release = join(f.root, 'release');
  const childScript = join(f.root, 'plugin.mjs');
  writeFileSync(
    childScript,
    `import fs from 'node:fs'; process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)}); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},100);`,
  );
  const harness = `import {Docker,Cancelled} from ${JSON.stringify(join(ROOT, 'deploy/run.ts'))}; const d=new Docker(${JSON.stringify(process.execPath)}); try {try {await d.run(['-e',${JSON.stringify(`const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'inherit'}); process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0))}); setInterval(()=>{},100);`)}])} finally {await d.run(['-e',${JSON.stringify(`const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(cleanupReady)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer)}},20);`)}],{cleanup:true})}} catch(e){if(!(e instanceof Cancelled))throw e} finally{d.dispose()}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const waitFor = async (path: string) => {
    for (let count = 0; count < 2000 && !existsSync(path); count++) await delay(10);
    assert.ok(existsSync(path), `${path} not ready: ${stderr}`);
  };
  await waitFor(ready);
  child.kill('SIGTERM');
  await waitFor(cleanupReady);
  assert.ok(existsSync(stopped));
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) child.kill(signal);
  await delay(100);
  assert.equal(child.exitCode, null);
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  writeFileSync(release, 'release');
  assert.equal(await exited, 0, stderr);
});

test('root npm commands expose help and validate an archive without invoking Docker', (t) => {
  const f = fixture(t);
  const env = { ...process.env, CRS_DATA_DIR: f.data, CRS_DOCKER: join(f.root, 'not-installed') };
  for (const key of ['RUNTIME', 'AI', 'AI_URL', 'KEY_FILE', 'AUTH_DIR', 'ENV_FILE', 'STACK'])
    delete env[key as keyof typeof env];
  const help = spawnSync('npm', ['run', 'help'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /npm run login:chatgpt/u);
  const valid = spawnSync('npm', ['run', 'check:data'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Archive mount location valid/u);
  const invalid = spawnSync('npm', ['run', 'check:data'], {
    cwd: ROOT,
    env: { ...env, CRS_DATA_DIR: 'relative' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /absolute path outside Git/u);
});

test('a Docker leader exiting early does not abandon its unresponsive plugin process group', async (t) => {
  const f = fixture(t),
    ready = join(f.root, 'orphan-ready');
  const plugin = join(f.root, 'orphan.mjs');
  writeFileSync(
    plugin,
    `import fs from 'node:fs'; process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},100);`,
  );
  const docker = new Docker(process.execPath, false);
  docker.stopGraceMs = 100;
  docker.terminateGraceMs = 100;
  docker.killGraceMs = 5000;
  const running = docker.run([
    '-e',
    `const {spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(plugin)}],{stdio:'inherit'});child.unref(); const fs=require('node:fs'); const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(wait)}},20);`,
  ]);
  const rejected = assert.rejects(running, /forced shutdown/u);
  t.after(() => {
    if (existsSync(ready)) {
      try {
        process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
  await rejected;
  assert.ok(existsSync(ready));
  const pid = Number(readFileSync(ready, 'utf8'));
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    await delay(20);
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test(
  'npm start terminal process-group signals still complete Compose cleanup',
  { timeout: 120_000 },
  async (t) => {
    const f = fixture(t);
    const preload = join(f.root, 'docker-preload.mjs');
    // Node is the executable, even on noexec fixture mounts. The preload acts only
    // on Docker action names and leaves npm and the launcher modules untouched.
    writeFileSync(
      preload,
      `
import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const action=path.basename(process.argv[1] || '');
if(['info','run','compose'].includes(action)) {
 const marker=name=>path.join(process.env.CRS_SIGNAL_ROOT,name);
 if(action==='info') { console.log('fictional'); process.exit(0); }
 if(action==='run') { console.log(JSON.stringify({response_model:'fictional-upstream',images:false,promptCache:false})); process.exit(0); }
 if(process.argv.includes('up')) {
   const child=spawn(process.execPath,['-e', \`const fs=require('node:fs'); for(const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig,()=>{fs.writeFileSync(\${JSON.stringify(marker('plugin-stopped'))},sig);process.exit(0)});fs.writeFileSync(\${JSON.stringify(marker('plugin-ready'))},String(process.pid));setInterval(()=>{},50);\`],{stdio:'ignore'});
   for(const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig,()=>{fs.writeFileSync(marker('up-stopped'),sig); if(child.exitCode!==null)process.exit(0);else child.once('exit',()=>process.exit(0));});
   fs.writeFileSync(marker('up-pid'),String(process.pid)); setInterval(()=>{},50); await new Promise(()=>{});
 } else if(process.argv.includes('down')) { fs.writeFileSync(marker('down'),String(process.pid)); process.exit(0); }
 else process.exit(0);
}
`,
    );
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const root = join(f.root, signal);
      mkdirSync(root);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...f.env,
        CRS_DOCKER: process.execPath,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        CRS_SIGNAL_ROOT: root,
      };
      for (const key of [
        'RUNTIME',
        'AI',
        'AI_URL',
        'KEY_FILE',
        'AUTH_DIR',
        'ENV_FILE',
        'STACK',
        'CRS_PDF',
        'CRS_IMAGES',
        'CRS_RESPONSE_MODEL',
        'CRS_PROMPT_CACHE',
      ])
        delete env[key];
      const child = spawn('npm', ['run', 'start'], {
        cwd: ROOT,
        env,
        detached: true,
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (bytes) => {
        stderr += String(bytes);
      });
      child.stdout.resume();
      const waitFor = async (name: string) => {
        const target = join(root, name);
        for (let attempt = 0; attempt < 2000 && !existsSync(target); attempt++) await delay(10);
        assert.ok(existsSync(target), `${signal} ${name}: ${stderr}`);
      };
      try {
        await waitFor('plugin-ready');
        process.kill(-child.pid!, signal);
        await waitFor('down');
        assert.equal(readFileSync(join(root, 'plugin-stopped'), 'utf8'), signal);
        assert.equal(readFileSync(join(root, 'up-stopped'), 'utf8'), signal);
        for (const name of ['up-pid', 'plugin-ready']) {
          const pid = Number(readFileSync(join(root, name), 'utf8'));
          for (let attempt = 0; attempt < 500; attempt++) {
            try {
              process.kill(pid, 0);
            } catch {
              break;
            }
            await delay(20);
          }
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        }
      } finally {
        for (const name of ['up-pid', 'plugin-ready'])
          if (existsSync(join(root, name))) {
            try {
              process.kill(Number(readFileSync(join(root, name), 'utf8')), 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* npm and launcher exited */
        }
      }
    }
  },
);

test('image build propagates repository metadata instead of accepting caller identity claims', async () => {
  const docker = new FakeDocker();
  await main(
    'build',
    { CRS_BUILD_REVISION: '/fictional/not-a-revision', CRS_BUILD_WORKTREE: 'clean' },
    () => docker,
  );
  const args = docker.calls[0]!.args;
  assert.equal(args[0], 'build');
  assert.ok(
    args.some((arg) => /^CRS_BUILD_REVISION=(?:[a-f0-9]{40}|[a-f0-9]{64}|unknown)$/.test(arg)),
  );
  assert.ok(args.some((arg) => /^CRS_BUILD_WORKTREE=(?:clean|dirty|unknown)$/.test(arg)));
  assert.equal(
    args.some((arg) => arg.includes('/fictional')),
    false,
  );
  const compose = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  for (const field of ['CRS_BUILD_REVISION', 'CRS_BUILD_WORKTREE']) {
    assert.ok(compose.includes(field + ': ${' + field + ':-unknown}'));
    assert.ok(dockerfile.includes('ARG ' + field + '=unknown'));
  }
});

test('legacy launcher settings require migration instead of selecting another archive or auth directory', async (t) => {
  const f = fixture(t);
  for (const [oldKey, newKey] of [
    ['DATA_DIR', 'CRS_DATA_DIR'],
    ['STATE_DIR', 'CRS_STATE_DIR'],
    ['MODEL', 'CRS_MODEL'],
    ['HEALTH_IMPORT_DIAGNOSTICS', 'CRS_IMPORT_DIAGNOSTICS'],
  ]) {
    const env: NodeJS.ProcessEnv = { ...f.env, [oldKey!]: 'old-setting' };
    delete env[newKey!];
    const docker = new FakeDocker();
    await assert.rejects(
      main('run', env, () => docker),
      new RegExp(newKey!),
    );
    assert.equal(docker.calls.length, 0);
  }
  const docker = new FakeDocker();
  await main(
    'run',
    {
      ...f.env,
      STATE_DIR: '/unused-old-state',
      HEALTH_IMPORT_DIAGNOSTICS: 'false',
      CRS_IMPORT_DIAGNOSTICS: 'true',
    },
    () => docker,
  );
  const up = docker.calls.find((call) => call.args.includes('up'))!;
  assert.equal(up.env!.CRS_STATE_DIR, f.state);
  assert.equal(up.env!.CRS_IMPORT_DIAGNOSTICS, 'true');
});
