import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VAULT_CERTIFICATE_SCHEMA,
  orderedVaultCertificateRows,
  orderedChangedVaultCertificateRows,
  vaultRecordCertificates,
  type VaultRecordCertificate,
} from '../vault-record-certificates.ts';
import { createIntakeTree, type IntakeTreeRoot } from '../intake-state-tree.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';
import { MAX_CERTIFICATE_DELTA_CHUNK_BYTES } from '../contributor-certificate-delta.ts';

test('private 64-certificate spans reuse actual authenticated page reads without retaining a cache', (t) => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    let checks = 0;
    const codec = vaultRecordCertificates(
        sql,
        'fictional-private-batch',
        randomUUID(),
        () => checks++,
      ),
      values: VaultRecordCertificate[] = Array.from({ length: 256 }, (_, index) => ({
        entity: 'people',
        recordId: JSON.stringify(['fictional-batch-' + index]),
        versionId: 'fictional-version-' + index,
        deleted: Number(index % 7 === 0),
        preimage: { hash: 'd'.repeat(64), bytes: 16 },
        fields: [],
      }));
    let root: IntakeTreeRoot = null;
    for (let offset = 0; offset < values.length; offset += 64)
      root = codec.putMany(root, values.slice(offset, offset + 64)).root;
    const requests = [
        ...values.slice(0, 62),
        { entity: 'people', recordId: '["fictional-missing"]' },
        values[0]!,
      ],
      beforeSerial = intakeWorkCounters(sql).warm.collectionNodeReads,
      expected = withIntakeWork(sql, 'warm', () =>
        requests.map((request) => codec.getPrivate(root, request.entity, request.recordId)),
      ),
      serialReads = intakeWorkCounters(sql).warm.collectionNodeReads - beforeSerial,
      beforeBatch = intakeWorkCounters(sql).warm.collectionNodeReads;
    checks = 0;
    const actual = withIntakeWork(sql, 'warm', () => codec.getManyPrivate(root, requests)),
      batchReads = intakeWorkCounters(sql).warm.collectionNodeReads - beforeBatch;
    assert.deepEqual(actual, expected);
    assert.equal(actual?.length, 64);
    assert.equal(checks, 2, 'the native batch closes its scratch proof before exposing results');
    assert.ok(batchReads < serialReads, `${batchReads} vs ${serialReads} native page reads`);
    const beforeRepeat = intakeWorkCounters(sql).warm.collectionNodeReads;
    assert.deepEqual(
      withIntakeWork(sql, 'warm', () => codec.getManyPrivate(root, requests)),
      expected,
    );
    assert.equal(
      intakeWorkCounters(sql).warm.collectionNodeReads - beforeRepeat,
      batchReads,
      'another invocation rereads every required authenticated path',
    );
    const beforeRefusal = checks;
    assert.throws(
      () => codec.getManyPrivate(root, [...requests, requests[0]!]),
      /batch exceeds bound/,
    );
    assert.equal(checks, beforeRefusal, 'oversized input refuses before admission');
    const old = root,
      replacement = { ...values[0]!, versionId: 'fictional-replacement' };
    root = codec.putMany(root, [replacement]).root;
    assert.deepEqual(codec.getManyPrivate(old, [values[0]!]), [values[0]]);
    assert.deepEqual(codec.getManyPrivate(root, [values[0]!]), [replacement]);
    sql.exec("UPDATE certificate_pages SET raw='{}'");
    assert.throws(() => codec.getManyPrivate(root, requests), /intake|collection/i);
    t.diagnostic(JSON.stringify({ requests: requests.length, serialReads, batchReads }));
  } finally {
    sql.close();
  }
});

test('private certificate batches detach inputs before admission and refuse closing cancellation', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    let cancelled = false,
      checks = 0,
      stopAt = Infinity;
    const codec = vaultRecordCertificates(sql, 'fictional-batch-cancel', randomUUID(), () => {
        if (cancelled || ++checks === stopAt) throw Error('fictional batch owner cancelled');
      }),
      value: VaultRecordCertificate = {
        entity: 'people',
        recordId: '["fictional-person"]',
        versionId: 'fictional-version',
        deleted: 0,
        preimage: { hash: 'a'.repeat(64), bytes: 12 },
        fields: [],
      },
      root = codec.put(null, value).root;
    const request = {
      entity: value.entity,
      get recordId() {
        cancelled = true;
        return value.recordId;
      },
    };
    assert.throws(() => codec.getManyPrivate(root, [request]), /owner cancelled/);
    cancelled = false;
    checks = 0;
    stopAt = 2;
    assert.throws(() => codec.getManyPrivate(root, [value, value]), /owner cancelled/);
    assert.equal(checks, 2, 'closing refusal never exposes even the first completed result');
    stopAt = Infinity;
    let afterPages = false;
    sql.setAuthorizer((_action, table) => {
      if (table === 'certificates') {
        afterPages = true;
        cancelled = true;
      }
      return constants.SQLITE_OK;
    });
    assert.throws(() => codec.getManyPrivate(root, [value, value]), /owner cancelled/);
    assert.equal(afterPages, true, 'certificate reprepare follows an authenticated cached page');
  } finally {
    sql.close();
  }
});

test('native batch reprepare cannot expose cached results after same-byte scratch mutation', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    const stamp = sql.prepare('SELECT total_changes() n'),
      mutate = sql.prepare('UPDATE certificate_pages SET raw=raw');
    let expected: unknown,
      changed = false;
    const codec = vaultRecordCertificates(sql, 'fictional-batch-scratch', randomUUID(), () => {
        if (expected !== undefined && stamp.get()!.n !== expected)
          throw Error('fictional batch scratch changed');
      }),
      value: VaultRecordCertificate = {
        entity: 'people',
        recordId: '["fictional-person"]',
        versionId: 'fictional-version',
        deleted: 0,
        preimage: { hash: 'a'.repeat(64), bytes: 12 },
        fields: [],
      },
      root = codec.put(null, value).root;
    expected = stamp.get()!.n;
    sql.setAuthorizer((_action, table) => {
      if (!changed && table === 'certificates') {
        changed = true;
        mutate.run();
      }
      return constants.SQLITE_OK;
    });
    assert.throws(() => codec.getManyPrivate(root, [value, value]), /scratch changed/);
    assert.equal(
      changed,
      true,
      'mutation occurs after an earlier page entered the invocation cache',
    );
    assert.notEqual(stamp.get()!.n, expected);
    sql.setAuthorizer(null);
    expected = stamp.get()!.n;
    assert.deepEqual(codec.getManyPrivate(root, [value, value]), [value, value]);
  } finally {
    sql.close();
  }
});

test('private certificate reads seal one native synchronous lookup without skipping page authentication', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    let checks = 0;
    const codec = vaultRecordCertificates(
      sql,
      'fictional-private-read',
      randomUUID(),
      () => checks++,
    );
    const values: VaultRecordCertificate[] = Array.from({ length: 128 }, (_, index) => ({
      entity: 'source_files',
      recordId: JSON.stringify(['fictional-source-' + index]),
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: 'a'.repeat(64), bytes: 16 },
      fields: [],
    }));
    let root: IntakeTreeRoot = null;
    for (const value of values) root = codec.put(root, value).root;
    for (const value of values) {
      checks = 0;
      assert.deepEqual(codec.getPrivate(root, value.entity, value.recordId), value);
      assert.equal(checks, 2);
    }
    checks = 0;
    assert.equal(codec.getPrivate(root, 'source_files', '["fictional-missing"]'), undefined);
    assert.equal(checks, 2);
    checks = 0;
    codec.get(root, values[0].entity, values[0].recordId);
    assert.ok(checks > 2, 'generic callers retain per-page guard checks');
    const originalGet = StatementSync.prototype.get;
    let substituted = false;
    try {
      StatementSync.prototype.get = function (...args) {
        substituted = true;
        return Reflect.apply(originalGet, this, args);
      };
      assert.deepEqual(codec.getPrivate(root, values[0].entity, values[0].recordId), values[0]);
      assert.equal(substituted, false, 'private reads use the captured native method');
    } finally {
      StatementSync.prototype.get = originalGet;
    }
    sql.exec("UPDATE certificates SET raw='{}'");
    checks = 0;
    assert.throws(
      () => codec.getPrivate(root, values[0].entity, values[0].recordId),
      /certificate changed/,
    );
    assert.equal(checks, 2, 'refusal still closes the owner proof');
    sql.exec("UPDATE certificate_pages SET raw='{}'");
    checks = 0;
    assert.throws(
      () => codec.getPrivate(root, values[0].entity, values[0].recordId),
      /intake|collection/i,
    );
    assert.equal(checks, 2);
  } finally {
    sql.close();
  }
});

test('private certificate input access precedes admission and closing cancellation never returns a value', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    let cancelled = false;
    const codec = vaultRecordCertificates(
      sql,
      'fictional-private-cancellation',
      randomUUID(),
      () => {
        if (cancelled) throw Error('fictional owner cancelled');
      },
    );
    const value: VaultRecordCertificate = {
      entity: 'app_meta',
      recordId: '["fictional-key"]',
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: 'b'.repeat(64), bytes: 12 },
      fields: [],
    };
    const root = codec.put(null, value).root!;
    const changingInput = {
      ...root,
      get hash() {
        cancelled = true;
        return root.hash;
      },
    };
    assert.throws(
      () => codec.getPrivate(changingInput, value.entity, value.recordId),
      /owner cancelled/,
    );
    cancelled = false;
    // Production private connections install no policy callbacks. Even an
    // intentionally injected native reprepare cancellation must not escape.
    let reauthorized = false;
    sql.setAuthorizer(() => {
      reauthorized = true;
      cancelled = true;
      return constants.SQLITE_OK;
    });
    assert.throws(() => codec.getPrivate(root, value.entity, value.recordId), /owner cancelled/);
    assert.equal(reauthorized, true);
  } finally {
    sql.close();
  }
});

test('custom certificate preparation keeps its per-page callback guard', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    const prepare = sql.prepare;
    let cancelled = false,
      active = false,
      visited = false;
    sql.prepare = function (source: string) {
      const statement = Reflect.apply(prepare, this, [source]) as StatementSync;
      if (source !== 'SELECT raw FROM certificate_pages WHERE hash=?') return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property !== 'get') return Reflect.get(target, property, target);
          return (...args: unknown[]) => {
            const value = Reflect.apply(target.get, target, args);
            if (active) {
              visited = true;
              cancelled = true;
            }
            return value;
          };
        },
      });
    };
    const codec = vaultRecordCertificates(sql, 'fictional-custom-preparation', randomUUID(), () => {
      if (cancelled) throw Error('fictional owner cancelled');
    });
    const value: VaultRecordCertificate = {
      entity: 'app_meta',
      recordId: '["fictional-key"]',
      versionId: randomUUID(),
      deleted: 0,
      preimage: { hash: 'c'.repeat(64), bytes: 12 },
      fields: [],
    };
    const root = codec.put(null, value).root;
    assert.equal(codec.supportsPrivateBatch, false);
    assert.equal(codec.getManyPrivate(root, [value]), undefined);
    active = true;
    assert.throws(() => codec.getPrivate(root, value.entity, value.recordId), /owner cancelled/);
    assert.equal(visited, true);
  } finally {
    sql.close();
  }
});

test('disk roster orders fixed certificate keys before reading full versions', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(
      'CREATE TABLE __record_current(entity TEXT NOT NULL,record_id TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(entity,record_id));' +
        'CREATE TABLE __record_versions(version_id TEXT PRIMARY KEY,contents_json TEXT NOT NULL,deleted INTEGER NOT NULL)',
    );
    const values = [
      ['people', '["fictional-one"]'],
      ['app_meta', '["fictional-setting"]'],
      ['source_files', '["fictional-source"]'],
      ['people', '["fictional-two"]'],
    ];
    for (const [index, [entity, recordId]] of values.entries()) {
      sql
        .prepare('INSERT INTO __record_current VALUES(?,?,?)')
        .run(entity, recordId, String(index));
      sql
        .prepare('INSERT INTO __record_versions VALUES(?,?,0)')
        .run(String(index), index === 0 ? 'x'.repeat(1024 * 1024) : '{}');
    }
    sql.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048');
    sql.exec(
      'CREATE TEMP TABLE __record_changed(value TEXT); CREATE TEMP TRIGGER __record_capture AFTER INSERT ON main.__record_current BEGIN INSERT INTO __record_changed VALUES(new.record_id); END',
    );
    const key = ([entity, recordId]: string[]) =>
      createHash('sha256')
        .update(JSON.stringify([entity, recordId]))
        .digest('hex');
    const rows = [...orderedVaultCertificateRows(sql, () => {})];
    assert.deepEqual(
      rows.map((row) => [row.entity, row.record_id]),
      [...values].sort((a, b) => key(a).localeCompare(key(b))),
    );
    assert.equal(
      String(rows.find((row) => row.record_id === values[0]![1])?.contents_json).length,
      1024 * 1024,
    );
    assert.equal(sql.prepare('PRAGMA temp_store').get()!.temp_store, 1);
    assert.equal(sql.prepare('PRAGMA temp.cache_size').get()!.cache_size, -2048);
    assert.equal(sql.prepare('SELECT count(*) n FROM temp.__record_changed').get()!.n, 0);
    sql
      .prepare('INSERT INTO __record_current VALUES(?,?,?)')
      .run('people', '["after-roster"]', 'later');
    assert.equal(
      sql.prepare('SELECT value FROM temp.__record_changed').get()!.value,
      '["after-roster"]',
    );
    assert.equal(
      sql
        .prepare(
          "SELECT count(*) n FROM sqlite_temp_master WHERE name='__vault_certificate_roster'",
        )
        .get()!.n,
      0,
    );
    assert.deepEqual(
      [...orderedVaultCertificateRows(sql, () => {}, true)].map((row) => row.entity).sort(),
      ['app_meta', 'source_files'],
    );
    const current = sql.prepare(
      'UPDATE __record_current SET version_id=? WHERE entity=? AND record_id=?',
    );
    let checks = 0;
    assert.throws(
      () => [
        ...orderedVaultCertificateRows(sql, () => {
          if (++checks === (values.length + 1) * 2 + 2)
            current.run('changed-version', values[0]![0], values[0]![1]);
        }),
      ],
      /certificate roster changed/,
    );
  } finally {
    sql.close();
  }
});

function changedRosterFixture(sql: DatabaseSync) {
  sql.exec(
    'PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-2048;' +
      'CREATE TABLE __record_current(entity TEXT,record_id TEXT,version_id TEXT,PRIMARY KEY(entity,record_id));' +
      'CREATE TABLE __record_versions(version_id TEXT PRIMARY KEY,profile_id TEXT,entity TEXT,record_id TEXT,sequence INTEGER,previous_version TEXT,contents_json TEXT,deleted INTEGER);' +
      'CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,sequence INTEGER,head_json TEXT);' +
      "INSERT INTO __record_state VALUES(1,3,'fictional-head'); CREATE TEMP TABLE fictional_existing_temp(value TEXT)",
  );
  const version = sql.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?)'),
    current = sql.prepare('INSERT OR REPLACE INTO __record_current VALUES(?,?,?)'),
    expected: {
      entity: string;
      recordId: string;
      versionId: string;
      previous: string | null;
      deleted: number;
    }[] = [];
  for (let index = 0; index < 128; index++) {
    const entity = index % 16 ? 'people' : 'app_meta',
      recordId = JSON.stringify(['fictional-' + index]),
      base = 'base-' + index;
    version.run(base, 'fictional-profile', entity, recordId, 1, null, '{}', 0);
    current.run(entity, recordId, base);
    if (index >= 96) continue;
    let id = 'updated-' + index;
    const deleted = Number(index === 3);
    version.run(id, 'fictional-profile', entity, recordId, 2, base, '{}', deleted);
    if (index < 2) {
      const repeated = 'repeated-' + index;
      version.run(
        repeated,
        'fictional-profile',
        entity,
        recordId,
        3,
        id,
        index === 0 ? 'x'.repeat(1024 * 1024) : '{}',
        0,
      );
      id = repeated;
    }
    current.run(entity, recordId, id);
    expected.push({ entity, recordId, versionId: id, previous: base, deleted });
  }
  version.run('new', 'fictional-profile', 'people', '["fictional-new"]', 3, null, '{}', 0);
  current.run('people', '["fictional-new"]', 'new');
  expected.push({
    entity: 'people',
    recordId: '["fictional-new"]',
    versionId: 'new',
    previous: null,
    deleted: 0,
  });
  version.run('foreign', 'other-profile', 'people', '["fictional-foreign"]', 3, null, '{}', 0);
  current.run('people', '["fictional-foreign"]', 'foreign');
  return expected;
}

test('changed disk roster sorts only touched keys and preserves first predecessors and final payloads', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const expected = changedRosterFixture(sql),
      selectedKey = (value: { entity: string; recordId: string }) =>
        createHash('sha256')
          .update(JSON.stringify([value.entity, value.recordId]))
          .digest('hex'),
      tempSchema = sql.prepare('PRAGMA temp.schema_version').get()!.schema_version;
    let inspected = false;
    const rows = [
      ...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
        if (
          !sql
            .prepare(
              "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
            )
            .get()
        )
          return;
        assert.deepEqual(
          sql
            .prepare('PRAGMA temp.table_info(__vault_changed_certificate_roster)')
            .all()
            .map((row) => row.name),
          ['key', 'current_rowid', 'first_sequence', 'version_hash'],
        );
        inspected = true;
      }),
    ];
    assert.equal(inspected, true, 'only fixed membership keys and row pointers enter the sort');
    assert.deepEqual(
      rows.map((row) => ({
        entity: row.entity,
        recordId: row.record_id,
        versionId: row.version_id,
        previous: row.previous_version,
        deleted: row.deleted,
      })),
      expected.sort((a, b) => selectedKey(a).localeCompare(selectedKey(b))),
    );
    assert.equal(
      rows.length,
      97,
      'unchanged and foreign-profile rows never enter the changed roster',
    );
    assert.equal(
      String(rows.find((row) => row.version_id === 'repeated-0')!.contents_json).length,
      1024 * 1024,
    );
    assert.equal(sql.isTransaction, false);
    assert.equal(sql.prepare('PRAGMA temp.schema_version').get()!.schema_version, tempSchema);
    assert.equal(
      sql
        .prepare("SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'")
        .get(),
      undefined,
    );
    const early = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {});
    assert.equal(early.next().done, false);
    early.return(undefined);
    assert.equal(sql.isTransaction, false);
    assert.equal(
      [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})].length,
      97,
    );
    sql.exec('BEGIN');
    assert.throws(
      () => [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})],
      /idle replay/,
    );
    assert.equal(
      sql.isTransaction,
      true,
      'the helper never rolls back an existing owner transaction',
    );
    sql.exec('ROLLBACK');
  } finally {
    sql.close();
  }
});

test('changed roster cooperates at bounded enrollment windows and once per streamed row', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    changedRosterFixture(sql);
    const callbacks: number[] = [];
    const rows = [
      ...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
        const roster = sql
          .prepare(
            "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
          )
          .get();
        if (roster)
          callbacks.push(
            Number(
              sql.prepare('SELECT count(*) n FROM temp.__vault_changed_certificate_roster').get()!
                .n,
            ),
          );
      }),
    ];
    assert.equal(rows.length, 97);
    assert.deepEqual(callbacks, [64, 97, ...Array.from({ length: 97 }, () => 97)]);
    assert.equal(sql.isTransaction, false);
  } finally {
    sql.close();
  }
});

test('changed roster keeps dense checks for a custom SQL facade and refuses a mid-stream swap', () => {
  for (const swapAfterYield of [false, true]) {
    const sql = new DatabaseSync(':memory:');
    try {
      changedRosterFixture(sql);
      const prepare = sql.prepare;
      let checks = 0;
      if (!swapAfterYield) sql.prepare = (source: string) => Reflect.apply(prepare, sql, [source]);
      const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
        checks++;
      });
      assert.equal(rows.next().done, false);
      if (swapAfterYield) {
        sql.prepare = (source: string) => Reflect.apply(prepare, sql, [source]);
        assert.throws(() => rows.next(), /SQL facade changed/);
        assert.equal(sql.isTransaction, false);
      } else {
        assert.equal([...rows].length, 96);
        assert.ok(checks > 97 * 2, `custom facade received ${checks} dense checks`);
      }
    } finally {
      sql.close();
    }
  }
});

test('changed roster cooperates when UTF-8 keys cross the enrollment byte window', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    changedRosterFixture(sql);
    sql.exec('DELETE FROM __record_current; DELETE FROM __record_versions');
    const largeId = JSON.stringify(['é'.repeat(MAX_CERTIFICATE_DELTA_CHUNK_BYTES / 4 + 1)]),
      secondLargeId = JSON.stringify(['ê'.repeat(MAX_CERTIFICATE_DELTA_CHUNK_BYTES / 4 + 1)]);
    assert.ok(Buffer.byteLength(largeId) < MAX_CERTIFICATE_DELTA_CHUNK_BYTES - 256);
    const version = sql.prepare('INSERT INTO __record_versions VALUES(?,?,?,?,?,?,?,?)'),
      current = sql.prepare('INSERT INTO __record_current VALUES(?,?,?)');
    version.run('large', 'fictional-profile', 'app_meta', largeId, 2, null, '{}', 0);
    current.run('app_meta', largeId, 'large');
    version.run('large-2', 'fictional-profile', 'app_meta', secondLargeId, 2, null, '{}', 0);
    current.run('app_meta', secondLargeId, 'large-2');
    version.run('small', 'fictional-profile', 'people', '["fictional-small"]', 2, null, '{}', 0);
    current.run('people', '["fictional-small"]', 'small');
    const callbacks: number[] = [];
    const rows = [
      ...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
        const roster = sql
          .prepare(
            "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
          )
          .get();
        if (roster)
          callbacks.push(
            Number(
              sql.prepare('SELECT count(*) n FROM temp.__vault_changed_certificate_roster').get()!
                .n,
            ),
          );
      }),
    ];
    assert.equal(rows.length, 3);
    assert.deepEqual(callbacks, [1, 3, 3, 3, 3]);
    sql.prepare('DELETE FROM __record_current WHERE version_id=?').run('large-2');
    sql.prepare('DELETE FROM __record_versions WHERE version_id=?').run('large-2');
    const oversized = JSON.stringify(['é'.repeat(MAX_CERTIFICATE_DELTA_CHUNK_BYTES / 2)]);
    version.run('oversized', 'fictional-profile', 'people', oversized, 2, null, '{}', 0);
    current.run('people', oversized, 'oversized');
    assert.throws(
      () => [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})],
      /certificate delta value too large/,
    );
    assert.equal(sql.isTransaction, false);
  } finally {
    sql.close();
  }
});

for (const mutation of ['main', 'temp', 'head', 'schema', 'row-binding'] as const)
  test('changed roster refuses ' + mutation + ' mutation after a streamed result', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      changedRosterFixture(sql);
      const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {});
      assert.equal(rows.next().done, false);
      if (mutation === 'main') sql.exec('UPDATE __record_current SET version_id=version_id');
      if (mutation === 'temp')
        sql.exec('UPDATE temp.__vault_changed_certificate_roster SET version_hash=version_hash');
      if (mutation === 'head') sql.exec("UPDATE __record_state SET head_json='fictional-replaced'");
      if (mutation === 'schema') sql.exec('CREATE TEMP TABLE fictional_injected(value TEXT)');
      if (mutation === 'row-binding')
        sql.exec(
          "UPDATE temp.__vault_changed_certificate_roster SET version_hash='fictional-stale'",
        );
      assert.throws(() => rows.next(), /roster changed|row binding changed/);
      assert.equal(sql.isTransaction, false);
      assert.equal(
        sql
          .prepare(
            "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
          )
          .get(),
        undefined,
      );
    } finally {
      sql.close();
    }
  });

test('changed roster closes outside its snapshot and rejects a peer changed-and-restored commit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-changed-roster-peer-')),
    path = join(directory, 'replay.sqlite'),
    sql = new DatabaseSync(path),
    peer = new DatabaseSync(path);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  try {
    changedRosterFixture(sql);
    sql.exec('PRAGMA journal_mode=WAL');
    const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {});
    assert.equal(rows.next().done, false);
    const change = peer.prepare('UPDATE __record_current SET version_id=? WHERE record_id=?');
    change.run('fictional-peer-replacement', '["fictional-0"]');
    change.run('repeated-0', '["fictional-0"]');
    assert.equal(
      sql
        .prepare('SELECT version_id FROM __record_current WHERE record_id=?')
        .get('["fictional-0"]')!.version_id,
      'repeated-0',
    );
    assert.throws(() => [...rows], /roster changed/);
    assert.equal(sql.isTransaction, false);
  } finally {
    peer.close();
    sql.close();
  }
});

test('changed roster refuses a current version beyond its pinned HEAD or before the first change', () => {
  for (const sequence of [1, 4]) {
    const sql = new DatabaseSync(':memory:');
    try {
      changedRosterFixture(sql);
      sql
        .prepare('UPDATE __record_versions SET sequence=? WHERE version_id=?')
        .run(sequence, 'repeated-0');
      assert.throws(
        () => [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})],
        /row binding changed/,
      );
      assert.equal(sql.isTransaction, false);
    } finally {
      sql.close();
    }
  }
});

test('changed roster rejects a stale row pointer or version digest even with the expected insert count', () => {
  for (const field of [1, 3]) {
    const sql = new DatabaseSync(':memory:');
    try {
      changedRosterFixture(sql);
      const prepare = sql.prepare.bind(sql);
      sql.prepare = (source: string) => {
        const statement = prepare(source);
        if (source !== 'INSERT INTO temp.__vault_changed_certificate_roster VALUES(?,?,?,?)')
          return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== 'run') return Reflect.get(target, property, target);
            return (...args: unknown[]) => {
              args[field] = field === 1 ? 999999 : 'a'.repeat(64);
              return Reflect.apply(target.run, target, args);
            };
          },
        });
      };
      assert.throws(
        () => [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})],
        /row binding changed/,
      );
      assert.equal(sql.isTransaction, false);
    } finally {
      sql.close();
    }
  }
});

for (const ending of ['COMMIT', 'ROLLBACK'] as const)
  test(
    'changed roster does not enroll into or close a callback replacement after ' + ending,
    () => {
      const sql = new DatabaseSync(':memory:');
      try {
        changedRosterFixture(sql);
        let replaced = false;
        const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
          if (!replaced && sql.isTransaction) {
            replaced = true;
            sql.exec(ending + '; BEGIN');
          }
        });
        assert.throws(() => rows.next(), /transaction changed|roster changed/);
        assert.equal(replaced, true);
        assert.equal(sql.isTransaction, true, 'the replacement remains owned by its caller');
        assert.equal(
          sql
            .prepare(
              "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
            )
            .get(),
          undefined,
          'ownership is checked before any roster enrollment',
        );
        sql.prepare('INSERT INTO fictional_existing_temp VALUES(?)').run('fictional-foreign-owner');
        assert.equal(
          sql.prepare('SELECT value FROM fictional_existing_temp').get()!.value,
          'fictional-foreign-owner',
        );
        sql.exec('ROLLBACK');
        assert.equal(
          [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})].length,
          97,
        );
      } finally {
        sql.close();
      }
    },
  );

for (const ending of ['COMMIT', 'ROLLBACK'] as const)
  for (const close of [false, true])
    test(
      'changed roster refuses replacement after a yielded row at ' +
        ending +
        (close ? ' early return' : ' resumed stream'),
      () => {
        const sql = new DatabaseSync(':memory:');
        try {
          changedRosterFixture(sql);
          let streamed = false,
            replaced = false;
          const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
            if (streamed && !replaced && !close) {
              replaced = true;
              sql.exec(ending + '; BEGIN');
            }
          });
          assert.equal(rows.next().done, false);
          streamed = true;
          if (close) {
            sql.exec(ending + '; BEGIN');
            replaced = true;
          }
          assert.throws(
            () => (close ? rows.return(undefined) : rows.next()),
            /transaction changed|roster changed/,
          );
          assert.equal(replaced, true);
          assert.equal(sql.isTransaction, true, 'cleanup leaves replacement ownership intact');
          sql.prepare('INSERT INTO fictional_existing_temp VALUES(?)').run('fictional-replacement');
          assert.equal(
            sql.prepare('SELECT value FROM fictional_existing_temp').get()!.value,
            'fictional-replacement',
          );
          sql.exec('ROLLBACK');
        } finally {
          sql.close();
        }
      },
    );

for (const phase of ['enrollment', 'stream', 'closing'] as const)
  test('changed roster cancellation at ' + phase + ' rolls back and permits a fresh roster', () => {
    const sql = new DatabaseSync(':memory:');
    try {
      changedRosterFixture(sql);
      let armed = true,
        streamed = false;
      const rows = orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {
        const roster = sql
          .prepare(
            "SELECT 1 FROM sqlite_temp_master WHERE name='__vault_changed_certificate_roster'",
          )
          .get();
        const count = roster
          ? Number(
              sql.prepare('SELECT count(*) n FROM temp.__vault_changed_certificate_roster').get()!
                .n,
            )
          : 0;
        if (
          armed &&
          ((phase === 'enrollment' && count === 64) ||
            (phase === 'stream' && streamed) ||
            (phase === 'closing' && streamed && !sql.isTransaction))
        )
          throw Error('fictional changed roster cancelled');
      });
      if (phase === 'enrollment') assert.throws(() => rows.next(), /cancelled/);
      else {
        assert.equal(rows.next().done, false);
        streamed = true;
        assert.throws(
          () => (phase === 'closing' ? rows.return(undefined) : rows.next()),
          /cancelled/,
        );
      }
      assert.equal(sql.isTransaction, false);
      armed = false;
      assert.equal(
        [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})].length,
        97,
      );
    } finally {
      sql.close();
    }
  });

test('changed roster uses native transaction control and refuses failed anchor creation without cleanup of unknown ownership', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    changedRosterFixture(sql);
    const exec = sql.exec.bind(sql);
    let substituted = false;
    sql.exec = (source: string) => {
      if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(source)) {
        substituted = true;
        throw Error('fictional substituted transaction control');
      }
      exec(source);
    };
    assert.equal(
      [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})].length,
      97,
    );
    assert.equal(
      substituted,
      false,
      'owned transaction control cannot invoke a replacement exec facade',
    );
    sql.setAuthorizer((action) =>
      action === constants.SQLITE_SAVEPOINT ? constants.SQLITE_DENY : constants.SQLITE_OK,
    );
    assert.throws(
      () => [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})],
      /authorized/,
    );
    assert.equal(
      sql.isTransaction,
      false,
      'failed native admission never creates a cleanup transaction',
    );
    sql.setAuthorizer(null);
    assert.equal(
      [...orderedChangedVaultCertificateRows(sql, 'fictional-profile', 1, () => {})].length,
      97,
    );
  } finally {
    sql.close();
  }
});

test('ordered 64-certificate batches reduce counted tree work and retain complete proofs', (t) => {
  const unordered = new DatabaseSync(':memory:'),
    ordered = new DatabaseSync(':memory:'),
    nonce = randomUUID(),
    values: VaultRecordCertificate[] = Array.from({ length: 2048 }, (_, index) => ({
      entity: index % 2 ? 'people' : 'source_files',
      recordId: JSON.stringify([`fictional-order-${index}`]),
      versionId: `fictional-version-${index}`,
      deleted: Number(index % 11 === 0),
      preimage: { hash: 'a'.repeat(64), bytes: index + 1 },
      fields: [],
    }));
  try {
    let unorderedChecks = 0,
      orderedChecks = 0;
    for (const sql of [unordered, ordered]) sql.exec(VAULT_CERTIFICATE_SCHEMA + ' BEGIN');
    const first = vaultRecordCertificates(
        unordered,
        'fictional-order',
        nonce,
        () => unorderedChecks++,
      ),
      second = vaultRecordCertificates(ordered, 'fictional-order', nonce, () => orderedChecks++);
    const build = (codec: typeof first, input: VaultRecordCertificate[]) => {
      let root: IntakeTreeRoot = null;
      for (let offset = 0; offset < input.length; offset += 64)
        root = codec.putMany(root, input.slice(offset, offset + 64)).root;
      return root;
    };
    const membershipKey = (value: VaultRecordCertificate) =>
      createHash('sha256')
        .update(JSON.stringify([value.entity, value.recordId]))
        .digest('hex');
    const unorderedRoot = build(first, values);
    const orderedRoot = build(
      second,
      [...values].sort((a, b) => membershipKey(a).localeCompare(membershipKey(b))),
    );
    const buildChecks = { unordered: unorderedChecks, ordered: orderedChecks };
    assert.equal(unorderedRoot?.count, values.length);
    assert.equal(orderedRoot?.count, values.length);
    assert.ok(
      orderedChecks < unorderedChecks,
      `ordered tree checks ${orderedChecks} must improve on unordered ${unorderedChecks}`,
    );
    for (const value of values) {
      assert.deepEqual(second.get(orderedRoot, value.entity, value.recordId), value);
      assert.deepEqual(first.get(unorderedRoot, value.entity, value.recordId), value);
    }
    assert.equal(second.get(orderedRoot, 'people', '["fictional-absent"]'), undefined);
    const pages = (sql: DatabaseSync) =>
      Number(sql.prepare('SELECT count(*) n FROM certificate_pages').get()!.n);
    t.diagnostic(
      JSON.stringify({
        members: values.length,
        buildChecks,
        pages: {
          unordered: pages(unordered),
          ordered: pages(ordered),
        },
      }),
    );
  } finally {
    unordered.close();
    ordered.close();
  }
});

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

test('certificate page accounting is an exact visible subset of unchanged aggregate tree work', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec(VAULT_CERTIFICATE_SCHEMA);
    const nonce = 'fictional-accounting',
      profileId = 'fictional-profile';
    const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
    const codec = vaultRecordCertificates(sql, profileId, nonce, () => {});
    const value: VaultRecordCertificate = {
      entity: 'people',
      recordId: '["fictional-person"]',
      versionId: 'fictional-version',
      deleted: 0,
      preimage: { hash: 'd'.repeat(64), bytes: 16 },
      fields: [],
    };
    const root = withIntakeWork(sql, 'warm', () => codec.put(null, value).root);
    const generated = intakeWorkCounters(sql).warm;
    assert.ok(generated.collectionPreparedBytes > 0);
    assert.equal(generated.vaultCertificatePagePreparedBytes, generated.collectionPreparedBytes);
    assert.equal(
      generated.vaultCertificatePagePeakPreparedBytes,
      generated.collectionPeakPreparedBytes,
    );
    withIntakeWork(sql, 'warm', () =>
      assert.deepEqual(codec.getPrivate(root, value.entity, value.recordId), value),
    );
    const certificate = intakeWorkCounters(sql).warm;
    assert.equal(certificate.collectionNodeReads, 1);
    assert.equal(certificate.vaultCertificatePageReads, certificate.collectionNodeReads);
    assert.equal(certificate.vaultCertificatePageReadBytes, certificate.collectionReadBytes);
    let selectedReads = 0,
      selectedBytes = 0;
    const selected = createIntakeTree(
      { profileId, intakeId: nonce, sourceHash: hash(nonce) },
      (digest) => {
        const raw = sql.prepare('SELECT raw FROM certificate_pages WHERE hash=?').get(digest)!
          .raw as string;
        selectedReads++;
        selectedBytes += Buffer.byteLength(raw);
        return raw;
      },
      new Map(),
    );
    withIntakeWork(sql, 'warm', () =>
      selected.get(root, hash(JSON.stringify([value.entity, value.recordId]))),
    );
    const combined = intakeWorkCounters(sql).warm;
    assert.equal(combined.collectionNodeReads, certificate.collectionNodeReads + selectedReads);
    assert.equal(combined.collectionReadBytes, certificate.collectionReadBytes + selectedBytes);
    assert.equal(combined.vaultCertificatePageReads, certificate.vaultCertificatePageReads);
    assert.equal(combined.collectionNodeReads - combined.vaultCertificatePageReads, selectedReads);
    assert.equal(
      combined.collectionReadBytes - combined.vaultCertificatePageReadBytes,
      selectedBytes,
    );
  } finally {
    sql.close();
  }
});
