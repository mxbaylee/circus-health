import assert from 'node:assert/strict';
import { constants, DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../database.ts';
import { captureIntakeCopyReadInterval } from '../intake-copy-work.ts';
import {
  isCommittedColumnShmTimestampRefusal,
  openRecordCommittedColumnReader,
} from '../record-committed-column-reader.ts';

function fixture(run: (db: DatabaseSync, path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'health-committed-columns-'));
  const path = join(directory, 'fictional.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE source_files(id TEXT PRIMARY KEY, details_json TEXT)',
    );
    run(db, path);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('committed column reader bounds WAL text pieces and refuses peer advance', () => {
  fixture((db, path) => {
    const value = JSON.stringify({ name: 'Fictional ' + 'a'.repeat(160_000) + '𐐷' });
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', value);
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    let before = db.prepare('PRAGMA main.data_version').get()!.data_version;
    let openings = 0;
    const reader = openRecordCommittedColumnReader(db, (phase) => {
      const current = db.prepare('PRAGMA main.data_version').get()!.data_version;
      if (phase === 'after-open') {
        // The reader pins main/WAL around this one owned connection transition.
        assert.equal(++openings, 1);
        before = current;
      } else if (current !== before) throw Error('managed peer advance');
    });
    try {
      assert.equal(openings, 1);
      assert.equal(
        reader.byteLength('source_files', 'details_json', rowid),
        Buffer.byteLength(value),
      );
      const pieces = [...reader.bytes('source_files', 'details_json', rowid)];
      assert.ok(pieces.length > 2);
      assert.ok(pieces.every((piece) => piece.byteLength <= 16 * 1024));
      assert.equal(Buffer.concat(pieces).toString('utf8'), value);
      assert.deepEqual(reader.work(), {
        chunks: pieces.length,
        bytes: Buffer.byteLength(value),
        maxChunk: 16 * 1024,
      });
      const peer = new DatabaseSync(path);
      try {
        peer
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run('changed', 'fictional');
      } finally {
        peer.close();
      }
      assert.throws(() => [...reader.bytes('source_files', 'details_json', rowid)]);
    } finally {
      reader.close();
    }
  });
});

test('committed column reader refuses a replaced fictional database pathname', () => {
  fixture((db, path) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      renameSync(path, `${path}.old`);
      copyFileSync(`${path}.old`, path);
      assert.throws(
        () => [...reader.bytes('source_files', 'details_json', rowid)],
        /Committed column file identity changed \(database: ino(?:,|\))/,
      );
    } finally {
      reader.close();
      renameSync(`${path}.old`, path);
    }
  });
});

test('committed column reader identifies a WAL change without exposing its pathname', () => {
  fixture((db, path) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    const peer = new DatabaseSync(path);
    try {
      peer.prepare('UPDATE source_files SET details_json=?').run('{"changed":true}');
      assert.throws(
        () => [...reader.bytes('source_files', 'details_json', rowid)],
        /Committed column file identity changed \(WAL: (?:size|mtimeNs|ctimeNs)/,
      );
    } finally {
      reader.close();
      peer.close();
    }
  });
});

test('committed column reader refuses same-file shared-memory timestamp movement', () => {
  fixture((db, path) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      const later = new Date(Date.now() + 60_000);
      utimesSync(`${path}-shm`, later, later);
      assert.throws(
        () => [...reader.bytes('source_files', 'details_json', rowid)],
        (error: unknown) =>
          isCommittedColumnShmTimestampRefusal(error) &&
          /shared-memory index: (?:mtimeNs|ctimeNs)/.test((error as Error).message),
      );
    } finally {
      reader.close();
    }
  });
});

test('committed column reader refuses a peer commit during readonly opening', () => {
  fixture((db, path) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const peer = new DatabaseSync(path);
    let reachedOpening = false;
    try {
      assert.throws(
        () =>
          openRecordCommittedColumnReader(db, (phase) => {
            if (phase !== 'after-open') return;
            reachedOpening = true;
            peer
              .prepare('UPDATE source_files SET details_json=? WHERE id=?')
              .run('{"changed":true}', 'fictional');
          }),
        /opening file changed/,
      );
      assert.equal(reachedOpening, true);
    } finally {
      peer.close();
    }
  });
});

test('committed column reader refuses a replaced fictional WAL during readonly opening', () => {
  fixture((db, path) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const wal = `${path}-wal`;
    const saved = `${wal}.fictional-original`;
    let replaced = false;
    try {
      assert.throws(
        () =>
          openRecordCommittedColumnReader(db, (phase) => {
            if (phase !== 'after-open') return;
            renameSync(wal, saved);
            copyFileSync(saved, wal);
            replaced = true;
          }),
        /opening file changed/,
      );
      assert.equal(replaced, true);
    } finally {
      if (replaced) renameSync(saved, wal);
    }
  });
});

test('committed column reader closes a partially consumed snapshot value', () => {
  fixture((db) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run(
      'fictional',
      'a'.repeat(64_000),
    );
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    const parts = reader.bytes('source_files', 'details_json', rowid)[Symbol.iterator]();
    assert.equal(parts.next().value?.byteLength, 16 * 1024);
    assert.doesNotThrow(() => reader.close());
    assert.throws(() => parts.next());
  });
});

test('committed column reader obeys managed column policy despite snapshot transport', () => {
  fixture((db) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      db.setAuthorizer((action, table, column) =>
        action === constants.SQLITE_READ && table === 'source_files' && column === 'details_json'
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      assert.throws(() => [...reader.bytes('source_files', 'details_json', rowid)]);
    } finally {
      db.setAuthorizer(null);
      reader.close();
    }
  });
});

test('committed column reader uses captured native location and SQL methods', () => {
  fixture((db) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('fictional', '{}');
    const rowid = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('fictional')!.rowid as number,
    );
    Object.defineProperty(db, 'location', { configurable: true, value: () => '/wrong.sqlite' });
    Object.defineProperty(db, 'prepare', {
      configurable: true,
      value: () => {
        throw Error('forged prepare');
      },
    });
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      assert.equal([...reader.text('source_files', 'details_json', rowid)].join(''), '{}');
    } finally {
      reader.close();
      delete (db as unknown as { location?: unknown }).location;
      delete (db as unknown as { prepare?: unknown }).prepare;
    }
  });
});

test('committed column reader refuses NULL and BLOB as TEXT', () => {
  fixture((db) => {
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run('null', null);
    db.prepare('INSERT INTO source_files(id,details_json) VALUES (?,?)').run(
      'blob',
      Buffer.from('hi'),
    );
    const nullId = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('null')!.rowid as number,
    );
    const blobId = BigInt(
      db.prepare('SELECT rowid FROM source_files WHERE id=?').get('blob')!.rowid as number,
    );
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      assert.throws(() => [...reader.text('source_files', 'details_json', nullId)]);
      assert.throws(() => [...reader.text('source_files', 'details_json', blobId)]);
      assert.equal(
        Buffer.concat([...reader.bytes('source_files', 'details_json', blobId)]).toString('utf8'),
        'hi',
      );
    } finally {
      reader.close();
    }
  });
});

test('committed column reader decodes a UTF-16 SQLite text column', () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-committed-utf16-'));
  const path = join(directory, 'fictional.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA encoding='UTF-16le'; PRAGMA journal_mode=WAL; CREATE TABLE source_files(details_json TEXT)",
    );
    const value = 'Fictional ' + 'a'.repeat(40_000) + '𐐷';
    db.prepare('INSERT INTO source_files(details_json) VALUES (?)').run(value);
    const reader = openRecordCommittedColumnReader(db, () => {});
    try {
      assert.equal([...reader.text('source_files', 'details_json', 1n)].join(''), value);
      assert.ok(reader.work().maxChunk <= 16 * 1024);
    } finally {
      reader.close();
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('committed column reader keeps a genuine managed read interval and installed policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-committed-managed-'));
  const db = openDatabase(join(directory, 'fictional.sqlite'), 'fictional-committed-reader');
  let reader: ReturnType<typeof openRecordCommittedColumnReader> | undefined;
  const prepare = db.prepare;
  try {
    let current: ReturnType<typeof captureIntakeCopyReadInterval> | undefined;
    const rowid = BigInt(
      db.prepare("SELECT rowid FROM app_meta WHERE key='owner_profile_id'").get()!.rowid as number,
    );
    reader = openRecordCommittedColumnReader(db, () => current?.());
    // Opening a second SQLite connection can advance data_version on Linux.
    // The reader pins main/WAL files across opening; this interval covers its reads.
    current = captureIntakeCopyReadInterval(db, 'fictional-committed-reader');
    assert.equal(
      [...reader.text('app_meta', 'value', rowid)].join(''),
      'fictional-committed-reader',
    );
    current();
    db.prepare = () => {
      throw Error('forged managed prepare');
    };
    assert.throws(() => [...reader!.text('app_meta', 'value', rowid)]);
  } finally {
    db.prepare = prepare;
    reader?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('committed column reader never shrinks the live WAL index under managed commits', (t) => {
  // A second SQLite library in this process would not share POSIX lock state
  // with node:sqlite: its open/close could truncate the -shm that the managed
  // connection still maps, and the next managed COMMIT dies with SIGBUS. The
  // scenario runs in a child so that crash is an assertion, not a runner abort.
  const directory = mkdtempSync(join(tmpdir(), 'health-committed-shm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const reader = new URL('../record-committed-column-reader.ts', import.meta.url).href;
  const child = `
    import { DatabaseSync } from 'node:sqlite';
    import { statSync } from 'node:fs';
    import { openRecordCommittedColumnReader } from ${JSON.stringify(reader)};
    const path = ${JSON.stringify(join(directory, 'fictional.sqlite'))};
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; CREATE TABLE source_files(id INTEGER PRIMARY KEY, details_json TEXT)');
    const insert = db.prepare('INSERT INTO source_files(details_json) VALUES (?)');
    const commits = (label) => { for (let i = 0; i < 9000; i++) insert.run(label + ' fictional ' + i); };
    const shm = () => { const s = statSync(path + '-shm', { bigint: true }); return { ino: String(s.ino), size: Number(s.size) }; };
    const seen = [];
    commits('before');
    for (let round = 0; round < 3; round++) {
      seen.push(shm());
      const opened = openRecordCommittedColumnReader(db, () => {});
      try {
        if ([...opened.text('source_files', 'details_json', 1n)].join('') !== 'before fictional 0')
          throw Error('fictional committed value differs');
        seen.push(shm());
        // Managed WAL commits while the reader's snapshot pins the WAL.
        commits('during ' + round);
        seen.push(shm());
      } finally {
        opened.close();
      }
      seen.push(shm());
      commits('after ' + round);
      seen.push(shm());
    }
    db.close();
    console.log(JSON.stringify(seen));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout) as { ino: string; size: number }[];
  assert.equal(seen.length, 15);
  for (let index = 1; index < seen.length; index++) {
    assert.equal(seen[index]!.ino, seen[0]!.ino, `-shm replaced at observation ${index}`);
    assert.ok(seen[index]!.size >= seen[index - 1]!.size, `-shm shrank at observation ${index}`);
  }
});
