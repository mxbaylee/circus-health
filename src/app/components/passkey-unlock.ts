import { startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser';
import {
  authenticatePasskey,
  cancelPasskeyAuthentication,
  passkeyAuthenticationOptions,
} from '../data/profile-management';
import { prfFrom, withBinaryPrf } from './passkey-prf';

export type PasskeyUnlockPhase = 'waiting' | 'saving';
export class PasskeyUnlockError extends Error {}
let activeUnlock: symbol | null = null;

export async function unlockProfilePasskey(
  profileId: string,
  {
    signal,
    onPhase,
  }: {
    signal: AbortSignal;
    onPhase?: (phase: PasskeyUnlockPhase) => void;
  },
) {
  signal.throwIfAborted();
  const attempt = Symbol('passkey unlock');
  activeUnlock = attempt;
  let challengeId: string | undefined,
    browserPending = false,
    saved = false,
    cancelled = false;
  const cancel = async () => {
    if (!challengeId || cancelled || saved) return;
    cancelled = true;
    await cancelPasskeyAuthentication(profileId, challengeId).catch(() => {});
  };
  const abort = () => {
    if (browserPending && activeUnlock === attempt) WebAuthnAbortService.cancelCeremony();
    void cancel();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    onPhase?.('waiting');
    signal.throwIfAborted();
    const challenge = await passkeyAuthenticationOptions(profileId);
    challengeId = challenge.challengeId;
    signal.throwIfAborted();
    browserPending = true;
    const response = await startAuthentication({
      optionsJSON: withBinaryPrf(challenge.options) as never,
    });
    browserPending = false;
    signal.throwIfAborted();
    const prf = prfFrom(response);
    if (!prf)
      throw new PasskeyUnlockError(
        'This passkey can’t unlock your encrypted profile in this browser. Use your recovery key.',
      );
    onPhase?.('saving');
    signal.throwIfAborted();
    const extensions = response.clientExtensionResults as Record<string, unknown>;
    const { results: _results, ...metadata } = extensions.prf as Record<string, unknown>;
    const sanitizedResponse = {
      ...response,
      clientExtensionResults: { ...extensions, prf: metadata },
    };
    const profile = await authenticatePasskey(profileId, {
      challengeId,
      response: sanitizedResponse,
      prf,
    });
    saved = true;
    signal.throwIfAborted();
    return profile;
  } catch (error) {
    if (signal.aborted || error instanceof PasskeyUnlockError) throw error;
    throw new PasskeyUnlockError(
      'Passkey unlock did not finish. Try again or use your recovery key.',
    );
  } finally {
    browserPending = false;
    signal.removeEventListener('abort', abort);
    if (activeUnlock === attempt) activeUnlock = null;
    await cancel();
  }
}
