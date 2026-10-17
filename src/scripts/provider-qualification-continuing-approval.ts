/** Public-API qualification controller, not a scripted provider or a source publisher.
 * The caller owns one real Import, route, cancellation and protected external artifacts.
 * Unit-test adapters exercise the oracle only; they are never live-provider evidence. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AssistantChat } from '../server/assistant.ts';
import type { Observation, Overview } from '../shared/api.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptancePlan,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../shared/intake.ts';
import type { IntakeSourceText, SourceTextReviewRequest } from '../shared/intake-source-text.ts';
import { canonicalIdentityName } from '../shared/self-identity.ts';
import { acceptedQualificationRecord } from './provider-qualification-acceptance.ts';
import {
  answersForQualification,
  gradeProviderQualification,
  qualificationBirthDate,
  qualificationPerson,
  type QualificationRecord,
} from './provider-qualification-fixture.ts';
import {
  readQualificationIdentity,
  type QualificationFeedBlock,
} from './qualification-intake-read.ts';

export interface ContinuingApprovalResult {
  status: 'passed' | 'inconclusive' | 'failed';
  passed: boolean;
  reason: string;
  scope: 'source_publications_during_continuing_model_reading';
  automaticCaptureAfterApproval: false;
  intermediateReviewObserved: boolean;
  sourcePublications: number;
  acceptanceOperations: number;
  savedRecords: number;
  rejectedRecords: number;
  evidence: string[];
}
export interface ContinuingApprovalOptions {
  prefix: string;
  profileId: string;
  originalId: string;
  expectedSha256: string;
  ownedProfiles: ReadonlySet<string>;
  signal: AbortSignal;
  request: <T>(path: string, input?: unknown) => Promise<T>;
  collectFeed: (prefix: string) => Promise<{ blocks: QualificationFeedBlock[] }>;
  originalHash: (prefix: string, originalId: string) => Promise<string>;
  /** Must write owner-only artifacts outside Git; values include fictional clinical content. */
  retain: (name: string, value: unknown) => void | Promise<void>;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error('Continuing approval qualification: ' + message);
}
const markerA = answersForQualification('continuing')[0]!.marker;
const markerB = answersForQualification('continuing')[1]!.marker;
const samePatient = (value: string | null | undefined) =>
  typeof value === 'string' &&
  canonicalIdentityName(value) === canonicalIdentityName(qualificationPerson);
const pending = (reading: IntakeBatch['items'][number]['reading']) =>
  !!reading &&
  reading.status === 'running' &&
  reading.coverage === 'reading_progress_only' &&
  (reading.remainingUnits > 0 || reading.pendingReadWindows > 0) &&
  Number.isSafeInteger(reading.modelRequests) &&
  reading.modelRequests! > 0;

/** Await this from the ordinary batch observer. Never starts conversion, resumes,
 * supplies proposals, relabels completed reading, or retries an attempted scenario. */
export function createContinuingApprovalQualifier(options: ContinuingApprovalOptions) {
  const { prefix, profileId, originalId, expectedSha256, request } = options;
  check(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(profileId) &&
      /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,255}$/.test(originalId) &&
      prefix === `/api/profiles/${profileId}` &&
      options.ownedProfiles.has(profileId) &&
      /^[a-f0-9]{64}$/.test(expectedSha256),
    'require one fresh owned fictional profile and exact original hash',
  );
  const state: ContinuingApprovalResult = {
    status: 'inconclusive',
    passed: false,
    reason: 'No real intermediate review with unfinished model reading was observed.',
    scope: 'source_publications_during_continuing_model_reading',
    automaticCaptureAfterApproval: false,
    intermediateReviewObserved: false,
    sourcePublications: 0,
    acceptanceOperations: 0,
    savedRecords: 0,
    rejectedRecords: 0,
    evidence: [],
  };
  let owner: { id: string; operationId: string; chatId: string | null } | undefined;
  let attempted = false;
  let observing = false;
  async function retain(name: string, value: unknown) {
    options.signal.throwIfAborted();
    await options.retain('continuing-' + name + '.json', structuredClone(value));
    state.evidence.push('continuing-' + name + '.json');
  }
  function scope(batch: IntakeBatch) {
    check(
      batch.profileId === profileId &&
        (batch.automaticRun === true || (!!owner && batch.status !== 'running')) &&
        batch.items.length === 1 &&
        batch.items[0]?.intakeId === originalId &&
        batch.items[0].sourceHash === expectedSha256,
      'batch must retain exactly the owned original',
    );
    owner ??= { id: batch.id, operationId: batch.operationId, chatId: null };
    check(
      batch.id === owner.id && batch.operationId === owner.operationId,
      'batch or operation identity changed',
    );
    if (batch.items[0].chatId) {
      owner.chatId ??= batch.items[0].chatId;
      check(batch.items[0].chatId === owner.chatId, 'conversion chat identity changed');
    }
  }
  async function active(name: string) {
    options.signal.throwIfAborted();
    const batch = await request<IntakeBatch>(
      prefix + `/intake-batches/${encodeURIComponent(owner!.id)}`,
    );
    scope(batch);
    const item = batch.items[0]!;
    if (batch.status !== 'running' || !pending(item.reading) || !item.chatId) return false;
    const chat = await request<AssistantChat>(
      prefix + `/assistant/chats/${encodeURIComponent(item.chatId)}`,
    );
    check(
      chat.id === item.chatId && chat.context?.intakeId === originalId,
      'live chat is not bound to the owned original',
    );
    // The coordinator can lag its chat. Require its current, unfinished running
    // state too, rather than treating cached pending counts as ongoing reading.
    const evidence = {
      batch,
      chat: {
        id: chat.id,
        status: chat.status,
        updatedAt: chat.updatedAt,
        context: chat.context,
        backend: chat.backend,
        model: chat.model,
        reading: chat.reading,
        intakeModelAttempts: chat.intakeModelAttempts,
      },
    };
    await retain(name, evidence);
    return chat.status === 'running' && chat.backend === 'litellm' && pending(chat.reading ?? null);
  }
  function inconclusive() {
    state.reason = 'Model reading ended before the publication and approval checks completed.';
  }
  function exact(records: readonly QualificationRecord[], required: readonly string[]) {
    check(records.length <= 4, 'fixture review exceeded four observations');
    const grade = gradeProviderQualification(records, originalId, 'continuing', 'accepted');
    check(
      !grade.duplicate.length &&
        !grade.duplicateIds.length &&
        !grade.unexpected.length &&
        !grade.mismatches.length &&
        required.every((marker) => !grade.missing.includes(marker)),
      'actual review differs from the independent literal and original-page oracle',
    );
  }
  async function feed() {
    const current = await options.collectFeed(prefix);
    check(
      current.blocks.length <= 4 &&
        current.blocks.every((block) => block.intakeId === originalId) &&
        current.blocks.reduce((n, block) => n + block.records.length, 0) <= 4,
      'review contains foreign or excessive records',
    );
    return structuredClone(current.blocks);
  }
  function selected(blocks: QualificationFeedBlock[], marker: string) {
    const matches = blocks.flatMap((block) =>
      block.records
        .filter((record) => record.mapping.testLabel === marker)
        .map((record) => ({ block, record })),
    );
    check(matches.length === 1, 'selected fictional row is absent or duplicated');
    return matches[0]!;
  }
  function approval({ block, record }: ReturnType<typeof selected>): IntakeReportAcceptanceBlock {
    check(
      record.kind === 'observation' &&
        record.selectable &&
        record.queueState !== 'accepted' &&
        record.candidateId &&
        record.candidateVersionId &&
        record.selectionReviewToken &&
        !record.issuesReference &&
        !record.questionsReference &&
        !(record.issues ?? []).some((issue) => issue.blocking && issue.status === 'unresolved') &&
        record.mapping.subject === 'self' &&
        record.identityReview &&
        !record.identityReview.blocking &&
        !record.identityReview.conflicts.length &&
        ['evidenced_match', 'prior_confirmation'].includes(record.identityReview.status) &&
        samePatient(record.identityReview.evidencedIdentity.fullName) &&
        record.identityReview.evidencedIdentity.birthDate === qualificationBirthDate &&
        (!record.identityReview.assignedPerson ||
          record.identityReview.assignedPerson.personId === 'patient'),
      'approval requires exact selectable host-evidenced Self without unresolved clinical issues',
    );
    return {
      intakeId: block.intakeId,
      proposalId: block.proposalId,
      intakeVersion: block.intakeVersion,
      reviewToken: block.reviewToken,
      selections: [
        {
          recordId: record.id,
          candidateId: record.candidateId,
          candidateVersionId: record.candidateVersionId,
          selectionReviewToken: record.selectionReviewToken,
          mapping: structuredClone(record.mapping),
        },
      ],
    };
  }
  async function confirmIdentity(blocks: QualificationFeedBlock[]) {
    const confirmed = new Set<string>();
    for (const marker of [markerA, markerB]) {
      const { record } = selected(blocks, marker);
      check(
        !record.issuesReference && !record.questionsReference,
        'identity evidence is incomplete',
      );
      const unresolved = (record.issues ?? []).filter(
        (issue) => issue.blocking && issue.status === 'unresolved',
      );
      check(
        unresolved.every((issue) => issue.kind === 'identity'),
        'clinical questions require manual review',
      );
      if (!unresolved.length) continue;
      check(
        Array.isArray(record.reportGroups) && record.reportGroups.length === 1,
        'identity scope is ambiguous',
      );
      const groupId = record.reportGroups[0]!.groupId;
      if (confirmed.has(groupId)) continue;
      const identity = await readQualificationIdentity(
        request,
        prefix + `/intakes/${originalId}/identity-review?groupId=${encodeURIComponent(groupId)}`,
      );
      const { review, inspectedScope, confirmationScope } = identity;
      const assignmentTargets = inspectedScope.assignmentTargets;
      check(Array.isArray(assignmentTargets), 'inspect the complete identity assignment targets');
      // A host-evidenced match can have no unanswered questions (targets),
      // while applying Self to an unknown mapping uses assignmentTargets.
      // Inspect and bind both collections rather than inventing a question.
      const targets = [...inspectedScope.targets, ...assignmentTargets];
      await retain('identity-' + confirmed.size, identity);
      check(
        !review.conflicts.length &&
          review.status !== 'conflict' &&
          !review.selfBirthDateConflict &&
          samePatient(review.self.fullName) &&
          review.self.birthDate === qualificationBirthDate &&
          samePatient(review.evidencedIdentity.fullName) &&
          review.evidencedIdentity.birthDate === qualificationBirthDate &&
          inspectedScope.profileId === profileId &&
          inspectedScope.intakeId === originalId &&
          inspectedScope.sourceHash === expectedSha256 &&
          inspectedScope.groupId === groupId &&
          inspectedScope.targets.length <= 4 &&
          assignmentTargets.length <= 4 &&
          targets.every((target) =>
            blocks.some((block) =>
              block.records.some(
                (candidate) =>
                  candidate.candidateId === target.candidateId &&
                  candidate.candidateVersionId === target.candidateVersionId,
              ),
            ),
          ) &&
          targets.some(
            (target) =>
              target.candidateId === record.candidateId &&
              target.candidateVersionId === record.candidateVersionId,
          ),
        'identity review does not prove the exact fictional patient and source',
      );
      const input = {
        version: inspectedScope.intakeVersion,
        operationId: randomUUID(),
        scope: confirmationScope,
        outcome: 'this_is_me',
        attestation: 'confirmed_displayed_identity_questions',
      };
      await retain('identity-request-' + confirmed.size, input);
      await request(prefix + `/intakes/${originalId}/identity-scope`, input);
      confirmed.add(groupId);
      blocks = await feed();
    }
    return blocks;
  }
  async function source() {
    const value = await request<IntakeSourceText>(prefix + `/intakes/${originalId}/source-text`);
    check(
      value.status === 'available' &&
        value.revision.profileId === profileId &&
        value.revision.intakeId === originalId &&
        value.revision.sourceHash === expectedSha256 &&
        value.revision.pages.length === 3 &&
        [1, 2, 3].every((page) => value.revision.pages.some((entry) => entry.page === page)) &&
        Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024,
      'require complete bounded source evidence for the three-page fictional original',
    );
    return value;
  }
  async function publish(name: string, page: number, clarification: string) {
    const before = await source();
    const input: SourceTextReviewRequest = {
      operationId: randomUUID(),
      expectedRevisionId: before.revision.id,
      sourceHash: expectedSha256,
      action: 'clarification',
      scope: { page },
      clarification,
    };
    check(state.sourcePublications < 2, 'source-publication bound exceeded');
    await retain(name + '-request', input);
    state.sourcePublications++;
    const after = await request<IntakeSourceText>(
      prefix + `/intakes/${originalId}/source-text`,
      input,
    );
    await retain(name + '-source', { before, after });
    check(
      after.status === 'available' &&
        after.revision.id !== before.revision.id &&
        after.revision.parentRevisionId === before.revision.id &&
        after.revision.sourceHash === expectedSha256 &&
        after.revision.review?.operationId === input.operationId &&
        after.revision.review.action === 'clarification' &&
        after.revision.review.scope.page === page &&
        after.revision.review.clarification === clarification &&
        isDeepStrictEqual(after.revision.spans, before.revision.spans) &&
        isDeepStrictEqual(after.revision.relations, before.revision.relations),
      'publication must retain the original transcript and separately attribute the requested clarification',
    );
  }
  async function accept(
    name: string,
    block: IntakeReportAcceptanceBlock,
    status: 'saved' | 'needs_review',
  ) {
    const plan = await request<IntakeReportAcceptancePlan>(
      prefix + '/intakes/report-acceptance-plan',
      {
        blocks: [block],
      },
    );
    await retain(name + '-plan', plan);
    check(
      !plan.unsent.length && plan.chunks.length === 1 && isDeepStrictEqual(plan.chunks[0], [block]),
      'planning must preserve the original exact approval without replacing its tokens or mapping',
    );
    const input: IntakeReportAcceptanceRequest = {
      mode: 'partial-v1',
      operationId: randomUUID(),
      plan: { id: plan.planId, chunk: 0 },
      blocks: structuredClone([block]),
    };
    check(state.acceptanceOperations < 2, 'acceptance-operation bound exceeded');
    await retain(name + '-acceptance-request', input);
    state.acceptanceOperations++;
    const result = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      input,
    );
    await retain(name + '-acceptance', result);
    const receipt = result.receipt;
    const selection = block.selections[0]!;
    check(
      !receipt.atomic &&
        receipt.operationId === input.operationId &&
        receipt.selectedCount === 1 &&
        receipt.acceptedCount === (status === 'saved' ? 1 : 0) &&
        receipt.items.length === 1 &&
        receipt.items[0]!.status === status &&
        receipt.items[0]!.intakeId === originalId &&
        receipt.items[0]!.recordId === selection.recordId &&
        receipt.items[0]!.candidateId === selection.candidateId &&
        receipt.items[0]!.candidateVersionId === selection.candidateVersionId &&
        receipt.items[0]!.selectionReviewToken === selection.selectionReviewToken,
      'actual partial receipt does not match the original approval and required outcome',
    );
    const recovered = await request<IntakeReportAcceptanceResult>(
      prefix + `/intakes/report-acceptance/${encodeURIComponent(input.operationId)}`,
    );
    const replay = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      input,
    );
    await retain(name + '-replay', { recovered, replay });
    check(
      replay.replayed &&
        isDeepStrictEqual(recovered.receipt, receipt) &&
        isDeepStrictEqual(replay.receipt, receipt),
      'original operation-ID reconciliation and exact replay must preserve the receipt',
    );
    return receipt;
  }
  async function counts(expected: number) {
    const overview = await request<Overview>(prefix + '/overview');
    check(
      overview.counts.observations === expected &&
        overview.counts.medications === 0 &&
        overview.counts.procedures === 0,
      'acceptance created unexpected clinical writes',
    );
    return overview.counts;
  }
  async function exercise(initial: QualificationFeedBlock[]) {
    if (!(await active('before-identity'))) return inconclusive();
    check(
      (await options.originalHash(prefix, originalId)) === expectedSha256,
      'original changed before approval',
    );
    let blocks = await confirmIdentity(initial);
    exact(
      blocks.flatMap((block) => block.records),
      [markerA, markerB],
    );
    const a = approval(selected(blocks, markerA));
    const b = approval(selected(blocks, markerB));
    await retain('original-approvals', { blocks, a, b });
    await retain('before-counts', await counts(0));
    if (!(await active('before-unrelated-publication'))) return inconclusive();
    state.intermediateReviewObserved = true;
    await publish(
      'unrelated',
      3,
      'Fictional administrative routing clarification for page 3 only. No clinical assertion or patient identity changes.',
    );
    blocks = await feed();
    await retain('after-unrelated-review', blocks);
    exact(
      blocks.flatMap((block) => block.records),
      [markerA, markerB],
    );
    for (const [before, marker] of [
      [a, markerA],
      [b, markerB],
    ] as const) {
      const now = approval(selected(blocks, marker));
      check(
        before.proposalId === now.proposalId &&
          isDeepStrictEqual(before.selections, now.selections),
        'unrelated publication changed an individual clinical approval',
      );
    }
    if (!(await active('after-unrelated-publication'))) return inconclusive();
    const saved = await accept('valid', a, 'saved');
    check(!saved.atomic, 'partial receipt required');
    const item = saved.items[0]!;
    check(
      item.personId === 'patient' &&
        item.receipt?.records.length === 1 &&
        item.receipt.records[0]!.kind === 'observation' &&
        item.receipt.records[0]!.outcome === 'added',
      'saved outcome must name Self and one new observation',
    );
    state.savedRecords = 1;
    const accepted = await request<Observation>(
      prefix + '/tests/' + encodeURIComponent(item.receipt.records[0]!.entityId),
    );
    await retain('accepted-record', accepted);
    check(accepted.personId === 'patient', 'accepted public record has the wrong person');
    exact([acceptedQualificationRecord('observation', accepted)], [markerA]);
    await retain('after-valid-counts', await counts(1));
    blocks = await feed();
    const beforeRelevant = approval(selected(blocks, markerB));
    await retain('before-relevant-review', { blocks, approval: beforeRelevant });
    check(
      beforeRelevant.proposalId === b.proposalId &&
        isDeepStrictEqual(beforeRelevant.selections, b.selections),
      'the remaining original approval changed before the relevant source publication',
    );
    if (!(await active('before-relevant-publication'))) return inconclusive();
    await publish(
      'relevant',
      1,
      'Fictional correction notice concerning the page 1 laboratory assertions: review the updated source context before saving any pending result.',
    );
    blocks = await feed();
    await retain('after-relevant-review', blocks);
    const changed = selected(blocks, markerB).record;
    check(
      changed.selectionReviewToken !== b.selections[0]!.selectionReviewToken,
      'relevant source clarification did not invalidate the old individual approval',
    );
    if (!(await active('after-relevant-publication'))) return inconclusive();
    await accept('stale', b, 'needs_review');
    state.rejectedRecords = 1;
    await retain('final-counts', await counts(1));
    check(
      (await options.originalHash(prefix, originalId)) === expectedSha256,
      'publication or acceptance changed the original',
    );
    state.status = 'passed';
    state.passed = true;
    state.reason =
      'Original approval saved after unrelated publication; original relevant approval required review, with no second clinical write.';
  }
  return {
    result: (): ContinuingApprovalResult => structuredClone(state),
    onSnapshot: async (batch: IntakeBatch) => {
      options.signal.throwIfAborted();
      check(!observing, 'batch checkpoints must be awaited sequentially');
      observing = true;
      try {
        scope(batch);
        if (attempted || batch.status !== 'running' || !pending(batch.items[0]!.reading)) return;
        const blocks = await feed();
        const records = blocks.flatMap((block) => block.records);
        if (
          ![markerA, markerB].every((marker) =>
            records.some((record) => record.mapping.testLabel === marker),
          )
        )
          return;
        // From here even a raced or failed attempt is retained, never retried on
        // another poll or replaced by a second import that happens to pass.
        attempted = true;
        await retain('intermediate-review', { batch, blocks });
        await exercise(blocks);
      } catch (error) {
        attempted = true;
        state.status = 'failed';
        state.passed = false;
        state.reason = error instanceof Error ? error.message : 'Qualification failed.';
        throw error;
      } finally {
        observing = false;
      }
    },
  };
}
