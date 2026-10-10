import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, proposeConversion } from '../intake.ts';
import { appendOwnershipDecision } from '../ownership-journal.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
  prepareCollectionClinicalReviewForAcceptanceAsync,
} from '../intake-review-collection-host.ts';
import {
  consumeCollectionClinicalAcceptanceReview,
  consumeCollectionClinicalAcceptanceGroup,
  consumeCollectionClinicalAcceptanceProjection,
  inspectCollectionClinicalAcceptanceProjection,
  disposeCollectionClinicalAcceptanceReview,
  type CollectionClinicalAcceptancePreparation,
} from '../intake-review-collection-session.ts';
import { acceptIntakeReportSelectionAsync } from '../intake-report-acceptance.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

async function fixture(t: test.TestContext, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-acceptance-handoff-')),
    profileId = 'fictional-acceptance-handoff',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sources = [];
  for (let index = 0; index < count; index++) {
    const jsonlText = JSON.stringify({
      format: 'health-record-v1',
      id: `fictional-${index}`,
      kind: 'document',
      payload: { text: `Fictional document ${index}` },
      provenance: {
        capturedVia: null,
        sourceSystem: 'Fictional clinic',
        sourceRecordId: `fictional-${index}`,
        evidenceClass: 'provider_export',
        locator: `Fictional section ${index}`,
      },
      coverage: { status: 'complete_response', notes: [] },
      clinical: {
        kind: 'document',
        subject: 'self',
        documentTitle: `Fictional document ${index}`,
        date: '2026-02-10',
      },
    });
    const source = uploadIntake(db, root, profileId, {
      filename: `fictional-${index}.txt`,
      bytes: Buffer.from(jsonlText),
    });
    const proposed = proposeConversion(db, root, profileId, source.id, {
      version: source.version,
      summary: 'Fictional selected occurrence',
      jsonlText,
    });
    const proposalId = proposed.proposals.at(-1)!.id;
    sources.push({ source, proposalId });
  }
  for (const { source } of sources) await buildIntakeCollectionEnvelope(db, { id: source.id });
  for (const { source, proposalId } of sources)
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, proposalId);
  await prepareIntakeLookupIndices(db);
  return { db, root, profileId, sources };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, controls = {}) {
  const { source, proposalId } = f.sources[0]!;
  const result = await prepareCollectionClinicalReviewForAcceptanceAsync(
    f.db,
    f.root,
    f.profileId,
    source.id,
    proposalId,
    controls,
  );
  if (result.status !== 'prepared') throw Error('Expected fictional prepared review');
  return result.preparation;
}

function countPhysicalPasses(t: test.TestContext) {
  const all = StatementSync.prototype.all,
    iterate = StatementSync.prototype.iterate;
  const counts = {
    sessionWorker: 0,
    unionWorker: 0,
    sessionSync: 0,
    unionSync: 0,
    workerIdentities: 0,
    syncIdentities: 0,
  };
  t.mock.method(StatementSync.prototype, 'all', function (this: StatementSync, ...args: unknown[]) {
    const rows = Reflect.apply(all, this, args);
    const sql = this.sourceSQL;
    if (
      /^SELECT id,path,identity,(seal|signature) FROM (main\.consumed_source_files|artifacts) .*LIMIT 64$/.test(
        sql,
      )
    ) {
      if (!sql.includes('WHERE id>')) {
        if (sql.includes('consumed_source_files')) counts.sessionWorker++;
        else counts.unionWorker++;
      }
      counts.workerIdentities += rows.length;
    }
    return rows;
  });
  t.mock.method(
    StatementSync.prototype,
    'iterate',
    function (this: StatementSync, ...args: unknown[]) {
      const rows = Reflect.apply(iterate, this, args) as ReturnType<StatementSync['iterate']>;
      const stack = new Error().stack || '';
      const session =
        this.sourceSQL.includes('consumed_source_files') &&
        stack.includes('assertPhysicalEvidenceCurrent');
      const union =
        this.sourceSQL === 'SELECT id,path,identity,signature FROM artifacts ORDER BY id' &&
        /at Object\.assertCurrent .*clinical-review-artifact-proof/.test(stack);
      if (session) counts.sessionSync++;
      if (union) counts.unionSync++;
      return (function* () {
        for (const row of rows) {
          if (session || union) counts.syncIdentities++;
          yield row;
        }
      })();
    },
  );
  return counts;
}

for (const count of [1, 2])
  test(`public ${count}-block acceptance closes the original union without repeated session sweeps`, async (t) => {
    const f = await fixture(t, count),
      blocks = [];
    for (const { source, proposalId } of f.sources) {
      const result = await prepareCollectionClinicalReviewAsync(
        f.db,
        f.root,
        f.profileId,
        source.id,
        proposalId,
      );
      if (result.status !== 'ready') throw Error('Expected fictional review');
      const review = result.session.review;
      blocks.push({
        intakeId: source.id,
        proposalId,
        intakeVersion: review.version,
        reviewToken: review.reviewToken,
        selections: review.records.map((record) => ({
          recordId: record.id,
          candidateId: record.candidateId!,
          candidateVersionId: record.candidateVersionId!,
          mapping: record.mapping,
        })),
      });
      result.session.close();
    }
    const counts = countPhysicalPasses(t);
    const result = await acceptIntakeReportSelectionAsync(f.db, f.root, f.profileId, {
      operationId: randomUUID(),
      blocks,
    });
    t.diagnostic(JSON.stringify(counts));
    assert.equal(result.receipt.acceptedCount, count);
    assert.equal(counts.sessionWorker, count);
    assert.equal(counts.sessionSync, 0);
    assert.equal(counts.unionWorker, 2);
    assert.equal(counts.workerIdentities, count * 6);
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  });

test('acceptance handoffs are opaque, owner/session bound and one-use at every stage', async (t) => {
  const f = await fixture(t),
    counts = countPhysicalPasses(t);
  assert.throws(
    () =>
      consumeCollectionClinicalAcceptanceReview(
        {} as CollectionClinicalAcceptancePreparation,
        f.db,
        f.profileId,
      ),
    /unavailable/,
  );
  const preparation = await pending(f);
  assert.equal('session' in preparation, false);
  const selected = consumeCollectionClinicalAcceptanceReview(preparation, f.db, f.profileId);
  try {
    assert.throws(
      () => consumeCollectionClinicalAcceptanceReview(preparation, f.db, f.profileId),
      /unavailable/,
    );
    const group = consumeCollectionClinicalAcceptanceGroup(
      selected.handoff,
      selected.session,
      f.db,
      f.profileId,
    );
    assert.throws(
      () =>
        consumeCollectionClinicalAcceptanceGroup(
          selected.handoff,
          selected.session,
          f.db,
          f.profileId,
        ),
      /unavailable/,
    );
    assert.equal(
      consumeCollectionClinicalAcceptanceProjection(
        group.handoff,
        selected.session,
        f.db,
        f.profileId,
      ),
      selected.context,
    );
    assert.throws(
      () =>
        consumeCollectionClinicalAcceptanceProjection(
          group.handoff,
          selected.session,
          f.db,
          f.profileId,
        ),
      /unavailable/,
    );
    assert.equal(
      counts.sessionWorker + counts.sessionSync + counts.unionWorker + counts.unionSync,
      0,
    );
  } finally {
    selected.session.close();
  }
  const foreign = await pending(f);
  assert.throws(
    () => consumeCollectionClinicalAcceptanceReview(foreign, f.db, 'fictional-foreign'),
    /Foreign/,
  );
  assert.throws(
    () => consumeCollectionClinicalAcceptanceReview(foreign, f.db, f.profileId),
    /unavailable/,
  );
  const wrongSession = await pending(f),
    other = await pending(f);
  const first = consumeCollectionClinicalAcceptanceReview(wrongSession, f.db, f.profileId),
    second = consumeCollectionClinicalAcceptanceReview(other, f.db, f.profileId);
  assert.throws(
    () =>
      consumeCollectionClinicalAcceptanceGroup(first.handoff, second.session, f.db, f.profileId),
    /Foreign/,
  );
  second.session.close();
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

for (const fault of ['cancel', 'accepted', 'closed', 'policy', 'source-sql'] as const)
  test(`deferred acceptance preserves original ${fault} refusal`, async (t) => {
    const f = await fixture(t);
    let refuse = false;
    const controller = new AbortController();
    const preparation = await pending(f, {
      signal: controller.signal,
      assertRunning() {
        if (fault === 'accepted' && refuse)
          transaction(f.db, () =>
            appendOwnershipDecision(f.db, 'fictional-later', 'Fictional later ownership', {
              fictional: true,
            }),
          );
        if (fault === 'source-sql' && refuse) {
          const id = f.sources[0]!.source.id;
          f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), id);
          f.db
            .prepare('UPDATE source_files SET sha256=? WHERE id=?')
            .run(f.sources[0]!.source.sha256, id);
        }
      },
    });
    if (fault === 'cancel') controller.abort(Error('Fictional cancelled'));
    if (fault === 'accepted' || fault === 'source-sql') refuse = true;
    if (fault === 'closed') disposeCollectionClinicalAcceptanceReview(preparation);
    if (fault === 'policy') f.db.setAuthorizer(() => 0);
    assert.throws(() => consumeCollectionClinicalAcceptanceReview(preparation, f.db, f.profileId));
    disposeCollectionClinicalAcceptanceReview(preparation);
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  });

for (const stage of ['consume', 'inspect'] as const)
  test(`final projection ${stage} refuses retained callback cancellation and closes the handoff`, async (t) => {
    const f = await fixture(t),
      controller = new AbortController(),
      reason = Error('Fictional final projection cancellation');
    let armed = false,
      abortCalls = 0;
    const preparation = await pending(f, {
      signal: controller.signal,
      assertRunning() {
        if (!armed) return;
        armed = false;
        abortCalls++;
        controller.abort(reason);
      },
    });
    const selected = consumeCollectionClinicalAcceptanceReview(preparation, f.db, f.profileId),
      group = consumeCollectionClinicalAcceptanceGroup(
        selected.handoff,
        selected.session,
        f.db,
        f.profileId,
      );
    const head = f.db.prepare('SELECT head_json FROM __record_state WHERE singleton=1').get(),
      records = f.db.prepare('SELECT count(*) AS n FROM documents').get(),
      counts = countPhysicalPasses(t);
    assert.equal(controller.signal.aborted, false, 'earlier legitimate handoff stages succeeded');
    armed = true;
    assert.throws(
      () =>
        (stage === 'consume'
          ? consumeCollectionClinicalAcceptanceProjection
          : inspectCollectionClinicalAcceptanceProjection)(
          group.handoff,
          selected.session,
          f.db,
          f.profileId,
        ),
      (error) => error === reason,
    );
    assert.equal(abortCalls, 1, 'the final retained callback really aborts and returns');
    assert.throws(
      () => selected.context.assertAuthorityCurrent(),
      /Closed clinical review session/,
    );
    assert.throws(
      () =>
        consumeCollectionClinicalAcceptanceProjection(
          group.handoff,
          selected.session,
          f.db,
          f.profileId,
        ),
      /unavailable/,
    );
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
    assert.deepEqual(
      f.db.prepare('SELECT head_json FROM __record_state WHERE singleton=1').get(),
      head,
    );
    assert.deepEqual(f.db.prepare('SELECT count(*) AS n FROM documents').get(), records);
    assert.equal(
      counts.sessionWorker + counts.sessionSync + counts.unionWorker + counts.unionSync,
      0,
      'cancellation cannot renew or replace the original physical proof',
    );
  });
