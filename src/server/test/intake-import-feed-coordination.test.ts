import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import {
  withAcceptedNativeIntakeSourceFormat,
  withAcceptedSourceMaintenanceAdmission,
} from '../intake-accepted-source-format.ts';
import { listIntakeImportFeed } from '../intake-report-queue.ts';
import { listIntakeImportFeedRead } from '../intake-queue-native.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-feed-coordination-')),
    profileId = 'fictional-feed-coordination',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-feed.txt',
    bytes: Buffer.from('Independently fictional import-feed source.'),
  });
  return { db, root, profileId, source };
}

function interval(f: ReturnType<typeof fixture>) {
  return {
    changes: Number(f.db.prepare('SELECT total_changes() AS n').get()!.n),
    schema: Number(f.db.prepare('PRAGMA temp.schema_version').get()!.schema_version),
  };
}

test('cold feed TEMP preparation waits until a real accepted proof consumer closes', async (t) => {
  const f = fixture(t),
    entered = gate(),
    release = gate();
  const proof = withAcceptedNativeIntakeSourceFormat(
    f.db,
    f.profileId,
    f.source.id,
    () => {},
    async (scope) => {
      entered.resolve();
      await release.promise;
      scope.assertCurrent();
      return scope.format;
    },
  );
  await entered.promise;
  const before = interval(f);
  let feedDone = false;
  const feed = listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' }).then(
    (value) => {
      feedDone = true;
      return value;
    },
  );
  const settled = Promise.allSettled([proof, feed]);
  try {
    for (let n = 0; n < 20; n++) await setImmediate();
    assert.equal(feedDone, false);
    assert.deepEqual(interval(f), before, 'feed performs no shared TEMP work during the proof');
    release.resolve();
    assert.equal(await proof, 'legacy');
    assert.deepEqual(await feed, listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }));
    assert.ok(
      interval(f).schema > before.schema,
      'cold feed TEMP tables are installed after proof',
    );
  } finally {
    release.resolve();
    await settled;
  }
});

test('queued independent feed cannot hold accepted admission ahead of a nested clinical feed', async (t) => {
  const f = fixture(t),
    entered = gate(),
    continueOwner = gate(),
    controller = new AbortController();
  const owner = runExclusiveClinicalOperation(
    f.db,
    async () => {
      entered.resolve();
      await continueOwner.promise;
      return listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' });
    },
    { signal: controller.signal },
  );
  await entered.promise;
  let queuedDone = false;
  const queued = listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' }).then(
    (value) => {
      queuedDone = true;
      return value;
    },
  );
  const settled = Promise.allSettled([owner, queued]);
  try {
    await setImmediate();
    assert.equal(queuedDone, false);
    continueOwner.resolve();
    const first = await owner;
    assert.deepEqual(await queued, first);
    assert.deepEqual(first, listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }));
  } finally {
    controller.abort(Error('Fictional feed owner cleanup'));
    continueOwner.resolve();
    await settled;
  }
});

test('cancelling a feed waiting for accepted admission leaves TEMP untouched and recovers', async (t) => {
  const f = fixture(t),
    entered = gate(),
    release = gate(),
    controller = new AbortController(),
    reason = Error('Fictional import-feed cancellation');
  const proof = withAcceptedNativeIntakeSourceFormat(
    f.db,
    f.profileId,
    f.source.id,
    () => {},
    async (scope) => {
      entered.resolve();
      await release.promise;
      scope.assertCurrent();
    },
  );
  await entered.promise;
  const before = interval(f);
  const feed = runExclusiveClinicalOperation(
    f.db,
    () => listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' }),
    { signal: controller.signal },
  );
  try {
    await setImmediate();
    release.resolve();
    controller.abort(reason);
    await assert.rejects(feed, (error) => error === reason);
    await proof;
    assert.deepEqual(interval(f), before);
  } finally {
    release.resolve();
    await Promise.allSettled([proof, feed]);
  }
  const recovered = await listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' });
  assert.deepEqual(recovered, listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }));
});

test('an aborted feed cannot install TEMP tables when accepted admission wakes', async (t) => {
  const f = fixture(t),
    entered = gate(),
    release = gate(),
    controller = new AbortController(),
    reason = Error('Fictional feed admission wakeup cancellation');
  const predecessor = withAcceptedSourceMaintenanceAdmission(
    f.db,
    () => {},
    async () => {
      entered.resolve();
      await release.promise;
      controller.abort(reason);
    },
  );
  await entered.promise;
  const before = interval(f);
  const feed = runExclusiveClinicalOperation(
    f.db,
    () => listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' }),
    { signal: controller.signal },
  );
  try {
    await setImmediate();
    release.resolve();
    await predecessor;
    await assert.rejects(feed, (error) => error === reason);
    assert.deepEqual(interval(f), before);
  } finally {
    release.resolve();
    await Promise.allSettled([predecessor, feed]);
  }
  const recovered = await listIntakeImportFeedRead(f.db, f.root, f.profileId, { view: 'all' });
  assert.deepEqual(recovered, listIntakeImportFeed(f.db, f.root, f.profileId, { view: 'all' }));
});
