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
  assert.equal(creates[1].excludeCredentials?.length, 1);
  assert.deepEqual(creates[1].excludeCredentials![0].transports, a.transports);
  assert.notEqual(b.id, a.id);
  const confirmedB = await confirmCredential(run, b, port);
  await verifyCredential(run, confirmedB, port);
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
    await assert.rejects(confirmCredential(run, a, port), { code: 'missing-prf' });
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
