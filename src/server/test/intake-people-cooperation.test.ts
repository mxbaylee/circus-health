import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  openCollectionPeopleRead,
  prepareCollectionPeopleIndex,
  readCollectionPeoplePage,
} from '../intake-people-collection.ts';
import { makeNativeQueueFixture } from './helpers/report-queue-fixture.ts';
import { validatedIntakePeople } from '../intake-people-format.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';
import { withVerifiedIntakeOriginalDescriptor } from '../intake.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';

for (const count of [4, 65])
  test(`native People preparation yields during ${count} retained report memberships`, async (t) => {
    const { root, profileId, db, sourceId } = await makeNativeQueueFixture(
      t,
      count,
      'people-membership',
    );
    const originalPrepare = DatabaseSync.prototype.prepare,
      originalRun = StatementSync.prototype.run;
    const membershipStatements = new WeakSet<StatementSync>();
    let membershipInserts = 0;
    t.after(() => {
      DatabaseSync.prototype.prepare = originalPrepare;
      StatementSync.prototype.run = originalRun;
    });
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.startsWith('INSERT INTO membership VALUES(')) membershipStatements.add(statement);
      return statement;
    };
    StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
      if (membershipStatements.has(this)) membershipInserts++;
      return Reflect.apply(originalRun, this, args) as ReturnType<StatementSync['run']>;
    } as typeof StatementSync.prototype.run;

    const firstTurn = new Promise<number>((resolve) =>
      setImmediate(() => resolve(membershipInserts)),
    );
    const preparation = prepareCollectionPeopleIndex(db, root, profileId, sourceId);
    const beforeTurn = await firstTurn;
    await preparation;
    t.diagnostic(JSON.stringify({ count, beforeTurn, membershipInserts }));
    assert.equal(membershipInserts, count);
    assert.ok(beforeTurn <= 64, `${count} membership rows were inserted before one I/O turn`);
  });

test('duplicate retained group membership keeps the earliest Person pointer', async (t) => {
  const f = await makeNativeQueueFixture(t, 4, 'people-duplicate');
  assert.equal(validatedIntakePeople(JSON.parse(readFileSync(f.originalPath, 'utf8'))).length, 1);
  const originalPrepare = DatabaseSync.prototype.prepare;
  const plans: string[] = [];
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
  });
  DatabaseSync.prototype.prepare = function (sql: string) {
    if (
      sql.startsWith(
        'SELECT groupId,groupVersionId,memberId,candidate,version,ordinal FROM membership',
      )
    ) {
      const rows = originalPrepare
        .call(this, 'EXPLAIN QUERY PLAN ' + sql)
        .all('null', `${f.sourceId}:line:1`);
      plans.push(...rows.map((row) => String(row.detail)));
    }
    return originalPrepare.call(this, sql);
  };
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId);
  assert.ok(plans.some((detail) => detail.includes('byOccurrence')));
  assert.ok(plans.every((detail) => !detail.includes('USE TEMP B-TREE')));
  const reader = openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId);
  const pointers = [];
  for await (const pointer of reader.pointersCooperative(undefined, () => {}))
    pointers.push(pointer);
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0]!.groupId, 'report-group-0');
  const page = await readCollectionPeoplePage(f.db, f.root, f.profileId, f.sourceId, {
    limit: 1,
  });
  assert.equal(page.totalPeople, 1);
  assert.equal(page.people.length, 1);
  assert.equal(page.nextCursor, null);
});

test('later conflicting member evidence is refused even after Person deduplication', async (t) => {
  const f = await makeNativeQueueFixture(t, 4, 'people-conflict');
  await assert.rejects(
    prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId),
    /Named Person evidence no longer matches/,
  );
});

for (const change of ['temp', 'registry'] as const)
  test(`a People pointer refuses ${change} mutation across its first async yield`, async (t) => {
    const f = await makeNativeQueueFixture(t, 4, 'people-duplicate');
    await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId);
    const reader = openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId);
    await withVerifiedIntakeOriginalDescriptor(
      { db: f.db, root: f.root, profileId: f.profileId, id: f.sourceId },
      async ({ assertRunning }) => {
        const iterator = reader.pointersCooperative(undefined, assertRunning);
        assert.equal((await iterator.next()).done, false);
        if (change === 'temp') f.db.exec('CREATE TEMP TABLE fictional_people_yield_change(value)');
        else clearIntakeStateCache(f.db);
        await assert.rejects(iterator.next(), /Refresh these People proposals/);
      },
    );
  });

test('a one-Person page cooperatively counts all 65 retained People', async (t) => {
  const f = await makeNativeQueueFixture(t, 65, 'people-page');
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId);
  let complete = false;
  const pagePromise = readCollectionPeoplePage(f.db, f.root, f.profileId, f.sourceId, {
    limit: 1,
  }).then((page) => {
    complete = true;
    return page;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const completedBeforeTurn = complete;
  const page = await pagePromise;
  t.diagnostic(JSON.stringify({ completedBeforeTurn, total: page.totalPeople }));
  assert.equal(completedBeforeTurn, false, 'the full People scan must yield before completion');
  assert.equal(page.people.length, 1);
  assert.equal(page.totalPeople, 65);
  assert.equal(page.counts.pending, 65);
  assert.ok(page.nextCursor);
  const filtered = await readCollectionPeoplePage(f.db, f.root, f.profileId, f.sourceId, {
    q: 'Fictional Mira 64',
    limit: 1,
  });
  assert.equal(filtered.totalPeople, 1);
  assert.equal(filtered.people.length, 1);
  assert.equal(filtered.counts.pending, 1);
});

test('a People page refuses physical source drift at its host turn', async (t) => {
  const f = await makeNativeQueueFixture(t, 65, 'people-page');
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId);
  const page = readCollectionPeoplePage(f.db, f.root, f.profileId, f.sourceId, { limit: 1 });
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      appendFileSync(f.originalPath, '\n');
      resolve();
    }),
  );
  await assert.rejects(page, /changed|source|original/i);
});

test('interrupted People preparation never publishes a complete index', async (t) => {
  const f = await makeNativeQueueFixture(t, 65, 'people-membership');
  const rejected = assert.rejects(
    prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId),
    /changed|source|original/i,
  );
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      appendFileSync(f.originalPath, '\n');
      resolve();
    }),
  );
  await rejected;
  assert.throws(
    () => openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId),
    /Prepare complete/,
  );
});

test('cancelled People preparation leaves the original unchanged and the index incomplete', async (t) => {
  const f = await makeNativeQueueFixture(t, 65, 'people-membership');
  const original = readFileSync(f.originalPath);
  const controller = new AbortController();
  const rejected = assert.rejects(
    runExclusiveClinicalOperation(
      f.db,
      async () => prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId),
      { signal: controller.signal },
    ),
    /fictional cancellation/,
  );
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      controller.abort(new Error('fictional cancellation'));
      resolve();
    }),
  );
  await rejected;
  assert.deepEqual(readFileSync(f.originalPath), original);
  assert.throws(
    () => openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId),
    /Prepare complete/,
  );
});

test('a returned proposal is reverified after the active cache switches sources', async (t) => {
  const f = await makeNativeQueueFixture(t, 66, 'people-proposals');
  await prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId);
  const reader = openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId);
  const pointers = [];
  for await (const pointer of reader.pointersCooperative(undefined, () => {}))
    pointers.push(pointer);
  assert.equal(pointers.length, 66);
  const [earlier, later] = f.proposalFiles;
  assert.ok(pointers.findIndex((pointer) => pointer.proposalId === later!.id) < 63);
  assert.equal(pointers[62]!.proposalId, earlier!.id);
  assert.ok(pointers.slice(63).every((pointer) => pointer.proposalId === earlier!.id));
  const page = readCollectionPeoplePage(f.db, f.root, f.profileId, f.sourceId, {
    q: 'Cedar',
    limit: 1,
  });
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      appendFileSync(later!.path, '\n');
      resolve();
    }),
  );
  await assert.rejects(page, /Retained People proposal changed/);
  assert.equal(
    createHash('sha256').update(readFileSync(f.originalPath)).digest('hex'),
    f.sourceHash,
  );
  assert.equal(
    createHash('sha256').update(readFileSync(earlier!.path)).digest('hex'),
    earlier!.sha256,
  );
  assert.notEqual(
    createHash('sha256').update(readFileSync(later!.path)).digest('hex'),
    later!.sha256,
  );
});

test('an active parsed proposal is refused after its physical identity changes', async (t) => {
  const f = await makeNativeQueueFixture(t, 66, 'people-proposals');
  const selected = f.proposalFiles[1]!;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalRun = StatementSync.prototype.run;
  const seenStatements = new WeakSet<StatementSync>();
  let seen = 0;
  let mutated = false;
  t.after(() => {
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.run = originalRun;
  });
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql === 'INSERT OR IGNORE INTO seen VALUES(?)') seenStatements.add(statement);
    return statement;
  };
  StatementSync.prototype.run = function (this: StatementSync, ...args: unknown[]) {
    const result = Reflect.apply(originalRun, this, args) as ReturnType<StatementSync['run']>;
    if (seenStatements.has(this) && ++seen === 34)
      setImmediate(() => {
        appendFileSync(selected.path, '\n');
        mutated = true;
      });
    return result;
  } as typeof StatementSync.prototype.run;
  await assert.rejects(
    prepareCollectionPeopleIndex(f.db, f.root, f.profileId, f.sourceId),
    /changed|source|original/i,
  );
  assert.ok(seen >= 34);
  assert.equal(mutated, true);
  assert.equal(
    createHash('sha256').update(readFileSync(f.originalPath)).digest('hex'),
    f.sourceHash,
  );
  assert.notEqual(
    createHash('sha256').update(readFileSync(selected.path)).digest('hex'),
    selected.sha256,
  );
  assert.throws(
    () => openCollectionPeopleRead(f.db, f.root, f.profileId, f.sourceId),
    /Prepare complete/,
  );
});
