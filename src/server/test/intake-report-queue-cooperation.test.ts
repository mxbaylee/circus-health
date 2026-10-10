import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { collectionReportQueueMembers } from '../intake-report-queue-collection.ts';
import { withVerifiedIntakeOriginalDescriptor } from '../intake.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
import { makeNativeQueueFixture } from './helpers/report-queue-fixture.ts';

for (const [count, mode] of [
  [4, 'distinct'],
  [65, 'shared-member'],
  [65, 'one-group'],
] as const)
  test(`native queue preparation cooperates across ${count} ${mode} rows`, async (t) => {
    const { root, profileId, db, sourceId, groupCount } = await makeNativeQueueFixture(
      t,
      count,
      mode,
    );

    const statementShapes = new WeakMap<StatementSync, 'groups' | 'members'>();
    const plans = new Map<'owner' | 'groups' | 'members' | 'fallback' | 'final', boolean>();
    const originalPrepare = DatabaseSync.prototype.prepare;
    const originalRun = StatementSync.prototype.run;
    t.after(() => {
      DatabaseSync.prototype.prepare = originalPrepare;
      StatementSync.prototype.run = originalRun;
    });
    const counts = { groups: 0, members: 0 };
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = originalPrepare.call(this, sql);
      const shape = sql.trim();
      if (shape.startsWith('INSERT INTO groups VALUES(')) statementShapes.set(statement, 'groups');
      if (shape.startsWith('INSERT INTO members VALUES('))
        statementShapes.set(statement, 'members');
      const plan = shape.startsWith('SELECT ordinal,id,basis FROM groups ORDER BY ordinal')
        ? 'owner'
        : shape.startsWith('SELECT candidate,version,ordering FROM members INDEXED BY memberOrder')
          ? 'members'
          : shape.startsWith('SELECT ordinal FROM groups WHERE id=? ORDER BY ordinal LIMIT 1')
            ? 'fallback'
            : shape.startsWith(
                  'SELECT ordinal,id,basis,ordering,address,span FROM groups INDEXED BY groupOrder',
                )
              ? 'groups'
              : shape.startsWith(
                    'SELECT ordinal,id,ordering,span FROM groups INDEXED BY groupOrder',
                  )
                ? 'final'
                : undefined;
      if (plan) {
        const parameters = plan === 'members' ? [0] : plan === 'fallback' ? ['report-group-0'] : [];
        const steps = originalPrepare.call(this, 'EXPLAIN QUERY PLAN ' + sql).all(...parameters);
        plans.set(
          plan,
          steps.some((row) => String(row.detail).includes('USE TEMP B-TREE')),
        );
      }
      return statement;
    };
    StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
      const shape = statementShapes.get(this);
      if (shape) counts[shape]++;
      return Reflect.apply(originalRun, this, args) as ReturnType<StatementSync['run']>;
    } as typeof StatementSync.prototype.run;

    let completedGroups = 0,
      finalPhaseTurn = false;
    const { beforeTurn, members, yieldedAfterFinalTurn } =
      await withVerifiedIntakeOriginalDescriptor(
        { db, root, profileId, id: sourceId },
        async ({ assertRunning }) => {
          const firstTurn = new Promise<{ groups: number; members: number; callbacks: number }>(
            (resolve) => setImmediate(() => resolve({ ...counts, callbacks: completedGroups })),
          );
          const iterator = collectionReportQueueMembers(
            db,
            profileId,
            sourceId,
            () => {
              completedGroups++;
              if (mode === 'shared-member' && completedGroups === groupCount)
                setImmediate(() => {
                  finalPhaseTurn = true;
                });
            },
            assertRunning,
          );
          const first = await iterator.next();
          const beforeTurn = await firstTurn;
          const yieldedAfterFinalTurn = finalPhaseTurn;
          const members = first.done ? [] : [first.value];
          for await (const member of iterator) members.push(member);
          return { beforeTurn, members, yieldedAfterFinalTurn };
        },
      );
    const order = members.map((member) => [
      member.groupOrder,
      member.groupOrdinal,
      member.memberOrder,
      member.candidateId,
      member.candidateVersionId,
    ]);
    const digest = createHash('sha256').update(JSON.stringify(order)).digest('hex');
    t.diagnostic(
      JSON.stringify({
        count,
        beforeTurn,
        completedGroups,
        members: members.length,
        yieldedAfterFinalTurn,
        digest,
        tempSorts: Object.fromEntries(plans),
      }),
    );
    assert.equal(completedGroups, groupCount);
    if (mode === 'shared-member') assert.equal(yieldedAfterFinalTurn, true);
    assert.equal(members.length, mode === 'shared-member' ? 1 : count);
    assert.equal(new Set(order.map((row) => JSON.stringify(row))).size, members.length);
    if (mode === 'shared-member') assert.equal(members[0]!.groupId, 'report-group-64');
    assert.deepEqual(
      [...order].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      order,
      'member order follows complete retained group order',
    );
    assert.ok(beforeTurn.groups <= 64, `${count} groups were indexed before one I/O turn`);
    assert.ok(beforeTurn.members <= 64, `${count} members were indexed before one I/O turn`);
    assert.ok(beforeTurn.callbacks <= 64, `${count} group callbacks ran before one I/O turn`);
    t.diagnostic(JSON.stringify({ tempSorts: Object.fromEntries(plans) }));
    assert.deepEqual(Object.fromEntries(plans), {
      members: false,
      owner: false,
      groups: false,
      final: false,
    });
  });

test('native queue permits a consumer-side derived refresh after an emitted member', async (t) => {
  const { root, profileId, db, sourceId } = await makeNativeQueueFixture(t, 4);
  await withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id: sourceId },
    async ({ assertRunning }) => {
      const iterator = collectionReportQueueMembers(
        db,
        profileId,
        sourceId,
        undefined,
        assertRunning,
      );
      const first = await iterator.next();
      assert.equal(first.done, false);
      db.exec('CREATE TEMP TABLE fictional_derived_refresh(value INTEGER)');
      clearIntakeCollectionCache(db);
      const remaining = [];
      for await (const member of iterator) remaining.push(member);
      assert.equal(remaining.length, 3);
    },
  );
});

test('native queue refuses source replacement after an emitted member', async (t) => {
  const { root, profileId, db, sourceId, originalPath } = await makeNativeQueueFixture(t, 4);
  await withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id: sourceId },
    async ({ assertRunning }) => {
      const iterator = collectionReportQueueMembers(
        db,
        profileId,
        sourceId,
        undefined,
        assertRunning,
      );
      const first = await iterator.next();
      assert.equal(first.done, false);
      const original = readFileSync(originalPath);
      writeFileSync(originalPath, Buffer.alloc(original.length, 88));
      await assert.rejects(iterator.next());
    },
  ).catch((error: unknown) => {
    // The outer physical lease may repeat the same refusal while closing.
    if (!(error instanceof Error) || !/changed|source/i.test(error.message)) throw error;
  });
});

test('native queue preserves duplicate group IDs and retained-only fallback membership', async (t) => {
  const { root, profileId, db, sourceId } = await makeNativeQueueFixture(
    t,
    4,
    'duplicate-fallback',
  );
  const groups: string[] = [];
  let fallbackTempSort: boolean | undefined;
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
  });
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith('SELECT ordinal FROM groups WHERE id=? ORDER BY ordinal LIMIT 1'))
      fallbackTempSort = originalPrepare
        .call(this, 'EXPLAIN QUERY PLAN ' + sql)
        .all('report-group:fictional')
        .some((row) => String(row.detail).includes('USE TEMP B-TREE'));
    return statement;
  };
  const members = await withVerifiedIntakeOriginalDescriptor(
    { db, root, profileId, id: sourceId },
    async ({ assertRunning }) => {
      const result = [];
      for await (const member of collectionReportQueueMembers(
        db,
        profileId,
        sourceId,
        (group) => groups.push(group.groupId),
        assertRunning,
      ))
        result.push(member);
      return result;
    },
  );
  assert.equal(groups.length, 5);
  assert.equal(fallbackTempSort, false);
  assert.equal(members.length, 5);
  assert.deepEqual(
    members
      .filter((member) => member.candidateId === 'candidate-0')
      .map((member) => member.groupOrdinal),
    [0, 1],
  );
  const fallback = members.find((member) => member.candidateId === 'candidate-1');
  assert.ok(fallback?.groupId.startsWith('report-group:'));
  assert.deepEqual(members.map((member) => member.candidateId).sort(), [
    'candidate-0',
    'candidate-0',
    'candidate-1',
    'candidate-2',
    'candidate-3',
  ]);
});

for (const [name, change] of [
  [
    'source binding',
    (db: DatabaseSync, id: string) => {
      db.prepare('UPDATE source_files SET details_json=details_json||? WHERE id=?').run(' ', id);
    },
  ],
  [
    'temporary SQL epoch',
    (db: DatabaseSync) => {
      db.exec('CREATE TEMP TABLE fictional_queue_epoch_change(value INTEGER)');
    },
  ],
] as const)
  test(`native queue refuses ${name} drift at an internal yield`, async (t) => {
    const { root, profileId, db, sourceId } = await makeNativeQueueFixture(t, 65, 'shared-member');
    await withVerifiedIntakeOriginalDescriptor(
      { db, root, profileId, id: sourceId },
      async ({ assertRunning }) => {
        const changed = new Promise<void>((resolve) =>
          setImmediate(() => {
            change(db, sourceId);
            resolve();
          }),
        );
        const first = collectionReportQueueMembers(
          db,
          profileId,
          sourceId,
          undefined,
          assertRunning,
        ).next();
        await changed;
        await assert.rejects(first);
      },
    );
  });

test('native queue refuses cancellation and same-size original replacement at internal yields', async (t) => {
  const { root, profileId, db, sourceId, originalPath } = await makeNativeQueueFixture(
    t,
    65,
    'shared-member',
  );
  let cancelled = false;
  await assert.rejects(
    withVerifiedIntakeOriginalDescriptor(
      {
        db,
        root,
        profileId,
        id: sourceId,
        assertRunning: () => {
          if (cancelled) throw Error('fictional cancellation');
        },
      },
      async ({ assertRunning }) => {
        const changed = new Promise<void>((resolve) =>
          setImmediate(() => {
            cancelled = true;
            resolve();
          }),
        );
        const first = collectionReportQueueMembers(
          db,
          profileId,
          sourceId,
          undefined,
          assertRunning,
        ).next();
        await changed;
        return first;
      },
    ),
    /fictional cancellation/,
  );
  const original = readFileSync(originalPath);
  await assert.rejects(
    withVerifiedIntakeOriginalDescriptor(
      { db, root, profileId, id: sourceId },
      async ({ assertRunning }) => {
        const changed = new Promise<void>((resolve) =>
          setImmediate(() => {
            writeFileSync(originalPath, Buffer.alloc(original.length, 88));
            resolve();
          }),
        );
        const first = collectionReportQueueMembers(
          db,
          profileId,
          sourceId,
          undefined,
          assertRunning,
        ).next();
        await changed;
        return first;
      },
    ),
  );
});
