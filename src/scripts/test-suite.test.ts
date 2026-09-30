import test from 'node:test';
import assert from 'node:assert/strict';
import { suiteFiles, testEnvironment } from './test-suite.ts';

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
  };
  assert.deepEqual(testEnvironment(original, 'server'), {
    PATH: '/fictional/bin',
    CRS_PDF_CONTROLLED_TEST: '0',
  });
  assert.equal(testEnvironment(original, 'continuation').CRS_PDF_CONTROLLED_TEST, '1');
  assert.equal(original.CRS_AI_API_KEY, 'fictional-key');
});
