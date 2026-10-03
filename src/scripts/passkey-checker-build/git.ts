import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateCheckerFiles } from './validate.ts';

/** A new empty index prevents source or previous-branch files entering the generated tree. */
export function createGeneratedCommit(
  repository: string,
  directory: string,
  revision: string,
  parent?: string,
): string {
  const files = validateCheckerFiles(directory, revision);
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd: repository,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'github-actions[bot]',
        GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'github-actions[bot]',
        GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });
  git(['read-tree', '--empty']);
  for (const file of files) {
    mkdirSync(join(repository, file, '..'), { recursive: true });
    cpSync(join(directory, file), join(repository, file));
  }
  git(['add', '--', ...files]);
  const tree = git(['write-tree']).trim();
  return git(
    ['commit-tree', tree, ...(parent ? ['-p', parent] : [])],
    `Publish passkey checker from ${revision}\n`,
  ).trim();
}
