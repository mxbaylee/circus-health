import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  MAX_CERTIFICATE_DELTA_CHUNK_BYTES,
  MAX_CERTIFICATE_DELTA_CHUNK_COUNT,
} from './contributor-certificate-delta.ts';
import {
  createIntakeTree,
  intakeTreeRef,
  type IntakeTreeRoot,
  type IntakeTreeReadCertificate,
} from './intake-state-tree.ts';

const nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run,
  nativeIterate = StatementSync.prototype.iterate,
  nativePrepare = DatabaseSync.prototype.prepare,
  nativeExec = DatabaseSync.prototype.exec;

export interface VaultRecordCertificate {
  entity: string;
  recordId: string;
  versionId: string;
  deleted: number;
  preimage: { hash: string; bytes: number };
  fields: readonly { name: string; hash: string; bytes: number }[];
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const key = (entity: string, recordId: string) => hash(JSON.stringify([entity, recordId]));

/** Sort only fixed-size membership keys on disk; fetch complete versions one at
 * a time after ordering so a large contents_json never enters the sort. */
export function* orderedVaultCertificateRows(
  sql: DatabaseSync,
  check: () => void,
  sourceOnly = false,
) {
  if (sql.prepare('PRAGMA temp_store').get()?.temp_store !== 1)
    throw Error('Vault certificate roster requires disk-backed temp storage');
  if (sql.isTransaction) throw Error('Vault certificate roster requires an idle replay database');
  sql.exec('BEGIN');
  try {
    const stamp = sql.prepare('SELECT total_changes() n'),
      schema = sql.prepare('PRAGMA main.schema_version'),
      peer = sql.prepare('PRAGMA main.data_version'),
      scope = sourceOnly ? " WHERE entity IN ('source_files','app_meta')" : '',
      schemaVersion = schema.get()!.schema_version,
      peerVersion = peer.get()!.data_version;
    let expectedChanges = Number(stamp.get()!.n),
      enrolled = 0;
    const guard = () => {
      check();
      if (
        !sql.isTransaction ||
        stamp.get()!.n !== expectedChanges ||
        schema.get()!.schema_version !== schemaVersion ||
        peer.get()!.data_version !== peerVersion
      )
        throw Error('Vault accepted current certificate roster changed');
    };
    sql.exec(
      'CREATE TEMP TABLE __vault_certificate_roster (key TEXT PRIMARY KEY,current_rowid INTEGER NOT NULL,version_hash TEXT NOT NULL) WITHOUT ROWID',
    );
    const add = sql.prepare('INSERT INTO temp.__vault_certificate_roster VALUES(?,?,?)');
    for (const row of sql
      .prepare('SELECT rowid,entity,record_id,version_id FROM __record_current' + scope)
      .iterate()) {
      guard();
      add.run(
        key(String(row.entity), String(row.record_id)),
        row.rowid,
        hash(String(row.version_id)),
      );
      expectedChanges++;
      enrolled++;
      guard();
    }
    guard();
    if (sql.prepare('SELECT count(*) n FROM __record_current' + scope).get()!.n !== enrolled)
      throw Error('Vault accepted current certificate roster changed');
    if (sql.prepare('SELECT count(*) n FROM temp.__vault_certificate_roster').get()!.n !== enrolled)
      throw Error('Vault accepted current certificate roster changed');
    const read = sql.prepare(
      'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted ' +
        'FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.rowid=?',
    );
    for (const item of sql
      .prepare(
        'SELECT key,current_rowid,version_hash FROM temp.__vault_certificate_roster ORDER BY key',
      )
      .iterate()) {
      guard();
      const row = read.get(item.current_rowid);
      if (
        !row ||
        key(String(row.entity), String(row.record_id)) !== item.key ||
        hash(String(row.version_id)) !== item.version_hash
      )
        throw Error('Vault accepted current certificate roster changed');
      yield row;
      guard();
    }
    guard();
    if (sql.prepare('SELECT count(*) n FROM __record_current' + scope).get()!.n !== enrolled)
      throw Error('Vault accepted current certificate roster changed');
  } finally {
    if (sql.isTransaction) sql.exec('ROLLBACK');
  }
}

/** Order only the changed membership keys. The roster stores fixed-size keys
 * and row pointers, never version contents; closing checks leave the snapshot
 * before deciding whether any callback changed the replay database. */
export function* orderedChangedVaultCertificateRows(
  sql: DatabaseSync,
  profileId: string,
  afterSequence: number,
  check: (phase?: 'enrollment') => void,
) {
  if (typeof profileId !== 'string' || !Number.isSafeInteger(afterSequence) || afterSequence < 0)
    throw Error('Vault changed certificate scope invalid');
  if (sql.prepare('PRAGMA temp_store').get()?.temp_store !== 1)
    throw Error('Vault changed certificate roster requires disk-backed temp storage');
  if (sql.isTransaction)
    throw Error('Vault changed certificate roster requires an idle replay database');
  const preparation = sql.prepare,
    execution = sql.exec,
    statementGet = StatementSync.prototype.get,
    statementRun = StatementSync.prototype.run,
    statementIterate = StatementSync.prototype.iterate,
    nativeFacade =
      preparation === nativePrepare &&
      execution === nativeExec &&
      statementGet === nativeGet &&
      statementRun === nativeRun &&
      statementIterate === nativeIterate;
  const stamp = sql.prepare('SELECT total_changes() n'),
    schema = sql.prepare('PRAGMA main.schema_version'),
    peer = sql.prepare('PRAGMA main.data_version'),
    tempSchema = sql.prepare('PRAGMA temp.schema_version'),
    tempPeer = sql.prepare('PRAGMA temp.data_version'),
    head = sql.prepare('SELECT sequence,head_json FROM __record_state WHERE singleton=1'),
    schemaVersion = schema.get()!.schema_version,
    peerVersion = peer.get()!.data_version,
    tempSchemaVersion = Number(tempSchema.get()!.schema_version),
    tempPeerVersion = tempPeer.get()!.data_version,
    selected = head.get();
  const anchor = 'vault_changed_' + randomUUID().replaceAll('-', ''),
    probe = anchor + '_probe',
    control = (source: string) => Reflect.apply(nativeExec, sql, [source]);
  if (
    !selected ||
    !Number.isSafeInteger(Number(selected.sequence)) ||
    Number(selected.sequence) < afterSequence
  )
    throw Error('Vault changed certificate HEAD unavailable');
  let expectedChanges = Number(stamp.get()!.n),
    expectedTempSchema = tempSchemaVersion,
    enrolled = 0;
  const facadeChanged = () =>
    sql.prepare !== preparation ||
    sql.exec !== execution ||
    StatementSync.prototype.get !== statementGet ||
    StatementSync.prototype.run !== statementRun ||
    StatementSync.prototype.iterate !== statementIterate;
  const assertWitness = (inside = true, alreadyCooperated = false) => {
    if (facadeChanged()) throw Error('Vault changed certificate SQL facade changed');
    if (!nativeFacade && !alreadyCooperated) check();
    if (facadeChanged()) throw Error('Vault changed certificate SQL facade changed');
    if (inside) {
      // The rotating marker detects a callback that ended our transaction even
      // if it immediately started another with identical visible witnesses.
      try {
        control('RELEASE ' + probe);
        control('SAVEPOINT ' + probe);
      } catch {
        throw Error('Vault changed certificate transaction changed');
      }
    }
    const current = head.get();
    if (
      sql.isTransaction !== inside ||
      stamp.get()!.n !== expectedChanges ||
      schema.get()!.schema_version !== schemaVersion ||
      peer.get()!.data_version !== peerVersion ||
      tempSchema.get()!.schema_version !== (inside ? expectedTempSchema : tempSchemaVersion) ||
      tempPeer.get()!.data_version !== tempPeerVersion ||
      current?.sequence !== selected.sequence ||
      current?.head_json !== selected.head_json
    )
      throw Error('Vault changed certificate roster changed');
  };
  const cooperate = (inside = true, phase?: 'enrollment') => {
    check(phase);
    assertWitness(inside, true);
  };
  cooperate(false);
  control('SAVEPOINT ' + anchor);
  try {
    control('SAVEPOINT ' + probe);
    cooperate();
    sql.exec(
      'CREATE TEMP TABLE __vault_changed_certificate_roster (' +
        'key TEXT PRIMARY KEY,current_rowid INTEGER NOT NULL,first_sequence INTEGER NOT NULL,' +
        'version_hash TEXT NOT NULL) WITHOUT ROWID',
    );
    expectedTempSchema++;
    assertWitness();
    const touched =
        'SELECT entity,record_id,min(sequence) AS first FROM __record_versions ' +
        'WHERE profile_id=? AND sequence>? GROUP BY entity,record_id',
      current = sql.prepare(
        'SELECT rowid,version_id FROM __record_current WHERE entity=? AND record_id=?',
      ),
      add = sql.prepare('INSERT INTO temp.__vault_changed_certificate_roster VALUES(?,?,?,?)');
    let windowRows = 0,
      windowBytes = 0;
    for (const row of sql.prepare(touched).iterate(profileId, afterSequence)) {
      assertWitness();
      const keyBytes =
        Buffer.byteLength(String(row.entity)) + Buffer.byteLength(String(row.record_id));
      if (keyBytes > MAX_CERTIFICATE_DELTA_CHUNK_BYTES - 256)
        throw Error('Contributor certificate delta value too large');
      if (
        windowRows &&
        (windowRows >= MAX_CERTIFICATE_DELTA_CHUNK_COUNT ||
          windowBytes + keyBytes > MAX_CERTIFICATE_DELTA_CHUNK_BYTES)
      ) {
        cooperate(true, 'enrollment');
        windowRows = 0;
        windowBytes = 0;
      }
      const selected = current.get(row.entity, row.record_id);
      if (!selected) throw Error('Vault changed certificate current record missing');
      add.run(
        key(String(row.entity), String(row.record_id)),
        selected.rowid,
        row.first,
        hash(String(selected.version_id)),
      );
      expectedChanges++;
      enrolled++;
      windowRows++;
      windowBytes += keyBytes;
      assertWitness();
      if (
        windowRows >= MAX_CERTIFICATE_DELTA_CHUNK_COUNT ||
        windowBytes >= MAX_CERTIFICATE_DELTA_CHUNK_BYTES
      ) {
        cooperate(true, 'enrollment');
        windowRows = 0;
        windowBytes = 0;
      }
    }
    const count = (includeSource = true) => {
      assertWitness();
      if (
        (includeSource &&
          sql.prepare('SELECT count(*) n FROM (' + touched + ')').get(profileId, afterSequence)!
            .n !== enrolled) ||
        sql.prepare('SELECT count(*) n FROM temp.__vault_changed_certificate_roster').get()!.n !==
          enrolled
      )
        throw Error('Vault changed certificate roster changed');
      assertWitness();
    };
    if (windowRows) cooperate(true, 'enrollment');
    count();
    const read = sql.prepare(
        'SELECT c.entity,c.record_id,c.version_id,v.contents_json,v.deleted,v.profile_id,' +
          'v.entity AS version_entity,v.record_id AS version_record_id,v.sequence ' +
          'FROM __record_current c JOIN __record_versions v ON v.version_id=c.version_id WHERE c.rowid=?',
      ),
      earliest = sql.prepare(
        'SELECT previous_version FROM __record_versions WHERE profile_id=? AND entity=? AND record_id=? ' +
          'AND sequence=? ORDER BY rowid LIMIT 1',
      );
    let returned = 0;
    for (const item of sql
      .prepare(
        'SELECT key,current_rowid,first_sequence,version_hash FROM temp.__vault_changed_certificate_roster ORDER BY key',
      )
      .iterate()) {
      cooperate();
      const row = read.get(item.current_rowid);
      if (
        !row ||
        row.profile_id !== profileId ||
        row.version_entity !== row.entity ||
        row.version_record_id !== row.record_id ||
        Number(row.sequence) < Number(item.first_sequence) ||
        Number(row.sequence) > Number(selected.sequence) ||
        key(String(row.entity), String(row.record_id)) !== item.key ||
        hash(String(row.version_id)) !== item.version_hash
      )
        throw Error('Vault changed certificate row binding changed');
      const first = earliest.get(profileId, row.entity, row.record_id, item.first_sequence);
      if (!first) throw Error('Vault changed certificate predecessor missing');
      assertWitness();
      returned++;
      yield {
        entity: row.entity,
        record_id: row.record_id,
        version_id: row.version_id,
        contents_json: row.contents_json,
        deleted: row.deleted,
        previous_version: first.previous_version,
      };
      assertWitness();
    }
    if (returned !== enrolled) throw Error('Vault changed certificate roster changed');
    count(false);
  } finally {
    try {
      // A missing private anchor must not roll back a replacement transaction.
      control('ROLLBACK TO ' + anchor);
      control('RELEASE ' + anchor);
    } catch {
      throw Error('Vault changed certificate transaction changed');
    } finally {
      cooperate(false);
    }
  }
}

/** A derivative codec, not an authority factory. The caller retains the root
 * obtained from authenticated replay or an exact private accepted transition. */
export function vaultRecordCertificates(
  sql: DatabaseSync,
  profileId: string,
  nonce: string,
  check: () => void,
  ownWrites: (count: number) => void = () => {},
) {
  const identity = { profileId, intakeId: nonce, sourceHash: hash(nonce) };
  const preparation = sql.prepare,
    privateReads = preparation === nativePrepare,
    prepare = (source: string): StatementSync => Reflect.apply(preparation, sql, [source]),
    read = prepare('SELECT raw FROM certificate_pages WHERE hash=?'),
    certificate = prepare('SELECT raw FROM certificates WHERE hash=?'),
    insert = prepare('INSERT OR IGNORE INTO certificate_pages VALUES(?,?)'),
    retain = prepare('INSERT OR IGNORE INTO certificates VALUES(?,?)');
  const tree = (privateRead = false) =>
    createIntakeTree(
      identity,
      (digest) => {
        if (privateRead) return Reflect.apply(nativeGet, read, [digest])?.raw;
        check();
        const raw = read.get(digest)?.raw;
        check();
        return raw;
      },
      new Map(),
      undefined,
      'vault-certificates',
    );
  const get = (
    root: IntakeTreeRoot,
    entity: string,
    recordId: string,
  ): VaultRecordCertificate | undefined => {
    check();
    const digest = tree().get(root, key(entity, recordId));
    if (digest === undefined) {
      check();
      return undefined;
    }
    const raw = certificate.get(digest)?.raw;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32768 || hash(raw) !== digest)
      throw Error('Vault accepted certificate changed');
    const value = JSON.parse(raw) as VaultRecordCertificate;
    if (value.entity !== entity || value.recordId !== recordId)
      throw Error('Vault accepted certificate identity changed');
    check();
    return value;
  };
  return {
    supportsPrivateBatch: privateReads,
    /** Reuse authenticated paths only within one detached, callback-free read
     * span. The caller closes its full owner proof before consuming results. */
    getManyPrivate(
      root: IntakeTreeRoot,
      input: readonly { entity: string; recordId: string }[],
    ): (VaultRecordCertificate | undefined)[] | undefined {
      const length = input.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > 64)
        throw Error('Vault private certificate batch exceeds bound');
      const selected = root === null ? null : Object.freeze({ ...root });
      intakeTreeRef(selected);
      const requests: { entity: string; recordId: string; key: string }[] = [];
      for (let index = 0; index < length; index++) {
        const { entity, recordId } = input[index]!;
        if (
          typeof profileId !== 'string' ||
          typeof nonce !== 'string' ||
          typeof entity !== 'string' ||
          typeof recordId !== 'string'
        )
          throw Error('Vault private certificate identity unavailable');
        requests.push({ entity, recordId, key: key(entity, recordId) });
      }
      if (!privateReads) return undefined;
      const certificateProof: IntakeTreeReadCertificate = {
        witness: '',
        registry: {},
        epoch: {},
        state: 'active',
      };
      check();
      try {
        const pages = createIntakeTree(
          identity,
          (digest) => Reflect.apply(nativeGet, read, [digest])?.raw,
          new Map(),
          {
            certificate: certificateProof,
            check() {
              if (certificateProof.state !== 'active')
                throw Error('Vault private certificate read expired');
            },
          },
          'vault-certificates',
        );
        return requests.map(({ entity, recordId, key: selectedKey }) => {
          const digest = pages.get(selected, selectedKey);
          if (digest === undefined) return undefined;
          const raw = Reflect.apply(nativeGet, certificate, [digest])?.raw;
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32768 || hash(raw) !== digest)
            throw Error('Vault accepted certificate changed');
          const value = JSON.parse(raw) as VaultRecordCertificate;
          if (value.entity !== entity || value.recordId !== recordId)
            throw Error('Vault accepted certificate identity changed');
          return value;
        });
      } finally {
        try {
          check();
        } finally {
          certificateProof.state = 'expired';
        }
      }
    },
    /** Only factory-owned scratch connections without authorizers or UDFs may
     * use this synchronous span. Inputs are detached before admission; native
     * reads expose no callback or result until the closing owner proof. Generic
     * reads and worker checkpoints retain their per-page checks below. */
    getPrivate(
      root: IntakeTreeRoot,
      entity: string,
      recordId: string,
    ): VaultRecordCertificate | undefined {
      // Instrumented/custom preparation may return a callback-bearing facade.
      if (!privateReads) return get(root, entity, recordId);
      if (
        typeof profileId !== 'string' ||
        typeof nonce !== 'string' ||
        typeof entity !== 'string' ||
        typeof recordId !== 'string'
      )
        throw Error('Vault private certificate identity unavailable');
      intakeTreeRef(root);
      const selected = root === null ? null : Object.freeze({ ...root });
      intakeTreeRef(selected);
      const selectedKey = key(entity, recordId);
      check();
      try {
        const digest = tree(true).get(selected, selectedKey);
        if (digest === undefined) return undefined;
        const raw = Reflect.apply(nativeGet, certificate, [digest])?.raw;
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32768 || hash(raw) !== digest)
          throw Error('Vault accepted certificate changed');
        const value = JSON.parse(raw) as VaultRecordCertificate;
        if (value.entity !== entity || value.recordId !== recordId)
          throw Error('Vault accepted certificate identity changed');
        return value;
      } finally {
        check();
      }
    },
    get,
    put(
      root: IntakeTreeRoot,
      value: VaultRecordCertificate,
    ): { root: IntakeTreeRoot; writes: number } {
      check();
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > 32768) throw Error('Vault accepted certificate exceeds page');
      const digest = hash(raw),
        codec = tree();
      let writes = Number(retain.run(digest, raw).changes);
      ownWrites(writes);
      const next = codec.put(root, key(value.entity, value.recordId), digest);
      for (const page of codec.writes([next])) {
        const count = Number(insert.run(page.hash, page.raw).changes);
        writes += count;
        ownWrites(count);
      }
      check();
      return { root: next, writes };
    },
    /** Cold replay already proved every member. Share bounded tree paths without
     * retaining obsolete intermediate roots or buffering the full keyspace. */
    putMany(
      root: IntakeTreeRoot,
      values: readonly VaultRecordCertificate[],
    ): { root: IntakeTreeRoot; writes: number } {
      check();
      if (values.length > 64) throw Error('Vault accepted certificate batch exceeds bound');
      const entries = values.map((value) => {
        check();
        const raw = JSON.stringify(value);
        if (Buffer.byteLength(raw) > 32768) throw Error('Vault accepted certificate exceeds page');
        return { key: key(value.entity, value.recordId), raw, digest: hash(raw) };
      });
      let writes = 0;
      for (const entry of entries) {
        check();
        const count = Number(retain.run(entry.digest, entry.raw).changes);
        writes += count;
        ownWrites(count);
        check();
      }
      const codec = tree(),
        next = codec.putMany(
          root,
          entries.map((entry) => ({ key: entry.key, value: entry.digest })),
        ).root;
      for (const page of codec.writes([next])) {
        check();
        const count = Number(insert.run(page.hash, page.raw).changes);
        writes += count;
        ownWrites(count);
        check();
      }
      check();
      return { root: next, writes };
    },
  };
}

export const VAULT_CERTIFICATE_SCHEMA =
  'CREATE TABLE certificates(hash TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE certificate_pages(hash TEXT PRIMARY KEY,raw TEXT NOT NULL);';
