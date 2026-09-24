import type { Plugin } from 'vite';

/** Called once by the production build, never by the running server. */
export function createBuildIdentity() {
  return { buildId: globalThis.crypto.randomUUID() };
}

export function buildIdentityPlugin(identity: { buildId: string }): Plugin {
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
