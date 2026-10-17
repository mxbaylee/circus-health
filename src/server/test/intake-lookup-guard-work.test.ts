import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { openDatabase, transaction } from '../database.ts';
import { clearIntakeStateCache, createIntakeStateStorage } from '../intake-state-storage.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import {
  prepareIntakeLookupIndices,
  preparedIntakeLookupReadToken,
} from '../intake-lookup-state.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  contributorAuthorityPath,
  openContributorRecordStorage,
} from '../contributor-record-storage.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { maximumIntakeDiscoveryOrder } from '../intake-lookup-projection.ts';

async function fixture(t: TestContext, withDiscovery = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fictional-lookup-guard-')));
  const profileId = 'fictional-lookup-guard';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  let closeStorage: (() => void) | undefined;
  t.after(() => {
    try {
      clearIntakeStateCache(db);
      db.close();
    } finally {
      try {
        closeStorage?.();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  const storage = openContributorRecordStorage(root, profileId, { initialize: true });
  closeStorage = () => storage.close();
  const original = Buffer.from('Independently fictional lookup original.');
  const path = paths.relativeRoot + '/sources/fictional.txt';
  writeFileSync(join(root, path), original);
  const identity = {
    profileId,
    intakeId: 'fictional-lookup-original',
    sourceHash: createHash('sha256').update(original).digest('hex'),
  };
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, path, identity.sourceHash, original.length, 'intake_original', '{}');
  attachRecordDurability(db, { profileId, storage });
  const f = { root, db, storage, identity };
  const initial = prepareInitialIntakeEnvelope({
    intake: {
      version: 1,
      originalName: 'fictional.txt',
      state: 'ready',
      ...(withDiscovery && {
        workflow: {
          reportGroups: [{ discoveryOrder: 7 }],
        },
      }),
    },
  });
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(initial.detailsJson, f.identity.intakeId);
    createIntakeStateStorage(f.db, f.identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(f.db, {
    id: f.identity.intakeId,
    sha256: f.identity.sourceHash,
  });
  return f;
}

test('retained lookup root publishes and reuses a genuine discovery index', async (t) => {
  const f = await fixture(t, true);
  const built = await prepareIntakeLookupIndices(f.db);
  assert.equal(built.prepared, 1);
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
  assert.notEqual(preparedIntakeLookupReadToken(f.db), undefined);
  const reused = await prepareIntakeLookupIndices(f.db, {
    onCheckpoint() {
      throw Error('fictional current index unexpectedly rebuilt');
    },
  });
  assert.equal(reused.prepared, 0);
  assert.equal(reused.reused, 1);
  assert.equal(reused.discoveryRevision, built.discoveryRevision);
  assert.equal(maximumIntakeDiscoveryOrder(f.db), 7);
});

test('lookup admission retains its root handle while every bounded policy check still runs', async (t) => {
  const f = await fixture(t);
  const head = f.storage.read('head');
  const work = createRecordVersionWorkCounters();
  const checks = 256;
  let calls = 0;
  await assert.rejects(
    withRecordVersionWork(work, () =>
      prepareIntakeLookupIndices(f.db, {
        assertRunning() {
          if (++calls === checks) throw Error('fictional bounded cancellation');
        },
      }),
    ),
    /fictional bounded cancellation/,
  );
  assert.equal(calls, checks);
  // Count a finite admission prefix, including its genuine storage checks.
  // Resolving the root again for each nested guard exceeds this allowance.
  assert.ok(
    work.operation.headReadCalls <= 3 * checks,
    `${work.operation.headReadCalls} HEAD reads for ${checks} policy checks`,
  );
  assert.deepEqual(f.storage.read('head'), head);
  assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
  t.diagnostic(JSON.stringify({ checks, headReadCalls: work.operation.headReadCalls }));
});

for (const fault of ['source', 'SQL', 'HEAD', 'methods'] as const)
  test(`retained lookup root refuses a restored ${fault} mutation during admission`, async (t) => {
    const f = await fixture(t);
    const headPath = join(contributorAuthorityPath(f.root, f.identity.profileId), 'head');
    const head = readFileSync(headPath);
    let fired = false;
    await assert.rejects(
      prepareIntakeLookupIndices(f.db, {
        assertRunning() {
          if (fired || !new Error().stack?.includes('admitLogAsync')) return;
          fired = true;
          if (fault === 'HEAD') {
            const bytes = readFileSync(headPath);
            writeFileSync(headPath, bytes);
            writeFileSync(headPath, bytes);
          } else if (fault === 'methods') {
            f.db.setAuthorizer(() => 0);
            f.db.setAuthorizer(null);
          } else if (fault === 'source') {
            const raw = f.db
              .prepare('SELECT details_json FROM source_files WHERE id=?')
              .get(f.identity.intakeId)!.details_json;
            const update = f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?');
            update.run('{}', f.identity.intakeId);
            update.run(raw!, f.identity.intakeId);
          } else {
            f.db.exec('CREATE TEMP TABLE fictional_lookup_attempt(value TEXT)');
            f.db.exec('DROP TABLE fictional_lookup_attempt');
          }
        },
      }),
      /authority changed|interval changed|owner changed|source changed|not.*current|unavailable/i,
    );
    assert.equal(fired, true);
    assert.equal(preparedIntakeLookupReadToken(f.db), undefined);
    assert.deepEqual(readFileSync(headPath), head);
  });
