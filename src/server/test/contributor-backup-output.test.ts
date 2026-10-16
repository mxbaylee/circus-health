import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  databaseSchemaVersion,
  transaction,
  installManagedDatabaseAuthorization,
  installManagedDatabaseFunctionRegistration,
  type Database,
} from '../database.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
import * as durability from '../contributor-durability.ts';
import { intakeCopyNativeSqlite } from '../intake-copy-native-sqlite.ts';
import { createBackup } from '../recovery.ts';
import { createIntakeCopyIncrementalReaderFromPortableBackup } from '../intake-copy-incremental-reader.ts';
import { intakeCopySerializedRowKeySteps } from '../intake-copy-json.ts';
import * as portable from '../portable.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-joint-backup-'));
  const databases = new Map<string, Database>();
  const lifecycle = createProfileLifecycle({ root, databases });
  t.after(() => {
    lifecycle.close();
    for (const db of databases.values()) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const profile = await lifecycle.create({
    name: 'Fictional joint backup',
    fullName: 'Fictional joint backup',
    birthDate: '1980-02-17',
  });
  const source = databases.get(profile.id)!;
  transaction(source, () => {
    const insert = source.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    insert.run(
      'fictional:escaped',
      ('Fictional "\\\n\0 text ' + String.fromCodePoint(0x1f680) + 'x'.repeat(4094)).repeat(40),
    );
    insert.run('fictional:integer', 42);
    insert.run('fictional:real', 1.25);
  });
  const stage = join(root, 'output');
  mkdirSync(stage);
  const snapshotPath = join(stage, 'database.sqlite');
  await backup(source, snapshotPath);
  const normalized = new DatabaseSync(snapshotPath);
  normalized.prepare('PRAGMA journal_mode=DELETE').get();
  normalized.close();
  const snapshot = managedSnapshot(snapshotPath);
  t.after(() => {
    if (snapshot.isOpen) snapshot.close();
  });
  return {
    root,
    source,
    snapshot,
    snapshotPath,
    profileId: profile.id,
    output: join(stage, 'portable.json'),
  };
}

function managedSnapshot(path: string) {
  const snapshot = new DatabaseSync(path, { readOnly: true });
  installManagedDatabaseFunctionRegistration(snapshot);
  installManagedDatabaseAuthorization(snapshot);
  return snapshot;
}

function expectedPortable(snapshot: Database, profileId: string) {
  const reader = createIntakeCopyIncrementalReaderFromPortableBackup(snapshot, () => {});
  const tables: string[] = [];
  let rows = 0;
  try {
    for (const table of reader.tables()) {
      const columns = reader.columns(table);
      const values: string[] = [];
      for (const id of reader.rowIds(table)) {
        values.push([...reader.rowPieces(table, id, columns, 'select')].join(''));
        rows++;
      }
      tables.push(JSON.stringify(table) + ':[' + values.join(',') + ']');
    }
  } finally {
    reader.close();
  }
  return {
    rows,
    text:
      JSON.stringify({
        format: 'circus-health-portable-v1',
        profileId,
        schemaVersion: databaseSchemaVersion(snapshot),
      }).slice(0, -1) +
      ',"tables":{' +
      tables.join(',') +
      '}}',
  };
}

test('public backup emits exact SELECT-order bytes from its compared backup rows', async (t) => {
  const f = await fixture(t);
  const expected = expectedPortable(f.snapshot, f.profileId);
  const result = await createBackup(f.source, f.root, f.profileId);
  assert.equal(readFileSync(join(result.path, 'portable.json'), 'utf8'), expected.text);
  const work =
    typeof durability.contributorCopyPortableSnapshotWork === 'function'
      ? durability.contributorCopyPortableSnapshotWork(f.source)
      : { rows: 0, bytes: 0 };
  assert.equal(work.rows, expected.rows, 'each output row is emitted by the three-way comparison');
  assert.ok(work.bytes > 160 * 1024);
  const traversal = durability.contributorCopyComparisonTraversalWork(f.source);
  assert.equal(traversal.backupRows, traversal.sourceRows);
  assert.equal(traversal.selectedRows, traversal.sourceRows);
});

test('public backup preserves its stage failure boundary and the retained output cause', async (t) => {
  const f = await fixture(t);
  const destination = join(f.root, 'terminal-backup');
  const post = Worker.prototype.postMessage;
  let resume: (() => void) | undefined;
  let notify!: () => void;
  const paused = new Promise<void>((resolve) => {
    notify = resolve;
  });
  try {
    Worker.prototype.postMessage = function (message, ...args) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'verify' &&
        existsSync(join(destination + '.pending', 'manifest.json'))
      ) {
        resume = () => Reflect.apply(post, this, [message, ...args]);
        notify();
        return;
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
    const saving = createBackup(f.source, f.root, f.profileId, destination);
    await Promise.race([
      paused,
      saving.then(() => {
        throw Error('Backup finished before terminal pause');
      }),
    ]);
    fs.appendFileSync(join(destination + '.pending', 'portable.json'), '!');
    resume!();
    resume = undefined;
    await assert.rejects(saving, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Backup stage changed before publication');
      assert.ok(error.cause instanceof portable.DurableChunkArtifactChangedError);
      assert.equal(error.cause.message, 'Portable backup retained output changed');
      return true;
    });
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(destination + '.pending'), false);
  } finally {
    resume?.();
    Worker.prototype.postMessage = post;
  }
});

test('joint certificate retains exact bytes and refuses same-byte output replacement after snapshot close', async (t) => {
  const f = await fixture(t);
  const expected = expectedPortable(f.snapshot, f.profileId);
  const cert = await durability.prepareContributorBackupCertification(
    f.source,
    f.root,
    f.profileId,
    f.snapshot,
    f.output,
  );
  try {
    assert.equal(readFileSync(f.output, 'utf8'), expected.text);
    f.snapshot.close();
    durability.assertContributorCopyCertificationCurrent(cert);
    const replacement = f.output + '.replacement';
    copyFileSync(f.output, replacement);
    renameSync(replacement, f.output);
    assert.throws(
      () => durability.assertContributorCopyCertificationCurrent(cert),
      portable.DurableChunkArtifactChangedError,
    );
    await assert.rejects(
      durability.verifyContributorCopyCertificationForPublication(cert),
      /changed/,
    );
  } finally {
    await durability.disposeContributorCopyCertification(cert);
    await durability.disposeContributorCopyCertification(cert);
  }
});

test('joint comparison refuses a divergent backup and removes unpublished output', async (t) => {
  const f = await fixture(t);
  f.snapshot.close();
  const changed = new DatabaseSync(f.snapshotPath);
  changed
    .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
    .run('fictional:extra', 'Fictional unmatched row');
  changed.close();
  const snapshot = managedSnapshot(f.snapshotPath);
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        snapshot,
        f.output,
      ),
      /conflicts/,
    );
    assert.equal(existsSync(f.output), false);
    assert.equal(
      readdirSync(dirname(f.output)).some((name) => name.startsWith('portable.json.pending-')),
      false,
    );
  } finally {
    snapshot.close();
  }
});

test('a microtask source mutation during output pulls cannot issue a certificate', async (t) => {
  const f = await fixture(t);
  const native = intakeCopyNativeSqlite();
  const read = native.blobRead;
  let scheduled = false;
  native.blobRead = (...args) => {
    if (!scheduled && durability.contributorCopyPortableSnapshotWork(f.source).rows > 0) {
      scheduled = true;
      queueMicrotask(() =>
        f.source
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional:microtask', 'Fictional changed source'),
      );
    }
    return read(...args);
  };
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        f.snapshot,
        f.output,
      ),
      /changed|conflicts/,
    );
    assert.equal(scheduled, true);
    assert.equal(existsSync(f.output), false);
    assert.equal(
      readdirSync(dirname(f.output)).some((name) => name.startsWith('portable.json.pending-')),
      false,
    );
  } finally {
    native.blobRead = read;
  }
});

test('actual host-yield cancellation during output closes and removes staged output', async (t) => {
  const f = await fixture(t);
  const native = intakeCopyNativeSqlite();
  const read = native.blobRead;
  const controller = new AbortController();
  let scheduled = false;
  native.blobRead = (...args) => {
    if (!scheduled && durability.contributorCopyPortableSnapshotWork(f.source).rows > 0) {
      scheduled = true;
      setImmediate(() => controller.abort(Error('Fictional joint output cancellation')));
    }
    return read(...args);
  };
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        f.snapshot,
        f.output,
        controller.signal,
      ),
      /Fictional joint output cancellation/,
    );
    assert.equal(scheduled, true);
    assert.equal(existsSync(f.output), false);
    assert.equal(
      readdirSync(dirname(f.output)).some((name) => name.startsWith('portable.json.pending-')),
      false,
    );
  } finally {
    native.blobRead = read;
  }
});

test('retained writer proves byte identity, refuses replacement, and cleans arbitrary pull errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'portable.json');
  const text = ('Fictional ' + String.fromCodePoint(0x1f680) + ' output').repeat(20_000);
  const artifact = await portable.durableWriteRetainedChunksAsync(
    path,
    (async function* () {
      yield text;
    })(),
    () => {},
  );
  assert.equal(readFileSync(path, 'utf8'), text);
  portable.assertDurableChunkArtifactCurrent(artifact);
  copyFileSync(path, path + '.replacement');
  renameSync(path + '.replacement', path);
  assert.throws(() => portable.assertDurableChunkArtifactCurrent(artifact), /changed/);
  portable.disposeDurableChunkArtifact(artifact);
  portable.disposeDurableChunkArtifact(artifact);
  assert.throws(() => portable.assertDurableChunkArtifactCurrent(artifact), /changed/);
  const failed = join(root, 'failed.json');
  await assert.rejects(
    portable.durableWriteRetainedChunksAsync(
      failed,
      (async function* () {
        yield 'Fictional first piece';
        throw Error('Fictional pull error');
      })(),
      () => {},
    ),
    /Fictional pull error/,
  );
  assert.equal(existsSync(failed), false);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith('failed.json.pending-')),
    false,
  );
});

test('retained writer refuses same-size overwrite with restored mtime inside installation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-retained-rename-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'portable.json');
  const link = fs.linkSync;
  let changed = false;
  fs.linkSync = (from, to) => {
    link(from, to);
    if (String(to) === path) {
      const stat = fs.statSync(path);
      const bytes = fs.readFileSync(path);
      bytes[0] = bytes[0] === 65 ? 66 : 65;
      fs.writeFileSync(path, bytes);
      fs.utimesSync(path, stat.atime, stat.mtime);
      changed = true;
    }
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      portable.durableWriteRetainedChunksAsync(
        path,
        (async function* () {
          yield 'Fictional retained output';
        })(),
        () => {},
      ),
      /changed/,
    );
    assert.equal(changed, true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    fs.linkSync = link;
    syncBuiltinESMExports();
  }
});

test('joint admission failure preserves an output sentinel created before writer admission', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const sentinel = 'Fictional unowned pre-writer sentinel';
  const callback = new Promise<void>((resolve) =>
    setImmediate(() => {
      fs.writeFileSync(f.output, sentinel);
      controller.abort(Error('Fictional pre-writer cancellation'));
      resolve();
    }),
  );
  await assert.rejects(
    durability.prepareContributorBackupCertification(
      f.source,
      f.root,
      f.profileId,
      f.snapshot,
      f.output,
      controller.signal,
    ),
    /Fictional pre-writer cancellation/,
  );
  await callback;
  assert.equal(readFileSync(f.output, 'utf8'), sentinel);
});

test('retained installation cannot overwrite an output sentinel appearing during a yield', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-no-clobber-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'portable.json');
  const sentinel = 'Fictional unowned destination';
  await assert.rejects(
    portable.durableWriteRetainedChunksAsync(
      path,
      (async function* () {
        yield 'Fictional initial output';
        await new Promise<void>((resolve) =>
          setImmediate(() => {
            fs.writeFileSync(path, sentinel);
            resolve();
          }),
        );
        yield 'Fictional final output';
      })(),
      () => {},
    ),
    /EEXIST/,
  );
  assert.equal(readFileSync(path, 'utf8'), sentinel);
  assert.deepEqual(readdirSync(root), ['portable.json']);
});

test('certificate failure preserves an unowned replacement scheduled at output handoff', async (t) => {
  const f = await fixture(t);
  const close = fs.closeSync;
  let scheduled = false;
  const sentinel = 'Fictional unowned handoff replacement';
  fs.closeSync = (fd) => {
    const held = fs.fstatSync(fd);
    if (!scheduled && existsSync(f.output) && fs.statSync(f.output).ino === held.ino) {
      scheduled = true;
      queueMicrotask(() => {
        fs.writeFileSync(f.output + '.replacement', sentinel);
        renameSync(f.output + '.replacement', f.output);
      });
    }
    close(fd);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        f.snapshot,
        f.output,
      ),
      /changed/,
    );
    assert.equal(scheduled, true);
    assert.equal(readFileSync(f.output, 'utf8'), sentinel);
  } finally {
    fs.closeSync = close;
    syncBuiltinESMExports();
  }
});

test('emitting row keys retain exact SELECT grammar for nonlexical columns, numeric names, scalars and blobs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-joint-row-grammar-'));
  const db = new DatabaseSync(join(root, 'database.sqlite'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    'CREATE TABLE fictional(z TEXT,"2" INTEGER,a BLOB,"0" TEXT,n REAL,missing TEXT); CREATE TABLE empty_table(value TEXT)',
  );
  const text = 'x'.repeat(16_383) + String.fromCodePoint(0x1f680) + '\n\0"\\';
  const insert = db.prepare('INSERT INTO fictional VALUES(?,?,?,?,?,?)');
  for (let row = 0; row < 2; row++)
    insert.run(text, 7, new Uint8Array([0, 127, 255]), 'first', 1.25, null);
  const reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
  try {
    assert.deepEqual([...reader.rowIds('empty_table')], []);
    const columns = reader.columns('fictional');
    assert.deepEqual(columns, ['z', '2', 'a', '0', 'n', 'missing']);
    const expected = JSON.stringify(db.prepare('SELECT * FROM fictional LIMIT 1').get());
    const keys: string[] = [];
    for (const row of reader.rowIds('fictional')) {
      const steps = intakeCopySerializedRowKeySteps(
        reader.rowPieces('fictional', row, columns, 'select'),
        { bytes: 0, parts: 0, rows: 0 },
        true,
      );
      let emitted = '';
      let quanta = 0;
      let key: string;
      for (;;) {
        const next = steps.next();
        if (next.done) {
          key = next.value;
          break;
        }
        if (typeof next.value === 'string') emitted += next.value;
        else quanta++;
      }
      assert.equal(emitted, expected);
      assert.ok(quanta > 0, 'the large escaped field keeps bounded comparison quanta');
      const plain = intakeCopySerializedRowKeySteps(
        reader.rowPieces('fictional', row, columns, 'select'),
      );
      let plainKey: string;
      for (;;) {
        const next = plain.next();
        if (next.done) {
          plainKey = next.value;
          break;
        }
      }
      assert.equal(key, plainKey);
      keys.push(key);
    }
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], 'duplicate values retain multiplicity as separate row visits');
  } finally {
    reader.close();
  }
});

test('bookkeeping differences stay excluded from equality but remain in exact portable output', async (t) => {
  const f = await fixture(t);
  f.snapshot.close();
  const changed = new DatabaseSync(f.snapshotPath);
  changed
    .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
    .run('personal_joint_bookkeeping', 'Fictional backup-only bookkeeping');
  changed.close();
  const snapshot = managedSnapshot(f.snapshotPath);
  try {
    const ordinary = await durability.prepareContributorCopyCertification(
      f.source,
      f.root,
      f.profileId,
      snapshot,
    );
    await durability.disposeContributorCopyCertification(ordinary);
    const expected = expectedPortable(snapshot, f.profileId);
    const cert = await durability.prepareContributorBackupCertification(
      f.source,
      f.root,
      f.profileId,
      snapshot,
      f.output,
    );
    try {
      assert.equal(readFileSync(f.output, 'utf8'), expected.text);
      assert.ok(expected.text.includes('personal_joint_bookkeeping'));
      assert.equal(durability.contributorCopyPortableSnapshotWork(f.source).rows, expected.rows);
      const work = durability.contributorCopyComparisonTraversalWork(f.source);
      assert.equal(work.backupRows, work.sourceRows);
    } finally {
      await durability.disposeContributorCopyCertification(cert);
    }
  } finally {
    snapshot.close();
  }
});

test('original snapshot replacement during output pulls refuses without certifying its clone', async (t) => {
  const f = await fixture(t);
  const native = intakeCopyNativeSqlite();
  const read = native.blobRead;
  let scheduled = false;
  native.blobRead = (...args) => {
    if (!scheduled && durability.contributorCopyPortableSnapshotWork(f.source).rows > 0) {
      scheduled = true;
      queueMicrotask(() => {
        copyFileSync(f.snapshotPath, f.snapshotPath + '.replacement');
        renameSync(f.snapshotPath + '.replacement', f.snapshotPath);
      });
    }
    return read(...args);
  };
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        f.snapshot,
        f.output,
      ),
      /changed/,
    );
    assert.equal(scheduled, true);
    assert.equal(existsSync(f.output), false);
  } finally {
    native.blobRead = read;
  }
});

test('source refusal after private certificate issue removes only its still-owned output', async (t) => {
  const f = await fixture(t);
  const freeze = Object.freeze;
  let scheduled = false;
  Object.freeze = ((value: unknown) => {
    const caller = new Error().stack?.split('\n')[2] ?? '';
    if (
      !scheduled &&
      value &&
      typeof value === 'object' &&
      Reflect.ownKeys(value).length === 0 &&
      /at prepareContributorCopyCertificationInternal /.test(caller)
    ) {
      scheduled = true;
      queueMicrotask(() =>
        f.source
          .prepare('INSERT INTO app_meta(key,value) VALUES(?,?)')
          .run('fictional:certificate-handoff', 'Fictional source changed after private issue'),
      );
    }
    return freeze(value);
  }) as typeof Object.freeze;
  try {
    await assert.rejects(
      durability.prepareContributorBackupCertification(
        f.source,
        f.root,
        f.profileId,
        f.snapshot,
        f.output,
      ),
      /changed/,
    );
    assert.equal(
      scheduled,
      true,
      'the observer targets the private empty certificate issue, not writer emission',
    );
    assert.equal(existsSync(f.output), false);
    assert.equal(
      readdirSync(dirname(f.output)).some((name) => name.startsWith('portable.json.pending-')),
      false,
    );
  } finally {
    Object.freeze = freeze;
  }
});
