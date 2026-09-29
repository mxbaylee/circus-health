const padded = (value: number): string => String(value).padStart(2, '0');
function calendarDate(year: number, month?: number, day?: number): string | null {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) return null;
  if (month === undefined) return String(year).padStart(4, '0');
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) return null;
  if (day === undefined) return `${String(year).padStart(4, '0')}-${padded(month)}`;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!Number.isSafeInteger(day) || day < 1 || day > days[month - 1]!) return null;
  return `${String(year).padStart(4, '0')}-${padded(month)}-${padded(day)}`;
}

const monthNumbers = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((month, index) => [month, index + 1]),
);
export const monthPattern = [...monthNumbers.keys()].join('|');
export function supportedDateValues(anchor: string): Set<string> {
  const values = new Set<string>();
  let sawStructuredDate = /\b\d{4}-\d{2}-\d{2}T[0-9:.+\-]+Z?/i.test(anchor);
  const source = anchor.replace(/\b\d{4}-\d{2}-\d{2}T[0-9:.+\-]+Z?/gi, ' ');
  const add = (year: string, month?: string, day?: string) => {
    const value = calendarDate(
      Number(year),
      month === undefined ? undefined : Number(month),
      day === undefined ? undefined : Number(day),
    );
    if (value) values.add(value);
  };
  for (const match of source.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    sawStructuredDate = true;
    add(match[1]!, match[2]!, match[3]!);
  }
  for (const match of source.matchAll(/\b(\d{4})-(\d{2})(?!-\d{2})\b/g)) {
    sawStructuredDate = true;
    add(match[1]!, match[2]!);
  }
  for (const match of source.matchAll(/\b(\d{4})[/.](\d{1,2})[/.](\d{1,2})\b/g)) {
    sawStructuredDate = true;
    add(match[1]!, match[2]!, match[3]!);
  }
  for (const match of source.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/g)) {
    sawStructuredDate = true;
    add(match[3]!, match[1]!, match[2]!);
    if (match[1] !== match[2]) add(match[3]!, match[2]!, match[1]!);
  }
  const namedFirst = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const match of source.matchAll(namedFirst)) {
    sawStructuredDate = true;
    add(match[3]!, String(monthNumbers.get(match[1]!.toLowerCase())), match[2]!);
  }
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})[,]?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (const match of source.matchAll(dayFirst)) {
    sawStructuredDate = true;
    add(match[3]!, String(monthNumbers.get(match[2]!.toLowerCase())), match[1]!);
  }
  const namedMonth = new RegExp(`\\b(${monthPattern})\\s+(\\d{4})\\b`, 'gi');
  for (const match of source.matchAll(namedMonth)) {
    sawStructuredDate = true;
    add(match[2]!, String(monthNumbers.get(match[1]!.toLowerCase())));
  }
  if (!values.size && !sawStructuredDate)
    for (const match of source.matchAll(/\b(\d{4})\b/g)) add(match[1]!);
  return values;
}

/**
 * Printed birth-date facts. `unreadable` means a birth-date label is present
 * but its value is not one complete calendar date: masked, free text, invalid,
 * partial (year or month only) or with a two-digit year. Identity policy must
 * ask about such a report; it is never the same as an absent birth date.
 */
export interface BirthDateEvidence {
  dates: string[];
  unreadable: boolean;
}

const noLetterOrDigit = '(?![\\p{L}\\p{N}])';
const birthMonth = `(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![\\p{L}])\\.?`;
const birthMonthNumber = (token: string): number =>
  [...monthNumbers.keys()].findIndex((month) => month.startsWith(token.slice(0, 3).toLowerCase())) +
  1;
const partSeparator = '[\\s./,-]*';
const ordinal = '(?:st|nd|rd|th)?';
const yearFirstBirthDate = new RegExp(
  `^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?:T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)?${noLetterOrDigit}`,
  'u',
);
const yearLastBirthDate = new RegExp(`^\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}${noLetterOrDigit}`, 'u');
const namedBirthDates: [RegExp, day: number, month: number, year: number][] = [
  // 4-Mar-1985, 04MAR1985, 4th March, 1985, 04/Mar/1985
  [
    new RegExp(
      `^(\\d{1,2})${ordinal}${partSeparator}${birthMonth}${partSeparator}(\\d{4})${noLetterOrDigit}`,
      'iu',
    ),
    1,
    2,
    3,
  ],
  // Mar 4, 1985; March 4th 1985; Sept. 04-1985
  [
    new RegExp(
      `^${birthMonth}${partSeparator}(\\d{1,2})${ordinal}${partSeparator}(\\d{4})${noLetterOrDigit}`,
      'iu',
    ),
    2,
    1,
    3,
  ],
  // 1985-Mar-04
  [
    new RegExp(
      `^(\\d{4})${partSeparator}${birthMonth}${partSeparator}(\\d{1,2})${noLetterOrDigit}`,
      'iu',
    ),
    3,
    2,
    1,
  ],
];
// `born` is also ordinary prose, so it is a label only before a colon or a date-like value.
const birthDateLabel =
  /(?<![\p{L}\p{N}])(?:d\.?o\.?b(?![\p{L}\p{N}])\.?|date\s+of\s+birth(?![\p{L}\p{N}])|birth[\s-]*date(?![\p{L}\p{N}])|(born)(?![\p{L}\p{N}]))/giu;
const bornLabel = new RegExp(`^\\s*(?::|(?:(?:on|in)\\s+)?(?=\\d|${birthMonth}))`, 'iu');

/** Every valid reading of one complete date at the start of `value`, or none. */
function completeBirthDateValues(value: string): string[] {
  const yearFirst = yearFirstBirthDate.exec(value);
  if (yearFirst) {
    const date = calendarDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    return date ? [date] : [];
  }
  const yearLast = yearLastBirthDate.exec(value);
  // Keep ambiguous day/month handling identical to other printed dates.
  if (yearLast) return [...supportedDateValues(yearLast[0])];
  for (const [pattern, day, month, year] of namedBirthDates) {
    const match = pattern.exec(value);
    if (!match) continue;
    const date = calendarDate(
      Number(match[year]),
      birthMonthNumber(match[month]!),
      Number(match[day]),
    );
    return date ? [date] : [];
  }
  return [];
}

/**
 * Labelled birth dates; ambiguous numeric dates retain every valid
 * interpretation. Only labels starting before `labelLimit` are read, although
 * their values may continue past it.
 */
export function labelledBirthDateEvidence(
  text: string,
  labelLimit = text.length,
): BirthDateEvidence {
  const dates = new Set<string>();
  let unreadable = false;
  for (const label of text.matchAll(birthDateLabel)) {
    if (label.index >= labelLimit) break;
    let value = text.slice(label.index + label[0].length);
    if (label[1]) {
      const born = bornLabel.exec(value);
      if (!born) continue;
      value = value.slice(born[0].length);
    }
    // Separators, including the quotes of a structured `"dob": "…"` field.
    const values = completeBirthDateValues(value.replace(/^["'\s:=#.\-–—]*/u, ''));
    if (!values.length) unreadable = true;
    for (const date of values) dates.add(date);
  }
  return { dates: [...dates], unreadable };
}

/** Labelled complete dates only; ambiguous numeric dates retain every valid interpretation. */
export function labelledBirthDates(text: string): string[] {
  return labelledBirthDateEvidence(text).dates;
}

const relativePrefix = /\b(?:mother|father|sibling|spouse|child|guarantor|contact)\b[^:]*:?\s*$/i;
const headerReach = 300;
// Far enough to finish a date whose label starts at the end of the header window.
const valueReach = 40;

/** Bound DOB discovery to the printed patient's nearby header, never another person. */
export function originalSubjectBirthDateEvidence(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): BirthDateEvidence {
  const dates = new Set<string>();
  let unreadable = false;
  if (!text || !subject) return { dates: [], unreadable };
  const anchor = reportAnchor ? text.indexOf(reportAnchor) : -1;
  const scoped =
    !!reportAnchor &&
    anchor >= 0 &&
    text.indexOf(reportAnchor, anchor + reportAnchor.length) === -1;
  /** Reads one printed subject's header; null when it introduces a relative. */
  const readHeader = (start: number, lineFloor: number): { labelled: boolean } | null => {
    const lineStart = Math.max(lineFloor, text.lastIndexOf('\n', start - 1) + 1);
    if (relativePrefix.test(text.slice(lineStart, start))) return null;
    const windowEnd = start + subject.length + headerReach;
    const header = text.slice(start, windowEnd);
    const patientLabelEnd =
      /^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*/i.exec(header)?.[0].length || 0;
    const nextPerson =
      /\b(?:(?:mother|father|sibling|spouse|child|guarantor|contact|family history)\b|(?:patient|subject)\s*:)/i.exec(
        header.slice(patientLabelEnd),
      );
    const evidence = labelledBirthDateEvidence(
      text.slice(
        start,
        nextPerson ? start + patientLabelEnd + nextPerson.index : windowEnd + valueReach,
      ),
      windowEnd - start,
    );
    for (const date of evidence.dates) dates.add(date);
    unreadable ||= evidence.unreadable;
    return { labelled: evidence.dates.length > 0 || evidence.unreadable };
  };
  let offset = scoped ? anchor : 0;
  let scopedHeader: { labelled: boolean } | null = null;
  while (offset < text.length) {
    const start = text.indexOf(subject, offset);
    if (start < 0) break;
    offset = start + subject.length;
    scopedHeader = readHeader(start, scoped ? anchor : 0);
    if (scoped && scopedHeader) break;
  }
  if (scoped && !scopedHeader?.labelled) {
    // A page banner printed just above the report heading is this report's
    // header when nothing after the heading prints a birth date for the subject.
    const banner =
      anchor >= subject.length ? text.lastIndexOf(subject, anchor - subject.length) : -1;
    if (banner >= 0 && anchor - banner <= subject.length + headerReach) readHeader(banner, 0);
  }
  return { dates: [...dates], unreadable };
}

/** Complete labelled birth dates from the printed patient's nearby header. */
export function originalSubjectBirthDates(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): string[] {
  return originalSubjectBirthDateEvidence(text, subject, reportAnchor).dates;
}
