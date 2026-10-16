import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertIntakeCopyTransfer,
  assertIntakeCopyTransferTarget,
  createIntakeCopyTransfer,
} from '../intake-copy-transfer.ts';
import { currentTransactionToken, transaction } from '../database.ts';

test('private copy transfer stages bounded text into an exact unpublished transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-copy-transfer-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  db.exec('PRAGMA main.synchronous=EXTRA');
  const transfer = createIntakeCopyTransfer(() => {});
  assertIntakeCopyTransfer(transfer);
  assert.throws(() => assertIntakeCopyTransfer({ ...transfer }), /identity changed/);
  const details = JSON.stringify({ fictionalText: 'Ω🙂'.repeat(24_000) });
  try {
    db.exec(`
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT NOT NULL,details_json TEXT NOT NULL);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      INSERT INTO app_meta VALUES('intake_state_fictional','before');
      INSERT INTO app_meta VALUES('intake_source_text:v1:fictional:revision:00000000-0000-0000-0000-000000000001','old');
    `);
    db.prepare('INSERT INTO source_files VALUES(?,?,?)').run(
      'fictional',
      'intake_original',
      details,
    );
    await transfer.put('originals', 'fictional', () => [details]);
    await transfer.put('source', 'intake_state_fictional', () => ['before']);
    await transfer.put('prepared', 'intake_state_fictional', () => ['after']);
    const revisionKey =
      'intake_source_text:v1:fictional:revision:00000000-0000-0000-0000-000000000001';
    transfer.putSync('revision-before', revisionKey, () => ['old']);
    transfer.putSync('revision-after', revisionKey, () => ['new']);
    const work = transfer.work();
    assert.equal(work.values, 5);
    assert.ok(work.chunks > 1 && work.maxChunk <= 16 * 1024);
    assert.ok(work.bytes >= Buffer.byteLength(details));
    transfer.seal();

    assert.throws(
      () =>
        transaction(db, () => {
          transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
            assertIntakeCopyTransferTarget(target, transfer, db, currentTransactionToken(db)!);
            assert.throws(
              () =>
                assertIntakeCopyTransferTarget(
                  { ...target },
                  transfer,
                  db,
                  currentTransactionToken(db)!,
                ),
              /identity changed/,
            );
            assert.throws(
              () =>
                db
                  .prepare(
                    "UPDATE __intake_copy_transfer.transfer SET value='changed' WHERE kind='source'",
                  )
                  .run(),
              /readonly|read-only|write/i,
              'the sealed staging file is never writable through the target',
            );
            target.assertOriginalDetails();
            target.applyRevisions();
            target.applyState();
          });
          throw Error('fictional late abort');
        }),
      /fictional late abort/,
    );
    transfer.assertReleased();
    assert.equal(db.prepare('PRAGMA main.synchronous').get()!.synchronous, 3);
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value,
      'old',
    );
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='intake_state_fictional'").get()!.value,
      'before',
    );

    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
        target.assertOriginalDetails();
        target.applyRevisions();
        target.applyState();
        target.assertOriginalDetails();
        target.assertInventory('prepared');
      });
    });
    transfer.assertReleased();
    assert.equal(db.prepare('PRAGMA main.synchronous').get()!.synchronous, 3);
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value,
      'new',
    );
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='intake_state_fictional'").get()!.value,
      'after',
    );

    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('tampered', revisionKey);
          transfer.withTarget(db, currentTransactionToken(db)!, (target) =>
            target.applyRevisions(),
          );
        }),
      /revision preimage changed/,
    );
    transfer.assertReleased();
    assert.equal(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(revisionKey)!.value,
      'new',
    );
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('interrupted disposable transfer cannot be sealed or reused', async () => {
  const transfer = createIntakeCopyTransfer(() => {});
  let reads = 0;
  try {
    await assert.rejects(
      transfer.put('source', 'intake_state_fictional', function* () {
        reads++;
        yield 'fictional first part';
        if (reads === 2) throw Error('fictional interrupted scratch write');
      }),
      /fictional interrupted scratch write/,
    );
    assert.equal(reads, 2);
    assert.throws(() => transfer.seal(), /seal changed/);
    await assert.rejects(
      transfer.put('source', 'intake_state_fictional', () => ['replacement']),
      /admission changed/,
    );
  } finally {
    transfer.close();
  }
});

test('private copy transfer refuses post-seal edits to its fictional scratch file', async () => {
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('health-copy-transfer-')),
  );
  const transfer = createIntakeCopyTransfer(() => {});
  try {
    await transfer.put('source', 'intake_state_fictional', () => ['fictional value']);
    transfer.seal();
    const created = readdirSync(tmpdir()).filter(
      (name) => name.startsWith('health-copy-transfer-') && !before.has(name),
    );
    assert.equal(created.length, 1, 'the isolated fictional transfer directory is identified');
    const path = join(tmpdir(), created[0]!, 'transfer.sqlite');
    chmodSync(path, 0o600);
    const fd = openSync(path, 'r+');
    try {
      writeSync(fd, Buffer.from('x'), 0, 1, 0);
    } finally {
      closeSync(fd);
    }
    assert.throws(() => transfer.assertReleased(), /Copy transfer file changed/);
  } finally {
    transfer.close();
  }
});

// Counted spool work: each complete value is written once and read back once.
// A second whole-value TEXT rewrite inside the spool would leave its freed
// pages behind, so the sealed file size distinguishes it physically.
test('private copy transfer writes and reads back each giant value exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-copy-transfer-once-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const prepare = DatabaseSync.prototype.prepare,
    prepared: string[] = [];
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    prepared.push(sql);
    return Reflect.apply(prepare, this, [sql]);
  } as typeof prepare;
  let transfer: ReturnType<typeof createIntakeCopyTransfer>;
  try {
    transfer = createIntakeCopyTransfer(() => {});
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  const spoolStatements = prepared.length;
  const giant = 'Fictional giant retained value Ω🙂 '.repeat(90_000);
  const bytes = Buffer.byteLength(giant);
  try {
    assert.ok(bytes > 3 * 1024 * 1024);
    db.exec(`
      CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT NOT NULL,details_json TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('intake_state_fictional', 'before');
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      prepared.push(sql);
      return Reflect.apply(prepare, this, [sql]);
    } as typeof prepare;
    try {
      await transfer.put('source', 'intake_state_fictional', () => ['before']);
      await transfer.put('prepared', 'intake_state_fictional', () => [giant]);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    // Admission compiles its one insert up front; no per-value SQL rewrites the spool.
    assert.deepEqual(prepared.slice(spoolStatements), []);
    transfer.seal();
    const work = transfer.work();
    assert.equal(work.bytes, bytes + Buffer.byteLength('before'));
    assert.equal(work.readbackBytes, work.bytes);
    assert.ok(
      work.sealedFileBytes < bytes * 1.25,
      `sealed spool ${work.sealedFileBytes} bytes for ${bytes} value bytes`,
    );
    transaction(db, () =>
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => target.applyState()),
    );
    transfer.assertReleased();
    const row = db
      .prepare(
        "SELECT typeof(value) AS type, value FROM app_meta WHERE key='intake_state_fictional'",
      )
      .get()!;
    assert.equal(row.type, 'text');
    assert.equal(row.value, giant);
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
