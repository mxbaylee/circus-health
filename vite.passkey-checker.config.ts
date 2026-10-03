import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readBuildSource } from './src/scripts/build-source.ts';
import { assertCheckerModule } from './src/scripts/passkey-checker-build/validate.ts';

const repository = fileURLToPath(new URL('.', import.meta.url));
const source = readBuildSource(repository);
const build = { version: '1', revision: source.revision ?? 'unknown', worktree: source.worktree };
export default defineConfig({
  root: fileURLToPath(new URL('./src/app/passkey-checker/', import.meta.url)),
  publicDir: false,
  base: '/circus-health/',
  define: { __PASSKEY_CHECKER_BUILD__: JSON.stringify(build) },
  plugins: [
    react(),
    {
      name: 'checker-only',
      generateBundle(_, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            for (const id of Object.keys(output.modules)) assertCheckerModule(id, repository);
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: 'build-info.json',
          source: JSON.stringify(build) + '\n',
        });
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist/passkey-checker/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
