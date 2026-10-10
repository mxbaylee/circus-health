import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatementSync } from 'node:sqlite';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { createNote } from '../notes.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
  prepareCollectionClinicalReviewForOwnershipAsync,
} from '../intake-review-collection-host.ts';
import {
  collectionClinicalProjectionContextAsync,
  consumeCollectionClinicalOwnershipReview,
  disposeCollectionClinicalOwnershipReview,
  type CollectionClinicalOwnershipPreparation,
} from '../intake-review-collection-session.ts';
import { prepareOwnershipReportPlan } from '../ownership-report-plan.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import type { OwnershipRequest } from '../../shared/record-ownership.ts';

async function fixture(t: test.TestContext, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-ownership-handoff-')),
    profileId = 'fictional-ownership-handoff',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = createNote(db, {
    kind: 'person',
    title: 'Fictional Robin',
    person: { fullName: 'Fictional Robin' },
  });
  const sources = [];
  for (let index = 0; index < count; index++) {
    const text = JSON.stringify({
      format: 'health-record-v1',
      id: `fictional-${index}`,
      kind: 'record',
      payload: { literal: `Fictional evidence ${index}` },
      clinical: {
        kind: 'observation',
        subject: 'self',
        date: '2026-01-12',
        testLabel: `Fictional measure ${index}`,
        valueText: String(index + 1),
        unit: 'cm',
      },
      provenance: {
        sourceSystem: 'Fictional Clinic',
        sourceRecordId: `fictional-${index}`,
        capturedVia: null,
        evidenceClass: 'provider_export',
        locator: `Fictional row ${index}`,
      },
      coverage: { status: 'complete_response', notes: [] },
    });
    const source = uploadIntake(db, root, profileId, {
      filename: `fictional-${index}.jsonl`,
      bytes: Buffer.from(text),
      newProviderName: 'Fictional Clinic',
    });
    const review = reviewIntake(db, root, profileId, source.id);
    importIntake(db, root, profileId, source.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    });
    sources.push(source);
  }
  for (const source of sources) await buildIntakeCollectionEnvelope(db, { id: source.id });
  for (const source of sources)
    await prepareCollectionClinicalReviewDependencies(db, root, profileId, source.id, null);
  await prepareIntakeLookupIndices(db);
  const request: OwnershipRequest = {
    selection: {
      type: 'records',
      records: db
        .prepare('SELECT id FROM observations ORDER BY id')
        .all()
        .map((row) => ({
          kind: 'observation',
          recordId: String(row.id),
        })),
    },
    destination: { noteId: person.id, expectedVersion: person.version },
  };
  return { root, profileId, db, sources, request };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, controls = {}) {
  const result = await prepareCollectionClinicalReviewForOwnershipAsync(
    f.db,
    f.root,
    f.profileId,
    f.sources[0]!.id,
    null,
    controls,
  );
  if (result.status !== 'prepared') throw Error('Expected fictional ownership preparation');
  return result.preparation;
}
function countPhysicalPasses(t: test.TestContext) {
  const all = StatementSync.prototype.all,
    counts = { sessionWorker: 0, unionWorker: 0, sessionIdentities: 0, unionIdentities: 0 };
  t.mock.method(StatementSync.prototype, 'all', function (this: StatementSync, ...args: unknown[]) {
    const rows = Reflect.apply(all, this, args);
    if (
      /^SELECT id,path,identity,(seal|signature) FROM (main\.consumed_source_files|clinical_artifacts) .*LIMIT 64$/.test(
        this.sourceSQL,
      )
    ) {
      const session = this.sourceSQL.includes('consumed_source_files');
      if (!this.sourceSQL.includes('WHERE id>')) {
        if (session) counts.sessionWorker++;
        else counts.unionWorker++;
      }
      if (session) counts.sessionIdentities += rows.length;
      else counts.unionIdentities += rows.length;
    }
    return rows;
  });
  return counts;
}

for (const count of [1, 3])
  test(`genuine ${count}-original ownership handoff replaces only the duplicate session closure`, async (t) => {
    const f = await fixture(t, count),
      counts = countPhysicalPasses(t);
    for (const source of f.sources) {
      const ready = await prepareCollectionClinicalReviewAsync(
        f.db,
        f.root,
        f.profileId,
        source.id,
        null,
      );
      if (ready.status !== 'ready') throw Error('Expected fictional review');
      try {
        await collectionClinicalProjectionContextAsync(ready.session);
      } finally {
        ready.session.close();
      }
    }
    const paired = structuredClone(counts);
    assert.equal(
      paired.sessionWorker,
      count * 2,
      'the previous paired API performs two actual workers',
    );
    counts.sessionWorker =
      counts.sessionIdentities =
      counts.unionWorker =
      counts.unionIdentities =
        0;
    for (const source of f.sources) {
      const result = await prepareCollectionClinicalReviewForOwnershipAsync(
        f.db,
        f.root,
        f.profileId,
        source.id,
        null,
      );
      if (result.status !== 'prepared') throw Error('Expected fictional ownership preparation');
      const selected = consumeCollectionClinicalOwnershipReview(
        result.preparation,
        f.db,
        f.profileId,
      );
      selected.session.close();
    }
    const forwarded = structuredClone(counts);
    assert.equal(forwarded.sessionWorker, count);
    assert.equal(paired.sessionIdentities, forwarded.sessionIdentities * 2);
    t.diagnostic(JSON.stringify({ count, paired, forwarded }));
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  });

for (const count of [1, 3])
  test(`genuine ${count}-original report preserves union and post-return physical closures`, async (t) => {
    const f = await fixture(t, count),
      counts = countPhysicalPasses(t);
    const head = readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head'));
    const plan = await prepareOwnershipReportPlan(f.db, f.root, f.profileId, f.request);
    try {
      const construction = structuredClone(counts);
      assert.equal(
        construction.sessionWorker,
        count === 1 ? 1 : count * 2,
        'each initial source open uses one worker; the one-slot session revisits multiple sources for holds',
      );
      assert.equal(
        construction.unionWorker,
        1,
        'the full original union closes before returning the preview',
      );
      assert.equal(
        construction.unionIdentities,
        count,
        'that closure verifies every original exactly once',
      );
      assert.deepEqual(
        readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head')),
        head,
      );
      assert.equal(plan.page('records').items.length, count);
      counts.sessionWorker =
        counts.sessionIdentities =
        counts.unionWorker =
        counts.unionIdentities =
          0;
      await plan.prepareSourceSnapshots();
      assert.equal(
        counts.sessionWorker % 2,
        0,
        'post-return session opens retain the original paired verification',
      );
      if (count === 3)
        assert.ok(counts.sessionWorker > 0, 'multiple post-return sources really reopen sessions');
      t.diagnostic(JSON.stringify({ count, construction, postReturn: counts }));
    } finally {
      plan.close();
    }
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  });

test('ownership preparation is opaque, DB/profile bound, disposed and one-use', async (t) => {
  const f = await fixture(t),
    counts = countPhysicalPasses(t);
  assert.throws(
    () =>
      consumeCollectionClinicalOwnershipReview(
        {} as CollectionClinicalOwnershipPreparation,
        f.db,
        f.profileId,
      ),
    /unavailable/,
  );
  const preparation = await pending(f);
  assert.equal('session' in preparation, false);
  const selected = consumeCollectionClinicalOwnershipReview(preparation, f.db, f.profileId);
  assert.throws(
    () => consumeCollectionClinicalOwnershipReview(preparation, f.db, f.profileId),
    /unavailable/,
  );
  selected.session.close();
  const foreign = await pending(f);
  assert.throws(
    () => consumeCollectionClinicalOwnershipReview(foreign, f.db, 'fictional-foreign'),
    /Foreign/,
  );
  assert.throws(
    () => consumeCollectionClinicalOwnershipReview(foreign, f.db, f.profileId),
    /unavailable/,
  );
  const otherDb = openDatabase(join(f.root, 'other.sqlite'), f.profileId);
  try {
    const foreignDb = await pending(f);
    assert.throws(
      () => consumeCollectionClinicalOwnershipReview(foreignDb, otherDb, f.profileId),
      /Foreign/,
    );
  } finally {
    otherDb.close();
  }
  const disposed = await pending(f);
  disposeCollectionClinicalOwnershipReview(disposed);
  disposeCollectionClinicalOwnershipReview(disposed);
  assert.throws(
    () => consumeCollectionClinicalOwnershipReview(disposed, f.db, f.profileId),
    /unavailable/,
  );
  assert.equal(counts.sessionWorker, 4);
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});

for (const fault of [
  'signal',
  'callback-abort',
  'callback-refusal',
  'method',
  'ordinary-sql',
  'source-aba',
  'logical',
] as const)
  test(`ownership handoff retains original ${fault} refusal without another physical pass`, async (t) => {
    const f = await fixture(t),
      controller = new AbortController(),
      reason = Error('Fictional ownership preparation refused');
    let armed = false;
    const preparation = await pending(f, {
      signal: controller.signal,
      assertRunning() {
        if (!armed) return;
        if (fault === 'callback-abort') controller.abort(reason);
        if (fault === 'callback-refusal') throw reason;
      },
    });
    if (fault === 'signal') controller.abort(reason);
    if (fault === 'callback-abort' || fault === 'callback-refusal') armed = true;
    if (fault === 'method') f.db.setAuthorizer(() => 0);
    if (fault === 'ordinary-sql') f.db.prepare('UPDATE notes SET title=title').run();
    if (fault === 'source-aba') {
      const id = f.sources[0]!.id,
        original = f.db.prepare('SELECT sha256 FROM source_files WHERE id=?').get(id)!.sha256;
      f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), id);
      f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run(original, id);
    }
    if (fault === 'logical')
      f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{}', f.sources[0]!.id);
    const counts = countPhysicalPasses(t),
      head = readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head'));
    const consume = () => consumeCollectionClinicalOwnershipReview(preparation, f.db, f.profileId);
    if (fault === 'signal' || fault.startsWith('callback'))
      assert.throws(consume, (error) => error === reason);
    else assert.throws(consume);
    assert.throws(
      () => consumeCollectionClinicalOwnershipReview(preparation, f.db, f.profileId),
      /unavailable/,
    );
    disposeCollectionClinicalOwnershipReview(preparation);
    assert.deepEqual(
      readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head')),
      head,
    );
    assert.equal(counts.sessionWorker + counts.unionWorker, 0);
    assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
  });

test('late report callback SQL changes still refuse before the original union can escape', async (t) => {
  const f = await fixture(t),
    head = readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head'));
  let reached = false;
  await assert.rejects(
    prepareOwnershipReportPlan(f.db, f.root, f.profileId, f.request, {
      onCheckpoint(stage) {
        if (stage !== 'records-complete') return;
        reached = true;
        f.db
          .prepare('UPDATE source_files SET sha256=? WHERE id=?')
          .run('0'.repeat(64), f.sources[0]!.id);
      },
    }),
  );
  assert.equal(reached, true);
  assert.deepEqual(readFileSync(join(contributorAuthorityPath(f.root, f.profileId), 'head')), head);
  assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
});
