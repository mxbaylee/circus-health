import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { createBackup } from '../recovery.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import {
  uploadIntake,
  submitPagedIntakeBatch,
  getIntakeRead,
  intakeTransaction,
  intakeConversionChatId,
  linkIntakeConversionRead,
  askIntakeQuestionRead,
  answerIntakeQuestionRead,
  updateIntakeMetadataRead,
  createIntakePlan,
  workflowMutation,
  confirmIntakeReportSourceRead,
  getIntakeReportSourceReviewRead,
  readIntakeReportSourceFragment,
  importIntakeRead,
  reviewIntakeRead,
  proposeConversionRead,
  saveIntakeReviewDraftRead,
} from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import {
  createPagedPackagePlan,
  readPackagePlanScope,
  savePagedPackageRoles,
} from '../intake-package-plan.ts';
import { packageMemberRoleHash } from '../intake-proposal-dependencies.ts';
import { nextPendingPagedPackageUnit } from '../intake-package-batch.ts';
import { intakeSourceVersion, intakeSourceMetadata } from '../intake-state-access.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession } from '../intake-package-session.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { isIntakeSummary } from '../../shared/intake-summary.ts';
import {
  prepareRetainedPlanAccess,
  readRetainedIntakeUnitScope,
  readRetainedPlanScope,
} from '../intake-retained-plan.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { handleIntakeRoute } from '../intake-routes.ts';
import type { IntakeClinicalReviewPage } from '../intake-review-collection-session.ts';
import type { IntakeReviewRecord } from '../../shared/intake.ts';

async function fixture(t: test.TestContext, direct = false, duplicatePlan = false) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-publication-')),
    profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearPackageSourceSession(db);
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: direct ? 'fictional.json' : 'fictional.zip',
    newProviderName: 'Fictional collection',
    bytes: direct
      ? Buffer.from(JSON.stringify({ fictional: 'Example evidence' }))
      : zipFixture([
          { name: 'one.txt', data: 'Fictional report one' },
          { name: 'two.txt', data: 'Fictional report two' },
        ]),
  });
  const planned = await (direct ? createIntakePlan : createPagedPackagePlan)(
    db,
    root,
    profileId,
    intake.id,
    {
      version: intake.version,
      operationId: 'fictional-plan',
    },
  );
  if (duplicatePlan)
    workflowMutation(
      db,
      root,
      profileId,
      intake.id,
      { version: planned.version, operationId: 'fictional-duplicate-retained-plan' },
      (flow) => {
        const old = flow.plans[0]!,
          active = structuredClone(old);
        old.status = 'superseded';
        flow.plans.push(active);
      },
    );
  if (direct)
    await buildIntakeCollectionEnvelope(
      db,
      db
        .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
        .get(intake.id) as never,
    );
  return { db, root, profileId, id: intake.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test('actual direct JSON batch preserves retained unit attempts and exact retry without package substitution', async (t) => {
  const f = await fixture(t, true, true);
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  const plan = readRetainedPlanScope(f.db, f.profileId, f.id, { activeOnly: true })!;
  assert.ok(plan);
  const first = plan.reader.childAt(plan.record, 'units', 0)!,
    unitIdField = plan.reader.field(first, 'id');
  assert.ok(unitIdField.kind === 'value' && typeof unitIdField.value === 'string');
  if (unitIdField.kind !== 'value' || typeof unitIdField.value !== 'string')
    throw Error('Missing unit');
  const unitId = unitIdField.value,
    request = {
      version: plan.version,
      planId: plan.planId,
      operationId: 'fictional-direct-batch',
      summary: 'Fictional direct record',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-direct',
        kind: 'record',
        payload: { literal: '12.00' },
        provenance: {
          capturedVia: 'Fictional delivery',
          sourceSystem: 'Fictional issuer',
          sourceRecordId: 'fictional-direct',
          evidenceClass: 'provider_export',
          locator: 'JSON root',
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'observation',
          subject: 'self',
          testLabel: 'Example',
          valueText: '12.00',
          unit: 'mg',
          date: '2026-09',
        },
      }),
      coverage: [{ unitId, kind: 'extracted' as const, notes: 'Fictional direct evidence' }],
    },
    before = { ...intakeWorkCounters(f.db).warm };
  const updated = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(updated.version, request.version + 1);
  const selected = readRetainedPlanScope(f.db, f.profileId, f.id, {
    planId: plan.planId,
    activeOnly: true,
  })!;
  assert.equal(selected.planId, request.planId);
  assert.equal(selected.unitCount, plan.unitCount);
  assert.equal(selected.unitById(unitId)!.status, 'completed');
  assert.equal(selected.accountedKind(unitId), 'extracted');
  assert.equal(selected.unitById(unitId)!.attemptCount, 1);
  const attempts = selected.attempts(unitId, { items: 10, bytes: 4096 });
  assert.equal(attempts.total, 1);
  clearIntakeStateCache(f.db);
  const replay = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.version, updated.version);
  assert.equal(
    readRetainedPlanScope(f.db, f.profileId, f.id, {
      planId: plan.planId,
      activeOnly: true,
    })!.attempts(unitId, { items: 10, bytes: 4096 }).total,
    1,
  );
  assert.equal(
    readRetainedPlanScope(f.db, f.profileId, f.id, { planId: plan.planId })!.unitById(unitId)!
      .attemptCount,
    0,
  );
  const repeated = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, {
    ...request,
    version: updated.version,
    operationId: 'fictional-direct-inspection',
    coverage: [{ unitId, kind: 'inspected', notes: 'Fictional follow-up inspection' }],
  });
  const reopened = readRetainedPlanScope(f.db, f.profileId, f.id, {
    planId: plan.planId,
    activeOnly: true,
  })!;
  assert.equal(reopened.unitById(unitId)!.attemptCount, 2);
  assert.equal(reopened.unitById(unitId)!.status, 'partial');
  assert.equal(reopened.accountedKind(unitId), null);
  assert.equal(reopened.attempts(unitId, { items: 10, bytes: 4096 }).total, 2);
  assert.equal(
    (await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request)).version,
    repeated.version,
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('native metadata edits publish the compact header and append history exactly once', async (t) => {
  const f = await fixture(t),
    before = { ...intakeWorkCounters(f.db).warm },
    original = intakeSourceMetadata(f.db, f.id),
    request = {
      version: intakeSourceVersion(f.db, f.id).version,
      operationId: 'fictional-metadata',
      metadata: { careArea: ' Example care ', topics: ['Example', 'Example', ' '] },
    };
  const updated = await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, request);
  assert.ok(isIntakeSummary(updated));
  if (!isIntakeSummary(updated)) throw Error('Expected native metadata summary');
  assert.equal(updated.version, request.version + 1);
  assert.equal(updated.review.state, 'exact');
  assert.equal(updated.review.counts?.pendingWorkCount, 2);
  const metadata = intakeSourceMetadata(f.db, f.id);
  assert.equal(metadata.metadata?.careArea, 'Example care');
  assert.deepEqual(metadata.metadata?.topics, ['Example']);
  assert.deepEqual(metadata.acquisition, original.acquisition);
  const saved = selected(f),
    intake = saved.view.child(saved.view.root(), 'intake')!,
    history = saved.view.childAt(intake, 'metadataHistory', 0)!;
  assert.equal(saved.view.childCount(intake, 'metadataHistory'), 1);
  assert.deepEqual(
    JSON.parse([...saved.view.recordChunks(saved.view.child(history, 'before')!)].join('')),
    original.metadata,
  );
  clearIntakeStateCache(f.db);
  const replay = await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.version, updated.version);
  await assert.rejects(
    updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, {
      ...request,
      metadata: { source: 'Different' },
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  const changed = await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, {
    version: updated.version,
    operationId: 'fictional-source',
    metadata: { source: 'Fictional new clinic' },
  });
  assert.equal(changed.version, updated.version + 1);
  const current = selected(f),
    currentIntake = current.view.child(current.view.root(), 'intake')!;
  assert.equal(current.view.childCount(currentIntake, 'metadataHistory'), 2);
  assert.equal(intakeSourceMetadata(f.db, f.id).metadata?.source, 'Fictional new clinic');
  assert.equal(
    f.db
      .prepare('SELECT count(*) AS count FROM providers WHERE name=?')
      .get('Fictional new clinic')!.count,
    1,
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('actual native source confirmation registers its provider and retained receipt atomically', async (t) => {
  const f = await fixture(t),
    request = input(f, 'fictional-source-proposal'),
    value = JSON.parse(request.jsonlText);
  value.payload.literal = 'Report F27 12.00';
  request.jsonlText = JSON.stringify(value);
  const proposed = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request),
    selectedState = selected(f),
    group = selectedState.view.childAt(selectedState.workflow, 'reportGroups', 0)!,
    groupVersion = selectedState.view.childAt(
      group,
      'versions',
      selectedState.view.childCount(group, 'versions') - 1,
    )!;
  const text = (record: typeof group, name: string) => {
    const field = selectedState.view.field(record, name);
    if (field.kind !== 'value' || typeof field.value !== 'string')
      throw Error('Missing bounded identity');
    return field.value;
  };
  const confirmationRequest = {
      version: proposed.version,
      operationId: 'fictional-source-confirmation',
      groupId: text(group, 'id'),
      groupVersionId: text(groupVersion, 'id'),
      contextId: text(groupVersion, 'id'),
      basis: 'manual_report_label' as const,
      source: 'Fictional verified clinic',
    },
    before = { ...intakeWorkCounters(f.db).warm };
  const sourceReview = await getIntakeReportSourceReviewRead(
    f.db,
    f.root,
    f.profileId,
    f.id,
    confirmationRequest.groupId,
    'all',
    { limit: 1 },
  );
  assert.ok(
    'format' in sourceReview && sourceReview.format === 'health-intake-report-source-review-v2',
  );
  if (!('format' in sourceReview)) throw Error('Expected paged source review');
  assert.equal(sourceReview.targets.total, 1);
  assert.equal(sourceReview.targets.items.length, 1);
  const sourceFragment = await readIntakeReportSourceFragment(f.db, f.profileId, f.id, {
    ...sourceReview.targets.items[0]!.evidence,
    offset: 0,
    limit: 4096,
  });
  assert.ok(sourceFragment);
  const result = await confirmIntakeReportSourceRead(
    f.db,
    f.root,
    f.profileId,
    f.id,
    confirmationRequest,
  );
  assert.ok('format' in result && result.format === 'health-intake-report-source-result-v2');
  if (!('format' in result)) throw Error('Expected native source receipt');
  assert.equal(result.intake.version, proposed.version + 1);
  assert.equal(result.confirmation.memberCount, 1);
  assert.equal(result.confirmation.source, confirmationRequest.source);
  assert.equal(
    f.db.prepare('SELECT name FROM providers WHERE id=?').get(result.confirmation.sourceProviderId)
      ?.name,
    confirmationRequest.source,
  );
  clearIntakeStateCache(f.db);
  const replay = await confirmIntakeReportSourceRead(
    f.db,
    f.root,
    f.profileId,
    f.id,
    confirmationRequest,
  );
  assert.deepEqual(replay.confirmation, result.confirmation);
  assert.equal(replay.intake.version, result.intake.version);
  await assert.rejects(
    confirmIntakeReportSourceRead(f.db, f.root, f.profileId, f.id, {
      ...confirmationRequest,
      source: 'Fictional competing clinic',
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('native review HTTP exposes bounded pages and exact fragments with stale-token refusal', async (t) => {
  const f = await fixture(t),
    request = input(f, 'fictional-review-page');
  await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  const state = selected(f),
    intake = state.view.child(state.view.root(), 'intake')!,
    proposal = state.view.childAt(intake, 'proposals', 0)!,
    field = state.view.field(proposal, 'id');
  if (field.kind !== 'value' || typeof field.value !== 'string') throw Error('Missing proposal');
  const proposalId = field.value,
    before = { ...intakeWorkCounters(f.db).warm };
  let response: unknown,
    body: Record<string, unknown> = {};
  const context = {
    resource: 'intakes',
    id: f.id,
    action: 'review',
    method: 'GET',
    params: new URLSearchParams({ proposalId, limit: '1', bytes: '1024' }),
    req: Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' } }),
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    respond(value: unknown) {
      response = value;
    },
    list() {},
    async body() {
      return Buffer.from(JSON.stringify(body));
    },
    assistant: {},
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  assert.equal(await handleIntakeRoute(context), true);
  const page = response as IntakeClinicalReviewPage;
  assert.equal(page.format, 'health-intake-clinical-review-page-v2');
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  const item = page.items[0]!;
  assert.equal(item.kind, 'reference');
  if (item.kind !== 'reference') throw Error('Fixture needs a fragment');
  body = { proposalId, reference: item.reference, bytes: 4096 };
  await handleIntakeRoute({ ...context, method: 'POST', action: 'review-fragment' });
  const fragment = response as {
    encoding: string;
    data: string;
    complete: boolean;
    nextOffset: number | null;
  };
  assert.equal(fragment.encoding, 'base64');
  assert.ok(Buffer.from(fragment.data, 'base64').length <= 4096);
  await updateIntakeMetadataRead(f.db, f.root, f.profileId, f.id, {
    version: page.version,
    operationId: 'fictional-review-stale',
    metadata: { careArea: 'Fictional follow-up' },
  });
  await assert.rejects(
    handleIntakeRoute({ ...context, method: 'POST', action: 'review-fragment' }),
    { code: 'REVIEW_FRAGMENT' },
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('native standalone proposal uses the public route and retains exact replay without workflow hydration', async (t) => {
  const f = await fixture(t),
    request = input(f, 'standalone-proposal');
  const body = { version: request.version, jsonlText: request.jsonlText, summary: request.summary };
  const before = { ...intakeWorkCounters(f.db).warm };
  let response: unknown;
  const route = {
    resource: 'intakes',
    id: f.id,
    action: 'proposals',
    method: 'POST',
    params: new URLSearchParams(),
    req: Object.assign(new EventEmitter(), { headers: { 'content-type': 'application/json' } }),
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    respond(value: unknown) {
      response = value;
    },
    list() {},
    async body() {
      return Buffer.from(JSON.stringify(body));
    },
    assistant: {},
  } as unknown as Parameters<typeof handleIntakeRoute>[0];
  await handleIntakeRoute(route);
  const result = response as Awaited<ReturnType<typeof proposeConversionRead>>;
  assert.ok(isIntakeSummary(result));
  assert.equal(result.version, request.version + 1);
  if (!isIntakeSummary(result)) throw Error('Expected native summary');
  assert.equal(result.collections.proposals.total, 1);
  const state = selected(f),
    intake = state.view.child(state.view.root(), 'intake')!,
    flow = state.view.child(intake, 'workflow')!;
  const plan = state.view.childAt(flow, 'plans', 0)!;
  assert.equal(state.view.childCount(plan, 'batches'), 0);
  clearIntakeStateCache(f.db);
  const replay = await proposeConversionRead(f.db, f.root, f.profileId, f.id, body);
  assert.equal(replay.version, result.version);
  await handleIntakeRoute({ ...route, action: undefined, method: 'GET' });
  assert.ok(isIntakeSummary(response as Awaited<ReturnType<typeof proposeConversionRead>>));
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
});
for (const terminal of ['keep_original_only', 'accept'] as const)
  test(
    `native draft autosaves retain shared correction history, exact replay and ${terminal} disposition`,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture(t),
        request = input(f, 'native-draft-proposal');
      const value = JSON.parse(request.jsonlText);
      value.kind = 'document';
      value.clinical = {
        kind: 'document',
        subject: 'self',
        documentTitle: 'Fictional draft',
        date: '2026-01-01',
      };
      delete value.report;
      request.jsonlText = JSON.stringify(value);
      await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
      const view = selected(f).view,
        original = view.child(view.root(), 'intake')!,
        proposal = view.childAt(original, 'proposals', 0)!;
      const field = view.field(proposal, 'id');
      if (field.kind !== 'value' || typeof field.value !== 'string')
        throw Error('Missing proposal');
      const proposalId = field.value;
      const record = async () => {
        const page = await reviewIntakeRead(f.db, f.root, f.profileId, f.id, proposalId);
        if (
          !('format' in page) ||
          page.format !== 'health-intake-clinical-review-page-v2' ||
          page.items[0]?.kind !== 'value'
        )
          throw Error('Expected native reviewed record');
        return { page, record: page.items[0].value as IntakeReviewRecord };
      };
      let current = await record();
      const before = { ...intakeWorkCounters(f.db).warm };
      for (let index = 0; index < 2; index++) {
        const mapping = { documentTitle: 'Fictional correction ' + index };
        const command = {
          version: current.page.version,
          operationId: 'draft-save-' + index,
          proposalId,
          recordId: current.record.id,
          candidateVersionId: current.record.candidateVersionId!,
          mapping,
          correctionPatch: mapping,
          correctionReason: 'Fictional transcription correction',
          disposition: 'review_later' as const,
        };
        const saved = await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, f.id, command);
        assert.equal(saved.version, command.version + 1);
        const replay = await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, f.id, command);
        assert.equal(replay.version, saved.version);
        current = await record();
        assert.equal(current.record.draft?.format, 'health-intake-review-draft-v2');
        assert.equal(current.record.draft?.history?.corrections, index + 1);
        assert.equal(current.record.draft?.corrections?.length, 1);
        assert.equal(current.record.draft?.mapping.documentTitle, mapping.documentTitle);
      }
      const { readReviewDraftHistoryPage } = await import('../intake-review-draft-state.ts');
      const history = current.record.draft!.history!;
      clearIntakeStateCache(f.db);
      const page = readReviewDraftHistoryPage(f.db, { id: f.id }, history, {
        section: 'corrections',
        limit: 1,
      });
      assert.equal(page.total, 2);
      assert.equal(page.complete, false);
      assert.equal(page.items.length, 1);
      assert.equal(
        readReviewDraftHistoryPage(f.db, { id: f.id }, history, {
          section: 'corrections',
          offset: 1,
        }).complete,
        true,
      );
      current = await record();
      if (terminal === 'keep_original_only') {
        const kept = await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, f.id, {
          version: current.page.version,
          operationId: 'keep-original',
          proposalId,
          recordId: current.record.id,
          candidateVersionId: current.record.candidateVersionId!,
          disposition: 'keep_original_only',
        });
        assert.ok(isIntakeSummary(kept));
        current = await record();
        assert.equal(current.record.reviewState, 'kept_original');
        assert.equal(current.record.draft?.history?.corrections, 2);
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 0);
        await assert.rejects(
          saveIntakeReviewDraftRead(f.db, f.root, f.profileId, f.id, {
            version: current.page.version,
            operationId: 'replace-kept',
            proposalId,
            recordId: current.record.id,
            candidateVersionId: current.record.candidateVersionId!,
            disposition: 'pending',
          }),
          { code: 'REVIEW_DISPOSITION' },
        );
      } else {
        const { checkedAcceptedReviewDraftHistory } =
          await import('../intake-review-draft-state.ts');
        const expected = {
          proposalId,
          recordId: current.record.id,
          candidateId: current.record.candidateId!,
          candidateVersionId: current.record.candidateVersionId!,
        };
        assert.deepEqual(
          checkedAcceptedReviewDraftHistory(f.db, { id: f.id }, current.record.draft, expected),
          history,
        );
        assert.throws(
          () =>
            checkedAcceptedReviewDraftHistory(
              f.db,
              { id: f.id },
              { ...current.record.draft!, history: { ...history, corrections: 1 } },
              expected,
            ),
          { code: 'REVIEW_HISTORY_CHANGED' },
        );
        assert.throws(
          () =>
            checkedAcceptedReviewDraftHistory(f.db, { id: f.id }, current.record.draft, {
              ...expected,
              candidateVersionId: 'fictional-other-version',
            }),
          { code: 'REVIEW_HISTORY_CHANGED' },
        );
        const acceptance = {
          version: current.page.version,
          proposalId,
          reviewToken: current.page.reviewToken,
          decisions: [
            {
              recordId: current.record.id,
              action: 'accept' as const,
              mapping: current.record.mapping,
            },
          ],
        };
        const accepted = await importIntakeRead(f.db, f.root, f.profileId, f.id, acceptance);
        assert.equal(accepted.version, acceptance.version + 1);
        const saved = f.db.prepare('SELECT id,title,extra_json FROM documents').get()!;
        assert.equal(saved.title, 'Fictional correction 1');
        const imported = JSON.parse(String(saved.extra_json)).import;
        assert.deepEqual(imported.correctionHistorySource, {
          format: 'health-accepted-contribution-corrections-v1',
        });
        assert.equal(imported.corrections, undefined);
        const { clinicalImportCorrectionHistory } =
          await import('../clinical-import-corrections.ts');
        clearIntakeStateCache(f.db);
        const complete = clinicalImportCorrectionHistory(f.db, {
          profileId: f.profileId,
          kind: 'document',
          recordId: String(saved.id),
          limit: 1,
        });
        assert.equal(complete.complete, true);
        assert.equal(complete.entries.length, 1);
        assert.deepEqual(complete.entries[0]!.history, history);
        assert.equal(complete.entries[0]!.candidateVersionId, current.record.candidateVersionId);
        const corrections = readReviewDraftHistoryPage(
          f.db,
          { id: f.id },
          complete.entries[0]!.history,
          { section: 'corrections', limit: 2 },
        );
        assert.equal(corrections.total, 2);
        assert.equal(corrections.complete, true);
        assert.deepEqual(
          corrections.items.map((entry) =>
            'value' in entry ? (entry.value as { operationId: string }).operationId : null,
          ),
          ['draft-save-0', 'draft-save-1'],
        );
        const replay = await importIntakeRead(f.db, f.root, f.profileId, f.id, acceptance);
        assert.equal(replay.version, accepted.version);
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) n FROM manual_batches WHERE title='Accepted clinical contribution'",
            )
            .get()!.n,
          1,
        );
        const backup = await createBackup(f.db, f.root, f.profileId),
          recoveredRoot = join(f.root, 'correction-recovered'),
          recovered = rebuildProfile(join(backup.path, 'files'), f.profileId, recoveredRoot),
          recoveredDb = openDatabase(recovered.database, f.profileId);
        attachPersonalDurability(recoveredDb, { root: recoveredRoot, profileId: f.profileId });
        try {
          assert.deepEqual(
            clinicalImportCorrectionHistory(recoveredDb, {
              profileId: f.profileId,
              kind: 'document',
              recordId: String(saved.id),
              limit: 1,
            }),
            complete,
          );
          assert.deepEqual(
            readReviewDraftHistoryPage(recoveredDb, { id: f.id }, history, {
              section: 'corrections',
              limit: 2,
            }),
            corrections,
          );
          assert.deepEqual(
            JSON.parse(
              String(
                recoveredDb.prepare('SELECT extra_json FROM documents WHERE id=?').get(saved.id)!
                  .extra_json,
              ),
            ).import.correctionHistorySource,
            imported.correctionHistorySource,
          );
        } finally {
          clearIntakeStateCache(recoveredDb);
          recoveredDb.close();
        }
      }
      assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
      assert.equal(intakeWorkCounters(f.db).warm.sourceDTOHydrations, before.sourceDTOHydrations);
    },
  );
test(
  'native corrected occurrence attachment retains complete import audit and existing legacy corrections',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const submit = async (name: string, ordinal: number, title: string) => {
      const request = input(f, name, ordinal),
        value = JSON.parse(request.jsonlText);
      value.id = value.provenance.sourceRecordId = name;
      value.kind = 'document';
      value.clinical = {
        kind: 'document',
        subject: 'self',
        documentTitle: title,
        date: '2026-01-01',
      };
      delete value.report;
      request.jsonlText = JSON.stringify(value);
      await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
      const state = selected(f),
        intake = state.view.child(state.view.root(), 'intake')!,
        proposal = state.view.childAt(
          intake,
          'proposals',
          state.view.childCount(intake, 'proposals') - 1,
        )!,
        id = state.view.field(proposal, 'id');
      if (id.kind !== 'value' || typeof id.value !== 'string') throw Error('Missing proposal');
      return id.value;
    };
    const review = async (proposalId: string) => {
      const page = await reviewIntakeRead(f.db, f.root, f.profileId, f.id, proposalId);
      if (
        !('format' in page) ||
        page.format !== 'health-intake-clinical-review-page-v2' ||
        page.items[0]?.kind !== 'value'
      )
        throw Error('Expected bounded review');
      return { page, record: page.items[0].value as IntakeReviewRecord };
    };
    const targetProposal = await submit('fictional-saved-target', 0, 'Fictional saved note');
    const targetReview = await review(targetProposal);
    await importIntakeRead(f.db, f.root, f.profileId, f.id, {
      version: targetReview.page.version,
      proposalId: targetProposal,
      reviewToken: targetReview.page.reviewToken,
      decisions: [
        {
          recordId: targetReview.record.id,
          action: 'accept',
          mapping: targetReview.record.mapping,
        },
      ],
    });
    const target = f.db.prepare('SELECT id,extra_json FROM documents').get()!,
      extra = JSON.parse(String(target.extra_json)),
      legacyCorrections = [
        { operationId: 'fictional-legacy-correction', reason: 'Retained original audit' },
      ];
    extra.import.corrections = legacyCorrections;
    intakeTransaction(
      f.db,
      () =>
        f.db
          .prepare('UPDATE documents SET extra_json=? WHERE id=?')
          .run(JSON.stringify(extra), target.id),
      {},
    );
    const proposalId = await submit(
      'fictional-incoming-occurrence',
      1,
      'Fictional transcribed note',
    );
    let current = await review(proposalId);
    await saveIntakeReviewDraftRead(f.db, f.root, f.profileId, f.id, {
      version: current.page.version,
      operationId: 'fictional-attachment-correction',
      proposalId,
      recordId: current.record.id,
      candidateVersionId: current.record.candidateVersionId!,
      mapping: { documentTitle: 'Fictional saved note' },
      correctionPatch: { documentTitle: 'Fictional saved note' },
      correctionReason: 'Fictional transcription correction',
      disposition: 'review_later',
    });
    current = await review(proposalId);
    const comparison = current.record.comparisons?.find((entry) => entry.id === target.id);
    assert.ok(comparison, 'the corrected incoming occurrence offers the existing saved target');
    const accepted = await importIntakeRead(f.db, f.root, f.profileId, f.id, {
      version: current.page.version,
      proposalId,
      reviewToken: current.page.reviewToken,
      decisions: [
        {
          recordId: current.record.id,
          action: 'accept',
          mapping: current.record.mapping,
          comparisons: [
            {
              otherRecordId: String(target.id),
              scope: comparison.scope,
              outcome: 'same_event',
              occurrenceEvidence: 'attach',
              reason: 'Fictional duplicate delivery of the same note',
            },
          ],
        },
      ],
    });
    assert.equal(accepted.version, current.page.version + 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
    const imported = JSON.parse(
      String(
        f.db.prepare('SELECT extra_json FROM documents WHERE id=?').get(target.id)!.extra_json,
      ),
    ).import;
    assert.deepEqual(imported.corrections, legacyCorrections);
    assert.deepEqual(imported.correctionHistorySource, {
      format: 'health-accepted-contribution-corrections-v1',
    });
    const { clinicalImportCorrectionHistory } = await import('../clinical-import-corrections.ts');
    const history = clinicalImportCorrectionHistory(f.db, {
      profileId: f.profileId,
      kind: 'document',
      recordId: String(target.id),
    });
    assert.equal(history.entries.length, 1);
    assert.deepEqual(history.entries[0]!.history, current.record.draft!.history);
    const reread = await review(proposalId),
      retained = reread.record.comparisons?.find((entry) => entry.id === target.id);
    assert.equal(retained?.scope?.format, 'intake-pair-scope-v2');
    if (retained?.scope?.format !== 'intake-pair-scope-v2')
      throw Error('Expected retained attachment scope');
    assert.ok(retained.scope.activeAttachment, 'the final authority includes the new audit marker');
  },
);
test('actual native reviewed acceptance publishes clinical rows and exact replay without whole workflow reads', async (t) => {
  const f = await fixture(t),
    request = input(f, 'fictional-acceptance-proposal'),
    value = JSON.parse(request.jsonlText);
  value.kind = 'document';
  value.clinical = {
    kind: 'document',
    subject: 'self',
    documentTitle: 'Fictional note',
    date: '2026-01-01',
  };
  delete value.report;
  request.jsonlText = JSON.stringify(value);
  const proposed = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request),
    state = selected(f),
    intake = state.view.child(state.view.root(), 'intake')!,
    proposal = state.view.childAt(intake, 'proposals', 0)!,
    field = state.view.field(proposal, 'id');
  if (field.kind !== 'value' || typeof field.value !== 'string') throw Error('Missing proposal');
  const proposalId = field.value,
    page = await reviewIntakeRead(f.db, f.root, f.profileId, f.id, proposalId);
  assert.ok('format' in page && page.format === 'health-intake-clinical-review-page-v2');
  if (!('format' in page) || page.format !== 'health-intake-clinical-review-page-v2')
    throw Error('Expected review page');
  const item = page.items[0]!;
  if (item.kind !== 'value') throw Error('Expected bounded reviewed record');
  const record = item.value as IntakeReviewRecord,
    acceptance = {
      version: page.version,
      proposalId,
      reviewToken: page.reviewToken,
      decisions: [{ recordId: record.id, action: 'accept' as const, mapping: record.mapping }],
    },
    before = { ...intakeWorkCounters(f.db).warm };
  const accepted = await importIntakeRead(f.db, f.root, f.profileId, f.id, acceptance);
  assert.equal(accepted.version, proposed.version + 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
  const saved = selected(f),
    currentIntake = saved.view.child(saved.view.root(), 'intake')!;
  assert.ok(saved.view.child(currentIntake, 'imported'));
  assert.equal(saved.view.childCount(currentIntake, 'importHistory'), 0);
  clearIntakeStateCache(f.db);
  const replay = await importIntakeRead(f.db, f.root, f.profileId, f.id, acceptance);
  assert.equal(replay.version, accepted.version);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM documents').get()!.n, 1);
  await assert.rejects(
    importIntakeRead(f.db, f.root, f.profileId, f.id, {
      ...acceptance,
      decisions: [{ ...acceptance.decisions[0]!, action: 'skip' }],
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('native question commands retain exact review counts and answer replay without loading the workflow', async (t) => {
  const f = await fixture(t),
    before = { ...intakeWorkCounters(f.db).warm },
    asked = await askIntakeQuestionRead(f.db, f.root, f.profileId, f.id, {
      version: intakeSourceVersion(f.db, f.id).version,
      key: 'fictional-date',
      prompt: 'Confirm the collection date',
      locator: 'Fictional cover page',
      field: 'date',
    });
  assert.ok(isIntakeSummary(asked));
  if (!isIntakeSummary(asked)) throw Error('Expected native question summary');
  assert.equal(asked.review.state, 'exact');
  assert.equal(asked.review.counts?.unansweredCount, 1);
  assert.equal(asked.review.counts?.pendingWorkCount, 2);
  assert.equal(asked.state, 'needs_review');
  const { view, workflow } = selected(f),
    question = view.childAt(workflow, 'questions', 0)!,
    questionId = view.field(question, 'id');
  assert.ok(questionId.kind === 'value' && typeof questionId.value === 'string');
  if (questionId.kind !== 'value' || typeof questionId.value !== 'string')
    throw Error('Expected question ID');
  const request = {
    version: asked.version,
    operationId: 'fictional-answer',
    questionId: questionId.value,
    answer: 'September 2026',
    mapping: { date: '2026-09' },
  };
  const answered = await answerIntakeQuestionRead(f.db, f.root, f.profileId, f.id, request);
  assert.ok(isIntakeSummary(answered));
  if (!isIntakeSummary(answered)) throw Error('Expected native answer summary');
  assert.equal(answered.version, asked.version + 1);
  // An answer is retained evidence; only an explicit reviewed resolution closes the question.
  assert.equal(answered.review.counts?.unansweredCount, 1);
  const replay = await answerIntakeQuestionRead(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.version, answered.version);
  const current = selected(f),
    currentQuestion = current.view.find('question', current.workflow, request.questionId)!;
  assert.equal(current.view.childCount(currentQuestion, 'answers'), 1);
  await assert.rejects(
    answerIntakeQuestionRead(f.db, f.root, f.profileId, f.id, {
      ...request,
      version: answered.version,
      operationId: 'fictional-invalid',
      mapping: { startDate: '2026-09' },
    }),
    { code: 'QUESTION_MAPPING' },
  );
  assert.equal(intakeSourceVersion(f.db, f.id).version, answered.version);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
test('native chat links preserve the intake version and package work without loading a workflow', async (t) => {
  const f = await fixture(t),
    before = intakeSourceVersion(f.db, f.id),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    work = intakeWorkCounters(f.db).warm;
  assert.equal(intakeConversionChatId(f.db, f.profileId, f.id), null);
  await linkIntakeConversionRead(f.db, f.root, f.profileId, f.id, 'fictional-chat');
  assert.equal(intakeConversionChatId(f.db, f.profileId, f.id), 'fictional-chat');
  assert.equal(intakeSourceVersion(f.db, f.id).version, before.version);
  assert.notEqual(intakeSourceVersion(f.db, f.id).logicalBinding, before.logicalBinding);
  assert.equal(readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.planId, scope.planId);
  const replay = intakeWorkCounters(f.db).warm.collectionNodesWritten;
  await linkIntakeConversionRead(f.db, f.root, f.profileId, f.id, 'fictional-chat');
  assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, replay);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, work.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, work.materializationReads);
});
test('actual package publication updates an already prepared question and reading summary atomically', async (t) => {
  const f = await fixture(t);
  await prepareRetainedPlanAccess(f.db, f.profileId, f.id);
  await askIntakeQuestionRead(f.db, f.root, f.profileId, f.id, {
    version: intakeSourceVersion(f.db, f.id).version,
    key: 'fictional-pending',
    prompt: 'Confirm the date',
    field: 'date',
    locator: 'Fictional page one',
  });
  const before = { ...intakeWorkCounters(f.db).warm };
  const first = await submitPagedIntakeBatch(
    f.db,
    f.root,
    f.profileId,
    f.id,
    input(f, 'fictional-warm-one'),
  );
  assert.ok(isIntakeSummary(first));
  if (!isIntakeSummary(first)) throw Error('Expected native summary');
  assert.equal(first.review.state, 'exact');
  assert.deepEqual(first.review.counts, {
    needsReview: true,
    pendingCount: 1,
    unansweredCount: 1,
    pendingWorkCount: 1,
    reviewLaterCount: 0,
  });
  const second = await submitPagedIntakeBatch(
    f.db,
    f.root,
    f.profileId,
    f.id,
    input(f, 'fictional-warm-two', 1),
  );
  assert.ok(isIntakeSummary(second));
  if (!isIntakeSummary(second)) throw Error('Expected native summary');
  assert.equal(second.review.state, 'exact');
  assert.equal(second.review.counts?.pendingWorkCount, 0);
  // Equal record keys in two package members remain separate evidence scopes.
  assert.equal(second.review.counts?.pendingCount, 2);
  assert.equal(second.review.counts?.unansweredCount, 1);
  await linkIntakeConversionRead(f.db, f.root, f.profileId, f.id, 'fictional-resume-chat');
  const linked = getIntakeRead(f.db, f.root, f.profileId, f.id);
  assert.ok(isIntakeSummary(linked));
  if (!isIntakeSummary(linked)) throw Error('Expected native linked summary');
  assert.equal(linked.version, second.version);
  assert.equal(linked.review.state, 'exact');
  assert.deepEqual(linked.review.counts, second.review.counts);
  assert.notEqual(linked.pins.logicalRoot, second.pins.logicalRoot);
  const unit = input(f, 'fictional-unsubmitted').coverage[0]!.unitId;
  assert.equal(readRetainedIntakeUnitScope(f.db, f.root, f.profileId, f.id, unit).unit.id, unit);
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.envelopeHydrations);
  assert.equal(intakeWorkCounters(f.db).warm.materializationReads, before.materializationReads);
});
function input(f: Fixture, operationId: string, ordinal = 0) {
  const scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    member = scope.inventory.member(ordinal)!,
    unit = scope.unit(member.memberId)!;
  return {
    version: scope.version,
    planId: scope.planId,
    operationId,
    summary: 'Fictional report proposal',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'fictional-record',
      kind: 'record',
      payload: { literal: '12.00' },
      provenance: {
        capturedVia: 'Fictional delivery',
        sourceSystem: 'Fictional issuer',
        sourceRecordId: 'fictional-record',
        evidenceClass: 'provider_export',
        locator: 'page 1',
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'observation',
        subject: 'self',
        testLabel: 'Example',
        valueText: '12.00',
        unit: 'mg',
        date: '2026-09',
      },
      report: {
        key: 'fictional-report',
        title: 'Fictional report',
        memberId: member.memberId,
        anchor: { locator: 'page 1', text: 'Report F27' },
        subject: null,
      },
    }),
    coverage: [{ unitId: unit.id, kind: 'extracted' as const, notes: 'Fictional evidence read' }],
  };
}
function selected(f: Fixture) {
  const file = f.db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(f.id)!,
    view = openIntakeCollectionEnvelope(f.db, file as never),
    intake = view.child(view.root(), 'intake')!,
    workflow = view.child(intake, 'workflow')!;
  return { view, intake, workflow };
}

test('actual package batch publishes proposal original, candidate/report evidence and progress, then replays under changed source pins', async (t) => {
  const f = await fixture(t),
    request = input(f, 'fictional-batch-one'),
    before = intakeWorkCounters(f.db);
  const first = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  assert.ok(isIntakeSummary(first));
  if (!isIntakeSummary(first)) throw Error('Expected native summary');
  assert.equal(first.version, request.version + 1);
  assert.equal(first.durability.pending, false);
  assert.equal(first.collections.proposals.total, 1);
  assert.equal(first.collections.candidates.total, 1);
  assert.equal(first.collections.reportGroups.total, 1);
  assert.equal(first.activePlan.state, 'exact');
  const proposal = f.db
    .prepare("SELECT id,path FROM source_files WHERE kind='intake_proposal'")
    .get()!;
  assert.equal(
    readFileSync(profileOriginal(f.root, String(proposal.path), f.profileId), 'utf8'),
    request.jsonlText,
  );
  assert.notEqual(
    nextPendingPagedPackageUnit(f.db, f.root, f.profileId, f.id)!.id,
    request.coverage[0]!.unitId,
  );
  const secondRequest = { ...request, version: first.version, operationId: 'fictional-batch-two' };
  const second = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, secondRequest);
  assert.ok(isIntakeSummary(second));
  const retained = selected(f),
    candidate = retained.view.childAt(retained.workflow, 'candidates', 0)!,
    version = retained.view.childAt(candidate, 'versions', 0)!;
  assert.equal(retained.view.childCount(version, 'occurrences'), 2);
  assert.equal(retained.view.childCount(retained.intake, 'proposals'), 1);
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.unitById(request.coverage[0]!.unitId)!
      .attemptCount,
    2,
  );
  assert.equal(intakeWorkCounters(f.db).warm.envelopeHydrations, before.warm.envelopeHydrations);
  const backup = await createBackup(f.db, f.root, f.profileId),
    recoveredRoot = join(f.root, 'recovered'),
    recovered = rebuildProfile(join(backup.path, 'files'), f.profileId, recoveredRoot),
    recoveredDb = openDatabase(recovered.database, f.profileId);
  attachPersonalDurability(recoveredDb, { root: recoveredRoot, profileId: f.profileId });
  try {
    const recoveredScope = readPackagePlanScope(recoveredDb, recoveredRoot, f.profileId, f.id)!;
    assert.equal(recoveredScope.planId, request.planId);
    assert.equal(recoveredScope.unitById(request.coverage[0]!.unitId)!.attemptCount, 2);
    assert.equal(recoveredScope.accountedKind(request.coverage[0]!.unitId), 'extracted');
    const recoveredRead = getIntakeRead(recoveredDb, recoveredRoot, f.profileId, f.id);
    assert.ok(isIntakeSummary(recoveredRead));
    if (isIntakeSummary(recoveredRead))
      assert.equal(recoveredRead.collections.reportGroups.total, 1);
    const recoveredReplay = await submitPagedIntakeBatch(
      recoveredDb,
      recoveredRoot,
      f.profileId,
      f.id,
      request,
    );
    assert.equal(recoveredReplay.version, second.version);
    assert.equal(recoveredReplay.durability.pending, false);
  } finally {
    clearPackageSourceSession(recoveredDb);
    clearIntakeStateCache(recoveredDb);
    recoveredDb.close();
  }
  intakeTransaction(
    f.db,
    () =>
      writeIntakeSourcePin(f.db, f.id, {
        revisionId: 'fictional-new-revision',
        dependencyToken: 'fictional-new-token',
        requiresInterpretation: true,
        version: 1,
      }),
    {},
  );
  const replayVersion = intakeSourceVersion(f.db, f.id).version;
  clearIntakeStateCache(f.db);
  const beforeReplay = intakeWorkCounters(f.db);
  const replay = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(replay.version, replayVersion);
  assert.equal(replay.durability.pending, false);
  assert.equal(
    intakeWorkCounters(f.db).warm.collectionNodesWritten,
    beforeReplay.warm.collectionNodesWritten,
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) n FROM source_files WHERE kind='intake_proposal'").get()!.n,
    1,
  );
});

test('actual proposal registration failure leaves candidate and batch progress unselected and retry succeeds', async (t) => {
  const f = await fixture(t),
    request = input(f, 'fictional-failed-batch'),
    before = intakeSourceVersion(f.db, f.id);
  f.db.exec(
    "CREATE TEMP TRIGGER fictional_proposal_failure BEFORE INSERT ON source_files WHEN NEW.kind='intake_proposal' BEGIN SELECT RAISE(ABORT,'fictional proposal registration failure'); END",
  );
  await assert.rejects(
    submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request),
    /fictional proposal registration failure/,
  );
  assert.deepEqual(intakeSourceVersion(f.db, f.id), before);
  const summary = getIntakeRead(f.db, f.root, f.profileId, f.id);
  assert.ok(isIntakeSummary(summary));
  if (isIntakeSummary(summary)) assert.equal(summary.collections.proposals.total, 0);
  assert.equal(
    readPackagePlanScope(f.db, f.root, f.profileId, f.id)!.unitById(request.coverage[0]!.unitId)!
      .attemptCount,
    0,
  );
  f.db.exec('DROP TRIGGER fictional_proposal_failure');
  const retry = await submitPagedIntakeBatch(f.db, f.root, f.profileId, f.id, request);
  assert.equal(retry.version, before.version + 1);
  assert.equal(retry.durability.pending, false);
});

test('proposal dependency role hashes use complete selected native evidence without workflow reads', async (t) => {
  const f = await fixture(t),
    scope = readPackagePlanScope(f.db, f.root, f.profileId, f.id)!,
    member = scope.inventory.member(0)!,
    role = {
      memberId: member.memberId,
      role: 'context' as const,
      reason: 'Fictional scoped context',
      coverage: 'pending' as const,
      references: [],
    };
  assert.equal(packageMemberRoleHash(f.db, f.id, member.memberId), null);
  await savePagedPackageRoles(f.db, f.root, f.profileId, f.id, {
    version: scope.version,
    operationId: 'fictional-role',
    planId: scope.planId,
    roles: [role],
  });
  clearIntakeStateCache(f.db);
  const before = intakeWorkCounters(f.db);
  assert.equal(
    packageMemberRoleHash(f.db, f.id, member.memberId),
    createHash('sha256').update(JSON.stringify(role)).digest('hex'),
  );
  assert.equal(packageMemberRoleHash(f.db, f.id, 'not-a-member'), null);
  assert.equal(packageMemberRoleHash(f.db, 'not-an-intake', member.memberId), null);
  const after = intakeWorkCounters(f.db);
  assert.equal(after.warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(after.warm.materializationReads, before.warm.materializationReads);
  assert.equal(after.warm.jsonCanonicalInputCodeUnits, before.warm.jsonCanonicalInputCodeUnits);
});
