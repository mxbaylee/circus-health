import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, managedDatabaseMethodSerial } from '../database.ts';
import { canonicalLiteral } from '../intake-format.ts';
import {
  duplicateRecord,
  nativeDuplicateRecord,
  intakePairReference,
  intakePairScope,
} from '../duplicate-review.ts';
import {
  ensureDuplicateEvidenceFunction,
  prepareDuplicateEvidenceIndex,
  duplicateEvidenceIndexWork,
  readSavedDuplicateEvidence,
} from '../duplicate-evidence-index.ts';
import {
  ensureIntakeFrontierObserver,
  captureIntakeFrontierAttempts,
  readIntakeFrontierAttempts,
} from '../intake-lookup-frontier-observer.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

test('duplicate function prerequisite does no index work and cold empty index DDL preserves the frontier', async (t) => {
  const db = openDatabase(':memory:', 'fictional');
  memoryRecordAuthority(db);
  t.after(() => db.close());
  const schema = db.prepare('PRAGMA temp.schema_version').get()!.schema_version;
  ensureDuplicateEvidenceFunction(db);
  assert.equal(db.prepare('PRAGMA temp.schema_version').get()!.schema_version, schema);
  ensureIntakeFrontierObserver(db);
  const captured = captureIntakeFrontierAttempts(db);
  assert.ok(captured);
  const method = managedDatabaseMethodSerial(db);
  await prepareDuplicateEvidenceIndex(db);
  await prepareDuplicateEvidenceIndex(db);
  assert.equal(managedDatabaseMethodSerial(db), method);
  assert.ok(readIntakeFrontierAttempts(db, captured));
});

for (const mode of ['replacement', 'failed-registration'] as const)
  test(`duplicate index refuses same-name ${mode} and cannot restore an older frontier`, async (t) => {
    const db = openDatabase(':memory:', 'fictional');
    memoryRecordAuthority(db);
    t.after(() => db.close());
    db.prepare(
      "INSERT INTO source_files(id,path,sha256,bytes) VALUES('original','fictional.txt',?,1)",
    ).run('1'.repeat(64));
    db.prepare(
      "INSERT INTO source_records(id,source_file_id,source_key,raw_json) VALUES('source','original','source','{}')",
    ).run();
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title) VALUES('saved','source','Fictional')",
    ).run();
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES('evidence','document','saved','source')",
    ).run();
    await prepareDuplicateEvidenceIndex(db);
    const expected = intakePairReference(db, nativeDuplicateRecord(db, 'document', 'saved'));
    ensureIntakeFrontierObserver(db);
    const captured = captureIntakeFrontierAttempts(db);
    assert.ok(captured);
    const name = 'CIRCUS_DUPLICATE_ORIGINAL_ID';
    if (mode === 'replacement') db.function(name, { deterministic: true }, () => 'forged');
    else assert.throws(() => Reflect.apply(db.function, db, [name, { deterministic: true }, null]));
    assert.throws(() => nativeDuplicateRecord(db, 'document', 'saved'), {
      code: 'DUPLICATE_EVIDENCE_PENDING',
    });
    assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
    await prepareDuplicateEvidenceIndex(db);
    assert.deepEqual(
      intakePairReference(db, nativeDuplicateRecord(db, 'document', 'saved')),
      expected,
    );
    assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
    const method = managedDatabaseMethodSerial(db);
    await prepareDuplicateEvidenceIndex(db);
    assert.equal(managedDatabaseMethodSerial(db), method);
  });

for (const mutation of ['protected-main', 'foreign-temp'] as const)
  test(`duplicate auxiliary initialization cannot forgive a ${mutation} write`, async (t) => {
    const db = openDatabase(':memory:', 'fictional');
    memoryRecordAuthority(db);
    t.after(() => db.close());
    db.prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)').run('fictional-input', 'before');
    ensureDuplicateEvidenceFunction(db);
    ensureIntakeFrontierObserver(db);
    const captured = captureIntakeFrontierAttempts(db);
    assert.ok(captured);
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (this === db && !injected && sql.includes('__duplicate_evidence_')) {
        injected = true;
        if (mutation === 'protected-main')
          db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(
            'after',
            'fictional-input',
          );
        else exec.call(db, 'CREATE TEMP TABLE fictional_foreign(value TEXT)');
      }
      return exec.call(this, sql);
    };
    try {
      await prepareDuplicateEvidenceIndex(db);
      assert.equal(injected, true);
      assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
    } finally {
      DatabaseSync.prototype.exec = exec;
    }
  });

test('duplicate function prerequisite refuses an unmanaged connection', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => ensureDuplicateEvidenceFunction(db), { code: 'DUPLICATE_EVIDENCE_PENDING' });
});

test('complete saved evidence index streams exact hashes, bounded windows and changed-target invalidation', async () => {
  const db = openDatabase(':memory:', 'fictional');
  try {
    db.prepare(
      "INSERT INTO source_files(id,path,sha256,bytes) VALUES('original','fictional.txt',?,1)",
    ).run('1'.repeat(64));
    for (let i = 0; i < 1025; i++) {
      const id = 'source-' + String(i).padStart(5, '0');
      db.prepare(
        'INSERT INTO source_records(id,source_file_id,source_key,raw_json) VALUES(?,?,?,?)',
      ).run(
        id,
        'original',
        id,
        JSON.stringify({
          fictional: i,
          literal: i === 1010 ? 'x'.repeat(70000) : 'Retained result',
        }),
      );
      db.prepare(
        "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,'document','saved',?,'source')",
      ).run('evidence-' + id, id);
    }
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title,extra_json) VALUES('saved','source-00000','Fictional',?)",
    ).run(
      JSON.stringify({
        import: { acceptedMapping: { kind: 'document', documentTitle: 'Fictional' } },
      }),
    );
    const legacy = duplicateRecord(db, 'document', 'saved'),
      legacyRef = intakePairReference(db, legacy),
      incoming = { ...legacy, evidence: [legacy.evidence[0]!], id: 'incoming' };
    const occurrence = { intakeVersion: 1, contextHash: 'fictional-context' };
    const expectedScope = intakePairScope(db, incoming, legacy, occurrence);
    await prepareDuplicateEvidenceIndex(db);
    const native = nativeDuplicateRecord(db, 'document', 'saved');
    assert.deepEqual(intakePairReference(db, native), legacyRef);
    assert.deepEqual(intakePairScope(db, incoming, native, occurrence), expectedScope);
    assert.equal(
      native.evidence.digest,
      createHash('sha256').update(canonicalLiteral(legacy.evidence)).digest('hex'),
    );
    assert.equal(native.evidence.count, 1025);
    const initial = duplicateEvidenceIndexWork(db);
    assert.equal(initial.coldRows, 1025);
    await prepareDuplicateEvidenceIndex(db);
    assert.equal(duplicateEvidenceIndexWork(db).rows, initial.rows);
    const params = new URL(native.evidence.url, 'http://fictional').searchParams;
    const first = readSavedDuplicateEvidence(db, params);
    assert.ok('items' in first);
    assert.equal(first.items.length, 16);
    assert.equal(first.complete, false);
    params.set('after', 'evidence-source-01009');
    const large = readSavedDuplicateEvidence(db, params);
    assert.ok('items' in large);
    assert.equal(large.items[0]!.kind, 'fragment');
    if (large.items[0]!.kind !== 'fragment') throw Error('Expected fragment');
    const fragment = readSavedDuplicateEvidence(
      db,
      new URL(large.items[0]!.url, 'http://fictional').searchParams,
    );
    assert.ok('encoding' in fragment);
    assert.equal(Buffer.from(fragment.data, 'base64').length, 32768);
    db.exec('SAVEPOINT fictional');
    db.prepare("UPDATE source_records SET raw_json='{}' WHERE id='source-01024'").run();
    assert.throws(() => nativeDuplicateRecord(db, 'document', 'saved'), {
      code: 'DUPLICATE_EVIDENCE_PENDING',
    });
    db.exec('ROLLBACK TO fictional; RELEASE fictional');
    assert.equal(
      nativeDuplicateRecord(db, 'document', 'saved').evidence.digest,
      native.evidence.digest,
    );
    db.prepare("UPDATE source_records SET raw_json='{}' WHERE id='source-01024'").run();
    await prepareDuplicateEvidenceIndex(db);
    assert.equal(duplicateEvidenceIndexWork(db).rows, initial.rows + 1025);
    assert.throws(() => readSavedDuplicateEvidence(db, params), {
      code: 'DUPLICATE_EVIDENCE_CHANGED',
    });
    db.exec('DROP TRIGGER temp.__duplicate_evidence_evidence_insert');
    assert.throws(() => nativeDuplicateRecord(db, 'document', 'saved'), {
      code: 'DUPLICATE_EVIDENCE_PENDING',
    });
  } finally {
    db.close();
  }
});

test('saved evidence invalidation preserves JSON first-property and parsed last-property source semantics', async () => {
  const db = openDatabase(':memory:', 'fictional');
  try {
    for (const id of ['carrier', 'first', 'last'])
      db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,1)').run(
        id,
        id + '.txt',
        '1'.repeat(64),
      );
    db.prepare(
      "INSERT INTO source_records(id,source_file_id,source_key,raw_json) VALUES('source','carrier','source','{}')",
    ).run();
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title) VALUES('saved','source','Fictional')",
    ).run();
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,locator_json) VALUES('evidence','document','saved','source',?)",
    ).run('{"originalSourceFileId":"first","originalSourceFileId":"last"}');
    db.prepare(
      "INSERT INTO documents(id,source_record_id,title) VALUES('broken','source','Unrelated fictional')",
    ).run();
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,locator_json) VALUES('bad-evidence','document','broken','source',?)",
    ).run('{"originalSourceFileId":"missing"}');
    await prepareDuplicateEvidenceIndex(db);
    assert.throws(() => nativeDuplicateRecord(db, 'document', 'broken'), {
      code: 'DUPLICATE_EVIDENCE',
    });
    assert.equal(nativeDuplicateRecord(db, 'document', 'saved').evidence.count, 1);
    for (const id of ['first', 'last']) {
      db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('2'.repeat(64), id);
      assert.throws(() => nativeDuplicateRecord(db, 'document', 'saved'), {
        code: 'DUPLICATE_EVIDENCE_PENDING',
      });
      await prepareDuplicateEvidenceIndex(db);
      assert.deepEqual(
        intakePairReference(db, nativeDuplicateRecord(db, 'document', 'saved')),
        intakePairReference(db, duplicateRecord(db, 'document', 'saved')),
      );
    }
  } finally {
    db.close();
  }
});
