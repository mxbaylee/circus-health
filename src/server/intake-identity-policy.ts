import {
  canonicalIdentityName,
  possiblySameIdentityName,
  savedKnownNames,
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
} from '../shared/intake-identity.ts';

const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalLiteral(value)).digest('hex');

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
      receipt.scope.targets.length > 0 &&
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

export function collectEvidencedIdentity(
  issues: Iterable<Pick<IntakeReviewIssue, 'selfSuggestion'>>,
): { evidence: IntakeEvidencedIdentity; conflicts: IntakeIdentityConflict[] } {
  const names: string[] = [];
  const dates: string[] = [];
  for (const issue of issues) {
    const name = clean(issue.selfSuggestion?.fullName);
    const date = clean(issue.selfSuggestion?.birthDate);
    if (
      name &&
      !names.some((value) => canonicalIdentityName(value) === canonicalIdentityName(name))
    )
      names.push(name);
    if (date && !dates.some((value) => value === date)) dates.push(date);
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
  };
}

export interface IdentityPolicyAssessment {
  confidence: IntakeIdentityConfidence;
  status: IntakeIdentityReviewStatus;
  blocking: boolean;
  message: string;
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
          const target = receipt.scope.targets.find(
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
  return receipts?.findLast((receipt) => {
    if (receipt.scope.groupId === groupId && receipt.scope.groupVersionId === groupVersionId)
      return true;
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
  evidence,
  evidenceConflicts = [],
  group,
  groupVersionId,
  originalFingerprint,
  receipts,
  hasUnstructuredIdentityQuestion,
  explicitlyConfirmedOperationId,
  currentRefusal,
}: {
  self: IntakeIdentitySelfSnapshot;
  evidence: IntakeEvidencedIdentity;
  evidenceConflicts?: IntakeIdentityConflict[];
  group: IntakeReportGroup | null;
  groupVersionId: string | null;
  originalFingerprint: string | null;
  receipts?: IntakeIdentityReceipt[];
  hasUnstructuredIdentityQuestion?: boolean;
  explicitlyConfirmedOperationId?: string;
  currentRefusal?: 'unknown' | 'other_person';
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
  const conflicts = [...evidenceConflicts];
  const selfName = clean(self.fullName);
  const selfBirthDate = clean(self.birthDate);
  const savedNames = [selfName, ...savedKnownNames(self.knownNames)].filter(
    (name): name is string => !!name,
  );
  const nameMatches =
    !!fullName &&
    savedNames.some((name) => canonicalIdentityName(fullName) === canonicalIdentityName(name));
  const possibleName =
    !!fullName &&
    !nameMatches &&
    savedNames.some((name) => possiblySameIdentityName(fullName, name));
  const birthDateMatches =
    !!birthDate && !!selfBirthDate && compatibleBirthDates(birthDate, selfBirthDate);
  if (fullName && savedNames.length && !nameMatches && !possibleName)
    conflicts.push({
      field: 'fullName',
      selfValue: selfName,
      evidencedValue: fullName,
      reason: 'self_mismatch',
    });
  if (birthDate && selfBirthDate && !compatibleBirthDates(birthDate, selfBirthDate))
    conflicts.push({
      field: 'birthDate',
      selfValue: selfBirthDate,
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
      : nameMatches && birthDateMatches && birthDate?.length === 10 && selfBirthDate?.length === 10
        ? 'strong'
        : nameMatches || birthDateMatches
          ? 'limited'
          : 'none';
  const common = { evidencedIdentity, offeredSelfFields, conflicts, confidence };
  if (conflicts.length)
    return {
      ...common,
      status: 'conflict',
      blocking: true,
      message:
        'The report identity conflicts with Self. Correct or resolve the contradictory name or date of birth before saving.',
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
  const receipt =
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
  const resolutionOperationId =
    explicitReceipt?.operationId ||
    (!hasUnstructuredIdentityQuestion ? receipt?.operationId : undefined);
  if (resolutionOperationId)
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
  if (possibleName)
    return {
      ...common,
      status: 'confirmation_required',
      blocking: true,
      message:
        'The printed name resembles a saved name, but initials or omitted names do not prove identity. Confirm the report subject before saving; add another known name in Self only if you have used it.',
    };
  if ((nameMatches || birthDateMatches) && !hasUnstructuredIdentityQuestion)
    return {
      ...common,
      status: 'evidenced_match',
      blocking: false,
      message: 'The report identity matches saved Self identity.',
      attribution: {
        status: 'evidenced_match',
        basis: 'matched_saved_self',
        confidence,
        groupId: group?.id || null,
        groupVersionId,
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
