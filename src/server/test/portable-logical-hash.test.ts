import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { logicalDatabaseHash } from '../portable.ts';
import { logicalDatabaseHashIncremental } from '../portable-logical-hash.ts';

test('incremental private logical hash matches the accepted SELECT-star grammar', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-portable-logical-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fictional.sqlite');
  const db = openDatabase(path, 'fictional-portable-logical');
  let expected: string;
  try {
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      'fictional-long-value',
      'A😀𐀀\uD800é'.repeat(80_000),
    );
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(
      'fictional-numeric-name',
      JSON.stringify({ '10': 'ten', '2': 'two', ordinary: true }),
    );
    const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    for (let index = 0; index < 40; index++)
      insert.run(`fictional-sort-${String(index).padStart(2, '0')}`, `${index}\u0000\n\"😀`);
    insert.run('fictional-escaped-control', '\u0000'.repeat(40_000));
    expected = logicalDatabaseHash(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(db.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode, 'delete');
  } finally {
    db.close();
  }
  assert.equal(
    logicalDatabaseHashIncremental(path, () => {}),
    expected,
  );
});
