import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describePrfRequest,
  describePrfResponse,
  isPrfDiagnostics,
  projectPrfDiagnostics,
} from '../app/passkey-checker/diagnostics.ts';
test('diagnostics projection retains only bounded allowlisted evidence without reading foreign accessors', () => {
  const diagnostics = { requestMode: 'eval', inputShape: 'array-buffer', inputLength: 32 };
  assert.equal(isPrfDiagnostics(diagnostics), true);
  const extra = {
    ...diagnostics,
    get rawNativeResponse() {
      throw new Error('must not read a private property');
    },
    salt: 'fictional-secret',
  };
  assert.equal(isPrfDiagnostics(extra), false);
  assert.deepEqual(projectPrfDiagnostics(extra), diagnostics);
  assert.notEqual(projectPrfDiagnostics(diagnostics), diagnostics);
  for (const field of [
    { inputShape: 'fictional-secret' },
    { requestMode: 'arbitrary' },
    { outputShape: new Uint8Array(32) },
    { outputLength: -1 },
    { outputLength: 65_537 },
    { outputLength: 1.5 },
    { outputLength: Infinity },
    { credentialMatched: 'true' },
  ]) {
    assert.equal(isPrfDiagnostics({ ...diagnostics, ...field }), false);
    assert.equal(projectPrfDiagnostics({ ...diagnostics, ...field }), undefined);
  }
  assert.equal(isPrfDiagnostics({ ...diagnostics, [Symbol('secret')]: 'fictional' }), false);
  for (const native of [new Date(), new ArrayBuffer(32), new Uint8Array(32)]) {
    assert.equal(isPrfDiagnostics(Object.assign(native, diagnostics)), false);
  }
  assert.equal(
    projectPrfDiagnostics({
      ...diagnostics,
      get outputLength() {
        throw new Error();
      },
    }),
    undefined,
  );
  assert.equal(projectPrfDiagnostics({ inputShape: 'absent' }), undefined);
  assert.equal(projectPrfDiagnostics(null), undefined);
  assert.equal(projectPrfDiagnostics([]), undefined);
});
test('diagnostics describe shape and bounded length without decoding or retaining contents', () => {
  const input = new Uint8Array(32).fill(7).buffer;
  const evidence = describePrfRequest('eval', input);
  describePrfResponse(evidence, { prf: { results: { first: 'x'.repeat(65_537) } } });
  assert.deepEqual(evidence, {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    extensionShape: 'object',
    resultsShape: 'object',
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'string',
  });
  const absent = describePrfRequest('evalByCredential', input);
  describePrfResponse(absent, {});
  assert.deepEqual(absent, {
    requestMode: 'evalByCredential',
    inputShape: 'array-buffer',
    inputLength: 32,
    extensionShape: 'absent',
    resultsShape: 'absent',
    extensionPresent: false,
    resultsPresent: false,
    outputShape: 'absent',
  });
});
test('actionable diagnostics reject unknown names, rules, stages, counts and unsafe shapes', () => {
  const base = { requestMode: 'eval', inputShape: 'array-buffer', inputLength: 32 };
  const extra = {
    operation: 'confirm',
    stage: 'native-get',
    nativeErrorName: 'TypeError',
    nativeErrorCategory: 'js-name',
    applicationError: 'unknown-error',
    validationRule: 'selected-credential',
    requestCredentialMatched: true,
    allowCredentialCount: 1,
    excludedCredentialCount: 1,
    userIdLength: 32,
    credentialIdShape: 'array-buffer',
    credentialIdLength: 2,
    extensionShape: 'null',
    resultsShape: 'absent',
    diagnosticsUnavailable: true,
  };
  assert.equal(isPrfDiagnostics({ ...base, ...extra }), true);
  assert.deepEqual(projectPrfDiagnostics({ ...base, ...extra, privateDump: 'fictional-secret' }), {
    ...base,
    ...extra,
  });
  for (const field of [
    { operation: 'private' },
    { stage: 'private' },
    { validationRule: 'private' },
    { nativeErrorName: 'private credential dump' },
    { nativeErrorCategory: 'Error' },
    { applicationError: 'private' },
    { allowCredentialCount: 3 },
    { excludedCredentialCount: -1 },
    { userIdLength: 65 },
    { credentialIdLength: 65_537 },
    { extensionShape: 'private' },
    { resultsShape: {} },
    { diagnosticsUnavailable: 'yes' },
  ]) {
    assert.equal(projectPrfDiagnostics({ ...base, ...field }), undefined);
    assert.equal(isPrfDiagnostics({ ...base, ...field }), false);
  }
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('fictional-secret');
      },
      getPrototypeOf() {
        throw new Error('fictional-secret');
      },
    },
  );
  assert.equal(projectPrfDiagnostics(proxy), undefined);
  assert.equal(isPrfDiagnostics(proxy), false);
});
