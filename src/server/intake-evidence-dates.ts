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
  /** Inferred centuries are display suggestions, never original evidence. */
  suggestions?: string[];
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
const bornLabel = new RegExp(`^\\s*(?::|(?:(?:on|in)\\s*)?(?=\\d|${birthMonth}))`, 'iu');

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

/** The latest century consistent with the report date; this is only a suggestion. */
function shortYearSuggestions(value: string, referenceDate: string): string[] {
  const yearOnly = /^(\d{2})\s*$/u.exec(value.split(/\r?\n/, 1)[0]!.trim());
  if (yearOnly) {
    const shortYear = Number(yearOnly[1]);
    for (
      let year = Math.floor(Number(referenceDate.slice(0, 4)) / 100) * 100 + shortYear;
      year > 0;
      year -= 100
    )
      if (String(year).padStart(4, '0') <= referenceDate) return [String(year).padStart(4, '0')];
    return [];
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?![\p{L}\p{N}])/u.exec(value);
  const parts: [number, number, number][] = [];
  if (numeric) {
    parts.push([Number(numeric[3]), Number(numeric[1]), Number(numeric[2])]);
    if (numeric[1] !== numeric[2])
      parts.push([Number(numeric[3]), Number(numeric[2]), Number(numeric[1])]);
  } else {
    for (const [pattern, day, month, year] of namedBirthDates.slice(0, 2)) {
      const match = new RegExp(
        pattern.source
          .replace('d{4}', 'd{2}')
          .replace('(?:st|nd|rd|th)?[\\s./,-]*(\\d{2})', '(?:st|nd|rd|th)?[\\s./,-]+(\\d{2})'),
        pattern.flags,
      ).exec(value);
      if (match)
        parts.push([Number(match[year]), birthMonthNumber(match[month]!), Number(match[day])]);
    }
  }
  return [
    ...new Set(
      parts.flatMap(([shortYear, month, day]) => {
        for (
          let year = Math.floor(Number(referenceDate.slice(0, 4)) / 100) * 100 + shortYear;
          year > 0;
          year -= 100
        ) {
          const date = calendarDate(year, month, day);
          if (date && date <= referenceDate) return [date];
          // An impossible month/day cannot become valid in another century.
          if (month < 1 || month > 12 || day < 1 || day > 31 || (month === 2 && day > 29)) break;
        }
        return [];
      }),
    ),
  ];
}

/**
 * Labelled birth dates; ambiguous numeric dates retain every valid
 * interpretation. Only labels starting before `labelLimit` are read, although
 * their values may continue past it.
 */
export function labelledBirthDateEvidence(
  text: string,
  labelLimit = text.length,
  referenceDate = new Date().toISOString().slice(0, 10),
): BirthDateEvidence {
  const dates = new Set<string>();
  let unreadable = false;
  const suggestions = new Set<string>();
  for (const label of text.matchAll(birthDateLabel)) {
    if (label.index >= labelLimit) break;
    let value = text.slice(label.index + label[0].length);
    if (label[1]) {
      const born = bornLabel.exec(value);
      if (!born) continue;
      value = value.slice(born[0].length);
    }
    // Separators, including the quotes of a structured `"dob": "…"` field.
    const dateText = value.replace(/^["'\s:=#.\-–—]*/u, '');
    const values = completeBirthDateValues(dateText);
    if (!values.length)
      for (const date of shortYearSuggestions(dateText, referenceDate)) suggestions.add(date);
    if (!values.length) unreadable = true;
    for (const date of values) dates.add(date);
  }
  return {
    dates: [...dates],
    unreadable,
    ...(suggestions.size ? { suggestions: [...suggestions] } : {}),
  };
}

/** Labelled complete dates only; ambiguous numeric dates retain every valid interpretation. */
export function labelledBirthDates(text: string): string[] {
  return labelledBirthDateEvidence(text).dates;
}

const relativePrefix =
  /\b(?:mother|father|sibling|spouse|child|guarantor|contact|policyholder|subscriber|insured|guardian|parent|responsible party|caregiver|next of kin|family member|physician|doctor|clinician|provider|nurse|emergency contact)\b[^:]*:?\s*$/i;
const headerReach = 300;
// Far enough to finish a date whose label starts at the end of the header window.
const valueReach = 40;

const relativeRole =
  /\b(?:mother|father|sibling|spouse|child|guarantor|contact|policyholder|subscriber|insured|guardian|parent|responsible party|family history|caregiver|next of kin|family member|physician|doctor|clinician|provider|nurse|emergency contact)(?=\s*(?::|\.|\b(?:DOB|D\.O\.B\.|date of birth|birthdate?)\b))/i;
const patientRole = /\b(?:patient|client|subject)(?:\s+name)?\s*[:.]/i;
const patientPersonStart =
  /\b(?:patient|client|subject)(?:\s+name)?\s*:|\b(?:patient|client|subject)\.name\s*:/i;
const objectBoundary = /^\[identity (?:object|record) boundary\]$/;
const structuredPath = /^\s*[\w-]+(?:\.[\w-]+)+\s*:/;

/** Retain JSON field names and object boundaries when reading the original. */
export function decodeOriginalIdentityText(source: string, filename: string): string {
  if (!/\.jsonl?$/i.test(filename)) return source;
  const readableKey = (key: string): string =>
    key === 'fullName'
      ? key
      : key
          .replace(/([a-z\d])([A-Z])/g, '$1.$2')
          .replace(/([A-Z])([A-Z][a-z])/g, '$1.$2')
          .replace(/[_\s-]+/g, '.')
          .replace(/birth\.date/gi, 'birthdate')
          .replace(/date\.of\.birth/gi, 'date of birth');
  const render = (value: unknown, path: string, depth: number): string => {
    if (depth > 100) return '';
    if (typeof value === 'string') return `${path ? `${path}: ` : ''}${value}\n`;
    if (value === null || typeof value === 'number' || typeof value === 'boolean')
      return path ? `${path}: ${String(value)}\n` : '';
    if (typeof value !== 'object') return '';
    let result = '';
    if (Array.isArray(value)) {
      for (const child of value)
        result += render(child, path, depth + 1) + '[identity record boundary]\n';
    } else {
      for (const [childKey, child] of Object.entries(value))
        result += render(
          child,
          path ? `${path}.${readableKey(childKey)}` : readableKey(childKey),
          depth + 1,
        );
    }
    return result;
  };
  try {
    if (/\.jsonl$/i.test(filename))
      return source
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => render(JSON.parse(line), '', 0) + '[identity record boundary]\n')
        .join('');
    return render(JSON.parse(source), '', 0);
  } catch {
    return source;
  }
}

interface IdentityLine {
  start: number;
  end: number;
  text: string;
  role: 'patient' | 'relative' | 'unknown';
}

function identityLines(text: string): IdentityLine[] {
  const lines: IdentityLine[] = [];
  let role: IdentityLine['role'] = 'unknown';
  let start = 0;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) break;
    const line = match[0];
    if (objectBoundary.test(line.trim())) role = 'unknown';
    else {
      const patient = patientRole.exec(line);
      const relative = relativeRole.exec(line);
      if (patient || relative)
        role = patient && (!relative || patient.index > relative.index) ? 'patient' : 'relative';
      else if (structuredPath.test(line)) role = 'unknown';
    }
    lines.push({ start, end: start + line.length, text: line, role });
    start += line.length;
  }
  return lines;
}

function reportWindow(text: string, subject: string, reportAnchor?: string) {
  if (!reportAnchor) return { start: 0, end: text.length, anchor: -1 };
  const anchor = text.indexOf(reportAnchor);
  if (anchor < 0 || text.indexOf(reportAnchor, anchor + reportAnchor.length) >= 0)
    return { start: 0, end: 0, anchor: -1 };
  const lines = identityLines(text);
  const anchorLine = lines.findIndex((line) => line.start <= anchor && line.end > anchor);
  const preceding = lines[anchorLine - 1];
  // A patient banner immediately above the title belongs to the same report.
  const start =
    preceding && preceding.text.includes(subject) && anchor - preceding.start <= headerReach
      ? preceding.start
      : anchor;
  const nextRecord = text.indexOf('[identity record boundary]', anchor + reportAnchor.length);
  let end = Math.min(text.length, anchor + 600, nextRecord < 0 ? text.length : nextRecord);
  let firstPatient = false;
  for (let index = anchorLine + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.start >= end) break;
    if (
      /\breport\b/i.test(line.text) &&
      !/^\s*(?:report\s*date|reportDate)\s*:/i.test(line.text) &&
      !/^\s*[\w.-]+\s*:/.test(line.text)
    ) {
      end = line.start;
      break;
    }
    if (patientPersonStart.test(line.text)) {
      if (firstPatient) {
        end = line.start;
        break;
      }
      firstPatient = true;
    }
  }
  return {
    start,
    end,
    anchor,
  };
}

function boundReportDate(text: string, subject: string, reportAnchor?: string): string | null {
  const window = reportWindow(text, subject, reportAnchor);
  if (window.anchor < 0) return null;
  const lines = identityLines(text);
  const anchorIndex = lines.findIndex(
    (line) => line.start <= window.anchor && line.end > window.anchor,
  );
  const dateLine =
    /^\s*(?:report\s*date|reportDate|report\.date|date\s*reported|report\s*dated|reported)\s*[:=]\s*(.*)/i;
  const candidates: string[] = [];
  // A date directly above the heading is part of its printed banner.
  if (anchorIndex > 0) {
    const previous = lines[anchorIndex - 1]!;
    const found = dateLine.exec(previous.text);
    const beforeDate = lines[anchorIndex - 2];
    // A date following another report title may be that earlier report's date.
    if (found && !(beforeDate && /\breport\b/i.test(beforeDate.text))) candidates.push(found[1]!);
  }
  // Only an adjacent report header is reliably bound. Never search the rest
  // of a page for a date that may belong to another report.
  const following = lines[anchorIndex + 1];
  if (following && following.start < window.end) {
    const found = dateLine.exec(following.text);
    if (found) candidates.push(found[1]!);
  }
  if (candidates.length !== 1) return null;
  const values = completeBirthDateValues(candidates[0]!.trim());
  return values.length === 1 ? values[0]! : null;
}

function patientSubjectPosition(
  text: string,
  lines: IdentityLine[],
  start: number,
  subject: string,
  window: ReturnType<typeof reportWindow>,
): boolean {
  const lineIndex = lines.findIndex((item) => item.start <= start && item.end > start);
  const line = lines[lineIndex];
  if (!line || line.role === 'relative') return false;
  if (line.role === 'unknown' && structuredPath.test(line.text)) return false;
  if (relativePrefix.test(text.slice(line.start, start))) return false;
  if (window.anchor < 0) return true;
  const previous = lines[lineIndex - 1];
  const anchorLine = lines.findIndex(
    (item) => item.start <= window.anchor && item.end > window.anchor,
  );
  const explicitPatient =
    patientPersonStart.test(line.text.slice(0, start - line.start)) ||
    (patientPersonStart.test(subject) &&
      patientPersonStart.test(
        line.text.slice(start - line.start, start - line.start + subject.length),
      )) ||
    /^\s*(?:[\w.-]+\.)?subject\.text\s*:/i.test(line.text) ||
    !!(previous && /^\s*(?:patient|client|subject)(?:\s+name)?\s*:\s*$/i.test(previous.text));
  const unlabelledHeader =
    lineIndex >= anchorLine &&
    lineIndex <= anchorLine + 2 &&
    !patientPersonStart.test(line.text) &&
    !lines.slice(anchorLine, lineIndex).some((item) => patientPersonStart.test(item.text));
  return explicitPatient || unlabelledHeader;
}

/** Bound DOB discovery to the printed patient's nearby header, never another person. */
export function originalSubjectBirthDateEvidence(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): BirthDateEvidence {
  const dates = new Set<string>();
  let unreadable = false;
  const suggestions = new Set<string>();
  if (!text || !subject) return { dates: [], unreadable };
  const window = reportWindow(text, subject, reportAnchor);
  const lines = identityLines(text);
  const referenceDate =
    boundReportDate(text, subject, reportAnchor) || new Date().toISOString().slice(0, 10);
  const readHeader = (start: number): boolean => {
    const subjectLine = lines.findIndex((line) => line.start <= start && line.end > start);
    if (subjectLine < 0 || !patientSubjectPosition(text, lines, start, subject, window))
      return false;
    let evidenceStart = start;
    const structuredParent = /^\s*([\w.-]*\b(?:patient|client|subject))\.name\s*:/i.exec(
      lines[subjectLine]!.text,
    )?.[1];
    if (structuredParent) {
      for (let index = subjectLine - 1; index >= 0; index--) {
        const previous = lines[index]!;
        if (
          previous.start < window.start ||
          previous.text.includes('[identity record boundary]') ||
          !previous.text.trimStart().startsWith(`${structuredParent}.`)
        )
          break;
        if (start - previous.start > headerReach) break;
        evidenceStart = previous.start;
      }
    }
    const limit = Math.min(window.end, start + subject.length + headerReach + valueReach);
    let end = limit;
    for (let index = subjectLine + 1; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.start >= limit) break;
      if (
        line.role === 'relative' ||
        (line.role === 'unknown' &&
          structuredPath.test(line.text) &&
          !/^\s*D\.?O\.?B\.?\s*:/i.test(line.text)) ||
        objectBoundary.test(line.text.trim()) ||
        patientPersonStart.test(line.text) ||
        line.text.includes('[identity record boundary]')
      ) {
        end = line.start;
        break;
      }
    }
    const evidence = labelledBirthDateEvidence(
      text.slice(evidenceStart, end),
      Math.min(end - evidenceStart, start - evidenceStart + subject.length + headerReach),
      referenceDate,
    );
    for (const date of evidence.dates) dates.add(date);
    unreadable ||= evidence.unreadable;
    for (const date of evidence.suggestions || []) suggestions.add(date);
    return evidence.dates.length > 0 || evidence.unreadable;
  };
  let foundAfterAnchor = false;
  for (
    let start = text.indexOf(subject, window.start);
    start >= 0 && start < window.end;
    start = text.indexOf(subject, start + subject.length)
  ) {
    const found = readHeader(start);
    if (window.anchor >= 0 && start >= window.anchor && found) {
      foundAfterAnchor = true;
      break;
    }
  }
  if (window.anchor >= 0 && !foundAfterAnchor && window.start === window.anchor) {
    const banner = text.lastIndexOf(subject, window.anchor - 1);
    const bannerPrefix =
      banner >= 0 ? text.slice(text.lastIndexOf('\n', banner - 1) + 1, banner) : '';
    const between = banner >= 0 ? text.slice(banner + subject.length, window.anchor) : '';
    const interveningReportOrPatient = between
      .split(/\r?\n/)
      .some(
        (line) =>
          (/\breport\b/i.test(line) && !/^\s*[\w.-]+\s*:/.test(line)) ||
          (patientPersonStart.test(line) &&
            (!structuredPath.test(line) ||
              /^\s*(?:[\w.-]+\.)?(?:patient|client|subject)\.name\s*:/i.test(line))),
      );
    const sameStructuredRecord =
      banner >= 0 &&
      /^(?:[\w.-]+\.)?transcript\s*:/i.test(bannerPrefix) &&
      !text.slice(banner, window.anchor).includes('[identity record boundary]') &&
      !interveningReportOrPatient;
    const adjacentPrintedBanner =
      banner >= 0 &&
      window.anchor - banner <= subject.length + headerReach &&
      between
        .split(/\r?\n/)
        .every((line) =>
          /^\s*(?:(?:D\.?O\.?B\.?|date of birth|birth[ -]?date|born)\b.*)?$/i.test(line),
        );
    if (adjacentPrintedBanner || sameStructuredRecord) readHeader(banner);
  }
  return {
    dates: [...dates],
    unreadable,
    ...(suggestions.size ? { suggestions: [...suggestions] } : {}),
  };
}

/** Complete labelled birth dates from the printed patient's nearby header. */
export function originalSubjectBirthDates(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): string[] {
  return originalSubjectBirthDateEvidence(text, subject, reportAnchor).dates;
}

/** An exact name in a subscriber or relative field is not patient-name grounding. */
export function originalSubjectNameGrounded(
  text: string | null,
  subject: string,
  reportAnchor?: string,
): boolean {
  if (!text || !subject) return false;
  const window = reportWindow(text, subject, reportAnchor);
  const lines = identityLines(text);
  for (
    let start = text.indexOf(subject, window.start);
    start >= 0 && start < window.end;
    start = text.indexOf(subject, start + subject.length)
  ) {
    if (patientSubjectPosition(text, lines, start, subject, window)) return true;
  }
  return false;
}
