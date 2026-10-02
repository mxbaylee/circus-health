import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { outsideGit } from '../../deploy/run.ts';
import { qualifyArchiveRestore, restoreDrillEnvironment } from './qualify-archive-restore.ts';

function externalTemporaryRoot(): string {
  // Some managed workspaces mark /tmp as a synthetic Git root. Exercise the real
  // external-output guard rather than weakening it for those environments.
  for (const candidate of [tmpdir(), '/dev/shm']) {
    if (!existsSync(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      outsideGit(canonical);
      return canonical;
    } catch {
      // Try another independently external temporary filesystem.
    }
  }
  throw new Error('Qualification guard tests require an external temporary directory.');
}

test('Compose restore qualification requires explicit opt-in before output or tool access', async () => {
  for (const optIn of [undefined, '', 'true', '0']) {
    await assert.rejects(
      qualifyArchiveRestore({
        CRS_ARCHIVE_RESTORE_TEST: optIn,
        CRS_RESTORE_OUTPUT_DIR: 'relative-fictional-output',
        CRS_DOCKER: '/fictional-tool-must-never-run',
      }),
      /Set CRS_ARCHIVE_RESTORE_TEST=1/,
    );
  }
});

test('opted-in qualification refuses missing or relative output before launching tools', async () => {
  for (const output of [undefined, '', 'fictional-output', '../fictional-output']) {
    await assert.rejects(
      qualifyArchiveRestore({
        CRS_ARCHIVE_RESTORE_TEST: '1',
        CRS_RESTORE_OUTPUT_DIR: output,
        CRS_DOCKER: '/fictional-tool-must-never-run',
      }),
      /fresh absolute external directory/,
    );
  }
});

test('qualification refuses existing external output and preserves retained evidence', async (t) => {
  const output = mkdtempSync(join(externalTemporaryRoot(), 'fictional-restore-refusal-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const marker = join(output, 'retained-marker');
  const bytes = Buffer.from([2, 7, 1, 8, 2, 8]);
  writeFileSync(marker, bytes);
  await assert.rejects(
    qualifyArchiveRestore({
      CRS_ARCHIVE_RESTORE_TEST: '1',
      CRS_RESTORE_OUTPUT_DIR: output,
      CRS_DOCKER: '/fictional-tool-must-never-run',
    }),
    /never overwrites an existing output/,
  );
  assert.deepEqual(readFileSync(marker), bytes);
  assert.equal(existsSync(join(output, 'receipts')), false);
});

test('drill environment strips inherited installation and provider selection before fixture overrides', () => {
  const privateKeys = [
    'CRS_DATA_DIR',
    'CRS_STATE_DIR',
    'CRS_RUNTIME_DIR',
    'CRS_LITELLM_CONFIG',
    'CRS_LITELLM_ENV_FILE',
    'CRS_ARCHIVE_RESTORE_TEST',
    'CRS_RESTORE_OUTPUT_DIR',
    'CRS_MODEL',
    'CRS_RESPONSE_MODEL',
    'CRS_DOCKER',
    'CRS_IMAGE',
    'HEALTH_DATA_DIR',
    'CIRCUS_ARCHIVE_DIR',
    'CODEX_HOME',
    'DATA_DIR',
    'STATE_DIR',
    'AUTH_DIR',
    'KEY_FILE',
    'ENV_FILE',
    'CONFIG_FILE',
    'LITELLM_API_KEY',
    'OLLAMA_HOST',
    'CHATGPT_AUTH_DIR',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'TOGETHERAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'PROVIDER_API_KEY',
    'AI',
    'AI_URL',
    'MODEL',
    'MODEL_NAME',
    'RESPONSE_MODEL',
    'STACK',
    'RUNTIME',
    'PORT',
    'IMAGE',
    'NODE',
    'IMAGES',
    'PDF',
    'PROMPT_CACHE',
  ];
  const retained = {
    PATH: '/fictional/tool-path',
    PLAYWRIGHT_BROWSERS_PATH: '/fictional/browser-cache',
    HTTPS_PROXY: 'http://fictional-proxy.invalid',
    HTTP_PROXY: 'http://fictional-proxy.invalid',
    ALL_PROXY: 'http://fictional-proxy.invalid',
    NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: '/fictional/trust-store',
    SSL_CERT_FILE: '/fictional/trust-store',
    DOCKER_HOST: 'unix:///fictional/docker.sock',
    DOCKER_CONFIG: '/fictional/docker-tool-config',
    HOME: '/fictional/home',
    TMPDIR: '/fictional/temporary',
  };
  const inherited = {
    ...Object.fromEntries(privateKeys.map((key) => [key, 'fictional-private-value'])),
    ...retained,
  };
  const before = { ...inherited };
  const isolated = restoreDrillEnvironment(inherited);
  assert.deepEqual(isolated, retained);
  assert.deepEqual(inherited, before, 'Scrubbing must not mutate the parent environment');
  const explicitFixture = {
    ...isolated,
    CRS_DATA_DIR: '/fictional/drill/source/data',
    CRS_STATE_DIR: '/fictional/drill/source-proxy-state',
    CRS_MODEL: 'fictional-restore',
  };
  assert.equal(explicitFixture.CRS_DATA_DIR, '/fictional/drill/source/data');
  assert.equal(explicitFixture.CRS_MODEL, 'fictional-restore');
  assert.equal(explicitFixture.PATH, retained.PATH);
});
