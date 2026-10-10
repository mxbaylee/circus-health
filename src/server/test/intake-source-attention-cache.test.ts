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
import {
  ensureIntakeFrontierObserver,
  captureIntakeFrontierAttempts,
  readIntakeFrontierAttempts,
} from '../intake-lookup-frontier-observer.ts';

function attentionFixture(t: test.TestContext) {
  const db = openDatabase(':memory:', 'fictional-attention');
  memoryRecordAuthority(db);
  t.after(() => db.close());
  transaction(db, () => {
    registerIntakeFile(db, {
      id: 'fictional-source',
      path: 'fictional.txt',
      sha256: 'a'.repeat(64),
      size: 1,
      mimeType: 'text/plain',
      kind: 'intake_original',
      coverage: 'unknown',
      details: { intake: { createdAt: '2026-01-01T00:00:00Z', version: 1, proposals: [] } },
    });
  });
  let calls = 0;
  const read = () =>
    readPreparedSourceAttention(db, 'fictional-attention', 0, () => {
      calls++;
      return 3;
    });
  return { db, read, calls: () => calls };
}

test('attention rejects unchecked empty TEMP counts and observes preprepared and rolled-back writes', async (t) => {
  const f = attentionFixture(t);
  const first = await f.read();
  assert.equal(first.total, 1);
  assert.equal(first.sections, 3);
  assert.equal(f.calls(), 1);
  const replace = f.db.prepare('UPDATE temp.source_attention_counts_v1 SET sections=0');
  replace.run();
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 2);
  await f.read();
  assert.equal(f.calls(), 2, 'unchanged warm counts require no source reread');
  f.db.exec('BEGIN');
  replace.run();
  f.db.exec('ROLLBACK');
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 3, 'rollback cannot erase the private invalidation event');
});

test('attention invalidates deleted dirty sources and restored or replaced guard triggers', async (t) => {
  const f = attentionFixture(t);
  const first = await f.read();
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=details_json WHERE id=?')
      .run('fictional-source');
  });
  f.db.exec('DELETE FROM temp.source_attention_dirty_v1');
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 2);
  const trigger = f.db
    .prepare(
      "SELECT name,sql FROM temp.sqlite_schema WHERE type='trigger' AND name GLOB '__source_attention_event_*_source_attention_counts_v1_update'",
    )
    .get()!;
  f.db.exec(`DROP TRIGGER temp.${trigger.name}`);
  f.db.exec('UPDATE temp.source_attention_counts_v1 SET sections=0');
  f.db.exec(String(trigger.sql));
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 3, 'restored schema does not erase revoked runtime identity');
});

test('attention guard function replacement cannot establish empty counts and shadows refuse', async (t) => {
  const f = attentionFixture(t);
  const first = await f.read();
  const sql = String(
    f.db
      .prepare(
        "SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name GLOB '__source_attention_event_*_source_attention_counts_v1_update'",
      )
      .get()!.sql,
  );
  const name = sql.match(/SELECT (__source_attention_event_[a-f0-9]+)\(\)/)![1]!;
  f.db.function(name, () => null);
  f.db.exec('UPDATE temp.source_attention_counts_v1 SET sections=0');
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 2);
  f.db.exec('CREATE TEMP VIEW source_files AS SELECT * FROM main.source_files WHERE 0');
  await assert.rejects(f.read(), { code: 'SOURCE_TEXT_CHANGED' });
});

test('attention refuses a count mutation inside source derivation without publishing a partial queue', async (t) => {
  const f = attentionFixture(t);
  await assert.rejects(
    readPreparedSourceAttention(f.db, 'fictional-attention', 0, () => {
      f.db.exec('UPDATE temp.source_attention_state_v1 SET data_version=data_version');
      return 3;
    }),
    { code: 'SOURCE_TEXT_CHANGED' },
  );
  const recovered = await f.read();
  assert.equal(recovered.total, 1);
  assert.equal(recovered.sections, 3);
  assert.equal(f.calls(), 1);
});

test('attention and frontier observers coexist without replacing function registration or rebuilding warm rows', async (t) => {
  const f = attentionFixture(t);
  ensureIntakeFrontierObserver(f.db);
  const setter = f.db.function;
  const first = await f.read();
  assert.equal(f.db.function, setter);
  ensureIntakeFrontierObserver(f.db);
  const frontier = captureIntakeFrontierAttempts(f.db)!;
  assert.ok(frontier);
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(await f.read(), first);
    ensureIntakeFrontierObserver(f.db);
    assert.equal(f.db.function, setter);
    assert.ok(readIntakeFrontierAttempts(f.db, frontier));
  }
  assert.equal(f.calls(), 1);
  const attentionSQL = String(
    f.db
      .prepare(
        "SELECT sql FROM temp.sqlite_schema WHERE type='trigger' AND name GLOB '__source_attention_event_*_source_attention_counts_v1_update'",
      )
      .get()!.sql,
  );
  const attentionFunction = attentionSQL.match(
    /SELECT (__source_attention_event_[a-f0-9]+)\(\)/,
  )![1]!;
  f.db.function(attentionFunction, () => null);
  assert.ok(
    readIntakeFrontierAttempts(f.db, frontier),
    'unrelated private registration does not revoke frontier',
  );
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 2);
  ensureIntakeFrontierObserver(f.db);
  const renewed = captureIntakeFrontierAttempts(f.db)!;
  assert.ok(renewed);
  const frontierSQL = String(
    f.db
      .prepare(
        "SELECT sql FROM temp.sqlite_schema WHERE name GLOB '__intake_frontier_meta_update_*'",
      )
      .get()!.sql,
  );
  const frontierFunction = frontierSQL.match(/SELECT (__intake_frontier_event_[a-f0-9]+)\(/)![1]!;
  f.db.function(frontierFunction, (_a, _b, _c, _d) => null);
  assert.equal(readIntakeFrontierAttempts(f.db, renewed), undefined);
  assert.deepEqual(await f.read(), first);
  assert.equal(f.calls(), 2, 'global private registration alone does not revoke attention');
});

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
