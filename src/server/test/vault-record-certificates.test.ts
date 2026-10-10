import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  VAULT_CERTIFICATE_SCHEMA,
  vaultRecordCertificates,
  type VaultRecordCertificate,
} from '../vault-record-certificates.ts';
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

test('bounded certificate batches preserve exact members, absence and old roots with fewer actual page writes', (t) => {
  const serial = new DatabaseSync(':memory:'),
    batched = new DatabaseSync(':memory:'),
    nonce = randomUUID(),
    values: VaultRecordCertificate[] = Array.from({ length: 256 }, (_, index) => ({
      entity: index % 2 ? 'people' : 'source_files',
      recordId: JSON.stringify(['fictional-' + index]),
      versionId: randomUUID(),
      deleted: Number(index % 7 === 0),
      preimage: { hash: String(index % 10).repeat(64), bytes: index + 16 },
      fields: index % 7 ? [{ name: 'details_json', hash: 'f'.repeat(64), bytes: 1024 * 1024 }] : [],
    }));
  try {
    let serialWrites = 0,
      batchedWrites = 0;
    for (const sql of [serial, batched]) sql.exec(VAULT_CERTIFICATE_SCHEMA + ' BEGIN');
    const one = vaultRecordCertificates(
        serial,
        'fictional-batch',
        nonce,
        () => {},
        (count) => {
          serialWrites += count;
        },
      ),
      many = vaultRecordCertificates(
        batched,
        'fictional-batch',
        nonce,
        () => {},
        (count) => {
          batchedWrites += count;
        },
      );
    let serialRoot: IntakeTreeRoot = null,
      batchedRoot: IntakeTreeRoot = null,
      returnedWrites = 0;
    for (const value of values) serialRoot = one.put(serialRoot, value).root;
    for (let offset = 0; offset < values.length; offset += 64) {
      const next = many.putMany(batchedRoot, values.slice(offset, offset + 64));
      batchedRoot = next.root;
      returnedWrites += next.writes;
    }
    assert.equal(serialRoot?.count, values.length);
    assert.equal(batchedRoot?.count, values.length);
    for (const value of values) {
      assert.deepEqual(many.get(batchedRoot, value.entity, value.recordId), value);
      assert.deepEqual(
        many.get(batchedRoot, value.entity, value.recordId),
        one.get(serialRoot, value.entity, value.recordId),
      );
    }
    assert.equal(many.get(batchedRoot, 'people', '["fictional-absent"]'), undefined);
    const rows = (sql: DatabaseSync) =>
        Number(
          sql
            .prepare(
              'SELECT (SELECT count(*) FROM certificates)+(SELECT count(*) FROM certificate_pages) n',
            )
            .get()!.n,
        ),
      serialPages = Number(serial.prepare('SELECT count(*) n FROM certificate_pages').get()!.n),
      batchedPages = Number(batched.prepare('SELECT count(*) n FROM certificate_pages').get()!.n);
    assert.equal(serialWrites, rows(serial));
    assert.equal(batchedWrites, rows(batched));
    assert.equal(returnedWrites, batchedWrites);
    assert.ok(
      batchedPages < serialPages,
      'only final reachable shared paths are inserted per bounded batch',
    );
    t.diagnostic(
      JSON.stringify({
        members: values.length,
        serialPages,
        batchedPages,
        serialWrites,
        batchedWrites,
      }),
    );
    const old = batchedRoot,
      replacement = { ...values[42]!, versionId: randomUUID(), deleted: 1, fields: [] },
      added = {
        ...values[0]!,
        entity: 'app_meta',
        recordId: '["fictional-new"]',
        versionId: randomUUID(),
      };
    const next = many.putMany(batchedRoot, [replacement, added]);
    batchedRoot = next.root;
    assert.deepEqual(many.get(old, replacement.entity, replacement.recordId), values[42]);
    assert.equal(many.get(old, added.entity, added.recordId), undefined);
    assert.deepEqual(many.get(batchedRoot, replacement.entity, replacement.recordId), replacement);
    assert.deepEqual(many.get(batchedRoot, added.entity, added.recordId), added);
    assert.equal(batchedRoot?.count, values.length + 1);
    assert.deepEqual(many.putMany(batchedRoot, []), { root: batchedRoot, writes: 0 });
    assert.equal(
      many.putMany(batchedRoot, [replacement, added]).writes,
      0,
      'repeating exact members does not rewrite certificate pages',
    );
    assert.equal(rows(batched), batchedWrites);
  } finally {
    serial.close();
    batched.close();
  }
});

test('certificate batches validate all bounded rows before writes and retain last duplicate-key value', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA + ' BEGIN');
    const codec = vaultRecordCertificates(sql, 'fictional-batch-refusal', randomUUID(), () => {}),
      value: VaultRecordCertificate = {
        entity: 'people',
        recordId: '["fictional"]',
        versionId: randomUUID(),
        deleted: 0,
        preimage: { hash: '1'.repeat(64), bytes: 16 },
        fields: [],
      },
      before = Number(sql.prepare('SELECT total_changes() n').get()!.n);
    assert.throws(() => codec.putMany(null, Array(65).fill(value)), /batch exceeds bound/);
    assert.throws(
      () => codec.putMany(null, [value, { ...value, recordId: 'x'.repeat(32768) }]),
      /exceeds page/,
    );
    assert.equal(sql.prepare('SELECT total_changes() n').get()!.n, before);
    const last = { ...value, versionId: randomUUID(), deleted: 1 };
    const root = codec.putMany(null, [value, last]).root;
    assert.equal(root?.count, 1);
    assert.deepEqual(codec.get(root, value.entity, value.recordId), last);
  } finally {
    sql.close();
  }
});

test('batch owner checks surround actual writes and never expose a root after callback refusal', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA + ' BEGIN');
    const value: VaultRecordCertificate = {
      entity: 'people',
      recordId: '["fictional"]',
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: '1'.repeat(64), bytes: 16 },
      fields: [],
    };
    let refused = false,
      writes = 0;
    const codec = vaultRecordCertificates(
      sql,
      'fictional-batch-cancel',
      randomUUID(),
      () => {
        if (refused) throw Error('Fictional certificate owner refused');
      },
      (count) => {
        writes += count;
        refused = true;
      },
    );
    assert.throws(() => codec.putMany(null, [value]), /owner refused/);
    assert.equal(writes, 1, 'the first owned payload write is counted before refusal');
    assert.equal(
      sql.prepare('SELECT count(*) n FROM certificate_pages').get()!.n,
      0,
      'no membership root was written or returned',
    );
    assert.throws(() => codec.get(null, value.entity, value.recordId), /owner refused/);
  } finally {
    sql.close();
  }
});
