import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { openRecordCommittedColumnReader } from '../record-committed-column-reader.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-committed-opening-')),
    profileId = 'fictional-opening',
    path = ensureProfileDirectories(root, profileId).database,
    db = openDatabase(path, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, path };
}
const peer = (db: DatabaseSync) => db.prepare('PRAGMA data_version').get()!.data_version as number;
const ownCommit = (db: DatabaseSync, value: string) =>
  transaction(db, () =>
    db
      .prepare(
        "INSERT INTO app_meta(key,value) VALUES('fictional_opening',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value),
  );
const foreignCommit = (path: string, value: string) => {
  const other = new DatabaseSync(path);
  try {
    other
      .prepare(
        "INSERT INTO app_meta(key,value) VALUES('fictional_foreign',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value);
  } finally {
    other.close();
  }
};

test('a committed-reader opening never steps the peer counter; a foreign commit does', (t) => {
  const { db, path } = fixture(t);
  ownCommit(db, '1');
  const steps: number[] = [];
  for (let n = 0; n < 3; n++) {
    ownCommit(db, String(n + 2));
    const before = peer(db);
    let atOpen: number | undefined;
    openRecordCommittedColumnReader(db, (phase) => {
      if (phase === 'after-open') atOpen = peer(db);
    }).close();
    steps.push(atOpen! - before, peer(db) - before);
  }
  t.diagnostic(JSON.stringify({ steps }));
  // The snapshot is a node:sqlite connection sharing this process's WAL-index
  // and lock state, so its opening runs no WAL-index recovery: no peer step,
  // and no opening certificate is needed.
  assert.deepEqual(steps, [0, 0, 0, 0, 0, 0]);
  const before = peer(db);
  foreignCommit(path, '1');
  assert.equal(peer(db) - before, 1, 'a foreign commit is a peer change');
});
