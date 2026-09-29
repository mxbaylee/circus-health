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

/** Labelled dates only; ambiguous numeric dates retain every valid interpretation. */
export function labelledBirthDates(text: string): string[] {
  const dates = new Set<string>();
  const pattern = new RegExp(
    `\\b(?:DOB|date of birth|birth date)\\s*:?\\s*(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}|(?:${monthPattern})\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+(?:${monthPattern})\\s+\\d{4})\\b`,
    'gi',
  );
  for (const match of text.matchAll(pattern))
    for (const date of supportedDateValues(match[1]!)) dates.add(date);
  return [...dates];
}

/** Bound DOB discovery to the printed patient's nearby header, never another person. */
export function originalSubjectBirthDates(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): string[] {
  if (!text || !subject) return [];
  const anchor = reportAnchor ? text.indexOf(reportAnchor) : -1;
  const scoped =
    !!reportAnchor &&
    anchor >= 0 &&
    text.indexOf(reportAnchor, anchor + reportAnchor.length) === -1;
  if (scoped) text = text.slice(anchor);
  const dates = new Set<string>();
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(subject, offset);
    if (start < 0) break;
    offset = start + subject.length;
    const prefix = text.slice(Math.max(0, text.lastIndexOf('\n', start - 1) + 1), start);
    if (/\b(?:mother|father|sibling|spouse|child|guarantor|contact)\b[^:]*:?\s*$/i.test(prefix))
      continue;
    const header = text.slice(start, start + subject.length + 300);
    const patientLabelEnd =
      /^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*/i.exec(header)?.[0].length || 0;
    const nextPerson =
      /\b(?:(?:mother|father|sibling|spouse|child|guarantor|contact|family history)\b|(?:patient|subject)\s*:)/i.exec(
        header.slice(patientLabelEnd),
      );
    for (const date of labelledBirthDates(
      nextPerson ? header.slice(0, patientLabelEnd + nextPerson.index) : header,
    ))
      dates.add(date);
    if (scoped) break;
  }
  return [...dates];
}
