import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  attachPersonalDurability,
  durableWriteChunksAsync,
  DURABLE_OUTPUT_BUFFER_BYTES,
} from '../portable.ts';
import { openDatabase, transaction, type Database } from '../database.ts';
import { createBackup } from '../recovery.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import {
  contributorCopyComparisonGuardWork,
  contributorCopyCurrentChecks,
  contributorCopyWorkerMessageChecks,
} from '../contributor-durability.ts';
import { createPortableWorkCounters, withPortableWork } from '../portable-work.ts';

test('cooperative durable writer proves its source per yield, not per chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-proof-work-'));
  try {
    const path = join(root, 'portable.json');
    async function* pieces() {
      for (let index = 0; index < 20_000; index++) yield 'fictional' + (index % 10);
    }
    const counters = createPortableWorkCounters();
    let checks = 0;
    await withPortableWork(counters, () =>
      durableWriteChunksAsync(path, pieces(), () => {
        checks++;
      }),
    );
    assert.equal(readFileSync(path, 'utf8').length, 200_000);
    assert.equal(counters.outputChunks, 20_000);
    assert.ok(counters.backupYields >= 3, 'fixture output and readback cross yield quanta');
    // Start, both sides of every yield, and the fixed completion/rename proofs.
    assert.ok(
      checks <= 2 * counters.backupYields + 6,
      `checks ${checks} scale with yields ${counters.backupYields}, not chunks`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cooperative durable writer writes bounded buffers, not one write per chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-output-writes-'));
  const original = fs.writeSync;
  let writes = 0;
  try {
    const path = join(root, 'portable.json');
    async function* pieces() {
      for (let index = 0; index < 20_000; index++) yield 'fictional' + (index % 10);
      yield Buffer.from('x'.repeat(40_000));
    }
    // Physical file writes, counted at the fs boundary the writer calls.
    fs.writeSync = ((...args: Parameters<typeof original>) => {
      writes++;
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    const counters = createPortableWorkCounters();
    await withPortableWork(counters, () => durableWriteChunksAsync(path, pieces(), () => {}));
    fs.writeSync = original;
    syncBuiltinESMExports();
    const text = readFileSync(path, 'utf8');
    assert.equal(text.length, 240_000);
    assert.equal(text.slice(0, 20), 'fictional0fictional1');
    assert.equal(counters.outputChunks, 20_001);
    assert.equal(counters.outputBytes, 240_000);
    // One write per full buffer, plus a partial flush before each yield's
    // proof and at the end; 20,001 before buffering.
    assert.ok(
      writes <= Math.ceil(240_000 / DURABLE_OUTPUT_BUFFER_BYTES) + counters.backupYields + 1,
      `writes ${writes} for ${counters.backupYields} yields`,
    );
    assert.equal(counters.outputWrites, writes);
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

function contributorFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const profileId = 'fictional';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  attachPersonalDurability(db, { root, profileId });
  // Many small fictional rows make many streamed pieces per output quantum.
  transaction(db, () => {
    const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    for (let index = 0; index < 3000; index++)
      insert.run(`fictional:proof-row:${String(index).padStart(5, '0')}`, 'reviewed');
  });
  return { root, profileId, db };
}

function close(db: Database, root: string) {
  if (db.isOpen) db.close();
  rmSync(root, { recursive: true, force: true });
}

test('contributor backup proves copy certification per yield, not per streamed piece', async () => {
  const { root, profileId, db } = contributorFixture('fictional-backup-proof-work-');
  try {
    const counters = createPortableWorkCounters();
    const before = contributorCopyCurrentChecks(db),
      messagesBefore = contributorCopyWorkerMessageChecks(db);
    const receipt = await withPortableWork(counters, () => createBackup(db, root, profileId));
    const checks = contributorCopyCurrentChecks(db) - before,
      // One proof per comparison quantum and per worker message turn; both are
      // the certification's own yields, counted separately from backup output.
      certification =
        contributorCopyComparisonGuardWork(db).fullChecks +
        contributorCopyWorkerMessageChecks(db) -
        messagesBefore;
    assert.ok(existsSync(join(receipt.path, 'portable.json')));
    assert.ok(
      counters.outputChunks > 4 * counters.backupYields,
      `fixture streams many pieces (${counters.outputChunks}) per yield (${counters.backupYields})`,
    );
    // Certification, both sides of each yield, a fixed number of proofs per
    // digested file, per-table reader setup and the publication seal; never
    // one per output piece.
    const files = receipt.files + 8;
    assert.ok(
      checks <= certification + 2 * counters.backupYields + 10 * files + 128,
      `copy proofs ${checks} scale with certification ${certification}, yields ${counters.backupYields} and files ${files}`,
    );
    assert.ok(checks < counters.outputChunks / 2, 'copy proofs are not per streamed piece');
  } finally {
    close(db, root);
  }
});

test('a same-byte HEAD rewrite during yielded backup output is still refused', async () => {
  const { root, profileId, db } = contributorFixture('fictional-backup-head-rewrite-');
  const destination = join(root, 'backup-result');
  const open = fs.openSync,
    write = fs.writeSync;
  let outputFd: number | undefined;
  let rewrite: Promise<void> | undefined;
  let rewritten = false;
  try {
    const head = join(contributorAuthorityPath(root, profileId), 'head');
    fs.openSync = ((...args: Parameters<typeof open>) => {
      const fd = open(...args);
      if (String(args[0]).startsWith(join(destination + '.pending', 'portable.json.pending-')))
        outputFd = fd;
      return fd;
    }) as typeof open;
    fs.writeSync = ((...args: Parameters<typeof write>) => {
      const count = write(...args);
      // Mutate during the actual writer's next host turn, not during setup.
      if (args[0] === outputFd && count > 0 && !rewrite)
        rewrite = setImmediate().then(() => {
          writeFileSync(head, readFileSync(head));
          rewritten = true;
        });
      return count;
    }) as typeof write;
    syncBuiltinESMExports();
    const saving = createBackup(db, root, profileId, destination).then(
      () => undefined,
      (error: unknown) => error,
    );
    const error = await saving;
    await rewrite;
    if (!rewritten && error instanceof Error)
      throw new Error('Backup failed before the output mutation', { cause: error });
    assert.equal(rewritten, true, 'fixture reaches the yielded portable writer');
    assert.ok(error instanceof Error, 'backup refuses the replaced HEAD');
    assert.match(String(error), /changed|physical/i);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(destination + '.pending'), false);
  } finally {
    fs.openSync = open;
    fs.writeSync = write;
    syncBuiltinESMExports();
    await rewrite;
    close(db, root);
  }
});
