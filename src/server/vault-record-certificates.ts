import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createIntakeTree, type IntakeTreeRoot } from './intake-state-tree.ts';

export interface VaultRecordCertificate {
  entity: string;
  recordId: string;
  versionId: string;
  deleted: number;
  preimage: { hash: string; bytes: number };
  fields: readonly { name: string; hash: string; bytes: number }[];
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

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
  const read = sql.prepare('SELECT raw FROM certificate_pages WHERE hash=?'),
    certificate = sql.prepare('SELECT raw FROM certificates WHERE hash=?'),
    insert = sql.prepare('INSERT OR IGNORE INTO certificate_pages VALUES(?,?)'),
    retain = sql.prepare('INSERT OR IGNORE INTO certificates VALUES(?,?)');
  const key = (entity: string, recordId: string) => hash(JSON.stringify([entity, recordId]));
  const tree = () =>
    createIntakeTree(
      identity,
      (digest) => {
        check();
        const raw = read.get(digest)?.raw;
        check();
        return raw;
      },
      new Map(),
    );
  return {
    get(
      root: IntakeTreeRoot,
      entity: string,
      recordId: string,
    ): VaultRecordCertificate | undefined {
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
    },
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
  };
}

export const VAULT_CERTIFICATE_SCHEMA =
  'CREATE TABLE certificates(hash TEXT PRIMARY KEY,raw TEXT NOT NULL); CREATE TABLE certificate_pages(hash TEXT PRIMARY KEY,raw TEXT NOT NULL);';
