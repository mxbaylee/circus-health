import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import {
  readSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-piece-materialization-'));
  const path = join(root, 'cache.sqlite');
  const db = openDatabase(path, 'fictional-piece-materialization');
  const text = JSON.stringify({
    fictional: 'Exact independently fictional Ω 😀 text. '.repeat(300),
  });
  for (const id of ['a', 'b'])
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(id, `${id}.txt`, 'a'.repeat(64), 0, 'derived', text);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, path, text };
}

test('unchanged source-piece snapshots avoid SQL hydration and engine revalidation but respect lowered limits', (t) => {
  const { db, text } = fixture(t);
  assert.equal(readSourceTextProjection(db, 'a'), text);
  const before = structuredClone(sourceTextProjectionCounters(db));
  for (let i = 0; i < 3; i++) assert.equal(readSourceTextProjection(db, 'a'), text);
  const after = sourceTextProjectionCounters(db);
  assert.equal(after.projectionRowsRead, before.projectionRowsRead);
  assert.deepEqual(after.engine, before.engine);
  assert.equal(after.snapshotReuses - before.snapshotReuses, 3);
  assert.throws(
    () => readSourceTextProjection(db, 'a', { limits: { maxReconstructionUtf16Units: 1 } }),
    /limit/i,
  );
  assert.equal(readSourceTextProjection(db, 'a'), text);
});

test('same-head occurrence, link and shared-content corruption invalidate warmed snapshots', (t) => {
  const { db, text } = fixture(t);
  for (const id of ['a', 'b']) assert.equal(readSourceTextProjection(db, id), text);
  for (const fault of [
    "UPDATE __record_source_text_occurrences SET start=999999 WHERE source_id='a'",
    "UPDATE __record_source_text_links SET next=id WHERE source_id='a'",
    "UPDATE __record_source_text_contents SET text='corrupt shared content' WHERE id=(SELECT content_id FROM __record_source_text_occurrences WHERE source_id='a' LIMIT 1)",
  ]) {
    const head = db
      .prepare("SELECT head_json FROM __record_source_text_heads WHERE source_id='a'")
      .get()!.head_json;
    const before = sourceTextProjectionCounters(db).rebuiltSources;
    db.exec(fault);
    assert.equal(
      db.prepare("SELECT head_json FROM __record_source_text_heads WHERE source_id='a'").get()!
        .head_json,
      head,
    );
    for (const id of ['a', 'b']) assert.equal(readSourceTextProjection(db, id), text);
    assert.ok(sourceTextProjectionCounters(db).rebuiltSources > before);
  }
});

test('external SQLite changes and rolled-back changed text cannot reuse an old selected snapshot', (t) => {
  const { db, path, text } = fixture(t);
  assert.equal(readSourceTextProjection(db, 'a'), text);
  const other = new DatabaseSync(path);
  try {
    other.exec("UPDATE __record_source_text_links SET next=id WHERE source_id='a'");
  } finally {
    other.close();
  }
  const before = sourceTextProjectionCounters(db).rebuiltSources;
  assert.equal(readSourceTextProjection(db, 'a'), text);
  assert.ok(sourceTextProjectionCounters(db).rebuiltSources > before);
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare("UPDATE source_files SET details_json=? WHERE id='a'").run(
          '{"fictional":"unpublished"}',
        );
        assert.equal(readSourceTextProjection(db, 'a'), '{"fictional":"unpublished"}');
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(readSourceTextProjection(db, 'a'), text);
});
