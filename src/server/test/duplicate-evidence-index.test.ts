import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { canonicalLiteral } from '../intake-format.ts';
import {
  duplicateRecord,
  nativeDuplicateRecord,
  intakePairReference,
  intakePairScope,
} from '../duplicate-review.ts';
import {
  prepareDuplicateEvidenceIndex,
  duplicateEvidenceIndexWork,
  readSavedDuplicateEvidence,
} from '../duplicate-evidence-index.ts';

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
