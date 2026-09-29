import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createBuildIdentity, buildIdentityPlugin } from './src/scripts/build-identity.ts';

const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
const dependencyRoot = realpathSync(fileURLToPath(new URL('./node_modules/', import.meta.url)));

export default defineConfig(({ command }) => {
  const identity = command === 'build' ? createBuildIdentity() : null;
  return {
    root: sourceRoot,
    define: {
      __CIRCUS_BUILD_ID__: JSON.stringify(identity?.buildId ?? null),
      __CIRCUS_BUILD_SOURCE__: JSON.stringify(
        identity ? { revision: identity.revision, worktree: identity.worktree } : null,
      ),
    },
    plugins: [react(), ...(identity ? [buildIdentityPlugin(identity)] : [])],
    server: {
      proxy: { '/api': 'http://127.0.0.1:3001' },
      port: 5173,
      strictPort: true,
      fs: { strict: true, allow: [sourceRoot, dependencyRoot] },
    },
    preview: { proxy: { '/api': 'http://127.0.0.1:3001' }, port: 4173, strictPort: true },
  };
});
