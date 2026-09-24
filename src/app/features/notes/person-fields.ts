import type { PersonProfile } from '../../../shared/api.ts';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
export function personFields(profile: PersonProfile): PersonProfile {
  const relative =
    profile.sourceRelative && typeof profile.sourceRelative === 'object'
      ? (profile.sourceRelative as Record<string, unknown>)
      : {};
  return {
    ...profile,
    fullName:
      typeof profile.fullName === 'string'
        ? profile.fullName
        : text(relative.realName) || text(profile.realName),
    pronouns: text(profile.pronouns),
    birthDate: text(profile.birthDate),
    deathDate: text(profile.deathDate),
    lifeStatus: ['alive', 'deceased', 'unknown'].includes(text(profile.lifeStatus))
      ? profile.lifeStatus
      : 'unknown',
  };
}

/** Partial dates remain partial; never supply an invented month/day. */
export function validPartialDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12))) return false;
  return day === undefined || (day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate());
}
