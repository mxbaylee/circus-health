import {
  bindReviewRecordIssues,
  reviewRecordIssues,
  reviewIssueCollection,
  type ReviewIssueCollection,
} from './intake-review-issue-state.ts';
import {
  bindReviewRecordQuestions,
  mapReviewRecordQuestions,
  reviewRecordQuestions,
  type ReviewQuestionSelection,
} from './intake-review-question-selection.ts';
import { selectedReportGroups } from './intake-selected-report-groups.ts';
import {
  reviewDraftResolutions,
  latestReviewDraftResolution,
  knownReviewDraftResolution,
} from './intake-review-draft-selection.ts';
import { selectedSequence, type SelectedSequence } from './intake-selected-sequence.ts';
import { candidateSourceIdentityV1 } from './intake-source-identity.ts';
import { compatibleIdentityBirthDates } from '../shared/self-identity.ts';
import { createHash } from 'node:crypto';
import { HttpError, now, safeText } from './database.ts';
import { workflowCounts } from './intake-workflow-reader.ts';
import { legacyWorkflowCountReader } from './intake-workflow-legacy-reader.ts';
import { canonicalLiteral } from './intake-format.ts';
import { recordIntakeCandidateVersionHash } from './intake-file-work.ts';
import { validatedIntakePeople } from './intake-people-format.ts';
import { recordReportGroups, reportGroupsWithLegacyFallback } from './intake-report-groups.ts';
import { intakeReportSourceForMember } from './intake-report-source.ts';
import {
  assessIdentityPolicy,
  confirmedPersonReceipt,
  collectEvidencedIdentity,
  isGenericNameConfirmation,
  competingIdentityBoundaries,
  identityBoundaryRepairApplies,
  currentIdentityRefusal,
  repeatedIdentityQuestionReceipt,
  exactCurrentIdentityResolutionOperationId,
  identityReceiptAppliesToCurrentBoundary,
  identityOriginalFingerprint,
  modelBirthDateWarnings,
  type IdentityPolicyPersonSnapshot,
} from './intake-identity-policy.ts';
import type { IdentityGroundingLookup } from './intake-identity-grounding.ts';
import type { ReportGroupContribution } from './intake-report-groups.ts';
import {
  actionableIssueKind,
  currentReviewDraft,
  issueKind,
  reviewIssues,
  type SuggestionEvidenceScope,
} from './intake-review.ts';
import { clinicalMappingEnvelope, sourceContextEnvelope } from './clinical-import.ts';
import type {
  IntakeClinicalMapping,
  IntakeIssueResolution,
  IntakeQuestion,
  IntakeQuestionAnswer,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraft,
  IntakeReviewIssue,
  IntakeReviewGroupReference,
  IntakeWorkflow,
  IntakePackageFailure,
} from '../shared/intake.ts';
import type { IntakeEntry } from './intake-format.ts';
import type { IntakeIdentitySelfSnapshot } from '../shared/intake-identity.ts';

interface WorkflowQuestionAnswer extends IntakeQuestionAnswer {
  outcome?:
    'same_event' | 'changed_version' | 'distinct' | 'unresolved' | IntakeIssueResolution['outcome'];
  otherRecordId?: string;
}

interface WorkflowQuestion extends Omit<IntakeQuestion, 'answers'> {
  answers: WorkflowQuestionAnswer[];
}

type WorkflowDecision = IntakeWorkflow['decisions'][number] & { evidence?: unknown };

interface DurableWorkflow extends Omit<IntakeWorkflow, 'questions' | 'decisions' | 'reviewDrafts'> {
  questions: WorkflowQuestion[];
  decisions: WorkflowDecision[];
  reviewDrafts: IntakeReviewDraft[];
  operations: { id: string; fingerprint: string; at: string }[];
}

interface IntakeWorkflowDetails {
  packageFailures?: Record<string, IntakePackageFailure>;
  workflow?: DurableWorkflow;
  proposals?: {
    id: string;
    manualSourceRecord?: import('../shared/intake-manual-source-record.ts').ManualSourceRecordReceipt;
    sourceTextRevisionId?: string | null;
    sourceTextDependencyToken?: string | null;
  }[];
}

/** Same clinical payload derived from changed text requires its own review version. */
export function intakeCandidateVersionId(
  details: IntakeWorkflowDetails,
  proposalId: string | null,
  entry: Pick<IntakeEntry, 'value'>,
): string {
  const proposal = details.proposals?.find((p) => p.id === proposalId);
  const revision = proposal?.sourceTextDependencyToken || proposal?.sourceTextRevisionId;
  return intakeCandidateVersionIdForRevision(entry, revision);
}
export function intakeCandidateVersionIdForRevision(
  entry: Pick<IntakeEntry, 'value'>,
  revision?: string | null,
): string {
  return (
    'candidate-version:' +
    workflowHash(
      revision ? [canonicalLiteral(entry.value), revision] : canonicalLiteral(entry.value),
      recordIntakeCandidateVersionHash,
    )
  );
}

interface WorkflowFile {
  id: string;
  sha256: string;
  mime_type?: string;
}

interface WorkflowQuestionInput {
  key: string;
  candidateId?: string | null;
  candidateVersionId?: string | null;
  prompt: string;
  locator: string;
  field?: string | null;
}

interface WorkflowSummaryOptions {
  sourceContextVersionIds?: Set<string>;
}

const typedReviewIssues = reviewIssues as unknown as (
  record: IntakeReview['records'][number],
  entry: IntakeEntry,
  questions: ReturnType<typeof reviewRecordQuestions>,
  metadataScope: SuggestionEvidenceScope,
  sink?: ReviewIssueCollection,
) => ReviewIssueCollection;
const typedActionableIssueKind = actionableIssueKind as unknown as (
  prompt: string,
  field?: string | null,
) => IntakeReviewIssue['kind'];

export const workflowHash = (value: unknown, observeInput?: (input: string) => void): string => {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  observeInput?.(input);
  return createHash('sha256').update(input).digest('hex');
};
export function intakeWorkflow(details: IntakeWorkflowDetails): DurableWorkflow {
  const workflow = (details.workflow ||= {
    format: 'health-intake-workflow-v1',
    questions: [],
    candidates: [],
    plans: [],
    decisions: [],
    reviewDrafts: [],
    operations: [],
  });
  workflow.operations ||= [];
  workflow.reviewDrafts ||= [];
  return workflow;
}
export const intakeCandidateId = candidateSourceIdentityV1;

export function recordCandidateVersions(
  file: WorkflowFile,
  details: IntakeWorkflowDetails,
  entries: IntakeEntry[],
  proposalId: string | null,
  batchId: string | null = null,
): void {
  const workflow = intakeWorkflow(details);
  const contributions: ReportGroupContribution[] = [];
  for (const entry of entries) {
    const id = intakeCandidateId(file, entry),
      versionId = intakeCandidateVersionId(details, proposalId, entry);
    let candidate = workflow.candidates.find((item) => item.id === id);
    if (sourceContextEnvelope(entry.value)) {
      const retainedVersion = candidate?.versions.find((item) => item.id === versionId);
      if (retainedVersion) retainedVersion.sourceContext = true;
      continue;
    }
    if (!candidate) {
      candidate = {
        id,
        envelopeId: entry.value.id,
        sourceSystem: entry.value.provenance.sourceSystem,
        sourceRecordId: entry.value.provenance.sourceRecordId,
        versions: [],
      };
      workflow.candidates.push(candidate);
    }
    let version = candidate.versions.find((item) => item.id === versionId);
    if (!version) {
      // New evidence cannot silently close an earlier pending review or its drafts.
      version = {
        id: versionId,
        contentDigest: workflowHash(canonicalLiteral(entry.value)),
        status: 'pending',
        createdAt: now(),
        occurrences: [],
      };
      candidate.versions.push(version);
    }
    const peopleCount = validatedIntakePeople(entry.value).length;
    if (peopleCount) {
      version.peopleCount = peopleCount;
      version.peopleOnly = Object.keys(clinicalMappingEnvelope(entry.value)).length === 0;
    }
    const occurrence = {
      proposalId,
      recordId: `${proposalId || file.id}:line:${entry.line}`,
      batchId,
      locator: entry.value.provenance.locator,
    };
    if (
      !version.occurrences.some(
        (item) => item.recordId === occurrence.recordId && item.batchId === batchId,
      )
    )
      version.occurrences.push(occurrence);
    contributions.push({
      value: entry.value,
      candidateId: id,
      candidateVersionId: versionId,
      occurrence,
      entryLine: entry.line,
    });
    const clinical = clinicalMappingEnvelope(entry.value);
    for (const uncertainty of Array.isArray(clinical.uncertainties) ? clinical.uncertainties : []) {
      if (typeof uncertainty !== 'string' || !uncertainty.trim()) continue;
      if (
        issueKind(uncertainty) === 'information' ||
        clinical.reviewIssues ||
        entry.value.reviewIssues
      )
        continue;
      addWorkflowQuestion(file, workflow, {
        key: workflowHash([id, versionId, uncertainty]),
        candidateId: id,
        candidateVersionId: versionId,
        prompt: uncertainty,
        locator: entry.value.provenance.locator,
      });
    }
  }
  recordReportGroups(file, workflow, contributions, entries);
}
export function intakeWorkflowQuestionValue(file: WorkflowFile, input: WorkflowQuestionInput) {
  const key = safeText(input.key, 'question key', 200),
    prompt = safeText(input.prompt, 'question', 4000).trim(),
    locator = safeText(input.locator, 'question evidence locator', 2000).trim();
  if (!key || !prompt || !locator)
    throw new HttpError(
      400,
      'QUESTION_INPUT',
      'Question key, prompt and original locator are required',
    );
  const id = 'question:' + workflowHash([file.id, key]);
  return {
    id,
    key,
    candidateId: input.candidateId || null,
    candidateVersionId: input.candidateVersionId || null,
    prompt,
    locator,
    field: input.field ? safeText(input.field, 'question field', 100) : null,
  };
}
export function addWorkflowQuestion(
  file: WorkflowFile,
  workflow: DurableWorkflow,
  input: WorkflowQuestionInput,
): WorkflowQuestion {
  const value = intakeWorkflowQuestionValue(file, input);
  if (input.candidateId && !workflow.candidates.some((item) => item.id === input.candidateId))
    throw new HttpError(
      404,
      'CANDIDATE_NOT_FOUND',
      'Question record does not belong to this delivery',
    );
  const existing = workflow.questions.find((item) => item.id === value.id);
  if (existing) {
    if (
      Object.entries(value).some(
        ([key, item]) => (existing as unknown as Record<string, unknown>)[key] !== item,
      )
    )
      throw new HttpError(
        409,
        'QUESTION_CONFLICT',
        'This question key already refers to different evidence',
      );
    return existing;
  }
  const question: WorkflowQuestion = {
    ...value,
    status: 'unanswered',
    createdAt: now(),
    answers: [],
  };
  workflow.questions.push(question);
  return question;
}
export type WorkflowReviewGroup = import('./intake-identity-policy.ts').IdentityBoundaryHeader &
  Pick<import('../shared/intake.ts').IntakeReportGroup, 'basis'>;
export interface WorkflowReviewScope {
  close?(): void;
  issueSink?(record: IntakeReview['records'][number]): ReviewIssueCollection;
  versionId(proposalId: string | null, entry: IntakeEntry): string;
  references(
    candidateId: string,
    versionId: string,
    recordId: string,
    proposalId: string | null,
  ): import('../shared/intake-report-group-links.ts').IntakeReviewGroupLinks;
  reportSource(
    record: IntakeReview['records'][number],
    proposalId: string | null,
  ): string | undefined;
  questions(candidateId: string, versionId: string): ReviewQuestionSelection;
  accepted(candidateId: string, versionId: string): boolean;
  draft(proposalId: string | null, recordId: string, versionId: string): IntakeReviewDraft | null;
  firstVersion(candidateId: string): string | undefined;
  keptOriginal(candidateId: string, versionId: string): boolean;
  group(reference: IntakeReviewGroupReference): WorkflowReviewGroup | undefined;
  identityGroup(id: string): WorkflowReviewGroup | undefined;
  currentVersion(group: WorkflowReviewGroup): string | null;
  membership(
    group: WorkflowReviewGroup,
  ): import('./intake-identity-policy.ts').CurrentIdentityReceiptBoundary['membership'];
  originalFingerprint(group: WorkflowReviewGroup): string;
  receipts: SelectedSequence<import('./intake-identity-policy.ts').IdentityPolicyReceipt>;
  packageEvidence: boolean;
  manual(
    proposalId: string | null,
  ): import('../shared/intake-manual-source-record.ts').ManualSourceRecordReceipt | undefined;
  competingBoundaryUnrepaired(
    group: WorkflowReviewGroup,
    operationId: string | undefined,
    target: import('../shared/intake-identity.ts').IntakeIdentityScope['targets'][number],
  ): boolean;
  /** Complete proposal/report identity facts, including every off-page occurrence. */
  evidence(
    group: WorkflowReviewGroup | null,
    record: IntakeReview['records'][number],
    review: IntakeReview,
    original: import('./intake-evidence-dates.ts').BirthDateEvidence | undefined,
  ): {
    collected: ReturnType<typeof collectEvidencedIdentity>;
    structured: ReturnType<typeof collectEvidencedIdentity>['evidence'];
  };
}
export interface SelectedWorkflowIdentityContext {
  profileId: string;
  people?: IdentityPolicyPersonSnapshot[];
  copiedManualSourceApplies?: NonNullable<
    Parameters<typeof workflowReview>[5]
  >['copiedManualSourceApplies'];
  resolutionCurrent?: NonNullable<Parameters<typeof workflowReview>[5]>['resolutionCurrent'];
  grounded(
    group: WorkflowReviewGroup,
    issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>,
    receipt: import('./intake-identity-policy.ts').IdentityGroundingReceipt,
  ): boolean;
  originalBirthDateEvidence?: (
    group: WorkflowReviewGroup,
  ) => import('./intake-evidence-dates.ts').BirthDateEvidence | undefined;
  subjectGrounded?: (group: WorkflowReviewGroup) => boolean;
  nameQuestionGrounded?: (
    group: WorkflowReviewGroup,
    issue: Pick<IntakeReviewIssue, 'prompt' | 'textAnchor'>,
  ) => boolean;
}
export function workflowReview<T extends IntakeReview>(
  file: WorkflowFile,
  details: IntakeWorkflowDetails,
  review: T,
  entries: IntakeEntry[],
  self?: IntakeIdentitySelfSnapshot,
  identityContext?: {
    profileId: string;
    copiedManualSourceApplies?: (
      receipt: import('../shared/intake-manual-source-record.ts').ManualSourceRecordReceipt,
      proposalId: string,
    ) => boolean;
    activeReceipts?: (
      receipts: IntakeWorkflow['identityConfirmations'],
    ) => IntakeWorkflow['identityConfirmations'];
    grounded: IdentityGroundingLookup;
    people?: IdentityPolicyPersonSnapshot[];
    originalBirthDateEvidence?: (
      group: import('../shared/intake.ts').IntakeReportGroup,
    ) => import('./intake-evidence-dates.ts').BirthDateEvidence | undefined;
    subjectGrounded?: (group: import('../shared/intake.ts').IntakeReportGroup) => boolean;
    nameQuestionGrounded?: (
      group: import('../shared/intake.ts').IntakeReportGroup,
      issue: Pick<import('../shared/intake.ts').IntakeReviewIssue, 'prompt' | 'textAnchor'>,
    ) => boolean;
    resolutionCurrent?: (
      resolution: import('../shared/intake.ts').IntakeIssueResolution,
      mapping: Partial<IntakeClinicalMapping>,
    ) => boolean;
  },
): T {
  const retainedWorkflow = intakeWorkflow(details);
  const workflow = identityContext?.activeReceipts
    ? {
        ...retainedWorkflow,
        identityConfirmations: identityContext.activeReceipts(
          retainedWorkflow.identityConfirmations,
        ),
      }
    : retainedWorkflow;
  const reportGroups = reportGroupsWithLegacyFallback(workflow);
  const groupReferences = new Map<string, IntakeReviewGroupReference[]>();
  for (const group of reportGroups) {
    const seen = new Set<string>();
    // Each occurrence keeps the first immutable group version that introduced it.
    // A later cumulative version may have a different report-source context.
    for (const version of group.versions)
      for (const member of version.members)
        for (const occurrence of member.occurrences) {
          const key = JSON.stringify([
            member.candidateId,
            member.candidateVersionId,
            occurrence.recordId,
            occurrence.proposalId,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          const refs = groupReferences.get(key) || [];
          refs.push({ groupId: group.id, groupVersionId: version.id });
          groupReferences.set(key, refs);
        }
  }
  const fullGroup = (group: WorkflowReviewGroup) =>
    reportGroups.find((item) => item.id === group.id)!;
  const scope: WorkflowReviewScope = {
    versionId: (proposalId, entry) => intakeCandidateVersionId(details, proposalId, entry),
    references: (candidateId, versionId, recordId, proposalId) =>
      groupReferences.get(JSON.stringify([candidateId, versionId, recordId, proposalId])) || [],
    reportSource: (record, proposalId) =>
      intakeReportSourceForMember(
        workflow.reportSourceConfirmations,
        record.reportGroups,
        record,
        workflow.candidates
          .find((candidate) => candidate.id === record.candidateId)
          ?.versions.find((version) => version.id === record.candidateVersionId)
          ?.occurrences.find(
            (occurrence) =>
              occurrence.recordId === record.id && occurrence.proposalId === proposalId,
          ),
      )?.confirmation.source,
    questions: (candidateId, versionId) =>
      workflow.questions.filter(
        (q) =>
          q.candidateId === candidateId &&
          (!q.candidateVersionId || q.candidateVersionId === versionId),
      ),
    accepted: (candidateId, versionId) =>
      workflow.decisions.some(
        (d) =>
          d.candidateId === candidateId &&
          d.candidateVersionId === versionId &&
          d.action === 'accept',
      ),
    draft: (proposalId, recordId, versionId) =>
      currentReviewDraft(workflow, proposalId, recordId, versionId),
    firstVersion: (candidateId) =>
      workflow.candidates.find((candidate) => candidate.id === candidateId)?.versions[0]?.id,
    keptOriginal: (candidateId, versionId) =>
      !!workflow.candidates
        .find((candidate) => candidate.id === candidateId)
        ?.versions.some(
          (version) => version.id === versionId && version.status === 'kept_original',
        ),
    group: (reference) =>
      reportGroups.find(
        (group) =>
          group.id === reference.groupId &&
          group.versions.some((version) => version.id === reference.groupVersionId),
      ),
    identityGroup: (id) => reportGroups.find((group) => group.id === id),
    currentVersion: (group) => fullGroup(group).versions.at(-1)?.id || null,
    membership: (group) => fullGroup(group).versions.at(-1)!.members,
    originalFingerprint: (group) =>
      identityOriginalFingerprint(file.id, file.sha256, fullGroup(group), workflow),
    receipts: selectedSequence(workflow.identityConfirmations),
    packageEvidence:
      file.mime_type === 'application/zip' ||
      workflow.plans.some((plan) => (plan.index.members?.length || 0) > 0),
    manual: (proposalId) => details.proposals?.find((p) => p.id === proposalId)?.manualSourceRecord,
    competingBoundaryUnrepaired: (group, operationId, target) =>
      !!competingIdentityBoundaries(fullGroup(group), reportGroups).length &&
      !identityBoundaryRepairApplies(
        workflow.identityConfirmations?.find((receipt) => receipt.operationId === operationId),
        fullGroup(group),
        reportGroups,
        [target],
      ),
    evidence: (group, record, current, original) => {
      const related = group
        ? current.records.filter((candidate) =>
            selectedReportGroups(candidate.reportGroups).some(
              (reference) => reference.groupId === group.id,
            ),
          )
        : [record];
      const issues = function* () {
        for (const candidate of related)
          for (const issue of reviewRecordIssues(candidate))
            if (issue.kind === 'identity') yield issue;
      };
      return {
        collected: collectEvidencedIdentity(issues(), group?.report?.subject?.text, original),
        structured: collectEvidencedIdentity(issues()).evidence,
      };
    },
  };
  return workflowReviewSelected(
    file,
    scope,
    review,
    entries,
    self,
    identityContext && {
      ...identityContext,
      grounded: (group, issue, receipt) =>
        identityContext.grounded(fullGroup(group), issue, receipt),
      originalBirthDateEvidence:
        identityContext.originalBirthDateEvidence &&
        ((group) => identityContext.originalBirthDateEvidence!(fullGroup(group))),
      subjectGrounded:
        identityContext.subjectGrounded &&
        ((group) => identityContext.subjectGrounded!(fullGroup(group))),
      nameQuestionGrounded:
        identityContext.nameQuestionGrounded &&
        ((group, issue) => identityContext.nameQuestionGrounded!(fullGroup(group), issue)),
    },
  );
}
export function workflowReviewSelected<T extends IntakeReview>(
  file: WorkflowFile,
  scope: WorkflowReviewScope,
  review: T,
  entries: IntakeEntry[],
  self?: IntakeIdentitySelfSnapshot,
  identityContext?: SelectedWorkflowIdentityContext,
): T {
  const inputFileId = review.proposalId || file.id;
  const entriesByRecordId = new Map(
    entries.map((entry) => [`${inputFileId}:line:${entry.line}`, entry]),
  );
  for (const record of review.records) {
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    const candidateId = intakeCandidateId(file, entry);
    const versionId = scope.versionId(review.proposalId, entry);
    record.candidateId = candidateId;
    record.candidateVersionId = versionId;
    record.reportGroups = scope.references(candidateId, versionId, record.id, review.proposalId);
    const reportSource = scope.reportSource(record, review.proposalId);
    if (reportSource) record.provider = reportSource;
    bindReviewRecordQuestions(record, scope.questions(candidateId, versionId));
    record.reviewState =
      !record.projectionUpgrade && scope.accepted(candidateId, versionId) ? 'accepted' : 'pending';
    record.draft = scope.draft(review.proposalId, record.id, versionId);
    // Legacy questions did not pin a version. An old identity answer is history,
    // not confirmation of a changed envelope. Keep the durable question intact.
    if (record.reviewState !== 'accepted' && scope.firstVersion(candidateId) !== versionId)
      mapReviewRecordQuestions(record, (question) =>
        !question.candidateVersionId &&
        typedActionableIssueKind(question.prompt, question.field) === 'identity' &&
        !knownReviewDraftResolution(record.draft, question.id)
          ? {
              ...question,
              status: 'unanswered',
              answers: [],
              resolvedAt: undefined,
              resolvedByDecisionId: undefined,
            }
          : question,
      );

    const scopedReference = selectedReportGroups(record.reportGroups).find(
      (reference) => scope.group(reference)?.basis === 'report_anchor',
    );
    const scopedReport = scopedReference ? scope.group(scopedReference) : undefined;
    const issueScope = {
      packageEvidence: scope.packageEvidence,
      reportScoped: !!scopedReport,
      memberId: scopedReport?.memberId || null,
      reportSubject: scopedReport?.report?.subject?.text || null,
    };
    let issues = typedReviewIssues(
      record,
      entry,
      reviewRecordQuestions(record),
      issueScope,
      scope.issueSink?.(record),
    );
    // Prepared JSONL has no proposal id, but a host-resolved printed report
    // subject still needs an actionable identity target. Preserve an existing
    // exact typed target; otherwise add the same generic target as a proposal.
    if (
      scopedReport?.report?.subject &&
      !issues.some((issue) => issue.kind === 'identity') &&
      record.reviewState !== 'accepted' &&
      !record.projectionUpgrade
    ) {
      (
        record as typeof record & {
          identityConfirmationRequired?: boolean;
        }
      ).identityConfirmationRequired = true;
      issues = typedReviewIssues(
        record,
        entry,
        reviewRecordQuestions(record),
        issueScope,
        scope.issueSink?.(record),
      );
    }
    bindReviewRecordIssues(record, issues);
    for (const issue of issues) {
      const resolution = latestReviewDraftResolution(record.draft, issue.id);
      if (resolution) {
        if (
          identityContext?.resolutionCurrent?.(resolution, {
            ...record.mapping,
            ...record.draft?.mapping,
          }) === false &&
          !(
            issue.kind === 'identity' &&
            !resolution.dependency &&
            ['this_is_me', 'other_person'].includes(resolution.outcome) &&
            scope.receipts?.some(
              (receipt) =>
                receipt.operationId === resolution.operationId &&
                receipt.scope.intakeId === file.id &&
                receipt.scope.sourceHash === file.sha256 &&
                receipt.outcome ===
                  (resolution.outcome === 'other_person' ? 'this_is_person' : 'this_is_me') &&
                selectedReportGroups(record.reportGroups).some(
                  (group) => group.groupId === receipt.scope.groupId,
                ) &&
                (receipt.scope.assignmentTargets || receipt.scope.targets).some(
                  (target) =>
                    target.candidateId === record.candidateId &&
                    target.candidateVersionId === record.candidateVersionId &&
                    target.proposalId === review.proposalId &&
                    target.recordId === record.id &&
                    selectedSequence(target.issueIds || [target.issueId]).some(
                      (id) => id === issue.id,
                    ),
                ),
            )
          )
        ) {
          issue.status = 'unresolved';
          // An explicit refusal is negative intent, not authority to accept or
          // assign a person. Keep it blocking even if its measured evidence is
          // stale, so a later clinical edit cannot revive an automatic match.
          issue.resolution =
            issue.kind === 'identity' && ['unknown', 'other_person'].includes(resolution.outcome)
              ? resolution
              : undefined;
          if (issues.markQuestionReset) {
            if (issue.questionId) issues.markQuestionReset(issue.questionId);
          } else
            mapReviewRecordQuestions(record, (question) =>
              question.id === issue.questionId
                ? { ...question, status: 'unanswered', answers: [] }
                : question,
            );
        } else {
          issue.resolution = resolution;
          issue.status = resolution.outcome === 'unknown' ? 'unresolved' : 'resolved';
          if (resolution.outcome === 'unknown' && issue.kind !== 'identity') issue.blocking = false;
        }
      }
    }
    if (issues.questionWasReset)
      mapReviewRecordQuestions(record, (question) =>
        issues.questionWasReset!(question.id)
          ? { ...question, status: 'unanswered', answers: [] }
          : question,
      );
    if (scope.keptOriginal(candidateId, versionId)) record.reviewState = 'kept_original';
    const suggested: Partial<IntakeClinicalMapping> = {};
    for (const q of reviewRecordQuestions(record)) {
      const issue = issues.findId ? issues.findId(q.id) : issues.find((i) => i.questionId === q.id);
      if (
        q.status === 'answered' &&
        issue?.kind !== 'information' &&
        issue?.resolution?.outcome !== 'unknown' &&
        (!issue?.resolution || issue.status === 'resolved')
      )
        Object.assign(suggested, q.answers.at(-1)?.mapping || {});
    }
    record.suggestedMapping = Object.assign(suggested, record.draft?.mapping || {});
  }
  if (self) {
    const groupEvidence = new Map<
      string,
      {
        collected: ReturnType<typeof collectEvidencedIdentity>;
        structured: ReturnType<typeof collectEvidencedIdentity>['evidence'];
      }
    >();
    for (const record of review.records) {
      const reference = selectedReportGroups(record.reportGroups).find(() => true) || null;
      const group = reference ? scope.identityGroup(reference.groupId) || null : null;
      const originalBirthDates = group
        ? identityContext?.originalBirthDateEvidence?.(group)
        : undefined;
      let collected = group ? groupEvidence.get(group.id) : undefined;
      if (!collected) {
        collected = scope.evidence(group, record, review, originalBirthDates);
        if (group) groupEvidence.set(group.id, collected);
      }
      const { evidence, conflicts, unreadableBirthDate, bannerBirthDates } = structuredClone(
        collected.collected,
      );
      const structuredEvidence = structuredClone(collected.structured);
      const ownIdentityIssues = reviewRecordIssues(record).filter(
        (issue) => issue.kind === 'identity',
      );
      const genericIdentityIssueId =
        'issue:' +
        createHash('sha256')
          .update(JSON.stringify([record.candidateVersionId, 'identity', 'subject']))
          .digest('hex');
      const hasIdentityContext = !!(
        group?.report?.subject ||
        evidence.fullName ||
        evidence.birthDate ||
        unreadableBirthDate ||
        conflicts.length
      );
      const explicitIssues = ownIdentityIssues.filter(
        (issue) =>
          issue.id !== genericIdentityIssueId &&
          !issue.selfSuggestion &&
          // A bare model prompt invents no printed identity. Preserve the
          // missing-identity warning, while retaining any grounded question or
          // explicit user uncertainty as a blocker.
          !!(
            hasIdentityContext ||
            issue.textAnchor ||
            issue.questionId ||
            issue.resolution?.outcome === 'unknown' ||
            issue.resolution?.outcome === 'other_person'
          ),
      );
      const currentVersion =
        (group && scope.currentVersion(group)) || reference?.groupVersionId || null;
      const originalFingerprint = group ? scope.originalFingerprint(group) : null;
      const hasUnstructuredIdentityQuestion = explicitIssues.some(
        (issue) =>
          !(
            group &&
            identityContext?.nameQuestionGrounded?.(group, issue) &&
            isGenericNameConfirmation(
              issue,
              group.report?.subject?.text,
              self,
              identityContext.people || [],
            )
          ) &&
          (!group ||
            !originalFingerprint ||
            !identityContext ||
            !repeatedIdentityQuestionReceipt({
              issue,
              group,
              receipts: scope.receipts,
              profileId: identityContext.profileId,
              intakeId: file.id,
              sourceHash: file.sha256,
              originalFingerprint,
              grounded: (receipt) => identityContext.grounded(group, issue, receipt),
            })),
      );
      const explicit = exactCurrentIdentityResolutionOperationId({
        receipts: scope.receipts,
        occurrences: explicitIssues.length
          ? [
              {
                candidateId: record.candidateId!,
                candidateVersionId: record.candidateVersionId!,
                proposalId: review.proposalId,
                recordId: record.id,
                issueIds: explicitIssues.map((issue) => issue.id),
                resolutions: reviewDraftResolutions(record.draft),
                latestResolution: (issueId: string) =>
                  latestReviewDraftResolution(record.draft, issueId),
              },
            ]
          : [],
        receiptApplies: (receipt) =>
          !!group &&
          !!currentVersion &&
          identityReceiptAppliesToCurrentBoundary(receipt, {
            intakeId: file.id,
            groupId: group.id,
            groupVersionId: currentVersion,
            sourceHash: file.sha256,
            memberId: group.memberId,
            report: group.report!.anchor,
            subject: group.report!.subject!,
            evidencedIdentity: evidence,
            evidenceOriginalFingerprint: originalFingerprint,
            membership: scope.membership(group),
          }),
      });
      const assessment = assessIdentityPolicy({
        self,
        people: identityContext?.people,
        originalEvidenceChecked: !group || originalBirthDates !== undefined,
        unreadableBirthDate,
        bannerBirthDates,
        nameEvidenceGrounded: group
          ? !!identityContext?.subjectGrounded?.(group)
          : review.proposalId === null && !!structuredEvidence.fullName,
        evidence,
        evidenceConflicts: conflicts,
        group,
        groupVersionId: currentVersion,
        originalFingerprint,
        receipts: scope.receipts,
        hasUnstructuredIdentityQuestion,
        explicitlyConfirmedOperationId: explicit,
        currentRefusal: currentIdentityRefusal(ownIdentityIssues),
      });
      const personReceipt =
        group?.report?.subject && currentVersion
          ? confirmedPersonReceipt({
              receipts: scope.receipts,
              boundary: {
                profileId: identityContext?.profileId,
                intakeId: file.id,
                groupId: group.id,
                groupVersionId: currentVersion,
                sourceHash: file.sha256,
                memberId: group.memberId,
                report: group.report!.anchor,
                subject: group.report!.subject!,
                evidencedIdentity: evidence,
                evidenceOriginalFingerprint: originalFingerprint,
                membership: scope.membership(group),
              },
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              proposalId: review.proposalId,
              recordId: record.id,
              resolutions: reviewDraftResolutions(record.draft),
              latestResolution: (issueId: string) =>
                latestReviewDraftResolution(record.draft, issueId),
              requiredIssueIds: ownIdentityIssues.map((issue) => issue.id),
            })
          : undefined;
      if (personReceipt?.assignedPerson) {
        const currentPerson = identityContext?.people?.find(
          (person) =>
            person.personId === personReceipt.assignedPerson!.personId &&
            person.noteId === personReceipt.assignedPerson!.noteId,
        );
        const reviewedBirthDate =
          personReceipt.identityAnswers?.birthDate ||
          evidence.birthDate ||
          personReceipt.scope.evidencedIdentity?.birthDate;
        if (
          reviewedBirthDate &&
          currentPerson?.birthDate &&
          !compatibleIdentityBirthDates(reviewedBirthDate, currentPerson.birthDate)
        ) {
          // A receipt pins the human choice, not a perpetual exemption from
          // the selected person's current DOB. Unrelated note edits are harmless.
          assessment.status = 'conflict';
          assessment.blocking = true;
          assessment.message =
            'The report birth date differs from the assigned person’s current birth date. Review who this report belongs to before saving.';
          assessment.conflicts = [
            ...assessment.conflicts.filter((conflict) => conflict.field !== 'birthDate'),
            {
              field: 'birthDate',
              selfValue: currentPerson.birthDate,
              evidencedValue: reviewedBirthDate,
              reason: 'self_mismatch',
            },
          ];
          delete assessment.attribution;
        } else {
          assessment.status = 'prior_confirmation';
          assessment.blocking = false;
          assessment.message =
            'This report was assigned to ' + personReceipt.assignedPerson.fullName + '.';
          assessment.attribution = {
            status: 'prior_confirmation',
            basis: 'explicit_person_confirmation',
            groupId: group!.id,
            groupVersionId: currentVersion,
            confirmationOperationId: personReceipt.operationId,
            assignedPerson: personReceipt.assignedPerson,
            evidencedIdentity: evidence,
          };
        }
      }
      // This receipt exists only on a host-created proposal, outside its untrusted JSONL.
      // It assigns this single human-authored record, not other records or printed aliases.
      const manual = scope.manual(review.proposalId);
      if (
        manual &&
        (manual.profileId === identityContext?.profileId ||
          (!!review.proposalId &&
            identityContext?.copiedManualSourceApplies?.(manual, review.proposalId))) &&
        manual.intakeId === file.id &&
        manual.sourceHash === file.sha256 &&
        entriesByRecordId.get(record.id)?.value.id === `manual:${manual.operationId}`
      ) {
        const available =
          manual.person.personId === 'patient'
            ? manual.person.noteId === self.noteId
            : identityContext?.people?.some(
                (person) =>
                  person.noteId === manual.person.noteId &&
                  person.personId === manual.person.personId,
              );
        assessment.status = available ? 'prior_confirmation' : 'conflict';
        assessment.blocking = !available;
        assessment.message = available
          ? 'You assigned this manually authored record to ' + manual.person.fullName + '.'
          : 'Choose an available person before saving this record.';
        assessment.attribution = available
          ? {
              status: 'prior_confirmation',
              basis: 'explicit_manual_source_record',
              groupId: group?.id || null,
              groupVersionId: currentVersion,
              confirmationOperationId: manual.operationId,
              assignedPerson: manual.person,
              manualSourceRecord: manual,
            }
          : undefined;
      }
      if (
        group &&
        scope.competingBoundaryUnrepaired(group, assessment.attribution?.confirmationOperationId, {
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          proposalId: review.proposalId,
          recordId: record.id,
          title: record.title,
          issueId: genericIdentityIssueId,
        })
      ) {
        assessment.status = 'conflict';
        assessment.blocking = true;
        assessment.message =
          'This report boundary has conflicting subject claims; resolve identity individually';
        assessment.attribution = undefined;
      }
      if (
        !assessment.attribution?.assignedPerson &&
        record.mapping.subject &&
        !['self', 'unknown'].includes(record.mapping.subject)
      ) {
        assessment.status = 'conflict';
        assessment.blocking = true;
        assessment.message =
          'This record is attributed to another person and cannot be accepted into Self.';
        assessment.attribution = undefined;
      }
      const assignedPerson = assessment.attribution?.assignedPerson;
      const currentAssignedPerson = assessment.attribution
        ? assignedPerson && assignedPerson.personId !== 'patient'
          ? identityContext?.people?.find(
              (person) =>
                person.personId === assignedPerson.personId &&
                person.noteId === assignedPerson.noteId,
            )
          : {
              fullName: self.fullName || assignedPerson?.fullName || 'Self',
              birthDate: self.birthDate,
            }
        : undefined;
      const warnings =
        !assessment.blocking && (!group || originalBirthDates !== undefined)
          ? modelBirthDateWarnings({
              issues: ownIdentityIssues,
              originalBirthDate: evidence.birthDate,
              unreadableBirthDate,
              person: currentAssignedPerson,
            })
          : [];
      record.identityReview = {
        confidence: assessment.confidence,
        status: assessment.status,
        blocking: assessment.blocking,
        message: assessment.message,
        evidencedIdentity: assessment.evidencedIdentity,
        conflicts: assessment.conflicts,
        ...(warnings.length ? { warnings } : {}),
        ...(assessment.attribution?.assignedPerson
          ? { assignedPerson: assessment.attribution.assignedPerson }
          : {}),
      };
      if (assessment.attribution) {
        record.identityAttribution = assessment.attribution;
        const otherPerson =
          assessment.attribution.assignedPerson?.personId !== 'patient' &&
          !!assessment.attribution.assignedPerson;
        record.mapping.subject = otherPerson ? 'other' : 'self';
        if (otherPerson && assessment.attribution.assignedPerson)
          record.mapping.personId = assessment.attribution.assignedPerson.personId;
        else delete record.mapping.personId;
        const internal = record as typeof record & {
          undraftedMapping?: { subject?: string };
        };
        if (internal.undraftedMapping)
          internal.undraftedMapping.subject = otherPerson ? 'other' : 'self';
      }
      if (assessment.status === 'missing_warning') {
        for (const issue of ownIdentityIssues) {
          issue.blocking = false;
          issue.status = record.reviewState === 'accepted' ? 'resolved' : 'unresolved';
        }
        const generic = ownIdentityIssues.find(
          (issue) => issue.prompt === 'Does this record belong to you?',
        );
        if (generic) generic.prompt = assessment.message;
      } else if (assessment.attribution) {
        for (const issue of ownIdentityIssues) {
          issue.blocking = false;
          issue.status = 'resolved';
        }
      } else if (assessment.status === 'conflict') {
        for (const issue of ownIdentityIssues) {
          issue.blocking = true;
          issue.status = 'unresolved';
        }
        if (!ownIdentityIssues.some((issue) => issue.prompt === assessment.message))
          reviewIssueCollection(record).push({
            id: 'issue:' + workflowHash([record.candidateVersionId, 'identity-conflict']),
            kind: 'identity',
            prompt: assessment.message,
            field: 'subject',
            blocking: true,
            status: 'unresolved',
            locator: ownIdentityIssues.at(0)?.locator || record.evidence[0]?.locator || 'Original',
            questionId: null,
          });
      }
    }
  }
  return review;
}

export function workflowSummary(
  details: IntakeWorkflowDetails,
  { sourceContextVersionIds = new Set<string>() }: WorkflowSummaryOptions = {},
) {
  const workflow = intakeWorkflow(details);
  const projectedWorkflow = sourceContextVersionIds.size
    ? {
        ...workflow,
        candidates: workflow.candidates.map((candidate) => ({
          ...candidate,
          versions: candidate.versions.map((version) =>
            sourceContextVersionIds.has(version.id) ? { ...version, sourceContext: true } : version,
          ),
        })),
      }
    : workflow;
  return {
    workflow: {
      ...projectedWorkflow,
      reportGroups: reportGroupsWithLegacyFallback(projectedWorkflow),
    },
    ...workflowCounts(
      legacyWorkflowCountReader(workflow, details.packageFailures, sourceContextVersionIds),
    ),
  };
}
export function saveWorkflowDecisions(
  file: WorkflowFile,
  details: IntakeWorkflowDetails,
  review: IntakeReview,
  decisions: IntakeReviewDecision[],
): void {
  const workflow = intakeWorkflow(details),
    at = now();
  for (const decision of decisions) {
    const record = review.records.find((item) => item.id === decision.recordId);
    if (!record) continue;
    for (const comparison of decision.comparisons || []) {
      // A search-page choice has already passed exact scope validation inside
      // clinical projection. Retain its question even outside the default page.
      const target =
        record.comparisons?.find((item) => item.id === comparison.otherRecordId) ||
        (comparison.scope
          ? {
              id: comparison.otherRecordId,
              identity: comparison.scope.saved.identity,
              version: comparison.scope.saved.version,
            }
          : null);
      if (!target) continue;
      const key =
        'duplicate:' +
        workflowHash([
          record.candidateId,
          record.candidateVersionId,
          target.identity,
          target.version,
        ]);
      const question = addWorkflowQuestion(file, workflow, {
        key,
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        prompt:
          'Review whether these paired records describe the same event, a changed version, or distinct events.',
        locator: record.evidence[0]?.locator || 'Retained original',
        field: 'duplicate',
      });
      question.otherRecordId = target.id;
      const answerId = 'answer:' + workflowHash([review.reviewToken, comparison]);
      if (!question.answers.some((answer) => answer.id === answerId))
        question.answers.push({
          id: answerId,
          answer: comparison.reason,
          mapping: {},
          scope: 'record',
          outcome: comparison.outcome,
          otherRecordId: target.id,
          at,
        });
      question.status = comparison.outcome === 'unresolved' ? 'unanswered' : 'resolved';
      if (question.status === 'resolved') {
        question.resolvedAt = at;
        question.resolvedByDecisionId = answerId;
      }
    }
    if (decision.action !== 'accept') continue;
    const accepted: WorkflowDecision = {
      id: 'decision:' + workflowHash([review.reviewToken, decision]),
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      recordId: record.id,
      action: 'accept',
      mapping: decision.mapping || {},
      scope: decision.rememberRule ? 'reusable-rule' : 'record',
      evidence: record.evidence,
      at,
    };
    if (!workflow.decisions.some((item) => item.id === accepted.id))
      workflow.decisions.push(accepted);
    const version = workflow.candidates
      .find((c) => c.id === record.candidateId)
      ?.versions.find((v) => v.id === record.candidateVersionId);
    if (version) version.status = 'accepted';
    for (const reference of reviewRecordQuestions(record)) {
      const question = workflow.questions.find((q) => q.id === reference.id);
      if (
        question?.status === 'answered' &&
        question.field !== 'duplicate' &&
        reviewRecordIssues(record).find((i) => i.questionId === question.id)?.resolution
          ?.outcome !== 'unknown'
      ) {
        question.status = 'resolved';
        question.resolvedAt = at;
        question.resolvedByDecisionId = accepted.id;
      }
    }
  }
}
