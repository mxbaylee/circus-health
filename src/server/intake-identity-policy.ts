import {
  finishClinicalReviewWork,
  everyClinicalReviewWork,
  findClinicalReviewWork,
  lastClinicalReviewWork,
  someClinicalReviewWork,
} from './clinical-review-work.ts';
import { selectedSequence, type SelectedSequence } from './intake-selected-sequence.ts';
import {
  bannerDatePattern,
  numericDateReadings,
  originalSubjectBirthDateEvidence,
  type BirthDateEvidence,
} from './intake-evidence-dates.ts';
import {
  canonicalIdentityName,
  possiblySameIdentityName,
  savedKnownNames,
  safeSourceIdentityName,
  validOnboardingBirthDate,
} from '../shared/self-identity.ts';
export { canonicalIdentityName } from '../shared/self-identity.ts';
import { createHash } from 'node:crypto';
import { canonicalLiteral } from './intake-format.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import type {
  IntakeClinicalIdentityAttribution,
  IntakeIssueResolution,
  IntakePackageMember,
  IntakeReportGroup,
  IntakeReviewIssue,
  IntakeWorkflow,
} from '../shared/intake.ts';
import type {
  IntakeEvidencedIdentity,
  IntakeIdentityConflict,
  IntakeIdentityConfidence,
  IntakeIdentityReceipt,
  IntakeIdentityReviewStatus,
  IntakeIdentityScope,
  IntakeIdentitySelfSnapshot,
  IntakeIdentityPerson,
  IntakeIdentityWarning,
} from '../shared/intake-identity.ts';

/** Read policy needs complete repeatable collections, not materialized receipt histories. */
export type IdentityPolicyTarget = Omit<IntakeIdentityScope['targets'][number], 'issueIds'> & {
  issueIds?: Iterable<string>;
  /** Complete immutable selected issue index; omitted from canonical evidence. */
  hasIssueId?: (id: string) => boolean;
};
export function identityTargetHasIssue(target: IdentityPolicyTarget, issueId: string): boolean {
  return finishClinicalReviewWork(identityTargetHasIssueWork(target, issueId));
}
export function* identityTargetHasIssueWork(
  target: IdentityPolicyTarget,
  issueId: string,
): Generator<void, boolean, void> {
  if (target.hasIssueId) return target.hasIssueId(issueId);
  return yield* someClinicalReviewWork(target.issueIds || [target.issueId], function* (id) {
    return id === issueId;
  });
}
export type IdentityPolicyTargets =
  IdentityPolicyTarget[] | (SelectedSequence<IdentityPolicyTarget> & { readonly length: number });
export type IdentityPolicyMember = Omit<
  IntakeIdentityScope['membership'][number],
  'occurrences'
> & { occurrences: Iterable<IntakeIdentityScope['membership'][number]['occurrences'][number]> };
export type IdentityPolicyQuestion =
  | NonNullable<IntakeIdentityScope['questions']>[number]
  | { matches(question: NonNullable<IntakeIdentityScope['questions']>[number]): boolean };
export type IdentityPolicyReceipt = Omit<IntakeIdentityReceipt, 'scope' | 'draftIds'> & {
  scope: Omit<IntakeIdentityScope, 'targets' | 'assignmentTargets' | 'membership' | 'questions'> & {
    targets: IdentityPolicyTargets;
    assignmentTargets?: IdentityPolicyTargets;
    membership: Iterable<IdentityPolicyMember>;
    questions?: IdentityPolicyQuestion[] | SelectedSequence<IdentityPolicyQuestion>;
  };
};
export type IdentityGroundingReceipt = Pick<IdentityPolicyReceipt, 'operationId'> & {
  scope: Pick<IntakeIdentityScope, 'scopeToken' | 'profileId'>;
};
export type IdentityPolicyPeople =
  IdentityPolicyPersonSnapshot[] | SelectedSequence<IdentityPolicyPersonSnapshot>;
export interface IdentityPolicyPersonSnapshot extends IntakeIdentityPerson {
  knownNames: string[];
  challengedNames?: string[];
  birthDate: string | null;
}

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');

export type IdentityBoundaryHeader = Pick<
  IntakeReportGroup,
  'id' | 'report' | 'sourceFileId' | 'sourceHash' | 'memberId'
>;

/** Complete-scope traversal; consumers can count or page without collecting all conflicts. */
export function* iterateCompetingIdentityBoundaries<T extends IdentityBoundaryHeader>(
  group: IdentityBoundaryHeader,
  groups: Iterable<T>,
): Generator<T> {
  // Separate model groups are not separate people. A header with no subject,
  // a different subject locator, or self/unknown role tags are not contradictory
  // printed identity. Keep each group's grounding/receipts independent.
  const subject = group.report?.subject?.text.trim();
  if (!group.report?.anchor || !subject) return;
  const claim = (text: string) =>
    canonicalIdentityName(
      text.replace(/^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*/i, ''),
    );
  const currentClaim = claim(subject);
  const anchor = canonicalLiteral(group.report.anchor);
  for (const other of groups)
    if (
      other.id !== group.id &&
      !!other.report?.anchor &&
      !!other.report.subject?.text.trim() &&
      claim(other.report.subject.text.trim()) !== currentClaim &&
      other.sourceFileId === group.sourceFileId &&
      other.sourceHash === group.sourceHash &&
      other.memberId === group.memberId &&
      canonicalLiteral(other.report?.anchor) === anchor
    )
      yield other;
}

export function competingIdentityBoundaries(
  group: IntakeReportGroup,
  groups: Iterable<IntakeReportGroup>,
): IntakeReportGroup[] {
  return Array.from(iterateCompetingIdentityBoundaries(group, groups));
}

/** Compare the complete stable group-ID order without collecting claims.
 * Each current occurrence consumes one receipt occurrence, including repeated
 * IDs and identical claims. Within an ID, retained occurrence order is policy. */
export function identityCompetingClaimsEqual(
  current: Iterable<NonNullable<IntakeIdentityScope['competingSubjects']>[number] | undefined>,
  prior: Iterable<NonNullable<IntakeIdentityScope['competingSubjects']>[number]>,
): boolean {
  return finishClinicalReviewWork(identityCompetingClaimsEqualWork(current, prior));
}
export function* identityCompetingClaimsEqualWork(
  current: Iterable<NonNullable<IntakeIdentityScope['competingSubjects']>[number] | undefined>,
  prior: Iterable<NonNullable<IntakeIdentityScope['competingSubjects']>[number]>,
): Generator<void, boolean, void> {
  const scratch = disposableSqlite('intake-identity-competing-claims-');
  try {
    scratch.db.exec(
      'CREATE TABLE claims(id TEXT,ordinal INTEGER,value TEXT,PRIMARY KEY(id,ordinal))',
    );
    const put = scratch.db.prepare('INSERT INTO claims VALUES(?,?,?)'),
      first = scratch.db.prepare(
        'SELECT ordinal,value FROM claims WHERE id=? ORDER BY ordinal LIMIT 1',
      ),
      remove = scratch.db.prepare('DELETE FROM claims WHERE id=? AND ordinal=?');
    let ordinal = 0,
      previous: string | undefined,
      ordered = true;
    for (const claim of prior) {
      if (previous !== undefined && previous.localeCompare(claim.groupId) > 0) ordered = false;
      previous = claim.groupId;
      put.run(claim.groupId, ordinal++, canonicalLiteral(claim));
      yield;
    }
    for (const claim of current) {
      yield;
      if (!claim) continue;
      if (!ordered) return false;
      const row = first.get(claim.groupId);
      if (!row || row.value !== canonicalLiteral(claim)) return false;
      remove.run(claim.groupId, row.ordinal);
    }
    return ordered && !scratch.db.prepare('SELECT 1 FROM claims LIMIT 1').get();
  } finally {
    scratch.close();
  }
}

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function currentIdentityRefusal(
  issues: Iterable<Pick<IntakeReviewIssue, 'resolution'>>,
): 'unknown' | 'other_person' | undefined {
  let answer: 'unknown' | 'other_person' | undefined;
  for (const issue of issues) {
    if (issue.resolution?.outcome === 'other_person') return 'other_person';
    if (issue.resolution?.outcome === 'unknown') answer = 'unknown';
  }
  return answer;
}

/** Matching words never establish authority without both a human receipt and
 * host verification of this exact current report's retained original page. */
export function repeatedIdentityQuestionReceipt<T extends IdentityPolicyReceipt>(
  ...input: Parameters<typeof repeatedIdentityQuestionReceiptWork<T>>
): T | undefined {
  return finishClinicalReviewWork(repeatedIdentityQuestionReceiptWork<T>(...input));
}
export function* repeatedIdentityQuestionReceiptWork<T extends IdentityPolicyReceipt>({
  issue,
  group,
  receipts,
  profileId,
  intakeId,
  sourceHash,
  originalFingerprint,
  grounded,
  groundedWork,
}: {
  issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor' | 'resolution'>;
  group: IdentityBoundaryHeader;
  receipts?: Iterable<T>;
  profileId: string;
  intakeId: string;
  sourceHash: string;
  originalFingerprint: string;
  grounded: (receipt: T) => boolean;
  groundedWork?: (receipt: T) => Generator<void, boolean, void>;
}): Generator<void, T | undefined, void> {
  const anchor = issue.textAnchor;
  const subject = group.report?.subject?.text;
  if (
    (issue.resolution && issue.resolution.outcome !== 'this_is_me') ||
    !anchor?.trim() ||
    !subject
  )
    return undefined;
  return yield* lastClinicalReviewWork(receipts || [], function* (receipt) {
    return (
      receipt.outcome === 'this_is_me' &&
      receipt.attestation === 'confirmed_displayed_identity_questions' &&
      (receipt.scope.targets.length > 0 || !!receipt.scope.assignmentTargets?.length) &&
      receipt.scope.profileId === profileId &&
      receipt.scope.intakeId === intakeId &&
      receipt.scope.sourceHash === sourceHash &&
      receipt.scope.evidenceOriginalFingerprint === originalFingerprint &&
      receipt.scope.memberId === group.memberId &&
      canonicalIdentityName(receipt.scope.subject.text) === canonicalIdentityName(subject) &&
      (yield* someClinicalReviewWork(receipt.scope.questions || [], function* (question) {
        return 'matches' in question
          ? question.matches({ textAnchor: anchor, prompt: issue.prompt })
          : question.textAnchor === anchor && question.prompt === issue.prompt;
      })) &&
      (groundedWork ? yield* groundedWork(receipt) : grounded(receipt))
    );
  });
}

function compatibleBirthDates(left: string, right: string): boolean {
  const short = left.length <= right.length ? left : right;
  const long = left.length <= right.length ? right : left;
  return long === short || long.startsWith(short + '-');
}

function validModelBirthDate(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return validOnboardingBirthDate(value);
  if (/^\d{4}$/.test(value))
    return Number(value) > 0 && value <= new Date().toISOString().slice(0, 4);
  if (!/^\d{4}-\d{2}$/.test(value)) return false;
  const [year, month] = value.split('-').map(Number);
  return year > 0 && month >= 1 && month <= 12 && value <= new Date().toISOString().slice(0, 7);
}

/** Compare a model-only DOB suggestion with the person finally assigned to a record.
 * Original DOB evidence and printed uncertainty are handled by the blocking policy instead. */
export function modelBirthDateWarnings({
  issues,
  originalBirthDate,
  unreadableBirthDate,
  person,
}: {
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'>>;
  originalBirthDate?: string;
  unreadableBirthDate: boolean;
  person?: Pick<IntakeIdentityPerson, 'fullName' | 'birthDate'>;
}): IntakeIdentityWarning[] {
  const savedBirthDate = clean(person?.birthDate);
  if (originalBirthDate || unreadableBirthDate || !savedBirthDate || !person) return [];
  const warnings: IntakeIdentityWarning[] = [];
  for (const warning of modelBirthDateWarningCandidates({
    issues,
    originalBirthDate,
    unreadableBirthDate,
    person,
  })) {
    if (!warnings.some((prior) => prior.modelBirthDate === warning.modelBirthDate))
      warnings.push(warning);
  }
  return warnings;
}

/** Complete warning candidates; the selected policy sink deduplicates on disk. */
export function* modelBirthDateWarningCandidates(
  ...input: Parameters<typeof modelBirthDateWarningCandidatesWork>
): Generator<IntakeIdentityWarning> {
  for (const warning of modelBirthDateWarningCandidatesWork(...input)) if (warning) yield warning;
}
export function* modelBirthDateWarningCandidatesWork({
  issues,
  originalBirthDate,
  unreadableBirthDate,
  person,
}: Omit<Parameters<typeof modelBirthDateWarnings>[0], 'issues'> & {
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'> | undefined>;
}): Generator<IntakeIdentityWarning | undefined> {
  const savedBirthDate = clean(person?.birthDate);
  if (originalBirthDate || unreadableBirthDate || !savedBirthDate || !person) return;
  for (const issue of issues) {
    yield undefined;
    const modelBirthDate = clean(issue?.selfSuggestion?.birthDate);
    if (
      !modelBirthDate ||
      !validModelBirthDate(modelBirthDate) ||
      compatibleBirthDates(modelBirthDate, savedBirthDate)
    )
      continue;
    yield {
      kind: 'model_birth_date_mismatch',
      modelBirthDate,
      savedBirthDate,
      personName: person.fullName,
    };
  }
}

export function identityOriginalFingerprint(
  intakeId: string,
  sourceHash: string,
  group: IntakeReportGroup,
  workflow: Pick<IntakeWorkflow, 'plans'>,
): string {
  let member: IntakePackageMember | undefined;
  if (group.memberId)
    for (const plan of workflow.plans) {
      member = plan.index.members?.find((candidate) => candidate.memberId === group.memberId);
      if (member) break;
    }
  return identityOriginalFingerprintForMember(intakeId, sourceHash, group.memberId, member);
}

/** The member must come from a checked complete inventory lookup, including absence. */
export function identityOriginalFingerprintForMember(
  intakeId: string,
  sourceHash: string,
  memberId: string | null,
  member: Pick<IntakePackageMember, 'locator' | 'sourceHash'> | undefined,
): string {
  if (!memberId) return hash(['intake-original', intakeId, sourceHash]);
  return hash([
    'intake-member-original',
    intakeId,
    memberId,
    member?.locator || null,
    member?.sourceHash || null,
  ]);
}

export function identityPersonFingerprint(
  originalFingerprint: string,
  evidence: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>,
  subjectText: string | null,
): string | undefined {
  const fullName = clean(evidence.fullName);
  const birthDate = clean(evidence.birthDate);
  const subject = clean(subjectText);
  if (!fullName && !birthDate && !subject) return undefined;
  // Canonical supported facts identify the person across differently formatted
  // report headings. With no structured facts, retain the exact printed subject
  // as a conservative fallback rather than trusting a display label.
  return hash([
    originalFingerprint,
    fullName || birthDate ? 'supported-facts' : 'printed-subject',
    fullName ? canonicalIdentityName(fullName) : null,
    birthDate,
    !fullName && !birthDate && subject ? canonicalIdentityName(subject) : null,
  ]);
}

/** Conservative extraction of a name field, never an entire demographic sentence. */
export function printedIdentityName(subject: string | null | undefined): string | undefined {
  if (!subject) return;
  const text = subject.trim();
  // A later labelled subject must not disappear when the first DOB is split off.
  // Keep multi-person headers for explicit scoped human review.
  if ((text.match(/\b(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:/gi) || []).length > 1)
    return;
  const labeled =
    /^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*([^\n;|]+)(?:[\n;|]|$)/i.exec(text);
  let name = (labeled?.[1] || text).trim();
  // A name column followed by an explicit sex column and numeric date is a
  // demographic header, not a name containing measurements or dates.
  const columns = /^(.*?)\s{2,}(?:Female|Male)\s{2,}\d{1,4}[/-]\d{1,2}[/-]\d{1,4}(.*)$/i.exec(name);
  if (columns && /^(?:\s+(?:\d+(?:[./:-]\d+)*|in\.?|lbs\.?|cm|kg|ft\.?))*\s*$/i.test(columns[2]!))
    name = columns[1]!.trim();
  if (labeled) {
    const dateSentence =
      /^(.*?)\.\s+(?:DOB|date of birth|birth\s*date)\s*:\s*(\d{4}-\d{2}-\d{2})\.?$/i.exec(name);
    // A complete labelled date can delimit a sentence. Keep initials and suffixes
    // literal: their terminal period is meaningful and is not a safe delimiter.
    const terminal = dateSentence?.[1]?.match(/(?:^|\s)([\p{L}\p{M}’'-]+)$/u)?.[1];
    if (
      terminal &&
      validOnboardingBirthDate(dateSentence![2]) &&
      [...terminal].length >= 3 &&
      !/^(?:jr|sr|ii|iii|iv|esq|phd)$/i.test(terminal) &&
      !/[\p{Lu}]/u.test([...terminal].slice(1).join(''))
    )
      name = dateSentence![1]!.trim();
    else
      name = name.split(/\s+(?:DOB|date of birth|birth\s*date|MRN|patient\s*ID)\s*:/i)[0]!.trim();
  }
  if (
    !name ||
    name.length > 200 ||
    !/^[\p{L}\p{M} ,.’'-]+$/u.test(name) ||
    /^patient(?:\s|$)/i.test(name) ||
    /\b(?:unknown|unidentified|name|dob|report|results?|born|for|and|or)\b/i.test(name) ||
    name.split(',').length > 2
  )
    return;
  return name;
}

/** Only routine model ownership questions can defer to independently grounded
 * exact-name matching. Human answers and questions about specific uncertainty
 * remain separate review work. This never normalizes an ambiguous printed DOB. */
export function isGenericNameConfirmation(
  ...input: Parameters<typeof isGenericNameConfirmationWork>
): boolean {
  return finishClinicalReviewWork(isGenericNameConfirmationWork(...input));
}
export function* isGenericNameConfirmationWork(
  issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor' | 'field' | 'questionId' | 'resolution'>,
  subjectText: string | undefined,
  self: IntakeIdentitySelfSnapshot,
  people: Iterable<IdentityPolicyPersonSnapshot>,
): Generator<void, boolean, void> {
  if (issue.field !== 'subject' || issue.resolution || !issue.textAnchor) return false;
  const name = printedIdentityName(subjectText);
  const anchorName = printedIdentityName(issue.textAnchor);
  if (!name || !anchorName || canonicalIdentityName(name) !== canonicalIdentityName(anchorName))
    return false;
  const prompt =
    /^Does (?:this|the) (?:report|record|result)(?: for (.+?))? belong to you(?: or another person)?\?$/i.exec(
      issue.prompt.trim(),
    );
  const routineConfirmation =
    /^(?:Confirm (?:that )?(?:the displayed |this |the )?report subject is Self(?: before saving(?: (?:its )?records)?).?|Does this record belong to you?)$/i.test(
      issue.prompt.trim(),
    );
  if (!prompt && !routineConfirmation) return false;
  let promptName = prompt?.[1]?.replace(/,\s*$/, '').trim();
  const dateClaim =
    promptName &&
    /,?\s+(?:birth date|date of birth|DOB)\s*:?\s*(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})$/i.exec(
      promptName,
    );
  if (dateClaim) promptName = promptName!.slice(0, dateClaim.index).replace(/,\s*$/, '').trim();
  if (promptName && canonicalIdentityName(promptName) !== canonicalIdentityName(name)) return false;
  const labelledAnchorDate =
    /\b(?:DOB|birth date|date of birth)\s*:?\s*(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})/i.exec(
      issue.textAnchor,
    )?.[1];
  const bannerDate = bannerDatePattern.exec(issue.textAnchor)?.[1];
  const anchorDate = labelledAnchorDate || bannerDate;
  const rawDate = dateClaim?.[1] || anchorDate;
  if (
    dateClaim &&
    (!issue.textAnchor.includes(dateClaim[1]!) || (anchorDate && anchorDate !== dateClaim[1]))
  )
    return false;
  if (!rawDate) return true;
  // Model phrasing must not change an unlabelled original's compatibility.
  // Only banners share the original reader's short-year readings; labelled
  // DOBs still need interpretation and cannot take this permissive path.
  const alternatives = numericDateReadings(rawDate, !labelledAnchorDate && !!bannerDate);
  if (!alternatives.length) return false;
  const owners = selectedSequence(function* () {
    yield { fullName: self.fullName, knownNames: self.knownNames, birthDate: self.birthDate };
    yield* people;
  });
  let matching:
    { fullName: string | null; knownNames: unknown; birthDate: string | null } | undefined;
  for (const owner of owners) {
    yield;
    let found = false;
    for (const saved of [owner.fullName, ...savedKnownNames(owner.knownNames)]) {
      yield;
      if (saved && canonicalIdentityName(saved) === canonicalIdentityName(name)) {
        found = true;
        break;
      }
    }
    if (!found) continue;
    if (matching) return false;
    matching = owner;
  }
  // An unlabelled demographic date cannot strengthen a name-only match or
  // become DOB evidence. Retain the ownership question when none of its
  // readings fit the saved person; one compatible reading leaves that match
  // unchanged. Labelled DOB ambiguity still requires its own review.
  const matchedBirthDate = matching?.birthDate;
  return (
    matching !== undefined &&
    (!matchedBirthDate ||
      (labelledAnchorDate
        ? alternatives.every((date) => compatibleBirthDates(date, matchedBirthDate))
        : alternatives.some((date) => compatibleBirthDates(date, matchedBirthDate))))
  );
}

/** Structured hints contribute a name only when every distinct reading agrees. */
export function structuredEvidencedIdentity(
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'>>,
): IntakeEvidencedIdentity {
  return finishClinicalReviewWork(structuredEvidencedIdentityWork(issues));
}
export function* structuredEvidencedIdentityWork(
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'> | undefined>,
): Generator<void, IntakeEvidencedIdentity, void> {
  let firstName: string | undefined;
  let firstCanonical: string | undefined;
  let ambiguous = false;
  for (const issue of issues) {
    yield;
    if (!issue) continue;
    const name = clean(issue.selfSuggestion?.fullName);
    if (!name || printedIdentityName(name) !== name) continue;
    const canonical = canonicalIdentityName(name);
    if (firstName === undefined) {
      firstName = name;
      firstCanonical = canonical;
    } else if (canonical !== firstCanonical) ambiguous = true;
  }
  return firstName && !ambiguous ? { fullName: firstName } : {};
}

export function collectEvidencedIdentity(
  ...input: Parameters<typeof collectEvidencedIdentityWork>
): ReturnType<typeof collectEvidencedIdentityWork> extends Generator<void, infer T, void>
  ? T
  : never {
  return finishClinicalReviewWork(collectEvidencedIdentityWork(...input));
}
export function* collectEvidencedIdentityWork(
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'> | undefined>,
  subjectText?: string | null,
  original: BirthDateEvidence = { dates: [], unreadable: false },
): Generator<
  void,
  {
    evidence: IntakeEvidencedIdentity;
    conflicts: IntakeIdentityConflict[];
    /** A printed birth-date label whose value is not one complete date. */
    unreadableBirthDate: boolean;
    /** Readings of each unlabelled banner date; review clues, never evidence. */
    bannerBirthDates: string[][];
  },
  void
> {
  const names: string[] = [];
  const hasSubjectBoundary = subjectText !== undefined && subjectText !== null;
  const printedBoundaryName = printedIdentityName(subjectText);
  let contradictoryNameSuggestion = false;
  const subject = printedIdentityName(subjectText)
    ? originalSubjectBirthDateEvidence(subjectText!, subjectText!)
    : { dates: [], unreadable: false };
  const unreadableBirthDate = original.unreadable || subject.unreadable;
  const dates: string[] = [...new Set([...original.dates, ...subject.dates])];
  const bannerBirthDates = new Map(
    [...(original.bannerDates || []), ...(subject.bannerDates || [])].map((readings) => [
      readings.join('|'),
      readings,
    ]),
  );
  for (const issue of issues) {
    yield;
    if (!issue) continue;
    const name = clean(issue.selfSuggestion?.fullName);
    if (
      name &&
      printedIdentityName(name) === name &&
      hasSubjectBoundary &&
      (!printedBoundaryName ||
        canonicalIdentityName(name) !== canonicalIdentityName(printedBoundaryName))
    ) {
      contradictoryNameSuggestion = true;
      continue;
    }
    if (
      name &&
      printedIdentityName(name) === name &&
      !names.some((value) => canonicalIdentityName(value) === canonicalIdentityName(name))
    )
      names.push(name);
    // A model-provided date is not original evidence. Printed uncertainty is
    // reviewed with a host-derived suggestion; arbitrary model disagreement
    // does not create a second birth-date decision.
  }
  if ((names.length || contradictoryNameSuggestion) && hasSubjectBoundary) {
    const printed = printedIdentityName(subjectText);
    if (
      !printed ||
      contradictoryNameSuggestion ||
      names.some((name) => canonicalIdentityName(name) !== canonicalIdentityName(printed))
    ) {
      // A literal name elsewhere in a multi-person subject is not the patient.
      // Leave exact name selection to the displayed confirmation instead of
      // retaining a relative's name or offering their demographics as Self.
      names.length = 0;
      dates.length = 0;
      bannerBirthDates.clear();
    }
  } else if (!names.length) {
    const printed = printedIdentityName(subjectText);
    if (printed) names.push(printed);
  }
  const conflicts: IntakeIdentityConflict[] = [];
  if (names.length > 1)
    conflicts.push({
      field: 'fullName',
      selfValue: null,
      evidencedValue: names.join(' / '),
      reason: 'evidence_disagreement',
    });
  if (dates.some((value) => !compatibleBirthDates(dates[0]!, value)))
    conflicts.push({
      field: 'birthDate',
      selfValue: null,
      evidencedValue: dates.join(' / '),
      reason: 'evidence_disagreement',
    });
  const birthDate = dates.sort((left, right) => right.length - left.length)[0];
  return {
    evidence: {
      ...(names.length === 1 ? { fullName: names[0] } : {}),
      ...(birthDate && !conflicts.some((conflict) => conflict.field === 'birthDate')
        ? { birthDate }
        : {}),
    },
    conflicts,
    unreadableBirthDate,
    // A labelled or unreadable birth date is the header's own answer.
    bannerBirthDates: dates.length || unreadableBirthDate ? [] : [...bannerBirthDates.values()],
  };
}

export interface IdentityPolicyAssessment {
  selfBirthDateConflict?: boolean;
  defaultPerson?: 'self' | 'new';
  confidence: IntakeIdentityConfidence;
  status: IntakeIdentityReviewStatus;
  blocking: boolean;
  message: string;
  challengedName?: string;
  evidencedIdentity: IntakeEvidencedIdentity;
  offeredSelfFields: Pick<IntakeEvidencedIdentity, 'fullName' | 'birthDate'>;
  conflicts: IntakeIdentityConflict[];
  attribution?: IntakeClinicalIdentityAttribution;
}

export interface ExplicitIdentityResolutionOccurrence {
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  issueIds: Iterable<string>;
  resolutions: Iterable<IntakeIssueResolution>;
  latestResolution?: (issueId: string) => IntakeIssueResolution | undefined;
}

export interface CurrentIdentityReceiptBoundary {
  profileId?: string;
  intakeId: string;
  groupId: string;
  groupVersionId: string;
  sourceHash: string;
  memberId: string | null;
  original?: IntakeIdentityScope['original'];
  report: IntakeIdentityScope['report'];
  subject: IntakeIdentityScope['subject'];
  verificationMode?: IntakeIdentityScope['verificationMode'];
  evidencedIdentity?: IntakeEvidencedIdentity;
  evidenceOriginalFingerprint: string | null;
  membership: IntakeIdentityScope['membership'] | SelectedIdentityMembership;
}

/** A complete selected report snapshot, never a presentation page. */
export interface SelectedIdentityMembership {
  retains(prior: Iterable<IdentityPolicyMember>): boolean;
  retainsWork?(prior: Iterable<IdentityPolicyMember>): Generator<void, boolean, void>;
}

function identityEvidenceCompatible(
  prior: IntakeEvidencedIdentity | undefined,
  current: IntakeEvidencedIdentity | undefined,
): boolean {
  const priorName = clean(prior?.fullName),
    currentName = clean(current?.fullName),
    priorBirthDate = clean(prior?.birthDate),
    currentBirthDate = clean(current?.birthDate);
  const sameName =
    !!priorName &&
    !!currentName &&
    canonicalIdentityName(priorName) === canonicalIdentityName(currentName);
  const sameBirthDate =
    !!priorBirthDate &&
    !!currentBirthDate &&
    compatibleBirthDates(priorBirthDate, currentBirthDate);
  if (
    (priorName && currentName && !sameName) ||
    (priorBirthDate && currentBirthDate && !sameBirthDate)
  )
    return false;
  const priorStructured = !!priorName || !!priorBirthDate;
  const currentStructured = !!currentName || !!currentBirthDate;
  // Do not bridge two disjoint supported identities merely because their report
  // headings share a display name. One side with no structured facts may still
  // use the exact retained original and printed-subject boundary below.
  return !priorStructured || !currentStructured || sameName || sameBirthDate;
}

function* receiptMembershipIsRetainedWork(
  prior: Iterable<IdentityPolicyMember>,
  current: IntakeIdentityScope['membership'] | SelectedIdentityMembership,
): Generator<void, boolean, void> {
  if (!Array.isArray(current))
    return current.retainsWork ? yield* current.retainsWork(prior) : current.retains(prior);
  return yield* everyClinicalReviewWork(prior, function* (priorMember) {
    const currentMember = yield* findClinicalReviewWork(current, function* (member) {
      return (
        member.candidateId === priorMember.candidateId &&
        member.candidateVersionId === priorMember.candidateVersionId
      );
    });
    return (
      !!currentMember &&
      canonicalLiteral(currentMember.section || null) ===
        canonicalLiteral(priorMember.section || null) &&
      (yield* everyClinicalReviewWork(priorMember.occurrences, function* (priorOccurrence) {
        return yield* someClinicalReviewWork(currentMember.occurrences, function* (occurrence) {
          return canonicalLiteral(occurrence) === canonicalLiteral(priorOccurrence);
        });
      }))
    );
  });
}

/**
 * An exact issue receipt remains authoritative when a cumulative report version
 * only adds members or occurrences. The caller still has to prove that the
 * receipt contains the exact current candidate/version/record/issue target.
 */
export function identityReceiptAppliesToCurrentBoundary(
  ...input: Parameters<typeof identityReceiptAppliesToCurrentBoundaryWork>
): boolean {
  return finishClinicalReviewWork(identityReceiptAppliesToCurrentBoundaryWork(...input));
}
export function* identityReceiptAppliesToCurrentBoundaryWork(
  receipt: IdentityPolicyReceipt,
  current: CurrentIdentityReceiptBoundary,
): Generator<void, boolean, void> {
  const prior = receipt.scope;
  // Do not compare groupVersionId directly: retained membership below is the
  // semantic proof that a newer cumulative version only extended the report.
  return (
    (!current.profileId || prior.profileId === current.profileId) &&
    prior.intakeId === current.intakeId &&
    prior.groupId === current.groupId &&
    prior.sourceHash === current.sourceHash &&
    prior.memberId === current.memberId &&
    prior.evidenceOriginalFingerprint === current.evidenceOriginalFingerprint &&
    canonicalLiteral(prior.report) === canonicalLiteral(current.report) &&
    canonicalLiteral(prior.subject) === canonicalLiteral(current.subject) &&
    (!current.original ||
      canonicalLiteral(prior.original) === canonicalLiteral(current.original)) &&
    (!current.verificationMode || prior.verificationMode === current.verificationMode) &&
    identityEvidenceCompatible(prior.evidencedIdentity, current.evidencedIdentity) &&
    (yield* receiptMembershipIsRetainedWork(prior.membership, current.membership))
  );
}

/**
 * Every current explicit issue needs its own latest draft answer and the exact
 * receipt target that wrote it. Separate later questions may therefore be
 * confirmed separately without allowing an older operation to cover them.
 */
/** A family assignment is exact per retained candidate occurrence, never inferred from a name. */
export function confirmedPersonReceipt<T extends IdentityPolicyReceipt>(
  ...input: Parameters<typeof confirmedPersonReceiptWork<T>>
): T | undefined {
  return finishClinicalReviewWork(confirmedPersonReceiptWork<T>(...input));
}
export function* confirmedPersonReceiptWork<T extends IdentityPolicyReceipt>({
  receipts,
  boundary,
  candidateId,
  candidateVersionId,
  proposalId,
  recordId,
  resolutions,
  latestResolution,
  requiredIssueIds,
}: {
  receipts?: Iterable<T>;
  boundary: CurrentIdentityReceiptBoundary;
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  resolutions: Iterable<IntakeIssueResolution>;
  latestResolution?: (issueId: string) => IntakeIssueResolution | undefined;
  requiredIssueIds: Iterable<string>;
}): Generator<void, T | undefined, void> {
  return yield* lastClinicalReviewWork(receipts || [], function* (receipt) {
    if (
      receipt.outcome !== 'this_is_person' ||
      !receipt.assignedPerson ||
      !(yield* identityReceiptAppliesToCurrentBoundaryWork(receipt, boundary))
    )
      return false;
    const target = yield* findClinicalReviewWork(
      receipt.scope.assignmentTargets || receipt.scope.targets,
      function* (item) {
        return (
          item.candidateId === candidateId &&
          item.candidateVersionId === candidateVersionId &&
          item.proposalId === proposalId &&
          item.recordId === recordId
        );
      },
    );
    return (
      !!target &&
      (yield* everyClinicalReviewWork(requiredIssueIds, function* (issueId) {
        return yield* identityTargetHasIssueWork(target, issueId);
      })) &&
      (yield* everyClinicalReviewWork(target.issueIds || [target.issueId], function* (issueId) {
        const answer = latestResolution
          ? latestResolution(issueId)
          : yield* lastClinicalReviewWork(resolutions, function* (item) {
              return item.issueId === issueId;
            });
        return answer?.operationId === receipt.operationId && answer.outcome === 'other_person';
      }))
    );
  });
}

export function exactCurrentIdentityResolutionOperationId<T extends IdentityPolicyReceipt>(
  ...input: Parameters<typeof exactCurrentIdentityResolutionOperationIdWork<T>>
): string | undefined {
  return finishClinicalReviewWork(exactCurrentIdentityResolutionOperationIdWork<T>(...input));
}
export function* exactCurrentIdentityResolutionOperationIdWork<T extends IdentityPolicyReceipt>({
  receipts,
  occurrences,
  receiptApplies = () => true,
  receiptAppliesWork,
}: {
  receipts?: Iterable<T>;
  occurrences: Iterable<ExplicitIdentityResolutionOccurrence>;
  receiptApplies?: (receipt: T) => boolean;
  receiptAppliesWork?: (receipt: T) => Generator<void, boolean, void>;
}): Generator<void, string | undefined, void> {
  let anyOccurrence = false,
    latestReceiptIndex = -1;
  let latestOperationId: string | undefined;
  for (const occurrence of occurrences) {
    yield;
    anyOccurrence = true;
    let anyIssue = false;
    for (const issueId of occurrence.issueIds) {
      yield;
      anyIssue = true;
      const resolution = occurrence.latestResolution
        ? occurrence.latestResolution(issueId)
        : yield* lastClinicalReviewWork(occurrence.resolutions, function* (item) {
            return item.issueId === issueId;
          });
      if (resolution?.outcome !== 'this_is_me' || !resolution.operationId) return undefined;
      let receiptIndex = -1,
        index = -1;
      for (const receipt of receipts || []) {
        yield;
        index++;
        if (
          receipt.operationId !== resolution.operationId ||
          !(receiptAppliesWork ? yield* receiptAppliesWork(receipt) : receiptApplies(receipt))
        )
          continue;
        const target = yield* findClinicalReviewWork(
          receipt.scope.assignmentTargets || receipt.scope.targets,
          function* (item) {
            return (
              item.candidateId === occurrence.candidateId &&
              item.candidateVersionId === occurrence.candidateVersionId &&
              item.proposalId === occurrence.proposalId &&
              item.recordId === occurrence.recordId
            );
          },
        );
        if (target && (yield* identityTargetHasIssueWork(target, issueId))) receiptIndex = index;
      }
      if (receiptIndex < 0) return undefined;
      if (receiptIndex > latestReceiptIndex) {
        latestReceiptIndex = receiptIndex;
        latestOperationId = resolution.operationId;
      }
    }
    if (!anyIssue) return undefined;
  }
  return anyOccurrence ? latestOperationId : undefined;
}

function* receiptForWork(
  receipts: Iterable<IdentityPolicyReceipt> | undefined,
  groupId: string,
  groupVersionId: string,
  personFingerprint: string | undefined,
  originalFingerprint: string,
  evidence: IntakeEvidencedIdentity,
  subjectText: string | null,
  operationId?: string,
): Generator<void, IdentityPolicyReceipt | undefined, void> {
  const subject = clean(subjectText);
  const exactGroup = yield* lastClinicalReviewWork(receipts || [], function* (receipt) {
    return (
      (!operationId || receipt.operationId === operationId) &&
      receipt.scope.groupId === groupId &&
      receipt.scope.groupVersionId === groupVersionId
    );
  });
  if (exactGroup) return exactGroup;
  return yield* lastClinicalReviewWork(receipts || [], function* (receipt) {
    if (operationId && receipt.operationId !== operationId) return false;
    if (
      personFingerprint &&
      receipt.scope.evidencedIdentity?.personFingerprint === personFingerprint
    )
      return true;
    // A later proposal may omit a structured name/DOB that the earlier one
    // supplied. The printed subject on the same retained original can bridge
    // that omission, but never a contradictory structured fact.
    const prior = receipt.scope.evidencedIdentity || {};
    const priorName = clean(prior.fullName);
    const currentName = clean(evidence.fullName);
    const priorBirthDate = clean(prior.birthDate);
    const currentBirthDate = clean(evidence.birthDate);
    return (
      receipt.scope.evidenceOriginalFingerprint === originalFingerprint &&
      !!subject &&
      !!clean(receipt.scope.subject?.text) &&
      canonicalIdentityName(receipt.scope.subject.text) === canonicalIdentityName(subject) &&
      !(
        priorName &&
        currentName &&
        canonicalIdentityName(priorName) !== canonicalIdentityName(currentName)
      ) &&
      !(
        priorBirthDate &&
        currentBirthDate &&
        !compatibleBirthDates(priorBirthDate, currentBirthDate)
      )
    );
  });
}

export function assessIdentityPolicy(
  ...input: Parameters<typeof assessIdentityPolicyWork>
): IdentityPolicyAssessment {
  return finishClinicalReviewWork(assessIdentityPolicyWork(...input));
}
export function* assessIdentityPolicyWork({
  self,
  people = [],
  evidence,
  evidenceConflicts = [],
  group,
  groupVersionId,
  originalFingerprint,
  receipts,
  hasUnstructuredIdentityQuestion,
  explicitlyConfirmedOperationId,
  currentRefusal,
  nameEvidenceGrounded = true,
  originalEvidenceChecked = true,
  unreadableBirthDate = false,
  bannerBirthDates = [],
}: {
  self: IntakeIdentitySelfSnapshot;
  people?: Iterable<IdentityPolicyPersonSnapshot>;
  evidence: IntakeEvidencedIdentity;
  evidenceConflicts?: IntakeIdentityConflict[];
  group: IdentityBoundaryHeader | null;
  groupVersionId: string | null;
  originalFingerprint: string | null;
  receipts?: Iterable<IdentityPolicyReceipt>;
  hasUnstructuredIdentityQuestion?: boolean;
  explicitlyConfirmedOperationId?: string;
  currentRefusal?: 'unknown' | 'other_person';
  nameEvidenceGrounded?: boolean;
  originalEvidenceChecked?: boolean;
  /** A printed birth-date label is present but its value is not one complete date. */
  unreadableBirthDate?: boolean;
  /** Readings of each unlabelled banner date (name, sex, date columns), never DOB evidence. */
  bannerBirthDates?: string[][];
}): Generator<void, IdentityPolicyAssessment, void> {
  const fullName = clean(evidence.fullName);
  const birthDate = clean(evidence.birthDate);
  const personFingerprint =
    originalFingerprint && group
      ? identityPersonFingerprint(
          originalFingerprint,
          evidence,
          group.report?.subject?.text || null,
        )
      : undefined;
  const evidencedIdentity: IntakeEvidencedIdentity = {
    ...(fullName ? { fullName } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(personFingerprint ? { personFingerprint } : {}),
  };
  const conflicts = evidenceConflicts.filter(
    (conflict) => conflict.field !== 'birthDate' || conflict.reason !== 'evidence_disagreement',
  );
  unreadableBirthDate ||= evidenceConflicts.some(
    (conflict) => conflict.field === 'birthDate' && conflict.reason === 'evidence_disagreement',
  );
  const selfName = clean(self.fullName);
  const selfBirthDate = clean(self.birthDate);
  const selfNames = [
    selfName,
    ...savedKnownNames(self.knownNames).filter(safeSourceIdentityName),
  ].filter((name): name is string => !!name);
  const selfOwner = {
    personId: 'patient',
    names: selfNames,
    birthDate: selfBirthDate,
    person: undefined as IdentityPolicyPersonSnapshot | undefined,
  };
  const owners = selectedSequence(function* () {
    yield selfOwner;
    for (const person of people)
      if (person.personId !== 'patient')
        yield {
          personId: person.personId,
          names: [person.fullName, ...person.knownNames.filter(safeSourceIdentityName)].filter(
            Boolean,
          ),
          birthDate: clean(person.birthDate),
          person,
        };
  });
  const futureOwner = fullName
    ? self.futureNameOwners?.find(
        (decision) => canonicalIdentityName(decision.name) === canonicalIdentityName(fullName),
      )?.personId
    : undefined;
  let uniqueOwner: typeof selfOwner | undefined,
    ownerMatchCount: 0 | 1 | 2 = 0;
  for (const owner of owners) {
    yield;
    if (
      !fullName ||
      !owner.names.some((name) => canonicalIdentityName(name) === canonicalIdentityName(fullName))
    )
      continue;
    if (futureOwner && owner.personId !== futureOwner) continue;
    if (!uniqueOwner) {
      uniqueOwner = owner;
      ownerMatchCount = 1;
    } else if (uniqueOwner.personId === owner.personId) uniqueOwner = owner;
    else ownerMatchCount = 2; // Two means ambiguity, never a displayed completeness count.
  }
  const generationalName = (name: string): { base: string; suffix: string | null } => {
    const printed = name.normalize('NFKC').trim();
    const surnameFirst = printed.match(/^([^,]+),\s*(.+?)\s+(jr\.?|sr\.?|ii|iii|iv)\.?$/iu);
    const ordered = surnameFirst
      ? `${surnameFirst[2]} ${surnameFirst[1]} ${surnameFirst[3]}`
      : printed;
    const canonical = canonicalIdentityName(ordered);
    const match = canonical.match(/^(.*?)\s+(jr|sr|ii|iii|iv)\.?$/u);
    return match ? { base: match[1]!, suffix: match[2]! } : { base: canonical, suffix: null };
  };
  const printedName = fullName ? generationalName(fullName) : null;
  const suffixAmbiguity =
    !!printedName &&
    !printedName.suffix &&
    ownerMatchCount === 1 &&
    (yield* someClinicalReviewWork(owners, function* (owner) {
      return (
        owner.personId !== uniqueOwner!.personId &&
        owner.names.some((name) => {
          const saved = generationalName(name);
          return !!saved.suffix && saved.base === printedName.base;
        })
      );
    }));
  const challengedName =
    !!fullName &&
    (yield* someClinicalReviewWork(
      (function* () {
        yield self;
        yield* people;
      })(),
      function* (owner) {
        return !!owner.challengedNames?.some(
          (name) => canonicalIdentityName(name) === canonicalIdentityName(fullName),
        );
      },
    ));
  const matchedOwner = ownerMatchCount === 1 ? uniqueOwner : undefined;
  const bannerIncompatibleWith = (owner: typeof selfOwner | undefined): boolean =>
    !!owner?.birthDate &&
    bannerBirthDates.some(
      (readings) => !readings.some((date) => compatibleBirthDates(date, owner.birthDate!)),
    );
  const incompatibleBanner = bannerIncompatibleWith(matchedOwner);
  const savedNames = matchedOwner?.names || selfNames;
  const matchedBirthDate = matchedOwner ? matchedOwner.birthDate : selfBirthDate;
  const nameMatches = !!matchedOwner;
  const possibleName =
    !!fullName &&
    !nameMatches &&
    (yield* someClinicalReviewWork(owners, function* (owner) {
      return owner.names.some((name) => possiblySameIdentityName(fullName, name));
    }));
  const birthDateMatches =
    !!birthDate && !!matchedBirthDate && compatibleBirthDates(birthDate, matchedBirthDate);
  if (fullName && savedNames.length && !nameMatches && !possibleName)
    conflicts.push({
      field: 'fullName',
      selfValue: selfName,
      evidencedValue: fullName,
      reason: 'self_mismatch',
    });
  if (birthDate && matchedBirthDate && !compatibleBirthDates(birthDate, matchedBirthDate))
    conflicts.push({
      field: 'birthDate',
      selfValue: matchedBirthDate,
      evidencedValue: birthDate,
      reason: 'self_mismatch',
    });
  const offeredSelfFields = {
    ...(fullName && !selfName ? { fullName } : {}),
    ...(birthDate && !selfBirthDate ? { birthDate } : {}),
  };
  const confidence: IntakeIdentityConfidence = conflicts.length
    ? 'none'
    : possibleName
      ? 'possible'
      : nameMatches &&
          birthDateMatches &&
          !unreadableBirthDate &&
          birthDate?.length === 10 &&
          matchedBirthDate?.length === 10
        ? 'strong'
        : nameMatches || birthDateMatches
          ? 'limited'
          : 'none';
  const selfBirthDateConflict =
    !!birthDate && !!selfBirthDate && !compatibleBirthDates(birthDate, selfBirthDate);
  const defaultPerson = selfBirthDateConflict ? ('new' as const) : ('self' as const);
  const common = {
    evidencedIdentity,
    offeredSelfFields,
    conflicts,
    confidence,
    selfBirthDateConflict,
    defaultPerson,
    ...(challengedName ? { challengedName: fullName! } : {}),
  };
  if (currentRefusal)
    return {
      ...common,
      confidence: 'none',
      status: currentRefusal === 'other_person' ? 'conflict' : 'confirmation_required',
      blocking: true,
      message:
        currentRefusal === 'other_person'
          ? 'A current identity answer attributes this record to another person. Resolve that answer before saving into Self.'
          : 'A current identity answer is unknown. Review that answer before saving this record into Self.',
    };
  const latestPersonChoice =
    group && groupVersionId
      ? yield* receiptForWork(
          receipts,
          group.id,
          groupVersionId,
          personFingerprint,
          originalFingerprint!,
          evidencedIdentity,
          group.report?.subject?.text || null,
        )
      : undefined;
  const ownPersonReceipt =
    latestPersonChoice?.outcome === 'this_is_person' &&
    latestPersonChoice.scope.groupId === group?.id &&
    latestPersonChoice.scope.groupVersionId === groupVersionId
      ? latestPersonChoice
      : undefined;
  const ownSelfReceipt =
    latestPersonChoice?.outcome === 'this_is_me' &&
    latestPersonChoice.scope.groupId === group?.id &&
    latestPersonChoice.scope.groupVersionId === groupVersionId;
  if (
    latestPersonChoice?.outcome === 'this_is_person' &&
    !ownPersonReceipt &&
    ownerMatchCount < 2 &&
    matchedOwner?.personId !== latestPersonChoice.assignedPerson?.personId
  )
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'This report was assigned to another person. Confirm who these current records belong to.',
    };
  if (
    latestPersonChoice?.outcome === 'this_is_me' &&
    !ownSelfReceipt &&
    ownerMatchCount < 2 &&
    matchedOwner?.personId !== 'patient'
  )
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'The person matched by this report has changed. Confirm who these current records belong to.',
    };
  // A confirmation belongs to the reviewed report. A borrowed Self answer
  // cannot decide between same-named owners or override B's banner against
  // the owner it would actually assign, even when there is no unique match.
  // B's own applicable confirmation still resolves its ownership question.
  const borrowedSelfReceipt = latestPersonChoice?.outcome === 'this_is_me' && !ownSelfReceipt;
  const reusableSelfReceipt = (candidate: IdentityPolicyReceipt | undefined) =>
    candidate?.outcome === 'this_is_me' &&
    ((candidate.scope.groupId === group?.id && candidate.scope.groupVersionId === groupVersionId) ||
      (!unreadableBirthDate &&
        ownerMatchCount <= 1 &&
        !suffixAmbiguity &&
        !bannerIncompatibleWith(selfOwner)));
  const receipt =
    latestPersonChoice?.outcome === 'this_is_me' &&
    (!borrowedSelfReceipt || reusableSelfReceipt(latestPersonChoice))
      ? latestPersonChoice
      : undefined;
  const explicitCandidate =
    explicitlyConfirmedOperationId && group && groupVersionId
      ? yield* receiptForWork(
          receipts,
          group.id,
          groupVersionId,
          personFingerprint,
          originalFingerprint!,
          evidencedIdentity,
          group.report?.subject?.text || null,
          explicitlyConfirmedOperationId,
        )
      : undefined;
  // An operation ID identifies the old decision; it is not a fresh review of
  // changed membership or current identity clues. Apply the same reuse gate.
  const explicitReceipt =
    explicitCandidate?.outcome === 'this_is_me' && !reusableSelfReceipt(explicitCandidate)
      ? undefined
      : explicitCandidate;
  if (
    challengedName &&
    !explicitReceipt &&
    !ownPersonReceipt &&
    !(receipt && receipt.scope.groupId === group?.id)
  )
    return {
      ...common,
      confidence: 'none',
      status: 'confirmation_required',
      blocking: true,
      message:
        'An accepted person correction challenged this printed name. Confirm this report’s person and choose whether future reports should use that name or ask each time.',
    };
  const applicableReceipt = explicitReceipt || receipt;
  // Only a Self answer can resolve a Self match or be compared with Self's
  // birth date. An explicit Person repair can share this operation channel.
  const resolutionOperationId =
    applicableReceipt?.outcome === 'this_is_me'
      ? explicitReceipt?.operationId ||
        (!hasUnstructuredIdentityQuestion ? receipt?.operationId : undefined)
      : undefined;
  if (
    resolutionOperationId &&
    !ownPersonReceipt &&
    applicableReceipt?.scope.groupId !== group?.id &&
    !nameEvidenceGrounded
  )
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'Confirm this report’s patient identity before reusing a confirmation from another report.',
    };
  const reviewedBirthDate = applicableReceipt?.identityAnswers?.birthDate;
  if (
    resolutionOperationId &&
    !ownPersonReceipt &&
    reviewedBirthDate &&
    selfBirthDate &&
    !compatibleBirthDates(reviewedBirthDate, selfBirthDate)
  )
    return {
      ...common,
      selfBirthDateConflict: true,
      defaultPerson: 'new',
      status: 'conflict',
      blocking: true,
      message:
        'The reviewed report birth date differs from Self’s current birth date. Choose who this report belongs to before saving.',
      conflicts: [
        ...conflicts.filter((conflict) => conflict.field !== 'birthDate'),
        {
          field: 'birthDate',
          selfValue: selfBirthDate,
          evidencedValue: reviewedBirthDate,
          reason: 'self_mismatch',
        },
      ],
    };
  if (resolutionOperationId && !ownPersonReceipt && !birthDate && !originalEvidenceChecked)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'Recheck this report’s original identity before reusing a confirmation that contains no birth date.',
    };
  if (
    resolutionOperationId &&
    !ownPersonReceipt &&
    (!suffixAmbiguity || ownSelfReceipt) &&
    !selfBirthDateConflict &&
    !conflicts.some((conflict) => conflict.reason === 'evidence_disagreement')
  )
    return {
      ...common,
      status: 'prior_confirmation',
      blocking: false,
      message: 'A retained confirmation for this same original and evidenced person applies.',
      attribution: {
        status: 'prior_confirmation',
        basis: receipt ? 'same_original_person_confirmation' : 'explicit_report_confirmation',
        groupId: group?.id || null,
        groupVersionId,
        ...(personFingerprint ? { personFingerprint } : {}),
        confirmationOperationId: resolutionOperationId,
        ...(Object.keys(evidencedIdentity).length ? { evidencedIdentity } : {}),
      },
    };
  if (ownPersonReceipt) {
    const assigned = yield* findClinicalReviewWork(people, function* (person) {
      return (
        person.personId === ownPersonReceipt.assignedPerson?.personId &&
        person.noteId === ownPersonReceipt.assignedPerson?.noteId
      );
    });
    const reviewedDate =
      clean(ownPersonReceipt.identityAnswers?.birthDate) ||
      birthDate ||
      clean(ownPersonReceipt.scope.evidencedIdentity?.birthDate);
    if (
      !assigned ||
      (hasUnstructuredIdentityQuestion &&
        explicitlyConfirmedOperationId !== ownPersonReceipt.operationId) ||
      conflicts.some((conflict) => conflict.reason === 'evidence_disagreement') ||
      (!birthDate && !originalEvidenceChecked)
    )
      return {
        ...common,
        status: 'confirmation_required',
        blocking: true,
        message: 'Confirm who these current records belong to before saving.',
      };
    if (
      reviewedDate &&
      assigned.birthDate &&
      !compatibleBirthDates(reviewedDate, assigned.birthDate)
    )
      return {
        ...common,
        status: 'conflict',
        blocking: true,
        message:
          'The reviewed report birth date differs from the assigned person’s current birth date. Choose who this report belongs to before saving.',
      };
    return {
      ...common,
      status: 'prior_confirmation',
      blocking: false,
      message: `This report was assigned to ${assigned.fullName}.`,
      attribution: {
        status: 'prior_confirmation',
        basis: 'explicit_person_confirmation',
        groupId: group?.id || null,
        groupVersionId,
        confirmationOperationId: ownPersonReceipt.operationId,
        assignedPerson: {
          noteId: assigned.noteId,
          personId: assigned.personId,
          version: assigned.version,
          fullName: assigned.fullName,
        },
        evidencedIdentity,
      },
    };
  }
  if (suffixAmbiguity && !ownSelfReceipt)
    return {
      ...common,
      confidence: 'none',
      status: 'confirmation_required',
      blocking: true,
      message:
        'This printed name could belong to people whose saved names differ only by a generational suffix. Choose who this report belongs to.',
    };
  if (ownerMatchCount > 1)
    return {
      ...common,
      confidence: 'none',
      status: 'confirmation_required',
      blocking: true,
      message:
        'This printed name is saved for more than one person. Choose who this report belongs to; a shared name or birth date cannot choose for you.',
    };
  if (conflicts.length)
    return {
      ...common,
      status: 'conflict',
      blocking: true,
      message:
        'The report identity conflicts with saved identity. Choose who this report belongs to before saving.',
    };
  if (possibleName)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'The printed name resembles a saved name, but initials or omitted names do not prove identity. Confirm the report subject before saving; add another known name in Self only if you have used it.',
    };
  // Never a match, and never the absent-DOB path to a name-only match or warning.
  if (unreadableBirthDate)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'The birth date information for this report needs review; a model suggestion is not original evidence. Choose who this report belongs to before saving.',
    };
  // An unlabelled banner date cannot confirm a match, but one no reading of
  // which fits the saved person blocks it, whether or not the model asked.
  if (incompatibleBanner)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'The date printed beside the name in this report header does not fit the saved birth date. Confirm who this report belongs to before saving.',
    };
  if (
    birthDate &&
    (yield* someClinicalReviewWork(receipts || [], function* (prior) {
      return (
        prior.scope.evidenceOriginalFingerprint === originalFingerprint &&
        !!prior.scope.evidencedIdentity?.birthDate &&
        !compatibleBirthDates(prior.scope.evidencedIdentity.birthDate, birthDate)
      );
    }))
  )
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'This report has a different evidenced birth date from an earlier confirmed report. Choose who it belongs to.',
    };
  if (
    nameMatches &&
    !hasUnstructuredIdentityQuestion &&
    nameEvidenceGrounded &&
    originalEvidenceChecked
  )
    return {
      ...common,
      status: 'evidenced_match',
      blocking: false,
      message: matchedOwner?.person
        ? `The report identity matches saved names for ${matchedOwner.person.fullName}.`
        : 'The report identity matches saved Self identity.',
      attribution: {
        status: 'evidenced_match',
        basis: matchedOwner?.person ? 'matched_saved_person' : 'matched_saved_self',
        ...(matchedOwner?.person
          ? {
              assignedPerson: {
                noteId: matchedOwner.person.noteId,
                personId: matchedOwner.person.personId,
                version: matchedOwner.person.version,
                fullName: matchedOwner.person.fullName,
              },
            }
          : {}),
        confidence,
        groupId: group?.id || null,
        groupVersionId,
        ...(group && originalFingerprint
          ? { originalSubjectFingerprint: originalFingerprint }
          : {}),
        ...(personFingerprint ? { personFingerprint } : {}),
        evidencedIdentity,
      },
    };
  const hasPrintedIdentity =
    !!group?.report?.subject || !!fullName || !!birthDate || hasUnstructuredIdentityQuestion;
  if (!hasPrintedIdentity)
    return {
      ...common,
      status: 'missing_warning',
      blocking: false,
      message:
        'No patient identity was supplied for this record. Saving will attribute the reviewed record to active Self without inventing source identity evidence.',
      attribution: {
        status: 'missing_warning',
        basis: 'reviewed_active_profile_missing_identity',
        groupId: group?.id || null,
        groupVersionId,
      },
    };
  return {
    ...common,
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm that the displayed report subject is Self before saving its records.',
  };
}

/** A human repair covers only the displayed competing claims and exact pending occurrences. */
export function identityBoundaryRepairApplies(
  receipt: IntakeIdentityReceipt | undefined,
  group: IntakeReportGroup,
  groups: IntakeReportGroup[],
  targets: IntakeIdentityScope['targets'],
): boolean {
  if (
    !receipt ||
    receipt.scope.groupId !== group.id ||
    receipt.attestation !== 'confirmed_displayed_identity_questions' ||
    !receipt.scope.competingSubjects?.length
  )
    return false;
  const competing = competingIdentityBoundaries(group, groups)
    .map((other) => ({
      groupId: other.id,
      groupVersionId: other.versions.at(-1)!.id,
      subject: other.report!.subject!,
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
  if (canonicalLiteral(competing) !== canonicalLiteral(receipt.scope.competingSubjects))
    return false;
  return (
    targets.length > 0 &&
    targets.every((target) =>
      (receipt.scope.assignmentTargets || receipt.scope.targets).some(
        (prior) =>
          prior.candidateId === target.candidateId &&
          prior.candidateVersionId === target.candidateVersionId &&
          prior.proposalId === target.proposalId &&
          prior.recordId === target.recordId &&
          selectedSequence(target.issueIds || [target.issueId]).every((issueId) =>
            identityTargetHasIssue(prior, issueId),
          ),
      ),
    )
  );
}
