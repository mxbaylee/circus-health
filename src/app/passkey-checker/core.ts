import { encodePrf, prfFrom, withBinaryPrf } from '../components/passkey-prf.ts';
import { ERROR_MESSAGES, KNOWN_TRANSPORTS } from './types.ts';
import type { CredentialAlias, CredentialRecord, ErrorCode, RunHeader } from './types.ts';

export class CheckerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
  }
}
export function sanitizeError(error: unknown): ErrorCode {
  if (error instanceof CheckerError) return error.code;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
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
/** Injection is for controlled unit tests only, never a physical-observation mode. */
export interface CredentialPort {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
}
function nativePort(run: RunHeader): CredentialPort {
  if (globalThis.location?.protocol !== 'https:' || !globalThis.isSecureContext)
    throw new CheckerError('insecure-context');
  if (location.origin !== run.origin || location.hostname !== run.rpId)
    throw new CheckerError('scope-mismatch');
  if (
    !globalThis.navigator?.credentials ||
    typeof navigator.credentials.create !== 'function' ||
    typeof navigator.credentials.get !== 'function' ||
    !globalThis.crypto?.subtle ||
    typeof PublicKeyCredential === 'undefined'
  )
    throw new CheckerError('unsupported');
  return {
    create: (options) => navigator.credentials.create(options),
    get: (options) => navigator.credentials.get(options),
  };
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
function publicCredential(value: Credential | null): PublicKeyCredential {
  if (!value || value.type !== 'public-key') throw new CheckerError('invalid-credential');
  const credential = value as PublicKeyCredential;
  if (
    Object.prototype.toString.call(credential.rawId) !== '[object ArrayBuffer]' ||
    credential.rawId.byteLength < 1 ||
    credential.rawId.byteLength > 1024 ||
    typeof credential.getClientExtensionResults !== 'function'
  )
    throw new CheckerError('invalid-credential');
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
function extractPrf(value: Credential | null, credential: CredentialRecord): string {
  const result = publicCredential(value);
  if (encodePrf(result.rawId) !== credential.id) throw new CheckerError('wrong-credential');
  const prf = prfFrom({ clientExtensionResults: result.getClientExtensionResults() });
  if (!prf) throw new CheckerError('missing-prf');
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
): Promise<CredentialRecord> {
  if (existing.some((entry) => entry.alias === alias)) throw new CheckerError('invalid-state');
  const salt = encodePrf(random(32).buffer);
  // Calling the port precedes the first await, preserving the button's user activation.
  const result = publicCredential(
    await (port ?? nativePort(run)).create({
      publicKey: withBinaryPrf({
        challenge: random(32),
        timeout: 60_000,
        rp: { name: 'Circus Health fictional compatibility checker', id: run.rpId },
        user: {
          id: bytes(run.userId),
          name: `fictional-${run.id}`,
          displayName: 'Fictional compatibility test',
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
    }),
  );
  const id = encodePrf(result.rawId);
  if (existing.some((entry) => entry.id === id)) throw new CheckerError('duplicate-credential');
  const transports = transportHints(result);
  return { alias, id, salt, ...(transports.length ? { transports } : {}) };
}
export async function confirmCredential(
  run: RunHeader,
  credential: CredentialRecord,
  port?: CredentialPort,
): Promise<CredentialRecord> {
  if (credential.cipher) throw new CheckerError('invalid-state');
  const assertion = await (port ?? nativePort(run)).get(request(run, credential, true));
  const key = await keyFor(extractPrf(assertion, credential), run, credential);
  const iv = random(12);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: context(run, credential) },
    key,
    fictionalValue(run, credential),
  );
  const confirmed = { ...credential, cipher: { iv: encodePrf(iv.buffer), data: encodePrf(data) } };
  await decryptAndCompare(key, run, confirmed);
  return confirmed;
}
async function decryptAndCompare(key: CryptoKey, run: RunHeader, credential: CredentialRecord) {
  if (!credential.cipher) throw new CheckerError('unconfirmed');
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
    const expected = fictionalValue(run, credential);
    const matches =
      plaintext.length === expected.length &&
      plaintext.every((byte, index) => byte === expected[index]);
    plaintext.fill(0);
    if (!matches) throw new Error();
  } catch {
    throw new CheckerError('decrypt-failed');
  }
}
export async function verifyCredential(
  run: RunHeader,
  credential: CredentialRecord,
  port?: CredentialPort,
): Promise<void> {
  if (!credential.cipher) throw new CheckerError('unconfirmed');
  const assertion = await (port ?? nativePort(run)).get(request(run, credential, false));
  const key = await keyFor(extractPrf(assertion, credential), run, credential);
  await decryptAndCompare(key, run, credential);
}
