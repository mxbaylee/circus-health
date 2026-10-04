import { attachPersonalDurability } from '../portable.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, observeTransactionOutcome, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createApp } from '../index.ts';
import { readQualificationReview } from '../../scripts/qualification-intake-read.ts';
import type { ClinicalRecordSectionPage } from '../../shared/intake-clinical-record-sections.ts';
import type { IntakeEvidenceComparison } from '../../shared/intake.ts';
import type { IntakeReviewDraftTransition } from '../../shared/intake-review-draft-transition.ts';
import { refreshPairScopesAfterOwnDraft } from '../../app/features/intake/review-draft-pair-scope.ts';
import type { ReviewDraftPairCommit } from '../../app/features/intake/review-draft-pair-scope.ts';
import type {
  Intake,
  IntakeReview,
  IntakeReviewDecision,
  IntakeReviewDraftUpdate,
} from '../../shared/intake.ts';

for (const change of [
  'none',
  'unrelated mutation',
  'clinical mapping changed',
  'ordinary write during preparation',
] as const) {
  // These actual durable HTTP fixtures measured 11–21 seconds in isolation;
  // allow host contention while preserving every revision and refusal assertion.
  test(
    `real draft HTTP roundtrip refreshes only its own pair pins: ${change}`,
    { timeout: 90000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'fictional-own-draft-pair-'));
      const profileId = 'cookie-dough';
      const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
      attachPersonalDurability(db, { root, profileId });
      const app = createApp({ root, databases: new Map([[profileId, db]]) });
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        await new Promise<void>((resolve) => app.server.close(() => resolve()));
        db.close();
        rmSync(root, { recursive: true, force: true });
      });
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/${profileId}/intakes`;
      async function request<T>(path: string, body?: unknown, status = 200) {
        const response = await fetch(base + path, {
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
          headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' },
        });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result as { data: T; meta: { revision: number }; error?: { code: string } };
      }
      async function review(path: string) {
        const current = await readQualificationReview(
          async <T>(page: string) => (await request<T>(page)).data,
          path + '/review',
        );
        for (const record of current.records) {
          const page = (
            await request<ClinicalRecordSectionPage>(path + '/related-records', {
              proposalId: current.proposalId,
              recordId: record.id,
              candidateVersionId: record.candidateVersionId,
            })
          ).data;
          assert.equal(page.format, 'health-clinical-record-section-page-v1');
          assert.equal(page.section, 'comparisons');
          assert.equal(page.nextCursor, null, 'the small fictional pair is completely inspected');
          assert.equal(page.items.length, page.total);
          record.comparisons = page.items.map((item) => {
            assert.equal(item.control.kind, 'pair');
            assert.equal(item.detail.kind, 'value');
            assert.ok(item.detail.kind === 'value');
            const { comparison } = item.detail.value as { comparison: IntakeEvidenceComparison };
            assert.ok(comparison);
            return comparison;
          });
        }
        return current;
      }
      async function upload(id: string, valueText: string) {
        const bytes = JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'record',
          payload: { literal: valueText },
          provenance: {
            capturedVia: 'Fictional delivery',
            sourceSystem: 'Fictional issuer',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'row 1',
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'observation',
            subject: 'self',
            testLabel: 'Fictional Example',
            valueText,
            unit: 'mg/L',
            date: '2026-09-01',
          },
        });
        const response = await fetch(base, {
          method: 'POST',
          body: bytes,
          headers: {
            origin: 'http://127.0.0.1:5173',
            'content-type': 'application/x-ndjson',
            'x-filename': `${id}.jsonl`,
          },
        });
        const result = await response.json();
        assert.equal(response.status, 201, JSON.stringify(result));
        return result.data as Intake;
      }
      const accept = (review: IntakeReview, decision?: IntakeReviewDecision) => ({
        operationId: randomUUID(),
        blocks: [
          {
            intakeId: review.intakeId,
            proposalId: review.proposalId,
            intakeVersion: review.version,
            reviewToken: review.reviewToken,
            selections: [
              {
                recordId: review.records[0]!.id,
                candidateId: review.records[0]!.candidateId!,
                candidateVersionId: review.records[0]!.candidateVersionId!,
                mapping: decision?.mapping || review.records[0]!.mapping,
                comparisons: decision?.comparisons,
              },
            ],
          },
        ],
      });
      const first = await upload('fictional-first', '7.5');
      const firstReview = await review(`/${encodeURIComponent(first.id)}`);
      await request('/report-acceptance', accept(firstReview));
      const second = await upload('fictional-second', '9.25');
      const path = `/${encodeURIComponent(second.id)}`;
      const before = await review(path);
      const record = before.records[0]!;
      assert.equal(record.comparisons!.length, 1);
      const decision: IntakeReviewDecision = {
        recordId: record.id,
        action: 'accept',
        mapping: structuredClone(record.mapping),
        comparisons: [
          {
            otherRecordId: record.comparisons![0]!.id,
            scope: record.comparisons![0]!.scope,
            outcome: 'distinct',
            reason: 'Fictional originals establish two separate values.',
          },
        ],
      };
      const draft: IntakeReviewDraftUpdate = {
        operationId: randomUUID(),
        version: before.version,
        proposalId: before.proposalId,
        recordId: record.id,
        candidateVersionId: record.candidateVersionId!,
        mapping: decision.mapping,
        disposition: 'pending',
        resolutions: [],
        answers: {},
        decision,
      };
      if (change === 'ordinary write during preparation') {
        let intervened = false;
        const stop = observeTransactionOutcome(db, (outcome) => {
          if (outcome.intakeMaintenance && !intervened) {
            intervened = true;
            transaction(db, () => {});
          }
        });
        try {
          const rejected = await request(path + '/review-draft', draft, 409);
          assert.equal(intervened, true);
          assert.equal(rejected.error!.code, 'DUPLICATE_SCOPE_CHANGED');
          assert.equal(rejected.data, undefined, 'failed preparation grants no transition');
          assert.equal((await request<Intake>(path)).data.version, before.version);
          assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
        } finally {
          stop();
        }
        return;
      }
      type DraftResponse = Intake & { reviewDraftTransition?: IntakeReviewDraftTransition };
      const saved = await request<DraftResponse>(path + '/review-draft', draft);
      const transition = saved.data.reviewDraftTransition;
      assert.ok(transition, 'a fresh native save acknowledges its exact preparation transition');
      assert.equal(transition.operationId, draft.operationId);
      assert.equal(transition.toRevision, saved.meta.revision);
      assert.equal(transition.toVersion, saved.data.version);
      assert.equal(
        transition.fromRevision,
        record.comparisons![0]!.scope!.format === 'intake-pair-scope-v2'
          ? record.comparisons![0]!.scope!.requestRevision
          : -1,
      );
      assert.ok(
        transition.toRevision > transition.fromRevision + 1,
        'fixture exercises certified maintenance',
      );
      const commit: ReviewDraftPairCommit = {
        profileId,
        intakeId: second.id,
        candidateId: record.candidateId!,
        request: draft,
        version: saved.data.version,
        revision: saved.meta.revision,
        transition,
      };
      if (change === 'unrelated mutation') await upload('fictional-unrelated', '101');
      if (change === 'clinical mapping changed') {
        const mapping = { ...decision.mapping, valueText: '99' };
        await request(path + '/review-draft', {
          ...draft,
          operationId: randomUUID(),
          version: saved.data.version,
          mapping,
          decision: { ...decision, mapping },
        });
      }
      const fresh = await review(path);
      const current = fresh.records[0]!;
      const stripped = Object.keys(decision.mapping).filter(
        (key) => !Object.hasOwn(current.draft!.mapping, key),
      );
      assert.deepEqual(
        stripped.sort(),
        [
          'assets',
          'label',
          'mappingOrigins',
          'sourceRecordId',
          'sourceSystem',
          'uncertainties',
        ].sort(),
      );
      const refreshed = refreshPairScopesAfterOwnDraft(profileId, fresh, current, decision, commit);
      if (change === 'none') {
        const replay = await request<DraftResponse>(path + '/review-draft', draft);
        assert.equal(
          replay.data.reviewDraftTransition,
          undefined,
          'replay cannot manufacture own-write proof',
        );
        assert.equal(
          refreshPairScopesAfterOwnDraft(profileId, fresh, current, decision, {
            ...commit,
            transition: undefined,
          }),
          decision,
        );
        assert.deepEqual(refreshed.comparisons![0]!.scope, current.comparisons![0]!.scope);
        assert.notEqual(
          refreshed.comparisons![0]!.scope!.token,
          decision.comparisons![0]!.scope!.token,
        );
        await request('/report-acceptance', accept(fresh, refreshed));
        assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 2);
      } else {
        assert.equal(refreshed, decision);
        const rejected = await request('/report-acceptance', accept(fresh, refreshed), 409);
        assert.equal(rejected.error!.code, 'DUPLICATE_SCOPE_CHANGED');
        assert.equal(db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
      }
    },
  );
}
