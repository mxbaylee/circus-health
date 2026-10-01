import { candidateSourceIdentityV1 } from './intake-source-identity.ts';
import { compatibleIdentityBirthDates } from '../shared/self-identity.ts';
import { createHash } from 'node:crypto';
import { HttpError, now, safeText } from './database.ts';
import { accountedUnitKind } from './intake-unit-accounting.ts';
import { canonicalLiteral } from './intake-format.ts';
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
import {
  clinicalFields,
  clinicalMappingEnvelope,
  sourceContextEnvelope,
} from './clinical-import.ts';
import type {
  IntakeCandidateVersion,
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
  return (
    'candidate-version:' +
    workflowHash(
      revision ? [canonicalLiteral(entry.value), revision] : canonicalLiteral(entry.value),
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
  questions: IntakeQuestion[],
  metadataScope: SuggestionEvidenceScope,
) => IntakeReviewIssue[];
const typedActionableIssueKind = actionableIssueKind as unknown as (
  prompt: string,
  field?: string | null,
) => IntakeReviewIssue['kind'];

export const workflowHash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
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
export function addWorkflowQuestion(
  file: WorkflowFile,
  workflow: DurableWorkflow,
  input: WorkflowQuestionInput,
): WorkflowQuestion {
  const key = safeText(input.key, 'question key', 200),
    prompt = safeText(input.prompt, 'question', 4000).trim(),
    locator = safeText(input.locator, 'question evidence locator', 2000).trim();
  if (!key || !prompt || !locator)
    throw new HttpError(
      400,
      'QUESTION_INPUT',
      'Question key, prompt and original locator are required',
    );
  if (input.candidateId && !workflow.candidates.some((item) => item.id === input.candidateId))
    throw new HttpError(
      404,
      'CANDIDATE_NOT_FOUND',
      'Question record does not belong to this delivery',
    );
  const id = 'question:' + workflowHash([file.id, key]),
    existing = workflow.questions.find((item) => item.id === id);
  const value = {
    id,
    key,
    candidateId: input.candidateId || null,
    candidateVersionId: input.candidateVersionId || null,
    prompt,
    locator,
    field: input.field ? safeText(input.field, 'question field', 100) : null,
  };
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
export function workflowReview<T extends IntakeReview>(
  file: WorkflowFile,
  details: IntakeWorkflowDetails,
  review: T,
  entries: IntakeEntry[],
  self?: IntakeIdentitySelfSnapshot,
  identityContext?: {
    profileId: string;
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
  const inputFileId = review.proposalId || file.id;
  const entriesByRecordId = new Map(
    entries.map((entry) => [`${inputFileId}:line:${entry.line}`, entry]),
  );
  for (const record of review.records) {
    const entry = entriesByRecordId.get(record.id);
    if (!entry) throw new Error('Clinical review entry is missing from its retained proposal');
    const candidateId = intakeCandidateId(file, entry);
    const versionId = intakeCandidateVersionId(details, review.proposalId, entry);
    record.candidateId = candidateId;
    record.candidateVersionId = versionId;
    record.reportGroups =
      groupReferences.get(JSON.stringify([candidateId, versionId, record.id, review.proposalId])) ||
      [];
    const reportSource = intakeReportSourceForMember(
      workflow.reportSourceConfirmations,
      record.reportGroups,
      record,
      workflow.candidates
        .find((candidate) => candidate.id === candidateId)
        ?.versions.find((version) => version.id === versionId)
        ?.occurrences.find(
          (occurrence) =>
            occurrence.recordId === record.id && occurrence.proposalId === review.proposalId,
        ),
    );
    if (reportSource) record.provider = reportSource.confirmation.source;
    record.questions = workflow.questions.filter(
      (q) =>
        q.candidateId === candidateId &&
        (!q.candidateVersionId || q.candidateVersionId === versionId),
    );
    record.reviewState =
      !record.projectionUpgrade &&
      workflow.decisions.some(
        (d) =>
          d.candidateId === candidateId &&
          d.candidateVersionId === versionId &&
          d.action === 'accept',
      )
        ? 'accepted'
        : 'pending';
    record.draft = currentReviewDraft(workflow, review.proposalId, record.id, versionId);
    // Legacy questions did not pin a version. An old identity answer is history,
    // not confirmation of a changed envelope. Keep the durable question intact.
    if (
      record.reviewState !== 'accepted' &&
      workflow.candidates.find((candidate) => candidate.id === candidateId)?.versions[0]?.id !==
        versionId
    )
      record.questions = record.questions.map((question) =>
        !question.candidateVersionId &&
        typedActionableIssueKind(question.prompt, question.field) === 'identity' &&
        !record.draft?.resolutions.some(
          (resolution) => resolution.issueId === question.id && resolution.outcome !== 'unknown',
        )
          ? {
              ...question,
              status: 'unanswered',
              answers: [],
              resolvedAt: undefined,
              resolvedByDecisionId: undefined,
            }
          : question,
      );

    const scopedReport = record.reportGroups
      .map((reference) =>
        reportGroups.find(
          (group) =>
            group.id === reference.groupId &&
            group.versions.some((version) => version.id === reference.groupVersionId),
        ),
      )
      .find((group) => group?.basis === 'report_anchor');
    const issueScope = {
      packageEvidence:
        file.mime_type === 'application/zip' ||
        workflow.plans.some((plan) => (plan.index.members?.length || 0) > 0),
      reportScoped: !!scopedReport,
      memberId: scopedReport?.memberId || null,
      reportSubject: scopedReport?.report?.subject?.text || null,
    };
    let issues = typedReviewIssues(record, entry, record.questions, issueScope);
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
      issues = typedReviewIssues(record, entry, record.questions, issueScope);
    }
    record.issues = issues;
    for (const issue of issues) {
      const resolution = record.draft?.resolutions.findLast((r) => r.issueId === issue.id);
      if (resolution) {
        if (
          identityContext?.resolutionCurrent?.(resolution, {
            ...record.mapping,
            ...record.draft?.mapping,
          }) === false
        ) {
          issue.status = 'unresolved';
          issue.resolution = undefined;
          record.questions = record.questions.map((question) =>
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
    if (
      workflow.candidates
        .find((c) => c.id === candidateId)
        ?.versions.some((v) => v.id === versionId && v.status === 'kept_original')
    )
      record.reviewState = 'kept_original';
    record.suggestedMapping = Object.assign(
      {},
      ...record.questions
        .filter(
          (q) =>
            q.status === 'answered' &&
            issues.find((i) => i.questionId === q.id)?.kind !== 'information' &&
            issues.find((i) => i.questionId === q.id)?.status === 'resolved',
        )
        .map((q) => q.answers.at(-1)?.mapping || {}),
      record.draft?.mapping || {},
    );
  }
  if (self) {
    const recordsByGroup = new Map<string, IntakeReview['records']>();
    for (const record of review.records)
      for (const reference of record.reportGroups || []) {
        const records = recordsByGroup.get(reference.groupId) || [];
        if (!records.includes(record)) records.push(record);
        recordsByGroup.set(reference.groupId, records);
      }
    // Self suggestions are fixed during this synchronous enrichment pass.
    // Collect shared report facts once, rather than scanning every row per row.
    const groupEvidence = new Map<
      string,
      {
        collected: ReturnType<typeof collectEvidencedIdentity>;
        structured: ReturnType<typeof collectEvidencedIdentity>['evidence'];
      }
    >();
    for (const record of review.records) {
      const reference = record.reportGroups?.[0] || null;
      const group = reference
        ? reportGroups.find((candidate) => candidate.id === reference.groupId) || null
        : null;
      const related = group ? recordsByGroup.get(group.id) || [record] : [record];
      const identityIssues = related.flatMap((candidate) =>
        (candidate.issues || []).filter((issue) => issue.kind === 'identity'),
      );
      const originalBirthDates = group
        ? identityContext?.originalBirthDateEvidence?.(group)
        : undefined;
      let collected = group ? groupEvidence.get(group.id) : undefined;
      if (!collected) {
        collected = {
          collected: collectEvidencedIdentity(
            identityIssues,
            group?.report?.subject?.text,
            originalBirthDates,
          ),
          structured: collectEvidencedIdentity(identityIssues).evidence,
        };
        if (group) groupEvidence.set(group.id, collected);
      }
      const { evidence, conflicts, unreadableBirthDate, bannerBirthDates } = structuredClone(
        collected.collected,
      );
      const structuredEvidence = structuredClone(collected.structured);
      const ownIdentityIssues = (record.issues || []).filter((issue) => issue.kind === 'identity');
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
      const currentGroupVersion = group?.versions.at(-1) || null;
      const currentVersion = currentGroupVersion?.id || reference?.groupVersionId || null;
      const originalFingerprint = group
        ? identityOriginalFingerprint(file.id, file.sha256, group, workflow)
        : null;
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
              receipts: workflow.identityConfirmations,
              profileId: identityContext.profileId,
              intakeId: file.id,
              sourceHash: file.sha256,
              originalFingerprint,
              grounded: (receipt) => identityContext.grounded(group, issue, receipt),
            })),
      );
      const explicit = exactCurrentIdentityResolutionOperationId({
        receipts: workflow.identityConfirmations,
        occurrences: explicitIssues.length
          ? [
              {
                candidateId: record.candidateId!,
                candidateVersionId: record.candidateVersionId!,
                proposalId: review.proposalId,
                recordId: record.id,
                issueIds: explicitIssues.map((issue) => issue.id),
                resolutions: record.draft?.resolutions || [],
              },
            ]
          : [],
        receiptApplies: (receipt) =>
          !!group &&
          !!currentGroupVersion &&
          identityReceiptAppliesToCurrentBoundary(receipt, {
            intakeId: file.id,
            groupId: group.id,
            groupVersionId: currentGroupVersion.id,
            sourceHash: file.sha256,
            memberId: group.memberId,
            report: group.report!.anchor,
            subject: group.report!.subject!,
            evidencedIdentity: evidence,
            evidenceOriginalFingerprint: originalFingerprint,
            membership: currentGroupVersion.members,
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
        receipts: workflow.identityConfirmations,
        hasUnstructuredIdentityQuestion,
        explicitlyConfirmedOperationId: explicit,
        currentRefusal: currentIdentityRefusal(ownIdentityIssues),
      });
      const personReceipt =
        group?.report?.subject && currentGroupVersion
          ? confirmedPersonReceipt({
              receipts: workflow.identityConfirmations,
              boundary: {
                profileId: identityContext?.profileId,
                intakeId: file.id,
                groupId: group.id,
                groupVersionId: currentGroupVersion.id,
                sourceHash: file.sha256,
                memberId: group.memberId,
                report: group.report!.anchor,
                subject: group.report!.subject!,
                evidencedIdentity: evidence,
                evidenceOriginalFingerprint: originalFingerprint,
                membership: currentGroupVersion.members,
              },
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              proposalId: review.proposalId,
              recordId: record.id,
              resolutions: record.draft?.resolutions || [],
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
      const manual = details.proposals?.find((p) => p.id === review.proposalId)?.manualSourceRecord;
      if (
        manual &&
        manual.profileId === identityContext?.profileId &&
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
        competingIdentityBoundaries(group, reportGroups).length &&
        !identityBoundaryRepairApplies(
          workflow.identityConfirmations?.find(
            (receipt) => receipt.operationId === assessment.attribution?.confirmationOperationId,
          ),
          group,
          reportGroups,
          [
            {
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              proposalId: review.proposalId,
              recordId: record.id,
              title: record.title,
              issueId: genericIdentityIssueId,
            },
          ],
        )
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
          record.issues!.push({
            id: 'issue:' + workflowHash([record.candidateVersionId, 'identity-conflict']),
            kind: 'identity',
            prompt: assessment.message,
            field: 'subject',
            blocking: true,
            status: 'unresolved',
            locator: ownIdentityIssues[0]?.locator || record.evidence[0]?.locator || 'Original',
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
  const isSourceContext = (version: IntakeCandidateVersion): boolean => {
    if (!version.sourceContext && !sourceContextVersionIds.has(version.id)) return false;
    const draft = workflow.reviewDrafts.findLast((item) => item.candidateVersionId === version.id);
    const accepted = workflow.decisions.findLast(
      (item) => item.candidateVersionId === version.id && item.action === 'accept',
    );
    const reviewedKind =
      draft?.decision?.mapping?.kind || draft?.mapping?.kind || accepted?.mapping?.kind;
    return !Object.hasOwn(clinicalFields, reviewedKind || '');
  };
  const versionsById = new Map(
    workflow.candidates
      .flatMap((candidate) => candidate.versions)
      .map((version) => [version.id, version]),
  );
  const candidatesById = new Map(workflow.candidates.map((candidate) => [candidate.id, candidate]));
  const terminal = (candidateId: string | null, versionId: string | null): boolean =>
    !!workflow.candidates
      .find((c) => c.id === candidateId)
      ?.versions.some((v) => v.id === versionId && v.status === 'kept_original');
  const unanswered = workflow.questions.filter((q) => {
    // Legacy questions did not pin a candidate version. Bind their derived state
    // to the candidate's current version so an older draft cannot confirm future
    // evidence that happens to retain the same question ID.
    const version = q.candidateVersionId
      ? versionsById.get(q.candidateVersionId)
      : q.candidateId
        ? candidatesById.get(q.candidateId)?.versions.at(-1)
        : undefined;
    if (version && isSourceContext(version)) return false;
    if (terminal(q.candidateId, version?.id || q.candidateVersionId)) return false;
    const reviewKind = typedActionableIssueKind(q.prompt, q.field);
    if (reviewKind === 'information') return false;
    const resolvedDecision = q.resolvedByDecisionId
      ? workflow.decisions.find((decision) => decision.id === q.resolvedByDecisionId)
      : undefined;
    if (
      q.status === 'resolved' &&
      (q.candidateVersionId ||
        !version ||
        (resolvedDecision?.candidateId === q.candidateId &&
          resolvedDecision.candidateVersionId === version.id))
    )
      return false;
    const resolution = workflow.reviewDrafts
      .filter(
        (draft) =>
          !!version &&
          draft.candidateId === q.candidateId &&
          draft.candidateVersionId === version.id,
      )
      .flatMap((draft) => draft.resolutions)
      .findLast((resolution) => resolution.issueId === q.id);
    const outcome = resolution?.outcome;
    if (
      outcome === 'other_person' &&
      reviewKind === 'identity' &&
      resolution?.operationId &&
      workflow.identityConfirmations?.some(
        (receipt) =>
          receipt.outcome === 'this_is_person' &&
          receipt.assignedPerson &&
          receipt.operationId === resolution.operationId &&
          (receipt.scope.assignmentTargets || receipt.scope.targets).some(
            (target) =>
              target.candidateId === q.candidateId &&
              target.candidateVersionId === version?.id &&
              (target.issueIds || [target.issueId]).includes(q.id),
          ),
      )
    )
      return false;
    if (outcome === 'this_is_me' && reviewKind === 'identity') return false;
    if (outcome === 'unknown' && reviewKind !== 'identity') return false;
    return true;
  }).length;
  const pendingCandidates = workflow.candidates.filter((c) =>
    c.versions.some((v) => v.status === 'pending' && !v.peopleOnly && !isSourceContext(v)),
  ).length;
  const pendingWork = workflow.plans
    .filter((p) => p.status !== 'superseded')
    .flatMap((p) => p.units.filter((u) => !accountedUnitKind(p, u))).length;
  return {
    workflow: {
      ...projectedWorkflow,
      reportGroups: reportGroupsWithLegacyFallback(projectedWorkflow),
    },
    needsReview: unanswered > 0 || pendingCandidates > 0 || pendingWork > 0,
    pendingCount: pendingCandidates,
    unansweredCount: unanswered,
    pendingWorkCount: pendingWork,
    reviewLaterCount: workflow.candidates
      .flatMap((c) => c.versions)
      .filter(
        (v) =>
          v.status === 'pending' &&
          !v.peopleOnly &&
          !isSourceContext(v) &&
          workflow.reviewDrafts.findLast((d) => d.candidateVersionId === v.id)?.disposition ===
            'review_later',
      ).length,
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
    for (const reference of record.questions || []) {
      const question = workflow.questions.find((q) => q.id === reference.id);
      if (
        question?.status === 'answered' &&
        question.field !== 'duplicate' &&
        record.issues?.find((i) => i.questionId === question.id)?.resolution?.outcome !== 'unknown'
      ) {
        question.status = 'resolved';
        question.resolvedAt = at;
        question.resolvedByDecisionId = accepted.id;
      }
    }
  }
}
