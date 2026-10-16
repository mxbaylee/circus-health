import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createIntakeCopyIncrementalReader } from '../intake-copy-incremental-reader.ts';
import {
  validatePortableIntakeSourceTextDatabase,
  validatePortableIntakeSourceTextRows,
} from '../intake-source-text.ts';

const profileId = 'fictional-copy-text-profile';
const intakeId = 'fictional-copy-text-intake';
const sourceHash = 'a'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (name: string) => `intake_source_text:v1:${intakeId}:${name}`;

function fixture(long = false) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT NOT NULL,sha256 TEXT NOT NULL,details_json TEXT);',
  );
  const put = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
  db.prepare('INSERT INTO source_files VALUES(?,?,?,?)').run(
    intakeId,
    'intake_original',
    sourceHash,
    'unrelated original details '.repeat(long ? 100_000 : 1),
  );
  const blob = (raw: string) => {
    const ref = hash(JSON.parse(raw));
    put.run(key(`blob:${ref}`), raw);
    return ref;
  };
  const relationRef = blob('[]');
  const pageRef = blob(
    JSON.stringify({
      page: { page: 1, disposition: 'extracted', inspected: true },
      spans: [
        {
          id: 'span-1',
          text: long ? 'Fictional Ω🙂 source text. '.repeat(100_000) : 'Fictional Ω source text.',
          region: { page: 1 },
          provenance: 'native',
        },
      ],
      issues: [],
    }),
  );
  const revisionId = randomUUID();
  const value = {
    header: {
      format: 'intake-source-text-v1',
      id: revisionId,
      parentRevisionId: null,
      profileId,
      intakeId,
      sourceHash,
      createdAt: '2026-01-12T00:00:00.000Z',
      adapter: { name: 'fictional', version: '1' },
      review: null,
      protectedPages: [],
    },
    pageRefs: [pageRef],
    relationRef,
  };
  put.run(key(`revision:${revisionId}`), JSON.stringify({ value, sha256: hash(value) }));
  put.run(key('head'), JSON.stringify({ revisionId, sourceHash }));
  return { db, revisionId, pageRef };
}

async function validate(db: DatabaseSync) {
  const reader = await createIntakeCopyIncrementalReader(db, () => {});
  try {
    validatePortableIntakeSourceTextDatabase(reader, profileId);
    return reader.work();
  } finally {
    reader.close();
  }
}

test('source-text copy validation streams long Unicode evidence and unrelated original details', async () => {
  const { db } = fixture(true);
  try {
    const work = await validate(db);
    assert.ok(work.bytes > 1_000_000);
    assert.ok(work.maxChunk <= 16 * 1024);
  } finally {
    db.close();
  }
});

test('source-text copy hashes parsed stringify semantics, including numeric and Unicode spelling', async () => {
  const { db, pageRef } = fixture();
  try {
    const raw = String(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`blob:${pageRef}`))!.value,
    );
    const spelled = raw.replace('"page":1', '"page":1.0').replace('Ω', '\\u03a9');
    assert.notEqual(spelled, raw);
    assert.equal(hash(JSON.parse(spelled)), pageRef);
    db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(spelled, key(`blob:${pageRef}`));
    validatePortableIntakeSourceTextRows(
      { rows: (table) => db.prepare(`SELECT * FROM ${table}`).iterate() },
      profileId,
    );
    await validate(db);
  } finally {
    db.close();
  }
});

test('source-text copy retains legacy date coercion and skips unrelated large metadata keys', async () => {
  const { db, revisionId } = fixture();
  try {
    const stored = JSON.parse(
      String(
        db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`revision:${revisionId}`))!
          .value,
      ),
    );
    stored.value.header.createdAt = [2020];
    stored.sha256 = hash(stored.value);
    db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
      JSON.stringify(stored),
      key(`revision:${revisionId}`),
    );
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run('unrelated:'.repeat(100_000), 'ignored');
    db.prepare('INSERT INTO source_files VALUES(?,?,?,?)').run(
      'unrelated-'.repeat(30_000),
      'intake_original',
      'not-a-source-text-hash'.repeat(30_000),
      null,
    );
    validatePortableIntakeSourceTextRows(
      { rows: (table) => db.prepare(`SELECT * FROM ${table}`).iterate() },
      profileId,
    );
    await validate(db);
  } finally {
    db.close();
  }
});

test('source-text copy leaves other pin versions outside the v1 validator', async () => {
  const { db } = fixture();
  try {
    db.prepare('INSERT INTO app_meta VALUES(?,?)').run(
      `intake_source_pin:v2:${intakeId}`,
      '{"future":"shape"}',
    );
    validatePortableIntakeSourceTextRows(
      { rows: (table) => db.prepare(`SELECT * FROM ${table}`).iterate() },
      profileId,
    );
    await validate(db);
  } finally {
    db.close();
  }
});

test('source-text copy preserves historical selected identities without a new length cap', async () => {
  const { db, revisionId } = fixture();
  const longId = 'fictional-selected-' + 'x'.repeat(100_000);
  const longHash = 'h'.repeat(100_000);
  try {
    db.prepare('UPDATE source_files SET id=?,sha256=? WHERE id=?').run(longId, longHash, intakeId);
    const rows = db.prepare('SELECT key,value FROM app_meta').all();
    for (const row of rows) {
      const oldKey = String(row.key);
      if (!oldKey.startsWith(`intake_source_text:v1:${intakeId}:`)) continue;
      let value = String(row.value);
      if (oldKey.endsWith(':head')) value = JSON.stringify({ revisionId, sourceHash: longHash });
      if (oldKey.endsWith(`:revision:${revisionId}`)) {
        const stored = JSON.parse(value);
        stored.value.header.intakeId = longId;
        stored.value.header.sourceHash = longHash;
        stored.sha256 = hash(stored.value);
        value = JSON.stringify(stored);
      }
      db.prepare('UPDATE app_meta SET key=?,value=? WHERE key=?').run(
        oldKey.replace(`intake_source_text:v1:${intakeId}:`, `intake_source_text:v1:${longId}:`),
        value,
        oldKey,
      );
    }
    validatePortableIntakeSourceTextRows(
      { rows: (table) => db.prepare(`SELECT * FROM ${table}`).iterate() },
      profileId,
    );
    const work = await validate(db);
    assert.ok(work.maxChunk <= 16 * 1024);
    assert.ok(work.bytes > 500_000);
  } finally {
    db.close();
  }
});

test('source-text incremental copy validation matches retained row decoder on binding faults', async () => {
  for (const mutate of [
    (db: DatabaseSync, revisionId: string) =>
      db
        .prepare('UPDATE app_meta SET value=? WHERE key=?')
        .run(JSON.stringify({ revisionId, sourceHash: 'b'.repeat(64) }), key('head')),
    (db: DatabaseSync, revisionId: string) => {
      const stored = JSON.parse(
        String(
          db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`revision:${revisionId}`))!
            .value,
        ),
      );
      stored.value.header.profileId = 'fictional-foreign-profile';
      stored.sha256 = hash(stored.value);
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
        JSON.stringify(stored),
        key(`revision:${revisionId}`),
      );
    },
    (db: DatabaseSync, revisionId: string) => {
      const stored = JSON.parse(
        String(
          db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`revision:${revisionId}`))!
            .value,
        ),
      );
      stored.value.header.parentRevisionId = revisionId;
      stored.sha256 = hash(stored.value);
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
        JSON.stringify(stored),
        key(`revision:${revisionId}`),
      );
    },
    (db: DatabaseSync, revisionId: string) => {
      const raw = JSON.stringify([
        { id: 'bad-edge', kind: 'precedes', from: 'span-1', to: 'absent', provenance: 'adapter' },
      ]);
      const ref = hash(JSON.parse(raw));
      db.prepare('INSERT INTO app_meta VALUES(?,?)').run(key(`blob:${ref}`), raw);
      const stored = JSON.parse(
        String(
          db.prepare('SELECT value FROM app_meta WHERE key=?').get(key(`revision:${revisionId}`))!
            .value,
        ),
      );
      stored.value.relationRef = ref;
      stored.sha256 = hash(stored.value);
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
        JSON.stringify(stored),
        key(`revision:${revisionId}`),
      );
    },
    (db: DatabaseSync) => {
      const row = db
        .prepare(
          "SELECT key FROM app_meta WHERE key GLOB 'intake_source_text:*:blob:*' AND value LIKE '%spans%' LIMIT 1",
        )
        .get()!;
      db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', row.key);
    },
  ]) {
    const { db, revisionId } = fixture();
    try {
      mutate(db, revisionId);
      assert.throws(() =>
        validatePortableIntakeSourceTextRows(
          { rows: (table) => db.prepare(`SELECT * FROM ${table}`).iterate() },
          profileId,
        ),
      );
      await assert.rejects(validate(db));
    } finally {
      db.close();
    }
  }
});
