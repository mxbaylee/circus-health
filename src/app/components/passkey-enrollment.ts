import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import {
  cancelPasskeyRegistration,
  confirmPasskeyRegistration,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from '../data/profile-management';
import { prfFrom, withBinaryPrf } from './passkey-prf';
import { ApiError } from '../data/api';

export type PasskeyEnrollmentPhase = 'creating' | 'confirming' | 'saving';
export class PasskeyEnrollmentError extends Error {}
let activeEnrollment: symbol | null = null;

function withoutPrfResults<T extends { clientExtensionResults?: unknown }>(response: T): T {
  const extensions = response.clientExtensionResults as Record<string, unknown> | undefined;
  const prf = extensions?.prf as Record<string, unknown> | undefined;
  if (!prf) return response;
  const { results: _results, ...metadata } = prf;
  return { ...response, clientExtensionResults: { ...extensions, prf: metadata } };
}

/** A stored authenticator credential is usable only after its PRF assertion is verified. */
export async function enrollProfilePasskey(
  profileId: string,
  {
    signal,
    onPhase,
  }: {
    signal: AbortSignal;
    onPhase?: (phase: PasskeyEnrollmentPhase) => void;
  },
): Promise<void> {
  signal.throwIfAborted();
  const attempt = Symbol('passkey enrollment');
  activeEnrollment = attempt;
  let challengeId: string | undefined,
    browserPending = false,
    saved = false;
  const cancelled = new Set<string>();
  const cancelPending = async () => {
    if (!challengeId || cancelled.has(challengeId)) return;
    cancelled.add(challengeId);
    // Cancellation cannot require a successful network connection. The server
    // also expires staged credentials and invalidates them on lock/restart.
    await cancelPasskeyRegistration(profileId, challengeId).catch(() => {});
  };
  const abort = () => {
    if (browserPending && activeEnrollment === attempt) WebAuthnAbortService.cancelCeremony();
    if (!saved) void cancelPending();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    onPhase?.('creating');
    signal.throwIfAborted();
    const registration = await passkeyRegistrationOptions(profileId);
    challengeId = registration.challengeId;
    signal.throwIfAborted();
    browserPending = true;
    const created = await startRegistration({
      optionsJSON: withBinaryPrf(registration.options) as never,
    });
    browserPending = false;
    signal.throwIfAborted();
    onPhase?.('confirming');
    signal.throwIfAborted();
    // PRF output is optional during create(). Verify the new public credential,
    // then ask to use that exact credential with the same server-generated salt.
    const confirmation = await verifyPasskeyRegistration(profileId, {
      challengeId,
      response: withoutPrfResults(created),
    });
    challengeId = confirmation.challengeId;
    signal.throwIfAborted();
    browserPending = true;
    const assertion = await startAuthentication({
      optionsJSON: withBinaryPrf(confirmation.options) as never,
    });
    browserPending = false;
    signal.throwIfAborted();
    const prf = prfFrom(assertion);
    if (!prf)
      throw new PasskeyEnrollmentError(
        'This passkey can’t unlock your encrypted profile in this browser. Skip to use your recovery key.',
      );
    onPhase?.('saving');
    signal.throwIfAborted();
    await confirmPasskeyRegistration(profileId, {
      challengeId,
      response: withoutPrfResults(assertion),
      prf,
    });
    saved = true;
  } catch (error) {
    if (error instanceof ApiError) throw new PasskeyEnrollmentError(error.message);
    throw error;
  } finally {
    browserPending = false;
    signal.removeEventListener('abort', abort);
    if (activeEnrollment === attempt) activeEnrollment = null;
    if (!saved) await cancelPending();
  }
}
