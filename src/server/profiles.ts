// Public fictional seed metadata only. Private owners are selected from the
// runtime registry and verified archive metadata, never a compiled roster.
export interface ProfileDefinition {
  readonly id: string;
  readonly placebo: boolean;
  readonly defaultName: string;
  readonly legacyDatabase: string | null;
}
export const PROFILE_DEFINITIONS: readonly Readonly<ProfileDefinition>[] = Object.freeze([
  Object.freeze({
    id: 'cookie-dough',
    placebo: true,
    defaultName: 'Cookie Dough',
    legacyDatabase: 'data/profiles/cookie-dough.sqlite',
  }),
]);
export const PROFILE_IDS = Object.freeze(PROFILE_DEFINITIONS.map((profile) => profile.id));
export const PROFILES = Object.freeze(
  PROFILE_DEFINITIONS.map(({ id, placebo }) => Object.freeze({ id, placebo })),
);
// This validates a safe path component, not authorization or registry membership.
// The p- namespace remains reserved for generated opaque owner UUIDs.
export const validProfileId = (id: unknown): id is string =>
  typeof id === 'string' &&
  (/^p-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
    (!id.startsWith('p-') && /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(id)));
export function profileDefinition(profileId: unknown): Readonly<ProfileDefinition> {
  if (!validProfileId(profileId)) throw new Error('Unknown profile');
  return (
    PROFILE_DEFINITIONS.find((profile) => profile.id === profileId) || {
      id: profileId,
      placebo: false,
      defaultName: 'Patient',
      legacyDatabase: null,
    }
  );
}
