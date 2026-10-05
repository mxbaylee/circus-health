import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
      /reviewed-main/.test(String((error as { stderr?: Buffer }).stderr)),
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

const publisher = fileURLToPath(new URL('./publish.ts', import.meta.url));
function publicationFixture(
  run: (context: {
    directory: string;
    source: string;
    revision: string;
    git: (args: string[]) => string;
    publish: (event: string, extra?: NodeJS.ProcessEnv) => string;
  }) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), 'checker-publish-test-'));
  const remote = join(directory, 'remote.git');
  const source = join(directory, 'dist/passkey-checker');
  const config = join(directory, 'gitconfig');
  // Exercise real Git against a fictional local remote; forbid all network protocols.
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fictional Tester',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Fictional Tester',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (args: string[]) =>
    execFileSync('git', ['--git-dir', remote, ...args], {
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  try {
    writeFileSync(config, '');
    execFileSync(
      'git',
      [
        'config',
        '--file',
        config,
        `url.${pathToFileURL(remote).href}.insteadOf`,
        'https://github.com/fictional/checker.git',
      ],
      { env, stdio: 'pipe' },
    );
    execFileSync('git', ['init', '--bare', '--quiet', remote], { env, stdio: 'pipe' });
    const tree = git(['mktree']);
    const sourceRevision = git(['commit-tree', tree, '-m', 'Fictional reviewed main']);
    git(['update-ref', 'refs/heads/main', sourceRevision]);
    mkdirSync(join(source, 'assets'), { recursive: true });
    writeFileSync(
      join(source, 'index.html'),
      `<meta content="connect-src 'none'; script-src 'self'; style-src 'self'">`,
    );
    writeFileSync(
      join(source, 'build-info.json'),
      JSON.stringify({ version: '3', revision: sourceRevision, worktree: 'clean' }),
    );
    writeFileSync(
      join(source, 'assets/index-abc.js'),
      '/* fictional fixture */\n//# sourceMappingURL=index-abc.js.map',
    );
    // The source map alone exceeds execFileSync's default stdout buffer.
    writeFileSync(
      join(source, 'assets/index-abc.js.map'),
      JSON.stringify({
        version: 3,
        file: 'index-abc.js',
        sources: ['../../src/app/passkey-checker/core.ts'],
        sourcesContent: ['// ' + 'fictional source '.repeat(140000)],
        names: [],
        mappings: 'AAAA',
      }),
    );
    run({
      directory,
      source,
      revision: sourceRevision,
      git,
      publish: (event, extra = {}) =>
        execFileSync(process.execPath, [publisher], {
          cwd: directory,
          env: {
            ...env,
            GITHUB_EVENT_NAME: event,
            GITHUB_REF: 'refs/heads/main',
            GITHUB_SHA: sourceRevision,
            GITHUB_REPOSITORY: 'fictional/checker',
            GH_TOKEN: 'fictional-test-token',
            ...extra,
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const event of ['workflow_dispatch', 'push'])
  test(`${event} publisher exports large source maps and preserves generated history`, () =>
    publicationFixture(({ directory, source, revision, git, publish }) => {
      let parent: string | undefined;
      for (let iteration = 0; iteration < 2; iteration++) {
        const result = publish(event);
        const commit = git(['rev-parse', 'refs/heads/gh-pages']);
        assert.match(
          result,
          new RegExp(`Published gh-pages commit ${commit} from reviewed main ${revision}`),
        );
        assert.doesNotMatch(result, /fictional-test-token|AUTHORIZATION/);
        if (parent) assert.equal(git(['rev-parse', `${commit}^`]), parent);
        else assert.equal(git(['rev-list', '--count', commit]), '1');
        parent = commit;
        const published = join(directory, 'dist/passkey-checker-published');
        const files = validateCheckerFiles(source, revision);
        assert.deepEqual(validateCheckerFiles(published, revision), files);
        assert.deepEqual(git(['ls-tree', '-r', '--name-only', commit]).split('\n').sort(), files);
        for (const file of files)
          assert.deepEqual(readFileSync(join(published, file)), readFileSync(join(source, file)));
        assert.equal(git(['rev-parse', 'refs/heads/main']), revision);
      }
    }));

test('publication refuses other events, refs and incomplete workflow context before side effects', () =>
  publicationFixture(({ directory, git, publish }) => {
    const before = readdirSync(directory).sort();
    for (const [event, extra] of [
      ['pull_request', {}],
      ['pull_request_target', {}],
      ['workflow_run', {}],
      ['workflow_dispatch', { GITHUB_REF: 'refs/heads/topic' }],
      ['push', { GITHUB_REF: 'refs/heads/topic' }],
      ['push', { GITHUB_REF: 'refs/heads/gh-pages' }],
      ['push', { GITHUB_REF: 'refs/tags/main' }],
      ['push', { GITHUB_SHA: 'invalid' }],
      ['push', { GITHUB_REPOSITORY: 'fictional/checker/extra' }],
      ['push', { GH_TOKEN: '' }],
    ] as const) {
      assert.throws(
        () => publish(event, extra),
        (error) => {
          const stderr = String((error as { stderr?: Buffer }).stderr);
          assert.match(stderr, /reviewed-main/);
          assert.doesNotMatch(stderr, /fictional-test-token|AUTHORIZATION/);
          return true;
        },
      );
      assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads/gh-pages']), '');
      assert.deepEqual(readdirSync(directory).sort(), before);
    }
  }));

test('publication refuses a stale main revision without advancing generated history', () =>
  publicationFixture(({ revision, git, publish }) => {
    const next = git(['commit-tree', git(['mktree']), '-p', revision, '-m', 'Fictional next main']);
    git(['update-ref', 'refs/heads/main', next]);
    assert.throws(
      () => publish('push'),
      (error) => {
        const stderr = String((error as { stderr?: Buffer }).stderr);
        assert.match(stderr, /during verify current main/);
        assert.doesNotMatch(stderr, /fictional-test-token|AUTHORIZATION/);
        return true;
      },
    );
    assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/heads/gh-pages']), '');
    assert.equal(git(['rev-parse', 'refs/heads/main']), next);
  }));

test('archive extraction failure reports its safe stage without advancing gh-pages', () =>
  publicationFixture(({ directory, git, publish }) => {
    publish('workflow_dispatch');
    const previous = git(['rev-parse', 'refs/heads/gh-pages']);
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'tar'),
      '#!/bin/sh\necho "FICTIONAL_SECRET_PROCESS_DETAIL" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    assert.throws(
      () => publish('push', { PATH: `${bin}:${process.env.PATH}` }),
      (error) => {
        const stderr = String((error as { stderr?: Buffer }).stderr);
        assert.match(stderr, /during prepare Pages artifact/);
        assert.doesNotMatch(
          stderr,
          /FICTIONAL_SECRET_PROCESS_DETAIL|fictional-test-token|AUTHORIZATION/,
        );
        return true;
      },
    );
    assert.equal(git(['rev-parse', 'refs/heads/gh-pages']), previous);
  }));

test('publication workflow runs for main merges and manual dispatch without a gh-pages loop', () => {
  const workflow = readFileSync('.github/workflows/passkey-checker.yml', 'utf8');
  const triggers = workflow.split('\npermissions:')[0];
  assert.match(triggers, /\n  push:\n    branches: \[main\]\n/);
  assert.match(triggers, /\n  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /pull_request|workflow_run|gh-pages|paths:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /cancel-in-progress: false/);
});
