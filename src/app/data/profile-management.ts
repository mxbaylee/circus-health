import { ApiError } from './api';
import type { Profile } from './profile';

// Lifecycle requests deliberately operate on explicit IDs, independently of the
// selected clinical profile. Keep that exception out of the clinical API helper.
async function request<T>(path: string, method: string, body: unknown, setup = false): Promise<T> {
  const response = await fetch(`${setup ? '/api/profile-setups' : '/api/profiles'}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      payload?.error?.message ?? `Request failed (${response.status}).`,
      payload?.error?.code,
      response.status,
    );
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data'))
    throw new ApiError('The server returned an unexpected response.', 'INVALID_RESPONSE');
  return payload.data as T;
}
export type RecoveryKit = {
  format: 'circus-health-recovery-v1';
  profileId: string;
  phrase: string;
};
export type ProfileSetup = { setupId: string; profileId: string; recoveryKit: RecoveryKit };
export const createProfile = (
  name: string,
  icon: string,
  placebo = false,
  copyFrom?: string,
  identity?: { fullName: string; birthDate: string },
) =>
  request<ProfileSetup>(
    '',
    'POST',
    { name, icon, placebo, ...identity, ...(copyFrom ? { copyFrom } : {}) },
    true,
  );
export const verifyProfileSetup = (setupId: string, recovery: string | RecoveryKit) =>
  request<Profile>(
    `/${encodeURIComponent(setupId)}/verify`,
    'POST',
    { recovery, acknowledged: true },
    true,
  );
export const unlockProfile = (id: string, recovery: string | RecoveryKit) =>
  request<Profile>(`/${encodeURIComponent(id)}/unlock`, 'POST', { recovery });
export const lockProfile = (id: string) =>
  request<Profile>(`/${encodeURIComponent(id)}/lock`, 'POST', {});
export type PasskeyChallenge = { challengeId: string; options: Record<string, unknown> };
export const passkeyRegistrationOptions = (profileId: string) =>
  request<PasskeyChallenge>(`/${encodeURIComponent(profileId)}/passkeys/options`, 'POST', {});
export const verifyPasskeyRegistration = (profileId: string, body: unknown) =>
  request<PasskeyChallenge>(`/${encodeURIComponent(profileId)}/passkeys/verify`, 'POST', body);
export const confirmPasskeyRegistration = (profileId: string, body: unknown) =>
  request<{ registered: true }>(`/${encodeURIComponent(profileId)}/passkeys/confirm`, 'POST', body);
export const cancelPasskeyRegistration = (profileId: string, challengeId: string) =>
  request<unknown>(`/${encodeURIComponent(profileId)}/passkeys/cancel`, 'POST', { challengeId });
export const passkeyAuthenticationOptions = (id: string) =>
  request<{ challengeId: string; options: Record<string, unknown> }>(
    `/${encodeURIComponent(id)}/passkeys/authentication-options`,
    'POST',
    {},
  );
export const authenticatePasskey = (id: string, body: unknown) =>
  request<Profile>(`/${encodeURIComponent(id)}/passkeys/authenticate`, 'POST', body);
export const resumeProfileSetup = (recovery: RecoveryKit) =>
  request<
    { profileId: string; name: string } & ({ active: true } | { active: false; setupId: string })
  >('/resume', 'POST', { recovery }, true);
export const deleteProfile = (id: string, confirmationName: string, version: number) =>
  request<unknown>(`/${encodeURIComponent(id)}`, 'DELETE', { confirmationName, version });

export const cancelPasskeyAuthentication = cancelPasskeyRegistration;

export type SavedPasskey = {
  id: string;
  rpID: string;
  createdAt: string;
  lastUsedAt: string | null;
  label?: string;
};
export const removeProfilePasskey = (profileId: string, credentialId: string) =>
  request<{ removed: true }>(`/${encodeURIComponent(profileId)}/passkeys/remove`, 'POST', {
    credentialId,
  });

export const renameProfilePasskey = (profileId: string, credentialId: string, label: string) =>
  request<{ renamed: true; label: string }>(
    `/${encodeURIComponent(profileId)}/passkeys/rename`,
    'POST',
    { credentialId, label },
  );
