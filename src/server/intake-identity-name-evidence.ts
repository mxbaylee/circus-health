/** Complete distinct-name evidence without retaining the report's claims in JavaScript. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalIdentityName } from '../shared/self-identity.ts';
import type { IntakeReviewIssue } from '../shared/intake.ts';
import type { BirthDateEvidence } from './intake-evidence-dates.ts';
import { collectEvidencedIdentity, printedIdentityName } from './intake-identity-policy.ts';
import { registerReviewRecordField } from './intake-review-selected-record.ts';

type Claims = () => Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'>>;

/** Scratch preserves first occurrence order and never becomes recovery authority. */
function* names(claims: Claims): Generator<string> {
  const scratch = new DatabaseSync('');
  try {
    scratch.exec('PRAGMA temp_store=FILE; PRAGMA cache_size=-1024');
    scratch.exec('CREATE TABLE names (canonical TEXT PRIMARY KEY, ordinal INTEGER, value TEXT)');
    const insert = scratch.prepare('INSERT OR IGNORE INTO names VALUES(?,?,?)');
    let ordinal = 0;
    for (const issue of claims()) {
      const raw = issue.selfSuggestion?.fullName;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value && printedIdentityName(value) === value)
        insert.run(canonicalIdentityName(value), ordinal++, value);
    }
    for (const row of scratch.prepare('SELECT value FROM names ORDER BY ordinal').iterate())
      yield String(row.value);
  } finally {
    scratch.close();
  }
}

function* canonicalNames(claims: Claims): Generator<string> {
  yield '"';
  let first = true;
  for (const name of names(claims)) {
    if (!first) yield ' / ';
    first = false;
    yield JSON.stringify(name).slice(1, -1);
  }
  yield '"';
}

/** Native consumers retain a repeatable source for the exact complete conflict commitment. */
export function collectSelectedEvidencedIdentity(
  claims: Claims,
  subjectText?: string | null,
  original: BirthDateEvidence = { dates: [], unreadable: false },
): ReturnType<typeof collectEvidencedIdentity> {
  // A printed boundary admits only that one canonical name. The established
  // collector is already bounded in this case, including contradictory hints.
  if (subjectText !== undefined && subjectText !== null)
    return collectEvidencedIdentity(claims(), subjectText, original);
  let first: string | undefined,
    second: string | undefined,
    count = 0,
    bytes = 0,
    inline = '',
    included = true;
  const hash = createHash('sha256').update('"');
  for (const name of names(claims)) {
    first ??= name;
    if (count === 1) second = name;
    const separator = count ? ' / ' : '';
    count++;
    bytes += Buffer.byteLength(separator) + Buffer.byteLength(name);
    hash.update(separator).update(JSON.stringify(name).slice(1, -1));
    if (included && bytes <= 8192) inline += separator + name;
    else {
      included = false;
      inline = '';
    }
  }
  const digest = hash.update('"').digest('hex');
  const result = collectEvidencedIdentity(
    [first, second]
      .filter((value): value is string => value !== undefined)
      .map((fullName) => ({ selfSuggestion: { fullName } })),
    subjectText,
    original,
  );
  const conflict = result.conflicts.find((value) => value.field === 'fullName');
  if (!conflict) return result;
  conflict.evidencedValue = included
    ? inline
    : `${count} distinct name readings. Review the identity questions on the individual records for all names.`;
  if (!included) {
    conflict.evidencedValueReference = {
      format: 'health-intake-name-conflict-v1',
      names: count,
      bytes,
      sha256: digest,
      evidence: 'record_identity_questions',
    };
    registerReviewRecordField(conflict, 'evidencedValue', 'evidencedValueReference', () =>
      canonicalNames(claims),
    );
  }
  return result;
}
