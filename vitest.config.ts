import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(repositoryRoot, 'src');
const dependencyRoot = realpathSync(resolve(repositoryRoot, 'node_modules'));

export default defineConfig({
  root: sourceRoot,
  plugins: [react()],
  // node_modules is intentionally shared from the primary worktree. Allow only
  // that resolved dependency directory so Vite can transform pdfjs assets in
  // mounted component tests without widening the workspace filesystem scope.
  server: { fs: { strict: true, allow: [sourceRoot, dependencyRoot] } },
  test: {
    environment: 'jsdom',
    include: ['tests/mounted/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/mounted/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
