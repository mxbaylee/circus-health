import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createCredential,
  confirmCredential,
  verifyCredential,
} from '../app/passkey-checker/core.ts';
import type { CredentialPort } from '../app/passkey-checker/core.ts';
import {
  describePrfRequest,
  describePrfResponse,
  isPrfDiagnostics,
  observeNative,
  projectPrfDiagnostics,
} from '../app/passkey-checker/diagnostics.ts';
import type { PrfDiagnostics } from '../app/passkey-checker/diagnostics.ts';
import { encodePrf } from '../app/components/passkey-prf.ts';
import { reportMarkdown } from '../app/passkey-checker/report.ts';
import { LEGACY_DATABASE, roundDatabase } from '../app/passkey-checker/round.ts';
import type { RegistrationMode } from '../app/passkey-checker/round.ts';
import type { CheckerState, RunHeader } from '../app/passkey-checker/types.ts';

const environment = {
  browser: { value: '', source: 'unknown' as const },
  browserVersion: { value: '', source: 'unknown' as const },
  os: { value: '', source: 'unknown' as const },
  osVersion: { value: '', source: 'unknown' as const },
  provider: { value: '', source: 'unknown' as const },
  providerVersion: { value: '', source: 'unknown' as const },
};
const run: RunHeader = {
  schemaVersion: 1,
  id: 'fictional-round',
  origin: 'https://example.test',
  secureContext: true,
  rpId: 'example.test',
  userId: encodePrf(new Uint8Array(32).fill(9).buffer),
  createdAt: '2026-10-05T00:00:00.000Z',
  build: { version: '3', revision: 'fictional', worktree: 'clean' },
  environment,
};
function result(id: number, extensions: unknown = {}) {
  const rawId = new Uint8Array([id]).buffer;
  return {
    type: 'public-key',
    id: encodePrf(rawId),
    rawId,
    authenticatorAttachment: 'platform',
    response: { getTransports: () => ['internal', 'hybrid'] },
    getClientExtensionResults: () => extensions,
  } as unknown as Credential;
}
function prf(first: unknown = new Uint8Array(32).fill(7)) {
  return { prf: { results: { first } } };
}

for (const mode of ['eval', 'enable-only'] as const)
  test(`${mode}: same-credential retry and retained A/B access`, async () => {
    let next = 1;
    let refusal = false;
    const creates: CredentialCreationOptions[] = [];
    const gets: CredentialRequestOptions[] = [];
    const seen: PrfDiagnostics[] = [];
    const port: CredentialPort = {
      create(options) {
        creates.push(options);
        return Promise.resolve(result(next, { prf: { enabled: true }, credProps: { rk: true } }));
      },
      get(options) {
        gets.push(options);
        if (refusal)
          return Promise.reject(new DOMException('private native text', 'NotAllowedError'));
        // Plain arrays retain the existing 1Password compatibility path.
        return Promise.resolve(result(next, prf(Array(32).fill(7))));
      },
    };
    const pending = createCredential(run, 'A', [], port, (d) => seen.push(d), mode);
    assert.equal(creates.length, 1, 'native create must precede the first await');
    const a = await pending;
    const creationPrf = creates[0].publicKey!.extensions!.prf;
    if (mode === 'enable-only') assert.deepEqual(creationPrf, {});
    else assert.equal((creationPrf!.eval!.first as ArrayBuffer).byteLength, 32);
    assert.equal(a.cipher, undefined, 'enabled=true is not verified encryption');
    assert.equal(seen[0].requestMode, mode);
    assert.equal(seen[0].prfEnabled, true);
    assert.equal(seen[0].residentCredentialReported, true);
    assert.equal(seen[0].credentialIdTextMatched, true);
    assert.equal(seen[0].attachmentHint, 'platform');
    assert.equal(isPrfDiagnostics(seen[0]), true);
    refusal = true;
    await assert.rejects(confirmCredential(run, a, port), { name: 'NotAllowedError' });
    refusal = false;
    const confirming = confirmCredential(run, a, port);
    assert.equal(gets.length, 2, 'native retry must precede the first await');
    const confirmedA = await confirming;
    assert.equal(creates.length, 1, 'confirmation retry must not create again');
    assert.deepEqual(gets[0].publicKey!.extensions, gets[1].publicKey!.extensions);
    assert.notDeepEqual(gets[0].publicKey!.challenge, gets[1].publicKey!.challenge);
    for (let i = 0; i < 3; i++) await verifyCredential(run, confirmedA, port);
    next = 2;
    const b = await createCredential(run, 'B', [confirmedA], port, undefined, mode);
    assert.deepEqual(creates[1].publicKey!.user.id, creates[0].publicKey!.user.id);
    assert.equal(creates[1].publicKey!.excludeCredentials!.length, 1);
    assert.deepEqual(creates[1].publicKey!.excludeCredentials![0].id, new Uint8Array([1]));
    const confirmedB = await confirmCredential(run, b, port);
    await verifyCredential(run, confirmedB, port);
    next = 1;
    await verifyCredential(run, confirmedA, port);
    assert.equal(confirmedA.salt, a.salt);
    assert.deepEqual(gets.at(-1)!.publicKey!.allowCredentials![0].id, new Uint8Array([1]));
  });

test('failed B preserves A; wrong ID stops before PRF access', async () => {
  let returned = result(1, prf());
  let failCreate = false;
  const port: CredentialPort = {
    create: async () => {
      if (failCreate) throw new DOMException('private detail', 'InvalidStateError');
      return returned;
    },
    get: async () => returned,
  };
  const a = await confirmCredential(run, await createCredential(run, 'A', [], port), port);
  const before = structuredClone(a);
  failCreate = true;
  await assert.rejects(createCredential(run, 'B', [a], port), { name: 'InvalidStateError' });
  assert.deepEqual(a, before);
  await verifyCredential(run, a, port);
  let accessed = false;
  returned = {
    ...result(2),
    getClientExtensionResults() {
      accessed = true;
      throw Error('must not inspect wrong credential output');
    },
  } as unknown as Credential;
  await assert.rejects(verifyCredential(run, a, port), { code: 'wrong-credential' });
  assert.equal(accessed, false);
});

test('native throw/rejection evidence preserves the original error', async () => {
  for (const sync of [true, false]) {
    const d = describePrfRequest('eval', new Uint8Array(32));
    const error = new DOMException('private never-export-native-message', 'InvalidStateError');
    let called = false;
    const promise = observeNative(d, () => {
      called = true;
      if (sync) throw error;
      return Promise.reject(error);
    });
    assert.equal(called, true);
    await assert.rejects(promise, (actual) => actual === error);
    assert.equal(d.nativeOutcome, sync ? 'threw' : 'rejected');
    assert.equal(d.nativeErrorCode, error.code);
    assert.ok(d.nativeDuration);
    assert.equal(isPrfDiagnostics(d), true);
    assert.doesNotMatch(JSON.stringify(d), /never-export|private|message|stack/);
  }
});

test('throwing optional metadata does not alter PRF extraction or native results', async () => {
  const d = describePrfRequest('eval', new Uint8Array(32));
  const first = new Uint8Array(32).fill(8);
  let reads = 0;
  const captured = describePrfResponse(d, {
    get credProps() {
      throw Error('private metadata');
    },
    prf: {
      get enabled() {
        throw Error('private metadata');
      },
      results: {
        get first() {
          reads++;
          return first;
        },
      },
    },
  });
  assert.equal(reads, 1);
  assert.equal(captured.prf.results.first, first);
  assert.equal(d.diagnosticsUnavailable, true);
  const oddError = Object.defineProperty(new Error('private'), 'code', {
    get() {
      throw Error('private');
    },
  });
  await assert.rejects(observeNative(d, () => Promise.reject(oddError)), (e) => e === oddError);
});

test('creation flags are evidence, not a decryption pass', () => {
  for (const enabled of [true, false, 'private string', null, undefined]) {
    const d = describePrfRequest('enable-only', undefined);
    describePrfResponse(d, { prf: { enabled } });
    assert.equal(d.prfEnabled, typeof enabled === 'boolean' ? enabled : undefined);
    assert.equal(d.outputShape, 'absent');
    assert.equal(isPrfDiagnostics(d), true);
    assert.doesNotMatch(JSON.stringify(d), /private string/);
  }
});

test('supported 32-byte representations retain decryption', async () => {
  let output: unknown = new Uint8Array(32).fill(7).buffer;
  const port: CredentialPort = {
    create: async () => result(1),
    get: async () => result(1, prf(output)),
  };
  const a = await confirmCredential(run, await createCredential(run, 'A', [], port), port);
  for (const first of [
    Array(32).fill(7),
    encodePrf(new Uint8Array(32).fill(7).buffer),
    new Uint8Array(new Uint8Array(40).fill(7).buffer, 4, 32),
    new DataView(new Uint8Array(40).fill(7).buffer, 4, 32),
    runInNewContext('new Uint8Array(32).fill(7).buffer'),
  ]) {
    output = first;
    await verifyCredential(run, a, port);
  }
  for (const invalid of [
    Array(31).fill(7),
    Array(32).fill('7'),
    new Uint8Array(33),
    {},
    'untrusted',
  ]) {
    output = invalid;
    await assert.rejects(verifyCredential(run, a, port), { code: 'prf-invalid' });
  }
  output = new Uint8Array(32).fill(8);
  await assert.rejects(verifyCredential(run, a, port), { code: 'decrypt-failed' });
});

test('new report facts remain bounded and secret-free', () => {
  const d: PrfDiagnostics = {
    requestMode: 'enable-only',
    inputShape: 'absent',
    operation: 'create',
    stage: 'native-create',
    nativeOutcome: 'rejected',
    nativeErrorName: 'InvalidStateError',
    nativeErrorCode: 11,
    nativeDuration: '1-5s',
    prfEnabled: false,
    userActivationAtInvocation: true,
    documentFocusedAtInvocation: false,
    credentialIdTextMatched: true,
  };
  const extra = { ...d, secret: 'never-export-native-data', stack: 'never-export-stack' };
  assert.deepEqual(projectPrfDiagnostics(extra), d);
  assert.equal(isPrfDiagnostics(extra), false);
  const state: CheckerState = {
    run,
    credentials: [],
    observations: [],
    attempts: [
      {
        id: 'never-export-attempt-id',
        alias: 'A',
        step: 'create',
        status: 'failed',
        startedAt: run.createdAt,
        build: run.build,
        environment,
        error: 'invalid-state',
        diagnostics: extra,
      },
    ],
  };
  const report = reportMarkdown(state);
  for (const phrase of [
    'request mode: enable-only',
    'native invocation outcome: rejected',
    'native numeric error code: 11',
    'PRF enabled flag: false',
    'document focused at native invocation: false',
    'not a provider fix',
  ])
    assert.ok(report.includes(phrase), phrase);
  assert.doesNotMatch(report, /never-export/);
  for (const invalid of [
    { nativeErrorCode: 26 },
    { nativeDuration: 'private text' },
    { attachmentHint: 'private provider name' },
    { prfEnabled: 'true' },
    { nativeOutcome: 'private message' },
  ])
    assert.equal(projectPrfDiagnostics({ ...d, ...invalid }), undefined);
});

test('fresh round and experimental mode never reuse or delete the legacy database', () => {
  const baseline = roundDatabase('eval');
  const experiment = roundDatabase('enable-only');
  assert.notEqual(baseline, experiment);
  assert.notEqual(baseline, LEGACY_DATABASE);
  assert.notEqual(experiment, LEGACY_DATABASE);
  assert.equal(roundDatabase('eval'), baseline, 'reload resumes this round');
  assert.throws(() => roundDatabase('private-arbitrary-name' as RegistrationMode), TypeError);
});
