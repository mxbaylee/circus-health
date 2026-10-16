import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { openDatabase } from '../database.ts';
import {
  createIntakeCopyIncrementalReader,
  createIntakeCopyIncrementalReaderFromStandalone,
  createIntakeCopyIncrementalReaderFromPortableBackup,
} from '../intake-copy-incremental-reader.ts';
import { captureIntakeCopyReadInterval, finishIntakeCopySteps } from '../intake-copy-work.ts';
import { intakeCopyRowKeySteps, intakeCopySerializedRowKeySteps } from '../intake-copy-json.ts';
import { intakeCopyNativeSqlite } from '../intake-copy-native-sqlite.ts';

test('incremental copy reads managed source schema under the terminal callback barrier', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-managed-copy-reader-'));
  const db = openDatabase(join(directory, 'source.sqlite'), 'fictional-managed-copy-reader');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    const current = captureIntakeCopyReadInterval(db, 'fictional-managed-copy-reader');
    reader = await createIntakeCopyIncrementalReader(db, current);
    assert.ok(reader.columns('app_meta').includes('value'));
    assert.ok([...reader.rowIds('app_meta')].length > 0);
    current();
  } finally {
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('warm incremental column type checks snapshot around native point read', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      "CREATE TABLE fictional(value TEXT NOT NULL); INSERT INTO fictional VALUES('fictional')",
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    reader.columns('fictional');
    const rowid = [...reader.rowIds('fictional')][0]!;
    assert.equal(reader.columnType('fictional', 'value', rowid), 'text');
    const original = fs.fstatSync;
    let checks = 0;
    fs.fstatSync = ((...args: unknown[]) => {
      checks++;
      return Reflect.apply(original, fs, args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      assert.equal(reader.columnType('fictional', 'value', rowid), 'text');
      assert.equal(checks, 2, 'reused native statement retains pre/post snapshot checks');
    } finally {
      fs.fstatSync = original;
      syncBuiltinESMExports();
    }
  } finally {
    reader?.close();
    db.close();
  }
});

test('cached incremental cells preserve scalar grammar and recheck their source owner', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  let current = true;
  try {
    db.exec(
      'CREATE TABLE fictional(value); INSERT INTO fictional VALUES(7),(3.125),(NULL),(9007199254740993)',
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {
      if (!current) throw Error('Fictional source owner changed');
    });
    const columns = reader.columns('fictional');
    const ids = [...reader.rowIds('fictional')];
    for (let pass = 0; pass < 2; pass++) {
      for (const id of ids.slice(0, 3)) {
        const original = db.prepare('SELECT * FROM fictional WHERE rowid=?').get(id)!;
        assert.equal(
          finishIntakeCopySteps(
            intakeCopySerializedRowKeySteps(reader.rowPieces('fictional', id, columns)),
          ),
          finishIntakeCopySteps(intakeCopyRowKeySteps(original)),
        );
      }
      assert.equal(reader.columnType('fictional', 'value', ids[3]!), 'integer');
      assert.throws(() => [...reader!.rowPieces('fictional', ids[3]!, columns)], /too large/);
    }
    current = false;
    assert.throws(() => reader!.columnType('fictional', 'value', ids[0]!), /source owner changed/);
    assert.throws(
      () => [...reader!.rowPieces('fictional', ids[0]!, columns)],
      /source owner changed/,
    );
  } finally {
    reader?.close();
    db.close();
  }
});

test('standalone setup reader preserves SQLite LIKE selection and bounded native TEXT', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-standalone-copy-reader-'));
  const path = join(directory, 'copy.sqlite');
  const db = new DatabaseSync(path);
  let reader: ReturnType<typeof createIntakeCopyIncrementalReaderFromStandalone> | undefined;
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE source_files(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,kind TEXT NOT NULL)',
    );
    const text = '\uFEFF' + 'fictional'.repeat(8_000) + '😀\0';
    const rowid = 9_007_199_254_740_993n;
    db.prepare('INSERT INTO app_meta(rowid,key,value) VALUES(?,?,?)').run(
      rowid,
      'intake_source_text:v1:fictional:revision:one',
      text,
    );
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run('unrelated', 'fictional');
    db.prepare('INSERT INTO source_files VALUES(?,?,?)').run(
      'fictional-original',
      'a'.repeat(64),
      'intake_original',
    );
    let checks = 0;
    reader = createIntakeCopyIncrementalReaderFromStandalone(db, () => {
      checks++;
    });
    assert.deepEqual(
      [...reader.rowIdsLike('app_meta', 'key', 'intake_source_text:v1:%:revision:%')],
      [rowid],
    );
    assert.equal(reader.columnType('app_meta', 'value', rowid), 'text');
    assert.equal([...reader.textPieces('app_meta', 'value', rowid)].join(''), text);
    const sourceRowid = [...reader.rowIds('source_files')][0]!;
    assert.equal(
      [...reader.textPieces('source_files', 'id', sourceRowid)].join(''),
      'fictional-original',
    );
    const work = reader.work();
    assert.ok(work.chunks > 1 && work.bytes >= Buffer.byteLength(text));
    assert.ok(work.maxChunk <= 16 * 1024 && checks > work.chunks);
    writeFileSync(path + '.replacement', readFileSync(path));
    renameSync(path + '.replacement', path);
    assert.throws(
      () => [...reader!.textPieces('app_meta', 'value', rowid)],
      /identity changed/,
      'same-byte pathname replacement cannot redirect the pinned reader',
    );
  } finally {
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('completed portable backup reader keeps SELECT star bytes and refuses path replacement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-standalone-portable-reader-'));
  const path = join(directory, 'backup.sqlite');
  const db = new DatabaseSync(path);
  let reader: ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; CREATE TABLE fictional(note TEXT, "2" INTEGER, artifact BLOB, "0" TEXT)',
    );
    db.prepare('INSERT INTO fictional VALUES(?,?,?,?)').run(
      'a'.repeat(70_000) + '😀',
      7,
      Uint8Array.from({ length: 80_000 }, (_, index) => index % 251),
      'first',
    );
    const old = db.prepare('SELECT * FROM fictional').get()!;
    reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
    assert.deepEqual(reader.tables(), ['fictional']);
    const columns = reader.columns('fictional');
    assert.deepEqual(columns, ['note', '2', 'artifact', '0']);
    const rowid = [...reader.rowIds('fictional')][0]!;
    assert.equal(
      [...reader.rowPieces('fictional', rowid, columns, 'select')].join(''),
      JSON.stringify(old),
    );
    assert.ok(reader.work().maxChunk <= 16 * 1024);
    const suspended = reader.rowPieces('fictional', rowid, columns, 'select')[Symbol.iterator]();
    assert.equal(suspended.next().value, '{');
    let field: IteratorResult<string>;
    for (let step = 0; step < 16; step++) {
      field = suspended.next();
      if (field.value === '"note":') break;
    }
    assert.equal(field!.value, '"note":');
    writeFileSync(path + '.replacement', readFileSync(path));
    renameSync(path + '.replacement', path);
    assert.throws(() => suspended.next(), /identity changed/);
  } finally {
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable inline row refuses same-byte replacement when closed before the next field', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-inline-portable-reader-'));
  const path = join(directory, 'backup.sqlite');
  const db = new DatabaseSync(path);
  let reader: ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES('fictional-small')",
    );
    reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    const pieces = reader
      .rowPieces('fictional', rowid, reader.columns('fictional'))
      [Symbol.iterator]();
    let observed = false;
    for (;;) {
      const next = pieces.next();
      if (next.done) break;
      if (next.value === 'fictional-small') {
        observed = true;
        break;
      }
    }
    assert.equal(observed, true, 'the inline cell was consumed before replacement');
    writeFileSync(path + '.replacement', readFileSync(path));
    renameSync(path + '.replacement', path);
    assert.throws(() => pieces.return?.(undefined), /identity changed/);
  } finally {
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable inline row checks identity when closed after an opening delimiter', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-inline-delimiter-reader-'));
  const path = join(directory, 'backup.sqlite');
  const db = new DatabaseSync(path);
  let reader: ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES('fictional')",
    );
    reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    const pieces = reader
      .rowPieces('fictional', rowid, reader.columns('fictional'))
      [Symbol.iterator]();
    assert.equal(pieces.next().value, '{');
    writeFileSync(path + '.replacement', readFileSync(path));
    renameSync(path + '.replacement', path);
    assert.throws(() => pieces.return?.(undefined), /identity changed/);
  } finally {
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('managed inline row checks its owner when closed after an opening delimiter', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  let invalid = false;
  try {
    db.exec("CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES('fictional')");
    reader = await createIntakeCopyIncrementalReader(db, () => {
      if (invalid) throw Error('fictional source owner changed');
    });
    const rowid = [...reader.rowIds('fictional')][0]!;
    const pieces = reader
      .rowPieces('fictional', rowid, reader.columns('fictional'))
      [Symbol.iterator]();
    assert.equal(pieces.next().value, '{');
    invalid = true;
    assert.throws(() => pieces.return?.(undefined), /source owner changed/);
  } finally {
    reader?.close();
    db.close();
  }
});

test('portable reader preserves virtual ALTER TABLE text defaults on older rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-default-reader-'));
  try {
    for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
      const db = new DatabaseSync(join(directory, `${encoding}.sqlite`));
      let reader:
        ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
      try {
        db.exec(`PRAGMA encoding='${encoding}'; PRAGMA journal_mode=DELETE`);
        db.exec(
          "CREATE TABLE notes(id TEXT PRIMARY KEY); INSERT INTO notes VALUES('fictional-note'); ALTER TABLE notes ADD COLUMN text_formats_json TEXT NOT NULL DEFAULT '{}'; CREATE TABLE procedures(id TEXT PRIMARY KEY); INSERT INTO procedures VALUES('fictional-procedure'); ALTER TABLE procedures ADD COLUMN category TEXT NOT NULL DEFAULT 'unspecified'",
        );
        reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
        for (const table of ['notes', 'procedures']) {
          const expected = db.prepare(`SELECT * FROM ${table}`).get()!;
          const rowid: bigint = [...reader.rowIds(table)][0]!;
          assert.equal(
            [...reader.rowPieces(table, rowid, reader.columns(table), 'select')].join(''),
            JSON.stringify(expected),
          );
        }
        assert.ok(reader.work().maxChunk <= 16 * 1024);
      } finally {
        reader?.close();
        db.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('portable inline copy preserves BOM, NUL, and supplementary text in each encoding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-inline-encoding-'));
  try {
    for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
      const db = new DatabaseSync(join(directory, `${encoding}.sqlite`));
      let reader:
        ReturnType<typeof createIntakeCopyIncrementalReaderFromPortableBackup> | undefined;
      try {
        db.exec(
          `PRAGMA encoding='${encoding}'; PRAGMA journal_mode=DELETE; CREATE TABLE fictional(value TEXT)`,
        );
        db.prepare('INSERT INTO fictional VALUES(?)').run('\uFEFFfictional\0😀');
        reader = createIntakeCopyIncrementalReaderFromPortableBackup(db, () => {});
        const rowid = [...reader.rowIds('fictional')][0]!;
        assert.equal(
          [...reader.rowPieces('fictional', rowid, reader.columns('fictional'))].join(''),
          JSON.stringify({ value: '\uFEFFfictional\0😀' }),
        );
        assert.ok(reader.work().maxChunk <= 16 * 1024);
      } finally {
        reader?.close();
        db.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('copy equality reader preserves virtual ALTER TABLE defaults on older rows', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      "CREATE TABLE notes(id TEXT PRIMARY KEY); INSERT INTO notes VALUES('fictional-note'); ALTER TABLE notes ADD COLUMN text_formats_json TEXT NOT NULL DEFAULT '{}'; CREATE TABLE procedures(id TEXT PRIMARY KEY); INSERT INTO procedures VALUES('fictional-procedure'); ALTER TABLE procedures ADD COLUMN category TEXT NOT NULL DEFAULT 'unspecified'",
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    for (const table of ['notes', 'procedures']) {
      const expected = db.prepare(`SELECT * FROM ${table}`).get()!;
      const rowid: bigint = [...reader.rowIds(table)][0]!;
      assert.equal(
        finishIntakeCopySteps(
          intakeCopySerializedRowKeySteps(reader.rowPieces(table, rowid, reader.columns(table))),
        ),
        finishIntakeCopySteps(intakeCopyRowKeySteps(expected)),
      );
    }
  } finally {
    reader?.close();
    db.close();
  }
});

test('copy rows inline bounded raw cells but retain large and virtual-default blob reads', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  const native = intakeCopyNativeSqlite();
  const original = native.blobOpen;
  let opens = 0;
  try {
    db.exec('CREATE TABLE notes(id TEXT, title TEXT, artifact BLOB, huge TEXT)');
    db.prepare('INSERT INTO notes VALUES(?,?,?,?)').run(
      'fictional-id',
      'fictional small 😀\0text',
      Uint8Array.of(0, 1, 255),
      'large'.repeat(5000),
    );
    db.exec("ALTER TABLE notes ADD COLUMN text_formats_json TEXT NOT NULL DEFAULT '{}'");
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    native.blobOpen = (...args) => {
      opens++;
      return Reflect.apply(original, native, args);
    };
    const rowid = [...reader.rowIds('notes')][0]!;
    const actual = [...reader.rowPieces('notes', rowid, reader.columns('notes'), 'select')].join(
      '',
    );
    assert.equal(actual, JSON.stringify(db.prepare('SELECT * FROM notes').get()!));
    assert.equal(opens, 2, 'only the oversized and virtual-default cells use blob_open');
    assert.ok(reader.work().maxChunk <= 16 * 1024);
  } finally {
    native.blobOpen = original;
    reader?.close();
    db.close();
  }
});

test('empty inline BLOB contributes no copy bytes or chunks', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  const native = intakeCopyNativeSqlite();
  const original = native.blobOpen;
  let opens = 0;
  try {
    db.exec("CREATE TABLE fictional(value BLOB); INSERT INTO fictional VALUES(x'')");
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    const before = reader.work();
    native.blobOpen = (...args) => {
      opens++;
      return Reflect.apply(original, native, args);
    };
    assert.equal(
      [...reader.rowPieces('fictional', rowid, reader.columns('fictional'))].join(''),
      '{"value":{}}',
    );
    assert.equal(opens, 0);
    assert.equal(reader.work().chunks, before.chunks);
    assert.equal(reader.work().bytes, before.bytes);
  } finally {
    native.blobOpen = original;
    reader?.close();
    db.close();
  }
});

test('copy inline byte limit is divided across the selected row columns', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  const native = intakeCopyNativeSqlite();
  const original = native.blobOpen;
  let opens = 0;
  try {
    db.exec('CREATE TABLE fictional(a TEXT,b TEXT,c TEXT,d TEXT)');
    db.prepare('INSERT INTO fictional VALUES(?,?,?,?)').run(
      'a'.repeat(4096),
      'b'.repeat(4096),
      'c'.repeat(4096),
      'd'.repeat(4097),
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    native.blobOpen = (...args) => {
      opens++;
      return Reflect.apply(original, native, args);
    };
    assert.equal(
      [...reader.rowPieces('fictional', rowid, reader.columns('fictional'), 'select')].join(''),
      JSON.stringify(db.prepare('SELECT * FROM fictional').get()!),
    );
    assert.equal(opens, 1, 'the first cell beyond the per-column byte cap uses blob_open');
    assert.equal(reader.work().bytes, 16_385);
    assert.ok(reader.work().maxChunk <= 16 * 1024);
  } finally {
    native.blobOpen = original;
    reader?.close();
    db.close();
  }
});

test('copy row refuses an unapproved virtual ALTER TABLE default', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      "CREATE TABLE fictional(id TEXT); INSERT INTO fictional VALUES('fictional'); ALTER TABLE fictional ADD COLUMN ghost TEXT NOT NULL DEFAULT 'fabricated'",
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    const selectedReader = reader;
    assert.throws(
      () => [...selectedReader.rowPieces('fictional', rowid, selectedReader.columns('fictional'))],
      /column open failed/,
    );
  } finally {
    reader?.close();
    db.close();
  }
});

test('incremental copy rows retain native JSON grammar in bounded SQLite reads', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      'CREATE TABLE fictional(rowid TEXT, "0" INTEGER, note TEXT, artifact BLOB, nullable TEXT)',
    );
    const note = 'a'.repeat(16_383) + '😀' + '\0' + 'Ω'.repeat(80_000);
    const artifact = Uint8Array.from({ length: 130_009 }, (_, i) => i % 251);
    db.prepare('INSERT INTO fictional VALUES(?,?,?,?,?)').run(
      'fictional-shadow',
      7,
      note,
      artifact,
      null,
    );
    const old = db.prepare('SELECT * FROM fictional').get()!;
    const oldKey = finishIntakeCopySteps(intakeCopyRowKeySteps(old));
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    assert.deepEqual(reader.tables(), ['fictional']);
    const rowid = [...reader.rowIds('fictional')][0]!;
    assert.equal(rowid, 1n, 'shadowed rowid uses an unshadowed alias');
    assert.equal(reader.columnType('fictional', 'note', rowid), 'text');
    assert.equal([...reader.textPieces('fictional', 'note', rowid)].join(''), note);
    const newKey = finishIntakeCopySteps(
      intakeCopySerializedRowKeySteps(
        reader.rowPieces('fictional', rowid, reader.columns('fictional')),
      ),
    );
    assert.equal(newKey, oldKey);
    assert.equal(
      [...reader.rowPieces('fictional', rowid, reader.columns('fictional'), 'select')].join(''),
      JSON.stringify(old),
      'portable row order matches SELECT * and JavaScript numeric-key enumeration',
    );
    assert.throws(
      () => [
        ...reader!.rowPieces('fictional', rowid, reader!.columns('fictional'), 'other' as 'sorted'),
      ],
      /row order changed/,
    );
    const work = reader.work();
    assert.ok(work.pages > 0);
    assert.ok(work.chunks > 8);
    assert.ok(work.bytes >= Buffer.byteLength(note) + artifact.length);
    assert.ok(work.maxChunk <= 16 * 1024);
    db.prepare('UPDATE fictional SET note=?').run('advanced after snapshot');
    assert.equal(
      finishIntakeCopySteps(
        intakeCopySerializedRowKeySteps(
          reader.rowPieces('fictional', rowid, reader.columns('fictional')),
        ),
      ),
      oldKey,
      'private transport stays pinned to its initial snapshot',
    );
  } finally {
    reader?.close();
    db.close();
  }
});

test('incremental copy excludes only the original bookkeeping keys', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const put = db.prepare('INSERT INTO app_meta VALUES(?,?)');
    for (const key of [
      'personal_transient',
      'personal_assistant_receipt',
      'personal_restore_receipt',
      'curation_revision',
      'curation_revision_extra',
      'ordinary',
    ])
      put.run(key, 'fictional');
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const found = new Map<string, boolean>();
    for (const rowid of reader.rowIds('app_meta')) {
      const key = [...reader.textPieces('app_meta', 'key', rowid)].join('');
      found.set(key, reader.bookkeepingKey(rowid));
    }
    assert.deepEqual(Object.fromEntries(found), {
      personal_transient: true,
      personal_assistant_receipt: false,
      personal_restore_receipt: false,
      curation_revision: true,
      curation_revision_extra: false,
      ordinary: false,
    });
  } finally {
    reader?.close();
    db.close();
  }
});

test('incremental copy keeps three native readers valid across early key close and GC', async () => {
  const db = new DatabaseSync(':memory:');
  const readers: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>>[] = [];
  try {
    db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO app_meta VALUES(?,?)');
    for (let index = 0; index < 96; index++)
      insert.run(`fictional_${index.toString().padStart(3, '0')}`, 'v'.repeat(20_000));
    for (let index = 0; index < 3; index++)
      readers.push(await createIntakeCopyIncrementalReader(db, () => {}));
    const rows = readers.map((reader) => [...reader.rowIds('app_meta')]);
    for (let pass = 0; pass < 4; pass++) {
      for (let index = 0; index < rows[0]!.length; index++) {
        for (let readerIndex = 0; readerIndex < readers.length; readerIndex++) {
          const reader = readers[readerIndex]!;
          const rowid = rows[readerIndex]![index]!;
          assert.equal(reader.bookkeepingKey(rowid), false);
          const pieces = reader.textPieces('app_meta', 'key', rowid)[Symbol.iterator]();
          try {
            assert.equal(pieces.next().value, `fictional_${index.toString().padStart(3, '0')}`);
          } finally {
            pieces.return?.(undefined);
          }
        }
        if (index % 16 === 0) {
          (globalThis as { gc?: () => void }).gc?.();
          await setImmediate();
        }
      }
    }
    for (let index = 0; index < 32; index++) {
      const active = readers.map((reader, readerIndex) =>
        reader.textPieces('app_meta', 'value', rows[readerIndex]![index]!)[Symbol.iterator](),
      );
      try {
        for (const pieces of active) {
          const first = pieces.next();
          assert.equal(first.done, false);
          assert.ok(first.value!.length > 0);
        }
        (globalThis as { gc?: () => void }).gc?.();
        await setImmediate();
        for (const pieces of active) {
          const second = pieces.next();
          assert.equal(second.done, false);
          assert.ok(second.value!.length > 0);
        }
      } finally {
        for (const pieces of active) pieces.return?.(undefined);
      }
    }
    for (const reader of readers) assert.ok(reader.work().chunks >= 96 * 4 * 2);
  } finally {
    for (const reader of readers) reader.close();
    db.close();
  }
});

test('incremental copy refuses invalid native TEXT rather than silently replacing bytes', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      "CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES(CAST(x'80' AS TEXT))",
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const rowid = [...reader.rowIds('fictional')][0]!;
    const selectedReader = reader;
    assert.throws(
      () => [...selectedReader.textPieces('fictional', 'value', rowid)],
      /encoded data was not valid/i,
    );
    assert.throws(
      () => [...selectedReader.rowPieces('fictional', rowid, selectedReader.columns('fictional'))],
      /encoded data was not valid/i,
      'the bounded SQL BLOB path must not use SQLite text coercion',
    );
  } finally {
    reader?.close();
    db.close();
  }
});

for (const [encoding, raw] of [
  ['UTF-16le', '00d8'],
  ['UTF-16be', 'd800'],
] as const)
  test(`inline copy refuses an unpaired surrogate in ${encoding}`, async () => {
    const db = new DatabaseSync(':memory:');
    let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
    try {
      db.exec(
        `PRAGMA encoding='${encoding}'; CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES(CAST(x'${raw}' AS TEXT))`,
      );
      reader = await createIntakeCopyIncrementalReader(db, () => {});
      const rowid = [...reader.rowIds('fictional')][0]!;
      const selectedReader = reader;
      assert.throws(
        () => [
          ...selectedReader.rowPieces('fictional', rowid, selectedReader.columns('fictional')),
        ],
        /encoded data was not valid/i,
      );
    } finally {
      reader?.close();
      db.close();
    }
  });

test('incremental copy retains 64-bit row identity and refuses unsupported table layout', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec(
      'CREATE TABLE fictional(value TEXT); CREATE TABLE no_rowid(id TEXT PRIMARY KEY) WITHOUT ROWID',
    );
    db.prepare('INSERT INTO fictional(rowid,value) VALUES(?,?)').run(
      9_007_199_254_740_993n,
      'fictional',
    );
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const id = [...reader.rowIds('fictional')][0]!;
    assert.equal(id, 9_007_199_254_740_993n);
    assert.equal([...reader.textPieces('fictional', 'value', id)].join(''), 'fictional');
    assert.throws(() => reader!.columns('no_rowid'), /ordinary rowid table/);
  } finally {
    reader?.close();
    db.close();
  }
});

test('incremental copy reads genuine snapshot rows after public statement methods change', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec("CREATE TABLE fictional(value TEXT); INSERT INTO fictional VALUES('original')");
    const old = db.prepare('SELECT * FROM fictional').get()!;
    const expected = finishIntakeCopySteps(intakeCopyRowKeySteps(old));
    reader = await createIntakeCopyIncrementalReader(db, () => {});
    const original = StatementSync.prototype.get;
    StatementSync.prototype.get = function () {
      return { value: 'forged', type: 'blob', wr: 1 };
    };
    try {
      const rowid = [...reader.rowIds('fictional')][0]!;
      assert.equal(
        finishIntakeCopySteps(
          intakeCopySerializedRowKeySteps(
            reader.rowPieces('fictional', rowid, reader.columns('fictional')),
          ),
        ),
        expected,
      );
    } finally {
      StatementSync.prototype.get = original;
    }
  } finally {
    reader?.close();
    db.close();
  }
});

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'])
  test(`incremental copy preserves BOM and bookkeeping semantics in ${encoding}`, async () => {
    const db = new DatabaseSync(':memory:');
    let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
    try {
      db.exec(
        `PRAGMA encoding='${encoding}'; CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)`,
      );
      db.prepare('INSERT INTO app_meta VALUES(?,?)').run('curation_revision', '\uFEFFfictional😀');
      db.prepare('INSERT INTO app_meta VALUES(?,?)').run('personal_assistant_receipt', 'fictional');
      reader = await createIntakeCopyIncrementalReader(db, () => {});
      for (const rowid of reader.rowIds('app_meta')) {
        const row = db.prepare('SELECT * FROM app_meta WHERE rowid=?').get(rowid)!;
        assert.equal(
          finishIntakeCopySteps(
            intakeCopySerializedRowKeySteps(
              reader.rowPieces('app_meta', rowid, reader.columns('app_meta')),
            ),
          ),
          finishIntakeCopySteps(intakeCopyRowKeySteps(row)),
        );
        assert.equal(reader.bookkeepingKey(rowid), row.key === 'curation_revision');
      }
    } finally {
      reader?.close();
      db.close();
    }
  });

test('incremental copy refuses source advancement during backup and between pieces', async () => {
  const db = new DatabaseSync(':memory:');
  let reader: Awaited<ReturnType<typeof createIntakeCopyIncrementalReader>> | undefined;
  try {
    db.exec('CREATE TABLE fictional(value TEXT)');
    db.prepare('INSERT INTO fictional VALUES(?)').run('a'.repeat(600_000));
    let baseline = db.prepare('SELECT total_changes() AS n').get()!.n;
    let calls = 0;
    const duringBackup = () => {
      if (++calls === 2) db.prepare('UPDATE fictional SET value=?').run('b'.repeat(600_000));
      if (db.prepare('SELECT total_changes() AS n').get()!.n !== baseline)
        throw Error('fictional source advanced');
    };
    await assert.rejects(createIntakeCopyIncrementalReader(db, duringBackup), /source advanced/);
    assert.ok(calls >= 2, 'backup invoked the original checkpoint after acquisition');
    baseline = db.prepare('SELECT total_changes() AS n').get()!.n;
    let advance = false;
    const betweenPieces = () => {
      if (advance) {
        advance = false;
        db.prepare('UPDATE fictional SET value=?').run('c'.repeat(600_000));
      }
      if (db.prepare('SELECT total_changes() AS n').get()!.n !== baseline)
        throw Error('fictional source advanced');
    };
    reader = await createIntakeCopyIncrementalReader(db, betweenPieces);
    const rowid = [...reader.rowIds('fictional')][0]!;
    const pieces = reader.textPieces('fictional', 'value', rowid)[Symbol.iterator]();
    assert.ok(pieces.next().value);
    advance = true;
    assert.throws(() => pieces.next(), /source advanced/);
  } finally {
    reader?.close();
    db.close();
  }
});
