import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { VAULT_CERTIFICATE_SCHEMA, vaultRecordCertificates } from '../vault-record-certificates.ts';
import type { IntakeTreeRoot } from '../intake-state-tree.ts';

test('retained accepted certificates authenticate complete positive and negative point paths', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    const index = vaultRecordCertificates(
      sql,
      'fictional-certificate-profile',
      randomUUID(),
      () => {},
    );
    let root: IntakeTreeRoot = null;
    for (let i = 0; i < 256; i++)
      root = index.put(root, {
        entity: 'source_files',
        recordId: JSON.stringify(['source-' + i]),
        versionId: randomUUID(),
        deleted: 0,
        preimage: { hash: '1'.repeat(64), bytes: 24 },
        fields: [{ name: 'id', hash: '2'.repeat(64), bytes: 12 }],
      }).root;
    assert.equal(root?.count, 256);
    assert.equal(
      index.get(root, 'source_files', JSON.stringify(['source-42']))?.fields[0]?.name,
      'id',
    );
    assert.equal(index.get(root, 'app_meta', JSON.stringify(['absent'])), undefined);
    const immutableRoot = root;
    root = index.put(root, {
      entity: 'app_meta',
      recordId: JSON.stringify(['absent']),
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: '3'.repeat(64), bytes: 32 },
      fields: [],
    }).root;
    assert.ok(index.get(root, 'app_meta', JSON.stringify(['absent'])));
    assert.equal(index.get(immutableRoot, 'app_meta', JSON.stringify(['absent'])), undefined);
    sql.prepare('DELETE FROM certificate_pages WHERE hash=?').run(root!.hash);
    assert.throws(
      () => index.get(root, 'app_meta', JSON.stringify(['missing'])),
      /intake|collection/i,
    );
    assert.throws(
      () => index.get(root, 'source_files', JSON.stringify(['source-42'])),
      /intake|collection/i,
    );
  } finally {
    sql.close();
  }
});

test('certificate payload substitution cannot agree with the retained membership root', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    const index = vaultRecordCertificates(
      sql,
      'fictional-certificate-profile',
      randomUUID(),
      () => {},
    );
    const root = index.put(null, {
      entity: 'app_meta',
      recordId: '["fixed-key"]',
      versionId: randomUUID(),
      deleted: 1,
      preimage: { hash: '4'.repeat(64), bytes: 16 },
      fields: [],
    }).root;
    sql.exec("UPDATE certificates SET raw='{}'");
    assert.throws(() => index.get(root, 'app_meta', '["fixed-key"]'), /certificate changed/);
  } finally {
    sql.close();
  }
});

test('retained roots cannot be adopted by a foreign owner or after owner cancellation', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    let closed = false;
    const check = () => {
      if (closed) throw Error('fictional owner cancelled');
    };
    const index = vaultRecordCertificates(
      sql,
      'fictional-certificate-profile',
      randomUUID(),
      check,
    );
    const root = index.put(null, {
      entity: 'source_files',
      recordId: '["fixed-source"]',
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: '5'.repeat(64), bytes: 16 },
      fields: [],
    }).root;
    const foreign = vaultRecordCertificates(sql, 'fictional-other-profile', randomUUID(), () => {});
    assert.throws(() => foreign.get(root, 'source_files', '["fixed-source"]'), /binding/i);
    closed = true;
    assert.throws(() => index.get(root, 'source_files', '["fixed-source"]'), /owner cancelled/);
    assert.throws(() => index.get(root, 'app_meta', '["absent"]'), /owner cancelled/);
  } finally {
    sql.close();
  }
});
