import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCredential,
  confirmCredential,
  verifyCredential,
  sanitizeError,
} from '../app/passkey-checker/core.ts';
import type { CredentialPort } from '../app/passkey-checker/core.ts';
import type { RunHeader } from '../app/passkey-checker/types.ts';
import { inspectEnvironment } from '../app/passkey-checker/environment.ts';
import { encodePrf } from '../app/components/passkey-prf.ts';
import type { PrfDiagnostics } from '../app/passkey-checker/diagnostics.ts';
function legacyEvidence(value: PrfDiagnostics | undefined) {
  if (!value) return value;
  const fields = [
    'requestMode',
    'inputShape',
    'inputLength',
    'extensionPresent',
    'resultsPresent',
    'outputShape',
    'outputLength',
    'credentialMatched',
  ] as const;
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}
const encode = (bytes: number[]) => encodePrf(Uint8Array.from(bytes).buffer);
const run: RunHeader = {
  schemaVersion: 1,
  id: 'fictional-run',
  origin: 'https://example.test',
  secureContext: true,
  rpId: 'example.test',
  userId: encode(Array(32).fill(9)),
  createdAt: '2026-10-03T00:00:00.000Z',
  build: { version: '1', revision: 'fictional', worktree: 'clean' },
  environment: inspectEnvironment(''),
};
function result(id: number[], prf: unknown = new Uint8Array(32).fill(7)): Credential {
  return {
    type: 'public-key',
    rawId: Uint8Array.from(id).buffer,
    response: { getTransports: () => ['hybrid', 'internal', 'hybrid', 'untrusted-provider-name'] },
    getClientExtensionResults: () => ({ prf: { results: { first: prf } } }),
  } as unknown as Credential;
}
test('controlled port: native-shaped requests start synchronously and preserve production constraints', async () => {
  const creates: PublicKeyCredentialCreationOptions[] = [],
    gets: PublicKeyCredentialRequestOptions[] = [];
  let id = [1, 2, 3];
  const port: CredentialPort = {
    create(options) {
      creates.push(options.publicKey!);
      return Promise.resolve(result(id));
    },
    get(options) {
      gets.push(options.publicKey!);
      return Promise.resolve(result(id));
    },
  };
  const pending = createCredential(run, 'A', [], port);
  assert.equal(creates.length, 1, 'create precedes any await');
  const a = await pending;
  assert.equal(a.cipher, undefined, 'creation/PRF capability is not confirmation');
  assert.deepEqual(creates[0].authenticatorSelection, {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  });
  assert.equal(creates[0].attestation, 'none');
  assert.equal(creates[0].extensions?.credProps, true);
  assert.deepEqual(a.transports, ['hybrid', 'internal']);
  assert.deepEqual(
    creates[0].pubKeyCredParams.map((entry) => entry.alg),
    [-8, -7, -257],
  );
  assert.equal(creates[0].rp.id, run.rpId);
  const confirming = confirmCredential(run, a, port);
  assert.equal(gets.length, 1, 'get precedes any await');
  const confirmed = await confirming;
  assert.deepEqual(
    new Uint8Array(gets[0].allowCredentials![0].id as ArrayBuffer),
    new Uint8Array([1, 2, 3]),
  );
  assert.deepEqual(gets[0].extensions?.prf?.eval?.first, creates[0].extensions?.prf?.eval?.first);
  for (let i = 0; i < 3; i++) await verifyCredential(run, confirmed, port);
  assert.equal(gets.length, 4, 'three subsequent uses each call fresh get');
  assert.equal(gets[1].userVerification, 'required');
  assert.deepEqual(gets[0].allowCredentials![0].transports, a.transports);
  assert.deepEqual(gets[1].allowCredentials![0].transports, a.transports);
  assert.ok(gets[1].extensions?.prf?.evalByCredential?.[a.id]);
  assert.notDeepEqual(gets[1].challenge, gets[2].challenge);
  id = [4, 5, 6];
  const b = await createCredential(run, 'B', [confirmed], port);
  assert.deepEqual(creates[1].user.id, creates[0].user.id, 'same fictional profile user ID');
  assert.match(creates[0].user.name, /passkey-A$/);
  assert.match(creates[1].user.name, /passkey-B$/);
  assert.match(creates[0].user.displayName, /passkey A$/);
  assert.match(creates[1].user.displayName, /passkey B$/);
  assert.equal(creates[1].excludeCredentials?.length, 1);
  assert.deepEqual(creates[1].excludeCredentials![0].transports, a.transports);
  assert.deepEqual(creates[1].excludeCredentials![0].id, new Uint8Array([1, 2, 3]));
  assert.notEqual(b.id, a.id);
  const confirmedB = await confirmCredential(run, b, port);
  await verifyCredential(run, confirmedB, port);
  id = [1, 2, 3];
  await verifyCredential(run, confirmed, port);
  assert.deepEqual(gets.at(-1)!.allowCredentials![0].id, new Uint8Array([1, 2, 3]));
  assert.deepEqual(Object.keys(confirmed).sort(), ['alias', 'cipher', 'id', 'salt', 'transports']);
  assert.deepEqual(Object.keys(confirmed.cipher!).sort(), ['data', 'iv']);
});
test('controlled crypto: rejects missing/malformed PRF, wrong credential, duplicate B and changed fresh PRF', async () => {
  let returned = result([1]);
  const port: CredentialPort = { create: async () => returned, get: async () => returned };
  const a = await createCredential(run, 'A', [], port);
  await assert.rejects(createCredential(run, 'B', [a], port), { code: 'duplicate-credential' });
  for (const prf of [undefined, [], Array(31).fill(7), new Uint8Array(33), 'untrusted']) {
    returned = {
      type: 'public-key',
      rawId: new Uint8Array([1]).buffer,
      getClientExtensionResults: () => ({ prf: { results: { first: prf } } }),
    } as unknown as Credential;
    await assert.rejects(confirmCredential(run, a, port), {
      code: prf === undefined ? 'prf-absent' : 'prf-invalid',
    });
  }
  returned = result([2]);
  await assert.rejects(confirmCredential(run, a, port), { code: 'wrong-credential' });
  returned = result([1]);
  const confirmed = await confirmCredential(run, a, port);
  returned = result([1], new Uint8Array(32).fill(8));
  await assert.rejects(verifyCredential(run, confirmed, port), { code: 'decrypt-failed' });
  returned = result([1]);
  await assert.rejects(verifyCredential({ ...run, id: 'different-run' }, confirmed, port), {
    code: 'decrypt-failed',
  });
  await assert.rejects(verifyCredential(run, { ...confirmed, alias: 'B' }, port), {
    code: 'decrypt-failed',
  });
  await assert.rejects(verifyCredential(run, a, port), { code: 'unconfirmed' });
  const corrupt = {
    ...confirmed,
    cipher: { ...confirmed.cipher!, data: encode(Array(32).fill(0)) },
  };
  await assert.rejects(verifyCredential(run, corrupt, port), { code: 'decrypt-failed' });
});
test('native adapter refuses insecure contexts and error classification never includes raw messages', async () => {
  await assert.rejects(createCredential(run, 'A', []), { code: 'insecure-context' });
  assert.equal(
    sanitizeError(new DOMException('secret credential dump', 'NotAllowedError')),
    'not-allowed',
  );
  assert.equal(sanitizeError(new Error('secret credential dump')), 'unknown-error');
  const environment = inspectEnvironment(
    'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36',
  );
  assert.equal(environment.browser.source, 'browser-reported');
  assert.deepEqual(environment.osVersion, {
    value: 'NT 10.0 (UA hint; may be frozen)',
    source: 'browser-reported',
  });
  assert.equal(environment.provider.source, 'unknown');
  assert.equal(environment.providerVersion.source, 'unknown');
  assert.deepEqual(inspectEnvironment('').osVersion, { value: '', source: 'unknown' });
});
test('controlled diagnostics: capture once and distinguish absence, rejected shapes, mismatch and native refusal', async () => {
  let calls = 0;
  let extensions: unknown = { prf: { results: { first: new Uint8Array(32).fill(7) } } };
  let returnedId = [1];
  let refusal: unknown;
  const port: CredentialPort = {
    create: async () => result([1]),
    get: async () => {
      if (refusal) throw refusal;
      return {
        type: 'public-key',
        rawId: Uint8Array.from(returnedId).buffer,
        getClientExtensionResults() {
          calls++;
          return extensions;
        },
      } as unknown as Credential;
    },
  };
  const observed: PrfDiagnostics[] = [];
  const observe = (diagnostics: PrfDiagnostics) => observed.push(diagnostics);
  const a = await createCredential(run, 'A', [], port, observe);
  assert.deepEqual(legacyEvidence(observed.pop()), {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'array-buffer-view',
    outputLength: 32,
  });
  const confirmed = await confirmCredential(run, a, port, observe);
  assert.equal(calls, 1, 'the extension API is shared by diagnostics and production decoder');
  assert.deepEqual(legacyEvidence(observed.pop()), {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    credentialMatched: true,
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'array-buffer-view',
    outputLength: 32,
  });
  let firstReads = 0;
  extensions = {
    prf: {
      results: {
        get first() {
          firstReads++;
          return new Uint8Array(32).fill(firstReads === 1 ? 7 : 8);
        },
      },
    },
  };
  const capturedConfirmation = await confirmCredential(run, a, port, observe);
  assert.equal(firstReads, 1, 'diagnostics and decoder use one captured output value');
  assert.equal(observed.pop()!.outputLength, 32);
  extensions = { prf: { results: { first: new Uint8Array(32).fill(7) } } };
  await verifyCredential(run, capturedConfirmation, port, observe);
  observed.pop();
  await verifyCredential(run, confirmed, port, observe);
  assert.equal(calls, 4);
  assert.equal(observed.pop()!.requestMode, 'evalByCredential');
  for (const [first, expectedShape] of [
    [Array(32).fill(7), 'array'],
    [encode(Array(32).fill(7)), 'string'],
    [new Uint8Array(32).fill(7).buffer, 'array-buffer'],
  ] as const) {
    extensions = { prf: { results: { first } } };
    await verifyCredential(run, confirmed, port, observe);
    assert.equal(observed.pop()!.outputShape, expectedShape);
  }
  extensions = { prf: { results: { first: new Uint8Array(32).fill(8) } } };
  await assert.rejects(verifyCredential(run, confirmed, port, observe), { code: 'decrypt-failed' });
  assert.deepEqual(legacyEvidence(observed.pop()), {
    requestMode: 'evalByCredential',
    inputShape: 'array-buffer',
    inputLength: 32,
    credentialMatched: true,
    extensionPresent: true,
    resultsPresent: true,
    outputShape: 'array-buffer-view',
    outputLength: 32,
  });
  for (const missing of [{}, { prf: {} }, { prf: { results: {} } }]) {
    extensions = missing;
    await assert.rejects(confirmCredential(run, a, port, observe), { code: 'prf-absent' });
    assert.equal(observed.pop()!.outputShape, 'absent');
  }
  for (const [first, outputShape, outputLength] of [
    [null, 'null', undefined],
    [Array(31).fill(7), 'array', 31],
    [Array(32).fill('7'), 'array', 32],
    [new Uint8Array(33), 'array-buffer-view', 33],
    ['fictional-untrusted', 'string', 19],
    [{ private: 'fictional-secret' }, 'object', undefined],
  ] as const) {
    extensions = { prf: { results: { first } }, untrusted: 'fictional-secret' };
    await assert.rejects(confirmCredential(run, a, port, observe), { code: 'prf-invalid' });
    const evidence = observed.pop()!;
    assert.equal(evidence.outputShape, outputShape);
    assert.equal(evidence.outputLength, outputLength);
    assert.equal(JSON.stringify(evidence).includes('fictional-secret'), false);
  }
  const beforeMismatch = calls;
  returnedId = [2];
  await assert.rejects(confirmCredential(run, a, port, observe), { code: 'wrong-credential' });
  assert.equal(calls, beforeMismatch, "never inspect another credential's extensions");
  assert.deepEqual(legacyEvidence(observed.pop()), {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    credentialMatched: false,
  });
  refusal = new DOMException('fictional-secret native response', 'NotAllowedError');
  await assert.rejects(confirmCredential(run, a, port, observe), { name: 'NotAllowedError' });
  assert.deepEqual(legacyEvidence(observed.pop()), {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
  });
  refusal = undefined;
  returnedId = [1];
  extensions = { prf: { results: { first: new Uint8Array(32).fill(7) } } };
  await confirmCredential(run, a, port, () => {
    throw new Error('observer failure');
  });
});
test('creation retains the credential when optional extension diagnostics fail', async () => {
  let calls = 0;
  const port: CredentialPort = {
    create: async () =>
      ({
        type: 'public-key',
        rawId: new Uint8Array([1]).buffer,
        getClientExtensionResults() {
          calls++;
          throw new Error('fictional native extension failure');
        },
      }) as unknown as Credential,
    get: async () => null,
  };
  const observed: PrfDiagnostics[] = [];
  const a = await createCredential(run, 'A', [], port, (diagnostics) => observed.push(diagnostics));
  assert.equal(a.id, encode([1]));
  assert.equal(calls, 1);
  assert.deepEqual(observed.map(legacyEvidence), [
    { requestMode: 'eval', inputShape: 'array-buffer', inputLength: 32 },
  ]);
});
test('failure diagnostics discriminate native refusal, early exits, credential validation and PRF rules without secrets', async () => {
  let returned: Credential | null = result([1]);
  let refusal: unknown;
  const port: CredentialPort = {
    create: async () => {
      if (refusal) throw refusal;
      return returned;
    },
    get: async () => {
      if (refusal) throw refusal;
      return returned;
    },
  };
  const observed: PrfDiagnostics[] = [];
  const observe = (value: PrfDiagnostics) => observed.push(value);
  const a = await createCredential(run, 'A', [], port, observe);
  const creation = observed.pop()!;
  assert.equal(creation.operation, 'create');
  assert.equal(creation.stage, 'complete');
  assert.equal(creation.userIdLength, 32);
  assert.equal(creation.excludedCredentialCount, 0);
  assert.equal(creation.requiredResidentKey, true);
  assert.equal(creation.requiredUserVerification, true);
  for (const [name, applicationError, category] of [
    ['InvalidStateError', 'invalid-state', 'dom-name'],
    ['UnknownError', 'unknown-error', 'dom-name'],
    ['TypeError', 'unknown-error', 'js-name'],
    ['fictional-secret', 'unknown-error', 'unrecognized'],
  ] as const) {
    refusal = { name, message: 'fictional-secret response' };
    await assert.rejects(
      createCredential(run, 'B', [a], port, observe),
      (error) => error === refusal,
    );
    const evidence = observed.pop()!;
    assert.equal(evidence.stage, 'native-create');
    assert.equal(evidence.nativeErrorName, name === 'fictional-secret' ? 'unrecognized' : name);
    assert.equal(evidence.nativeErrorCategory, category);
    assert.equal(evidence.applicationError, applicationError);
    assert.equal(evidence.excludedCredentialCount, 1);
    assert.equal(evidence.credentialReturned, undefined);
    assert.equal(evidence.validationRule, undefined, 'native rejection does not prove exclusion');
    assert.equal(JSON.stringify(evidence).includes('fictional-secret'), false);
  }
  refusal = {
    get name() {
      throw new Error('fictional-secret getter');
    },
  };
  await assert.rejects(confirmCredential(run, a, port, observe), (error) => error === refusal);
  assert.equal(observed.pop()!.nativeErrorName, 'unrecognized');
  assert.equal(sanitizeError(refusal), 'unknown-error');
  refusal = undefined;
  await assert.rejects(createCredential(run, 'A', [a], port, observe), { code: 'invalid-state' });
  assert.equal(observed.pop()!.validationRule, 'alias-unused');
  await assert.rejects(verifyCredential(run, a, port, observe), { code: 'unconfirmed' });
  assert.equal(observed.pop()!.stage, 'preflight');
  await assert.rejects(confirmCredential(run, { ...a, salt: '%%%fictional' }, port, observe));
  const construction = observed.pop()!;
  assert.equal(construction.stage, 'request-construction');
  assert.equal(construction.nativeErrorName, 'InvalidCharacterError');
  for (const [value, rule] of [
    [null, 'credential-returned'],
    [{ type: 'password' }, 'credential-type'],
    [{ type: 'public-key', rawId: new Uint8Array([1]) }, 'credential-id-buffer'],
    [{ type: 'public-key', rawId: new ArrayBuffer(0) }, 'credential-id-length'],
    [{ type: 'public-key', rawId: new Uint8Array([1]).buffer }, 'extension-reader'],
  ] as const) {
    returned = value as Credential | null;
    await assert.rejects(confirmCredential(run, a, port, observe), { code: 'invalid-credential' });
    const evidence = observed.pop()!;
    assert.equal(evidence.stage, 'credential-validation');
    assert.equal(evidence.validationRule, rule);
    assert.equal(evidence.outputShape, undefined);
  }
  returned = result([2]);
  await assert.rejects(confirmCredential(run, a, port, observe), { code: 'wrong-credential' });
  const mismatch = observed.pop()!;
  assert.equal(mismatch.requestCredentialMatched, true);
  assert.equal(mismatch.allowCredentialCount, 1);
  assert.equal(mismatch.credentialMatched, false);
  assert.equal(mismatch.stage, 'credential-match');
  assert.equal(mismatch.validationRule, 'selected-credential');
  assert.equal(mismatch.outputShape, undefined);
  const canonical = encode(Array(32).fill(7));
  const noncanonical = canonical.slice(0, -1) + 'd';
  for (const [first, rule] of [
    [undefined, 'prf-output-present'],
    [new Uint8Array(31), 'prf-output-buffer-length'],
    [Array(31).fill(7), 'prf-output-array-length'],
    [Array(32).fill('7'), 'prf-output-array-bytes'],
    [Array(32), 'prf-output-array-bytes'],
    ['x'.repeat(42), 'prf-output-base64url-length'],
    ['!'.repeat(43), 'prf-output-base64url-alphabet'],
    [noncanonical, 'prf-output-base64url-canonical'],
    [null, 'prf-output-supported-shape'],
    [{ privateDump: 'fictional-secret' }, 'prf-output-supported-shape'],
  ] as const) {
    returned = result([1], first);
    if (first === undefined)
      returned = {
        ...returned,
        getClientExtensionResults: () => ({ prf: { results: {} } }),
      } as unknown as Credential;
    await assert.rejects(confirmCredential(run, a, port, observe), {
      code: first === undefined ? 'prf-absent' : 'prf-invalid',
    });
    const evidence = observed.pop()!;
    assert.equal(evidence.stage, 'prf-validation');
    assert.equal(evidence.validationRule, rule);
    assert.equal(evidence.inputShape, 'array-buffer');
    assert.equal(evidence.inputLength, 32);
    assert.equal(JSON.stringify(evidence).includes('fictional-secret'), false);
  }
  for (const [extensions, extensionShape, resultsShape, rule] of [
    [{}, 'absent', 'absent', 'prf-extension-present'],
    [{ prf: null }, 'null', 'absent', 'prf-results-present'],
    [{ prf: { results: null } }, 'object', 'null', 'prf-output-present'],
  ] as const) {
    returned = {
      ...result([1]),
      getClientExtensionResults: () => extensions,
    } as unknown as Credential;
    await assert.rejects(confirmCredential(run, a, port, observe), { code: 'prf-absent' });
    const evidence = observed.pop()!;
    assert.equal(evidence.extensionShape, extensionShape);
    assert.equal(evidence.resultsShape, resultsShape);
    assert.equal(evidence.validationRule, rule);
  }
  const extensionError = new TypeError('fictional-secret extension failure');
  returned = {
    ...result([1]),
    getClientExtensionResults() {
      throw extensionError;
    },
  } as unknown as Credential;
  await assert.rejects(
    confirmCredential(run, a, port, observe),
    (error) => error === extensionError,
  );
  const extensionFailure = observed.pop()!;
  assert.equal(extensionFailure.stage, 'extension-read');
  assert.equal(extensionFailure.nativeErrorName, 'TypeError');
  assert.equal(
    extensionFailure.outputShape,
    undefined,
    'an unreadable extension is not absent PRF',
  );
  await createCredential(run, 'A', [], port, observe);
  assert.equal(
    observed.pop()!.diagnosticsUnavailable,
    true,
    'optional creation evidence cannot reject enrollment',
  );
  returned = result([1]);
  const confirmed = await confirmCredential(run, a, port, observe);
  observed.pop();
  await assert.rejects(confirmCredential(run, confirmed, port, observe), { code: 'invalid-state' });
  assert.equal(observed.pop()!.validationRule, 'credential-unconfirmed');
  returned = result([1], new Uint8Array(32).fill(8));
  await assert.rejects(verifyCredential(run, confirmed, port, observe), { code: 'decrypt-failed' });
  const decryption = observed.pop()!;
  assert.equal(decryption.stage, 'decryption');
  assert.equal(decryption.validationRule, 'fictional-decryption');
  assert.equal(decryption.nativeErrorName, 'OperationError');
  refusal = new DOMException('fictional-secret', 'NotAllowedError');
  await assert.rejects(
    confirmCredential(run, a, port, () => {
      throw new Error('diagnostics observer failure');
    }),
    (error) => error === refusal,
  );
});
test('crypto error stages remain separate and diagnostics preserve the original derivation/encryption errors', async () => {
  const port: CredentialPort = { create: async () => result([1]), get: async () => result([1]) };
  const a = await createCredential(run, 'A', [], port);
  const observed: PrfDiagnostics[] = [];
  const observe = (diagnostics: PrfDiagnostics) => observed.push(diagnostics);
  const confirmed = await confirmCredential(run, a, port);
  const stages = [
    ['importKey', 'key-derivation'],
    ['encrypt', 'encryption'],
    ['decrypt', 'decryption'],
  ] as const;
  for (const [method, stage] of stages) {
    const original = crypto.subtle[method];
    const failure = new DOMException('fictional-private-error', 'OperationError');
    Object.defineProperty(crypto.subtle, method, {
      configurable: true,
      value: async () => {
        throw failure;
      },
    });
    try {
      if (method === 'decrypt')
        await assert.rejects(verifyCredential(run, confirmed, port, observe), {
          code: 'decrypt-failed',
        });
      else
        await assert.rejects(
          confirmCredential(run, a, port, observe),
          (error) => error === failure,
        );
      const evidence = observed.pop()!;
      assert.equal(evidence.stage, stage);
      assert.equal(evidence.nativeErrorName, 'OperationError');
      assert.equal(
        evidence.applicationError,
        method === 'decrypt' ? 'decrypt-failed' : 'unknown-error',
      );
      assert.equal(JSON.stringify(evidence).includes('fictional-private-error'), false);
    } finally {
      Object.defineProperty(crypto.subtle, method, { configurable: true, value: original });
    }
  }
  const original = crypto.subtle.decrypt;
  Object.defineProperty(crypto.subtle, 'decrypt', {
    configurable: true,
    value: async () => new Uint8Array([1]).buffer,
  });
  try {
    await assert.rejects(verifyCredential(run, confirmed, port, observe), {
      code: 'decrypt-failed',
    });
    const evidence = observed.pop()!;
    assert.equal(evidence.stage, 'plaintext-comparison');
    assert.equal(evidence.validationRule, 'fictional-plaintext-match');
    assert.equal(evidence.nativeErrorName, undefined);
  } finally {
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: original });
  }
});
test('native preflight rejects scope and missing browser APIs before any request and records its rule', async () => {
  const descriptors = new Map(
    ['location', 'isSecureContext'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const observed: PrfDiagnostics[] = [];
  const observe = (diagnostics: PrfDiagnostics) => observed.push(diagnostics);
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'https:', origin: 'https://different.test', hostname: 'different.test' },
    });
    await assert.rejects(createCredential(run, 'A', [], undefined, observe), {
      code: 'scope-mismatch',
    });
    assert.equal(observed.pop()!.validationRule, 'relying-party-scope');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'https:', origin: run.origin, hostname: run.rpId },
    });
    await assert.rejects(createCredential(run, 'A', [], undefined, observe), {
      code: 'unsupported',
    });
    const unsupported = observed.pop()!;
    assert.equal(unsupported.stage, 'preflight');
    assert.equal(unsupported.validationRule, 'required-browser-api');
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: false });
    await assert.rejects(createCredential(run, 'A', [], undefined, observe), {
      code: 'insecure-context',
    });
    assert.equal(observed.pop()!.validationRule, 'secure-context');
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
test('native names are captured once and partial extension evidence survives child accessor failures', async () => {
  let returned = result([1]);
  let refusal: unknown;
  const port: CredentialPort = {
    create: async () => returned,
    get: async () => {
      if (refusal) throw refusal;
      return returned;
    },
  };
  const a = await createCredential(run, 'A', [], port);
  const observed: PrfDiagnostics[] = [];
  const observe = (value: PrfDiagnostics) => observed.push(value);
  let nameReads = 0;
  refusal = {
    get name() {
      return ++nameReads === 1 ? 'InvalidStateError' : 'fictional-private-name';
    },
  };
  await assert.rejects(confirmCredential(run, a, port, observe), (error) => error === refusal);
  const native = observed.pop()!;
  assert.equal(nameReads, 1);
  assert.equal(native.nativeErrorName, 'InvalidStateError');
  assert.equal(native.applicationError, 'invalid-state');
  refusal = undefined;
  const failure = new TypeError('fictional-private-child-getter');
  for (const [extensions, resultsPresent] of [
    [
      {
        prf: {
          get results() {
            throw failure;
          },
        },
      },
      undefined,
    ],
    [
      {
        prf: {
          results: {
            get first() {
              throw failure;
            },
          },
        },
      },
      true,
    ],
  ] as const) {
    returned = {
      ...result([1]),
      getClientExtensionResults: () => extensions,
    } as unknown as Credential;
    await assert.rejects(confirmCredential(run, a, port, observe), (error) => error === failure);
    const partial = observed.pop()!;
    assert.equal(partial.stage, 'extension-read');
    assert.equal(partial.extensionPresent, true);
    assert.equal(partial.extensionShape, 'object');
    assert.equal(partial.resultsPresent, resultsPresent);
    assert.equal(partial.outputShape, undefined);
    assert.equal(partial.nativeErrorName, 'TypeError');
  }
  const first = Array(32).fill(7);
  let tagsRead = 0;
  Object.defineProperty(first, Symbol.toStringTag, {
    get() {
      tagsRead++;
      throw new Error('optional shape must not inspect tags');
    },
  });
  returned = result([1], first);
  await confirmCredential(run, a, port, observe);
  assert.equal(tagsRead, 0, 'optional array shape evidence does not invoke a custom tag accessor');
  assert.equal(observed.pop()!.outputShape, 'array');
});
