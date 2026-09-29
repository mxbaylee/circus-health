import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBuildSource } from './build-source.ts';

test('build source distinguishes clean, changed, untracked and unavailable Git without exporting filenames', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-build-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readBuildSource(root), { revision: null, worktree: 'unknown' });
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init');
  writeFileSync(join(root, 'fictional-source.txt'), 'fictional source');
  git('add', '.');
  // Only this disposable independently fictional repository is committed.
  git(
    '-c',
    'user.name=Fictional Builder',
    '-c',
    'user.email=builder@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fictional build fixture',
  );
  const revision = git('rev-parse', 'HEAD');
  assert.deepEqual(readBuildSource(root), { revision, worktree: 'clean' });
  writeFileSync(join(root, 'fictional-source.txt'), 'changed source');
  assert.deepEqual(readBuildSource(root), { revision, worktree: 'dirty' });
  git('checkout', '--', 'fictional-source.txt');
  writeFileSync(join(root, 'fictional-private-name.txt'), 'not exported');
  const state = readBuildSource(root);
  assert.deepEqual(state, { revision, worktree: 'dirty' });
  assert.equal(JSON.stringify(state).includes('fictional'), false);
});
