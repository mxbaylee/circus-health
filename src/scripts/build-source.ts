import { execFileSync } from 'node:child_process';
import { sanitizeBuildIdentity, type BuildSourceIdentity } from '../shared/build-identity.ts';

/** Read only at build time. Git output stays local; only an object ID and state leave here. */
export function readBuildSource(cwd: string): BuildSourceIdentity {
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    const revision = git(['rev-parse', '--verify', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']).length > 0;
    const safe = sanitizeBuildIdentity({ revision, worktree: dirty ? 'dirty' : 'clean' });
    return { revision: safe.revision, worktree: safe.worktree };
  } catch {
    return { revision: null, worktree: 'unknown' };
  }
}
