import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import {
  contributorAttachReconstructionWork,
  rebuildContributorDatabase,
  rebuildContributorDatabaseAsync,
} from '../contributor-durability.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import type { RecordStepDriverWork } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';

const profileId = 'fictional-stepwise-owner';
const COMMITS = 160;

/** A contributor profile whose authority holds COMMITS separate fictional
 * transactions, so reconstruction has many replayable steps. It is written
 * once and copied, so each test starts from fresh, unshared inodes. */
let template: string | undefined;
function templateRoot(): string {
  if (template) return template;
  const root = mkdtempSync(join(tmpdir(), 'fictional-stepwise-template-'));
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  try {
    attachPersonalDurability(db, { root, profileId });
    const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
    for (let i = 0; i < COMMITS; i++)
      transaction(db, () => insert.run('fictional-' + i, 'Fictional person ' + i));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  return (template = root);
}
after(() => {
  if (template) rmSync(template, { recursive: true, force: true });
});
function history(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-stepwise-rebuild-'));
  cpSync(templateRoot(), root, { recursive: true });
  const database = ensureProfileDirectories(root, profileId).database;
  const db = openDatabase(database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, db };
}
const counts = (): RecordStepDriverWork => ({ proofs: 0, yields: 0, windows: 0, steps: 0 });
function people(path: string): unknown[] {
  const db = openDatabase(path, profileId);
  try {
    return db.prepare('SELECT id,display_name FROM people ORDER BY id').all();
  } finally {
    db.close();
  }
}
async function hostRequestDuring(rebuild: () => Promise<unknown>) {
  const server = createServer((_request, response) => response.end('fictional-ok'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as AddressInfo;
    const order: string[] = [];
    const request = fetch(`http://127.0.0.1:${port}/`).then(async (response) => {
      assert.equal(await response.text(), 'fictional-ok');
      order.push('request');
    });
    await Promise.all([rebuild().then(() => order.push('rebuild')), request]);
    return order;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test('a host request completes while a large contributor rebuild runs step-wise', async (t) => {
  const f = history(t);
  // Control: the synchronous reconstruction holds the event loop, so the same
  // request cannot complete until the rebuild has finished.
  const blocked = await hostRequestDuring(async () =>
    rebuildContributorDatabase(resolve(f.root, 'sync.sqlite'), f.root, profileId),
  );
  assert.deepEqual(blocked, ['rebuild', 'request']);

  const work = counts();
  const order = await hostRequestDuring(() =>
    rebuildContributorDatabaseAsync(resolve(f.root, 'async.sqlite'), f.root, profileId, { work }),
  );
  assert.deepEqual(order, ['request', 'rebuild']);
  assert.ok(work.yields >= 4, `yielded ${work.yields} times`);
  // A proof opens every window and closes the completed run.
  assert.equal(work.proofs, work.windows + 1);
  assert.deepEqual(people(resolve(f.root, 'async.sqlite')), people(resolve(f.root, 'sync.sqlite')));
  assert.ok(people(resolve(f.root, 'async.sqlite')).length > COMMITS);
});

test('a same-byte HEAD replacement during a step-wise rebuild is refused and leaves no target', async (t) => {
  const f = history(t);
  const head = resolve(contributorAuthorityPath(f.root, profileId), 'head'),
    bytes = readFileSync(head),
    target = resolve(f.root, 'replaced.sqlite'),
    work = counts();
  const rebuild = rebuildContributorDatabaseAsync(target, f.root, profileId, { work });
  while (work.yields === 0) await new Promise((done) => setImmediate(done));
  // Identical bytes on a new inode: content comparison alone would accept it.
  writeFileSync(head + '.fictional-pending', bytes);
  renameSync(head + '.fictional-pending', head);
  assert.deepEqual(readFileSync(head), bytes);
  await assert.rejects(rebuild, /changed during reconstruction/);
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(target + suffix), false);
  assert.ok(work.proofs >= 2, 'the replacement was caught by a later proof');
});

test('step-wise and synchronous rebuilds replay the same record work', async (t) => {
  const f = history(t);
  const sync = createRecordVersionWorkCounters(),
    stepwise = createRecordVersionWorkCounters();
  withRecordVersionWork(sync, () =>
    rebuildContributorDatabase(resolve(f.root, 'sync.sqlite'), f.root, profileId),
  );
  const work = counts();
  await withRecordVersionWork(stepwise, () =>
    rebuildContributorDatabaseAsync(resolve(f.root, 'async.sqlite'), f.root, profileId, { work }),
  );
  assert.ok(sync.reconstruction.commitValidations >= COMMITS);
  // Replay itself is identical: no commit, version or decode is repeated.
  assert.deepEqual(stepwise.reconstruction, sync.reconstruction);
  // The only added work is the starting HEAD binding plus one fresh HEAD
  // read and parse per driver proof.
  const { headReadCalls, headReadBytes, parseCalls, parsedBytes, ...rest } = stepwise.operation;
  assert.equal(headReadCalls, work.proofs + 1);
  assert.equal(parseCalls, work.proofs + 1);
  assert.equal(parsedBytes, headReadBytes);
  const {
    headReadCalls: syncHeadReads,
    headReadBytes: _syncHeadBytes,
    parseCalls: syncParses,
    parsedBytes: _syncParsed,
    ...syncRest
  } = sync.operation;
  assert.equal(syncHeadReads + syncParses, 0);
  assert.deepEqual(rest, syncRest);
});

test('attaching an indexed contributor cache reconstructs once and re-proves every input', (t) => {
  const f = history(t);
  f.db.close();
  const db: Database = openDatabase(f.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
  });
  attachPersonalDurability(db, { root: f.root, profileId });
  const work = contributorAttachReconstructionWork(db);
  // Before reuse: indexed baseline plus a second coherence reconstruction.
  assert.equal(work.reconstructions, 1);
  assert.equal(work.reused, 1);
  assert.ok(work.reverifiedVersions >= COMMITS, `${work.reverifiedVersions} versions re-proved`);
});

test('attaching an indexed contributor cache replays the history into SQLite once', (t) => {
  const f = history(t);
  const single = createRecordVersionWorkCounters();
  withRecordVersionWork(single, () =>
    rebuildContributorDatabase(resolve(f.root, 'single.sqlite'), f.root, profileId),
  );
  f.db.close();
  const db: Database = openDatabase(f.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const attach = createRecordVersionWorkCounters();
  withRecordVersionWork(attach, () => attachPersonalDurability(db, { root: f.root, profileId }));
  assert.ok(single.reconstruction.replayInsertAttempts >= COMMITS);
  // 9b1bcc0 replayed twice here (indexed baseline, then coherence).
  assert.equal(
    attach.reconstruction.replayInsertAttempts,
    single.reconstruction.replayInsertAttempts,
  );
  // Every commit is still validated again by the input re-proof.
  assert.ok(attach.reconstruction.commitValidations >= 2 * COMMITS);
});

test('a stale cache that must catch up still takes a full coherence reconstruction', (t) => {
  const f = history(t);
  const stale = resolve(f.root, 'stale.sqlite');
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(f.database, stale);
  transaction(f.db, () =>
    f.db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run('fictional-late', 'Late'),
  );
  f.db.close();
  rmSync(f.database, { force: true });
  for (const suffix of ['-wal', '-shm']) rmSync(f.database + suffix, { force: true });
  renameSync(stale, f.database);
  const db: Database = openDatabase(f.database, profileId);
  t.after(() => {
    if (db.isOpen) db.close();
  });
  attachPersonalDurability(db, { root: f.root, profileId });
  assert.equal(
    db.prepare("SELECT display_name FROM people WHERE id='fictional-late'").get()?.display_name,
    'Late',
  );
  const work = contributorAttachReconstructionWork(db);
  assert.equal(work.reused, 0);
  assert.equal(work.reconstructions, 2);
});
