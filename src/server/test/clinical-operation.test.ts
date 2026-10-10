import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { reviewPreparationStamp } from '../clinical-review-maintenance.ts';
import {
  assertClinicalOperation,
  currentClinicalOperation,
  runExclusiveClinicalOperation,
} from '../clinical-operation.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('closing clinical ownership never invokes caller cancellation accessors or methods', async () => {
  const db = new DatabaseSync(':memory:'),
    controller = new AbortController();
  let callbacks = 0;
  try {
    await assert.rejects(
      runExclusiveClinicalOperation(
        db,
        async (owner) => {
          Object.defineProperty(controller.signal, 'aborted', {
            configurable: true,
            get() {
              callbacks++;
              return false;
            },
          });
          Object.defineProperty(controller.signal, 'throwIfAborted', {
            configurable: true,
            value() {
              callbacks++;
            },
          });
          Object.defineProperty(controller.signal, 'reason', {
            configurable: true,
            get() {
              callbacks++;
              return Error('untrusted reason');
            },
          });
          assertClinicalOperation(db, owner);
          assert.equal(callbacks, 0);
          controller.abort();
          assert.throws(() => assertClinicalOperation(db, owner), { name: 'AbortError' });
          assert.equal(callbacks, 0);
          Reflect.deleteProperty(controller.signal, 'aborted');
          Reflect.deleteProperty(controller.signal, 'throwIfAborted');
          Reflect.deleteProperty(controller.signal, 'reason');
        },
        { signal: controller.signal },
      ),
      /abort/i,
    );
  } finally {
    db.close();
  }
});
test('closing clinical ownership preserves the exact native custom cancellation reason', async () => {
  const db = new DatabaseSync(':memory:'),
    controller = new AbortController(),
    reason = Error('fictional subscriber cancellation');
  try {
    await assert.rejects(
      runExclusiveClinicalOperation(
        db,
        async (owner) => {
          controller.abort(reason);
          assert.throws(
            () => assertClinicalOperation(db, owner),
            (error) => error === reason,
          );
        },
        { signal: controller.signal },
      ),
      (error) => error === reason,
    );
    await runExclusiveClinicalOperation(db, async (owner) => assertClinicalOperation(db, owner));
  } finally {
    db.close();
  }
});
test('clinical operations serialize complete owners and preserve sequential nested ownership', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const entered = gate(),
      finish = gate(),
      events: string[] = [];
    const first = runExclusiveClinicalOperation(db, async (owner) => {
      events.push('first');
      entered.resolve();
      await runExclusiveClinicalOperation(
        db,
        async (child) => {
          assertClinicalOperation(db, owner);
          assert.equal(currentClinicalOperation(db), child);
          events.push('nested');
        },
        { operation: owner },
      );
      await finish.promise;
      events.push('finished');
    });
    await entered.promise;
    const second = runExclusiveClinicalOperation(db, async () => {
      events.push('second');
    });
    await setImmediate();
    assert.deepEqual(events, ['first', 'nested']);
    finish.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first', 'nested', 'finished', 'second']);
  } finally {
    db.close();
  }
});
test('queued cancellation and failed owners release the next operation', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const entered = gate(),
      finish = gate(),
      controller = new AbortController();
    const first = runExclusiveClinicalOperation(db, async () => {
      entered.resolve();
      await finish.promise;
      throw Error('owned failure');
    });
    const failed = assert.rejects(first, /owned failure/);
    await entered.promise;
    let canceledRan = false;
    const canceled = runExclusiveClinicalOperation(
      db,
      async () => {
        canceledRan = true;
      },
      { signal: controller.signal },
    );
    const refused = assert.rejects(canceled, /canceled subscriber/);
    controller.abort(Error('canceled subscriber'));
    let nextRan = false;
    const next = runExclusiveClinicalOperation(db, async () => {
      nextRan = true;
    });
    await refused;
    finish.resolve();
    await Promise.all([failed, next]);
    assert.equal(canceledRan, false);
    assert.equal(nextRan, true);
  } finally {
    db.close();
  }
});
test('parallel children, stale owners and transaction admission cannot bypass the queue', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let stale: ReturnType<typeof currentClinicalOperation>;
    await runExclusiveClinicalOperation(db, async (owner) => {
      stale = owner;
      const finish = gate();
      const child = runExclusiveClinicalOperation(
        db,
        async () => {
          await finish.promise;
        },
        { operation: owner },
      );
      await assert.rejects(
        runExclusiveClinicalOperation(db, async () => {}, { operation: owner }),
        /Parallel nested/,
      );
      finish.resolve();
      await child;
    });
    await assert.rejects(
      runExclusiveClinicalOperation(db, async () => {}, { operation: stale }),
      /no longer active/,
    );
    db.exec('BEGIN');
    await assert.rejects(
      runExclusiveClinicalOperation(db, async () => {}),
      /inside a transaction/,
    );
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
});
test('database close refuses queued owners and active proof checks', async () => {
  const db = new DatabaseSync(':memory:');
  const entered = gate(),
    finish = gate();
  const first = runExclusiveClinicalOperation(db, async (owner) => {
    entered.resolve();
    await finish.promise;
    assertClinicalOperation(db, owner);
  });
  const failed = assert.rejects(first, /no longer active/);
  await entered.promise;
  const queued = assert.rejects(
    runExclusiveClinicalOperation(db, async () => {}),
    /no longer active/,
  );
  db.close();
  finish.resolve();
  await Promise.all([failed, queued]);
});
test('detached children drain before the next owner and cannot reuse an expired owner', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    let childStopped = false;
    const outer = runExclusiveClinicalOperation(db, async (owner) => {
      void runExclusiveClinicalOperation(
        db,
        async (child) => {
          await setImmediate();
          assert.throws(() => assertClinicalOperation(db, child), /no longer active/);
          childStopped = true;
        },
        { operation: owner },
      ).catch(() => undefined);
    });
    const refused = assert.rejects(outer, /not awaited/);
    const next = runExclusiveClinicalOperation(db, async () => {
      assert.equal(childStopped, true);
    });
    await Promise.all([refused, next]);
  } finally {
    db.close();
  }
});
test('coordination never forgives unfenced main writes followed by rollback', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE evidence(value);INSERT INTO evidence VALUES(1)');
    const entered = gate(),
      finish = gate();
    const read = runExclusiveClinicalOperation(db, async () => {
      const before = reviewPreparationStamp(db);
      entered.resolve();
      await finish.promise;
      assert.notEqual(reviewPreparationStamp(db), before);
      assert.equal(db.prepare('SELECT value FROM evidence').get()!.value, 1);
    });
    await entered.promise;
    db.exec('BEGIN;UPDATE evidence SET value=2;ROLLBACK');
    finish.resolve();
    await read;
  } finally {
    db.close();
  }
});
test('a result abandoned by final microtask cancellation is disposed before another owner enters', async () => {
  const db = new DatabaseSync(':memory:');
  const scratch = new DatabaseSync(':memory:');
  const controller = new AbortController();
  let disposed = 0;
  try {
    const result = runExclusiveClinicalOperation(
      db,
      async (owner) => {
        return runExclusiveClinicalOperation(
          db,
          async () => {
            // The producer's final synchronous check can arrange cancellation
            // before the coordinator resumes its awaited resource handoff.
            queueMicrotask(() => controller.abort(Error('handoff canceled')));
            return scratch;
          },
          {
            operation: owner,
            onDiscardResult(value) {
              disposed++;
              value.close();
            },
          },
        );
      },
      { signal: controller.signal },
    );
    const refused = assert.rejects(result, /handoff canceled/);
    const next = runExclusiveClinicalOperation(db, async () => {
      assert.equal(scratch.isOpen, false);
      assert.equal(disposed, 1);
    });
    await Promise.all([refused, next]);
  } finally {
    if (scratch.isOpen) scratch.close();
    db.close();
  }
});
test('caller authority checks can assert their operation without recursively invoking themselves', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    await runExclusiveClinicalOperation(db, async (owner) => {
      await runExclusiveClinicalOperation(
        db,
        async (child) => {
          assertClinicalOperation(db, child);
          assertClinicalOperation(db, owner);
        },
        { operation: owner, assertRunning: () => assertClinicalOperation(db, owner) },
      );
    });
  } finally {
    db.close();
  }
});
