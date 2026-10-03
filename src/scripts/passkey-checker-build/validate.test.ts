import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertCheckerModule, validateCheckerFiles } from './validate.ts';
import { createGeneratedCommit } from './git.ts';

const revision = 'a'.repeat(40);
function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'checker-files-test-'));
  try {
    mkdirSync(join(directory, 'assets'));
    writeFileSync(join(directory, 'assets/index-abc.js'), '/* fictional fixture */');
    writeFileSync(
      join(directory, 'index.html'),
      `<meta content="connect-src 'none'; script-src 'self'; style-src 'self'">`,
    );
    writeFileSync(
      join(directory, 'build-info.json'),
      JSON.stringify({ version: '2', revision, worktree: 'clean' }),
    );
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('only checker, pure PRF helper, tokens and React enter the browser bundle', () => {
  for (const path of [
    'src/app/passkey-checker/main.tsx',
    'src/app/components/passkey-prf.ts',
    'src/app/tokens.css',
    'src/app/assets/harlequin-dark.svg',
    'node_modules/react-dom/client.js',
  ])
    assertCheckerModule(`/repo/${path}`, '/repo/');
  for (const path of [
    'src/app/main.tsx',
    'src/server/profile-passkeys.ts',
    'src/public/favicon.svg',
    'node_modules/libsodium-wrappers-sumo/index.js',
  ])
    assert.throws(() => assertCheckerModule(`/repo/${path}`, '/repo/'), /unexpected module/);
});

test('publication validates exact clean revision and complete allowlisted output', () =>
  fixture((directory) => {
    assert.equal(validateCheckerFiles(directory, revision).length, 3);
    assert.throws(
      () => validateCheckerFiles(directory, 'b'.repeat(40)),
      /exact clean reviewed revision/,
    );
    writeFileSync(
      join(directory, 'build-info.json'),
      JSON.stringify({ version: '2', revision, worktree: 'dirty' }),
    );
    assert.throws(() => validateCheckerFiles(directory, revision), /exact clean reviewed revision/);
  }));

test('local state, reports, sources and symlinks cannot enter publication', () => {
  for (const name of ['report.md', 'state.json', 'assets/index.js.map', 'assets/source.ts'])
    fixture((directory) => {
      writeFileSync(join(directory, name), 'fictional');
      assert.throws(() => validateCheckerFiles(directory), /Unexpected checker publication file/);
    });
  fixture((directory) => {
    symlinkSync(join(directory, 'index.html'), join(directory, 'assets/link.js'));
    assert.throws(() => validateCheckerFiles(directory), /symlinks/);
  });
});

test('manual publication refuses an unreviewed branch before any network or writes', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['src/scripts/passkey-checker-build/publish.ts'], {
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/topic',
          GITHUB_SHA: revision,
          GITHUB_REPOSITORY: 'fictional/example',
          GH_TOKEN: 'fictional-test-token',
        },
        stdio: 'pipe',
      }),
    (error) =>
      error instanceof Error &&
      /manual reviewed-main/.test(String((error as { stderr?: Buffer }).stderr)),
  );
});

test('generated commits preserve parent history while replacing the tree with only validated assets', () =>
  fixture((directory) => {
    const repository = mkdtempSync(join(tmpdir(), 'checker-git-test-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git(['init', '--quiet']);
      writeFileSync(join(repository, 'obsolete.txt'), 'fictional old publication');
      git(['add', 'obsolete.txt']);
      git([
        '-c',
        'user.name=Fictional Tester',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Fictional previous publication',
      ]);
      const parent = git(['rev-parse', 'HEAD']);
      const commit = createGeneratedCommit(repository, directory, revision, parent);
      assert.equal(git(['rev-parse', `${commit}^`]), parent);
      assert.deepEqual(
        git(['ls-tree', '-r', '--name-only', commit]).split('\n').sort(),
        validateCheckerFiles(directory, revision),
      );
      assert.match(git(['log', '-1', '--format=%B', commit]), new RegExp(revision));
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }));

test('the independent real checker build repeats byte-for-byte and uses the Pages project path', () => {
  const build = () => execFileSync('npm', ['run', 'build:passkey-checker'], { stdio: 'pipe' });
  const snapshot = () =>
    Object.fromEntries(
      validateCheckerFiles('dist/passkey-checker').map((file) => [
        file,
        readFileSync(join('dist/passkey-checker', file), 'base64'),
      ]),
    );
  build();
  const before = snapshot();
  build();
  assert.deepEqual(snapshot(), before);
  const html = readFileSync('dist/passkey-checker/index.html', 'utf8');
  assert.match(html, /src="\/circus-health\/assets\/[A-Za-z0-9_-]+\.js"/);
  assert.match(html, /href="\/circus-health\/assets\/[A-Za-z0-9_-]+\.css"/);
  assert.doesNotMatch(html, /<style|<script[^>]*>[^<]+|https?:\/\//);
});
