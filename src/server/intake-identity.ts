import {
  effectiveKnownNames,
  challengedKnownNames,
  challengedNameNoteIds,
  futureNameOwners,
  rememberFutureNameOwner,
  activeIdentityReceipts,
} from './name-associations.ts';
import { matchesSelfIdentityName } from '../shared/self-identity.ts';
import {
  decodeOriginalIdentityText,
  originalSubjectBirthDateEvidence,
  originalSubjectNameGrounded,
} from './intake-evidence-dates.ts';
import { noteVisibilitySQL } from './visibility.ts';
import {
  safeSourceIdentityName,
  compatibleIdentityBirthDates,
  validOnboardingBirthDate,
} from '../shared/self-identity.ts';
import { identityPeopleSnapshots } from './intake-identity-people.ts';
import { measureImportPhase } from './import-diagnostics.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, json, now } from './database.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  getIntake,
  getIntakeOriginal,
  getRetainedIntakeOriginalReference,
  reviewIntake,
  workflowMutation,
} from './intake.ts';
import { currentReviewDraft } from './intake-review.ts';
import { readPdfIdentityPageText } from './intake-pdf-session.ts';
import {
  assessIdentityPolicy,
  collectEvidencedIdentity,
  currentIdentityRefusal,
  repeatedIdentityQuestionReceipt,
  exactCurrentIdentityResolutionOperationId,
  identityReceiptAppliesToCurrentBoundary,
  identityOriginalFingerprint,
  identityPersonFingerprint,
  printedIdentityName,
  isGenericNameConfirmation,
  competingIdentityBoundaries,
  identityBoundaryRepairApplies,
} from './intake-identity-policy.ts';
import { retainIdentityGrounding } from './intake-identity-grounding.ts';
import {
  getNote,
  updateBlankSelfIdentityFieldsInTransaction,
  createIntakeFamilyPersonInTransaction,
  rememberSourceNameInTransaction,
} from './notes.ts';
import type {
  Intake,
  IntakeReview,
  IntakeReportGroup,
  IntakeReviewIssue,
} from '../shared/intake.ts';
import type {
  IntakeIdentityPerson,
  IntakeIdentityConfirmation,
  IntakeIdentityConflict,
  IntakeIdentityReview,
  IntakeIdentityReceipt,
  IntakeIdentityScope,
  IntakeIdentitySelfSnapshot,
} from '../shared/intake-identity.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalLiteral(value)).digest('hex');
const reject = (message: string): never => {
  throw new HttpError(409, 'IDENTITY_SCOPE', message);
};
interface Context {
  db: DatabaseSync;
  root: string;
  profileId: string;
  id: string;
}
interface Evidence {
  groupId: string;
  groupVersionId: string;
  sourceHash: string;
  original: IntakeIdentityScope['original'];
  verificationMode: IntakeIdentityScope['verificationMode'];
  originalFingerprint: string;
  pageText: string | null;
  patientNameGrounded: boolean;
}
const groupFor = (intake: Intake, groupId: string): IntakeReportGroup => {
  const group = intake.workflow?.reportGroups?.find((item) => item.id === groupId);
  if (!group || group.basis !== 'report_anchor' || !group.report?.subject)
    return reject(
      'A report and printed subject claim are required; review these records individually',
    );
  return group;
};

/** Existence is evidence location only; neither mode supplies identity authority. */
async function identityEvidence(context: Context, groupId: string): Promise<Evidence> {
  const { db, root, profileId, id } = context;
  const intake = getIntake(db, root, profileId, id);
  const group = groupFor(intake, groupId);
  let evidenceId = id;
  if (group.memberId) {
    const inventory = intake.workflow!.plans.flatMap((plan) => plan.index.members || []);
    const member = inventory.find((item) => item.memberId === group.memberId);
    if (!member) return reject('This package occurrence is not in the retained inventory');
    // Bind parent, exact occurrence locator and bytes; equal bytes in another member do not qualify.
    const child = db
      .prepare(
        "SELECT id FROM source_files WHERE sha256=? AND json_extract(details_json,'$.intake.parentSourceFileId')=? AND json_extract(details_json,'$.intake.locator')=?",
      )
      .get(member.sourceHash, id, member.locator) as { id: string } | undefined;
    if (!child)
      return reject('Open and retain this exact package member before confirming its identity');
    evidenceId = child.id;
  } else if (intake.mimeType === 'application/zip') {
    return reject('An outer package cannot supply common patient identity');
  }
  const reference = getRetainedIntakeOriginalReference(db, root, profileId, evidenceId);
  const sourceHash = reference.sourceHash;
  const subject = group.report!.subject!;
  const anchor = group.report!.anchor;
  let page: number | null = null;
  let text: string | null = null;
  if (reference.mimeType === 'application/pdf') {
    const subjectPage = /\bpage\s+(\d+)\b/i.exec(subject.locator)?.[1];
    const anchorPage = /\bpage\s+(\d+)\b/i.exec(anchor.locator)?.[1];
    if (!subjectPage || !anchorPage || subjectPage !== anchorPage)
      return reject(
        'Common PDF identity needs report and subject claims on one explicit original page',
      );
    page = Number(subjectPage);
    text = (await readPdfIdentityPageText({ ...reference, profileId }, page)).text;
    if (!text.trim()) text = null;
  } else {
    const original = getIntakeOriginal(db, root, profileId, evidenceId);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(original.mimeType)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(original.bytes);
      } catch {
        return reject('This original needs individual identity review');
      }
      // Keep decoded JSON keys, roles and object boundaries with the retained
      // string values. Flattening values alone makes guardian names look like
      // patient names and hides a structured patient's DOB key.
      text = decodeOriginalIdentityText(text, reference.filename);
      // Do not match hidden HTML instructions as visible subject evidence.
      if (original.mimeType === 'text/html')
        text = text
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
          .replace(/<[^>]*>/g, ' ');
    }
  }
  if (text !== null && (!text.includes(subject.text) || !text.includes(anchor.text)))
    return reject(
      'The report or subject quote was not found in the original text; inspect it individually',
    );
  return {
    groupId,
    groupVersionId: group.versions.at(-1)!.id,
    sourceHash,
    original: {
      filename: reference.filename,
      contentUrl: `/api/sources/${encodeURIComponent(evidenceId)}/content${page ? '#page=' + page : ''}`,
      page,
    },
    verificationMode: text === null ? 'human_reviewed_original' : 'literal_text_match',
    originalFingerprint: identityOriginalFingerprint(id, intake.sha256, group, intake.workflow!),
    pageText: text?.trim() ? text : null,
    patientNameGrounded: originalSubjectNameGrounded(text, subject.text, anchor.text),
  };
}
interface BuiltScope {
  scope: IntakeIdentityScope;
  evidenceConflicts: IntakeIdentityConflict[];
  unreadableBirthDate: boolean;
  bannerBirthDates: string[][];
  hasUnstructuredIdentityQuestion: boolean;
  explicitlyConfirmedOperationId?: string;
  currentRefusal?: 'unknown' | 'other_person';
  groundedQuestions: { issue: IntakeReviewIssue; receipt: IntakeIdentityReceipt }[];
  groundedNameQuestions: IntakeReviewIssue[];
  patientNameGrounded: boolean;
}

interface ExplicitIdentityOccurrence {
  candidateId: string;
  candidateVersionId: string;
  proposalId: string | null;
  recordId: string;
  title: string;
  issueIds: string[];
  issues: { id: string; prompt: string; textAnchor?: string }[];
  resolutions: NonNullable<IntakeReview['records'][number]['draft']>['resolutions'];
}

function buildScope(context: Context, evidence: Evidence): BuiltScope {
  const { db, root, profileId, id } = context;
  const intake = getIntake(db, root, profileId, id);
  const group = groupFor(intake, evidence.groupId);
  if (group.sourceFileId !== id || group.sourceHash !== intake.sha256)
    return reject('This report no longer belongs to this exact original');
  if (
    evidence.originalFingerprint !==
    identityOriginalFingerprint(id, intake.sha256, group, intake.workflow!)
  )
    return reject('The retained original occurrence changed while its evidence was being read');
  const latest = group.versions.at(-1);
  if (latest?.id !== evidence.groupVersionId)
    return reject('The report changed while its evidence was being read');
  if (!latest || latest.members.length > 1000)
    return reject('Review a bounded report with at most 1000 candidate versions');
  const competingSubjects = competingIdentityBoundaries(group, intake.workflow!.reportGroups!)
    .map((other) => ({
      groupId: other.id,
      groupVersionId: other.versions.at(-1)!.id,
      subject: other.report!.subject!,
    }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
  if (
    intake.workflow!.questions.some(
      (question) =>
        !question.candidateId &&
        question.status !== 'resolved' &&
        (question.field === 'subject' || /\b(patient|subject|identity)\b/i.test(question.prompt)),
    )
  )
    return reject('Resolve the delivery identity question before common confirmation');
  const reviews = new Map<string | null, IntakeReview>();
  const groundedNameQuestions: IntakeReviewIssue[] = [];
  const currentSelf = selfSnapshot(db);
  const currentPeople = identityPeopleSnapshots(db);
  const targets: IntakeIdentityScope['targets'] = [];
  const assignmentTargets: IntakeIdentityScope['targets'] = [];
  const questions = new Map<string, NonNullable<IntakeIdentityScope['questions']>[number]>();
  const identityIssues: NonNullable<IntakeReview['records'][number]['issues']> = [];
  const explicitOccurrences: ExplicitIdentityOccurrence[] = [];
  const groundedQuestions: BuiltScope['groundedQuestions'] = [];
  let hasUnstructuredIdentityQuestion = false;
  for (const member of latest.members) {
    const candidate = intake.workflow!.candidates.find((item) => item.id === member.candidateId);
    const version = candidate?.versions.find((item) => item.id === member.candidateVersionId);
    if (!candidate || !version) return reject('A report member no longer exists');
    if (candidate.versions.at(-1)?.id !== version.id || version.status !== 'pending') continue;
    for (const occurrence of member.occurrences) {
      let review = reviews.get(occurrence.proposalId);
      if (!review) {
        review = reviewIntake(db, root, profileId, id, occurrence.proposalId);
        reviews.set(occurrence.proposalId, review);
      }
      const record = review.records.find((item) => item.id === occurrence.recordId);
      if (
        !record ||
        record.candidateId !== candidate.id ||
        record.candidateVersionId !== version.id
      )
        return reject('The current report occurrence differs from the displayed member');
      const genericId =
        'issue:' +
        createHash('sha256')
          .update(JSON.stringify([version.id, 'identity', 'subject']))
          .digest('hex');
      const identity = (record.issues || []).filter((issue) => issue.kind === 'identity');
      identityIssues.push(...identity);
      if (record.reviewState === 'pending')
        assignmentTargets.push({
          candidateId: candidate.id,
          candidateVersionId: version.id,
          proposalId: occurrence.proposalId,
          recordId: record.id,
          title: record.title,
          issueId:
            identity.find((issue) => issue.id === genericId)?.id || identity[0]?.id || genericId,
          ...(identity.length ? { issueIds: identity.map((issue) => issue.id) } : {}),
        });
      const unresolved = identity.filter((issue) => issue.status === 'unresolved');
      const explicitIssues = identity
        .filter((issue) => issue.id !== genericId && !issue.selfSuggestion)
        .filter((issue) => {
          if (
            evidence.pageText?.includes(issue.textAnchor || '\u0000') &&
            isGenericNameConfirmation(
              issue,
              group.report?.subject?.text,
              currentSelf,
              currentPeople,
            )
          ) {
            groundedNameQuestions.push(issue);
            return false;
          }
          const receipt = repeatedIdentityQuestionReceipt({
            issue,
            group,
            receipts: activeIdentityReceipts(db, intake.workflow?.identityConfirmations),
            profileId,
            intakeId: id,
            sourceHash: intake.sha256,
            originalFingerprint: evidence.originalFingerprint,
            grounded: () =>
              !!issue.textAnchor && evidence.pageText?.includes(issue.textAnchor) === true,
          });
          if (!receipt) return true;
          groundedQuestions.push({ issue, receipt });
          return false;
        });
      if (explicitIssues.length) {
        hasUnstructuredIdentityQuestion = true;
        explicitOccurrences.push({
          candidateId: candidate.id,
          candidateVersionId: version.id,
          proposalId: occurrence.proposalId,
          recordId: record.id,
          title: record.title,
          issueIds: explicitIssues.map((issue) => issue.id),
          issues: explicitIssues.map((issue) => ({
            id: issue.id,
            prompt: issue.prompt,
            ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
          })),
          resolutions: record.draft?.resolutions || [],
        });
      }
      if (!unresolved.length || record.reviewState !== 'pending') continue;
      const additional = unresolved.filter((issue) => issue.id !== genericId);
      for (const issue of additional) {
        const question = {
          prompt: issue.prompt,
          ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
        };
        questions.set(canonicalLiteral(question), question);
      }
      if (questions.size > 100 || unresolved.length > 100)
        return reject(
          'Review these identity questions individually; the displayed scope is too large',
        );
      if (
        !targets.some(
          (target) =>
            target.candidateId === candidate.id &&
            target.candidateVersionId === version.id &&
            target.proposalId === occurrence.proposalId &&
            target.recordId === record.id,
        )
      )
        targets.push({
          candidateId: candidate.id,
          candidateVersionId: version.id,
          proposalId: occurrence.proposalId,
          recordId: record.id,
          title: record.title,
          issueId: unresolved.find((issue) => issue.id === genericId)?.id || unresolved[0]!.id,
          ...(additional.length ? { issueIds: unresolved.map((issue) => issue.id) } : {}),
        });
    }
  }
  if (targets.length > 1000)
    return reject('Review a bounded report with at most 1000 pending identity questions');
  const originalDates = originalSubjectBirthDateEvidence(
    evidence.pageText,
    group.report!.subject!.text,
    group.report!.anchor.text,
  );
  const collected = collectEvidencedIdentity(
    identityIssues,
    evidence.pageText === null || evidence.patientNameGrounded ? group.report?.subject?.text : '',
    originalDates,
  );
  const personFingerprint = identityPersonFingerprint(
    evidence.originalFingerprint,
    collected.evidence,
    group.report!.subject!.text,
  );
  const evidencedIdentity = {
    ...collected.evidence,
    ...(personFingerprint ? { personFingerprint } : {}),
  };
  const receiptApplies = (receipt: IntakeIdentityReceipt) =>
    !!(receipt.scope.assignmentTargets || receipt.scope.targets).length &&
    identityReceiptAppliesToCurrentBoundary(receipt, {
      profileId,
      intakeId: id,
      groupId: group.id,
      groupVersionId: latest.id,
      sourceHash: intake.sha256,
      memberId: group.memberId,
      original: evidence.original,
      report: group.report!.anchor,
      subject: group.report!.subject!,
      verificationMode: evidence.verificationMode,
      evidencedIdentity,
      evidenceOriginalFingerprint: evidence.originalFingerprint,
      membership: latest.members,
    });
  // A durable resolution without an exact retained target receipt is not
  // authority. Re-present only those current explicit issues; an unchanged
  // issue whose exact receipt remains inside a cumulative membership expansion
  // must not ask the user to confirm Self again.
  for (const occurrence of explicitOccurrences) {
    const missingIssueIds = occurrence.issueIds.filter(
      (issueId) =>
        !exactCurrentIdentityResolutionOperationId({
          receipts: activeIdentityReceipts(db, intake.workflow?.identityConfirmations),
          occurrences: [{ ...occurrence, issueIds: [issueId] }],
          receiptApplies,
        }),
    );
    if (!missingIssueIds.length) continue;
    const existingTarget = targets.find(
      (target) =>
        target.candidateId === occurrence.candidateId &&
        target.candidateVersionId === occurrence.candidateVersionId &&
        target.proposalId === occurrence.proposalId &&
        target.recordId === occurrence.recordId,
    );
    if (existingTarget) {
      const issueIds = new Set(existingTarget.issueIds || [existingTarget.issueId]);
      for (const issueId of missingIssueIds) issueIds.add(issueId);
      existingTarget.issueIds = [...issueIds];
    } else
      targets.push({
        candidateId: occurrence.candidateId,
        candidateVersionId: occurrence.candidateVersionId,
        proposalId: occurrence.proposalId,
        recordId: occurrence.recordId,
        title: occurrence.title,
        issueId: missingIssueIds[0]!,
        issueIds: missingIssueIds,
      });
    for (const issue of occurrence.issues)
      if (missingIssueIds.includes(issue.id)) {
        const question = {
          prompt: issue.prompt,
          ...(issue.textAnchor ? { textAnchor: issue.textAnchor } : {}),
        };
        questions.set(canonicalLiteral(question), question);
      }
  }
  if (targets.length > 1000 || assignmentTargets.length > 1000 || questions.size > 100)
    return reject('Review these identity questions individually; the displayed scope is too large');
  if (competingSubjects.length) {
    const question = {
      prompt:
        'Other extraction claims name a different subject at this same report boundary. Review the original and confirm the displayed subject and person for only the listed records.',
      textAnchor: competingSubjects.map((claim) => claim.subject.text).join(' / '),
    };
    questions.set(canonicalLiteral(question), question);
    hasUnstructuredIdentityQuestion = true;
  }
  if (questions.size > 100 || competingSubjects.length > 100)
    return reject('Review a bounded set of identity claims.');
  const birthDateReview =
    collected.unreadableBirthDate ||
    collected.conflicts.some((conflict) => conflict.field === 'birthDate')
      ? {
          choices: [...new Set([...originalDates.dates, ...(originalDates.suggestions || [])])],
          ...(originalDates.suggestions?.length ? { suggested: originalDates.suggestions[0] } : {}),
        }
      : undefined;
  const snapshot = {
    profileId,
    intakeId: id,
    intakeVersion: intake.version,
    selfVersion: selfSnapshot(db).version,
    groupId: group.id,
    groupVersionId: latest.id,
    sourceHash: intake.sha256,
    memberId: group.memberId,
    original: evidence.original,
    report: structuredClone(group.report!.anchor),
    subject: structuredClone(group.report!.subject!),
    verificationMode: evidence.verificationMode,
    evidencedIdentity,
    evidenceOriginalFingerprint: evidence.originalFingerprint,
    membership: structuredClone(latest.members),
    targets,
    assignmentTargets,
    ...(birthDateReview ? { birthDateReview } : {}),
    ...(competingSubjects.length ? { competingSubjects } : {}),
    ...(questions.size ? { questions: [...questions.values()] } : {}),
  };
  const scope: IntakeIdentityScope = {
    ...snapshot,
    scopeToken: hash([snapshot, evidence.sourceHash]),
  };
  let explicitlyConfirmedOperationId = scope.targets.length
    ? undefined
    : exactCurrentIdentityResolutionOperationId({
        receipts: activeIdentityReceipts(db, intake.workflow?.identityConfirmations),
        occurrences: explicitOccurrences,
        receiptApplies,
      });
  if (competingSubjects.length) {
    const repair = activeIdentityReceipts(db, intake.workflow?.identityConfirmations)?.findLast(
      (receipt) =>
        receiptApplies(receipt) &&
        identityBoundaryRepairApplies(
          receipt,
          group,
          intake.workflow!.reportGroups!,
          assignmentTargets,
        ),
    );
    if (repair) explicitlyConfirmedOperationId = repair.operationId;
  }
  return {
    scope,
    evidenceConflicts: collected.conflicts.filter((conflict) => conflict.field !== 'birthDate'),
    unreadableBirthDate: !!birthDateReview,
    bannerBirthDates: collected.bannerBirthDates,
    hasUnstructuredIdentityQuestion,
    currentRefusal: currentIdentityRefusal(identityIssues),
    groundedQuestions,
    groundedNameQuestions,
    patientNameGrounded: evidence.patientNameGrounded,
    ...(explicitlyConfirmedOperationId ? { explicitlyConfirmedOperationId } : {}),
  };
}

function selfSnapshot(db: DatabaseSync): IntakeIdentitySelfSnapshot {
  const self = getNote(db, 'person-note:self');
  const fullName =
    typeof self.person.fullName === 'string' && self.person.fullName.trim()
      ? self.person.fullName.trim()
      : null;
  const birthDate =
    typeof self.person.birthDate === 'string' && self.person.birthDate.trim()
      ? self.person.birthDate.trim()
      : null;
  return {
    noteId: 'person-note:self',
    version: self.version,
    fullName,
    knownNames: effectiveKnownNames(db, self.id, self.person),
    challengedNames: challengedKnownNames(db, self.id),
    futureNameOwners: futureNameOwners(db),
    birthDate,
  };
}

function groupRecordIdentity(
  context: Context,
  group: IntakeReportGroup,
): {
  evidence: ReturnType<typeof collectEvidencedIdentity>['evidence'];
  conflicts: IntakeIdentityConflict[];
  unreadableBirthDate: boolean;
  hasUnstructuredIdentityQuestion: boolean;
  currentRefusal?: 'unknown' | 'other_person';
} {
  const intake = getIntake(context.db, context.root, context.profileId, context.id);
  const latest = group.versions.at(-1);
  if (!latest || latest.members.length > 1000)
    return reject('Review a bounded report with at most 1000 candidate versions');
  const reviews = new Map<string | null, IntakeReview>();
  const issues: NonNullable<IntakeReview['records'][number]['issues']> = [];
  const explicitIssues: IntakeReviewIssue[] = [];
  for (const member of latest.members) {
    const candidate = intake.workflow!.candidates.find((item) => item.id === member.candidateId);
    const version = candidate?.versions.find((item) => item.id === member.candidateVersionId);
    if (!candidate || !version || candidate.versions.at(-1)?.id !== version.id) continue;
    for (const occurrence of member.occurrences) {
      let review = reviews.get(occurrence.proposalId);
      if (!review) {
        review = reviewIntake(
          context.db,
          context.root,
          context.profileId,
          context.id,
          occurrence.proposalId,
        );
        reviews.set(occurrence.proposalId, review);
      }
      const record = review.records.find(
        (item) =>
          item.id === occurrence.recordId &&
          item.candidateId === candidate.id &&
          item.candidateVersionId === version.id,
      );
      if (!record) continue;
      const genericId =
        'issue:' +
        createHash('sha256')
          .update(JSON.stringify([version.id, 'identity', 'subject']))
          .digest('hex');
      const identity = (record.issues || []).filter((issue) => issue.kind === 'identity');
      issues.push(...identity);
      explicitIssues.push(
        ...identity.filter((issue) => issue.id !== genericId && !issue.selfSuggestion),
      );
    }
  }
  const collected = collectEvidencedIdentity(issues, group.report?.subject?.text);
  const hasIdentityContext = !!(
    group.report?.subject ||
    collected.evidence.fullName ||
    collected.evidence.birthDate ||
    collected.unreadableBirthDate ||
    collected.conflicts.length
  );
  const hasUnstructuredIdentityQuestion = explicitIssues.some(
    (issue) =>
      !!(
        hasIdentityContext ||
        issue.textAnchor ||
        issue.questionId ||
        issue.resolution?.outcome === 'unknown' ||
        issue.resolution?.outcome === 'other_person'
      ),
  );
  return {
    evidence: collected.evidence,
    conflicts: collected.conflicts,
    unreadableBirthDate: collected.unreadableBirthDate,
    hasUnstructuredIdentityQuestion,
    currentRefusal: currentIdentityRefusal(issues),
  };
}

export async function getIntakeIdentityReview(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
): Promise<IntakeIdentityReview> {
  return measureImportPhase(
    'review_identity_grounding',
    async () => {
      const review = await getIntakeIdentityReviewInternal(db, root, profileId, id, groupId);
      const rows = db
        .prepare(
          `SELECT n.id FROM notes n WHERE n.kind='person' AND n.person_id!='patient' AND ${noteVisibilitySQL('n')}=0 ORDER BY n.title,n.id LIMIT 101`,
        )
        .all();
      const people = rows.slice(0, 100).map((row) => {
        const note = getNote(db, String(row.id));
        return {
          noteId: note.id,
          personId: note.personId!,
          version: note.version,
          birthDate: typeof note.person.birthDate === 'string' ? note.person.birthDate : null,
          relationship:
            typeof note.person.relationship === 'string' ? note.person.relationship : null,
          fullName:
            typeof note.person.fullName === 'string' && note.person.fullName.trim()
              ? note.person.fullName.trim()
              : note.title,
        };
      });
      const intake = getIntake(db, root, profileId, id);
      const group = intake.workflow?.reportGroups?.find((item) => item.id === groupId);
      const members = group?.versions.at(-1)?.members || [];
      const reviewedProposals = new Map<string | null, IntakeReview>();
      const assigned = members.flatMap((member) =>
        member.occurrences.map((occurrence) => {
          let proposalReview = reviewedProposals.get(occurrence.proposalId);
          if (!proposalReview) {
            proposalReview = reviewIntake(db, root, profileId, id, occurrence.proposalId);
            reviewedProposals.set(occurrence.proposalId, proposalReview);
          }
          const record = proposalReview.records.find(
            (item) =>
              item.id === occurrence.recordId &&
              item.candidateVersionId === member.candidateVersionId,
          );
          return {
            person: record?.identityAttribution?.assignedPerson,
            status: record?.identityReview?.status,
            warnings: record?.identityReview?.warnings || [],
          };
        }),
      );
      const assignedPerson =
        assigned.length &&
        assigned.every((item) => item.person?.personId === assigned[0]?.person?.personId)
          ? assigned[0]?.person
          : undefined;
      const warnings = assigned
        .flatMap((item) => item.warnings)
        .filter(
          (warning, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.kind === warning.kind &&
                candidate.modelBirthDate === warning.modelBirthDate &&
                candidate.savedBirthDate === warning.savedBirthDate &&
                candidate.personName === warning.personName,
            ) === index,
        );
      return {
        ...review,
        ...(warnings.length ? { warnings } : {}),
        people,
        peopleTruncated: rows.length > 100,
        ...(assignedPerson
          ? {
              assignedPerson,
              status: assigned.every((item) => item.status === 'evidenced_match')
                ? ('evidenced_match' as const)
                : ('prior_confirmation' as const),
              blocking: false,
              message: assigned.every((item) => item.status === 'evidenced_match')
                ? 'The printed name uniquely matches a saved name for ' +
                  assignedPerson.fullName +
                  '.'
                : 'This report was assigned to ' + assignedPerson.fullName + '.',
            }
          : {}),
      };
    },
    {},
    { profileId, importId: id },
  );
}
async function getIntakeIdentityReviewInternal(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
): Promise<IntakeIdentityReview> {
  const context = { db, root, profileId, id };
  const intake = getIntake(db, root, profileId, id);
  const group = intake.workflow?.reportGroups?.find((item) => item.id === groupId);
  if (!group) throw new HttpError(404, 'REPORT_GROUP_NOT_FOUND', 'Report group not found');
  const self = selfSnapshot(db);
  const correctionRow = db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Report ownership default' AND json_extract(coverage_json,'$.intakeId')=? AND json_extract(coverage_json,'$.groupId')=? ORDER BY json_extract(coverage_json,'$.revision') DESC,id DESC LIMIT 1",
    )
    .get(id, groupId);
  const correctedAuthority = correctionRow
    ? (json(correctionRow.coverage_json) as { personId: string; noteId: string })
    : null;
  const correctedNote = correctedAuthority ? getNote(db, correctedAuthority.noteId) : null;
  const correctedPerson =
    correctedAuthority && correctedNote
      ? {
          personId: correctedAuthority.personId,
          fullName: correctedNote.person.fullName || correctedNote.title,
        }
      : undefined;
  const groupIdentity = groupRecordIdentity(context, group);
  const latest = group.versions.at(-1);
  const originalFingerprint = identityOriginalFingerprint(
    id,
    intake.sha256,
    group,
    intake.workflow!,
  );
  if (group.basis !== 'report_anchor' || !group.report?.subject) {
    const assessment = assessIdentityPolicy({
      self,
      people: identityPeopleSnapshots(db),
      nameEvidenceGrounded: false,
      evidence: groupIdentity.evidence,
      evidenceConflicts: groupIdentity.conflicts,
      unreadableBirthDate: groupIdentity.unreadableBirthDate,
      group,
      groupVersionId: latest?.id || null,
      originalFingerprint,
      receipts: activeIdentityReceipts(db, intake.workflow?.identityConfirmations),
      hasUnstructuredIdentityQuestion: groupIdentity.hasUnstructuredIdentityQuestion,
      currentRefusal: groupIdentity.currentRefusal,
    });
    return { ...assessment, scope: null, self, correctedPerson };
  }
  let built: BuiltScope;
  try {
    const evidence = await identityEvidence(context, groupId);
    built = buildScope(context, evidence);
    const current = getIntake(db, root, profileId, id);
    retainIdentityGrounding(
      db,
      {
        profileId,
        intakeId: id,
        sourceHash: current.sha256,
        workflow: current.workflow!,
      },
      groupFor(current, groupId),
      built.groundedQuestions,
      built.patientNameGrounded,
      built.groundedNameQuestions,
      originalSubjectBirthDateEvidence(
        evidence.pageText,
        group.report!.subject!.text,
        group.report!.anchor.text,
      ),
    );
    // Record review and its token must observe the same verified authority as
    // this preview. No draft, human receipt or page text is persisted here.
    built = buildScope(context, evidence);
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'IDENTITY_SCOPE') throw error;
    return {
      status: 'conflict',
      blocking: true,
      message: error.message,
      scope: null,
      evidencedIdentity: groupIdentity.evidence,
      self,
      correctedPerson,
      offeredSelfFields: {},
      conflicts: groupIdentity.conflicts,
    };
  }
  const assessment = assessIdentityPolicy({
    self,
    people: identityPeopleSnapshots(db),
    nameEvidenceGrounded: built.patientNameGrounded,
    evidence: built.scope.evidencedIdentity || {},
    evidenceConflicts: built.evidenceConflicts,
    unreadableBirthDate: built.unreadableBirthDate,
    bannerBirthDates: built.bannerBirthDates,
    group,
    groupVersionId: built.scope.groupVersionId,
    originalFingerprint: built.scope.evidenceOriginalFingerprint || originalFingerprint,
    receipts: activeIdentityReceipts(db, intake.workflow?.identityConfirmations),
    hasUnstructuredIdentityQuestion: built.hasUnstructuredIdentityQuestion,
    explicitlyConfirmedOperationId: built.explicitlyConfirmedOperationId,
    currentRefusal: built.currentRefusal,
  });
  return {
    ...assessment,
    scope: built.scope,
    self,
    correctedPerson,
  };
}

export async function getIntakeIdentityScope(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  groupId: string,
): Promise<IntakeIdentityScope> {
  const review = await getIntakeIdentityReview(db, root, profileId, id, groupId);
  if (!review.scope)
    return reject(
      review.status === 'conflict'
        ? review.message
        : 'This report does not need a common identity confirmation',
    );
  return review.scope;
}

export async function confirmIntakeIdentityScope(
  db: DatabaseSync,
  root: string,
  profileId: string,
  id: string,
  input: IntakeIdentityConfirmation,
) {
  if (
    !input?.operationId ||
    !input.scope ||
    !['this_is_me', 'this_is_person'].includes(input.outcome) ||
    ![
      'reviewed_original_and_membership',
      'confirmed_displayed_report_subject',
      'confirmed_displayed_identity_questions',
    ].includes(input.attestation)
  )
    throw new HttpError(
      400,
      'IDENTITY_CONFIRMATION',
      'Explicit confirmation of the displayed report subject or original review is required',
    );
  const context = { db, root, profileId, id };
  // Reconcile a committed lost response against its operation fingerprint before
  // inspecting any later evidence. A receipt never applies to later candidates.
  if (
    getIntake(db, root, profileId, id).workflow?.identityConfirmations?.some(
      (receipt) => receipt.operationId === input.operationId,
    )
  )
    return workflowMutation(db, root, profileId, id, input, () =>
      reject('The retained identity receipt has no matching durable operation'),
    );
  const evidence = await identityEvidence(context, input.scope.groupId);
  return workflowMutation(db, root, profileId, id, input, (workflow) => {
    const built = buildScope(context, evidence);
    const current = built.scope;
    const currentSelf = selfSnapshot(db);
    const answers = input.identityAnswers;
    const yearAnswerAllowed =
      typeof answers?.birthDate === 'string' &&
      /^\d{4}$/.test(answers.birthDate) &&
      current.birthDateReview?.choices.some((choice) => /^\d{4}$/.test(choice)) &&
      Number(answers.birthDate) >= 1 &&
      answers.birthDate <= new Date().toISOString().slice(0, 4);
    if (
      answers !== undefined &&
      (!answers ||
        typeof answers !== 'object' ||
        Array.isArray(answers) ||
        Object.keys(answers).some((key) => key !== 'birthDate') ||
        !current.birthDateReview ||
        (answers.birthDate !== null &&
          !validOnboardingBirthDate(answers.birthDate) &&
          !yearAnswerAllowed))
    )
      throw new HttpError(
        400,
        'IDENTITY_BIRTH_DATE',
        current.birthDateReview?.choices.some((choice) => /^\d{4}$/.test(choice))
          ? 'Confirm a birth year from the original, or explicitly keep it unknown.'
          : 'Confirm a complete birth date from the original, or explicitly keep it unknown.',
      );
    if (current.birthDateReview?.choices.length && !Object.hasOwn(answers || {}, 'birthDate'))
      throw new HttpError(
        400,
        'IDENTITY_BIRTH_DATE',
        'Review the suggested birth date before confirming this report.',
      );
    const reviewedBirthDate = answers?.birthDate || current.evidencedIdentity?.birthDate;
    if (
      input.outcome === 'this_is_me' &&
      reviewedBirthDate &&
      currentSelf.birthDate &&
      !compatibleIdentityBirthDates(reviewedBirthDate, currentSelf.birthDate)
    )
      throw new HttpError(
        409,
        'IDENTITY_CONFLICT',
        'The reviewed birth date differs from Self. Choose another person or add a new person.',
      );
    const assessment = assessIdentityPolicy({
      self: currentSelf,
      people: identityPeopleSnapshots(db),
      nameEvidenceGrounded: built.patientNameGrounded,
      evidence: current.evidencedIdentity || {},
      evidenceConflicts: built.evidenceConflicts,
      unreadableBirthDate: built.unreadableBirthDate,
      bannerBirthDates: built.bannerBirthDates,
      group: groupFor(getIntake(db, root, profileId, id), current.groupId),
      groupVersionId: current.groupVersionId,
      originalFingerprint: current.evidenceOriginalFingerprint || evidence.originalFingerprint,
      receipts: activeIdentityReceipts(db, workflow.identityConfirmations),
      hasUnstructuredIdentityQuestion: built.hasUnstructuredIdentityQuestion,
      explicitlyConfirmedOperationId: built.explicitlyConfirmedOperationId,
      currentRefusal: built.currentRefusal,
    });
    if (input.outcome === 'this_is_me' && assessment.selfBirthDateConflict)
      throw new HttpError(
        409,
        'IDENTITY_CONFLICT',
        'The report birth date differs from Self. Choose another person or add a new person.',
      );
    if (assessment.conflicts.some((conflict) => conflict.reason === 'evidence_disagreement'))
      throw new HttpError(
        409,
        'IDENTITY_CONFLICT',
        'The report contains contradictory identity evidence; review its individual entries first',
      );
    if (input.scope.selfVersion !== undefined && input.scope.selfVersion !== currentSelf.version)
      throw new HttpError(
        409,
        'SELF_VERSION_CONFLICT',
        'Self changed while identity was being reviewed; refresh before confirming',
      );
    if (
      input.outcome === 'this_is_me' &&
      assessment.status === 'confirmation_required' &&
      !current.targets.length
    )
      throw new HttpError(
        409,
        'IDENTITY_SCOPE_EMPTY',
        'Identity confirmation requires a current displayed identity question',
      );
    const confirmationTargets = current.assignmentTargets || current.targets;
    if (!confirmationTargets.length && input.outcome === 'this_is_person')
      throw new HttpError(
        409,
        'IDENTITY_SCOPE_EMPTY',
        'Identity confirmation requires at least one exact current record and issue',
      );
    // HTTP responses qualify evidence URLs for the active profile. Compare that
    // presentation-only prefix canonically without changing the durable request.
    const profilePrefix = `/api/profiles/${encodeURIComponent(profileId)}/`;
    const submittedUrl = input.scope.original?.contentUrl;
    const submitted = {
      ...input.scope,
      original: {
        ...input.scope.original,
        contentUrl: submittedUrl?.startsWith(profilePrefix)
          ? '/api/' + submittedUrl.slice(profilePrefix.length)
          : submittedUrl,
      },
    };
    if (canonicalLiteral(current) !== canonicalLiteral(submitted))
      return reject(
        'The identity scope changed; review the current original and exact members again',
      );
    if (current.questions?.length && input.attestation !== 'confirmed_displayed_identity_questions')
      throw new HttpError(
        400,
        'IDENTITY_CONFIRMATION',
        'Read and explicitly confirm every displayed identity question for this report',
      );
    const confirmedPrintedName =
      current.evidencedIdentity?.fullName ||
      (typeof input.printedName === 'string'
        ? input.printedName.trim()
        : /[;\n]/.test(current.subject.text)
          ? undefined
          : printedIdentityName(current.subject.text));
    if (
      !confirmedPrintedName ||
      (input.printedName !== undefined &&
        (typeof input.printedName !== 'string' ||
          (current.evidencedIdentity?.fullName
            ? input.printedName.trim() !== current.evidencedIdentity.fullName
            : !current.subject.text.includes(input.printedName.trim())))) ||
      (!current.evidencedIdentity?.fullName &&
        printedIdentityName(confirmedPrintedName) !== confirmedPrintedName)
    )
      throw new HttpError(
        400,
        'IDENTITY_PRINTED_NAME',
        'Select the exact printed person name from the displayed subject before confirming; demographic sentences are not names',
      );
    const futureChoice = input.futureNameOwner || { outcome: 'ask' as const };
    if (
      input.futureNameOwner &&
      (!assessment.challengedName ||
        !['self', 'person', 'ask'].includes(futureChoice.outcome) ||
        (futureChoice.outcome === 'person' &&
          (typeof futureChoice.noteId !== 'string' ||
            !Number.isSafeInteger(futureChoice.expectedVersion))) ||
        (futureChoice.outcome !== 'person' && futureChoice.noteId !== undefined))
    )
      throw new HttpError(
        400,
        'IDENTITY_NAME_CHOICE',
        'Choose how later reports should use the challenged printed name.',
      );
    let futureTarget: { noteId: string; personId: string } | null = null;
    if (assessment.challengedName && futureChoice.outcome === 'self')
      futureTarget = { noteId: 'person-note:self', personId: 'patient' };
    if (assessment.challengedName && futureChoice.outcome === 'person') {
      const note = getNote(db, futureChoice.noteId!);
      if (
        note.kind !== 'person' ||
        note.archived ||
        note.version !== futureChoice.expectedVersion ||
        !note.personId ||
        note.personId === 'patient'
      )
        throw new HttpError(
          409,
          'IDENTITY_NAME_CHOICE',
          'The selected future name owner changed. Refresh the identity review.',
        );
      futureTarget = { noteId: note.id, personId: note.personId };
    }
    const challengedNotes = assessment.challengedName
      ? challengedNameNoteIds(db, confirmedPrintedName)
      : [];
    if (
      ['prior_confirmation', 'evidenced_match'].includes(assessment.status) &&
      input.selfUpdate === undefined &&
      input.outcome === 'this_is_me' &&
      getNote(db, 'person-note:self').person.sourceKnownNames?.some(
        (entry) => entry.name === confirmedPrintedName,
      ) &&
      activeIdentityReceipts(db, workflow.identityConfirmations)?.some(
        (receipt) =>
          receipt.outcome === 'this_is_me' &&
          identityReceiptAppliesToCurrentBoundary(receipt, {
            ...current,
            evidenceOriginalFingerprint: current.evidenceOriginalFingerprint || null,
          }) &&
          (current.assignmentTargets || current.targets).every((target) =>
            (receipt.scope.assignmentTargets || receipt.scope.targets).some(
              (prior) =>
                prior.candidateId === target.candidateId &&
                prior.candidateVersionId === target.candidateVersionId &&
                prior.proposalId === target.proposalId &&
                prior.recordId === target.recordId,
            ),
          ),
      )
    )
      throw new HttpError(
        409,
        'IDENTITY_ALREADY_RESOLVED',
        'This report identity is already resolved; no additional confirmation is needed',
      );
    let assignedPerson: IntakeIdentityPerson | undefined;
    if (input.outcome === 'this_is_person') {
      if (input.selfUpdate !== undefined)
        throw new HttpError(
          400,
          'IDENTITY_SELECTION',
          'Self fields cannot be changed when assigning another person',
        );
      const selection = input.personSelection;
      if (!selection || typeof selection !== 'object')
        throw new HttpError(
          400,
          'IDENTITY_SELECTION',
          'Choose an existing person or create a family person',
        );
      let note;
      if ('noteId' in selection && !('newPerson' in selection)) {
        if (
          typeof selection.noteId !== 'string' ||
          !Number.isSafeInteger(selection.expectedVersion)
        )
          throw new HttpError(400, 'IDENTITY_SELECTION', 'Choose the displayed person version');
        note = getNote(db, selection.noteId);
        if (
          note.kind !== 'person' ||
          !note.personId ||
          note.personId === 'patient' ||
          note.archived
        )
          throw new HttpError(
            400,
            'IDENTITY_SELECTION',
            'Choose an available person other than Self',
          );
        if (note.version !== selection.expectedVersion)
          throw new HttpError(
            409,
            'PERSON_VERSION_CONFLICT',
            'This person changed; review the current person before confirming',
          );
        const printedBirthDate = reviewedBirthDate;
        const savedBirthDate =
          typeof note.person.birthDate === 'string' ? note.person.birthDate : null;
        if (
          printedBirthDate &&
          savedBirthDate &&
          !compatibleIdentityBirthDates(printedBirthDate, savedBirthDate)
        )
          throw new HttpError(
            409,
            'IDENTITY_CONFLICT',
            'The report birth date differs from this person. Choose another person or add a new person.',
          );
      } else if ('newPerson' in selection && !('noteId' in selection)) {
        const person = selection.newPerson;
        if (
          !person ||
          typeof person.fullName !== 'string' ||
          !person.fullName.trim() ||
          person.fullName.trim().length > 200 ||
          /[\x00-\x1f]/.test(person.fullName) ||
          (person.relationship !== undefined &&
            (typeof person.relationship !== 'string' || person.relationship.length > 200))
        )
          throw new HttpError(
            400,
            'IDENTITY_SELECTION',
            'Enter a name and an optional relationship for this family person',
          );
        const self = getNote(db, 'patient');
        if (
          matchesSelfIdentityName(person.fullName, [
            String(self.person.fullName || ''),
            ...effectiveKnownNames(db, self.id, self.person),
          ])
        )
          throw new HttpError(
            409,
            'INTAKE_PERSON_SELF',
            'This name belongs to Self. Choose Me (Self) rather than creating another Person.',
          );
        note = createIntakeFamilyPersonInTransaction(
          db,
          person.fullName.trim(),
          person.relationship?.trim(),
        );
      } else
        throw new HttpError(400, 'IDENTITY_SELECTION', 'Choose exactly one person destination');
      assignedPerson = {
        noteId: note.id,
        personId: note.personId!,
        version: note.version,
        fullName:
          typeof note.person.fullName === 'string' && note.person.fullName.trim()
            ? note.person.fullName.trim()
            : note.title,
      };
    } else if (input.personSelection !== undefined)
      throw new HttpError(
        400,
        'IDENTITY_SELECTION',
        'A separate person cannot be selected when confirming Self',
      );
    let selfUpdate:
      | {
          noteId: 'person-note:self';
          versionBefore: number;
          versionAfter: number;
          fields: NonNullable<IntakeIdentityConfirmation['selfUpdate']>['fields'];
        }
      | undefined;
    if (input.selfUpdate !== undefined) {
      const selected = input.selfUpdate;
      if (
        !selected ||
        typeof selected !== 'object' ||
        Array.isArray(selected) ||
        !Number.isSafeInteger(selected.expectedVersion) ||
        selected.expectedVersion < 1 ||
        !selected.fields ||
        typeof selected.fields !== 'object' ||
        Array.isArray(selected.fields)
      )
        throw new HttpError(
          400,
          'SELF_IDENTITY_UPDATE',
          'Select one or both displayed blank Self identity fields',
        );
      if (selected.expectedVersion !== currentSelf.version)
        throw new HttpError(
          409,
          'SELF_VERSION_CONFLICT',
          'Self changed while identity was being reviewed; refresh before confirming',
        );
      if (
        !Object.keys(selected.fields).length ||
        Object.keys(selected.fields).some((key) => !['fullName', 'birthDate'].includes(key)) ||
        (Object.keys(selected.fields) as ('fullName' | 'birthDate')[]).some(
          (key) => selected.fields[key] !== assessment.offeredSelfFields[key],
        )
      )
        throw new HttpError(
          409,
          'SELF_IDENTITY_UPDATE',
          'Select only the unchanged blank Self values displayed with this identity scope',
        );
      const updated = updateBlankSelfIdentityFieldsInTransaction(
        db,
        selected.expectedVersion,
        selected.fields,
      );
      selfUpdate = {
        noteId: 'person-note:self',
        ...updated,
        fields: structuredClone(selected.fields),
      };
    }
    const knownNameAdded = safeSourceIdentityName(confirmedPrintedName)
      ? rememberSourceNameInTransaction(db, assignedPerson?.noteId || 'person-note:self', {
          name: confirmedPrintedName,
          operationId: input.operationId,
          intakeId: id,
          sourceHash: current.sourceHash,
          groupId: current.groupId,
          subjectText: current.subject.text,
        })
      : undefined;
    if (assessment.challengedName && safeSourceIdentityName(confirmedPrintedName))
      rememberFutureNameOwner(
        db,
        confirmedPrintedName,
        futureTarget,
        input.operationId,
        challengedNotes,
      );
    if (assignedPerson) assignedPerson.version = getNote(db, assignedPerson.noteId).version;
    if (selfUpdate) selfUpdate.versionAfter = getNote(db, 'person-note:self').version;
    const at = now();
    const draftIds: string[] = [];
    // All validation precedes mutation; one durable transaction appends every exact draft and receipt.
    for (const target of confirmationTargets) {
      const previous = currentReviewDraft(
        workflow,
        target.proposalId,
        target.recordId,
        target.candidateVersionId,
      );
      const draftId = input.operationId + ':' + hash(target);
      const correction = assignedPerson
        ? { subject: 'other', personId: assignedPerson.personId }
        : { subject: 'self', personId: undefined };
      workflow.reviewDrafts.push({
        ...previous,
        id: draftId,
        proposalId: target.proposalId,
        recordId: target.recordId,
        candidateId: target.candidateId,
        candidateVersionId: target.candidateVersionId,
        mapping: { ...previous?.mapping, ...correction },
        resolutions: [
          ...(previous?.resolutions || []),
          ...(target.issueIds || [target.issueId]).map((issueId) => ({
            issueId,
            outcome: assignedPerson ? ('other_person' as const) : ('this_is_me' as const),
            mapping: correction,
            at,
            operationId: input.operationId,
          })),
        ],
        disposition: previous?.disposition || 'pending',
        at,
      });
      draftIds.push(draftId);
    }
    (workflow.identityConfirmations ||= []).push({
      operationId: input.operationId,
      at,
      scope: current,
      outcome: input.outcome,
      attestation: input.attestation,
      ...(answers ? { identityAnswers: structuredClone(answers) } : {}),
      draftIds,
      ...(assignedPerson ? { assignedPerson } : {}),
      ...(knownNameAdded ? { knownNameAdded } : {}),
      confirmedPrintedName,
      ...(selfUpdate ? { selfUpdate } : {}),
    });
  });
}
