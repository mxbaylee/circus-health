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
import type {
  IntakeClinicalIdentityAttribution,
  IntakeIssueResolution,
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

export interface IdentityPolicyPersonSnapshot extends IntakeIdentityPerson {
  knownNames: string[];
  challengedNames?: string[];
  birthDate: string | null;
}

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');

export function competingIdentityBoundaries(
  group: IntakeReportGroup,
  groups: IntakeReportGroup[],
): IntakeReportGroup[] {
  // Separate model groups are not separate people. A header with no subject,
  // a different subject locator, or self/unknown role tags are not contradictory
  // printed identity. Keep each group's grounding/receipts independent.
  const subject = group.report?.subject?.text.trim();
  if (!group.report?.anchor || !subject) return [];
  const claim = (text: string) =>
    canonicalIdentityName(
      text.replace(/^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*/i, ''),
    );
  const currentClaim = claim(subject);
  return groups.filter(
    (other) =>
      other.id !== group.id &&
      !!other.report?.anchor &&
      !!other.report.subject?.text.trim() &&
      claim(other.report.subject.text.trim()) !== currentClaim &&
      other.sourceFileId === group.sourceFileId &&
      other.sourceHash === group.sourceHash &&
      other.memberId === group.memberId &&
      canonicalLiteral(other.report?.anchor) === canonicalLiteral(group.report?.anchor),
  );
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
export function repeatedIdentityQuestionReceipt({
  issue,
  group,
  receipts,
  profileId,
  intakeId,
  sourceHash,
  originalFingerprint,
  grounded,
}: {
  issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor' | 'resolution'>;
  group: IntakeReportGroup;
  receipts?: IntakeIdentityReceipt[];
  profileId: string;
  intakeId: string;
  sourceHash: string;
  originalFingerprint: string;
  grounded: (receipt: IntakeIdentityReceipt) => boolean;
}): IntakeIdentityReceipt | undefined {
  const anchor = issue.textAnchor;
  const subject = group.report?.subject?.text;
  if (
    (issue.resolution && issue.resolution.outcome !== 'this_is_me') ||
    !anchor?.trim() ||
    !subject
  )
    return undefined;
  return receipts?.findLast(
    (receipt) =>
      receipt.outcome === 'this_is_me' &&
      receipt.attestation === 'confirmed_displayed_identity_questions' &&
      (receipt.scope.targets.length > 0 || !!receipt.scope.assignmentTargets?.length) &&
      receipt.scope.profileId === profileId &&
      receipt.scope.intakeId === intakeId &&
      receipt.scope.sourceHash === sourceHash &&
      receipt.scope.evidenceOriginalFingerprint === originalFingerprint &&
      receipt.scope.memberId === group.memberId &&
      canonicalIdentityName(receipt.scope.subject.text) === canonicalIdentityName(subject) &&
      receipt.scope.questions?.some(
        (question) => question.textAnchor === anchor && question.prompt === issue.prompt,
      ) &&
      grounded(receipt),
  );
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
  for (const issue of issues) {
    const modelBirthDate = clean(issue.selfSuggestion?.birthDate);
    if (
      !modelBirthDate ||
      !validModelBirthDate(modelBirthDate) ||
      compatibleBirthDates(modelBirthDate, savedBirthDate) ||
      warnings.some((warning) => warning.modelBirthDate === modelBirthDate)
    )
      continue;
    warnings.push({
      kind: 'model_birth_date_mismatch',
      modelBirthDate,
      savedBirthDate,
      personName: person.fullName,
    });
  }
  return warnings;
}

export function identityOriginalFingerprint(
  intakeId: string,
  sourceHash: string,
  group: IntakeReportGroup,
  workflow: Pick<IntakeWorkflow, 'plans'>,
): string {
  if (!group.memberId) return hash(['intake-original', intakeId, sourceHash]);
  const member = workflow.plans
    .flatMap((plan) => plan.index.members || [])
    .find((candidate) => candidate.memberId === group.memberId);
  return hash([
    'intake-member-original',
    intakeId,
    group.memberId,
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
  const labeled =
    /^(?:(?:patient|client)(?:\s+name)?|name|subject)\s*:\s*([^\n;|]+)(?:[\n;|]|$)/i.exec(text);
  let name = (labeled?.[1] || text).trim();
  // A name column followed by an explicit sex column and numeric date is a
  // demographic header, not a name containing measurements or dates.
  const columns = /^(.*?)\s{2,}(?:Female|Male)\s{2,}\d{1,4}[/-]\d{1,2}[/-]\d{1,4}(.*)$/i.exec(name);
  if (columns && /^(?:\s+(?:\d+(?:[./:-]\d+)*|in\.?|lbs\.?|cm|kg|ft\.?))*\s*$/i.test(columns[2]!))
    name = columns[1]!.trim();
  if (labeled)
    name = name.split(/\s+(?:DOB|date of birth|birth\s*date|MRN|patient\s*ID)\s*:/i)[0]!.trim();
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
  issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor' | 'field' | 'questionId' | 'resolution'>,
  subjectText: string | undefined,
  self: IntakeIdentitySelfSnapshot,
  people: IdentityPolicyPersonSnapshot[],
): boolean {
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
  const owners = [
    { fullName: self.fullName, knownNames: self.knownNames, birthDate: self.birthDate },
    ...people,
  ];
  const matching = owners.filter((owner) =>
    [owner.fullName, ...savedKnownNames(owner.knownNames)].some(
      (saved) => saved && canonicalIdentityName(saved) === canonicalIdentityName(name),
    ),
  );
  // An unlabelled demographic date cannot strengthen a name-only match or
  // become DOB evidence. Retain the ownership question when none of its
  // readings fit the saved person; one compatible reading leaves that match
  // unchanged. Labelled DOB ambiguity still requires its own review.
  return (
    matching.length === 1 &&
    (!matching[0]!.birthDate ||
      (labelledAnchorDate
        ? alternatives.every((date) => compatibleBirthDates(date, matching[0]!.birthDate!))
        : alternatives.some((date) => compatibleBirthDates(date, matching[0]!.birthDate!))))
  );
}

export function collectEvidencedIdentity(
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'>>,
  subjectText?: string | null,
  original: BirthDateEvidence = { dates: [], unreadable: false },
): {
  evidence: IntakeEvidencedIdentity;
  conflicts: IntakeIdentityConflict[];
  /** A printed birth-date label whose value is not one complete date. */
  unreadableBirthDate: boolean;
  /** Readings of each unlabelled banner date; review clues, never evidence. */
  bannerBirthDates: string[][];
} {
  const names: string[] = [];
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
    const name = clean(issue.selfSuggestion?.fullName);
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
  if (names.length && subjectText !== undefined && subjectText !== null) {
    const printed = printedIdentityName(subjectText);
    if (
      !printed ||
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
  issueIds: string[];
  resolutions: IntakeIssueResolution[];
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
  membership: IntakeIdentityScope['membership'];
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

function receiptMembershipIsRetained(
  prior: IntakeIdentityScope['membership'],
  current: IntakeIdentityScope['membership'],
): boolean {
  return prior.every((priorMember) => {
    const currentMember = current.find(
      (member) =>
        member.candidateId === priorMember.candidateId &&
        member.candidateVersionId === priorMember.candidateVersionId,
    );
    return (
      !!currentMember &&
      canonicalLiteral(currentMember.section || null) ===
        canonicalLiteral(priorMember.section || null) &&
      priorMember.occurrences.every((priorOccurrence) =>
        currentMember.occurrences.some(
          (occurrence) => canonicalLiteral(occurrence) === canonicalLiteral(priorOccurrence),
        ),
      )
    );
  });
}

/**
 * An exact issue receipt remains authoritative when a cumulative report version
 * only adds members or occurrences. The caller still has to prove that the
 * receipt contains the exact current candidate/version/record/issue target.
 */
export function identityReceiptAppliesToCurrentBoundary(
  receipt: IntakeIdentityReceipt,
  current: CurrentIdentityReceiptBoundary,
): boolean {
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
    receiptMembershipIsRetained(prior.membership, current.membership)
  );
}

/**
 * Every current explicit issue needs its own latest draft answer and the exact
 * receipt target that wrote it. Separate later questions may therefore be
 * confirmed separately without allowing an older operation to cover them.
 */
/** A family assignment is exact per retained candidate occurrence, never inferred from a name. */
export function confirmedPersonReceipt({
  receipts,
  boundary,
  candidateId,
  candidateVersionId,
  proposalId,
  recordId,
  resolutions,
  requiredIssueIds,
}: {
  receipts?: IntakeIdentityReceipt[];
  boundary: CurrentIdentityReceiptBoundary;
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  resolutions: IntakeIssueResolution[];
  requiredIssueIds: string[];
}): IntakeIdentityReceipt | undefined {
  return receipts?.findLast((receipt) => {
    if (
      receipt.outcome !== 'this_is_person' ||
      !receipt.assignedPerson ||
      !identityReceiptAppliesToCurrentBoundary(receipt, boundary)
    )
      return false;
    const target = (receipt.scope.assignmentTargets || receipt.scope.targets).find(
      (item) =>
        item.candidateId === candidateId &&
        item.candidateVersionId === candidateVersionId &&
        item.proposalId === proposalId &&
        item.recordId === recordId,
    );
    return (
      !!target &&
      requiredIssueIds.every((issueId) =>
        (target.issueIds || [target.issueId]).includes(issueId),
      ) &&
      (target.issueIds || [target.issueId]).every((issueId) => {
        const answer = resolutions.findLast((item) => item.issueId === issueId);
        return answer?.operationId === receipt.operationId && answer.outcome === 'other_person';
      })
    );
  });
}

export function exactCurrentIdentityResolutionOperationId({
  receipts,
  occurrences,
  receiptApplies = () => true,
}: {
  receipts?: IntakeIdentityReceipt[];
  occurrences: ExplicitIdentityResolutionOccurrence[];
  receiptApplies?: (receipt: IntakeIdentityReceipt) => boolean;
}): string | undefined {
  if (!occurrences.length) return undefined;
  let latestReceiptIndex = -1;
  let latestOperationId: string | undefined;
  for (const occurrence of occurrences) {
    if (!occurrence.issueIds.length) return undefined;
    for (const issueId of occurrence.issueIds) {
      const resolution = occurrence.resolutions.findLast((item) => item.issueId === issueId);
      if (resolution?.outcome !== 'this_is_me' || !resolution.operationId) return undefined;
      const receiptIndex =
        receipts?.findLastIndex((receipt) => {
          if (receipt.operationId !== resolution.operationId || !receiptApplies(receipt))
            return false;
          const target = (receipt.scope.assignmentTargets || receipt.scope.targets).find(
            (item) =>
              item.candidateId === occurrence.candidateId &&
              item.candidateVersionId === occurrence.candidateVersionId &&
              item.proposalId === occurrence.proposalId &&
              item.recordId === occurrence.recordId,
          );
          return !!target && (target.issueIds || [target.issueId]).includes(issueId);
        }) ?? -1;
      if (receiptIndex < 0) return undefined;
      if (receiptIndex > latestReceiptIndex) {
        latestReceiptIndex = receiptIndex;
        latestOperationId = resolution.operationId;
      }
    }
  }
  return latestOperationId;
}

function receiptFor(
  receipts: IntakeIdentityReceipt[] | undefined,
  groupId: string,
  groupVersionId: string,
  personFingerprint: string | undefined,
  originalFingerprint: string,
  evidence: IntakeEvidencedIdentity,
  subjectText: string | null,
): IntakeIdentityReceipt | undefined {
  const subject = clean(subjectText);
  const exactGroup = receipts?.findLast(
    (receipt) =>
      receipt.scope.groupId === groupId && receipt.scope.groupVersionId === groupVersionId,
  );
  if (exactGroup) return exactGroup;
  return receipts?.findLast((receipt) => {
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

export function assessIdentityPolicy({
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
  people?: IdentityPolicyPersonSnapshot[];
  evidence: IntakeEvidencedIdentity;
  evidenceConflicts?: IntakeIdentityConflict[];
  group: IntakeReportGroup | null;
  groupVersionId: string | null;
  originalFingerprint: string | null;
  receipts?: IntakeIdentityReceipt[];
  hasUnstructuredIdentityQuestion?: boolean;
  explicitlyConfirmedOperationId?: string;
  currentRefusal?: 'unknown' | 'other_person';
  nameEvidenceGrounded?: boolean;
  originalEvidenceChecked?: boolean;
  /** A printed birth-date label is present but its value is not one complete date. */
  unreadableBirthDate?: boolean;
  /** Readings of each unlabelled banner date (name, sex, date columns), never DOB evidence. */
  bannerBirthDates?: string[][];
}): IdentityPolicyAssessment {
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
  const owners = [
    {
      personId: 'patient',
      names: selfNames,
      birthDate: selfBirthDate,
      person: undefined as IdentityPolicyPersonSnapshot | undefined,
    },
    ...people
      .filter((person) => person.personId !== 'patient')
      .map((person) => ({
        personId: person.personId,
        names: [person.fullName, ...person.knownNames.filter(safeSourceIdentityName)].filter(
          Boolean,
        ),
        birthDate: clean(person.birthDate),
        person,
      })),
  ];
  const exactOwners = fullName
    ? owners.filter((owner) =>
        owner.names.some((name) => canonicalIdentityName(name) === canonicalIdentityName(fullName)),
      )
    : [];
  const futureOwner = fullName
    ? self.futureNameOwners?.find(
        (decision) => canonicalIdentityName(decision.name) === canonicalIdentityName(fullName),
      )?.personId
    : undefined;
  const distinctOwners = [
    ...new Map(
      exactOwners
        .filter((owner) => !futureOwner || owner.personId === futureOwner)
        .map((owner) => [owner.personId, owner]),
    ).values(),
  ];
  const challengedName =
    !!fullName &&
    [self, ...people].some((owner) =>
      owner.challengedNames?.some(
        (name) => canonicalIdentityName(name) === canonicalIdentityName(fullName),
      ),
    );
  const matchedOwner = distinctOwners.length === 1 ? distinctOwners[0] : undefined;
  const bannerIncompatibleWith = (owner: (typeof owners)[number] | undefined): boolean =>
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
    owners.some((owner) => owner.names.some((name) => possiblySameIdentityName(fullName, name)));
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
      ? receiptFor(
          receipts,
          group.id,
          groupVersionId,
          personFingerprint,
          originalFingerprint!,
          evidencedIdentity,
          group.report?.subject?.text || null,
        )
      : undefined;
  if (
    latestPersonChoice?.outcome === 'this_is_person' &&
    (matchedOwner?.personId !== latestPersonChoice.assignedPerson?.personId ||
      hasUnstructuredIdentityQuestion)
  )
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'This report was assigned to another person. Confirm who these current records belong to.',
    };
  // A confirmation belongs to the reviewed report. A borrowed Self answer
  // cannot decide between same-named owners or override B's banner against
  // the owner it would actually assign, even when there is no unique match.
  // B's own applicable confirmation still resolves its ownership question.
  const borrowedSelfReceipt =
    latestPersonChoice?.outcome === 'this_is_me' && latestPersonChoice.scope.groupId !== group?.id;
  const receipt =
    latestPersonChoice?.outcome === 'this_is_me' &&
    (!borrowedSelfReceipt ||
      (!unreadableBirthDate && distinctOwners.length <= 1 && !bannerIncompatibleWith(owners[0])))
      ? latestPersonChoice
      : undefined;
  const explicitReceipt =
    explicitlyConfirmedOperationId && group && groupVersionId
      ? receiptFor(
          receipts?.filter((candidate) => candidate.operationId === explicitlyConfirmedOperationId),
          group.id,
          groupVersionId,
          personFingerprint,
          originalFingerprint!,
          evidencedIdentity,
          group.report?.subject?.text || null,
        )
      : undefined;
  if (challengedName && !explicitReceipt && !(receipt && receipt.scope.groupId === group?.id))
    return {
      ...common,
      confidence: 'none',
      status: 'confirmation_required',
      blocking: true,
      message:
        'An accepted person correction challenged this printed name. Confirm this report’s person and choose whether future reports should use that name or ask each time.',
    };
  const resolutionOperationId =
    explicitReceipt?.operationId ||
    (!hasUnstructuredIdentityQuestion ? receipt?.operationId : undefined);
  const applicableReceipt = explicitReceipt || receipt;
  if (
    resolutionOperationId &&
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
  if (resolutionOperationId && !birthDate && !originalEvidenceChecked)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'Recheck this report’s original identity before reusing a confirmation that contains no birth date.',
    };
  if (
    resolutionOperationId &&
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
  if (distinctOwners.length > 1)
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
    receipts?.some(
      (prior) =>
        prior.scope.evidenceOriginalFingerprint === originalFingerprint &&
        prior.scope.evidencedIdentity?.birthDate &&
        !compatibleBirthDates(prior.scope.evidencedIdentity.birthDate, birthDate),
    )
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
          (target.issueIds || [target.issueId]).every((issueId) =>
            (prior.issueIds || [prior.issueId]).includes(issueId),
          ),
      ),
    )
  );
}
