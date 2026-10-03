import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, registerTransactionDurability } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import {
  readSourceTextProjection,
  reconcileSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-source-rope-'));
  const path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-rope');
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    reopen() {
      db.close();
      db = openDatabase(path, 'fictional-rope');
    },
    insert(id: string, text: string) {
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      ).run(id, id + '.txt', 'a'.repeat(64), 0, 'derived', text);
    },
    write(id: string, text: string) {
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(text, id);
    },
  };
}
function exact(db: ReturnType<typeof openDatabase>, id: string, expected: string) {
  const actual = readSourceTextProjection(db, id);
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected));
}
function rows(db: ReturnType<typeof openDatabase>, table: string, id?: string) {
  assert.match(table, /^(contents|occurrences|links|heads)$/);
  return db
    .prepare(
      `SELECT * FROM __record_source_text_${table}${id ? ' WHERE source_id=?' : ''} ORDER BY id`,
    )
    .all(...(id ? [id] : []));
}

test('exact raw serialization and automatic distant/periodic/moved changes preserve unaffected source rows', (t) => {
  const f = fixture(t);
  const left = 'Fictional left Ω 😀. '.repeat(450),
    middle = 'ab'.repeat(5000),
    right = 'Fictional right passage. '.repeat(450);
  let expected =
    '{ "z": "\\ud800", "text": ' + JSON.stringify(left + middle + right) + ', "a": 1 }';
  f.insert('changing', expected);
  f.insert('untouched', expected);
  exact(f.db, 'changing', expected);
  const untouchedOccurrences = rows(f.db, 'occurrences', 'untouched');
  const untouchedLinks = rows(f.db, 'links', 'untouched');
  const initialOccurrences = rows(f.db, 'occurrences', 'changing');
  const initialLinks = rows(f.db, 'links', 'changing');
  const content = new Map(rows(f.db, 'contents').map((row) => [row.id, String(row.text)]));
  const middleRows = initialOccurrences.filter((row) =>
    /^(?:ab)+$/.test(content.get(row.content_id)!),
  );
  assert.ok(middleRows.length > 0);
  for (const text of [
    left + 'early' + middle + right + 'late',
    right + left + 'early' + middle + 'late',
    right + left + 'early' + middle + middle + 'late',
  ]) {
    expected = '{ "z": "\\ud800", "text": ' + JSON.stringify(text) + ', "a": 1 }';
    const before = sourceTextProjectionCounters(f.db).authorityReads;
    transaction(f.db, () => {
      f.write('changing', expected);
      exact(f.db, 'changing', expected);
    });
    assert.equal(
      sourceTextProjectionCounters(f.db).authorityReads - before,
      1,
      'only dirty source authoritative view is read',
    );
    if (text === left + 'early' + middle + right + 'late') {
      for (const row of middleRows)
        assert.deepEqual(
          rows(f.db, 'occurrences', 'changing').find((next) => next.id === row.id),
          row,
        );
      const middleIds = new Set(middleRows.map((row) => row.id));
      for (const row of initialLinks.filter(
        (row) => middleIds.has(row.id) && middleIds.has(row.next),
      ))
        assert.deepEqual(
          rows(f.db, 'links', 'changing').find((next) => next.id === row.id),
          row,
        );
    }
    assert.deepEqual(rows(f.db, 'occurrences', 'untouched'), untouchedOccurrences);
    assert.deepEqual(rows(f.db, 'links', 'untouched'), untouchedLinks);
  }
  const retained = rows(f.db, 'occurrences', 'changing');
  const retainedLinks = rows(f.db, 'links', 'changing');
  assert.ok(
    initialOccurrences.filter((row) =>
      retained.some((next) => JSON.stringify(next) === JSON.stringify(row)),
    ).length >= 2,
  );
  assert.ok(
    initialLinks.filter((row) =>
      retainedLinks.some((next) => JSON.stringify(next) === JSON.stringify(row)),
    ).length >= 1,
  );
  const before = structuredClone(sourceTextProjectionCounters(f.db));
  for (let i = 0; i < 3; i++) reconcileSourceTextProjection(f.db);
  transaction(f.db, () => f.db.prepare('SELECT 1').get());
  reconcileSourceTextProjection(f.db);
  assert.deepEqual(
    sourceTextProjectionCounters(f.db),
    before,
    'unchanged reconciliation performs no authoritative text hydration',
  );
});

test('first warmup and partially applied batch roll back with caller transaction and retry cleanly', (t) => {
  const f = fixture(t);
  f.insert('a', '{"fictional":"old a"}');
  f.insert('z', '{"fictional":"old z"}');
  assert.throws(
    () =>
      transaction(f.db, () => {
        exact(f.db, 'a', '{"fictional":"old a"}');
        f.write('a', '{"fictional":"new a"}');
        exact(f.db, 'a', '{"fictional":"new a"}');
        throw Error('fictional first-warmup rollback');
      }),
    /first-warmup rollback/,
  );
  exact(f.db, 'a', '{"fictional":"old a"}');
  const before = f.db.prepare('SELECT * FROM __record_source_text_heads ORDER BY source_id').all();
  f.db.exec(
    "CREATE TEMP TRIGGER refuse_second_head BEFORE UPDATE ON main.__record_source_text_heads WHEN NEW.source_id='z' BEGIN SELECT RAISE(ABORT,'fictional partial batch'); END",
  );
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.write('a', '{"fictional":"next a"}');
        f.write('z', '{"fictional":"next z"}');
        assert.throws(() => reconcileSourceTextProjection(f.db), /partial batch/);
      }),
    /partial batch/,
  );
  assert.deepEqual(
    f.db.prepare('SELECT * FROM __record_source_text_heads ORDER BY source_id').all(),
    before,
  );
  f.db.exec('DROP TRIGGER temp.refuse_second_head');
  f.reopen();
  exact(f.db, 'a', '{"fictional":"old a"}');
  exact(f.db, 'z', '{"fictional":"old z"}');
});

test('connection reopen, index/table/schema loss and disposable corruption repair from exact source', (t) => {
  const f = fixture(t),
    expected = JSON.stringify({ fictional: 'distinct evidence Ω 😀 '.repeat(800) });
  f.insert('a', expected);
  f.insert('b', JSON.stringify({ fictional: 'other evidence '.repeat(800) }));
  exact(f.db, 'a', expected);
  f.reopen();
  exact(f.db, 'a', expected);
  const faults = [
    "UPDATE __record_source_text_occurrences SET start=9223372036854775807 WHERE source_id='a'",
    "UPDATE __record_source_text_occurrences SET end=9223372036854775807 WHERE source_id='a'",
    'UPDATE __record_source_text_state SET format=9223372036854775807',
    'PRAGMA ignore_check_constraints=ON; UPDATE __record_source_text_state SET singleton=9223372036854775807; PRAGMA ignore_check_constraints=OFF',
    "UPDATE __record_source_text_contents SET text='wrong' WHERE id=(SELECT content_id FROM __record_source_text_occurrences WHERE source_id='a' LIMIT 1)",
    "UPDATE __record_source_text_links SET next=id WHERE source_id='a'",
    "UPDATE __record_source_text_links SET next='missing' WHERE source_id='a'",
    "UPDATE __record_source_text_links SET next=(SELECT id FROM __record_source_text_occurrences WHERE source_id='b' LIMIT 1) WHERE source_id='a'",
    "UPDATE __record_source_text_heads SET profile_id='wrong',source_hash='wrong',details_digest='wrong' WHERE source_id='a'",
    "UPDATE __record_source_text_heads SET head_json='{}' WHERE source_id='a'",
    'DROP TABLE __record_source_text_links; CREATE TABLE __record_source_text_links(source_id TEXT,id TEXT,next INTEGER)',
    'DROP TABLE __record_source_text_occurrences',
  ];
  for (const fault of faults) {
    f.db.exec(fault);
    exact(f.db, 'a', expected);
    assert.equal(
      f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get('a')!.details_json,
      expected,
    );
  }
  const indexes = f.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name GLOB '__record_source_text_*'",
    )
    .all();
  assert.ok(indexes.length);
  for (const index of indexes) f.db.exec(`DROP INDEX "${String(index.name)}"`);
  exact(f.db, 'a', expected);
  for (const row of f.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_source_text_*'",
    )
    .all())
    f.db.exec(`DROP TABLE "${String(row.name)}"`);
  exact(f.db, 'a', expected);
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE '%source_text%'",
      )
      .get()!.n,
    0,
  );
});

test('matching source hashes, rename and delete retain other references and exact evidence', (t) => {
  const f = fixture(t),
    expected = JSON.stringify({ fictional: 'shared repeated piece. '.repeat(1000) });
  f.insert('a', expected);
  f.insert('b', expected);
  exact(f.db, 'a', expected);
  const b = rows(f.db, 'occurrences', 'b');
  f.db.exec(
    "UPDATE __record_source_text_contents SET text='corrupt shared content' WHERE id=(SELECT content_id FROM __record_source_text_occurrences WHERE source_id='a' LIMIT 1)",
  );
  exact(f.db, 'a', expected);
  exact(f.db, 'b', expected);
  assert.deepEqual(
    rows(f.db, 'occurrences', 'b').map((row) => row.content_id),
    b.map((row) => row.content_id),
  );
  const repairedB = rows(f.db, 'occurrences', 'b'),
    repairedLinks = rows(f.db, 'links', 'b');
  transaction(f.db, () => {
    f.db.prepare('UPDATE source_files SET id=? WHERE id=?').run('renamed', 'a');
    exact(f.db, 'renamed', expected);
  });
  assert.throws(() => readSourceTextProjection(f.db, 'a'), /missing|not found|unknown/i);
  const cleanupBefore = sourceTextProjectionCounters(f.db).cleanupAffectedReferences;
  const affectedContentIds = new Set(
    rows(f.db, 'occurrences', 'renamed').map((row) => row.content_id),
  );
  transaction(f.db, () => f.db.prepare('DELETE FROM source_files WHERE id=?').run('renamed'));
  exact(f.db, 'b', expected);
  assert.equal(
    sourceTextProjectionCounters(f.db).cleanupAffectedReferences - cleanupBefore,
    affectedContentIds.size,
  );
  assert.deepEqual(rows(f.db, 'occurrences', 'b'), repairedB);
  assert.deepEqual(rows(f.db, 'links', 'b'), repairedLinks);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM __record_source_text_occurrences WHERE source_id!='b'")
      .get()!.n,
    0,
  );
});

test('post-COMMIT flush and release failures invalidate readiness while preserving committed text', (t) => {
  for (const stage of ['flush', 'release'] as const) {
    const f = fixture(t);
    f.insert('a', '{"fictional":"old"}');
    exact(f.db, 'a', '{"fictional":"old"}');
    registerTransactionDurability(f.db, {
      prepare() {},
      [stage]() {
        throw Error(`fictional ${stage} failure`);
      },
    });
    assert.throws(
      () =>
        transaction(f.db, () => {
          f.write('a', '{"fictional":"committed"}');
          exact(f.db, 'a', '{"fictional":"committed"}');
        }),
      new RegExp(`${stage} failure`),
    );
    registerTransactionDurability(f.db, null);
    const reads = sourceTextProjectionCounters(f.db).authorityReads;
    exact(f.db, 'a', '{"fictional":"committed"}');
    assert.equal(sourceTextProjectionCounters(f.db).authorityReads - reads, 1);
  }
});

test('failed durable publication restores authority and invalidates warmed private readiness', (t) => {
  const f = fixture(t),
    objects = new Map<string, Buffer>();
  let fail = false;
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, value) {
      objects.set(name, Buffer.from(value));
    },
    publishHead(value) {
      if (fail) throw Error('fictional publication failure');
      objects.set('head', Buffer.from(value));
    },
  };
  const old = '{ "fictional": "accepted Ω" }';
  f.insert('a', old);
  attachRecordDurability(f.db, { profileId: 'fictional-rope', storage });
  exact(f.db, 'a', old);
  const head = storage.read('head');
  fail = true;
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.write('a', '{"fictional":"unaccepted"}');
        exact(f.db, 'a', '{"fictional":"unaccepted"}');
      }),
    /publication failure/,
  );
  assert.deepEqual(storage.read('head'), head);
  exact(f.db, 'a', old);
});

test('exhausted automatic matching never replaces the retained source with a fresh rope', (t) => {
  const f = fixture(t),
    old = JSON.stringify({ fictional: 'distinct repeated passage '.repeat(300) });
  f.insert('a', old);
  exact(f.db, 'a', old);
  const before = rows(f.db, 'occurrences', 'a');
  assert.throws(
    () =>
      transaction(f.db, () => {
        f.write('a', JSON.stringify({ fictional: 'x' + 'distinct repeated passage '.repeat(300) }));
        reconcileSourceTextProjection(f.db, { matchingLimits: { maxScanUtf16Units: 1 } });
      }),
    /limit|budget|exceed/i,
  );
  exact(f.db, 'a', old);
  assert.deepEqual(rows(f.db, 'occurrences', 'a'), before);
});

test('repeated source UPSERTs and malformed authority do not lose dirty tracking or invent empty text', (t) => {
  const f = fixture(t);
  f.insert('a', '{"fictional":1}');
  exact(f.db, 'a', '{"fictional":1}');
  transaction(f.db, () => {
    const upsert = f.db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET details_json=excluded.details_json',
    );
    for (const n of [2, 3])
      upsert.run('a', 'a.txt', 'a'.repeat(64), 0, 'derived', `{"fictional":${n}}`);
    exact(f.db, 'a', '{"fictional":3}');
  });
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.write('a', '{');
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  f.db.exec('DROP TABLE __record_source_text_heads');
  assert.throws(() => readSourceTextProjection(f.db, 'a'), /authority.*corrupt|JSON/i);
  for (const raw of [
    '{"intake":null}',
    '{"intake":{"workflow":null}}',
    '{"intake":{"workflow":{"format":"unsupported-fictional-v999"}}}',
  ]) {
    f.write('a', raw);
    assert.throws(() => readSourceTextProjection(f.db, 'a'), /incomplete|unsupported/i);
    assert.equal(
      f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get('a')!.details_json,
      raw,
    );
  }
});

test('malformed derived identities and BLOB content keys repair without laundering malformed source identity', (t) => {
  const expected = '{"fictional":"verified source"}';
  for (const malformed of [null, '', 'x'.repeat(1025), Buffer.alloc(64)]) {
    const f = fixture(t);
    f.insert('a', expected);
    exact(f.db, 'a', expected);
    f.db
      .prepare('INSERT INTO __record_source_text_heads VALUES(?,?,?,?,?)')
      .run(malformed, 'fictional-rope', 'a'.repeat(64), 'wrong', '{}');
    exact(f.db, 'a', expected);
    assert.equal(f.db.prepare('SELECT count(*) n FROM __record_source_text_heads').get()!.n, 1);
    f.db
      .prepare('INSERT INTO __record_source_text_contents VALUES(?,?)')
      .run(Buffer.alloc(64, 7), 'unreferenced corrupt BLOB key');
    exact(f.db, 'a', expected);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM __record_source_text_contents WHERE typeof(id)='blob'")
        .get()!.n,
      0,
    );
    const oldId = f.db
      .prepare('SELECT content_id FROM __record_source_text_occurrences WHERE source_id=? LIMIT 1')
      .get('a')!.content_id;
    const blobId = Buffer.alloc(64, 8);
    f.db.prepare('UPDATE __record_source_text_contents SET id=? WHERE id=?').run(blobId, oldId!);
    f.db
      .prepare('UPDATE __record_source_text_occurrences SET content_id=? WHERE content_id=?')
      .run(blobId, oldId!);
    exact(f.db, 'a', expected);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM __record_source_text_contents WHERE typeof(id)='blob'")
        .get()!.n,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT details_json FROM source_files WHERE id=?').get('a')!.details_json,
      expected,
    );
  }
});

test('malformed actual source identities fail and remain preserved as unavailable evidence', (t) => {
  for (const malformed of [null, '', 'x'.repeat(1025), Buffer.alloc(64)]) {
    const f = fixture(t);
    f.insert('a', '{"fictional":"valid"}');
    exact(f.db, 'a', '{"fictional":"valid"}');
    f.db
      .prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      )
      .run(
        malformed,
        'fictional-malformed.txt',
        'a'.repeat(64),
        0,
        'derived',
        '{"fictional":"unavailable identity"}',
      );
    assert.throws(() => reconcileSourceTextProjection(f.db), /source identity|binding|identity/i);
    assert.equal(f.db.prepare('SELECT count(*) n FROM source_files').get()!.n, 2);
  }
});

test('BLOB source kind is unavailable authority rather than a derived-cache repair candidate', (t) => {
  const f = fixture(t);
  f.insert('a', '{"fictional":"retained evidence"}');
  exact(f.db, 'a', '{"fictional":"retained evidence"}');
  f.db.prepare('UPDATE source_files SET kind=? WHERE id=?').run(Buffer.from('derived'), 'a');
  assert.throws(() => reconcileSourceTextProjection(f.db), /authority.*unavailable|source kind/i);
  assert.equal(
    f.db.prepare("SELECT typeof(kind) kind FROM source_files WHERE id='a'").get()!.kind,
    'blob',
  );
});
