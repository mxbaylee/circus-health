import { encodePrf, prfFrom, withBinaryPrf } from '../components/passkey-prf.ts';
import { ERROR_MESSAGES, KNOWN_TRANSPORTS } from './types.ts';
import type { CredentialAlias, CredentialRecord, ErrorCode, RunHeader } from './types.ts';
import {
  describePrfRequest,
  describePrfResponse,
  diagnosticShape,
  emitPrfDiagnostics,
  nativeErrorEvidence,
} from './diagnostics.ts';
import type { PrfDiagnostics, PrfDiagnosticsObserver, ValidationRule } from './diagnostics.ts';

export class CheckerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}
function checkerErrorCode(error: unknown): ErrorCode | undefined {
  try {
    return error instanceof CheckerError ? error.code : undefined;
  } catch {
    return undefined;
  }
}
function errorCodeForName(name: PrfDiagnostics['nativeErrorName']): ErrorCode {
  switch (name) {
    case 'NotAllowedError':
      return 'not-allowed';
    case 'InvalidStateError':
      return 'invalid-state';
    case 'NotSupportedError':
      return 'unsupported';
    case 'SecurityError':
      return 'security-error';
    case 'AbortError':
      return 'aborted';
    default:
      return 'unknown-error';
  }
}
export function sanitizeError(error: unknown): ErrorCode {
  return checkerErrorCode(error) ?? errorCodeForName(nativeErrorEvidence(error).nativeErrorName);
}
function fail(diagnostics: PrfDiagnostics, code: ErrorCode, rule: ValidationRule): never {
  diagnostics.validationRule = rule;
  throw new CheckerError(code);
}
function captureFailure(diagnostics: PrfDiagnostics, error: unknown) {
  const code = checkerErrorCode(error);
  if (code) diagnostics.applicationError = code;
  else {
    const evidence = nativeErrorEvidence(error);
    Object.assign(diagnostics, evidence);
    diagnostics.applicationError = errorCodeForName(evidence.nativeErrorName);
  }
}
function observeShape(diagnostics: PrfDiagnostics, value: unknown) {
  try {
    return diagnosticShape(value);
  } catch {
    diagnostics.diagnosticsUnavailable = true;
    return undefined;
  }
}
/** Injection is for controlled unit tests only, never a physical-observation mode. */
export interface CredentialPort {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}
function nativePort(run: RunHeader, diagnostics: PrfDiagnostics): CredentialPort {
  if (globalThis.location?.protocol !== 'https:' || !globalThis.isSecureContext)
    fail(diagnostics, 'insecure-context', 'secure-context');
  if (location.origin !== run.origin || location.hostname !== run.rpId)
    fail(diagnostics, 'scope-mismatch', 'relying-party-scope');
  if (
    !globalThis.navigator?.credentials ||
    typeof navigator.credentials.create !== 'function' ||
    typeof navigator.credentials.get !== 'function' ||
    !globalThis.crypto?.subtle ||
    typeof PublicKeyCredential === 'undefined'
  )
    fail(diagnostics, 'unsupported', 'required-browser-api');
  return {
    create: (options) => navigator.credentials.create(options),
    get: (options) => navigator.credentials.get(options),
  };
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
function publicCredential(
  value: Credential | null,
  diagnostics: PrfDiagnostics,
): PublicKeyCredential {
  diagnostics.stage = 'credential-validation';
  diagnostics.credentialReturned = Boolean(value);
  if (!value) fail(diagnostics, 'invalid-credential', 'credential-returned');
  diagnostics.credentialTypeMatched = value.type === 'public-key';
  if (!diagnostics.credentialTypeMatched)
    fail(diagnostics, 'invalid-credential', 'credential-type');
  const credential = value as PublicKeyCredential;
  const rawId = credential.rawId;
  const shape = observeShape(diagnostics, rawId);
  if (shape) {
    diagnostics.credentialIdShape = shape.shape;
    if (shape.length !== undefined) diagnostics.credentialIdLength = shape.length;
  }
  if (Object.prototype.toString.call(rawId) !== '[object ArrayBuffer]')
    fail(diagnostics, 'invalid-credential', 'credential-id-buffer');
  if (rawId.byteLength < 1 || rawId.byteLength > 1024)
    fail(diagnostics, 'invalid-credential', 'credential-id-length');
  diagnostics.extensionReaderPresent = typeof credential.getClientExtensionResults === 'function';
  if (!diagnostics.extensionReaderPresent)
    fail(diagnostics, 'invalid-credential', 'extension-reader');
  return credential;
}
function context(run: RunHeader, credential: CredentialRecord) {
  return new TextEncoder().encode(
    JSON.stringify(['circus-passkey-checker-v1', run.origin, run.rpId, run.id, credential.alias]),
  );
}
async function keyFor(
  prf: string,
  run: RunHeader,
  credential: CredentialRecord,
): Promise<CryptoKey> {
  const input = bytes(prf);
  try {
    const material = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: bytes(credential.salt),
        info: context(run, credential),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    input.fill(0);
  }
}
export function fictionalValue(run: RunHeader, credential: CredentialRecord) {
  return new TextEncoder().encode(
    `Fictional checker value only: ${run.id}, credential ${credential.alias}. No health information.`,
  );
}
function request(
  run: RunHeader,
  credential: CredentialRecord,
  confirmation: boolean,
): CredentialRequestOptions {
  return {
    publicKey: withBinaryPrf({
      challenge: random(32),
      timeout: 60_000,
      rpId: run.rpId,
      userVerification: 'required',
      allowCredentials: [
        {
          type: 'public-key',
          id: bytes(credential.id),
          ...(credential.transports ? { transports: credential.transports } : {}),
        },
      ],
      extensions: {
        prf: confirmation
          ? { eval: { first: credential.salt } }
          : { evalByCredential: { [credential.id]: { first: credential.salt } } },
      },
    }) as unknown as PublicKeyCredentialRequestOptions,
  };
}
function observeRequest(
  options: CredentialRequestOptions,
  credential: CredentialRecord,
  diagnostics: PrfDiagnostics,
) {
  const request = options.publicKey!;
  const input =
    diagnostics.requestMode === 'eval'
      ? request.extensions?.prf?.eval?.first
      : request.extensions?.prf?.evalByCredential?.[credential.id]?.first;
  Object.assign(diagnostics, describePrfRequest(diagnostics.requestMode, input));
  diagnostics.allowCredentialCount = request.allowCredentials!.length;
  diagnostics.requestCredentialMatched =
    encodePrf((request.allowCredentials![0].id as Uint8Array).buffer as ArrayBuffer) ===
    credential.id;
  diagnostics.requiredUserVerification = request.userVerification === 'required';
}
function extractPrf(
  value: Credential | null,
  credential: CredentialRecord,
  diagnostics: PrfDiagnostics,
): string {
  const result = publicCredential(value, diagnostics);
  diagnostics.stage = 'credential-match';
  diagnostics.credentialMatched = encodePrf(result.rawId) === credential.id;
  if (!diagnostics.credentialMatched) fail(diagnostics, 'wrong-credential', 'selected-credential');
  diagnostics.stage = 'extension-read';
  const extensions = result.getClientExtensionResults();
  const captured = describePrfResponse(diagnostics, extensions);
  diagnostics.stage = 'prf-validation';
  const prf = prfFrom({ clientExtensionResults: captured });
  if (!prf) {
    // Explain a rejected output only after the shared production decoder refuses it.
    // Do not create another acceptance path or inspect more than a 32-item array.
    let rule: ValidationRule = 'prf-output-supported-shape';
    const first = captured.prf.results.first;
    try {
      if (first === undefined)
        rule = !diagnostics.extensionPresent
          ? 'prf-extension-present'
          : !diagnostics.resultsPresent
            ? 'prf-results-present'
            : 'prf-output-present';
      else if (Array.isArray(first)) {
        rule = first.length !== 32 ? 'prf-output-array-length' : 'prf-output-array-bytes';
        if (first.length === 32) diagnostics.arrayEntriesValid = false;
      } else if (typeof first === 'string') {
        rule =
          first.length !== 43
            ? 'prf-output-base64url-length'
            : !/^[A-Za-z0-9_-]{43}$/.test(first)
              ? 'prf-output-base64url-alphabet'
              : 'prf-output-base64url-canonical';
      } else if (
        diagnostics.outputShape === 'array-buffer' ||
        diagnostics.outputShape === 'array-buffer-view'
      )
        rule = 'prf-output-buffer-length';
    } catch {
      diagnostics.diagnosticsUnavailable = true;
    }
    fail(diagnostics, first === undefined ? 'prf-absent' : 'prf-invalid', rule);
  }
  return prf;
}
/** Public browser routing hints, never used as proof of authenticator/provider identity. */
function transportHints(credential: PublicKeyCredential): AuthenticatorTransport[] {
  try {
    const response = credential.response as AuthenticatorAttestationResponse | undefined;
    const reported: unknown = response?.getTransports?.();
    if (!Array.isArray(reported)) return [];
    return KNOWN_TRANSPORTS.filter((transport) => reported.includes(transport));
  } catch {
    // Older browsers may omit the optional hint API; PRF verification remains mandatory.
    return [];
  }
}
export async function createCredential(
  run: RunHeader,
  alias: CredentialAlias,
  existing: CredentialRecord[],
  port?: CredentialPort,
  observer?: PrfDiagnosticsObserver,
): Promise<CredentialRecord> {
  const diagnostics: PrfDiagnostics = {
    requestMode: 'eval',
    inputShape: 'absent',
    operation: 'create',
    stage: 'request-construction',
  };
  try {
    const salt = encodePrf(random(32).buffer);
    const options: CredentialCreationOptions = {
      publicKey: withBinaryPrf({
        challenge: random(32),
        timeout: 60_000,
        rp: { name: 'Circus Health fictional compatibility checker', id: run.rpId },
        user: {
          id: bytes(run.userId),
          name: `fictional-${run.id}-passkey-${alias}`,
          displayName: `Fictional compatibility test — passkey ${alias}`,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        attestation: 'none',
        excludeCredentials: existing.map((entry) => ({
          type: 'public-key',
          id: bytes(entry.id),
          ...(entry.transports ? { transports: entry.transports } : {}),
        })),
        extensions: { credProps: true, prf: { eval: { first: salt } } },
      }) as unknown as PublicKeyCredentialCreationOptions,
    };
    Object.assign(
      diagnostics,
      describePrfRequest('eval', options.publicKey?.extensions?.prf?.eval?.first),
    );
    const creation = options.publicKey!;
    diagnostics.excludedCredentialCount = creation.excludeCredentials!.length;
    diagnostics.userIdLength = (creation.user.id as Uint8Array).byteLength;
    diagnostics.requiredUserVerification =
      creation.authenticatorSelection?.userVerification === 'required';
    diagnostics.requiredResidentKey = creation.authenticatorSelection?.residentKey === 'required';
    diagnostics.stage = 'preflight';
    if (existing.some((entry) => entry.alias === alias))
      fail(diagnostics, 'invalid-state', 'alias-unused');
    // Calling the port precedes the first await, preserving the button's user activation.
    const adapter = port ?? nativePort(run, diagnostics);
    diagnostics.stage = 'native-create';
    const result = publicCredential(await adapter.create(options), diagnostics);
    try {
      diagnostics.stage = 'extension-read';
      const extensions = result.getClientExtensionResults();
      describePrfResponse(diagnostics, extensions);
    } catch {
      diagnostics.diagnosticsUnavailable = true;
      // Creation alone is not PRF confirmation; optional evidence cannot lose an enrolled credential.
    }
    diagnostics.stage = 'credential-match';
    const id = encodePrf(result.rawId);
    if (existing.some((entry) => entry.id === id))
      fail(diagnostics, 'duplicate-credential', 'distinct-credential');
    const transports = transportHints(result);
    diagnostics.stage = 'complete';
    return { alias, id, salt, ...(transports.length ? { transports } : {}) };
  } catch (error) {
    captureFailure(diagnostics, error);
    throw error;
  } finally {
    emitPrfDiagnostics(diagnostics, observer);
  }
}
export async function confirmCredential(
  run: RunHeader,
  credential: CredentialRecord,
  port?: CredentialPort,
  observer?: PrfDiagnosticsObserver,
): Promise<CredentialRecord> {
  const diagnostics: PrfDiagnostics = {
    requestMode: 'eval',
    inputShape: 'absent',
    operation: 'confirm',
    stage: 'request-construction',
  };
  try {
    const options = request(run, credential, true);
    observeRequest(options, credential, diagnostics);
    diagnostics.stage = 'preflight';
    if (credential.cipher) fail(diagnostics, 'invalid-state', 'credential-unconfirmed');
    const adapter = port ?? nativePort(run, diagnostics);
    diagnostics.stage = 'native-get';
    const assertion = await adapter.get(options);
    const prf = extractPrf(assertion, credential, diagnostics);
    diagnostics.stage = 'key-derivation';
    const key = await keyFor(prf, run, credential);
    diagnostics.stage = 'encryption';
    const iv = random(12);
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(run, credential) },
      key,
      fictionalValue(run, credential),
    );
    const confirmed = {
      ...credential,
      cipher: { iv: encodePrf(iv.buffer), data: encodePrf(data) },
    };
    await decryptAndCompare(key, run, confirmed, diagnostics);
    diagnostics.stage = 'complete';
    return confirmed;
  } catch (error) {
    captureFailure(diagnostics, error);
    throw error;
  } finally {
    emitPrfDiagnostics(diagnostics, observer);
  }
}
async function decryptAndCompare(
  key: CryptoKey,
  run: RunHeader,
  credential: CredentialRecord,
  diagnostics: PrfDiagnostics,
) {
  if (!credential.cipher) fail(diagnostics, 'unconfirmed', 'credential-confirmed');
  diagnostics.stage = 'decryption';
  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes(credential.cipher.iv),
          additionalData: context(run, credential),
        },
        key,
        bytes(credential.cipher.data),
      ),
    );
    diagnostics.stage = 'plaintext-comparison';
    const expected = fictionalValue(run, credential);
    const matches =
      plaintext.length === expected.length &&
      plaintext.every((byte, index) => byte === expected[index]);
    plaintext.fill(0);
    if (!matches) fail(diagnostics, 'decrypt-failed', 'fictional-plaintext-match');
  } catch (error) {
    if (!checkerErrorCode(error)) {
      Object.assign(diagnostics, nativeErrorEvidence(error));
      diagnostics.validationRule = 'fictional-decryption';
    }
    throw new CheckerError('decrypt-failed');
  }
}
export async function verifyCredential(
  run: RunHeader,
  credential: CredentialRecord,
  port?: CredentialPort,
  observer?: PrfDiagnosticsObserver,
): Promise<void> {
  const diagnostics: PrfDiagnostics = {
    requestMode: 'evalByCredential',
    inputShape: 'absent',
    operation: 'verify',
    stage: 'request-construction',
  };
  try {
    const options = request(run, credential, false);
    observeRequest(options, credential, diagnostics);
    diagnostics.stage = 'preflight';
    if (!credential.cipher) fail(diagnostics, 'unconfirmed', 'credential-confirmed');
    const adapter = port ?? nativePort(run, diagnostics);
    diagnostics.stage = 'native-get';
    const assertion = await adapter.get(options);
    const prf = extractPrf(assertion, credential, diagnostics);
    diagnostics.stage = 'key-derivation';
    const key = await keyFor(prf, run, credential);
    await decryptAndCompare(key, run, credential, diagnostics);
    diagnostics.stage = 'complete';
  } catch (error) {
    captureFailure(diagnostics, error);
    throw error;
  } finally {
    emitPrfDiagnostics(diagnostics, observer);
  }
}
