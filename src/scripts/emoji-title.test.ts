import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validEmojiTitle } from './emoji-title.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(
  new URL('../../.github/workflows/lint-pr-title.yml', import.meta.url),
  'utf8',
);
const script = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)?.[1];
assert.ok(script, 'Find the actual CI title check, so changes cannot silently bypass parity tests');

test('local and actual CI validators agree on Unicode emoji and invalid prefixes', () => {
  const cases: [string, boolean][] = [
    ['📚 Update bifrost and processing proposals.', true],
    ['🦦 Add an otter', true],
    ['🧑🏽‍💻 Improve tooling', true],
    ['🇨🇦 Add locale', true],
    ['1️⃣ First step', true],
    ['❤️ Improve care', true],
    [':memo: Update docs', true],
    ['📚 Keep $(commands) and `backticks` literal', true],
    ['Update docs', false],
    ['Update 📚 docs', false],
    ['[📚] Update docs', false],
    [' 📚 Update docs', false],
    ['📚Update docs', false],
    ['📚 ', false],
    ['1 Update docs', false],
    [':invented: Update docs', false],
    ['📚 Update\nextra title line', false],
  ];
  for (const [title, expected] of cases) {
    assert.equal(validEmojiTitle(title), expected, title);
    const result: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: repository,
      input: script,
      env: { ...process.env, PR_TITLE: title },
      encoding: 'utf8',
    });
    assert.equal(result.status, expected ? 0 : 1, `${title}: ${result.stderr}`);
  }
});

test('actual commitlint config checks the subject and retains generated-message exceptions', () => {
  for (const [message, expected] of [
    ['📚 Update bifrost and processing proposals.', 0],
    ['📚 Update docs\n\nBody without an emoji.', 0],
    ['No emoji\n\n📚 An emoji in the body must not rescue the subject.', 1],
    ['[📚] Update docs', 1],
    ['fixup! Earlier commit', 0],
    ["Merge branch 'example'", 0],
  ] as const) {
    const result: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../node_modules/@commitlint/cli/cli.js', import.meta.url))],
      { cwd: repository, input: message + '\n', encoding: 'utf8' },
    );
    assert.equal(result.status, expected, `${message}: ${result.stdout} ${result.stderr}`);
  }
});
