import type {
  IntakeCandidate,
  IntakeCandidateVersion,
  IntakeClinicalMapping,
  IntakeIssueResolution,
  IntakeQuestion,
  IntakeReviewDraft,
  IntakeWorkflow,
} from '../shared/intake.ts';
import { clinicalFields } from './clinical-import.ts';
import { actionableIssueKind } from './intake-review.ts';
import type { WorkflowCountFacts } from './intake-workflow-counts.ts';

/** Headers deliberately exclude independently growing child collections. */
export type WorkflowCandidateHeader = Omit<IntakeCandidate, 'versions'>;
export type WorkflowVersionHeader = Omit<IntakeCandidateVersion, 'occurrences'>;
export type WorkflowQuestionHeader = Omit<IntakeQuestion, 'answers'>;
export type WorkflowDecisionHeader = Pick<
  IntakeWorkflow['decisions'][number],
  'id' | 'candidateId' | 'candidateVersionId' | 'action'
> & {
  mapping: Pick<Partial<IntakeClinicalMapping>, 'kind'>;
};
export type WorkflowDraftHeader = Pick<
  IntakeReviewDraft,
  'id' | 'candidateId' | 'candidateVersionId' | 'disposition'
> & {
  mapping: Pick<Partial<IntakeClinicalMapping>, 'kind'>;
  decision?: { mapping?: Pick<Partial<IntakeClinicalMapping>, 'kind'> };
};

/**
 * Every iterator covers its entire named scope, in retained order. A page is
 * never an implementation of this interface. Point/latest joins must be bound
 * to the same selected roots as the traversal, including negative lookups.
 */
export interface WorkflowCountReader {
  candidates(): Iterable<WorkflowCandidateHeader>;
  versions(candidate: WorkflowCandidateHeader): Iterable<WorkflowVersionHeader>;
  version(candidateId: string, versionId: string): WorkflowVersionHeader | undefined;
  /** Legacy question behavior selects the last retained candidate with this version ID. */
  versionById(versionId: string): WorkflowVersionHeader | undefined;
  latestVersion(candidateId: string): WorkflowVersionHeader | undefined;
  questions(): Iterable<WorkflowQuestionHeader>;
  decision(id: string): WorkflowDecisionHeader | undefined;
  latestDraft(versionId: string): WorkflowDraftHeader | undefined;
  latestAcceptance(versionId: string): WorkflowDecisionHeader | undefined;
  latestResolution(
    candidateId: string | null,
    versionId: string,
    issueId: string,
  ): IntakeIssueResolution | undefined;
  hasPersonAssignment(
    operationId: string,
    candidateId: string | null,
    versionId: string,
    issueId: string,
  ): boolean;
  isSourceContextVersion(versionId: string): boolean;
  /** Includes all non-superseded plans and verifies retained batch/attempt coverage. */
  units(): Iterable<{ planId: string; unitId: string; pending: boolean }>;
  hasPendingPackageFailure(): boolean;
}

export interface WorkflowCounts {
  needsReview: boolean;
  pendingCount: number;
  unansweredCount: number;
  pendingWorkCount: number;
  reviewLaterCount: number;
}

export interface WorkflowCountContribution {
  /** Ordinals distinguish retained duplicate occurrences without changing public IDs. */
  key: readonly string[];
  facts: WorkflowCountFacts;
}

export function workflowVersionIsSourceContext(
  reader: Pick<WorkflowCountReader, 'isSourceContextVersion' | 'latestDraft' | 'latestAcceptance'>,
  version: WorkflowVersionHeader,
): boolean {
  if (!version.sourceContext && !reader.isSourceContextVersion(version.id)) return false;
  const draft = reader.latestDraft(version.id);
  const accepted = reader.latestAcceptance(version.id);
  const reviewedKind =
    draft?.decision?.mapping?.kind || draft?.mapping?.kind || accepted?.mapping?.kind;
  return !Object.hasOwn(clinicalFields, reviewedKind || '');
}

export function workflowQuestionNeedsAnswer(
  reader: WorkflowCountReader,
  question: WorkflowQuestionHeader,
): boolean {
  const version = question.candidateVersionId
    ? reader.versionById(question.candidateVersionId)
    : question.candidateId
      ? reader.latestVersion(question.candidateId)
      : undefined;
  if (version && workflowVersionIsSourceContext(reader, version)) return false;
  const terminalVersionId = version?.id || question.candidateVersionId;
  if (
    question.candidateId &&
    terminalVersionId &&
    reader.version(question.candidateId, terminalVersionId)?.status === 'kept_original'
  )
    return false;
  const reviewKind = actionableIssueKind(question.prompt, question.field);
  if (reviewKind === 'information') return false;
  const resolvedDecision = question.resolvedByDecisionId
    ? reader.decision(question.resolvedByDecisionId)
    : undefined;
  if (
    question.status === 'resolved' &&
    (question.candidateVersionId ||
      !version ||
      (resolvedDecision?.candidateId === question.candidateId &&
        resolvedDecision.candidateVersionId === version.id))
  )
    return false;
  const resolution = version
    ? reader.latestResolution(question.candidateId, version.id, question.id)
    : undefined;
  if (
    resolution?.outcome === 'other_person' &&
    reviewKind === 'identity' &&
    resolution.operationId &&
    version &&
    reader.hasPersonAssignment(
      resolution.operationId,
      question.candidateId,
      version.id,
      question.id,
    )
  )
    return false;
  if (resolution?.outcome === 'this_is_me' && reviewKind === 'identity') return false;
  if (resolution?.outcome === 'unknown' && reviewKind !== 'identity') return false;
  return true;
}

export function workflowCandidateCounts(
  reader: WorkflowCountReader,
  candidate: WorkflowCandidateHeader,
): Pick<WorkflowCounts, 'pendingCount' | 'reviewLaterCount'> {
  let pendingCount = 0,
    reviewLaterCount = 0;
  for (const version of reader.versions(candidate)) {
    if (
      version.status !== 'pending' ||
      version.peopleOnly ||
      workflowVersionIsSourceContext(reader, version)
    )
      continue;
    pendingCount = 1;
    if (reader.latestDraft(version.id)?.disposition === 'review_later') reviewLaterCount++;
  }
  return { pendingCount, reviewLaterCount };
}

/** Cold rebuild only. Interactive summaries consume a checked completed recount. */
export function* workflowCountContributions(
  reader: WorkflowCountReader,
): Generator<WorkflowCountContribution> {
  const facts = (patch: Partial<WorkflowCountFacts>): WorkflowCountFacts => ({
    pendingCount: 0,
    reviewLaterCount: 0,
    unansweredCount: 0,
    pendingWorkCount: 0,
    pendingPackageFailures: 0,
    ...patch,
  });
  let ordinal = 0;
  for (const candidate of reader.candidates())
    yield {
      key: ['candidate', candidate.id, String(ordinal++)],
      facts: facts(workflowCandidateCounts(reader, candidate)),
    };
  ordinal = 0;
  for (const question of reader.questions())
    yield {
      key: ['question', question.id, String(ordinal++)],
      facts: facts({ unansweredCount: workflowQuestionNeedsAnswer(reader, question) ? 1 : 0 }),
    };
  ordinal = 0;
  for (const unit of reader.units())
    yield {
      key: ['unit', unit.planId, unit.unitId],
      facts: facts({ pendingWorkCount: unit.pending ? 1 : 0 }),
    };
  // This is the failure-set contribution, not a claim about the number of failed members.
  yield {
    key: ['package-failure-set'],
    facts: facts({ pendingPackageFailures: reader.hasPendingPackageFailure() ? 1 : 0 }),
  };
}

/** Cold rebuild only. Interactive summaries consume a checked completed recount. */
export function workflowCounts(reader: WorkflowCountReader): WorkflowCounts {
  let pendingCount = 0,
    reviewLaterCount = 0,
    unansweredCount = 0,
    pendingWorkCount = 0;
  let hasPackageFailure = false;
  for (const { facts } of workflowCountContributions(reader)) {
    pendingCount += facts.pendingCount;
    reviewLaterCount += facts.reviewLaterCount;
    unansweredCount += facts.unansweredCount;
    pendingWorkCount += facts.pendingWorkCount;
    hasPackageFailure ||= facts.pendingPackageFailures > 0;
  }
  return {
    needsReview:
      unansweredCount > 0 || pendingCount > 0 || pendingWorkCount > 0 || hasPackageFailure,
    pendingCount,
    unansweredCount,
    pendingWorkCount,
    reviewLaterCount,
  };
}
