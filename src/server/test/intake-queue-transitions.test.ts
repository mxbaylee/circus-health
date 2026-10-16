import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  collectionQueueTransitionEffects,
  prepareCollectionQueueTransitions,
} from '../intake-queue-transitions.ts';

function fixture(t: import('node:test').TestContext, edges: [number, number][]) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  prepareCollectionQueueTransitions(db);
  const put = db.prepare('INSERT INTO __intake_queue_transitions VALUES(?,?,?)');
  const effect = db.prepare('INSERT INTO __intake_queue_transitions_effects VALUES(?,?,?,?,?)');
  for (const [after, before] of edges) {
    put.run('fictional', JSON.stringify({ n: after }), JSON.stringify({ n: before }));
    effect.run('fictional', JSON.stringify({ n: after }), 'proposal', String(after), String(after));
  }
  return db;
}

for (const edges of [
  [
    [2, 1],
    [1, 2],
  ],
  [
    [4, 3],
    [3, 2],
    [2, 1],
    [1, 3],
  ],
] satisfies [number, number][][])
  test(`queue transition refuses a ${edges.length}-row cyclic disposable chain with bounded reads`, (t) => {
    const db = fixture(t, edges);
    const prepare = db.prepare.bind(db);
    let reads = 0;
    db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT before FROM __intake_queue_transitions')) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          assert.ok(++reads <= 32, 'cycle traversal exceeded bounded regression allowance');
          return Reflect.apply(get, statement, args);
        };
      }
      return statement;
    };
    assert.equal(
      collectionQueueTransitionEffects(db, 'fictional', { n: 0 }, { n: edges[0]![0] }),
      undefined,
    );
    assert.ok(reads <= edges.length * 4);
  });

test('queue transitions retain oldest-first effects without a history-length cap', (t) => {
  const db = fixture(
    t,
    Array.from({ length: 257 }, (_, index) => [index + 1, index]),
  );
  const effects = collectionQueueTransitionEffects(db, 'fictional', { n: 0 }, { n: 257 });
  assert.ok(effects);
  assert.deepEqual(
    [...effects].map((effect) => effect.key),
    Array.from({ length: 257 }, (_, index) => String(index + 1)),
  );
});

test('equal queue roots produce no historical effects', (t) => {
  const db = fixture(t, [
    [2, 1],
    [1, 0],
  ]);
  assert.deepEqual([...collectionQueueTransitionEffects(db, 'fictional', { n: 2 }, { n: 2 })!], []);
});

test('missing and self-loop queue transitions select the complete fallback', (t) => {
  const db = fixture(t, [
    [2, 1],
    [4, 4],
  ]);
  assert.equal(collectionQueueTransitionEffects(db, 'fictional', { n: 0 }, { n: 2 }), undefined);
  assert.equal(collectionQueueTransitionEffects(db, 'fictional', { n: 0 }, { n: 4 }), undefined);
});

test('a transition changed to a cycle after selection refuses before yielding effects', (t) => {
  const db = fixture(t, [
    [2, 1],
    [1, 0],
  ]);
  const effects = collectionQueueTransitionEffects(db, 'fictional', { n: 0 }, { n: 2 });
  assert.ok(effects);
  db.prepare('UPDATE __intake_queue_transitions SET before=? WHERE after=?').run(
    JSON.stringify({ n: 2 }),
    JSON.stringify({ n: 1 }),
  );
  assert.throws(() => [...effects], /changed before iteration/);
});
