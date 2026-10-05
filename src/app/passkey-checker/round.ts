/** A new active testing round; old databases and provider credentials are not deleted. */
export const TEST_ROUND = '2026-10-05';
export type RegistrationMode = 'eval' | 'enable-only';
export const LEGACY_DATABASE = 'circus-health-passkey-checker-v1';
export function roundDatabase(mode: RegistrationMode): string {
  if (mode !== 'eval' && mode !== 'enable-only') throw new TypeError('Unknown checker mode');
  return `circus-health-passkey-checker-round-${TEST_ROUND}-${mode}`;
}
