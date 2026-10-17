import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { freshKey } from '../vault-crypto.ts';
import { openVault } from '../vault-store.ts';
import { attachRecordDurability } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { intakeLogResidencyStats } from '../intake-state-log.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-log-guard-')),
    profileId = 'fictional-log-guard',
    paths = ensureProfileDirectories(root, profileId),
    key = freshKey(),
    vault = openVault({ directory: paths.root, profileId, key, initialize: true }),
    db = openDatabase(paths.database, profileId);
  let state: ReturnType<typeof createIntakeStateStorage> | undefined;
  t.after(() => {
    state?.close();
    if (db.isOpen) db.close();
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  });
  const original = Buffer.from('Independently fictional guard counting original.\n'),
    path = profilePaths(root, profileId).relativeRoot + '/sources/guard.txt',
    identity = { profileId, intakeId: 'fictional-guard-source', sourceHash: sha(original) };
  writeFileSync(join(root, path), original);
  vault.storeFile(path, original);
  vault.publish();
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, path, identity.sourceHash, original.length, 'intake_original', '{}');
  attachRecordDurability(db, { profileId, storage: vault.recordStorage() });
  state = createIntakeStateStorage(db, identity);
  const store = state.collections,
    prepared = await store.prepareAsync(store.openView(), {
      operationId: '00000000-0000-4000-8000-000000000001',
      requestDigest: sha('initial'),
      domainVersion: 0,
      changes: [],
    }),
    receipt = transaction(db, () => store.stage(prepared));
  return { db, vault, identity, store, receipt };
}

test('generic vault admission retains checkpoints without duplicate outer original guard reads', async (t) => {
  const { store, receipt } = await fixture(t);
  const measurements: { phase: string; callbacks: number; headReadCalls: number }[] = [];
  for (const [phase, maximum] of [
    ['owned promotion', 290],
    ['warm reuse', 260],
  ] as const) {
    const work = createRecordVersionWorkCounters();
    let callbacks = 0;
    await withRecordVersionWork(work, async () => {
      await store.admitCurrentLogAsync(() => callbacks++);
      try {
        assert.deepEqual(store.replay(receipt.operationId, sha('initial')), receipt);
        assert.equal(
          store.replay('00000000-0000-4000-8000-000000000002', sha('missing')),
          undefined,
        );
      } finally {
        store.releaseLogAdmission();
      }
    });
    // The original duplicate guard used 308/273 HEAD reads in this fixture.
    // Counts include entry, exit, genuine physical-owner and selected SQL checks.
    assert.ok(work.operation.headReadCalls <= maximum, `${phase}: ${work.operation.headReadCalls}`);
    measurements.push({ phase, callbacks, headReadCalls: work.operation.headReadCalls });
  }
  t.diagnostic(JSON.stringify(measurements));
  const before = intakeLogResidencyStats().activeAdmissions;
  let observedCheckpoints = 0;
  await store.admitCurrentLogAsync(() => observedCheckpoints++);
  const admissionCheckpoints = observedCheckpoints;
  store.releaseLogAdmission();
  assert.ok(admissionCheckpoints > 0);
  t.diagnostic(JSON.stringify({ admissionCheckpoints }));
  for (let failureAt = 1; failureAt <= admissionCheckpoints; failureAt++) {
    let calls = 0;
    await assert.rejects(
      store.admitCurrentLogAsync(() => {
        if (++calls >= failureAt) throw Error('fictional cancelled guard');
      }),
      /fictional cancelled guard/,
      `admission checkpoint ${failureAt}/${admissionCheckpoints}`,
    );
    store.releaseLogAdmission();
    assert.equal(intakeLogResidencyStats().activeAdmissions, before);
    await store.admitCurrentLogAsync();
    try {
      assert.deepEqual(store.replay(receipt.operationId, sha('initial')), receipt);
    } finally {
      store.releaseLogAdmission();
    }
  }
});

for (const fault of ['source SQL', 'selected HEAD SQL', 'physical vault HEAD'] as const)
  test(`generic vault admission refuses ${fault} drift during a caller checkpoint`, async (t) => {
    const { db, vault, identity, store } = await fixture(t);
    const before = intakeLogResidencyStats().activeAdmissions;
    let calls = 0;
    await assert.rejects(
      store.admitCurrentLogAsync(() => {
        if (++calls !== 5) return;
        if (fault === 'source SQL')
          db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
            '{"fictional":"changed"}',
            identity.intakeId,
          );
        else if (fault === 'selected HEAD SQL')
          db.prepare('DELETE FROM app_meta WHERE key=?').run(intakeNamespace(identity) + 'head');
        else {
          vault.storeFile(
            'fictional-unrelated.txt',
            Buffer.from('Fictional physical head advance'),
          );
          vault.publish();
        }
      }),
      /legacy bridge|accepted.*(head|read)|[Vv]ault.*(changed|expired)|record.*(changed|owner)/,
    );
    assert.ok(calls >= 5);
    store.releaseLogAdmission();
    assert.equal(intakeLogResidencyStats().activeAdmissions, before);
  });
