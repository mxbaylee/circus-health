/** Saved names are explicit human assertions. Similar names are suggestions only. */
export function canonicalIdentityName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function knownNamesError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32)
    return 'Known names must be a list of at most 32 names';
  const seen = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 200 ||
      /[\x00-\x1f]/.test(name)
    )
      return 'Each known name must contain 1–200 characters';
    const key = canonicalIdentityName(name);
    if (seen.has(key)) return 'Known names must not contain duplicates';
    seen.add(key);
  }
  return null;
}

export function savedKnownNames(value: unknown): string[] {
  return !knownNamesError(value) && Array.isArray(value)
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
