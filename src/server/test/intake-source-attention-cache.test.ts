import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction, HttpError } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { readPreparedSourceAttention } from '../intake-source-attention.ts';
import { registerIntakeFile } from '../intake-state-access.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

test('attention invalidation survives outer conflict policies, rollback, cache disposal and cross-connection changes at yield', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-attention-cache-')),
    profile = 'fictional-profile',
    path = ensureProfileDirectories(root, profile).database,
    db = openDatabase(path, profile),
    other = new DatabaseSync(path);
  t.after(() => {
    other.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  // Small scalar rows isolate cache/invalidation tests; actual source decoding is covered by public fixtures.
  transaction(db, () => {
    for (let i = 0; i < 65; i++)
      registerIntakeFile(db, {
        id: 'fictional-' + String(i).padStart(3, '0'),
        path: 'fictional-' + i + '.txt',
        sha256: 'a'.repeat(64),
        size: 1,
        mimeType: 'text/plain',
        kind: 'intake_original',
        coverage: 'unknown',
        details: { intake: { createdAt: '2026-01-01T00:00:00Z', version: 1, proposals: [] } },
      });
  });
  let reads = 0;
  const sections = (file: { id: string; sha256: string }) => {
    reads++;
    return file.sha256 === 'b'.repeat(64) ? 2 : 1;
  };
  const read = () => readPreparedSourceAttention(db, profile, 0, sections);
  const cold = await read();
  assert.equal(cold.total, 65);
  assert.equal(cold.sections, 65);
  assert.equal(cold.items.length, 30);
  assert.equal(reads, 65);
  await read();
  assert.equal(reads, 65);
  // An outer OR REPLACE policy must not bypass idempotent dirty deduplication.
  transaction(db, () => {
    const key = 'intake_source_text:v1:fictional-000:head';
    db.prepare('INSERT OR REPLACE INTO app_meta VALUES(?,?)').run(key, 'fictional');
    db.prepare('INSERT OR REPLACE INTO app_meta VALUES(?,?)').run(key, 'fictional-again');
    db.prepare('UPDATE OR ABORT app_meta SET value=? WHERE key=?').run('fictional-final', key);
  });
  await read();
  assert.equal(reads, 66);
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare("UPDATE source_files SET sha256=? WHERE id='fictional-000'").run('b'.repeat(64));
        throw Error('rollback');
      }),
    /rollback/,
  );
  assert.deepEqual(await read(), cold);
  assert.equal(reads, 66);
  // A committed other connection changes data_version: all prior summary rows are disposable.
  other.prepare("UPDATE source_files SET sha256=? WHERE id='fictional-000'").run('b'.repeat(64));
  const updated = await read();
  assert.equal(updated.sections, 66);
  assert.equal(reads, 131);
  // Force complete cold preparation and mutate the other connection at the first async boundary.
  db.exec('DROP TABLE temp.source_attention_state_v1');
  const changed = new Promise<void>((resolve) =>
    setImmediate(() => {
      other
        .prepare("UPDATE source_files SET sha256=? WHERE id='fictional-001'")
        .run('b'.repeat(64));
      resolve();
    }),
  );
  await assert.rejects(read(), (e) => e instanceof HttpError && e.code === 'SOURCE_TEXT_CHANGED');
  await changed;
  const recovered = await read();
  assert.equal(recovered.total, 65);
  assert.equal(recovered.sections, 67);
  assert.equal(recovered.items.length, 30);
  await assert.rejects(
    readPreparedSourceAttention(db, 'foreign-profile', 0, sections),
    (e) => e instanceof HttpError && e.code === 'PROFILE_SCOPE',
  );
});
