import { firstReportGroup } from '../../shared/intake-report-group-links.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, reviewIntake, workflowMutation, getIntakeOriginal } from '../intake.ts';
import { saveIntakeDraftRepairRead } from '../intake-draft-repair-native.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { readNativeReviewDraft, readReviewDraftHistoryPage } from '../intake-review-draft-state.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { fictionalModel } from './fictional-model.ts';
import type { IntakeDraftRepairUpdate } from '../../shared/intake.ts';

test('native repair composes ordered fields and records in one version with exact history, replay and stale atomicity', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-repair-')),
    profileId = 'fictional',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from(
    ['one', 'two']
      .map((id) =>
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'record',
          payload: { literal: 'Independent fictional test record ' + id },
          clinical: {
            kind: 'observation',
            subject: 'self',
            testLabel: 'Fictional ' + id,
            valueText: '12',
            unit: 'fictional units',
            date: '2025-01-01',
            method: 'Original method',
            observationCategory: 'Fictional panel',
          },
          provenance: {
            capturedVia: null,
            sourceSystem: 'Fictional Clinic',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'row ' + id,
          },
          coverage: { status: 'complete_response', notes: [] },
          report: {
            key: 'fictional-report',
            title: 'Fictional panel',
            anchor: { locator: 'heading', text: 'Fictional report' },
            subject: null,
          },
        }),
      )
      .join('\n'),
  );
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional Clinic',
    bytes,
  });
  const review = reviewIntake(db, root, profileId, source.id),
    [first, second] = review.records;
  assert.ok(first && second);
  const selected = workflowMutation(
    db,
    root,
    profileId,
    source.id,
    { version: source.version, operationId: 'fictional-prior' },
    (workflow) => {
      workflow.reviewDrafts.push({
        id: 'prior',
        proposalId: null,
        recordId: first.id,
        candidateId: first.candidateId!,
        candidateVersionId: first.candidateVersionId!,
        mapping: { method: 'Prior method' },
        decision: { recordId: first.id, action: 'skip', mapping: { method: 'Decision method' } },
        disposition: 'review_later',
        answers: { fictional: 'Retained answer' },
        at: '2026-01-01T00:00:00Z',
        resolutions: [
          { issueId: 'fictional-prior-issue', outcome: 'acknowledged', operationId: 'prior' },
        ],
        corrections: [
          {
            operationId: `repair-three:3:${first.id}:date`,
            at: '2026-01-01T00:00:00Z',
            reason: 'Fictional prior edit',
            before: { method: 'Original method' },
            after: { method: 'Prior method' },
          },
        ],
      });
    },
  );
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  const input: IntakeDraftRepairUpdate = {
    version: selected.version,
    operationId: 'repair-three',
    groupId: firstReportGroup(first.reportGroups)!.groupId,
    corrections: [
      {
        proposalId: null,
        recordId: first.id,
        candidateVersionId: first.candidateVersionId!,
        field: 'date',
        before: '2025-01-01',
        after: '2025-02-02',
      },
      {
        proposalId: null,
        recordId: first.id,
        candidateVersionId: first.candidateVersionId!,
        field: 'method',
        before: 'Decision method',
        after: 'Reviewed method',
      },
      {
        proposalId: null,
        recordId: second.id,
        candidateVersionId: second.candidateVersionId!,
        field: 'method',
        before: 'Original method',
        after: 'Second reviewed method',
      },
    ],
  };
  const before = { ...intakeWorkCounters(db).warm };
  const result = await saveIntakeDraftRepairRead(db, root, profileId, source.id, input);
  assert.equal(result.version, input.version + 1);
  const assertNoPolicies = () => {
    assert.equal(db.prepare('SELECT count(*) n FROM intake_review_issue_policy_v2').get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM intake_review_issue_scope').get()!.n, 0);
  };
  assertNoPolicies();
  const read = () => {
    const view = openIntakeCollectionEnvelope(db, { id: source.id }),
      flow = view.child(view.child(view.root(), 'intake')!, 'workflow')!,
      catalog = createReportSnapshotCatalog(db, { id: source.id }, { catalog: 'review.snapshots' });
    return {
      view,
      flow,
      values: Array.from({ length: view.childCount(flow, 'reviewDrafts') }, (_, index) =>
        readNativeReviewDraft(view, view.childAt(flow, 'reviewDrafts', index)!, catalog, 65536),
      ),
    };
  };
  const drafts = read().values;
  assert.deepEqual(
    drafts.slice(1).map((draft) => draft.id),
    [
      `repair-three:3:${first.id}:date`,
      `repair-three:3:${first.id}:method`,
      `repair-three:3:${second.id}:method`,
    ],
  );
  assert.equal(drafts[1]!.mapping.date, '2025-02-02');
  assert.equal(drafts[1]!.mapping.method, 'Prior method');
  assert.equal(drafts[2]!.mapping.date, '2025-02-02');
  assert.equal(drafts[2]!.mapping.method, 'Reviewed method');
  assert.equal(drafts[2]!.decision?.mapping?.method, 'Reviewed method');
  assert.equal(drafts[2]!.disposition, 'review_later');
  assert.deepEqual(drafts[2]!.answers, { fictional: 'Retained answer' });
  assert.deepEqual(drafts[1]!.history, drafts[2]!.history);
  assert.equal(drafts[2]!.history?.resolutions, 1);
  assert.equal(drafts[2]!.history?.corrections, 1);
  assert.equal(
    readReviewDraftHistoryPage(db, { id: source.id }, drafts[2]!.history!, {
      section: 'corrections',
    }).total,
    1,
  );
  assert.equal(drafts[3]!.history?.resolutions, 0);
  const stale: IntakeDraftRepairUpdate = {
    ...input,
    version: result.version,
    operationId: 'late-stale',
    corrections: [
      { ...input.corrections[1]!, before: 'Reviewed method', after: 'Must not publish' },
      { ...input.corrections[2]!, before: 'stale', after: 'Must not publish either' },
    ],
  };
  await assert.rejects(saveIntakeDraftRepairRead(db, root, profileId, source.id, stale), {
    code: 'DRAFT_REPAIR_STALE',
  });
  assertNoPolicies();
  assert.equal(intakeSourceVersion(db, source.id).version, result.version);
  assert.equal(read().values.length, 4);
  await assert.rejects(
    saveIntakeDraftRepairRead(db, root, profileId, source.id, {
      ...stale,
      groupId: 'different-report',
    }),
    { code: 'DRAFT_REPAIR_SCOPE' },
  );
  await assert.rejects(
    saveIntakeDraftRepairRead(db, root, profileId, source.id, {
      ...input,
      corrections: [input.corrections[0]!, input.corrections[0]!],
    }),
    { code: 'DRAFT_REPAIR_SCOPE' },
  );
  assertNoPolicies();
  clearIntakeStateCache(db);
  assert.equal(
    (await saveIntakeDraftRepairRead(db, root, profileId, source.id, input)).version,
    result.version,
  );
  assert.equal(read().values.length, 4);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(
      (await saveIntakeDraftRepairRead(db, root, profileId, source.id, input)).version,
      result.version,
    );
    assertNoPolicies();
    await assert.rejects(saveIntakeDraftRepairRead(db, root, profileId, source.id, stale), {
      code: 'DRAFT_REPAIR_STALE',
    });
    assertNoPolicies();
  }
  await assert.rejects(
    saveIntakeDraftRepairRead(db, root, profileId, source.id, {
      ...input,
      corrections: [{ ...input.corrections[0]!, after: '2025-03-03' }],
    }),
    { code: 'OPERATION_CONFLICT' },
  );
  assert.deepEqual(getIntakeOriginal(db, root, profileId, source.id).bytes, bytes);
  for (const name of ['sourceDTOHydrations', 'envelopeHydrations', 'materializationReads'] as const)
    assert.equal(intakeWorkCounters(db).warm[name], before[name]);
});
