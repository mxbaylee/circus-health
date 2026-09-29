import type { Plugin } from 'vite';
import { sanitizeBuildIdentity, type BuildIdentity } from '../shared/build-identity.ts';
import { readBuildSource } from './build-source.ts';

/** Called once by the production build, never by the running server. */
export function createBuildIdentity(cwd = process.cwd(), env = process.env): BuildIdentity {
  const source =
    Object.hasOwn(env, 'CRS_BUILD_REVISION') || Object.hasOwn(env, 'CRS_BUILD_WORKTREE')
      ? sanitizeBuildIdentity({
          revision: env.CRS_BUILD_REVISION,
          worktree: env.CRS_BUILD_WORKTREE,
        })
      : readBuildSource(cwd);
  return { ...source, buildId: globalThis.crypto.randomUUID() };
}

export function buildIdentityPlugin(identity: BuildIdentity): Plugin {
  return {
    name: 'circus-build-identity',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify(identity) + '\n',
      });
    },
  };
}
