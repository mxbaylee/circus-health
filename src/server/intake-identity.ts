import { savedKnownNames } from '../shared/self-identity.ts';
import { measureImportPhase } from './import-diagnostics.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, now } from './database.ts';
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
} from './intake-identity-policy.ts';
import { retainIdentityGrounding } from './intake-identity-grounding.ts';
import { getNote, updateBlankSelfIdentityFieldsInTransaction } from './notes.ts';
import type {
  Intake,
  IntakeReview,
  IntakeReportGroup,
  IntakeReviewIssue,
} from '../shared/intake.ts';
import type {
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
  };
}
interface BuiltScope {
  scope: IntakeIdentityScope;
  evidenceConflicts: IntakeIdentityConflict[];
  hasUnstructuredIdentityQuestion: boolean;
  explicitlyConfirmedOperationId?: string;
  currentRefusal?: 'unknown' | 'other_person';
  groundedQuestions: { issue: IntakeReviewIssue; receipt: IntakeIdentityReceipt }[];
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
  // A competing subject claim at the same printed report boundary prevents common confirmation.
  if (
    intake.workflow!.reportGroups!.some(
      (other) =>
        other.id !== group.id &&
        other.memberId === group.memberId &&
        canonicalLiteral(other.report?.anchor) === canonicalLiteral(group.report!.anchor),
    )
  )
    return reject(
      'This report boundary has conflicting subject claims; resolve identity individually',
    );
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
  const targets: IntakeIdentityScope['targets'] = [];
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
      // Subject mappings and previous explicit other-person answers remain hard boundaries.
      if (
        (record.mapping.subject && !['self', 'unknown'].includes(record.mapping.subject)) ||
        record.draft?.resolutions.some((resolution) => resolution.outcome === 'other_person')
      )
        return reject(
          'This member has additional or contradictory identity clues; review it individually',
        );
      const unresolved = identity.filter((issue) => issue.status === 'unresolved');
      const explicitIssues = identity
        .filter((issue) => issue.id !== genericId && !issue.selfSuggestion)
        .filter((issue) => {
          const receipt = repeatedIdentityQuestionReceipt({
            issue,
            group,
            receipts: intake.workflow?.identityConfirmations,
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
  const collected = collectEvidencedIdentity(identityIssues);
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
    !!receipt.scope.targets.length &&
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
          receipts: intake.workflow?.identityConfirmations,
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
  if (targets.length > 1000 || questions.size > 100)
    return reject('Review these identity questions individually; the displayed scope is too large');
  const snapshot = {
    profileId,
    intakeId: id,
    intakeVersion: intake.version,
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
    ...(questions.size ? { questions: [...questions.values()] } : {}),
  };
  const scope: IntakeIdentityScope = {
    ...snapshot,
    scopeToken: hash([snapshot, evidence.sourceHash]),
  };
  const explicitlyConfirmedOperationId = scope.targets.length
    ? undefined
    : exactCurrentIdentityResolutionOperationId({
        receipts: intake.workflow?.identityConfirmations,
        occurrences: explicitOccurrences,
        receiptApplies,
      });
  return {
    scope,
    evidenceConflicts: collected.conflicts,
    hasUnstructuredIdentityQuestion,
    currentRefusal: currentIdentityRefusal(identityIssues),
    groundedQuestions,
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
    knownNames: savedKnownNames(self.person.knownNames),
    birthDate,
  };
}

function groupRecordIdentity(
  context: Context,
  group: IntakeReportGroup,
): {
  evidence: ReturnType<typeof collectEvidencedIdentity>['evidence'];
  conflicts: IntakeIdentityConflict[];
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
  const collected = collectEvidencedIdentity(issues);
  const hasIdentityContext = !!(
    group.report?.subject ||
    collected.evidence.fullName ||
    collected.evidence.birthDate ||
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
    () => getIntakeIdentityReviewInternal(db, root, profileId, id, groupId),
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
      evidence: groupIdentity.evidence,
      evidenceConflicts: groupIdentity.conflicts,
      group,
      groupVersionId: latest?.id || null,
      originalFingerprint,
      receipts: intake.workflow?.identityConfirmations,
      hasUnstructuredIdentityQuestion: groupIdentity.hasUnstructuredIdentityQuestion,
      currentRefusal: groupIdentity.currentRefusal,
    });
    return { ...assessment, scope: null, self };
  }
  const competing = intake.workflow!.reportGroups!.some(
    (other) =>
      other.id !== group.id &&
      other.memberId === group.memberId &&
      canonicalLiteral(other.report?.anchor) === canonicalLiteral(group.report!.anchor),
  );
  if (competing)
    return {
      status: 'conflict',
      blocking: true,
      message: 'This report boundary has conflicting printed subject claims.',
      scope: null,
      evidencedIdentity: groupIdentity.evidence,
      self,
      offeredSelfFields: {},
      conflicts: groupIdentity.conflicts,
    };
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
    );
    // Record review and its token must observe the same verified authority as
    // this preview. No draft, human receipt or page text is persisted here.
    if (built.groundedQuestions.length) built = buildScope(context, evidence);
  } catch (error) {
    if (!(error instanceof HttpError) || error.code !== 'IDENTITY_SCOPE') throw error;
    return {
      status: 'conflict',
      blocking: true,
      message: error.message,
      scope: null,
      evidencedIdentity: groupIdentity.evidence,
      self,
      offeredSelfFields: {},
      conflicts: groupIdentity.conflicts,
    };
  }
  const assessment = assessIdentityPolicy({
    self,
    evidence: built.scope.evidencedIdentity || {},
    evidenceConflicts: built.evidenceConflicts,
    group,
    groupVersionId: built.scope.groupVersionId,
    originalFingerprint: built.scope.evidenceOriginalFingerprint || originalFingerprint,
    receipts: intake.workflow?.identityConfirmations,
    hasUnstructuredIdentityQuestion: built.hasUnstructuredIdentityQuestion,
    explicitlyConfirmedOperationId: built.explicitlyConfirmedOperationId,
    currentRefusal: built.currentRefusal,
  });
  return {
    ...assessment,
    scope: assessment.status === 'conflict' ? null : built.scope,
    self,
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
    input.outcome !== 'this_is_me' ||
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
    const assessment = assessIdentityPolicy({
      self: currentSelf,
      evidence: current.evidencedIdentity || {},
      evidenceConflicts: built.evidenceConflicts,
      group: groupFor(getIntake(db, root, profileId, id), current.groupId),
      groupVersionId: current.groupVersionId,
      originalFingerprint: current.evidenceOriginalFingerprint || evidence.originalFingerprint,
      receipts: workflow.identityConfirmations,
      hasUnstructuredIdentityQuestion: built.hasUnstructuredIdentityQuestion,
      explicitlyConfirmedOperationId: built.explicitlyConfirmedOperationId,
      currentRefusal: built.currentRefusal,
    });
    if (assessment.status === 'conflict')
      throw new HttpError(
        409,
        'IDENTITY_CONFLICT',
        'The evidenced name or date of birth conflicts with Self and cannot be bypassed',
      );
    if (assessment.status === 'confirmation_required' && !current.targets.length)
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
    if (
      ['prior_confirmation', 'evidenced_match'].includes(assessment.status) &&
      input.selfUpdate === undefined
    )
      throw new HttpError(
        409,
        'IDENTITY_ALREADY_RESOLVED',
        'This report identity is already resolved; no additional confirmation is needed',
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
    const at = now();
    const draftIds: string[] = [];
    // All validation precedes mutation; one durable transaction appends every exact draft and receipt.
    for (const target of current.targets) {
      const previous = currentReviewDraft(
        workflow,
        target.proposalId,
        target.recordId,
        target.candidateVersionId,
      );
      const draftId = input.operationId + ':' + hash(target);
      const correction = { subject: 'self' };
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
            outcome: 'this_is_me' as const,
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
      draftIds,
      ...(selfUpdate ? { selfUpdate } : {}),
    });
  });
}
