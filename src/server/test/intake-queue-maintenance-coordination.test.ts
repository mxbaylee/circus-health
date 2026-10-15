import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { listIntakeReportQueue } from '../intake-report-queue.ts';
import { withAcceptedNativeIntakeSourceFormat } from '../intake-accepted-source-format.ts';
import {
  getIntakePeopleQueueRead,
  getIntakeReportQueueGroupRead,
  listIntakeReportQueueRead,
  prepareCollectionQueueRead,
} from '../intake-queue-native.ts';
import { runExclusiveClinicalOperation } from '../clinical-operation.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function fixture(t: test.TestContext, native = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-queue-maintenance-'))),
    profileId = 'fictional-queue-maintenance',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional-report.jsonl',
    newProviderName: 'Fictional clinic',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-report-record',
        kind: 'document',
        payload: { text: 'Independently fictional queue report.' },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional clinic',
          sourceRecordId: 'fictional-report-record',
          evidenceClass: 'provider_export',
          locator: 'page 1',
        },
        coverage: { status: 'complete_response', notes: [] },
        clinical: {
          kind: 'document',
          subject: 'unknown',
          documentTitle: 'Fictional report',
          date: '2026-01-01',
        },
      }),
    ),
  });
  const groupId = listIntakeReportQueue(db, root, profileId).groups[0]!.groupId;
  if (native) await buildIntakeCollectionEnvelope(db, { id: source.id, sha256: source.sha256 });
  return { db, root, profileId, source, groupId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function interval(f: Fixture) {
  return {
    changes: Number(f.db.prepare('SELECT total_changes() AS n').get()!.n),
    schema: Number(f.db.prepare('PRAGMA temp.schema_version').get()!.schema_version),
    transitions: Number(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM temp.sqlite_schema WHERE name LIKE '__intake_queue_transitions%'",
        )
        .get()!.n,
    ),
  };
}

const reads = {
  page: (f: Fixture) => listIntakeReportQueueRead(f.db, f.root, f.profileId, { view: 'all' }),
  group: (f: Fixture) =>
    getIntakeReportQueueGroupRead(f.db, f.root, f.profileId, f.groupId, { view: 'all' }),
  people: (f: Fixture) => getIntakePeopleQueueRead(f.db, f.root, f.profileId, f.groupId),
  // Fragment, coverage and records readers enter this same preparation function.
  preparation: (f: Fixture) => prepareCollectionQueueRead(f.db, f.root, f.profileId),
};

for (const native of [false, true])
  for (const [name, read] of Object.entries(reads).filter(
    ([name]) => native || name !== 'preparation',
  ))
    test(`cold ${native ? 'native' : 'legacy'} ${name} queue maintenance waits for a real accepted proof`, async (t) => {
      const f = await fixture(t, native),
        entered = gate(),
        release = gate();
      assert.equal(interval(f).transitions, 0, 'the fixture has not initialized queue TEMP state');
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
      let done = false;
      const queue = read(f).then((value) => {
        done = true;
        return value;
      });
      const settled = Promise.allSettled([proof, queue]);
      try {
        for (let n = 0; n < 20; n++) await setImmediate();
        assert.equal(done, false, 'queue preparation waits outside the held proof');
        assert.deepEqual(interval(f), before, 'no shared TEMP writes or DDL inside the proof');
        release.resolve();
        assert.equal(await proof, 'legacy');
        const result = await queue;
        assert.deepEqual(
          await read(f),
          result,
          'the completed public response is unchanged on reread',
        );
        assert.ok(interval(f).transitions > 0, 'the cold initializer ran after proof closure');
      } finally {
        release.resolve();
        await settled;
      }
    });

test('an independent queue read cannot block a nested clinical queue read on accepted admission', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    continueOwner = gate(),
    controller = new AbortController();
  const owner = runExclusiveClinicalOperation(
    f.db,
    async () => {
      entered.resolve();
      await continueOwner.promise;
      return reads.page(f);
    },
    { signal: controller.signal },
  );
  await entered.promise;
  let done = false;
  const queued = reads.page(f).then((value) => {
    done = true;
    return value;
  });
  const settled = Promise.allSettled([owner, queued]);
  try {
    await setImmediate();
    assert.equal(done, false);
    continueOwner.resolve();
    assert.deepEqual(await queued, await owner);
  } finally {
    controller.abort(Error('Fictional queue owner cleanup'));
    continueOwner.resolve();
    await settled;
  }
});

test('cancellation while a public report queue waits leaves TEMP untouched and permits recovery', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate(),
    controller = new AbortController(),
    reason = Error('Fictional report queue cancellation');
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
  const queue = listIntakeReportQueueRead(
    f.db,
    f.root,
    f.profileId,
    { view: 'all' },
    { signal: controller.signal },
  );
  const settled = Promise.allSettled([proof, queue]);
  try {
    await setImmediate();
    release.resolve();
    controller.abort(reason);
    await assert.rejects(queue, (error) => error === reason);
    await proof;
    assert.deepEqual(interval(f), before);
  } finally {
    release.resolve();
    await settled;
  }
  assert.deepEqual(
    await reads.page(f),
    listIntakeReportQueue(f.db, f.root, f.profileId, { view: 'all' }),
  );
});
