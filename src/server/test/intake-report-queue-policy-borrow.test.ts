import test from 'node:test';
import assert from 'node:assert/strict';
import nodeFs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachRecordDurability } from '../record-versions.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { uploadIntake, ensureNativeIntakeSchema } from '../intake.ts';
import {
  prepareCollectionClinicalReviewAsync,
  prepareCollectionClinicalReviewDependencies,
} from '../intake-review-collection-host.ts';
import { prepareCollectionPeopleIndex } from '../intake-people-collection.ts';
import {
  clearCollectionReportQueues,
  clearCollectionQueueReviews,
  checkedRetainedCollectionClinicalPolicyContext,
  openCollectionReportQueue,
  tryBorrowRetainedCollectionClinicalPolicy,
} from '../intake-report-group-collection.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { reviewReadStamp } from '../intake-clinical-review-read-cache.ts';
import { reviewIssueScratchCounts } from '../intake-review-issue-state.ts';
import { canonicalReviewValueChunks } from '../intake-review-question-state.ts';
import {
  execClinicalReviewMaintenance,
  runClinicalReviewMaintenance,
} from '../clinical-review-maintenance.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-queue-policy-borrow-')),
    profileId = 'fictional-queue-policy-borrow',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  attachRecordDurability(db, { profileId, storage });
  let writes = 0,
    publications = 0;
  const write = storage.writeImmutable.bind(storage),
    publish = storage.publishHead.bind(storage);
  storage.writeImmutable = (name, bytes) => {
    writes++;
    write(name, bytes);
  };
  storage.publishHead = (bytes) => {
    publications++;
    publish(bytes);
  };
  t.after(() => {
    clearCollectionReportQueues(db);
    if (db.isOpen) {
      clearIntakeStateCache(db);
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, db, writes: () => writes, publications: () => publications };
}
async function retained(t: test.TestContext, count = 1) {
  const f = fixture(t);
  const source = uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-policy.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      Array.from({ length: count }, (_, n) =>
        JSON.stringify({
          format: 'health-record-v1',
          id: 'fictional-' + n,
          kind: 'document',
          payload: {
            text: 'Independent fictional complete policy ' + n,
            lexical: JSON.rawJSON('12.00'),
          },
          provenance: {
            capturedVia: 'Fictional export',
            sourceSystem: 'Fictional clinic',
            sourceRecordId: 'fictional-' + n,
            evidenceClass: 'provider_export',
            locator: 'page ' + (n + 1),
          },
          coverage: { status: 'complete_response', notes: [] },
          clinical: {
            kind: 'document',
            subject: 'unknown',
            documentTitle: 'Fictional ' + n,
            date: '2026-01-01',
          },
        }),
      ).join('\n'),
    ),
  });
  await ensureNativeIntakeSchema(f.db, f.profileId, source.id);
  await prepareCollectionClinicalReviewDependencies(f.db, f.root, f.profileId, source.id);
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, source.id);
  const queue = await openCollectionReportQueue(f.db, f.root, f.profileId);
  assert.equal(
    'tryBorrowReview' in queue,
    false,
    'ordinary queue lease cannot bypass private pin admission',
  );
  const members = [...queue.groups('all', source.id)].flatMap((group) => [
    ...queue.members(source.id, group.ordinal),
  ]);
  assert.equal(members.length, count);
  try {
    let row = await queue.reviewMember(source.id, members[0]!);
    if (!row.certificate) row = await queue.reviewMember(source.id, members[0]!);
    assert.ok(row.certificate, 'unchanged successful preparation retained exact certificate');
    queue.close({ retainReview: true });
    assert.equal(
      reviewIssueScratchCounts(f.db).databases,
      1,
      'actual retained complete policy owner',
    );
    return { ...f, source, members, version: row.version, token: row.reviewToken };
  } catch (error) {
    queue.close();
    throw error;
  }
}
const digest = (value: unknown) => {
  const hash = createHash('sha256');
  for (const piece of canonicalReviewValueChunks(value)) hash.update(piece);
  return hash.digest('hex');
};
const borrow = (f: Awaited<ReturnType<typeof retained>>, assertRunning = () => {}) =>
  tryBorrowRetainedCollectionClinicalPolicy(
    f.db,
    f.root,
    f.profileId,
    f.source.id,
    null,
    assertRunning,
  );

for (const count of [4, 16] as const)
  test(
    'retained complete policy and tokens equal independent reconstruction at ' + count + ' records',
    { timeout: 120_000 },
    async (t) => {
      const f = await retained(t, count);
      await runExclusiveClinicalOperation(f.db, async () => {
        const before = { ...intakeWorkCounters(f.db).warm },
          stamp = reviewReadStamp(f.db);
        const selected = borrow(f);
        assert.ok(selected);
        const checked = checkedRetainedCollectionClinicalPolicyContext(f.db, selected);
        const foreign = new DatabaseSync(':memory:');
        try {
          assert.throws(
            () => checkedRetainedCollectionClinicalPolicyContext(foreign, selected),
            /Foreign retained clinical policy borrow/,
          );
        } finally {
          foreign.close();
        }
        assert.equal('checked' in selected, false, 'private context is not a public borrow method');
        assert.ok([...checked.verifiedArtifacts()].length >= 1);
        const borrowed = f.members.map((member) => {
          const record = selected.record(
            member.recordId,
            member.candidateId,
            member.candidateVersionId,
          );
          assert.ok(record);
          assert.equal(
            digest(checked.record(member.recordId, member.candidateId, member.candidateVersionId)),
            digest(record),
            'checked private record retains the same complete selected policy',
          );
          assert.match(record.mapping.text!, /12\.00/, 'exact lexical original survived policy');
          return { record: digest(record), selectionToken: record.selectionReviewToken };
        });
        selected.assertCurrent();
        selected.close();
        assert.throws(() => checked.assertAuthorityCurrent(), /Refresh|changed/i);
        assert.equal(reviewReadStamp(f.db), stamp, 'borrow never writes/rebaselines source SQL');
        assert.equal(
          intakeWorkCounters(f.db).warm.collectionQueuePolicyBorrowHits,
          before.collectionQueuePolicyBorrowHits + 1,
        );
        assert.equal(
          intakeWorkCounters(f.db).warm.reviewDraftHandoffs,
          before.reviewDraftHandoffs,
          'borrow constructs no policy',
        );
        const afterBorrow = { ...intakeWorkCounters(f.db).warm };
        assert.equal(
          afterBorrow.hashCalls,
          before.hashCalls,
          'an unchanged retained binding witness needs no new binding digest',
        );
        assert.equal(
          afterBorrow.hashedBytes,
          before.hashedBytes,
          'warm borrowing does not reread binding input bytes',
        );
        const fresh = await prepareCollectionClinicalReviewAsync(
          f.db,
          f.root,
          f.profileId,
          f.source.id,
        );
        assert.equal(fresh.status, 'ready');
        if (fresh.status !== 'ready') throw Error('Expected complete policy');
        try {
          assert.equal(fresh.session.review.version, f.version);
          assert.equal(
            fresh.session.review.reviewToken,
            f.token,
            'complete review token unchanged',
          );
          const reconstructed = f.members.map((member) => {
            const record = fresh.session.record(
              member.recordId,
              member.candidateId,
              member.candidateVersionId,
            );
            assert.ok(record);
            return { record: digest(record), selectionToken: record.selectionReviewToken };
          });
          assert.deepEqual(
            borrowed,
            reconstructed,
            'complete canonical policy/provider and exact selection tokens',
          );
        } finally {
          fresh.session.close();
        }
        const afterFresh = { ...intakeWorkCounters(f.db).warm };
        assert.equal(
          reviewReadStamp(f.db),
          stamp,
          'independent construction used the same authority',
        );
        // A fresh borrow still reads the immutable shared owner after independent consumption.
        const next = borrow(f);
        assert.ok(next);
        next.assertCurrent();
        next.close();
        t.diagnostic(
          JSON.stringify({
            count,
            borrowWork: Object.fromEntries(
              Object.keys(before)
                .map((key) => [
                  key,
                  afterBorrow[key as keyof typeof before] - before[key as keyof typeof before],
                ])
                .filter(([, n]) => n),
            ),
            freshWork: Object.fromEntries(
              Object.keys(before)
                .map((key) => [
                  key,
                  afterFresh[key as keyof typeof before] - afterBorrow[key as keyof typeof before],
                ])
                .filter(([, n]) => n),
            ),
            comparison:
              'complete bounded policy under the same current authority; not total-request/macro work',
          }),
        );
      });
    },
  );

test('queued review continuation credits only certified disposable maintenance', async (t) => {
  const f = fixture(t);
  execClinicalReviewMaintenance(
    f.db,
    'attention',
    'CREATE TEMP TABLE IF NOT EXISTS source_attention_counts_v1(source_id TEXT PRIMARY KEY,sections INTEGER NOT NULL)',
  );
  const neutral = await openCollectionReportQueue(f.db, f.root, f.profileId);
  const assertNeutralPrepared = neutral.capturePreparedGuard();
  runClinicalReviewMaintenance(
    f.db,
    'attention',
    'INSERT OR REPLACE INTO source_attention_counts_v1 VALUES(?,?)',
    'fictional-certified-attention',
    0,
  );
  neutral.assertPreparedGuard(assertNeutralPrepared);
  assert.throws(() => neutral.assertCurrent(), { code: 'REPORT_QUEUE_CURSOR' });
  neutral.close({ discard: true });
  assert.throws(() => neutral.assertPreparedGuard(assertNeutralPrepared), {
    code: 'REPORT_QUEUE_CURSOR',
  });

  const foreign = await openCollectionReportQueue(f.db, f.root, f.profileId);
  const assertForeignPrepared = foreign.capturePreparedGuard();
  f.db.exec('CREATE TEMP TABLE fictional_foreign_queue_cache(n INTEGER)');
  assert.throws(() => foreign.assertPreparedGuard(assertForeignPrepared), {
    code: 'REPORT_QUEUE_CURSOR',
  });
  foreign.close({ discard: true });

  const methods = await openCollectionReportQueue(f.db, f.root, f.profileId);
  const assertMethodsPrepared = methods.capturePreparedGuard();
  assert.throws(() => methods.assertPreparedGuard(assertForeignPrepared), {
    code: 'REPORT_QUEUE_CURSOR',
  });
  const beforeTransaction = methods.capturePreparedGuard();
  f.db.exec('BEGIN');
  try {
    assert.throws(() => methods.assertPreparedGuard(beforeTransaction), {
      code: 'REPORT_QUEUE_CURSOR',
    });
  } finally {
    f.db.exec('ROLLBACK');
  }
  f.db.setAuthorizer(null);
  assert.throws(() => methods.assertPreparedGuard(assertMethodsPrepared), {
    code: 'REPORT_QUEUE_CURSOR',
  });
  methods.close({ discard: true });
});

test(
  'actual users pin protects retained policy across fifth database LRU churn and releases only its lease',
  { timeout: 120_000 },
  async (t) => {
    const f = await retained(t),
      others = Array.from({ length: 4 }, () => fixture(t));
    // Another HTTP/profile owner has its own async context, outside this DB's held lane.
    const independent = new AsyncResource('fictional-independent-profile-request');
    const openIndependent = (other: ReturnType<typeof fixture>) =>
      independent.runInAsyncScope(() =>
        openCollectionReportQueue(other.db, other.root, other.profileId),
      );
    const held = [] as Awaited<ReturnType<typeof openCollectionReportQueue>>[];
    try {
      for (const other of others.slice(0, 3))
        held.push(await openCollectionReportQueue(other.db, other.root, other.profileId));
      await runExclusiveClinicalOperation(f.db, async () => {
        const selected = borrow(f);
        assert.ok(selected);
        try {
          assert.equal(
            borrow(f),
            undefined,
            'busy selected owner is skipped without waiting or replacement',
          );
          await immediate();
          const fifth = others[3]!;
          await assert.rejects(
            () => openIndependent(fifth),
            { code: 'REPORT_QUEUE_BUSY' },
            'all four actual queues are pinned; fifth cannot evict retained borrowed owner',
          );
          selected.assertCurrent();
          assert.equal(reviewIssueScratchCounts(f.db).databases, 1);
          held.shift()!.close();
          const admitted = await openIndependent(fifth);
          held.push(admitted);
          selected.assertCurrent();
          const member = f.members[0]!;
          assert.ok(
            selected.record(member.recordId, member.candidateId, member.candidateVersionId),
          );
        } finally {
          selected.close();
        }
        assert.throws(
          () => selected.assertCurrent(),
          /Refresh|changed/i,
          'released capability cannot be reused',
        );
      });
      const sixth = fixture(t),
        replacement = await openCollectionReportQueue(sixth.db, sixth.root, sixth.profileId);
      held.push(replacement);
      assert.equal(
        reviewIssueScratchCounts(f.db).databases,
        0,
        'pin release permits actual idle-owner eviction',
      );
    } finally {
      for (const queue of held) queue.close();
      independent.emitDestroy();
    }
  },
);

test(
  'borrow refuses reset clear replacement DB close and cancellation without resurrecting owners',
  { timeout: 120_000 },
  async (t) => {
    for (const mode of ['reset', 'clear', 'replacement', 'close', 'cancel'] as const) {
      const f = await retained(t),
        controller = new AbortController();
      let selected: ReturnType<typeof borrow>;
      const rejection = mode === 'cancel' || mode === 'close';
      const work = () =>
        runExclusiveClinicalOperation(
          f.db,
          async () => {
            selected = borrow(f);
            assert.ok(selected);
            const hits = intakeWorkCounters(f.db).warm.collectionQueuePolicyBorrowHits;
            try {
              if (mode === 'reset' || mode === 'replacement') clearCollectionQueueReviews(f.db);
              if (mode === 'clear') clearCollectionReportQueues(f.db);
              if (mode === 'close') f.db.close();
              if (mode === 'cancel') controller.abort(Error('fictional borrower cancelled'));
              if (mode === 'replacement') {
                const newer = await openCollectionReportQueue(f.db, f.root, f.profileId);
                try {
                  await newer.reviewMember(f.source.id, f.members[0]!);
                } finally {
                  newer.close({ retainReview: true });
                }
              }
              assert.throws(
                () => selected!.assertCurrent(),
                /Refresh|changed|no longer active|cancelled/i,
              );
              if (f.db.isOpen)
                assert.equal(
                  intakeWorkCounters(f.db).warm.collectionQueuePolicyBorrowHits,
                  hits,
                  'no fallback/re-admission',
                );
            } finally {
              selected.close();
            }
          },
          { signal: controller.signal },
        );
      if (rejection) await assert.rejects(work, /no longer active|cancelled/i);
      else await work();
      assert.ok(selected);
      const released = selected;
      assert.throws(() => released.assertCurrent(), /Refresh|changed|no longer active|cancelled/i);
      if (f.db.isOpen) {
        clearCollectionReportQueues(f.db);
        assert.equal(reviewIssueScratchCounts(f.db).databases, 0);
      }
    }
  },
);

test(
  'borrow original raw guard refuses local restored writes TEMP DDL and transactional rollback',
  { timeout: 120_000 },
  async (t) => {
    for (const mode of ['restored', 'temp', 'rollback'] as const) {
      const f = await retained(t);
      await runExclusiveClinicalOperation(f.db, async () => {
        const selected = borrow(f);
        assert.ok(selected);
        const before = {
          raw: reviewReadStamp(f.db),
          nodes: intakeWorkCounters(f.db).warm.collectionNodesWritten,
          writes: f.writes(),
          publications: f.publications(),
        };
        try {
          if (mode === 'temp')
            f.db.exec(
              'CREATE TEMP TABLE fictional_borrow_temp(value); DROP TABLE fictional_borrow_temp',
            );
          else {
            if (mode === 'rollback') f.db.exec('SAVEPOINT fictional_borrow_rollback');
            f.db
              .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
              .run('fictional-borrow', 'changed');
            if (mode === 'rollback')
              f.db.exec('ROLLBACK TO fictional_borrow_rollback; RELEASE fictional_borrow_rollback');
            else f.db.prepare('DELETE FROM app_meta WHERE key=?').run('fictional-borrow');
          }
          assert.notEqual(reviewReadStamp(f.db), before.raw);
          assert.equal(
            f.db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional-borrow'),
            undefined,
          );
          assert.throws(() => selected.assertCurrent(), /Refresh|changed/i);
          assert.throws(
            () => selected.assertCurrent(),
            /Refresh|changed/i,
            'original certificate is never rebased',
          );
          assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, before.nodes);
          assert.equal(f.writes(), before.writes);
          assert.equal(f.publications(), before.publications);
        } finally {
          selected.close();
        }
      });
    }
  },
);

test(
  'borrow hit refuses peer rollback and changed accepted HEAD at its final real physical guard',
  { timeout: 120_000 },
  async (t) => {
    for (const mode of ['peer', 'rollback', 'head'] as const) {
      const f = await retained(t),
        headPath = join(contributorAuthorityPath(f.root, f.profileId), 'head'),
        head = readFileSync(headPath);
      const peer = new DatabaseSync(String(f.db.prepare('PRAGMA database_list').get()!.file));
      const stat = nodeFs.lstatSync,
        limit = Error.stackTraceLimit;
      let stimulus:
        | {
            before: unknown;
            after: unknown;
            row: unknown;
            stack: string;
            headChanged: boolean;
            hits: number;
          }
        | undefined;
      try {
        await runExclusiveClinicalOperation(f.db, async () => {
          const selected = borrow(f);
          assert.ok(selected);
          const before = {
            raw: reviewReadStamp(f.db),
            hits: intakeWorkCounters(f.db).warm.collectionQueuePolicyBorrowHits,
            nodes: intakeWorkCounters(f.db).warm.collectionNodesWritten,
            writes: f.writes(),
            publications: f.publications(),
          };
          Error.stackTraceLimit = 64;
          Reflect.set(nodeFs, 'lstatSync', ((path, ...args) => {
            const result = Reflect.apply(stat, nodeFs, [path, ...args]);
            if (String(path) !== headPath || stimulus) return result;
            const stack = new Error('fictional queue borrowed HEAD stimulus').stack!;
            if (
              !stack.includes('assertBorrowedCurrent') ||
              !stack.includes('intakeSourceVersion') ||
              stack.includes('collectionQueueBinding') ||
              stack.includes('collectionClinicalProjectionContext')
            )
              return result;
            const state = {
              before: reviewReadStamp(f.db),
              after: reviewReadStamp(f.db),
              row: undefined as unknown,
              stack,
              headChanged: false,
              hits: intakeWorkCounters(f.db).warm.collectionQueuePolicyBorrowHits,
            };
            stimulus = state;
            if (mode === 'peer') {
              peer
                .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
                .run('fictional-last-head', 'changed');
              peer.prepare('DELETE FROM app_meta WHERE key=?').run('fictional-last-head');
            } else if (mode === 'rollback') {
              f.db.exec('SAVEPOINT fictional_last_head');
              f.db
                .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
                .run('fictional-last-head', 'changed');
              f.db.exec('ROLLBACK TO fictional_last_head; RELEASE fictional_last_head');
            } else {
              writeFileSync(headPath, Buffer.alloc(head.length, 32));
              state.headChanged = !readFileSync(headPath).equals(head);
            }
            state.after = reviewReadStamp(f.db);
            state.row = f.db
              .prepare('SELECT value FROM app_meta WHERE key=?')
              .get('fictional-last-head');
            return result;
          }) as typeof nodeFs.lstatSync);
          syncBuiltinESMExports();
          try {
            assert.throws(
              () => selected.assertCurrent(),
              /Refresh|changed|head|authority|record|json/i,
            );
          } finally {
            Reflect.set(nodeFs, 'lstatSync', stat);
            Error.stackTraceLimit = limit;
            syncBuiltinESMExports();
            writeFileSync(headPath, head);
            selected.close();
          }
          assert.ok(stimulus, 'actual accepted HEAD stat reached after admitted borrow hit');
          assert.equal(stimulus.hits, before.hits);
          assert.match(stimulus.stack, /assertBorrowedCurrent/);
          assert.match(stimulus.stack, /intakeSourceVersion/);
          assert.doesNotMatch(
            stimulus.stack,
            /collectionQueueBinding|collectionClinicalProjectionContext/,
            'stimulus follows physical session/queue checks at the final source-pin read',
          );
          assert.equal(
            stimulus.row,
            undefined,
            'real peer/local SQL rows restored outside rejection',
          );
          if (mode === 'head') assert.equal(stimulus.headChanged, true);
          else assert.notEqual(stimulus.after, stimulus.before);
          assert.equal(f.db.isTransaction, false);
          assert.deepEqual(readFileSync(headPath), head);
          assert.equal(f.writes(), before.writes);
          assert.equal(f.publications(), before.publications);
          assert.equal(intakeWorkCounters(f.db).warm.collectionNodesWritten, before.nodes);
        });
      } finally {
        Reflect.set(nodeFs, 'lstatSync', stat);
        Error.stackTraceLimit = limit;
        syncBuiltinESMExports();
        writeFileSync(headPath, head);
        peer.close();
      }
    }
  },
);
