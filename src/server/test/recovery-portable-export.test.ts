import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { durableWriteChunksAsync } from '../portable.ts';
import { attachPersonalDurability } from '../portable.ts';
import { openDatabase, transaction } from '../database.ts';
import { createBackup } from '../recovery.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

test('cooperative durable writer preserves exact chunks and cleans a tampered stage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-output-'));
  try {
    const path = join(root, 'portable.json');
    const text = 'a'.repeat(65_535) + '😀' + '\0' + 'Ω'.repeat(16_000);
    const bytes = Buffer.from(text);
    async function* pieces() {
      yield text.slice(0, 65_535);
      yield text.slice(65_535);
    }
    let checks = 0;
    await durableWriteChunksAsync(path, pieces(), () => {
      checks++;
    });
    assert.deepEqual(readFileSync(path), bytes);
    assert.ok(checks > 4);

    const second = join(root, 'tampered.json');
    let edited = false;
    await assert.rejects(
      durableWriteChunksAsync(second, pieces(), () => {
        const pending = readdirSync(root).find((name) => name.startsWith('tampered.json.pending-'));
        if (!edited && pending && statSync(join(root, pending)).size === bytes.length) {
          appendFileSync(join(root, pending), '!');
          edited = true;
        }
      }),
      /staged output changed/,
    );
    assert.equal(edited, true);
    assert.deepEqual(readdirSync(root), ['portable.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cooperative writer refuses an already-read prefix changed during readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-readback-'));
  const path = join(root, 'portable.json');
  const read = fs.readSync;
  let edited = false;
  try {
    fs.readSync = ((...args: unknown[]) => {
      const size = Reflect.apply(read, fs, args) as number;
      const pending = readdirSync(root).find((name) => name.startsWith('portable.json.pending-'));
      if (!edited && args[4] === 0 && size > 0 && pending) {
        const fd = openSync(join(root, pending), 'r+');
        try {
          writeSync(fd, Buffer.from('X'), 0, 1, 0);
        } finally {
          closeSync(fd);
        }
        edited = true;
      }
      return size;
    }) as typeof read;
    syncBuiltinESMExports();
    async function* pieces() {
      yield Buffer.alloc(200_000, 65);
    }
    await assert.rejects(
      durableWriteChunksAsync(path, pieces(), () => {}),
      /staged output changed/,
    );
    assert.equal(edited, true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    fs.readSync = read;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable backup preserves SELECT star row JSON with large and numeric columns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-backup-'));
  const db = openDatabase(join(root, 'fictional.sqlite'), 'fictional');
  try {
    db.exec('CREATE TABLE fictional("12" TEXT, ordinary BLOB, "3" REAL)');
    const large = 'fictional 😀\0'.repeat(90_000);
    db.prepare('INSERT INTO fictional("12",ordinary,"3") VALUES(?,?,?)').run(
      large,
      Buffer.from([0, 1, 127, 255]),
      1.25,
    );
    const oldRows = db
      .prepare('SELECT * FROM fictional')
      .all()
      .map((row) => JSON.stringify(row));
    const receipt = await createBackup(db, root, 'fictional');
    const exported = JSON.parse(readFileSync(join(receipt.path, 'portable.json'), 'utf8')) as {
      tables: Record<string, unknown[]>;
    };
    assert.deepEqual(
      exported.tables.fictional?.map((row) => JSON.stringify(row)),
      oldRows,
    );
    const raw = readFileSync(join(receipt.path, 'portable.json'), 'utf8');
    assert.ok(raw.includes(`"fictional":[${oldRows[0]}]`));
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith('.pending')),
      [],
    );
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable backup refuses an original changed during yielded output and removes its stage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-original-'));
  const db = openDatabase(join(root, 'fictional.sqlite'), 'fictional');
  try {
    const originalPath = 'data/profiles/fictional/sources/fictional.txt';
    const original = join(root, originalPath);
    const bytes = Buffer.from('fictional original evidence');
    mkdirSync(dirname(original), { recursive: true });
    writeFileSync(original, bytes);
    db.prepare('INSERT INTO providers(id,name) VALUES(?,?)').run('fictional', 'Fictional');
    db.prepare('INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES(?,?,?,?,?)').run(
      'fictional-file',
      'fictional',
      originalPath,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
    );
    db.exec('CREATE TABLE fictional_large(value TEXT)');
    db.prepare('INSERT INTO fictional_large(value) VALUES(?)').run('fictional '.repeat(300_000));
    const destination = join(root, 'backup-result');
    const saving = createBackup(db, root, 'fictional', destination);
    let changed = false;
    for (let attempt = 0; attempt < 20_000; attempt++) {
      const pending = destination + '.pending';
      if (existsSync(pending)) {
        const output = readdirSync(pending).find((name) =>
          name.startsWith('portable.json.pending-'),
        );
        if (output && statSync(join(pending, output)).size > 0) {
          writeFileSync(original, 'changed after source copy');
          changed = true;
          break;
        }
      }
      await setImmediate();
    }
    assert.equal(changed, true, 'fixture reaches the yielded portable writer');
    await assert.rejects(saving, /Backup original changed before publication/);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(destination + '.pending'), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('contributor backup refuses a staged artifact changed during final physical verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-portable-terminal-'));
  const profileId = 'fictional';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  const destination = join(root, 'backup-result');
  const post = Worker.prototype.postMessage;
  let resume: (() => void) | undefined;
  let signalPaused!: () => void;
  const paused = new Promise<void>((resolve) => {
    signalPaused = resolve;
  });
  try {
    attachPersonalDurability(db, { root, profileId });
    transaction(db, () =>
      db.prepare("INSERT INTO app_meta(key,value) VALUES('fictional:accepted','reviewed')").run(),
    );
    Worker.prototype.postMessage = function (message, ...args) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'verify' &&
        existsSync(join(destination + '.pending', 'manifest.json'))
      ) {
        resume = () => {
          Reflect.apply(post, this, [message, ...args]);
        };
        signalPaused();
        return;
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
    const saving = createBackup(db, root, profileId, destination);
    await Promise.race([
      paused,
      saving.then(() => {
        throw Error('Backup finished before terminal pause');
      }),
    ]);
    appendFileSync(join(destination + '.pending', 'portable.json'), '!');
    resume!();
    resume = undefined;
    await assert.rejects(saving, /Backup stage changed before publication/);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(destination + '.pending'), false);
  } finally {
    resume?.();
    Worker.prototype.postMessage = post;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
