import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { validateCheckerFiles } from './validate.ts';
import { createGeneratedCommit } from './git.ts';

// Only merged-main pushes and manual main runs may publish; arbitrary source refs are refused.
const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN } = process.env;
if (
  !['workflow_dispatch', 'push'].includes(GITHUB_EVENT_NAME ?? '') ||
  GITHUB_REF !== 'refs/heads/main' ||
  !GITHUB_SHA ||
  !/^[a-f0-9]{40}$/.test(GITHUB_SHA) ||
  !GITHUB_REPOSITORY ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_REPOSITORY) ||
  !GH_TOKEN
) {
  throw new Error('Publication requires a reviewed-main push or manual workflow context.');
}
const source = resolve('dist/passkey-checker');
validateCheckerFiles(source, GITHUB_SHA);
const temporary = mkdtempSync(join(tmpdir(), 'passkey-checker-publish-'));
const git = (args: string[], input?: string | Buffer) =>
  execFileSync('git', args, {
    cwd: temporary,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${GH_TOKEN}`).toString('base64')}`,
    },
  });
let stage = 'initialize publication';
try {
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', `https://github.com/${GITHUB_REPOSITORY}.git`]);
  stage = 'verify current main';
  git(['fetch', '--quiet', '--depth=1', 'origin', 'refs/heads/main']);
  if (git(['rev-parse', 'FETCH_HEAD']).trim() !== GITHUB_SHA)
    throw new Error('Reviewed main advanced; build its new revision before publication.');
  stage = 'read generated history';
  const existing = git(['ls-remote', '--heads', 'origin', 'refs/heads/gh-pages'])
    .trim()
    .split(/\s/)[0];
  let parent: string | undefined;
  if (existing) {
    git(['fetch', '--quiet', '--depth=1', 'origin', 'refs/heads/gh-pages']);
    parent = git(['rev-parse', 'FETCH_HEAD']).trim();
  }
  stage = 'create generated commit';
  const commit = createGeneratedCommit(temporary, source, GITHUB_SHA, parent);
  stage = 'prepare Pages artifact';
  const published = resolve('dist/passkey-checker-published');
  rmSync(published, { recursive: true, force: true });
  mkdirSync(published, { recursive: true });
  // Source maps exceed execFileSync's stdout limit. Keep archive bytes on disk, not in a pipe.
  const archive = join(temporary, 'checker.tar');
  git(['archive', '--format=tar', '--output', archive, commit]);
  execFileSync('tar', ['-xf', archive, '-C', published], { stdio: 'pipe' });
  validateCheckerFiles(published, GITHUB_SHA);
  stage = 'push generated assets';
  // Validate extraction first; an ordinary push still refuses competing branch history.
  git(['push', '--quiet', 'origin', `${commit}:refs/heads/gh-pages`]);
  console.log(`Published gh-pages commit ${commit} from reviewed main ${GITHUB_SHA}.`);
} catch {
  // Stages are fixed labels. Git errors may carry authenticated headers; never emit them.
  throw new Error(
    `Checker publication failed during ${stage}; inspect branch state and run a current-main build.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
