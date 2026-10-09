import { reviewRecordIssues, reviewIssueForQuestion } from './intake-review-issue-state.ts';
import { reviewRecordQuestions } from './intake-review-question-selection.ts';
/** Addressed acceptance effects. The clinical host proves the complete review,
 * source and pair scopes; the ordinary transaction publishes its clinical
 * projection and these exact retained workflow effects together. */
import { createHash } from 'node:crypto';
import {
  HttpError,
  revision,
  currentTransactionToken,
  observeTransactionOutcome,
  observeTransactionBeforePublication,
  type Database,
} from './database.ts';
import { canonicalLiteral, cloneLiteral } from './intake-format.ts';
import {
  intakeWorkflowQuestionValue,
  intakeCandidateId,
  intakeCandidateVersionIdForRevision,
  workflowHash,
} from './intake-workflow.ts';
import { personalDurabilityStatus } from './portable.ts';
import type { IntakeEntry } from './intake-format.ts';
import type { IntakeEnvelopeSource } from './intake-authority.ts';
import type {
  IntakeReview,
  IntakeReviewDecision,
  IntakeClinicalMapping,
  IntakeAtomicAcceptanceReceipt,
} from '../shared/intake.ts';
import type {
  IntakeCollectionEnvelopeReader,
  IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import type {
  IntakeEnvelopeMutation,
  IntakeEnvelopeDerivedPreparation,
} from './intake-envelope-mutation.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from './intake-collection-envelope.ts';
import { intakeSourceVersion } from './intake-state-access.ts';
import {
  nativeIntakeReceiptAppendBasis,
  retainNativeIntakeReceiptAppend,
} from './intake-lookup-projection.ts';
import {
  collectionClinicalProjectionContext,
  type CollectionClinicalReviewSession,
} from './intake-review-collection-session.ts';
import {
  prepareCollectionClinicalProjectionWithEvidence,
  preparedClinicalEvidenceChanges,
  preparedClinicalProjectionResult,
  preparedClinicalProjectionMatchingRows,
  applyPreparedClinicalProjection,
  disposePreparedClinicalProjection,
} from './intake-clinical-projection-plan.ts';
import {
  prepareIntakeCollectionProposal,
  type NativeProposalAffected,
  type NativeProposalReportEvidence,
} from './intake-collection-proposals.ts';
import type { IntakeCollectionChange } from './intake-state-storage.ts';

export interface NativeAcceptanceEffects {
  candidateChanges: Array<{
    candidateId: string;
    candidateVersionId: string;
    candidateAddress: string;
    versionAddress: string;
    kind: 'update';
  }>;
  questionAddresses: string[];
  decisionAddresses: string[];
  importedAddress?: string;
  archivedImportAddress?: string;
  archivedImportAddresses: string[];
  importedReceiptAddresses: string[];
  acceptedRecordAddresses: string[];
  reportAcceptanceAddresses: string[];
  identityReceiptAddresses: string[];
}
export function createNativeAcceptanceEffects(): NativeAcceptanceEffects {
  return {
    candidateChanges: [],
    questionAddresses: [],
    decisionAddresses: [],
    acceptedRecordAddresses: [],
    archivedImportAddresses: [],
    importedReceiptAddresses: [],
    reportAcceptanceAddresses: [],
    identityReceiptAddresses: [],
  };
}
function field(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): unknown {
  const value = view.field(record, name, { bytes: 8192 });
  if (value.kind === 'fragmented')
    throw Error('Acceptance field requires selected fragment access: ' + name);
  return value.kind === 'value' ? value.value : undefined;
}

/** Same record-level blockers and saved-answer mapping agreement as the legacy
 * prepareIntakeImport. Complete source/pair/identity scope remains host policy. */
export function nativeAcceptanceDecisions(
  review: IntakeReview,
  supplied: readonly IntakeReviewDecision[],
): IntakeReviewDecision[] {
  const seen = new Set<string>();
  return supplied.map((input) => {
    const record = review.records.find((record) => record.id === input.recordId);
    if (!record || seen.has(input.recordId))
      throw new HttpError(400, 'IMPORT_REVIEW', 'Unknown or repeated review decision');
    seen.add(input.recordId);
    if (!['accept', 'skip'].includes(input.action))
      throw new HttpError(400, 'IMPORT_REVIEW', 'Choose accept or skip');
    const decision = {
      ...input,
      mapping: { ...(record.draft?.mapping ?? {}), ...(input.mapping ?? {}) },
    };
    if (decision.action !== 'accept') return decision;
    if (review.sourceTextStale)
      throw new HttpError(
        409,
        'SOURCE_TEXT_CHANGED',
        'This proposal uses earlier source text. Review a current proposal before accepting.',
      );
    if (record.reviewState === 'kept_original')
      throw new HttpError(
        409,
        'REVIEW_DISPOSITION',
        'This candidate was kept as original evidence only',
      );
    if (
      reviewRecordIssues(record).some(
        (issue) => issue.blocking && issue.status !== 'resolved' && !issue.questionId,
      ) ||
      record.identityReview?.blocking
    )
      throw new HttpError(
        409,
        'REVIEW_ISSUES_PENDING',
        'Review this record’s identity or uncertain reading before accepting it',
      );
    if (
      reviewRecordQuestions(record).some(
        (question) =>
          question.status === 'unanswered' &&
          reviewIssueForQuestion(record, question.id)?.blocking !== false &&
          reviewIssueForQuestion(record, question.id)?.status !== 'resolved' &&
          !(
            question.field === 'duplicate' &&
            decision.comparisons?.some(
              (pair) =>
                pair.otherRecordId === question.otherRecordId &&
                ['same_event', 'changed_version', 'distinct'].includes(pair.outcome),
            )
          ),
      )
    )
      throw new HttpError(
        409,
        'QUESTIONS_PENDING',
        'Answer this record’s questions before accepting it; other resolved records can be accepted independently',
      );
    for (const [name, value] of Object.entries(record.suggestedMapping ?? {}))
      if (
        canonicalLiteral(
          decision.mapping[name as keyof IntakeClinicalMapping] ??
            record.mapping[name as keyof IntakeClinicalMapping],
        ) !== canonicalLiteral(value)
      )
        throw new HttpError(
          409,
          'ANSWER_REVIEW_REQUIRED',
          'Review the saved answer’s proposed field correction before accepting this record',
        );
    return decision;
  });
}

/** Consumed by the existing staged envelope mutation writer. Every read after a
 * yielded append observes that selected build, including prior decisions in the
 * same bounded approval. No partial workflow is passed to legacy mutators. */
export function* nativeAcceptanceDecisionChanges(input: {
  view: IntakeCollectionEnvelopeReader;
  file: { id: string; sha256: string };
  review: IntakeReview;
  decisions: readonly IntakeReviewDecision[];
  at: string;
  effects: NativeAcceptanceEffects;
}): Generator<IntakeEnvelopeMutation> {
  const { view, review, decisions, at, effects } = input,
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) throw Error('Acceptance requires selected workflow candidates');
  const changedQuestions = new Set<string>();
  const questionChanged = (question: IntakeEnvelopeRecord) => {
    const address = view.address(question);
    if (!changedQuestions.has(address)) {
      changedQuestions.add(address);
      effects.questionAddresses.push(address);
    }
  };
  for (const decision of decisions) {
    const record = review.records.find((record) => record.id === decision.recordId);
    if (!record) continue;
    for (const comparison of decision.comparisons ?? []) {
      const target =
        record.comparisons?.find((item) => item.id === comparison.otherRecordId) ??
        (comparison.scope
          ? {
              id: comparison.otherRecordId,
              identity: comparison.scope.saved.identity,
              version: comparison.scope.saved.version,
            }
          : undefined);
      if (!target) continue;
      const value = intakeWorkflowQuestionValue(input.file, {
        key:
          'duplicate:' +
          workflowHash([
            record.candidateId,
            record.candidateVersionId,
            target.identity,
            target.version,
          ]),
        candidateId: record.candidateId,
        candidateVersionId: record.candidateVersionId,
        prompt:
          'Review whether these paired records describe the same event, a changed version, or distinct events.',
        locator: record.evidence[0]?.locator || 'Retained original',
        field: 'duplicate',
      });
      if (record.candidateId && !view.find('candidate', workflow, record.candidateId))
        throw new HttpError(
          404,
          'CANDIDATE_NOT_FOUND',
          'Question record does not belong to this delivery',
        );
      let question = view.find('question', workflow, value.id);
      if (question) {
        if (Object.entries(value).some(([name, value]) => field(view, question!, name) !== value))
          throw new HttpError(
            409,
            'QUESTION_CONFLICT',
            'This question key already refers to different evidence',
          );
      } else {
        yield {
          op: 'append',
          record: workflow,
          field: 'questions',
          jsonText: JSON.stringify({ ...value, status: 'unanswered', createdAt: at, answers: [] }),
        };
        question = view.find('question', workflow, value.id);
      }
      if (!question) throw Error('New selected comparison question is missing');
      yield {
        op: 'set',
        record: question,
        field: 'otherRecordId',
        jsonText: JSON.stringify(target.id),
      };
      const answerId = 'answer:' + workflowHash([review.reviewToken, comparison]);
      if (!view.find('answer', question, answerId))
        yield {
          op: 'append',
          record: question,
          field: 'answers',
          jsonText: JSON.stringify({
            id: answerId,
            answer: comparison.reason,
            mapping: {},
            scope: 'record',
            outcome: comparison.outcome,
            otherRecordId: target.id,
            at,
          }),
        };
      const status = comparison.outcome === 'unresolved' ? 'unanswered' : 'resolved';
      yield { op: 'set', record: question, field: 'status', jsonText: JSON.stringify(status) };
      if (status === 'resolved') {
        yield { op: 'set', record: question, field: 'resolvedAt', jsonText: JSON.stringify(at) };
        yield {
          op: 'set',
          record: question,
          field: 'resolvedByDecisionId',
          jsonText: JSON.stringify(answerId),
        };
      }
      questionChanged(question);
    }
    if (decision.action !== 'accept') continue;
    const accepted = {
      id: 'decision:' + workflowHash([review.reviewToken, decision]),
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      recordId: record.id,
      action: 'accept',
      mapping: decision.mapping ?? {},
      scope: decision.rememberRule ? 'reusable-rule' : 'record',
      evidence: record.evidence,
      at,
    };
    if (!view.find('decision', workflow, accepted.id))
      yield {
        op: 'append',
        record: workflow,
        field: 'decisions',
        jsonText: JSON.stringify(accepted),
      };
    const acceptedRecord = view.find('decision', workflow, accepted.id);
    if (acceptedRecord) effects.decisionAddresses.push(view.address(acceptedRecord));
    const candidate = record.candidateId && view.find('candidate', workflow, record.candidateId),
      version =
        candidate &&
        record.candidateVersionId &&
        view.find('version', candidate, record.candidateVersionId);
    if (candidate && version) {
      yield { op: 'set', record: version, field: 'status', jsonText: '"accepted"' };
      effects.candidateChanges.push({
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        candidateAddress: view.address(candidate),
        versionAddress: view.address(version),
        kind: 'update',
      });
    }
    for (const reference of reviewRecordQuestions(record)) {
      const question = view.find('question', workflow, reference.id);
      if (
        question &&
        field(view, question, 'status') === 'answered' &&
        field(view, question, 'field') !== 'duplicate' &&
        reviewIssueForQuestion(record, reference.id)?.resolution?.outcome !== 'unknown'
      ) {
        yield { op: 'set', record: question, field: 'status', jsonText: '"resolved"' };
        yield { op: 'set', record: question, field: 'resolvedAt', jsonText: JSON.stringify(at) };
        yield {
          op: 'set',
          record: question,
          field: 'resolvedByDecisionId',
          jsonText: JSON.stringify(accepted.id),
        };
        questionChanged(question);
      }
    }
  }
}

export function* nativeAcceptanceReceiptChanges(input: {
  staged: IntakeCollectionEnvelopeReader;
  file: { id: string; sha256: string };
  review: IntakeReview;
  reviewed: boolean;
  reviewToken?: string;
  decisions: readonly IntakeReviewDecision[];
  at: string;
  effects: NativeAcceptanceEffects;
  proposalId: string | null;
  imported: Record<string, unknown>;
  decisionFingerprint: string;
  fingerprint: string;
  reportReceipt?: IntakeAtomicAcceptanceReceipt;
}): Generator<IntakeEnvelopeMutation> {
  const {
    staged,
    file,
    review,
    reviewed,
    reviewToken,
    decisions,
    at,
    effects,
    proposalId,
    imported,
    decisionFingerprint,
    reportReceipt,
  } = input;

  const current = staged.child(staged.root(), 'intake')!,
    oldProposal = field(staged, current, 'acceptedProposalId'),
    oldReviewToken = field(staged, current, 'lastReviewToken'),
    oldImported = staged.child(current, 'imported');
  if (reviewed)
    yield* nativeAcceptanceDecisionChanges({
      view: staged,
      file,
      review: review,
      decisions,
      at,
      effects,
    });
  yield {
    op: 'archive-current-import',
    record: current,
    acceptedProposalId: typeof oldProposal === 'string' ? oldProposal : null,
    reviewToken: typeof oldReviewToken === 'string' ? oldReviewToken : null,
  };
  if (oldImported) {
    const address = staged.address(oldImported);
    effects.archivedImportAddress ??= address;
    effects.archivedImportAddresses.push(address);
  }
  yield {
    op: 'set',
    record: current,
    field: 'lastDecisionFingerprint',
    jsonText: JSON.stringify(decisionFingerprint),
  };
  yield {
    op: 'set',
    record: current,
    field: 'lastReviewToken',
    jsonText: JSON.stringify(reviewToken || null),
  };
  yield {
    op: 'set',
    record: current,
    field: 'acceptedProposalId',
    jsonText: JSON.stringify(proposalId),
  };
  yield {
    op: 'set',
    record: current,
    field: 'imported',
    jsonText: JSON.stringify(imported),
  };
  const receipt = staged.child(current, 'imported')!,
    clinicalRecord = staged.child(receipt, 'clinical');
  effects.importedAddress = staged.address(receipt);
  effects.importedReceiptAddresses.push(effects.importedAddress);
  let after: string | undefined;
  while (clinicalRecord) {
    const page = staged.children(clinicalRecord, 'records', {
      after,
      items: 32,
      bytes: 32768,
    });
    for (const record of page.records) effects.acceptedRecordAddresses.push(staged.address(record));
    if (page.complete) break;
    if (!page.after || page.after === after) throw Error('Accepted receipt cursor did not advance');
    after = page.after;
  }
  if (reportReceipt) {
    const workflow = staged.child(current, 'workflow')!,
      ordinal = staged.childCount(workflow, 'reportAcceptances');
    yield {
      op: 'append',
      record: workflow,
      field: 'reportAcceptances',
      jsonText: JSON.stringify({ fingerprint: input.fingerprint, receipt: reportReceipt }),
    };
    const retained = staged.childAt(workflow, 'reportAcceptances', ordinal);
    if (!retained) throw Error('Missing selected atomic acceptance receipt');
    effects.reportAcceptanceAddresses.push(staged.address(retained));
  }
}

/** The host supplies complete package/context authority and the exact changed
 * workflow reducer. SQL projection runs on its verified session, never a page. */
export async function prepareNativeIntakeAcceptance(
  db: Database,
  root: string,
  profileId: string,
  input: {
    session: CollectionClinicalReviewSession;
    expectedVersion: number;
    reviewToken?: string;
    decisions: readonly IntakeReviewDecision[];
    operationId: string;
    fingerprint: string;
    /** Host-computed exact request bytes, before certified pair transport refresh. */
    requestDecisionFingerprint?: string;
    retainReportReceipt?: boolean;
    reportReceipt?: (result: {
      imported: {
        records: number;
        repeatedRows: number;
        matchingEarlierRows: number;
        at: string;
        fileId: string;
        clinical?: ReturnType<typeof preparedClinicalProjectionResult>;
      };
      intakeVersionBefore: number;
      intakeVersionAfter: number;
      decisions: readonly IntakeReviewDecision[];
      review: IntakeReview;
    }) => IntakeAtomicAcceptanceReceipt;
    reportEvidence: NativeProposalReportEvidence;
    nextDiscoveryOrder(): number;
    prepareDerived(
      input: IntakeEnvelopeDerivedPreparation & {
        affected: NativeProposalAffected;
        acceptance: NativeAcceptanceEffects;
      },
    ): Promise<{
      changes: readonly IntakeCollectionChange[];
      needsReview: boolean;
      receiptAppend?: object;
    }>;
    assertRunning?: () => void;
  },
) {
  const context = collectionClinicalProjectionContext(input.session),
    file = context.proposal.file,
    before = intakeSourceVersion(db, file.id),
    view = openIntakeCollectionEnvelope(db, file),
    intake = view.child(view.root(), 'intake')!;
  if (context.db !== db || context.profileId !== profileId)
    throw Error('Foreign acceptance clinical session');
  if (before.version !== input.expectedVersion)
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'This intake changed. Reload it before continuing.',
    );
  const reviewed = !!input.reviewToken;
  if (reviewed && input.session.review.reviewToken !== input.reviewToken)
    throw new HttpError(
      409,
      'REVIEW_CHANGED',
      'The archive or proposal changed. Review it again before accepting.',
    );
  if (!reviewed && context.proposal.entries.some((entry) => entry.value.clinical))
    throw new HttpError(
      400,
      'REVIEW_REQUIRED',
      'Review clinical additions before accepting this proposal',
    );
  const supplied = cloneLiteral(input.decisions),
    decisions = reviewed ? nativeAcceptanceDecisions(input.session.review, supplied) : [],
    proposalId = context.proposal.proposalId,
    proposal = proposalId ? view.find('proposal', intake, proposalId) : undefined;
  if (proposalId && !proposal) throw Error('Selected acceptance proposal is missing');
  const assertCurrent = () => {
    input.assertRunning?.();
    context.assertCurrent();
    const current = intakeSourceVersion(db, file.id);
    if (current.version !== before.version || current.logicalBinding !== before.logicalBinding)
      throw new HttpError(
        409,
        'VERSION_CONFLICT',
        'This intake changed. Reload it before continuing.',
      );
  };
  assertCurrent();
  const projection = await prepareCollectionClinicalProjectionWithEvidence(
    db,
    root,
    profileId,
    input.session,
    decisions,
    { reviewed },
  );
  try {
    const clinical = preparedClinicalProjectionResult(projection),
      entries = context.proposal.entries,
      seen = new Set<string>(),
      repeatedRows = entries.reduce((count, entry) => {
        const repeated = seen.has(entry.canonical);
        seen.add(entry.canonical);
        return count + Number(repeated);
      }, 0),
      at = new Date().toISOString(),
      imported = {
        records: entries.length,
        repeatedRows,
        matchingEarlierRows: preparedClinicalProjectionMatchingRows(projection),
        at,
        fileId: context.proposal.inputFile.id,
        ...(clinical ? { clinical } : {}),
      },
      decisionFingerprint =
        input.requestDecisionFingerprint ??
        createHash('sha256')
          .update(canonicalLiteral({ proposalId, decisions: supplied }))
          .digest('hex'),
      effects = createNativeAcceptanceEffects(),
      collections = selectedEnvelopeStore(db, file).collections;
    const receiptAppendBasis =
      input.retainReportReceipt === false || !before.logicalBinding
        ? undefined
        : nativeIntakeReceiptAppendBasis(db, file, before.logicalBinding);
    let receiptAppend:
      { logical: string; proof: object; reader: IntakeCollectionEnvelopeReader } | undefined;
    const reportReceipt = structuredClone(
      input.reportReceipt?.({
        imported: structuredClone(imported),
        intakeVersionBefore: before.version,
        intakeVersionAfter: before.version + 1,
        decisions: cloneLiteral(decisions),
        review: cloneLiteral(input.session.review),
      }),
    );
    if (reportReceipt)
      validateSingleAcceptanceReceipt(reportReceipt, {
        operationId: input.operationId,
        intakeId: file.id,
        proposalId,
        before: before.version,
        review: input.session.review,
        imported,
        decisions,
      });
    let needsReview: boolean | undefined,
      unchangedVersionHeaders = true;
    const prepared = await prepareIntakeCollectionProposal(db, file, {
      reader: view,
      file,
      proposalId,
      entries,
      operationId: input.operationId,
      requestDigest: input.fingerprint,
      domainVersion: before.rawVersion + 1,
      createdAt: at,
      reportEvidence: input.reportEvidence,
      nextDiscoveryOrder: input.nextDiscoveryOrder,
      sourceTextDependencyToken: proposal
        ? (field(view, proposal, 'sourceTextDependencyToken') as string | null | undefined)
        : undefined,
      sourceTextRevisionId: proposal
        ? (field(view, proposal, 'sourceTextRevisionId') as string | null | undefined)
        : undefined,
      assertRunning: assertCurrent,
      prepareDerived: async (value) => {
        receiptAppend = undefined;
        if (reportReceipt) {
          for (const changed of value.affected.candidateChanges) {
            if (changed.kind !== 'update') {
              unchangedVersionHeaders = false;
              continue;
            }
            try {
              const previous = view.resolve(changed.versionAddress),
                next = value.reader.resolve(changed.versionAddress);
              if (
                field(view, previous, 'status') !== 'pending' ||
                field(value.reader, next, 'status') !== 'accepted'
              )
                unchangedVersionHeaders = false;
              for (const name of ['sourceContext', 'peopleCount', 'peopleOnly'])
                if (
                  canonicalLiteral(field(view, previous, name)) !==
                  canonicalLiteral(field(value.reader, next, name))
                )
                  unchangedVersionHeaders = false;
            } catch {
              unchangedVersionHeaders = false;
            }
          }
        }
        const result = await input.prepareDerived({ ...value, acceptance: effects });
        if (typeof result.needsReview !== 'boolean')
          throw Error('Acceptance requires exact updated workflow facts');
        needsReview = result.needsReview;
        if (receiptAppendBasis && reportReceipt && result.receiptAppend && before.logicalBinding) {
          receiptAppend = {
            logical: JSON.stringify(value.logical),
            proof: result.receiptAppend,
            reader: value.reader,
          };
        }
        return [...result.changes, ...preparedClinicalEvidenceChanges(projection, file.id)];
      },
      derivedIntakeState: () => {
        if (needsReview === undefined) throw Error('Acceptance requires complete workflow facts');
        return needsReview ? 'needs_review' : 'imported';
      },
      compose: {
        additionalLogicalChanges: [],
        changes: (staged) =>
          nativeAcceptanceReceiptChanges({
            staged,
            file,
            review: input.session.review,
            reviewed,
            reviewToken: input.reviewToken,
            decisions,
            at,
            effects,
            proposalId,
            imported,
            decisionFingerprint,
            fingerprint: input.fingerprint,
            reportReceipt: input.retainReportReceipt === false ? undefined : reportReceipt,
          }),
      },
    });
    if (!prepared.prepared) {
      disposePreparedClinicalProjection(projection);
      return { replay: prepared.replay, prepared: undefined };
    }
    assertCurrent();
    const expectedLogical = JSON.stringify(collections.inspectPrepared(prepared.prepared).logical);
    let disposed = false;
    return {
      replay: undefined,
      prepared: prepared.prepared,
      effects,
      affected: prepared.affected,
      imported,
      reportReceipt,
      decisionFingerprint,
      decisions,
      intakeVersion: before.version + 1,
      projectDetailsJson: prepared.projectDetailsJson!,
      assertCurrent,
      /** Must be first accepted application write in the final ordinary transaction. */
      apply() {
        if (disposed) throw Error('Disposed acceptance preparation');
        assertCurrent();
        const footprint =
          reportReceipt && input.retainReportReceipt !== false
            ? captureAcceptanceFootprint(db)
            : undefined;
        try {
          applyPreparedClinicalProjection(db, projection);
          collections.stage(prepared.prepared!);
          // This fixed host effect is part of the acceptance capability, derived
          // only from the checked review context and the actual projection. Keep
          // it inside the footprint so callers cannot authorize arbitrary SQL
          // merely by asking for acceptance-only revalidation.
          db.prepare(
            "UPDATE manual_batches SET status='verified',verified_at=?,coverage_json=?,notes=? WHERE id=?",
          ).run(
            at,
            JSON.stringify({
              sourceIntake: file.id,
              rawPreserved: true,
              validation: context.validation,
              imported,
              clinicalProjection: clinical ? 'reviewed' : 'none',
            }),
            clinical
              ? 'Explicitly accepted clinical projection, original assertions and evidence preserved.'
              : 'Verified original hash and JSONL syntax/provenance. All source occurrences retained; repeated content is counted, not merged as clinical events. Clinical mapping and source truth are unreviewed.',
            file.batch_id,
          );
          // intakeTransaction records this same fixed revision after its host
          // callback. Include that owned marker now so the final footprint can
          // prove the wrapper only repeats the identical value.
          db.prepare(
            "INSERT INTO app_meta(key,value) VALUES('intake_mutation_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(String(revision(db) + 1));
          if (reportReceipt && footprint) {
            footprint.seal();
            observeOwnedAcceptanceTransition(
              db,
              {
                source: file,
                before: before.logicalBinding!,
                after: expectedLogical,
                operationId: input.operationId,
                fingerprint: input.fingerprint,
                receipt: reportReceipt,
                receiptAppend:
                  receiptAppendBasis && receiptAppend?.logical === expectedLogical
                    ? {
                        basis: receiptAppendBasis,
                        proof: receiptAppend.proof,
                        reader: receiptAppend.reader,
                      }
                    : undefined,
                simple:
                  unchangedVersionHeaders &&
                  reportReceipt.receipts[0]!.proposalId !== null &&
                  effects.questionAddresses.length === 0 &&
                  prepared.affected.questionAddresses.length === 0 &&
                  decisions.every((d) => d.action === 'accept' && !d.comparisons?.length) &&
                  prepared.affected.candidateChanges.every((c) => c.kind === 'update') &&
                  new Set(
                    prepared.affected.candidateChanges.map((c) =>
                      JSON.stringify([c.candidateId, c.candidateVersionId]),
                    ),
                  ).size === reportReceipt.acceptedCount &&
                  reportReceipt.receipts[0]!.records.every((record) =>
                    prepared.affected.candidateChanges.some(
                      (c) =>
                        c.candidateId === record.candidateId &&
                        c.candidateVersionId === record.candidateVersionId,
                    ),
                  ),
              },
              footprint,
            );
          }
          return { intakeVersion: before.version + 1, imported: structuredClone(imported) };
        } catch (error) {
          footprint?.close();
          throw error;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        disposePreparedClinicalProjection(projection);
        collections.disposePreparation(prepared.prepared!);
      },
    };
  } catch (error) {
    disposePreparedClinicalProjection(projection);
    throw error;
  }
}

export function validateSingleAcceptanceReceipt(
  receipt: IntakeAtomicAcceptanceReceipt,
  expected: {
    operationId: string;
    intakeId: string;
    proposalId: string | null;
    before: number;
    review: IntakeReview;
    imported: { clinical?: ReturnType<typeof preparedClinicalProjectionResult> };
    decisions: readonly IntakeReviewDecision[];
  },
) {
  const block = receipt.receipts[0],
    records = expected.imported.clinical?.records;
  if (
    receipt.operationId !== expected.operationId ||
    receipt.status !== 'accepted' ||
    receipt.atomic !== true ||
    receipt.receipts.length !== 1 ||
    !block ||
    !records ||
    !records.length ||
    records.length > 1000 ||
    receipt.selectedCount !== records.length ||
    receipt.acceptedCount !== records.length ||
    block.intakeId !== expected.intakeId ||
    block.proposalId !== expected.proposalId ||
    block.intakeVersionBefore !== expected.before ||
    block.intakeVersionAfter !== expected.before + 1 ||
    block.reviewToken !== expected.review.reviewToken ||
    block.records.length !== records.length ||
    expected.decisions.filter((d) => d.action === 'accept').length !== records.length
  )
    throw Error('Atomic acceptance receipt disagrees with actual clinical projection');
  const seen = new Set<string>();
  const accepted = expected.decisions.filter((d) => d.action === 'accept'),
    results = new Map(records.map((record) => [record.recordId, record]));
  if (results.size !== records.length) throw Error('Repeated projected acceptance record');
  for (let index = 0; index < records.length; index++) {
    const record = block.records[index]!,
      { candidateId, candidateVersionId, ...actual } = record,
      projected = results.get(accepted[index]!.recordId),
      selected = expected.review.records.find((r) => r.id === accepted[index]!.recordId),
      key = JSON.stringify([candidateId, candidateVersionId]);
    if (
      !selected ||
      selected.candidateId !== candidateId ||
      selected.candidateVersionId !== candidateVersionId ||
      seen.has(key) ||
      !projected ||
      canonicalLiteral(actual) !== canonicalLiteral(projected) ||
      !expected.decisions.some((d) => d.recordId === selected.id && d.action === 'accept')
    )
      throw Error('Atomic acceptance record differs from selected projected evidence');
    seen.add(key);
  }
}

declare const basisBrand: unique symbol, transitionBrand: unique symbol;
export interface NativeBatchRevalidationBasis {
  readonly [basisBrand]: true;
}
export interface NativeAcceptanceOnlyTransition {
  readonly [transitionBrand]: true;
}
interface BasisState {
  db: Database;
  source: IntakeEnvelopeSource;
  binding: string;
  logical: string;
  version: number;
  sourceTextRevision: string | null;
  revision: number;
  sequence: number | undefined;
  acceptedSequence?: number;
  persistedRevision: number | null;
  invalid: boolean;
  ordinary: number;
  stop(): void;
}
interface CertifiedTransition {
  source: IntakeEnvelopeSource;
  before: string;
  after: string;
  operationId: string;
  fingerprint: string;
  receipt: IntakeAtomicAcceptanceReceipt;
  simple: boolean;
  receiptAppend?: {
    basis: object;
    proof: object;
    reader: IntakeCollectionEnvelopeReader;
  };
}
const bases = new WeakMap<NativeBatchRevalidationBasis, BasisState>(),
  activeBases = new WeakMap<Database, Map<NativeBatchRevalidationBasis, BasisState>>(),
  transitions = new WeakMap<Database, Map<string, CertifiedTransition>>(),
  capabilities = new WeakMap<
    NativeAcceptanceOnlyTransition,
    {
      db: Database;
      basis: NativeBatchRevalidationBasis;
      transition: CertifiedTransition;
      revision: number;
    }
  >();
const durable = (db: Database) =>
  personalDurabilityStatus(db) as ReturnType<typeof personalDurabilityStatus> & {
    sequence?: number;
  };
const clean = (status: ReturnType<typeof durable>) =>
  !status.dirty && !status.conflicted && !status.lastError;
function immutableSourceBinding(db: Database, source: IntakeEnvelopeSource) {
  const selected = selectedEnvelopeStore(db, source),
    current = intakeSourceVersion(db, source.id);
  return JSON.stringify([
    selected.identity,
    createHash('sha256')
      .update(selected.source.details_json || '')
      .digest('hex'),
    current.sourcePin,
  ]);
}
/** Host request context and physical covered-source leases remain checked by the
 * assistant. This opaque basis binds all selected plan/unit/domain authority. */
export function captureNativeBatchRevalidationBasis(
  db: Database,
  source: IntakeEnvelopeSource,
): NativeBatchRevalidationBasis {
  const current = intakeSourceVersion(db, source.id),
    status = durable(db);
  if (!current.logicalBinding || !clean(status))
    throw Error('Native revalidation requires clean selected authority');
  const view = openIntakeCollectionEnvelope(db, source),
    intake = view.child(view.root(), 'intake')!,
    dependency = current.sourcePin
      ? current.sourcePin.dependencyToken
      : field(view, intake, 'sourceTextDependencyToken'),
    sourceRevision = current.sourcePin
      ? current.sourcePin.revisionId
      : field(view, intake, 'sourceTextRevisionId');
  if (
    (dependency != null && typeof dependency !== 'string') ||
    (sourceRevision != null && typeof sourceRevision !== 'string')
  )
    throw Error('Invalid captured source-text authority');
  const basis = Object.freeze({}) as NativeBatchRevalidationBasis,
    state: BasisState = {
      db,
      source: { id: source.id },
      binding: immutableSourceBinding(db, source),
      logical: current.logicalBinding,
      version: current.version,
      sourceTextRevision: (dependency || sourceRevision || null) as string | null,
      revision: revision(db),
      sequence: status.sequence,
      persistedRevision: status.persistedRevision,
      invalid: false,
      ordinary: 0,
      stop: () => {},
    };
  state.stop = observeTransactionOutcome(db, (outcome) => {
    if (!outcome.committed) return;
    if (!outcome.succeeded || state.invalid) {
      state.invalid = true;
      return;
    }
    if (!outcome.intakeMaintenance) {
      state.ordinary++;
      if (state.ordinary > 1) state.invalid = true;
      else state.acceptedSequence = durable(db).sequence;
      return;
    }
    const accepted = state.ordinary === 1 ? transitions.get(db)?.get(state.source.id) : undefined,
      ordinaryOffset = state.ordinary;
    if (
      (ordinaryOffset === 1 &&
        (!accepted || !accepted.simple || accepted.before !== state.logical)) ||
      revision(db) !== state.revision + ordinaryOffset + 1 ||
      immutableSourceBinding(db, source) !== state.binding ||
      intakeSourceVersion(db, source.id).logicalBinding !== (accepted?.after ?? state.logical)
    ) {
      state.invalid = true;
      return;
    }
    const next = durable(db);
    if (
      !clean(next) ||
      (state.sequence !== undefined && next.sequence !== state.sequence + ordinaryOffset + 1)
    ) {
      state.invalid = true;
      return;
    }
    state.revision = revision(db) - ordinaryOffset;
    state.sequence = next.sequence === undefined ? undefined : next.sequence - ordinaryOffset;
    state.persistedRevision =
      next.persistedRevision === null ? null : next.persistedRevision - ordinaryOffset;
  });
  bases.set(basis, state);
  let active = activeBases.get(db);
  if (!active) activeBases.set(db, (active = new Map()));
  active.set(basis, state);
  while (active.size > 64) disposeNativeBatchRevalidationBasis(active.keys().next().value!);
  return basis;
}
export function disposeNativeBatchRevalidationBasis(basis: NativeBatchRevalidationBasis) {
  const state = bases.get(basis);
  if (!state) return;
  state.invalid = true;
  state.stop();
  bases.delete(basis);
  activeBases.get(state.db)?.delete(basis);
}
function captureAcceptanceFootprint(db: Database) {
  const token = currentTransactionToken(db);
  if (!token) throw Error('Acceptance footprint requires an ordinary transaction');
  const sessions: ReturnType<Database['createSession']>[] = [];
  let stop = () => {},
    eligible = false,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    for (const session of sessions) session.close();
  };
  try {
    for (const table of db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '__*' AND name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .iterate())
      sessions.push(db.createSession({ table: String(table.name) }));
  } catch (error) {
    close();
    throw error;
  }
  const snapshot = () => {
    const hash = createHash('sha256');
    for (const session of sessions) {
      const bytes = session.changeset();
      hash.update(String(bytes.byteLength) + ':');
      hash.update(bytes);
    }
    // Net changesets alone cannot detect an unrelated row changed and restored.
    // The accepted-record capture retains every touched entity identity.
    for (const row of db
      .prepare('SELECT entity,record_id FROM __record_changed ORDER BY entity,record_id')
      .iterate())
      hash.update(JSON.stringify([row.entity, row.record_id]) + '\n');
    return hash.digest('hex');
  };
  return {
    close,
    eligible: () => eligible,
    seal() {
      const expected = snapshot();
      stop = observeTransactionBeforePublication(db, (observed) => {
        if (observed !== token) return;
        eligible = false;
        if (!closed && snapshot() === expected) eligible = true;
      });
    },
  };
}
function observeOwnedAcceptanceTransition(
  db: Database,
  input: CertifiedTransition,
  footprint: ReturnType<typeof captureAcceptanceFootprint>,
) {
  const token = currentTransactionToken(db);
  if (!token) throw Error('Acceptance transition requires an ordinary transaction');
  const saved: CertifiedTransition = {
    ...input,
    source: { id: input.source.id, sha256: input.source.sha256 },
    receipt: structuredClone(input.receipt),
  };
  const stop = observeTransactionOutcome(db, (outcome) => {
    if (outcome.token !== token) return;
    stop();
    const exact = footprint.eligible();
    footprint.close();
    if (
      !exact ||
      !outcome.committed ||
      !outcome.succeeded ||
      outcome.intakeMaintenance ||
      intakeSourceVersion(db, saved.source.id).logicalBinding !== saved.after
    )
      return;
    const row = db
      .prepare('SELECT fingerprint,result_json FROM __record_transactions WHERE operation_id=?')
      .get(saved.operationId);
    if (
      !row ||
      row.fingerprint !== saved.fingerprint ||
      canonicalLiteral(JSON.parse(String(row.result_json))) !== canonicalLiteral(saved.receipt)
    )
      return;
    if (saved.receiptAppend)
      retainNativeIntakeReceiptAppend(
        db,
        saved.receiptAppend.basis,
        saved.receiptAppend.proof,
        saved.receiptAppend.reader,
        saved.source,
        saved.before,
        saved.after,
      );
    let registry = transitions.get(db);
    if (!registry) transitions.set(db, (registry = new Map()));
    registry.delete(saved.source.id);
    const { receiptAppend: _consumedAppend, ...retainedTransition } = saved;
    registry.set(saved.source.id, retainedTransition);
    while (registry.size > 64) registry.delete(registry.keys().next().value!);
  });
}
function transitionCurrent(
  db: Database,
  basis: NativeBatchRevalidationBasis,
  transition: CertifiedTransition,
): boolean {
  const state = bases.get(basis);
  if (
    !state ||
    state.db !== db ||
    state.invalid ||
    state.ordinary !== 1 ||
    !transition.simple ||
    transition.before !== state.logical ||
    transition.source.id !== state.source.id ||
    immutableSourceBinding(db, state.source) !== state.binding
  )
    return false;
  const current = intakeSourceVersion(db, state.source.id),
    status = durable(db),
    row = db
      .prepare(
        'SELECT sequence,fingerprint,result_json FROM __record_transactions WHERE operation_id=?',
      )
      .get(transition.operationId);
  return (
    current.logicalBinding === transition.after &&
    current.version === state.version + 1 &&
    revision(db) === state.revision + 1 &&
    clean(status) &&
    status.revision === state.revision + 1 &&
    status.persistedRevision === (state.persistedRevision ?? state.revision) + 1 &&
    (state.sequence === undefined || status.sequence === state.sequence + 1) &&
    !!row &&
    (state.acceptedSequence === undefined || row.sequence === state.acceptedSequence) &&
    row.fingerprint === transition.fingerprint &&
    canonicalLiteral(JSON.parse(String(row.result_json))) === canonicalLiteral(transition.receipt)
  );
}
export function proveNativeAcceptanceOnlyTransition(
  db: Database,
  basis: NativeBatchRevalidationBasis,
  input: { entries: readonly IntakeEntry[] },
): NativeAcceptanceOnlyTransition | undefined {
  const state = bases.get(basis),
    transition = state && transitions.get(db)?.get(state.source.id);
  if (!state || !transition || !transitionCurrent(db, basis, transition)) return undefined;
  const records = transition.receipt.receipts[0]!.records,
    candidates = new Set(records.map((r) => r.candidateId)),
    versions = new Set(records.map((r) => r.candidateVersionId));
  for (const entry of input.entries)
    if (
      candidates.has(
        intakeCandidateId(
          {
            id: state.source.id,
            sha256: selectedEnvelopeStore(db, state.source).identity.sourceHash,
          },
          entry,
        ),
      ) ||
      versions.has(intakeCandidateVersionIdForRevision(entry, state.sourceTextRevision))
    )
      return undefined;
  const capability = Object.freeze({}) as NativeAcceptanceOnlyTransition;
  capabilities.set(capability, { db, basis, transition, revision: revision(db) });
  return capability;
}
export function assertNativeAcceptanceOnlyTransition(
  capability: NativeAcceptanceOnlyTransition,
): void {
  const value = capabilities.get(capability);
  if (
    !value ||
    revision(value.db) !== value.revision ||
    !transitionCurrent(value.db, value.basis, value.transition)
  )
    throw new HttpError(
      409,
      'VERSION_CONFLICT',
      'The accepted intake changed again; review the current batch.',
    );
}
