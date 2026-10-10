import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { openDatabase, revision, transaction } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareCollectionReviewMembership } from '../intake-review-membership-index.ts';
import { prepareClinicalSourceFingerprintIndex } from '../intake-clinical-source-index.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import {
  prepareCollectionClinicalReview,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import {
  prepareCollectionClinicalProjection,
  prepareCollectionClinicalProjectionWithEvidence,
  withVerifiedClinicalProjectionPublication,
  preparedClinicalProjectionResult,
  preparedClinicalProjectionMatchingRows,
  applyPreparedClinicalProjection,
  disposePreparedClinicalProjection,
  prepareCollectionClinicalProjectionGroup,
  preparedClinicalProjectionGroupResults,
  applyPreparedClinicalProjectionGroup,
  preparedClinicalProjectionMember,
  assertPreparedClinicalProjectionMember,
  prepareCollectionClinicalTerminalPairProjectionWithEvidence,
} from '../intake-clinical-projection-plan.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { prepareIntakeLookupIndices } from '../intake-lookup-state.ts';
import { collectionClinicalProjectionContext } from '../intake-review-collection-session.ts';
async function fixture(t: test.TestContext, clinical = true, scoped = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-clinical-plan-')),
    profileId = 'fictional-profile';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const cleanup: (() => void)[] = [];
  t.after(() => {
    for (const close of cleanup.reverse()) close();
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'one',
        kind: 'document',
        payload: {
          text: 'Fictional note' + (scoped ? '\nFictional Patient\nFictional report' : ''),
        },
        ...(scoped
          ? {
              report: {
                key: 'fictional-report',
                title: 'Fictional report',
                anchor: { locator: 'page 1', text: 'Fictional report' },
                subject: { locator: 'page 1', text: 'Fictional Patient' },
              },
            }
          : {}),
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'one',
          evidenceClass: 'provider_export',
          locator: 'page 1',
        },
        coverage: { status: 'complete_response', notes: [] },
        ...(clinical
          ? {
              clinical: {
                kind: 'document',
                subject: 'self',
                documentTitle: 'Fictional note',
                ...(scoped ? { text: 'Fictional note' } : {}),
                date: '2026-01-01',
              },
            }
          : {}),
      }),
    ),
  });
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  await prepareClinicalSourceFingerprintIndex(db);
  const result = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('Expected complete review');
  const decisions = result.session.review.records.map((record) => ({
    recordId: record.id,
    action: 'accept' as const,
    mapping: record.mapping,
  }));
  return { db, root, profileId, session: result.session, decisions, cleanup, intake };
}
test('clinical projection preparation restores all SQL changes; ordinary apply publishes exact result once', async (t) => {
  const { db, root, profileId, session, decisions, cleanup } = await fixture(t);
  db.exec(
    'CREATE TEMP TABLE projection_writes(value INTEGER); CREATE TEMP TRIGGER projection_observed AFTER INSERT ON main.documents BEGIN INSERT INTO projection_writes VALUES(1); END;',
  );
  const capture = db.createSession(),
    before = revision(db),
    work = intakeWorkCounters(db);
  cleanup.push(() => capture.close());
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.equal(capture.changeset().length, 0);
  assert.equal(revision(db), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM projection_writes').get()!.n, 0);
  const expected = preparedClinicalProjectionResult(plan)!;
  assert.equal(expected.added, 1);
  assert.equal(expected.newMedications, 0);
  assert.equal(preparedClinicalProjectionMatchingRows(plan), 0);
  const result = transaction(db, () => applyPreparedClinicalProjection(db, plan));
  assert.deepEqual(result, expected);
  assert.equal(db.prepare('SELECT count(*) AS n FROM projection_writes').get()!.n, 1);
  assert.equal(revision(db), before + 1);
  assert.ok(capture.changeset().length > 0);
  assert.equal(intakeWorkCounters(db).warm.materializationReads, work.warm.materializationReads);
  assert.throws(() => transaction(db, () => applyPreparedClinicalProjection(db, plan)), /Refresh/);
});

test('cooperative projection verifies original proof after staging and publishes the exact result', async (t) => {
  const { db, root, profileId, session, decisions, cleanup } = await fixture(t);
  const before = revision(db);
  const plan = await prepareCollectionClinicalProjectionWithEvidence(
    db,
    root,
    profileId,
    session,
    decisions,
  );
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.equal(revision(db), before);
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
  const expected = preparedClinicalProjectionResult(plan);
  const actual = await withVerifiedClinicalProjectionPublication(db, plan, () =>
    transaction(db, () => applyPreparedClinicalProjection(db, plan)),
  );
  assert.deepEqual(actual, expected);
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 1);
});

for (const mutation of ['original', 'method'] as const)
  test(`cooperative projection refuses ${mutation} changes during its post-staging proof`, async (t) => {
    const { db, root, profileId, session, decisions, intake } = await fixture(t);
    const path = profileOriginal(
      root,
      String(db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path),
      profileId,
    );
    const before = revision(db);
    const changes = () => Number(db.prepare('SELECT total_changes() n').get()!.n);
    const originalChanges = changes();
    const postMessage = Worker.prototype.postMessage;
    let injected = false;
    Worker.prototype.postMessage = function (value, transferList) {
      const message = value as { type?: string; items?: { path?: string }[] };
      if (
        !injected &&
        message.type === 'page' &&
        changes() > originalChanges &&
        message.items?.some((item) => item.path === path)
      ) {
        injected = true;
        assert.equal(
          db.prepare('SELECT count(*) n FROM documents').get()!.n,
          0,
          'Speculative rows already rolled back',
        );
        if (mutation === 'original') writeFileSync(path, readFileSync(path));
        else db.function('fictional_projection_gap', () => 1);
      }
      return postMessage.call(this, value, transferList);
    };
    t.after(() => {
      Worker.prototype.postMessage = postMessage;
    });
    await assert.rejects(
      prepareCollectionClinicalProjectionWithEvidence(db, root, profileId, session, decisions),
      /Retained (?:clinical|physical) evidence changed|Refresh this selected clinical review/,
    );
    assert.equal(injected, true, 'Mutation hit the actual post-staging worker page');
    assert.equal(revision(db), before);
    assert.equal(db.prepare('SELECT count(*) n FROM documents').get()!.n, 0);
  });

test('failed projection preparation and failed publication both leave no partial projection', async (t) => {
  const { db, root, profileId, session, decisions, cleanup } = await fixture(t);
  const capture = db.createSession();
  cleanup.push(() => capture.close());
  assert.throws(
    () =>
      prepareCollectionClinicalProjection(db, root, profileId, session, [
        ...decisions,
        ...decisions,
      ]),
    /Unknown or repeated/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(capture.changeset().length, 0);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.throws(
    () =>
      transaction(db, () => {
        applyPreparedClinicalProjection(db, plan);
        throw Error('Fictional publication failure');
      }),
    /Fictional publication/,
  );
  assert.equal(capture.changeset().length, 0);
  assert.equal(transaction(db, () => applyPreparedClinicalProjection(db, plan))!.added, 1);
});
test('projection read dependencies refuse changes even without a revision bump', async (t) => {
  const { db, root, profileId, session, decisions, cleanup } = await fixture(t);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare(
          "INSERT INTO providers(id,name) VALUES('fictional-later','Fictional later')",
        ).run();
        return applyPreparedClinicalProjection(db, plan);
      }),
    /Refresh/,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM documents WHERE id LIKE 'import:%'").get()!.n,
    0,
  );
});

test('projection copied group proof survives review cleanup and refuses replaced later evidence', async (t) => {
  const { db, root, profileId, cleanup, intake } = await fixture(t, true, true);
  await prepareIntakeLookupIndices(db);
  const originalPath = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path),
    profileId,
  );
  const source = JSON.parse(readFileSync(originalPath, 'utf8'));
  source.payload.extra = 'Fictional later group member';
  const second = uploadIntake(db, root, profileId, {
    filename: 'later.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(source)),
  });
  await buildIntakeCollectionEnvelope(db, { id: second.id, sha256: second.sha256 });
  await prepareCollectionReviewMembership(db, { id: second.id });
  const members = [intake.id, second.id].map((id) => {
    const selected = prepareCollectionClinicalReview(db, root, profileId, id);
    if (selected.status !== 'ready') throw Error('Expected complete review');
    return {
      session: selected.session,
      decisions: selected.session.review.records.map((record) => ({
        recordId: record.id,
        action: 'accept' as const,
        mapping: record.mapping,
      })),
    };
  });
  const laterContext = collectionClinicalProjectionContext(members[1]!.session);
  const consumed = laterContext.consumedArtifactIds.bind(laterContext);
  laterContext.consumedArtifactIds = function* () {
    yield* consumed();
    yield 'fictional-unprepared-group-dependency';
  };
  assert.throws(() => prepareCollectionClinicalProjectionGroup(db, root, profileId, members), {
    code: 'SOURCE_CHANGED',
  });
  laterContext.consumedArtifactIds = consumed;
  const contexts = members.map((member) => collectionClinicalProjectionContext(member.session));
  const checkpoints = contexts.map((context) => context.beginProjectionConsumption.bind(context));
  const restored: number[] = [];
  for (const [index, context] of contexts.entries())
    context.beginProjectionConsumption = () => {
      const restore = checkpoints[index]!();
      return () => {
        restore();
        restored.push(index);
        if (index === 1) throw Error('Fictional consumed source cleanup failure');
      };
    };
  assert.throws(
    () => prepareCollectionClinicalProjectionGroup(db, root, profileId, members),
    /Fictional consumed source cleanup failure/,
  );
  assert.deepEqual(restored, [1, 0], 'all borrowed contexts restore even when one cleanup fails');
  for (const [index, context] of contexts.entries())
    context.beginProjectionConsumption = checkpoints[index]!;
  const plan = prepareCollectionClinicalProjectionGroup(db, root, profileId, members);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  const repeated = prepareCollectionClinicalProjectionGroup(db, root, profileId, members);
  cleanup.push(() => disposePreparedClinicalProjection(repeated));
  assert.deepEqual(
    preparedClinicalProjectionGroupResults(repeated),
    preparedClinicalProjectionGroupResults(plan),
  );
  assert.throws(
    () =>
      transaction(db, () => {
        applyPreparedClinicalProjectionGroup(db, plan);
        throw Error('Fictional coupled publication rollback');
      }),
    /Fictional coupled publication rollback/,
  );
  clearIntakeStateCache(db);
  assert.equal(preparedClinicalProjectionGroupResults(plan)[0]!.clinical!.added, 1);
  assert.equal(preparedClinicalProjectionGroupResults(plan)[1]!.clinical!.duplicates, 1);
  const path = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(second.id)!.path),
    profileId,
  );
  const original = readFileSync(path);
  writeFileSync(path, Buffer.from(original.toString().replace('Fictional note', 'Different note')));
  assert.throws(() => transaction(db, () => applyPreparedClinicalProjectionGroup(db, plan)), {
    code: 'SOURCE_CHANGED',
  });
  assert.equal(db.prepare("SELECT count(*) n FROM documents WHERE id LIKE 'import:%'").get()!.n, 0);
});

test('projection copied proof does not outlive explicit session close or plan disposal', async (t) => {
  const { db, root, profileId, session, decisions, cleanup } = await fixture(t);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  session.close();
  assert.throws(() => preparedClinicalProjectionResult(plan), /Closed clinical review session/);
  disposePreparedClinicalProjection(plan);
  assert.throws(() => preparedClinicalProjectionResult(plan), /disposed clinical projection plan/);
  assert.doesNotThrow(() => disposePreparedClinicalProjection(plan));
});

test('projection rejects a consumed source absent from the original verified proof', async (t) => {
  const { db, root, profileId, session, decisions } = await fixture(t);
  const context = collectionClinicalProjectionContext(session);
  const consumed = context.consumedArtifactIds.bind(context);
  // A late policy dependency cannot be authorized by merely naming a retained source.
  context.consumedArtifactIds = function* () {
    yield* consumed();
    yield 'fictional-unprepared-source';
  };
  const capture = db.createSession();
  try {
    assert.throws(
      () => prepareCollectionClinicalProjection(db, root, profileId, session, decisions),
      { code: 'SOURCE_CHANGED' },
    );
    assert.equal(db.isTransaction, false);
    assert.equal(capture.changeset().length, 0);
  } finally {
    capture.close();
  }
});

test('projection survives certified auxiliary maintenance but refuses actor imitation', async (t) => {
  const { db, root, profileId, session, decisions, cleanup, intake } = await fixture(t);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  const { collections } = selectedEnvelopeStore(db, { id: intake.id, sha256: intake.sha256 });
  const operationId = randomUUID();
  const prepared = collections.prepare(collections.openView(), {
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: intake.version,
    changes: [
      {
        area: 'builds',
        collection: 'fictional-clinical-checkpoint',
        op: 'put',
        key: 'one',
        value: 'retained',
      },
    ],
  });
  collections.commitMaintenance(prepared);
  assert.equal(preparedClinicalProjectionResult(plan)!.added, 1);
  assert.equal(transaction(db, () => applyPreparedClinicalProjection(db, plan))!.added, 1);

  const next = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  if (next.status !== 'ready') throw Error('Expected complete review');
  const stale = prepareCollectionClinicalProjection(db, root, profileId, next.session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(stale));
  transaction(db, () => {}, { actor: 'intake-maintenance' });
  assert.throws(() => preparedClinicalProjectionResult(stale), /Refresh/);
});

test('source-only retention produces no clinical receipt and refuses clinical entries', async (t) => {
  const { db, root, profileId, session, cleanup } = await fixture(t, false);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, [], {
    reviewed: false,
  });
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.equal(preparedClinicalProjectionResult(plan), undefined);
  assert.equal(
    transaction(db, () => applyPreparedClinicalProjection(db, plan)),
    undefined,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM source_records WHERE kind LIKE 'intake_%'").get()!.n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM documents WHERE id LIKE 'import:%'").get()!.n,
    0,
  );
  const clinical = await fixture(t);
  assert.throws(
    () =>
      prepareCollectionClinicalProjection(
        clinical.db,
        clinical.root,
        clinical.profileId,
        clinical.session,
        [],
        { reviewed: false },
      ),
    /Review clinical/,
  );
});

test('projection rechecks retained original identity before final application', async (t) => {
  const { db, root, profileId, session, decisions, cleanup, intake } = await fixture(t);
  const plan = prepareCollectionClinicalProjection(db, root, profileId, session, decisions);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  const path = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path),
    profileId,
  );
  const bytes = readFileSync(path);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(path, bytes);
  assert.throws(
    () => transaction(db, () => applyPreparedClinicalProjection(db, plan)),
    /no longer matches|changed/,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM documents WHERE id LIKE 'import:%'").get()!.n,
    0,
  );
});

test('terminal pair projection retains only the exact selected proposal entry', async (t) => {
  const f = await fixture(t),
    { db, root, profileId, cleanup } = f;
  const accepted = prepareCollectionClinicalProjection(db, root, profileId, f.session, f.decisions);
  cleanup.push(() => disposePreparedClinicalProjection(accepted));
  transaction(db, () => applyPreparedClinicalProjection(db, accepted));
  await prepareIntakeLookupIndices(db);
  const sourcePath = profileOriginal(
      root,
      String(db.prepare('SELECT path FROM source_files WHERE id=?').get(f.intake.id)!.path),
      profileId,
    ),
    original = JSON.parse(readFileSync(sourcePath, 'utf8')),
    incoming = {
      ...original,
      id: 'incoming',
      provenance: { ...original.provenance, sourceRecordId: 'incoming' },
      payload: { text: 'Another fictional note' },
    },
    unrelated = {
      ...original,
      id: 'unrelated',
      provenance: { ...original.provenance, sourceRecordId: 'unrelated' },
      clinical: { ...original.clinical, documentTitle: 'Unrelated fictional note' },
    };
  const intake = uploadIntake(db, root, profileId, {
    filename: 'terminal.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from([incoming, unrelated].map((value) => JSON.stringify(value)).join('\n')),
  });
  await buildIntakeCollectionEnvelope(db, { id: intake.id, sha256: intake.sha256 });
  await prepareCollectionReviewMembership(db, { id: intake.id });
  await prepareCollectionClinicalReviewDependencies(db, root, profileId, intake.id);
  const selected = prepareCollectionClinicalReview(db, root, profileId, intake.id);
  if (selected.status !== 'ready') throw Error('Expected complete selected review');
  const record = selected.session.review.records[0]!,
    comparison = record.comparisons?.[0];
  assert.ok(comparison?.scope);
  const plan = await prepareCollectionClinicalTerminalPairProjectionWithEvidence(
    db,
    root,
    profileId,
    selected.session,
    {
      recordId: record.id,
      action: 'skip',
      mapping: record.mapping,
      comparisons: [
        {
          otherRecordId: comparison.id,
          scope: comparison.scope,
          outcome: 'distinct',
          reason: 'The fictional originals identify separate events.',
        },
      ],
    },
  );
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.equal(
    db.prepare('SELECT count(*) n FROM source_records WHERE source_file_id=?').get(intake.id)!.n,
    0,
  );
  const result = transaction(db, () => applyPreparedClinicalProjection(db, plan));
  assert.equal(result?.added, 0);
  assert.equal(
    db.prepare('SELECT count(*) n FROM source_records WHERE source_file_id=?').get(intake.id)!.n,
    1,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM documents WHERE id LIKE 'import:%'").get()!.n, 1);
  assert.equal(
    db.prepare('SELECT 1 FROM source_records WHERE id=?').get(intake.id + ':line:2'),
    undefined,
  );
});

test('coupled projection uses prior block writes and binds each receipt to its applied member', async (t) => {
  const f = await fixture(t, true, true),
    { db, root, profileId, cleanup, intake } = f;
  await prepareIntakeLookupIndices(db);
  const originalPath = profileOriginal(
    root,
    String(db.prepare('SELECT path FROM source_files WHERE id=?').get(intake.id)!.path),
    profileId,
  );
  const original = JSON.parse(readFileSync(originalPath, 'utf8'));
  original.payload.extra = 'Fictional second delivery';
  const second = uploadIntake(db, root, profileId, {
    filename: 'second.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(JSON.stringify(original)),
  });
  await buildIntakeCollectionEnvelope(db, { id: second.id, sha256: second.sha256 });
  await prepareCollectionReviewMembership(db, { id: second.id });
  const members = [intake.id, second.id].map((id) => {
    const selected = prepareCollectionClinicalReview(db, root, profileId, id);
    if (selected.status !== 'ready') throw Error('Expected complete review');
    return {
      session: selected.session,
      decisions: selected.session.review.records.map((record) => ({
        recordId: record.id,
        action: 'accept' as const,
        mapping: record.mapping,
      })),
    };
  });
  const capture = db.createSession();
  cleanup.push(() => capture.close());
  const plan = prepareCollectionClinicalProjectionGroup(db, root, profileId, members);
  cleanup.push(() => disposePreparedClinicalProjection(plan));
  assert.equal(capture.changeset().length, 0);
  const results = preparedClinicalProjectionGroupResults(plan);
  assert.equal(results[0]!.clinical!.added, 1);
  assert.equal(results[1]!.clinical!.duplicates, 1);
  assert.deepEqual(preparedClinicalProjectionMember(db, plan, 1, members[1]!.session), results[1]);
  assert.throws(
    () => preparedClinicalProjectionMember(db, plan, 0, members[1]!.session),
    /Foreign/,
  );
  assert.throws(
    () => assertPreparedClinicalProjectionMember(db, plan, 0, members[0]!.session),
    /not been applied/,
  );
  transaction(db, () => {
    assert.deepEqual(
      applyPreparedClinicalProjectionGroup(db, plan),
      results.map((result) => result.clinical),
    );
    for (let index = 0; index < members.length; index++)
      assertPreparedClinicalProjectionMember(db, plan, index, members[index]!.session);
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM documents WHERE id LIKE 'import:%'").get()!.n,
    1,
  );
  assert.throws(
    () =>
      transaction(db, () =>
        assertPreparedClinicalProjectionMember(db, plan, 0, members[0]!.session),
      ),
    /not been applied/,
  );
});
