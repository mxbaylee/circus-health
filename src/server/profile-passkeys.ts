import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import sodium from 'libsodium-wrappers-sumo';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { wrapKey, unwrapKey, type VaultKey } from './vault-crypto.ts';
import { HttpError } from './database.ts';
import { availablePasskeyName, passkeyProviderName } from './passkey-names.ts';
import type {
  EncryptedLabel,
  OpenedProfile,
  ProfilePasskey,
  createEncryptedProfiles,
} from './encrypted-profiles.ts';

type EncryptedProfileManager = ReturnType<typeof createEncryptedProfiles>;

interface RegistrationVerificationResult {
  verified: boolean;
  registrationInfo?: { credential: WebAuthnCredential; aaguid?: string };
}

interface AuthenticationVerificationResult {
  verified: boolean;
  authenticationInfo: { newCounter: number };
}

export interface PasskeyVerification {
  verifyRegistrationResponse(
    options: Parameters<typeof verifyRegistrationResponse>[0],
  ): Promise<RegistrationVerificationResult>;
  verifyAuthenticationResponse(
    options: Parameters<typeof verifyAuthenticationResponse>[0],
  ): Promise<AuthenticationVerificationResult>;
}

interface ChallengeBase {
  profileId: string;
  sessionId: string;
  origin: string;
  rpID: string;
  challenge: string;
  generation: number;
  expires: number;
  used?: boolean;
}

interface RegistrationChallenge extends ChallengeBase {
  kind: 'register';
  salt: string;
}

interface ConfirmationChallenge extends ChallengeBase {
  kind: 'confirm';
  salt: string;
  providerName: string;
  credential: Pick<ProfilePasskey, 'id' | 'publicKey' | 'counter' | 'transports'>;
}

interface AuthenticationChallenge extends ChallengeBase {
  kind: 'authenticate';
}

type PasskeyChallenge = RegistrationChallenge | ConfirmationChallenge | AuthenticationChallenge;
type NewChallenge =
  | Omit<RegistrationChallenge, 'expires'>
  | Omit<ConfirmationChallenge, 'expires'>
  | Omit<AuthenticationChallenge, 'expires'>;

interface ChallengeInput {
  challengeId?: unknown;
}

interface RegistrationInput extends ChallengeInput {
  response?: unknown;
}

interface AuthenticationInput extends ChallengeInput {
  response?: unknown;
  prf?: unknown;
}

const prfBytes = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new HttpError(
      400,
      'PRF_REQUIRED',
      'This passkey did not provide a supported PRF result. Use your recovery key.',
    );
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    bytes.fill(0);
    throw new HttpError(
      400,
      'PRF_REQUIRED',
      'This passkey did not provide a supported PRF result. Use your recovery key.',
    );
  }
  return bytes;
};

// Labels are private metadata, not unlock inputs. Bind their ciphertext to both
// the profile and credential, independently of the passkey's key wrapper.
const labelContext = (profileId: string, credentialId: string): Buffer =>
  Buffer.from(JSON.stringify(['circus-health-passkey-label-v1', profileId, credentialId]));
function validatedLabel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new HttpError(
      400,
      'PASSKEY_LABEL',
      'Enter a passkey name of 1–80 characters without control characters.',
    );
  return value.trim();
}
function encryptLabel(
  label: string,
  key: VaultKey,
  profileId: string,
  credentialId: string,
): EncryptedLabel {
  const nonce = randomBytes(24),
    plain = Buffer.from(label);
  try {
    return {
      algorithm: 'xchacha20poly1305-ietf',
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plain,
          labelContext(profileId, credentialId),
          null,
          nonce,
          key,
        ),
      ).toString('base64url'),
    };
  } finally {
    plain.fill(0);
  }
}
function decryptLabel(
  encrypted: unknown,
  key: VaultKey,
  profileId: string,
  credentialId: string,
): string {
  let plain: Buffer | undefined;
  try {
    if ((encrypted as Partial<EncryptedLabel> | null)?.algorithm !== 'xchacha20poly1305-ietf')
      throw Error('Unsupported label format');
    const nonce = Buffer.from((encrypted as Partial<EncryptedLabel>).nonce!, 'base64url'),
      cipher = Buffer.from((encrypted as Partial<EncryptedLabel>).ciphertext!, 'base64url');
    if (nonce.length !== 24 || cipher.length < 17 || cipher.length > 336)
      throw Error('Invalid label ciphertext');
    plain = Buffer.from(
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        cipher,
        labelContext(profileId, credentialId),
        nonce,
        key,
      ),
    );
    return validatedLabel(plain.toString('utf8'));
  } catch {
    throw new HttpError(
      500,
      'PASSKEY_LABEL_UNAVAILABLE',
      'A saved passkey name could not be read.',
    );
  } finally {
    plain?.fill(0);
  }
}

export function createProfilePasskeys(
  manager: EncryptedProfileManager,
  verification: PasskeyVerification = { verifyRegistrationResponse, verifyAuthenticationResponse },
) {
  const challenges = new Map<string, PasskeyChallenge>(),
    generations = new Map<string, number>();
  const generation = (id: string): number => generations.get(id) || 0;
  const assertCurrent = (id: string, expected: number): void => {
    manager.card(id);
    if (generation(id) !== expected)
      throw new HttpError(
        409,
        'PASSKEY_CANCELLED',
        'Profile access changed. Start the passkey request again.',
      );
  };
  const unlocked = (profileId: string): OpenedProfile => {
    const state = manager.opened.get(profileId);
    if (!state || state.closing)
      throw new HttpError(423, 'PROFILE_LOCKED', 'Unlock before adding a passkey');
    return state;
  };
  function add(value: NewChallenge): string {
    for (const [id, challenge] of challenges)
      if (challenge.expires < Date.now()) challenges.delete(id);
    if (challenges.size >= 1000)
      throw new HttpError(429, 'TOO_MANY_CHALLENGES', 'Try again shortly');
    const id = randomBytes(32).toString('base64url');
    challenges.set(id, { ...value, expires: Date.now() + 5 * 60 * 1000 } as PasskeyChallenge);
    return id;
  }
  // Keep claimed challenges visible until verification finishes so cancellation,
  // expiry and profile invalidation also stop requests already awaiting WebAuthn.
  function take<K extends PasskeyChallenge['kind']>(
    id: unknown,
    profileId: string,
    sessionId: string,
    kind: K,
  ): Extract<PasskeyChallenge, { kind: K }> {
    const value = challenges.get(id as string);
    if (
      !value ||
      value.used ||
      value.expires < Date.now() ||
      value.profileId !== profileId ||
      value.sessionId !== sessionId ||
      value.kind !== kind ||
      value.generation !== generation(profileId)
    ) {
      throw new HttpError(400, 'PASSKEY_CHALLENGE', 'Passkey request expired. Try again.');
    }
    value.used = true;
    return value as Extract<PasskeyChallenge, { kind: K }>;
  }
  function assertPending(id: unknown, value: PasskeyChallenge): void {
    assertCurrent(value.profileId, value.generation);
    if (challenges.get(id as string) !== value || value.expires < Date.now())
      throw new HttpError(400, 'PASSKEY_CHALLENGE', 'Passkey request expired. Try again.');
  }
  function finish(id: unknown, value: PasskeyChallenge): void {
    if (challenges.get(id as string) === value) challenges.delete(id as string);
  }
  return {
    list(profileId: string) {
      const state = unlocked(profileId);
      return manager
        .keyring(profileId)
        .passkeys.map(({ id, rpID, createdAt, lastUsedAt, encryptedLabel }) => ({
          id,
          rpID,
          createdAt,
          lastUsedAt: lastUsedAt || null,
          ...(encryptedLabel
            ? { label: decryptLabel(encryptedLabel, state.key, profileId, id) }
            : {}),
        }));
    },
    rename(profileId: string, input: { credentialId?: unknown; label?: unknown }) {
      const state = unlocked(profileId);
      if (typeof input.credentialId !== 'string' || !input.credentialId)
        throw new HttpError(400, 'PASSKEY_ID', 'Select the passkey to name');
      const label = validatedLabel(input.label);
      // No await between the fresh read and atomic write: a removed credential
      // cannot be recreated, and concurrent usage/enrollment metadata is retained.
      const ring = manager.keyring(profileId),
        key = ring.passkeys.find((key) => key.id === input.credentialId);
      if (!key)
        throw new HttpError(
          404,
          'PASSKEY_UNKNOWN',
          'This passkey was already removed. Refresh the list.',
        );
      key.encryptedLabel = encryptLabel(label, state.key, profileId, key.id);
      manager.writeKeyring(profileId, ring);
      return { renamed: true, label };
    },
    remove(profileId: string, input: { credentialId?: unknown }) {
      unlocked(profileId);
      if (typeof input.credentialId !== 'string' || !input.credentialId)
        throw new HttpError(400, 'PASSKEY_ID', 'Select the passkey to remove');
      const ring = manager.keyring(profileId);
      if (!ring.passkeys.some((key) => key.id === input.credentialId))
        throw new HttpError(
          404,
          'PASSKEY_UNKNOWN',
          'This passkey was already removed. Refresh the list.',
        );
      ring.passkeys = ring.passkeys.filter((key) => key.id !== input.credentialId);
      manager.writeKeyring(profileId, ring);
      return { removed: true };
    },
    recordUse(profileId: string, credentialId: string): boolean {
      // Usage is optional metadata after successful activation. Any failure must
      // not turn a completed unlock into an authentication error. This fresh
      // read and write are synchronous, so they cannot overwrite an interleaved edit.
      try {
        unlocked(profileId);
        const ring = manager.keyring(profileId),
          key = ring.passkeys.find((key) => key.id === credentialId);
        if (!key) return false;
        key.lastUsedAt = new Date().toISOString();
        manager.writeKeyring(profileId, ring);
        return true;
      } catch {
        return false;
      }
    },
    invalidate(profileId: string): void {
      generations.set(profileId, generation(profileId) + 1);
      for (const [id, challenge] of challenges)
        if (challenge.profileId === profileId) challenges.delete(id);
    },
    cancel(profileId: string, sessionId: string, input: { challengeId: string }) {
      const challenge = challenges.get(input.challengeId);
      if (challenge && challenge.profileId === profileId && challenge.sessionId === sessionId)
        challenges.delete(input.challengeId);
      return { cancelled: true };
    },
    async registrationOptions(profileId: string, sessionId: string, origin: string) {
      const state = unlocked(profileId),
        expectedGeneration = generation(profileId);
      const address = new URL(origin),
        rpID = address.hostname;
      if (isIP(rpID.replace(/^\[|\]$/g, ''))) {
        const guidance =
          address.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(rpID)
            ? `Open http://localhost${address.port ? ':' + address.port : ''} and unlock the profile to add a passkey.`
            : 'Open the app using its configured HTTPS hostname and unlock the profile to add a passkey.';
        throw new HttpError(
          400,
          'PASSKEY_DOMAIN',
          `Passkeys require a hostname, not an IP address. ${guidance}`,
        );
      }
      const ring = manager.keyring(profileId),
        salt = randomBytes(32).toString('base64url');
      const options = await generateRegistrationOptions({
        rpName: 'Circus Health',
        rpID,
        userName: manager.card(profileId).name,
        userID: Buffer.from(profileId),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: ring.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      });
      assertCurrent(profileId, expectedGeneration);
      if (unlocked(profileId) !== state)
        throw new HttpError(
          409,
          'PASSKEY_CANCELLED',
          'Profile access changed. Start the passkey request again.',
        );
      (options as unknown as { extensions: { prf: { eval: { first: string } } } }).extensions = {
        ...options.extensions,
        prf: { eval: { first: salt } },
      };
      return {
        challengeId: add({
          kind: 'register',
          profileId,
          sessionId,
          origin,
          rpID,
          challenge: options.challenge,
          salt,
          generation: expectedGeneration,
        }),
        options,
      };
    },
    async register(profileId: string, sessionId: string, input: RegistrationInput) {
      const state = unlocked(profileId);
      const challenge = take(input.challengeId, profileId, sessionId, 'register');
      try {
        const result = await verification.verifyRegistrationResponse({
          response: input.response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rpID,
          requireUserVerification: true,
        });
        assertPending(input.challengeId, challenge);
        if (unlocked(profileId) !== state)
          throw new HttpError(
            409,
            'PASSKEY_CANCELLED',
            'Profile access changed. Start the passkey request again.',
          );
        if (!result.verified)
          throw new HttpError(
            400,
            'PASSKEY_VERIFICATION',
            'Passkey registration could not be verified',
          );
        const credential = result.registrationInfo!.credential;
        if (manager.keyring(profileId).passkeys.some((p) => p.id === credential.id))
          throw new HttpError(409, 'PASSKEY_EXISTS', 'Passkey is already registered');
        const options = await generateAuthenticationOptions({
          rpID: challenge.rpID,
          userVerification: 'required',
          allowCredentials: [{ id: credential.id, transports: credential.transports }],
        });
        assertPending(input.challengeId, challenge);
        if (unlocked(profileId) !== state)
          throw new HttpError(
            409,
            'PASSKEY_CANCELLED',
            'Profile access changed. Start the passkey request again.',
          );
        (options as unknown as { extensions: { prf: { eval: { first: string } } } }).extensions = {
          prf: { eval: { first: challenge.salt } },
        };
        // Creation PRF is deliberately ignored: every enrollment must demonstrate
        // the credential's authentication PRF before a durable wrapper is published.
        challenges.set(input.challengeId as string, {
          ...challenge,
          kind: 'confirm',
          providerName: passkeyProviderName(result.registrationInfo!.aaguid),
          used: false,
          challenge: options.challenge,
          credential: {
            id: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: credential.counter,
            transports: credential.transports,
          },
        });
        return { challengeId: input.challengeId, options };
      } finally {
        finish(input.challengeId, challenge);
      }
    },
    async confirm(profileId: string, sessionId: string, input: AuthenticationInput) {
      const state = unlocked(profileId);
      const challenge = take(input.challengeId, profileId, sessionId, 'confirm');
      try {
        const credential = challenge.credential;
        if ((input.response as { id?: unknown } | null)?.id !== credential.id)
          throw new HttpError(400, 'PASSKEY_UNKNOWN', 'Passkey does not match the new credential');
        const result = await verification.verifyAuthenticationResponse({
          response: input.response as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rpID,
          credential: { ...credential, publicKey: Buffer.from(credential.publicKey, 'base64url') },
          requireUserVerification: true,
        });
        assertPending(input.challengeId, challenge);
        if (unlocked(profileId) !== state)
          throw new HttpError(
            409,
            'PASSKEY_CANCELLED',
            'Profile access changed. Start the passkey request again.',
          );
        if (!result.verified)
          throw new HttpError(400, 'PASSKEY_VERIFICATION', 'Passkey could not be verified');
        const secret = prfBytes(input.prf);
        try {
          const ring = manager.keyring(profileId);
          if (ring.passkeys.some((p) => p.id === credential.id))
            throw new HttpError(409, 'PASSKEY_EXISTS', 'Passkey is already registered');
          const wrapped = wrapKey(state.key, secret, profileId, `passkey:${credential.id}`);
          const check = unwrapKey(wrapped, secret, profileId, `passkey:${credential.id}`);
          try {
            if (!timingSafeEqual(check, state.key)) throw Error('Passkey unwrap failed');
          } finally {
            check.fill(0);
          }
          ring.passkeys.push({
            ...credential,
            encryptedLabel: encryptLabel(
              availablePasskeyName(
                challenge.providerName,
                ring.passkeys.map((key) =>
                  key.encryptedLabel
                    ? decryptLabel(key.encryptedLabel, state.key, profileId, key.id)
                    : 'Passkey',
                ),
              ),
              state.key,
              profileId,
              credential.id,
            ),
            counter: result.authenticationInfo.newCounter,
            salt: challenge.salt,
            rpID: challenge.rpID,
            wrapped,
            createdAt: new Date().toISOString(),
          });
          manager.writeKeyring(profileId, ring);
          return { registered: true };
        } finally {
          secret.fill(0);
        }
      } finally {
        finish(input.challengeId, challenge);
      }
    },
    async authenticationOptions(profileId: string, sessionId: string, origin: string) {
      manager.card(profileId);
      const expectedGeneration = generation(profileId),
        ring = manager.keyring(profileId),
        rpID = new URL(origin).hostname,
        allowed = ring.passkeys.filter((p) => p.rpID === rpID);
      if (!allowed.length)
        throw new HttpError(
          409,
          'NO_PASSKEY',
          'No passkey is available for this address. Use your recovery key.',
        );
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: allowed.map((p) => ({ id: p.id, transports: p.transports })),
      });
      assertCurrent(profileId, expectedGeneration);
      (
        options as unknown as {
          extensions: { prf: { evalByCredential: Record<string, { first: string }> } };
        }
      ).extensions = {
        prf: {
          evalByCredential: Object.fromEntries(allowed.map((p) => [p.id, { first: p.salt }])),
        },
      };
      return {
        challengeId: add({
          kind: 'authenticate',
          profileId,
          sessionId,
          origin,
          rpID,
          challenge: options.challenge,
          generation: expectedGeneration,
        }),
        options,
      };
    },
    async authenticate(profileId: string, sessionId: string, input: AuthenticationInput) {
      const challenge = take(input.challengeId, profileId, sessionId, 'authenticate');
      try {
        const ring = manager.keyring(profileId),
          saved = ring.passkeys.find(
            (p) =>
              p.id === (input.response as { id?: unknown } | null)?.id && p.rpID === challenge.rpID,
          );
        if (!saved)
          throw new HttpError(400, 'PASSKEY_UNKNOWN', 'Passkey does not belong to this profile');
        const result = await verification.verifyAuthenticationResponse({
          response: input.response as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rpID,
          credential: {
            id: saved.id,
            publicKey: Buffer.from(saved.publicKey, 'base64url'),
            counter: saved.counter,
            transports: saved.transports,
          },
          requireUserVerification: true,
        });
        assertPending(input.challengeId, challenge);
        if (!result.verified)
          throw new HttpError(400, 'PASSKEY_VERIFICATION', 'Passkey could not be verified');
        const secret = prfBytes(input.prf);
        let key: VaultKey | null | undefined;
        try {
          key = unwrapKey(saved.wrapped, secret, profileId, `passkey:${saved.id}`);
        } catch {
          throw new HttpError(
            400,
            'PASSKEY_UNWRAP',
            'This passkey could not unlock the profile. Use your recovery key.',
          );
        } finally {
          secret.fill(0);
        }
        try {
          const currentRing = manager.keyring(profileId),
            current = currentRing.passkeys.find((p) => p.id === saved.id);
          if (!current || current.counter !== saved.counter)
            throw new HttpError(409, 'PASSKEY_CHANGED', 'Passkey state changed. Try again.');
          current.counter = result.authenticationInfo.newCounter;
          manager.writeKeyring(profileId, currentRing);
          const profile = manager.unlockWithKey(profileId, key);
          key = null;
          return profile;
        } finally {
          key?.fill(0);
        }
      } finally {
        finish(input.challengeId, challenge);
      }
    },
  };
}
