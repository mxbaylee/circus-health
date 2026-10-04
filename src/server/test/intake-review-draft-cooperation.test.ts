import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake, intakeTransaction } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  openIntakeCollectionEnvelope,
  selectedEnvelopeStore,
} from '../intake-collection-envelope.ts';
import { prepareIntakeWorkflowCommand } from '../intake-workflow-command.ts';
import { createReportSnapshotCatalog } from '../intake-report-snapshot-catalog.ts';
import { prepareNativeDraftHistory } from '../intake-review-draft-state.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import {
  reviewDraftResolutions,
  latestReviewDraftResolution,
  knownReviewDraftResolution,
  latestSelfReviewDraftResolution,
} from '../intake-review-draft-selection.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import { canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import type { IntakeIssueResolution, IntakeReviewDraft } from '../../shared/intake.ts';

const witnesses = () =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith('intake-native-draft-witnesses-'))
    .sort();
const canonical = (value: unknown) => Array.from(canonicalReviewValueChunks(value)).join('');

test(
  'cold native selected draft yields inside retained witness history with exact policy, tokens and cleanup',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-draft-cooperation-')),
      profileId = 'fictional-profile',
      db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
    attachPersonalDurability(db, { root, profileId });
    t.after(() => {
      clearIntakeStateCache(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    const source = uploadIntake(db, root, profileId, {
      filename: 'fictional.jsonl',
      newProviderName: 'Fictional clinic',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id: 'fictional-record',
          kind: 'document',
          payload: { text: 'Fictional retained document' },
          clinical: {
            kind: 'document',
            subject: 'unknown',
            documentTitle: 'Fictional history',
            date: '2026-01-01',
          },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: 'fictional-record',
            evidenceClass: 'provider_export',
            locator: 'page 1',
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      ),
    });
    await buildIntakeCollectionEnvelope(db, source);
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    const initial = prepareCollectionClinicalReview(db, root, profileId, source.id);
    if (initial.status !== 'ready') throw Error('Expected initial native review');
    const record = initial.session.review.records[0]!,
      version = initial.session.review.version;
    const resolutions: IntakeIssueResolution[] = Array.from(
      { length: 96 },
      (_, n) =>
        parseLiteralJSON(
          `{"issueId":"fictional-issue-${n}","outcome":"confirmed","unknownField":{"literal":12.00,"text":"${'fictional '.repeat(64)}"},"operationId":"fictional-${n}"}`,
        ) as IntakeIssueResolution,
    );
    resolutions.push(
      { issueId: 'fictional-issue-0', outcome: 'this_is_me', operationId: 'fictional-self' },
      { issueId: 'fictional-issue-0', outcome: 'unknown', operationId: 'fictional-latest' },
      { issueId: 'fictional-issue-1', outcome: 'unknown', operationId: 'fictional-unknown' },
    );
    const draft: IntakeReviewDraft = {
      id: 'fictional-draft',
      proposalId: null,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      mapping: { documentTitle: 'Reviewed fictional history' },
      disposition: 'pending',
      at: '2026-01-01',
      resolutions,
    };
    initial.session.close();
    const view = openIntakeCollectionEnvelope(db, source),
      catalog = createReportSnapshotCatalog(db, source, { catalog: 'review.snapshots' }),
      preparedDraft = await prepareNativeDraftHistory(db, source, view, undefined, draft, {
        catalog,
        newResolutions: resolutions,
      });
    const publication = await prepareIntakeWorkflowCommand(db, source, {
      version,
      operationId: 'fictional-native-draft-cooperation',
      request: { resolutions: resolutions.length },
      createdAt: '2026-01-01',
      additionalLogicalChanges: await catalog.finalChanges(),
      *changes({ workflow }) {
        yield {
          op: 'append',
          record: workflow,
          field: 'reviewDrafts',
          jsonText: JSON.stringify(preparedDraft.draft),
        };
      },
    });
    if (publication.replayed) throw Error('Unexpected fixture replay');
    intakeTransaction(
      db,
      () => {
        publication.assertCurrent();
        selectedEnvelopeStore(db, source).collections.stage(publication.prepared);
      },
      { operationId: publication.publicationId, fingerprint: publication.fingerprint },
    );
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id);
    const options = { metadataBytes: 16384 };
    const sync = prepareCollectionClinicalReview(db, root, profileId, source.id, null, options);
    if (sync.status !== 'ready') throw Error('Expected synchronous selected draft oracle');
    const oracle = canonical(sync.session.review),
      selected = sync.session.review.records[0]!.draft!;
    // Independent array policy: latest, last nonunknown, and last self; preserve original ordinal order.
    const ordinals = new Set<number>();
    for (const item of resolutions) {
      ordinals.add(resolutions.findLastIndex((value) => value.issueId === item.issueId));
      const known = resolutions.findLastIndex(
        (value) => value.issueId === item.issueId && value.outcome !== 'unknown',
      );
      if (known >= 0) ordinals.add(known);
    }
    ordinals.add(resolutions.findLastIndex((item) => item.outcome === 'this_is_me'));
    const expected = resolutions.filter((_, n) => ordinals.has(n));
    assert.equal(
      canonical(Array.from(reviewDraftResolutions(selected))),
      canonicalLiteral(expected),
    );
    assert.equal(
      latestReviewDraftResolution(selected, 'fictional-issue-0')?.operationId,
      'fictional-latest',
    );
    assert.equal(
      knownReviewDraftResolution(selected, 'fictional-issue-0')?.operationId,
      'fictional-self',
    );
    assert.equal(latestSelfReviewDraftResolution(selected)?.operationId, 'fictional-self');
    assert.ok(
      selected.resolutionsReference,
      'bounded transport retains the complete canonical provider',
    );
    assert.match(canonical(selected), /12\.00/);
    sync.session.close();
    const beforeScratch = witnesses();
    const partialWitnessIndex = () => {
      for (const name of witnesses()) {
        if (beforeScratch.includes(name)) continue;
        const index = new DatabaseSync(join(tmpdir(), name, 'scratch.sqlite'), { readOnly: true });
        try {
          const count = Number(
            index.prepare('SELECT COUNT(*) AS count FROM selected').get()!.count,
          );
          if (count > 0 && count < expected.length) return true;
        } finally {
          index.close();
        }
      }
      return false;
    };
    let completed = false,
      stopped = false,
      request: Promise<Response> | undefined,
      historyTurns = 0;
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          owner:
            db.prepare("SELECT value FROM app_meta WHERE key='profile_id'").get()?.value ??
            profileId,
          completed,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected fictional HTTP listener');
    const heartbeat = () => {
      if (stopped) return;
      if (partialWitnessIndex()) {
        historyTurns++;
        request ??= fetch(`http://127.0.0.1:${address.port}/unrelated-profile-header`);
      }
      setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    try {
      const ready = await prepareCollectionClinicalReviewAsync(
        db,
        root,
        profileId,
        source.id,
        null,
        options,
      );
      completed = true;
      if (ready.status !== 'ready') throw Error('Expected cooperative selected draft');
      try {
        assert.equal(
          canonical(ready.session.review),
          oracle,
          'all review and selection tokens remain exact',
        );
        assert.ok(
          request,
          'unrelated HTTP request starts before native draft witness SQL preparation completes',
        );
        assert.deepEqual(await (await request).json(), { owner: profileId, completed: false });
        assert.ok(historyTurns > 0);
      } finally {
        ready.session.close();
      }
    } finally {
      stopped = true;
    }
    assert.deepEqual(witnesses(), beforeScratch);
    assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    for (const mode of ['abort', 'drift'] as const) {
      const controller = new AbortController();
      let finished = false,
        interrupted = false;
      const interrupt = () => {
        if (finished) return;
        if (partialWitnessIndex()) {
          interrupted = true;
          if (mode === 'abort') controller.abort();
          else
            db.prepare(
              "UPDATE app_meta SET value=CAST(value AS INTEGER)+1 WHERE key='clinical_review_revision'",
            ).run();
        } else setImmediate(interrupt);
      };
      setImmediate(interrupt);
      try {
        await assert.rejects(
          prepareCollectionClinicalReviewAsync(db, root, profileId, source.id, null, {
            ...options,
            signal: controller.signal,
          }),
          mode === 'abort' ? { name: 'AbortError' } : /Review changed while preparing/,
        );
        assert.ok(
          interrupted,
          `${mode} occurs during native selected draft SQL witness preparation`,
        );
      } finally {
        finished = true;
      }
      assert.deepEqual(witnesses(), beforeScratch);
      assert.deepEqual(reviewIssueScratchCounts(db), { databases: 0, scopes: 0, rows: 0 });
    }
    t.diagnostic(
      JSON.stringify({
        retainedResolutions: resolutions.length,
        policyWitnesses: expected.length,
        historyTurns,
      }),
    );
  },
);
