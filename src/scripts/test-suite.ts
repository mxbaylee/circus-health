import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Real service qualification is opt-in, even on a contributor shell configured
// for a live provider. Controlled in-process integration tests stay in server.
const externalTests = new Set([
  'src/server/test/model-providers.integration.test.ts',
  'src/server/test/native-provider-workflow.integration.test.ts',
  'src/server/test/proxy-model-bridge.integration.test.ts',
  'src/server/test/hardened-consumers.integration.test.ts',
  'src/server/test/launch.integration.test.ts',
  'src/server/test/intake-source-ocr-real.test.ts',
]);
const continuation = 'src/server/test/intake-pdf-controlled.integration.test.ts';
const acceptance = 'src/scripts/provider-qualification-acceptance.test.ts';
const patterns: Record<string, string[]> = {
  server: ['src/server/test/*.test.ts'],
  browser: ['src/tests/browser/*.test.ts'],
  tools: ['src/scripts/*.test.ts'],
  deploy: ['deploy/*.test.ts'],
  state: [
    'src/tests/*.test.ts',
    'src/app/features/notes/*.test.ts',
    'src/app/data/*.test.ts',
    'src/app/pages/*.test.ts',
  ],
  continuation: [continuation],
  acceptance: [acceptance],
};
export function suiteFiles(suite: string): string[] {
  if (!patterns[suite]) throw new Error(`Unknown test suite: ${suite}`);
  return globSync(patterns[suite])
    .filter(
      (file) =>
        !externalTests.has(file) &&
        (suite === 'continuation' || file !== continuation) &&
        (suite === 'acceptance' || file !== acceptance),
    )
    .sort();
}
export function testEnvironment(env: NodeJS.ProcessEnv, suite: string): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result))
    if (
      key.startsWith('CRS_AI_') ||
      /^CRS_.*(?:INTEGRATION_TEST|LIVE_TEST|WORKFLOW_TEST)$/.test(key) ||
      [
        'CRS_DATA_DIR',
        'CRS_RUNTIME_DIR',
        'CRS_CODEX_HOME',
        'CRS_TEST_CODE_ROOT',
        'CRS_CONSUMER_TEST_IMAGE',
        'CRS_SOURCE_OCR_REAL',
        'CRS_LAUNCH_TEST',
        'CRS_PASSKEY_DOCKER_TEST',
        'CRS_PDF_CONTROLLED_TEST',
        'CRS_INTAKE_MUTATION_QUALIFY',
      ].includes(key)
    )
      delete result[key];
  result.CRS_PDF_CONTROLLED_TEST = suite === 'continuation' ? '1' : '0';
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const suite = process.argv[2];
  const files = suiteFiles(suite);
  if (!files.length) throw new Error(`No tests found for ${suite}`);
  const child = spawn(
    process.execPath,
    [
      '--test',
      `--test-concurrency=${suite === 'browser' ? 1 : 2}`,
      `--test-timeout=${suite === 'browser' ? 60000 : suite === 'continuation' ? 180000 : 30000}`,
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=./src/scripts/test-timings.ts',
      '--test-reporter-destination=stdout',
      ...process.argv.slice(3),
      ...files,
    ],
    { stdio: 'inherit', env: testEnvironment(process.env, suite) },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}
