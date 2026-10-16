import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import {
  prepareIntakeLookupIndices,
  intakeDiscoveryRevision,
  preparedIntakeLookupReadToken,
} from '../intake-lookup-state.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import { clearIntakeCollectionCache } from '../intake-state-collections.ts';
import { clearIntakeLookupCache } from '../intake-lookup-projection.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';

for (const count of [1, 65]) {
  test(`lookup preparation gives a host turn within 64 original sources among ${count}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-cooperation-'));
    const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
    const authority = memoryRecordAuthority(db);
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
    transaction(db, () => {
      for (let index = 0; index < count; index++)
        registerRawIntakeFixture(
          db,
          `fictional-${index}`,
          JSON.stringify({ intake: { version: 0 } }),
        );
    });
    await prepareIntakeLookupIndices(db);
    db.exec("UPDATE app_meta SET value=value WHERE key='owner_profile_id'");
    const expected = intakeDiscoveryRevision(db);
    const objects = authority.objects.size;
    const sequence = recordDurabilityStatus(db)?.sequence;
    const prepare = DatabaseSync.prototype.prepare;
    const get = StatementSync.prototype.get;
    const iterate = StatementSync.prototype.iterate;
    const tracked = new WeakSet<StatementSync>();
    let rows = 0;
    DatabaseSync.prototype.prepare = function (sql: string) {
      const statement = prepare.call(this, sql);
      if (
        this === db &&
        sql.includes("kind='intake_original'") &&
        /ORDER BY (?:f\.)?rowid/.test(sql)
      )
        tracked.add(statement);
      return statement;
    };
    StatementSync.prototype.get = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['get']>
    ) {
      const row = Reflect.apply(get, this, parameters);
      if (row && tracked.has(this)) rows++;
      return row;
    } as typeof StatementSync.prototype.get;
    StatementSync.prototype.iterate = function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['iterate']>
    ) {
      const selected = Reflect.apply(iterate, this, parameters) as ReturnType<
        StatementSync['iterate']
      >;
      if (!tracked.has(this)) return selected;
      return (function* () {
        for (const row of selected) {
          rows++;
          yield row;
        }
      })();
    } as typeof StatementSync.prototype.iterate;
    let prepared: Awaited<ReturnType<typeof prepareIntakeLookupIndices>>;
    let rowsAtFirstTurn = -1;
    try {
      const firstTurn = new Promise<void>((resolve) =>
        setImmediate(() => {
          rowsAtFirstTurn = rows;
          resolve();
        }),
      );
      const running = prepareIntakeLookupIndices(db);
      prepared = await running;
      await firstTurn;
    } finally {
      DatabaseSync.prototype.prepare = prepare;
      StatementSync.prototype.get = get;
      StatementSync.prototype.iterate = iterate;
    }
    t.diagnostic(JSON.stringify({ count, rows, rowsAtFirstTurn }));
    assert.equal(prepared.prepared, 0);
    assert.equal(prepared.discoveryRevision, expected);
    assert.equal(authority.objects.size, objects);
    assert.equal(recordDurabilityStatus(db)?.sequence, sequence);
    assert.ok(rowsAtFirstTurn <= 64, `${rowsAtFirstTurn} sources before the first host turn`);
  });
}

async function preparedFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-turn-'));
  const path = join(root, 'cache.sqlite');
  const db = openDatabase(path, 'fictional-profile');
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  transaction(db, () => {
    for (let index = 0; index < 65; index++)
      registerRawIntakeFixture(
        db,
        `fictional-${index}`,
        JSON.stringify({ intake: { version: 0 } }),
      );
  });
  await prepareIntakeLookupIndices(db);
  transaction(db, () => undefined);
  return { db, path, authority };
}

function mutateAtPage(db: DatabaseSync, phase: 'initial' | 'final', action: () => void) {
  const prepare = DatabaseSync.prototype.prepare;
  const get = StatementSync.prototype.get;
  const selected = new WeakSet<StatementSync>();
  let frontierStatements = 0;
  let rows = 0;
  let scheduled = false;
  let actionError: unknown;
  let finishAction!: () => void;
  const actionFinished = new Promise<void>((resolve) => {
    finishAction = resolve;
  });
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (this === db && sql.includes('lookup_rowid')) {
      frontierStatements++;
      if (phase === 'initial' ? frontierStatements <= 2 : frontierStatements > 2)
        selected.add(statement);
    }
    return statement;
  };
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const row = Reflect.apply(get, this, parameters);
    if (row && selected.has(this) && ++rows === 64) {
      scheduled = true;
      setImmediate(() => {
        try {
          action();
        } catch (error) {
          actionError = error;
        } finally {
          finishAction();
        }
      });
    }
    return row;
  } as typeof StatementSync.prototype.get;
  return {
    async assertFired() {
      assert.equal(scheduled, true, `expected ${phase} 64-row checkpoint`);
      await actionFinished;
      if (actionError) throw actionError;
    },
    restore() {
      DatabaseSync.prototype.prepare = prepare;
      StatementSync.prototype.get = get;
    },
  };
}

for (const mutation of ['insert-before', 'delete-prior', 'reorder-prior'] as const) {
  test(`initial yielded frontier refuses ${mutation} without a partial token`, async (t) => {
    const { db } = await preparedFixture(t);
    const mutate = () => {
      if (mutation === 'insert-before') {
        transaction(db, () => {
          registerRawIntakeFixture(db, 'fictional-new', JSON.stringify({ intake: { version: 0 } }));
          db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(-1n, 'fictional-new');
        });
      } else if (mutation === 'delete-prior')
        db.prepare('DELETE FROM source_files WHERE id=?').run('fictional-0');
      else db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(1000n, 'fictional-0');
    };
    const hook = mutateAtPage(db, 'initial', mutate);
    try {
      const result = await prepareIntakeLookupIndices(db).then(
        () => null,
        (error: unknown) => error,
      );
      await hook.assertFired();
      assert.match(String(result), /frontier changed/);
      assert.equal(preparedIntakeLookupReadToken(db), undefined);
    } finally {
      hook.restore();
    }
  });
}

for (const mutation of [
  'local-noop',
  'peer',
  'TEMP-schema',
  'registry',
  'profile',
  'accepted-HEAD',
  'projection',
  'cancel',
] as const) {
  test(`final yielded frontier refuses ${mutation} without a partial token`, async (t) => {
    const { db, path, authority } = await preparedFixture(t);
    let cancelled = false;
    const mutate = () => {
      switch (mutation) {
        case 'local-noop':
          db.exec("UPDATE app_meta SET value=value WHERE key='owner_profile_id'");
          break;
        case 'peer': {
          const peer = openDatabase(path, 'fictional-profile');
          try {
            peer.exec("INSERT INTO app_meta(key,value) VALUES('fictional-peer','changed')");
          } finally {
            peer.close();
          }
          break;
        }
        case 'TEMP-schema':
          db.exec('CREATE TEMP TABLE fictional_shift(x)');
          break;
        case 'registry':
          clearIntakeCollectionCache(db);
          break;
        case 'profile':
          db.exec("UPDATE app_meta SET value='fictional-other' WHERE key='owner_profile_id'");
          break;
        case 'accepted-HEAD':
          authority.objects.set('head', Buffer.from('{}'));
          break;
        case 'projection':
          clearIntakeLookupCache(db);
          break;
        case 'cancel':
          cancelled = true;
      }
    };
    const hook = mutateAtPage(db, 'final', mutate);
    try {
      await assert.rejects(
        prepareIntakeLookupIndices(db, {
          assertRunning: () => {
            if (cancelled) throw Error('fictional cancellation');
          },
        }),
        mutation === 'cancel'
          ? /fictional cancellation/
          : mutation === 'accepted-HEAD'
            ? /Record journal: invalid head/
            : /frontier changed/,
      );
      await hook.assertFired();
      assert.equal(preparedIntakeLookupReadToken(db), undefined);
    } finally {
      hook.restore();
    }
  });
}

test('exact unsafe rowids are paged without rounding before the existing projection refusal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-bigint-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  transaction(db, () => {
    for (let index = 0; index < 3; index++)
      registerRawIntakeFixture(
        db,
        `fictional-${index}`,
        JSON.stringify({ intake: { version: 0 } }),
      );
    db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(-9007199254740993n, 'fictional-0');
    db.prepare('UPDATE source_files SET rowid=? WHERE id=?').run(9007199254740993n, 'fictional-2');
  });
  const expected = intakeDiscoveryRevision(db);
  const prepare = DatabaseSync.prototype.prepare;
  const get = StatementSync.prototype.get;
  const selected = new WeakSet<StatementSync>();
  const rows: Array<{ id: string; rowid: bigint }> = [];
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (this === db && sql.includes('lookup_rowid')) selected.add(statement);
    return statement;
  };
  StatementSync.prototype.get = function (
    this: StatementSync,
    ...parameters: Parameters<StatementSync['get']>
  ) {
    const row = Reflect.apply(get, this, parameters);
    if (row && selected.has(this))
      rows.push({ id: String(row.id), rowid: row.lookup_rowid as bigint });
    return row;
  } as typeof StatementSync.prototype.get;
  try {
    await assert.rejects(prepareIntakeLookupIndices(db), /too large to be represented/);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    StatementSync.prototype.get = get;
  }
  assert.deepEqual(rows, [
    { id: 'fictional-0', rowid: -9007199254740993n },
    { id: 'fictional-1', rowid: 2n },
    { id: 'fictional-2', rowid: 9007199254740993n },
  ]);
  assert.equal(intakeDiscoveryRevision(db), expected);
  assert.equal(preparedIntakeLookupReadToken(db), undefined);
});
