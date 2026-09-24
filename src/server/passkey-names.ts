import providers from './passkey-provider-names.json' with { type: 'json' };

// Factual name mappings from passkeydeveloper/passkey-authenticator-aaguids,
// aaguid.json at 774b3cfc940a4138bc451ae4ec9b943bf9a44c1b. Icons are not bundled.
// A name is a display hint, never an authenticator trust or PRF signal.
export function passkeyProviderName(aaguid: unknown) {
  if (typeof aaguid !== 'string') return 'Passkey';
  const id = aaguid.toLowerCase();
  return Object.hasOwn(providers, id) ? providers[id as keyof typeof providers] : 'Passkey';
}

export function availablePasskeyName(base: string, labels: Array<string | null | undefined>) {
  const used = new Set(labels.map((label) => (label || 'Passkey').trim().toLowerCase()));
  let candidate = base;
  for (let number = 2; used.has(candidate.toLowerCase()); number++) {
    candidate = `${base} ${number}`;
  }
  return candidate;
}
