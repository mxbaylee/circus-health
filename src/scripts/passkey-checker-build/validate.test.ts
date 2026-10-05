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
      JSON.stringify({ version: '3', revision, worktree: 'clean' }),
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
      JSON.stringify({ version: '3', revision, worktree: 'dirty' }),
    );
    assert.throws(() => validateCheckerFiles(directory, revision), /exact clean reviewed revision/);
  }));

test('local state, reports, unrelated sources and symlinks cannot enter publication', () => {
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

test('source maps require a paired script and the same public source scope as the bundle', () =>
  fixture((directory) => {
    const path = join(directory, 'assets/index-abc.js.map');
    const map = {
      version: 3,
      file: 'index-abc.js',
      sources: ['../../src/app/passkey-checker/core.ts'],
      sourcesContent: ['// fictional checker source'],
      names: [],
      mappings: 'AAAA',
    };
    writeFileSync(path, JSON.stringify(map));
    assert.throws(() => validateCheckerFiles(directory), /not referenced/);
    writeFileSync(
      join(directory, 'assets/index-abc.js'),
      '/* fictional fixture */\n//# sourceMappingURL=index-abc.js.map',
    );
    assert.equal(validateCheckerFiles(directory, revision).length, 4);
    for (const sources of [
      ['../../src/server/profile-passkeys.ts'],
      ['https://example.invalid/source.ts'],
      ['/private/source.ts'],
      ['../../src/app/passkey-checker/../../server/example.ts'],
    ]) {
      writeFileSync(path, JSON.stringify({ ...map, sources }));
      assert.throws(() => validateCheckerFiles(directory), /unexpected module|Unexpected/);
    }
    writeFileSync(path, JSON.stringify({ ...map, file: 'different.js' }));
    assert.throws(() => validateCheckerFiles(directory), /Invalid checker source map/);
    writeFileSync(path, JSON.stringify({ ...map, sourceRoot: 'https://example.invalid/' }));
    assert.throws(() => validateCheckerFiles(directory), /Invalid checker source map/);
    writeFileSync(path, JSON.stringify(map));
    writeFileSync(join(directory, 'assets/orphan-abc.js.map'), JSON.stringify(map));
    assert.throws(() => validateCheckerFiles(directory), /Orphan/);
    rmSync(join(directory, 'assets/orphan-abc.js.map'));
    rmSync(path);
    assert.throws(() => validateCheckerFiles(directory), /source map is missing/);
  }));

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
  const files = Object.keys(before);
  assert.ok(files.some((file) => file.endsWith('.js.map')));
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    assert.ok(files.includes(`${file}.map`));
    const map = JSON.parse(readFileSync(join('dist/passkey-checker', `${file}.map`), 'utf8'));
    assert.ok(map.sources.length > 0);
    assert.ok(map.mappings.length > 0);
  }
  const html = readFileSync('dist/passkey-checker/index.html', 'utf8');
  assert.match(html, /src="\/circus-health\/assets\/[A-Za-z0-9_-]+\.js"/);
  assert.match(html, /href="\/circus-health\/assets\/[A-Za-z0-9_-]+\.css"/);
  assert.doesNotMatch(html, /<style|<script[^>]*>[^<]+|https?:\/\//);
});
