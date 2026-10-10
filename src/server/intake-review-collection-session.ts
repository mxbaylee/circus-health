import { finishClinicalReviewWork } from './clinical-review-work.ts';
import { createHash } from 'node:crypto';
import { inlineReviewRecordIssuesWork, reviewRecordIssues } from './intake-review-issue-state.ts';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError, managedDatabaseMethodEpoch } from './database.ts';
import { reviewReadStamp } from './intake-clinical-review-read-cache.ts';
import { canonicalLiteral } from './intake-format.ts';
import {
  selectedReportGroupLinks,
  selectedReportGroups,
  selectedReportGroupAt,
  isSelectedReportGroups,
} from './intake-selected-report-groups.ts';
import {
  buildClinicalReviewWork,
  finalizeClinicalPairScopesWork,
  refreshClinicalIdentityPolicyWork,
  type BuildReviewInput,
  type ClinicalReview,
  type SelectedClinicalReportSource,
  type SelectedClinicalProjectionScope,
} from './clinical-import.ts';
import {
  workflowReviewSelectedWork,
  type SelectedWorkflowIdentityContext,
} from './intake-workflow.ts';
import { selectionAuthorityWork } from './intake-selection-authority.ts';
import type { IntakeIdentitySelfSnapshot } from '../shared/intake-identity.ts';
import type { IntakeReview } from '../shared/intake.ts';
import type { IntakeValidation } from '../shared/intake.ts';
import { hasUnreviewedPairChoices } from '../shared/clinical-review.ts';
import type { SelectedOwnershipReviewScope } from './record-ownership-authority.ts';
import {
  IntakeReviewFragmentRequired,
  type IntakeReviewFragmentReference,
  type collectionWorkflowReviewScope,
} from './intake-review-collection.ts';

import type {
  IntakeClinicalReviewPage,
  IntakeClinicalReviewReference,
  IntakeClinicalReviewSection as Section,
  IntakeClinicalRecordRead,
} from '../shared/intake-clinical-review.ts';
export type {
  IntakeClinicalReviewPage,
  IntakeClinicalReviewReference,
} from '../shared/intake-clinical-review.ts';
export type CollectionClinicalReviewResult =
  | { status: 'ready'; session: CollectionClinicalReviewSession }
  | { status: 'fragment_required'; reference: IntakeReviewFragmentReference };
export interface CollectionClinicalReviewSession {
  /** Release disposable policy scratch after the selected read or projection finishes. */
  close(): void;
  readonly ownership: SelectedOwnershipReviewScope;
  /** Complete bounded proposal review, used only by host policy/mutations. Never pass a display page as this value. */
  review: IntakeReview;
  page(
    section: Section,
    options: { cursor?: string; items: number; bytes: number },
  ): IntakeClinicalReviewPage;
  fragment(
    reference: IntakeClinicalReviewReference,
    offset: number,
    bytes: number,
  ): { encoding: 'base64'; data: string; complete: boolean; nextOffset: number | null };
  record(
    recordId: string,
    candidateId?: string,
    candidateVersionId?: string,
  ): IntakeReview['records'][number] | undefined;
  selectedRecord(
    recordId: string,
    candidateVersionId?: string,
    bytes?: number,
  ): IntakeClinicalRecordRead;
}
export interface VerifiedClinicalArtifact {
  id: string;
  path: string;
  identity: string;
}
export interface CollectionClinicalProjectionContext {
  verifiedArtifacts(): Iterable<VerifiedClinicalArtifact>;
  consumedArtifactIds(): Iterable<string>;
  beginProjectionConsumption(): () => void;
  readonly db: DatabaseSync;
  readonly profileId: string;
  readonly proposal: Omit<BuildReviewInput, 'drafts' | 'acceptedDecisions' | 'selected'>;
  readonly review: ClinicalReview;
  readonly selected: SelectedClinicalProjectionScope;
  readonly validation: IntakeValidation;
  assertCurrent(): void;
  /** Projection plans pair this logical guard with their own copied physical proof. */
  assertAuthorityCurrent(): void;
  verifyPhysicalEvidenceCooperatively?(
    signal?: AbortSignal,
    assertRunning?: () => void,
  ): Promise<void>;
}
const projectionContexts = new WeakMap<
  CollectionClinicalReviewSession,
  CollectionClinicalProjectionContext
>();
declare const acceptanceHandoff: unique symbol;
export interface CollectionClinicalAcceptancePreparation {
  readonly [acceptanceHandoff]: 'review';
}
export interface CollectionClinicalAcceptanceGroupHandoff {
  readonly [acceptanceHandoff]: 'group';
}
export interface CollectionClinicalAcceptanceProjectionHandoff {
  readonly [acceptanceHandoff]: 'projection';
}
type AcceptanceHandoff =
  | CollectionClinicalAcceptancePreparation
  | CollectionClinicalAcceptanceGroupHandoff
  | CollectionClinicalAcceptanceProjectionHandoff;
type AcceptanceHandoffState = {
  stage: 'review' | 'group' | 'projection';
  session: CollectionClinicalReviewSession;
  context: CollectionClinicalProjectionContext;
  methodEpoch: NonNullable<ReturnType<typeof managedDatabaseMethodEpoch>>;
  stamp: string;
  signal?: AbortSignal;
  assertRunning?: () => void;
};
const acceptanceHandoffs = new WeakMap<AcceptanceHandoff, AcceptanceHandoffState>();
function acceptanceCapability<T extends AcceptanceHandoff>(value: AcceptanceHandoffState): T {
  const capability = Object.freeze({}) as T;
  acceptanceHandoffs.set(capability, value);
  return capability;
}
export type CollectionClinicalAcceptancePreparationResult =
  | Exclude<CollectionClinicalReviewResult, { status: 'ready' }>
  | { status: 'prepared'; preparation: CollectionClinicalAcceptancePreparation };
/** Host preparation retains the original proof. Only the acceptance projection's
 * complete retained union may close its physical verification. */
export function deferCollectionClinicalAcceptanceReview(
  result: CollectionClinicalReviewResult,
  signal?: AbortSignal,
  assertRunning?: () => void,
): CollectionClinicalAcceptancePreparationResult {
  if (result.status !== 'ready') return result;
  const context = projectionContexts.get(result.session);
  if (!context) throw Error('Foreign selected clinical review session');
  context.assertAuthorityCurrent();
  const methodEpoch = managedDatabaseMethodEpoch(context.db),
    stamp = reviewReadStamp(context.db);
  if (!methodEpoch || !stamp) throw Error('Acceptance review handoff unavailable');
  return {
    status: 'prepared',
    preparation: acceptanceCapability<CollectionClinicalAcceptancePreparation>({
      stage: 'review',
      session: result.session,
      context,
      methodEpoch,
      stamp,
      signal,
      assertRunning,
    }),
  };
}
export function disposeCollectionClinicalAcceptanceReview(
  preparation: CollectionClinicalAcceptancePreparation,
) {
  const value = acceptanceHandoffs.get(preparation);
  acceptanceHandoffs.delete(preparation);
  value?.session.close();
}
function consumeAcceptanceHandoff(
  capability: AcceptanceHandoff,
  stage: AcceptanceHandoffState['stage'],
  db: DatabaseSync,
  profileId: string,
  session?: CollectionClinicalReviewSession,
) {
  const value = acceptanceHandoffs.get(capability);
  acceptanceHandoffs.delete(capability);
  if (!value || value.stage !== stage) throw Error('Acceptance review handoff unavailable');
  try {
    if (
      value.context.db !== db ||
      value.context.profileId !== profileId ||
      (session && value.session !== session)
    )
      throw Error('Foreign acceptance review handoff');
    value.signal?.throwIfAborted();
    assertAcceptanceHandoffCurrent(value);
    value.assertRunning?.();
    assertAcceptanceHandoffCurrent(value);
    return value;
  } catch (error) {
    value.session.close();
    throw error;
  }
}
function assertAcceptanceHandoffCurrent(value: AcceptanceHandoffState) {
  value.signal?.throwIfAborted();
  if (
    managedDatabaseMethodEpoch(value.context.db) !== value.methodEpoch ||
    reviewReadStamp(value.context.db) !== value.stamp
  )
    throw new HttpError(409, 'INTAKE_REVIEW_CHANGED', 'Refresh this selected clinical review');
  value.context.assertAuthorityCurrent();
  value.signal?.throwIfAborted();
}
export function consumeCollectionClinicalAcceptanceReview(
  preparation: CollectionClinicalAcceptancePreparation,
  db: DatabaseSync,
  profileId: string,
) {
  const value = consumeAcceptanceHandoff(preparation, 'review', db, profileId);
  return {
    session: value.session,
    context: value.context,
    handoff: acceptanceCapability<CollectionClinicalAcceptanceGroupHandoff>({
      ...value,
      stage: 'group',
    }),
  };
}
export function consumeCollectionClinicalAcceptanceGroup(
  handoff: CollectionClinicalAcceptanceGroupHandoff,
  session: CollectionClinicalReviewSession,
  db: DatabaseSync,
  profileId: string,
) {
  const value = consumeAcceptanceHandoff(handoff, 'group', db, profileId, session);
  return {
    context: value.context,
    handoff: acceptanceCapability<CollectionClinicalAcceptanceProjectionHandoff>({
      ...value,
      stage: 'projection',
    }),
  };
}
/** The singleton reducer may inspect the exact forwarded context, but cannot
 * consume or replace the projection's one-use proof. */
export function inspectCollectionClinicalAcceptanceProjection(
  handoff: CollectionClinicalAcceptanceProjectionHandoff,
  session: CollectionClinicalReviewSession,
  db: DatabaseSync,
  profileId: string,
) {
  const value = acceptanceHandoffs.get(handoff);
  if (!value) throw Error('Foreign acceptance projection handoff');
  try {
    if (
      value.stage !== 'projection' ||
      value.session !== session ||
      value.context.db !== db ||
      value.context.profileId !== profileId
    )
      throw Error('Foreign acceptance projection handoff');
    value.signal?.throwIfAborted();
    assertAcceptanceHandoffCurrent(value);
    value.assertRunning?.();
    assertAcceptanceHandoffCurrent(value);
    return value.context;
  } catch (error) {
    acceptanceHandoffs.delete(handoff);
    value.session.close();
    throw error;
  }
}
export function consumeCollectionClinicalAcceptanceProjection(
  handoff: CollectionClinicalAcceptanceProjectionHandoff,
  session: CollectionClinicalReviewSession,
  db: DatabaseSync,
  profileId: string,
) {
  return consumeAcceptanceHandoff(handoff, 'projection', db, profileId, session).context;
}
/** Host-only exact verified source context; a presentation page cannot mint acceptance authority. */
export function collectionClinicalProjectionContext(
  session: CollectionClinicalReviewSession,
): CollectionClinicalProjectionContext {
  const context = projectionContexts.get(session);
  if (!context) throw Error('Foreign selected clinical review session');
  context.assertCurrent();
  return context;
}
/** Async host reads verify the session's original physical proof off the main thread. */
export async function collectionClinicalProjectionContextAsync(
  session: CollectionClinicalReviewSession,
  signal?: AbortSignal,
  assertRunning?: () => void,
): Promise<CollectionClinicalProjectionContext> {
  const context = projectionContexts.get(session);
  if (!context) throw Error('Foreign selected clinical review session');
  context.assertAuthorityCurrent();
  if (context.verifyPhysicalEvidenceCooperatively)
    await context.verifyPhysicalEvidenceCooperatively(signal, assertRunning);
  else context.assertCurrent();
  context.assertAuthorityCurrent();
  return context;
}
/** Complete bounded JSONL input uses the same pure clinical/identity/pair logic as v1. Package history stays selected. */
export function createCollectionClinicalReviewSession(
  input: Parameters<typeof createCollectionClinicalReviewSessionWork>[0],
): CollectionClinicalReviewResult {
  return finishClinicalReviewWork(createCollectionClinicalReviewSessionWork(input));
}
export function* createCollectionClinicalReviewSessionWork(input: {
  db: DatabaseSync;
  profileId: string;
  proposal: Omit<BuildReviewInput, 'drafts' | 'acceptedDecisions' | 'selected'>;
  scope: ReturnType<typeof collectionWorkflowReviewScope>;
  sourceScopeProblem: NonNullable<BuildReviewInput['selected']>['sourceScopeProblem'];
  self: IntakeIdentitySelfSnapshot;
  identity: SelectedWorkflowIdentityContext;
  ownership: SelectedOwnershipReviewScope;
  reportSource: SelectedClinicalReportSource;
  projection: SelectedClinicalProjectionScope;
  validation: IntakeValidation;
  assertProjectionEvidenceCurrent?(): void;
  verifyProjectionEvidenceCooperatively?(
    signal?: AbortSignal,
    assertRunning?: () => void,
  ): Promise<void>;
  verifiedArtifacts?(): Iterable<VerifiedClinicalArtifact>;
  consumedArtifactIds?(): Iterable<string>;
  beginProjectionConsumption?(): () => void;
  sourceText: { stale: boolean; revisionId: string | null; dependencyToken: string | null };
  assertCurrent(): void;
}): Generator<void, CollectionClinicalReviewResult, void> {
  let closed = false;
  const check = input.assertCurrent;
  input = {
    ...input,
    assertCurrent() {
      if (closed) throw Error('Closed clinical review session');
      check();
    },
  };
  const close = () => {
    if (!closed) {
      closed = true;
      input.scope.close?.();
    }
  };
  const { db, proposal, scope } = input;
  input.assertCurrent();
  if (proposal.entries.length > 50_000 || Number(proposal.inputFile.bytes) > 25 * 1024 * 1024)
    throw new HttpError(
      413,
      'CONVERSION_REQUIRED',
      'Original retained; review a bounded JSONL conversion proposal (at most 25 MiB)',
    );
  let completed = false;
  try {
    const byId = new Map(
      proposal.entries.map((entry) => [`${proposal.inputFile.id}:line:${entry.line}`, entry]),
    );
    const clinical = yield* buildClinicalReviewWork(db, {
      ...proposal,
      selected: {
        sourceScopeProblem: input.sourceScopeProblem,
        reportContext: (envelopeId, proposalId) => scope.reportContext(envelopeId, proposalId),
        reportContextWork: (envelopeId, proposalId) =>
          scope.reportContextWork(envelopeId, proposalId),
        draft: (id) => {
          const entry = byId.get(id);
          if (!entry) throw Error('Review record is not in the complete selected proposal');
          return scope.draft(proposal.proposalId, id, scope.versionId(proposal.proposalId, entry));
        },
        draftWork: function* (id) {
          const entry = byId.get(id);
          if (!entry) throw Error('Review record is not in the complete selected proposal');
          return yield* scope.draftWork!(
            proposal.proposalId,
            id,
            scope.versionId(proposal.proposalId, entry),
          );
        },
        retainDraft: scope.bindPreparedDraft,
        accepted: (id) => scope.latestAcceptedRecord(id),
        acceptedWork: (id) => scope.latestAcceptedRecordWork(id),
      },
    });
    // ClinicalMapping has an internal broader string-kind type; all runtime fields are the same retained review.
    const review = yield* workflowReviewSelectedWork(
      proposal.file,
      scope,
      clinical as unknown as IntakeReview,
      proposal.entries,
      input.self,
      input.identity,
    );
    for (const record of review.records) {
      yield* refreshClinicalIdentityPolicyWork(
        db,
        proposal.file,
        record,
        undefined,
        input.ownership,
      );
      yield;
    }
    yield* finalizeClinicalPairScopesWork(
      db,
      proposal.file,
      proposal.inputFile,
      proposal.entries,
      clinical,
      input.reportSource,
    );
    let issueInlineBytes = 128 * 1024;
    for (const record of review.records)
      issueInlineBytes -= yield* inlineReviewRecordIssuesWork(
        record,
        Math.max(0, issueInlineBytes),
      );
    const reviewHash = createHash('sha256').update(
      '[' + canonicalLiteral(review.reviewToken) + ',',
    );
    for (const piece of scope.canonicalReviewRecords(review.records)) {
      reviewHash.update(piece);
      yield;
    }
    review.reviewToken = reviewHash.update(']').digest('hex');
    review.summary = { additions: 0, duplicates: 0, unsupported: 0, uncertain: 0 };
    for (const record of review.records) {
      review.summary[
        record.classification === 'addition'
          ? 'additions'
          : record.classification === 'duplicate'
            ? 'duplicates'
            : 'unsupported'
      ]++;
      if (record.uncertainties.length) review.summary.uncertain++;
    }
    review.coverageGaps = (clinical as ClinicalReview).records
      .filter((record) => record.problem || record.uncertainties.length)
      .map((record) => ({
        id: record.id,
        label: record.title,
        detail: [record.problem, ...record.uncertainties].filter(Boolean).join('; '),
        evidence: record.evidence,
      }));
    review.sourceTextStale = input.sourceText.stale;
    if (review.sourceTextStale)
      review.coverageGaps.push({
        id: 'source-text-changed',
        label: 'Source text changed',
        detail:
          'This proposal uses earlier source text. Read the corrected source and create a new proposal before acceptance.',
      });
    for (const record of review.records)
      record.selectionReviewToken = yield* selectionAuthorityWork(
        {
          profileId: input.profileId,
          intakeId: proposal.file.id,
          proposalId: proposal.proposalId,
          originalHash: proposal.file.sha256,
          proposalHash: proposal.inputFile.sha256,
          sourceTextRevisionId: input.sourceText.revisionId,
          sourceTextDependencyToken: input.sourceText.dependencyToken,
          sourceTextStale: review.sourceTextStale || false,
          record,
        },
        { recordComparisonsUndefined: true },
      );
    input.assertCurrent();
    const values = (section: Section): unknown[] => {
      if (!['records', 'sourceContext', 'coverageGaps'].includes(section))
        throw new HttpError(400, 'REVIEW_SECTION', 'Choose a clinical review section');
      return review[section] || [];
    };
    const cursor = (section: Section, ordinal: number) =>
      Buffer.from(
        JSON.stringify([
          input.profileId,
          review.intakeId,
          review.proposalId,
          review.reviewToken,
          section,
          ordinal,
        ]),
      ).toString('base64url');
    const session: CollectionClinicalReviewSession = {
      close,
      review,
      ownership: input.ownership,
      record(recordId, candidateId, candidateVersionId) {
        input.assertCurrent();
        return review.records.find(
          (record) =>
            record.id === recordId &&
            (candidateId === undefined || record.candidateId === candidateId) &&
            (candidateVersionId === undefined || record.candidateVersionId === candidateVersionId),
        );
      },
      selectedRecord(recordId, candidateVersionId, bytes = 128 * 1024) {
        input.assertCurrent();
        if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 256 * 1024)
          throw new HttpError(
            400,
            'REVIEW_WINDOW',
            'Choose a record byte budget from 1024 to 262144',
          );
        const ordinal = review.records.findIndex(
          (record) =>
            record.id === recordId &&
            (candidateVersionId === undefined || record.candidateVersionId === candidateVersionId),
        );
        if (ordinal < 0)
          throw new HttpError(404, 'REVIEW_RECORD_NOT_FOUND', 'Clinical review record not found');
        const record = review.records[ordinal]!,
          groupLinks = isSelectedReportGroups(record.reportGroups)
            ? record.reportGroups
            : selectedReportGroupLinks(
                () => selectedReportGroups(record.reportGroups),
                {
                  candidateId: record.candidateId!,
                  candidateVersionId: record.candidateVersionId!,
                  recordId: record.id,
                  proposalId: review.proposalId,
                },
                0,
                (ordinal) => selectedReportGroupAt(record.reportGroups, ordinal),
              ),
          size = Buffer.byteLength(JSON.stringify(record)),
          value = { kind: 'record' as const, record },
          blockingIssueCount =
            (record.identityReview?.blocking ? 1 : 0) +
            reviewRecordIssues(record).filter(
              (issue) => issue.blocking && issue.status !== 'resolved',
            ).length,
          unreviewedPairChoices = hasUnreviewedPairChoices(record);
        return {
          format: 'health-intake-clinical-record-v2',
          context: {
            intakeId: review.intakeId,
            proposalId: review.proposalId,
            version: review.version,
            reviewToken: review.reviewToken,
            summary: review.summary,
            sourceTextStale: !!review.sourceTextStale,
          },
          record:
            record.questionsReference ||
            record.issuesReference ||
            Buffer.byteLength(JSON.stringify(value)) > bytes
              ? {
                  kind: 'reference',
                  reference: {
                    format: 'health-intake-clinical-review-reference-v2',
                    reviewToken: review.reviewToken,
                    section: 'records',
                    ordinal,
                    bytes: size,
                  },
                  selection: {
                    recordId: record.id,
                    candidateId: record.candidateId,
                    candidateVersionId: record.candidateVersionId,
                    selectionReviewToken: record.selectionReviewToken,
                  },
                  ...(record.identityReview?.ownershipBlockers
                    ? { ownershipBlockers: record.identityReview.ownershipBlockers }
                    : {}),
                  ...(record.identityReview?.warningsReference
                    ? { identityWarnings: record.identityReview.warningsReference }
                    : {}),
                  ...(record.draft?.history ? { draftHistory: record.draft.history } : {}),
                  ...(!Array.isArray(groupLinks) ? { reportGroups: groupLinks } : {}),
                  policy: {
                    canAcceptUnchanged:
                      !review.sourceTextStale &&
                      record.reviewState !== 'accepted' &&
                      record.reviewState !== 'kept_original' &&
                      (!record.draft || record.draft.disposition === 'pending') &&
                      record.classification !== 'unsupported' &&
                      ['observation', 'medication', 'procedure', 'document'].includes(
                        record.mapping.kind || '',
                      ) &&
                      blockingIssueCount === 0 &&
                      !unreviewedPairChoices &&
                      !record.draft?.decision?.comparisons?.some((pair) => !pair.reason.trim()),
                    blockingIssueCount,
                    unreviewedPairChoices,
                    classification: record.classification,
                    kind: record.kind,
                  },
                }
              : value,
        };
      },
      page(section, options) {
        input.assertCurrent();
        if (
          !Number.isSafeInteger(options.items) ||
          options.items < 1 ||
          options.items > 100 ||
          !Number.isSafeInteger(options.bytes) ||
          options.bytes < 1024 ||
          options.bytes > 256 * 1024
        )
          throw new HttpError(
            400,
            'REVIEW_WINDOW',
            'Choose 1 to 100 review items and a byte budget from 1024 to 262144',
          );
        const all = values(section);
        let start = 0;
        if (options.cursor) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
          } catch {
            throw new HttpError(409, 'REVIEW_CURSOR', 'Refresh this selected review');
          }
          if (
            !Array.isArray(parsed) ||
            parsed.length !== 6 ||
            parsed[0] !== input.profileId ||
            parsed[1] !== review.intakeId ||
            parsed[2] !== review.proposalId ||
            parsed[3] !== review.reviewToken ||
            parsed[4] !== section ||
            !Number.isSafeInteger(parsed[5]) ||
            parsed[5] < 0 ||
            parsed[5] > all.length
          )
            throw new HttpError(409, 'REVIEW_CURSOR', 'Refresh this selected review');
          start = parsed[5];
        }
        const items: IntakeClinicalReviewPage['items'] = [];
        let bytes = 0,
          index = start;
        for (; index < all.length && items.length < options.items; index++) {
          const size = Buffer.byteLength(JSON.stringify(all[index]));
          const item: IntakeClinicalReviewPage['items'][number] =
            size > options.bytes
              ? {
                  kind: 'reference',
                  reference: {
                    format: 'health-intake-clinical-review-reference-v2',
                    reviewToken: review.reviewToken,
                    section,
                    ordinal: index,
                    bytes: size,
                  },
                }
              : { kind: 'value', ordinal: index, value: all[index] };
          const cost = Buffer.byteLength(JSON.stringify(item));
          if (items.length && bytes + cost > options.bytes) break;
          // A value's wrapper may itself exceed the budget; return a compact reference instead.
          if (cost > options.bytes && item.kind === 'value')
            items.push({
              kind: 'reference',
              reference: {
                format: 'health-intake-clinical-review-reference-v2',
                reviewToken: review.reviewToken,
                section,
                ordinal: index,
                bytes: size,
              },
            });
          else items.push(item);
          bytes += cost;
        }
        return {
          format: 'health-intake-clinical-review-page-v2',
          intakeId: review.intakeId,
          proposalId: review.proposalId,
          version: review.version,
          reviewToken: review.reviewToken,
          section,
          summary: review.summary,
          sourceTextStale: !!review.sourceTextStale,
          total: all.length,
          items,
          nextCursor: index < all.length ? cursor(section, index) : null,
        };
      },
      fragment(reference, offset, bytes) {
        input.assertCurrent();
        const all = values(reference.section);
        if (
          reference.format !== 'health-intake-clinical-review-reference-v2' ||
          reference.reviewToken !== review.reviewToken ||
          !Number.isSafeInteger(reference.ordinal) ||
          reference.ordinal < 0 ||
          reference.ordinal >= all.length ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(bytes) ||
          bytes < 1 ||
          bytes > 256 * 1024
        )
          throw new HttpError(409, 'REVIEW_FRAGMENT', 'Refresh this selected review fragment');
        const data = Buffer.from(JSON.stringify(all[reference.ordinal]));
        if (reference.bytes !== data.length || offset > data.length)
          throw new HttpError(409, 'REVIEW_FRAGMENT', 'Refresh this selected review fragment');
        const end = Math.min(data.length, offset + bytes);
        return {
          encoding: 'base64',
          data: data.subarray(offset, end).toString('base64'),
          complete: end === data.length,
          nextOffset: end === data.length ? null : end,
        };
      },
    };
    projectionContexts.set(session, {
      beginProjectionConsumption() {
        input.assertCurrent();
        if (!input.beginProjectionConsumption)
          throw Error('Clinical projection consumption checkpoint is unavailable');
        return input.beginProjectionConsumption();
      },
      *consumedArtifactIds() {
        input.assertCurrent();
        if (!input.consumedArtifactIds)
          throw Error('Clinical consumed artifact proof is unavailable');
        yield* input.consumedArtifactIds();
      },
      *verifiedArtifacts() {
        input.assertCurrent();
        if (!input.verifiedArtifacts) throw Error('Clinical artifact proof is unavailable');
        yield* input.verifiedArtifacts();
      },
      db,
      profileId: input.profileId,
      proposal,
      review: clinical,
      selected: input.projection,
      validation: input.validation,
      assertAuthorityCurrent() {
        input.assertCurrent();
      },
      assertCurrent() {
        input.assertCurrent();
        input.assertProjectionEvidenceCurrent?.();
      },
      verifyPhysicalEvidenceCooperatively: input.verifyProjectionEvidenceCooperatively,
    });
    completed = true;
    return { status: 'ready', session };
  } catch (error) {
    close();
    if (error instanceof IntakeReviewFragmentRequired)
      return { status: 'fragment_required', reference: error.reference };
    throw error;
  } finally {
    if (!completed) close();
  }
}
