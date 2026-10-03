import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { validateCheckerFiles } from './validate.ts';
import { createGeneratedCommit } from './git.ts';

// Called only by the manual workflow; there is no input for an arbitrary source ref.
const { GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN } = process.env;
if (
  GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  GITHUB_REF !== 'refs/heads/main' ||
  !GITHUB_SHA ||
  !/^[a-f0-9]{40}$/.test(GITHUB_SHA) ||
  !GITHUB_REPOSITORY ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(GITHUB_REPOSITORY) ||
  !GH_TOKEN
) {
  throw new Error('Publication requires the manual reviewed-main workflow context.');
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
try {
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', `https://github.com/${GITHUB_REPOSITORY}.git`]);
  git(['fetch', '--quiet', '--depth=1', 'origin', 'refs/heads/main']);
  if (git(['rev-parse', 'FETCH_HEAD']).trim() !== GITHUB_SHA)
    throw new Error('Reviewed main advanced; build its new revision before publication.');
  const existing = git(['ls-remote', '--heads', 'origin', 'refs/heads/gh-pages'])
    .trim()
    .split(/\s/)[0];
  let parent: string | undefined;
  if (existing) {
    git(['fetch', '--quiet', '--depth=1', 'origin', 'refs/heads/gh-pages']);
    parent = git(['rev-parse', 'FETCH_HEAD']).trim();
  }
  const commit = createGeneratedCommit(temporary, source, GITHUB_SHA, parent);
  // An ordinary push rejects a competing publication; never rewrite gh-pages history.
  git(['push', '--quiet', 'origin', `${commit}:refs/heads/gh-pages`]);
  const published = resolve('dist/passkey-checker-published');
  rmSync(published, { recursive: true, force: true });
  mkdirSync(published, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: temporary });
  execFileSync('tar', ['-xf', '-', '-C', published], { input: archive });
  validateCheckerFiles(published, GITHUB_SHA);
  console.log(`Published gh-pages commit ${commit} from reviewed main ${GITHUB_SHA}.`);
} catch {
  // Git failures may carry authenticated headers: never emit raw process errors.
  throw new Error(
    'Checker publication failed; inspect branch state and rerun a reviewed-main build.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
