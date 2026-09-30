/** Saved names are explicit human assertions. Similar names are suggestions only. */
export function canonicalIdentityName(value: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  const parts = normalized.split(',').map((part) => part.trim());
  // Only the explicit surname, given-name convention is reordered. Multiple
  // commas and suffixes remain literal, avoiding arbitrary token permutations.
  if (
    parts.length === 2 &&
    parts.every((part) => /^[\p{L}\p{M} .’'-]+$/u.test(part)) &&
    !parts.some((part) => /^(jr\.?|sr\.?|ii|iii|iv)$/i.test(part))
  )
    return parts[1] + ' ' + parts[0];
  return normalized;
}

export function knownNamesError(value: unknown, limit = 32): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > limit)
    return `Known names must be a list of at most ${limit} names`;
  const seen = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 200 ||
      /[\x00-\x1f]/.test(name)
    )
      return 'Each known name must contain 1–200 characters';
    const literalKey = name
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('en-US');
    if (seen.has(literalKey)) return 'Known names must not contain duplicates';
    seen.add(literalKey);
  }
  return null;
}

export function savedKnownNames(value: unknown): string[] {
  return !knownNamesError(value, 1056) && Array.isArray(value)
    ? value.map((name: string) => name.trim())
    : [];
}

/** Complete calendar dates only for new-profile onboarding; legacy partial dates are unchanged. */
export function validOnboardingBirthDate(
  value: unknown,
  today = new Date().toISOString().slice(0, 10),
): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today)
    return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function validOnboardingFullName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.trim().length <= 200 &&
    !/[\x00-\x1f]/.test(value)
  );
}

/** Conservative hint: same final name and matching given names/initials in order.
 * It never establishes identity and never changes a saved name. */
export function possiblySameIdentityName(left: string, right: string): boolean {
  const tokens = (name: string) => canonicalIdentityName(name).replace(/\./g, '').split(' ');
  const a = tokens(left),
    b = tokens(right);
  if (a.length < 2 || b.length < 2 || a.at(-1) !== b.at(-1)) return false;
  const compatible = (x: string, y: string) =>
    x === y || (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y));
  if (!compatible(a[0]!, b[0]!)) return false;
  const short = a.length <= b.length ? a : b,
    long = a.length <= b.length ? b : a;
  let index = 1;
  for (const token of short.slice(1, -1)) {
    while (index < long.length - 1 && !compatible(token, long[index]!)) index++;
    if (index >= long.length - 1) return false;
    index++;
  }
  return true;
}

/** Do not turn a report's single given name into a reusable identity alias. */
export function safeSourceIdentityName(name: string): boolean {
  return (
    canonicalIdentityName(name)
      .split(/\s+/)
      .filter((part) => /[\p{L}]/u.test(part)).length >= 2
  );
}

export function compatibleIdentityBirthDates(left: string, right: string): boolean {
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  return long === short || long.startsWith(short + '-');
}

/** One rule for Self-versus-new-Person choices in review and server publication. */
export function matchesSelfIdentityName(fullName: string, names: readonly string[]): boolean {
  return (
    !!fullName.trim() &&
    names.some(
      (name) => !!name.trim() && canonicalIdentityName(name) === canonicalIdentityName(fullName),
    )
  );
}
