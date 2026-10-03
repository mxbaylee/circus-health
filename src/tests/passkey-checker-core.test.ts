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
  assert.equal(environment.osVersion.source, 'unknown');
  assert.equal(environment.provider.source, 'unknown');
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
  assert.deepEqual(observed.pop(), {
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
  assert.deepEqual(observed.pop(), {
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
  assert.deepEqual(observed.pop(), {
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
  assert.deepEqual(observed.pop(), {
    requestMode: 'eval',
    inputShape: 'array-buffer',
    inputLength: 32,
    credentialMatched: false,
  });
  refusal = new DOMException('fictional-secret native response', 'NotAllowedError');
  await assert.rejects(confirmCredential(run, a, port, observe), { name: 'NotAllowedError' });
  assert.deepEqual(observed.pop(), {
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
  assert.deepEqual(observed, [
    { requestMode: 'eval', inputShape: 'array-buffer', inputLength: 32 },
  ]);
});
