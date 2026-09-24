export const PERSON_TAG_SUGGESTIONS = [
  'Family',
  'Professional',
  'Primary Care Provider',
  'Emergency Contact',
] as const;
export const MAX_PERSON_TAGS = 24;
export const MAX_PERSON_TAG_LENGTH = 80;

export function canonicalPersonTag(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ').toLowerCase();
  return PERSON_TAG_SUGGESTIONS.find((tag) => tag.toLowerCase() === normalized) || normalized;
}
export function normalizePersonTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Tags must be a list of at most 24 tags.');
  const tags = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Each tag must be text.');
    const tag = canonicalPersonTag(item);
    if (tag.length > MAX_PERSON_TAG_LENGTH) throw new Error('Keep each tag within 80 characters.');
    if (tag) tags.add(tag);
  }
  if (tags.size > MAX_PERSON_TAGS) throw new Error('Choose at most 24 tags for a person.');
  return [...tags].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  );
}
export function personContactError(person: Record<string, unknown>): string {
  for (const [key, label, max] of [
    ['phone', 'Phone number', 200],
    ['email', 'Email address', 320],
    ['schedulingUrl', 'Scheduling URL', 2048],
  ] as const) {
    const value = person[key];
    if (value == null) continue;
    if (typeof value !== 'string') return `${label} must be text.`;
    if (value.trim().length > max) return `${label} is too long.`;
  }
  const email = typeof person.email === 'string' ? person.email.trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    return 'Enter an email address such as name@example.com, or leave it blank.';
  const schedulingUrl = typeof person.schedulingUrl === 'string' ? person.schedulingUrl.trim() : '';
  if (schedulingUrl) {
    try {
      const url = new URL(schedulingUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || /\s/u.test(schedulingUrl))
        throw new Error();
    } catch {
      return 'Use a full http:// or https:// scheduling URL, or leave it blank.';
    }
  }
  return '';
}
export function normalizedPersonCare<T extends Record<string, unknown>>(person: T): T {
  const normalized = { ...person };
  if (person.tags !== undefined)
    Object.assign(normalized, { tags: normalizePersonTags(person.tags) });
  for (const key of ['phone', 'email', 'schedulingUrl'] as const) {
    if (typeof person[key] === 'string') Object.assign(normalized, { [key]: person[key].trim() });
  }
  return normalized;
}

// Self is an identity, not a member of a care/contact role. Old source values
// can remain in saved history, but cannot be assigned to the current profile.
export function selfTagError(person: Record<string, unknown> | undefined, isSelf: boolean): string {
  if (!isSelf || person?.tags === undefined) return '';
  return Array.isArray(person.tags) && person.tags.length === 0
    ? ''
    : 'Self cannot have role or custom tags.';
}
export function withoutPersonTags<T extends Record<string, unknown>>(person: T): T {
  const copy = { ...person };
  delete copy.tags;
  return copy;
}
export function canSchedulePerson(person: Record<string, unknown>, isSelf = false): boolean {
  return (
    !isSelf &&
    Array.isArray(person.tags) &&
    person.tags.some(
      (tag) =>
        typeof tag === 'string' &&
        ['Professional', 'Primary Care Provider'].includes(canonicalPersonTag(tag)),
    )
  );
}
