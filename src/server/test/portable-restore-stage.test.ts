import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentTransactionToken, transaction } from '../database.ts';
import { createPortableProjectionTransfer } from '../portable-projection-transfer.ts';
import { createPortableOriginalInventory } from '../portable-original-inventory.ts';
import { stagePortableGenerationRows } from '../portable-restore-stage.ts';
import { createPortableSourceIndex } from '../portable-source-index.ts';
import { profilePaths } from '../profile-storage.ts';
import { PACKET_PREFERENCE_PREFIX } from '../packet-preference-codec.ts';

test('selected duplicate portable table stages only its last rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-restore-stage-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const transfer = createPortableProjectionTransfer(new Map([['items', ['id', 'note']]]), () => {});
  try {
    db.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      CREATE TABLE items(id TEXT PRIMARY KEY,note TEXT)`);
    const note = 'fictional-🌿'.repeat(100_000);
    const raw =
      `{"format":"fictional","tables":{"items":[{"id":"obsolete-root"}]},` +
      `"tables":{"items":[{"id":"obsolete-table"}],` +
      `"items":[${JSON.stringify({ id: 'selected', note })}]},` +
      `"restoreOperations":[{"key":"deferred-fictional"}]}`;
    const path = join(directory, 'generation.json');
    writeFileSync(path, raw);
    const expected = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    const staged = stagePortableGenerationRows(
      path,
      expected,
      new Map([['items', ['id', 'note']]]),
      transfer,
      () => {},
      new Set(),
    );
    assert.equal(staged.header.format, 'fictional');
    assert.equal(staged.rows.get('items'), 1);
    assert.equal(staged.deferred.get('$restoreOperations'), 1);
    transfer.assertInventory(staged.rows);
    transfer.seal();
    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (view) => {
        assert.equal(view.apply('items'), 1);
      });
    });
    transfer.assertReleased();
    const rows = db.prepare('SELECT id,note FROM items').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 'selected');
    assert.equal(rows[0]!.note, note);
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('personal packet-preference field overlays curation metadata by prefix', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-restore-preferences-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const transfer = createPortableProjectionTransfer(
    new Map([['app_meta', ['key', 'value']]]),
    () => {},
  );
  try {
    db.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const raw = JSON.stringify({
      tables: {
        app_meta: [
          { key: PACKET_PREFERENCE_PREFIX + 'obsolete', value: 'old', ignoredLegacy: 'x' },
          { key: 'curation_revision', value: '4' },
        ],
      },
    });
    const file = join(directory, 'curation.json');
    writeFileSync(file, raw);
    const selected = stagePortableGenerationRows(
      file,
      { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
      new Map([['app_meta', ['key', 'value']]]),
      transfer,
      () => {},
      new Set(),
      undefined,
      undefined,
      undefined,
      new Map(),
      PACKET_PREFERENCE_PREFIX,
    );
    assert.equal(selected.rows.get('app_meta'), 1);
    transfer.assertInventory(new Map([['app_meta', 1]]));
    transfer.seal();
    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (target) => {
        assert.equal(target.apply('app_meta'), 1);
      });
    });
    transfer.assertReleased();
    assert.deepEqual(
      db
        .prepare('SELECT key,value FROM app_meta')
        .all()
        .map((row) => ({ ...row })),
      [{ key: 'curation_revision', value: '4' }],
    );
  } finally {
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const count of [0, 1, 3])
  test(`curation and ${count} personal selected evidence rows retain contiguous order`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-two-generation-stage-'));
    const db = new DatabaseSync(join(directory, 'target.sqlite'));
    const schema = new Map([['evidence', ['id', 'kind']]]);
    const transfer = createPortableProjectionTransfer(schema, () => {});
    try {
      db.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      CREATE TABLE evidence(id TEXT PRIMARY KEY,kind TEXT)`);
      const stage = (file: string, entries: unknown[], start: number) => {
        const raw = JSON.stringify({ tables: { evidence: entries } });
        const path = join(directory, file);
        const bases = new Map([['evidence', start]]);
        writeFileSync(path, raw);
        return stagePortableGenerationRows(
          path,
          { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
          schema,
          transfer,
          () => bases.set('evidence', 999),
          new Set(),
          undefined,
          undefined,
          undefined,
          bases,
        );
      };
      assert.equal(
        stage(
          'curation.json',
          [
            { id: 'curation-a', kind: 'measurement' },
            { id: 'curation-b', kind: 'measurement' },
          ],
          0,
        ).rows.get('evidence'),
        2,
      );
      const personal = Array.from({ length: count }, (_, i) => ({
        id: `personal-${i}`,
        kind: 'note',
      }));
      const staged = stage('personal.json', personal, 2);
      assert.equal(staged.rows.get('evidence'), 2 + count);
      transfer.assertInventory(staged.rows);
      transfer.seal();
      transaction(db, () => {
        transfer.withTarget(db, currentTransactionToken(db)!, (view) => {
          assert.equal(view.apply('evidence'), 2 + count);
        });
      });
      transfer.assertReleased();
      assert.deepEqual(
        db
          .prepare('SELECT id,kind FROM evidence ORDER BY rowid')
          .all()
          .map((row) => ({ ...row })),
        [
          { id: 'curation-a', kind: 'measurement' },
          { id: 'curation-b', kind: 'measurement' },
          ...personal,
        ],
      );
    } finally {
      transfer.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('selected source row binds its long ID and exact lexical bytes in one callback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-source-stage-'));
  const db = new DatabaseSync(join(directory, 'target.sqlite'));
  const schema = new Map([['source_files', ['id', 'details_json']]]);
  const transfer = createPortableProjectionTransfer(schema, () => {});
  const sources = createPortableSourceIndex(() => {});
  try {
    db.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      CREATE TABLE source_files(id TEXT PRIMARY KEY,details_json TEXT)`);
    const id = 'fictional-🌿'.repeat(15_000);
    const row = `{"id":${JSON.stringify(id)},"details_json":"selected"}`;
    const raw = `{"tables":{"source_files":[{"id":"obsolete"}],"source_files":[${row}]}}`;
    const path = join(directory, 'generation.json');
    writeFileSync(path, raw);
    const expected = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    const staged = stagePortableGenerationRows(
      path,
      expected,
      schema,
      transfer,
      () => {},
      new Set(),
      sources,
    );
    assert.equal(staged.rows.get('source_files'), 1);
    const found = sources.find(() => [id]);
    assert.ok(found);
    assert.equal([...found()].join(''), row);
    assert.equal(
      sources.find(() => ['obsolete']),
      undefined,
    );
    transfer.assertInventory(staged.rows);
    transfer.seal();
    transaction(db, () => {
      transfer.withTarget(db, currentTransactionToken(db)!, (view) => {
        assert.equal(view.apply('source_files'), 1);
      });
    });
    transfer.assertReleased();
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)?.details_json,
      'selected',
    );
  } finally {
    sources.close();
    transfer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const count of [0, 1, 3])
  test(`raw-source rows append ${count} rows after a nonzero base regardless of table order`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'fictional-raw-stage-'));
    const profileId = 'cookie-dough';
    const relative = `${profilePaths(directory, profileId).relativeRoot}/sources/original.json`;
    const original = JSON.stringify({ fictional: '🌿'.repeat(5_000) });
    const bytes = Buffer.from(original);
    const originalPath = join(directory, relative);
    mkdirSync(dirname(originalPath), { recursive: true });
    writeFileSync(originalPath, bytes);
    const db = new DatabaseSync(join(directory, 'target.sqlite'));
    const schema = new Map([
      ['source_files', ['id', 'path', 'sha256', 'bytes', 'details_json']],
      ['source_records', ['id', 'source_file_id', 'raw_json']],
    ]);
    const transfer = createPortableProjectionTransfer(schema, () => {});
    const sources = createPortableSourceIndex(() => {});
    const originals = createPortableOriginalInventory(() => {});
    try {
      db.exec(`CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO app_meta VALUES('revision','0'),('clinical_review_revision','0');
      CREATE TABLE source_files(id TEXT PRIMARY KEY,path TEXT,sha256 TEXT,bytes INTEGER,details_json TEXT);
      CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT,raw_json TEXT)`);
      const id = 'fictional-selected-source';
      const digest = createHash('sha256').update(bytes).digest('hex');
      const source = {
        id,
        path: relative,
        sha256: digest,
        bytes: bytes.length,
        details_json: '{}',
      };
      const record = {
        id: 'fictional-selected-record',
        source_file_id: id,
        raw_source: { sourceFileId: id, offset: 0, bytes: bytes.length, sha256: digest },
      };
      const raw = JSON.stringify({ tables: { source_records: [record], source_files: [source] } });
      const path = join(directory, 'generation.json');
      writeFileSync(path, raw);
      const staged = stagePortableGenerationRows(
        path,
        { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
        schema,
        transfer,
        () => {},
        new Set(),
        sources,
        { root: directory, profileId },
        originals,
      );
      assert.equal(staged.rows.get('source_files'), 1);
      assert.equal(staged.rows.get('source_records'), 1);
      assert.equal(originals.count(), 1);
      assert.deepEqual(
        [...originals.originals()],
        [{ path: relative, sha256: digest, bytes: bytes.length }],
      );
      const appended = Array.from({ length: count }, (_, i) => ({
        ...record,
        id: `fictional-appended-${i}`,
      }));
      const appendRaw = JSON.stringify({ tables: { source_records: appended, source_files: [] } });
      const appendPath = join(directory, 'append.json');
      writeFileSync(appendPath, appendRaw);
      const combined = stagePortableGenerationRows(
        appendPath,
        {
          bytes: Buffer.byteLength(appendRaw),
          sha256: createHash('sha256').update(appendRaw).digest('hex'),
        },
        schema,
        transfer,
        () => {},
        new Set(),
        sources,
        { root: directory, profileId },
        originals,
        staged.rows,
      );
      assert.equal(combined.rows.get('source_files'), 1);
      assert.equal(combined.rows.get('source_records'), 1 + count);
      transfer.assertInventory(combined.rows);
      transfer.seal();
      transaction(db, () => {
        transfer.withTarget(db, currentTransactionToken(db)!, (view) => {
          assert.equal(view.apply('source_files'), 1);
          assert.equal(view.apply('source_records'), 1 + count);
        });
      });
      transfer.assertReleased();
      assert.deepEqual(
        db
          .prepare('SELECT raw_json FROM source_records ORDER BY rowid')
          .all()
          .map((row) => row.raw_json),
        Array(1 + count).fill(original),
      );
    } finally {
      originals.close();
      sources.close();
      transfer.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('selected source index refuses non-text IDs before publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-source-type-'));
  const schema = new Map([['source_files', ['id', 'details_json']]]);
  const transfer = createPortableProjectionTransfer(schema, () => {});
  const sources = createPortableSourceIndex(() => {});
  try {
    const raw = '{"tables":{"source_files":[{"id":17,"details_json":"{}"}]}}';
    const path = join(directory, 'generation.json');
    writeFileSync(path, raw);
    assert.throws(
      () =>
        stagePortableGenerationRows(
          path,
          { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') },
          schema,
          transfer,
          () => {},
          new Set(),
          sources,
        ),
      /source ID must be text/,
    );
  } finally {
    sources.close();
    transfer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
