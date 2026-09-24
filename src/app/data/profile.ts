import { useSyncExternalStore } from 'react';

export type Profile = {
  id: string;
  name: string;
  placebo: boolean;
  nameVersion?: number;
  version?: number;
  icon?: string;
  locked?: boolean;
  hasPasskey?: boolean;
  storageBytes?: number;
};
let selected: Profile | null = null;
let registry: Profile[] = [];
const listeners = new Set<() => void>();
export function currentProfile() {
  return selected;
}
export function currentProfiles() {
  return registry;
}
export function subscribeProfile(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function subscribeProfileIdentity(listener: () => void) {
  let id = selected?.id;
  return subscribeProfile(() => {
    if (selected?.id === id) return;
    id = selected?.id;
    listener();
  });
}
const emit = () => {
  for (const listener of listeners) listener();
};
function sameProfile(a: Profile | null | undefined, b: Profile) {
  return (
    a?.id === b.id &&
    a.name === b.name &&
    a.placebo === b.placebo &&
    a.nameVersion === b.nameVersion &&
    a.version === b.version &&
    a.icon === b.icon &&
    a.locked === b.locked &&
    a.hasPasskey === b.hasPasskey &&
    a.storageBytes === b.storageBytes
  );
}
function newest(previous: Profile | undefined, next: Profile) {
  // Name freshness must never override authoritative lock or storage metadata.
  return previous && (previous.nameVersion ?? 0) > (next.nameVersion ?? 0)
    ? {
        ...next,
        name: previous.name,
        nameVersion: previous.nameVersion,
        version: previous.version,
        icon: previous.icon,
      }
    : next;
}
export function replaceProfiles(profiles: Profile[]) {
  registry = profiles.map((profile) =>
    newest(
      registry.find((item) => item.id === profile.id),
      profile,
    ),
  );
  const nextSelected = registry.find((item) => item.id === selected?.id);
  if ((!nextSelected || nextSelected.locked) && selected) clearProfile();
  else if (nextSelected && !sameProfile(selected, nextSelected)) selected = nextSelected;
  emit();
}
// A versioned server projection refreshes names without switching identities.
// Ignore late responses so an older GET cannot undo a successful rename.
export function recordProfile(profileId: string | undefined, value: unknown) {
  if (!profileId || !value || typeof value !== 'object') return;
  const next = value as Profile;
  if (
    next.id !== profileId ||
    typeof next.name !== 'string' ||
    !next.name.trim() ||
    typeof next.placebo !== 'boolean' ||
    !Number.isInteger(next.nameVersion) ||
    (next.nameVersion ?? -1) < 0
  )
    return;
  const previous =
    registry.find((item) => item.id === profileId) ??
    (selected?.id === profileId ? selected : undefined);
  // Scoped API responses project Self identity, not the complete public card.
  // Keep storage and authorization metadata from the last registry response.
  const accepted = newest(previous, {
    ...previous,
    ...next,
    ...(previous
      ? {
          locked: previous.locked,
          hasPasskey: previous.hasPasskey,
          storageBytes: previous.storageBytes,
        }
      : {}),
  });
  if (sameProfile(previous, accepted)) return;
  registry = registry.some((item) => item.id === profileId)
    ? registry.map((item) => (item.id === profileId ? accepted : item))
    : [...registry, accepted];
  if (selected?.id === profileId) selected = accepted;
  emit();
}
export function clearProfile() {
  selected = null;
  if (typeof document !== 'undefined')
    document.getElementById('recharts_measurement_span')?.remove();
  try {
    localStorage.removeItem('health-profile');
  } catch {
    /* Selection also works without storage. */
  }
  emit();
}
export function selectProfile(profile: Profile) {
  if (profile.locked) return;
  // Recharts leaves a text-measurement node outside React's tree. Clear its
  // previous value along with the keyed pages when changing owners.
  if (selected?.id !== profile.id && typeof document !== 'undefined') {
    document.getElementById('recharts_measurement_span')?.remove();
  }
  selected = newest(
    registry.find((item) => item.id === profile.id),
    profile,
  );
  try {
    localStorage.setItem('health-profile', profile.id);
  } catch {
    /* Selection still works without browser storage. */
  }
  emit();
}
export function useProfile() {
  return useSyncExternalStore(subscribeProfile, currentProfile, currentProfile);
}
export function useProfiles() {
  return useSyncExternalStore(subscribeProfile, currentProfiles, currentProfiles);
}
