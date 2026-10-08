import test from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { suiteConcurrency, suiteFiles, testEnvironment } from './test-suite.ts';

test('routine suites separate external qualification without dropping local integration coverage', () => {
  const server = suiteFiles('server');
  assert.ok(server.includes('src/server/test/archive-rebuild.integration.test.ts'));
  assert.ok(server.includes('src/server/test/intake-report-source-carryover.test.ts'));
  assert.ok(!server.some((file) => file.includes('model-providers.integration')));
  assert.ok(!server.some((file) => file.includes('intake-pdf-controlled')));
  assert.deepEqual(suiteFiles('continuation'), [
    'src/server/test/intake-pdf-controlled.integration.test.ts',
  ]);
  assert.equal(new Set(suiteFiles('state')).size, suiteFiles('state').length);
  assert.throws(() => suiteFiles('typo'), /Unknown test suite/);
});

test('dedicated acceptance and tools retain every local tooling test exactly once', () => {
  const tools = suiteFiles('tools'),
    acceptance = suiteFiles('acceptance');
  assert.deepEqual(acceptance, ['src/scripts/provider-qualification-acceptance.test.ts']);
  const combined = [...tools, ...acceptance].sort();
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual(combined, globSync('src/scripts/*.test.ts').sort());
});

test('routine child processes cannot inherit operator model credentials or external test opt-ins', () => {
  const original = {
    PATH: '/fictional/bin',
    CRS_AI_API_KEY: 'fictional-key',
    CRS_AI_API_KEY_FILE: '/fictional/key',
    CRS_AI_BASE_URL: 'https://fictional.invalid',
    CRS_AI_LIVE_TEST: '1',
    CRS_LITELLM_INTEGRATION_TEST: '1',
    CRS_PASSKEY_DOCKER_TEST: '1',
    CRS_DATA_DIR: '/fictional/data',
    CRS_RUNTIME_DIR: '/fictional/runtime',
    CRS_PDF_CONTROLLED_TEST: '1',
    CRS_INTAKE_MUTATION_QUALIFY: '1',
  };
  assert.deepEqual(testEnvironment(original, 'server'), {
    PATH: '/fictional/bin',
    CRS_PDF_CONTROLLED_TEST: '0',
  });
  assert.equal(testEnvironment(original, 'continuation').CRS_PDF_CONTROLLED_TEST, '1');
  assert.deepEqual(testEnvironment(original, 'acceptance'), {
    PATH: '/fictional/bin',
    CRS_PDF_CONTROLLED_TEST: '0',
  });
  assert.deepEqual(testEnvironment(original, 'history'), {
    PATH: '/fictional/bin',
    CRS_PDF_CONTROLLED_TEST: '0',
  });
  assert.equal(original.CRS_AI_API_KEY, 'fictional-key');
});

test('serial history is required and all routine server files execute exactly once', () => {
  const history = suiteFiles('history');
  assert.deepEqual(history, [
    'src/server/test/intake-identity-native-artifact-history.test.ts',
    'src/server/test/intake-identity-native-receipt-history.test.ts',
  ]);
  const external = new Set([
    'src/server/test/model-providers.integration.test.ts',
    'src/server/test/native-provider-workflow.integration.test.ts',
    'src/server/test/proxy-model-bridge.integration.test.ts',
    'src/server/test/hardened-consumers.integration.test.ts',
    'src/server/test/launch.integration.test.ts',
    'src/server/test/intake-source-ocr-real.test.ts',
  ]);
  const expected = globSync('src/server/test/*.test.ts')
    .filter((file) => !external.has(file))
    .sort();
  const actual = [...suiteFiles('server'), ...history, ...suiteFiles('continuation')].sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(suiteConcurrency('history'), 1);
  assert.equal(suiteConcurrency('server'), 2);
  assert.equal(suiteConcurrency('browser'), 1);
  assert.throws(() => suiteConcurrency('typo'), /Unknown test suite/);

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts['test:history'], 'node src/scripts/test-suite.ts history');
  assert.ok(pkg.scripts.test.split(' && ').includes('npm run test:history'));
  const workflow = readFileSync('.github/workflows/code-checks.yml', 'utf8');
  assert.match(workflow, /needs: \[[^\]]*\bhistory\b[^\]]*\]/);
  assert.match(workflow, /\n  history:\n[\s\S]*?run: npm run test:history\n/);
});
