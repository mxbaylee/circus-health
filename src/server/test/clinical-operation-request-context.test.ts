import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { assertClinicalOperation, runExclusiveClinicalOperation } from '../clinical-operation.ts';

test('queued clinical work retains its own request context after the previous request expires', async () => {
  const db = new DatabaseSync(':memory:');
  const requests = new AsyncLocalStorage<{ id: string; active: boolean }>();
  const first = { id: 'fictional-first', active: true };
  const second = { id: 'fictional-second', active: true };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: string[] = [];
  try {
    const firstWork = requests.run(first, () =>
      runExclusiveClinicalOperation(db, async () => {
        assert.equal(requests.getStore(), first);
        await gate;
        first.active = false;
      }),
    );
    const secondWork = requests.run(second, () =>
      runExclusiveClinicalOperation(db, async (owner) => {
        assert.equal(requests.getStore(), second);
        assert.equal(requests.getStore()!.active, true);
        observed.push(requests.getStore()!.id);
        await setImmediate();
        assert.equal(requests.getStore(), second);
        await runExclusiveClinicalOperation(
          db,
          async (child) => {
            assert.equal(requests.getStore(), second);
            assertClinicalOperation(db, child);
            assertClinicalOperation(db, owner);
          },
          { operation: owner },
        );
      }),
    );
    const unscopedWork = runExclusiveClinicalOperation(db, async () => {
      assert.equal(requests.getStore(), undefined);
      observed.push('unscoped');
    });
    assert.deepEqual(observed, []);
    release();
    await Promise.all([firstWork, secondWork, unscopedWork]);
    assert.deepEqual(observed, ['fictional-second', 'unscoped']);
  } finally {
    release();
    db.close();
  }
});
