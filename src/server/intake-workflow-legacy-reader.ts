import type {
  IntakeCandidate,
  IntakeCandidateVersion,
  IntakePackageFailure,
  IntakeWorkflow,
} from '../shared/intake.ts';
import { accountedUnitKind } from './intake-unit-accounting.ts';
import type { WorkflowCandidateHeader, WorkflowCountReader } from './intake-workflow-reader.ts';

/** Already materialized v3 values only; never a v4 reader or a page adapter. */
export function legacyWorkflowCountReader(
  workflow: IntakeWorkflow,
  packageFailures: Record<string, IntakePackageFailure> = {},
  sourceContextVersionIds: ReadonlySet<string> = new Set(),
): WorkflowCountReader {
  const versionsById = new Map<string, IntakeCandidateVersion>();
  const candidatesById = new Map<string, IntakeCandidate>();
  const candidateVersions = new WeakMap<WorkflowCandidateHeader, IntakeCandidateVersion[]>();
  for (const candidate of workflow.candidates) {
    candidatesById.set(candidate.id, candidate);
    candidateVersions.set(candidate, candidate.versions);
    for (const version of candidate.versions) versionsById.set(version.id, version);
  }
  return {
    candidates: () => workflow.candidates,
    versions(candidate) {
      const versions = candidateVersions.get(candidate);
      if (!versions) throw Error('Foreign legacy workflow candidate');
      return versions;
    },
    version: (candidateId, versionId) =>
      workflow.candidates
        .find((candidate) => candidate.id === candidateId)
        ?.versions.find((version) => version.id === versionId),
    versionById: (id) => versionsById.get(id),
    latestVersion: (id) => candidatesById.get(id)?.versions.at(-1),
    questions: () => workflow.questions,
    decision: (id) => workflow.decisions.find((decision) => decision.id === id),
    latestDraft: (id) =>
      workflow.reviewDrafts?.findLast((draft) => draft.candidateVersionId === id),
    latestAcceptance: (id) =>
      workflow.decisions.findLast(
        (decision) => decision.candidateVersionId === id && decision.action === 'accept',
      ),
    latestResolution(candidateId, versionId, issueId) {
      let selected;
      for (const draft of workflow.reviewDrafts || []) {
        if (draft.candidateId !== candidateId || draft.candidateVersionId !== versionId) continue;
        for (const resolution of draft.resolutions)
          if (resolution.issueId === issueId) selected = resolution;
      }
      return selected;
    },
    hasPersonAssignment: (operationId, candidateId, versionId, issueId) =>
      !!workflow.identityConfirmations?.some(
        (receipt) =>
          receipt.outcome === 'this_is_person' &&
          receipt.assignedPerson &&
          receipt.operationId === operationId &&
          (receipt.scope.assignmentTargets || receipt.scope.targets).some(
            (target) =>
              target.candidateId === candidateId &&
              target.candidateVersionId === versionId &&
              (target.issueIds || [target.issueId]).includes(issueId),
          ),
      ),
    isSourceContextVersion: (id) => sourceContextVersionIds.has(id),
    *units() {
      for (const plan of workflow.plans) {
        if (plan.status === 'superseded') continue;
        for (const unit of plan.units)
          yield { planId: plan.id, unitId: unit.id, pending: !accountedUnitKind(plan, unit) };
      }
    },
    hasPendingPackageFailure() {
      for (const key in packageFailures)
        if (Object.hasOwn(packageFailures, key) && packageFailures[key]!.status === 'pending')
          return true;
      return false;
    },
  };
}
