import { useSyncExternalStore } from 'react';
import { useProfile } from './profile.ts';

export type Durability = {
  configured: boolean;
  dirty: boolean;
  revision: number;
  persistedRevision: number | null;
  lastError: string | null;
};
const states = new Map<string, Durability>();
const listeners = new Set<() => void>();
export function recordDurability(profileId: string | undefined, value: unknown) {
  if (!profileId || !value || typeof value !== 'object' || !('configured' in value)) return;
  const next = value as Durability;
  const previous = states.get(profileId);
  if (previous && next.revision < previous.revision) return;
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  states.set(profileId, next);
  for (const listener of listeners) listener();
}
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
export function useDurability() {
  const profile = useProfile();
  return useSyncExternalStore(
    subscribe,
    () => (profile ? states.get(profile.id) : undefined),
    () => undefined,
  );
}
