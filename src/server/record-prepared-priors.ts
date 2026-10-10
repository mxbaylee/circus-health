import { createHmac, randomBytes } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';

export interface PreparedRecordPrior {
  entity: string;
  recordId: string;
  previousVersion: string | null;
  deleted: boolean;
  preimage: Readonly<{ hash: string; bytes: number }> | null;
}
type FoundPrior = Readonly<PreparedRecordPrior & { matched: boolean }>;

/** Changed-key transport, not accepted-history authority. The caller must walk
 * authenticated ancestry newest first and prove the root before claiming absence. */
export function createRecordPreparedPriors() {
  const scratch = disposableSqlite('circus-record-prepared-priors-'),
    key = randomBytes(32);
  let closed = false,
    poisoned = false,
    sealed = false,
    finished = false,
    count = 0,
    pending = 0,
    absent = 0,
    changes = 0n;
  const fail = (): never => {
    poisoned = true;
    throw Error('Prepared record predecessors changed, mismatched or expired');
  };
  try {
    scratch.db.exec(
      'CREATE TABLE priors(entity TEXT NOT NULL,record_id TEXT NOT NULL,position INTEGER NOT NULL UNIQUE,value TEXT NOT NULL,matched INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(entity,record_id)) WITHOUT ROWID',
    );
    const insert = scratch.db.prepare('INSERT INTO priors VALUES(?,?,?,?,0,?)'),
      select = scratch.db.prepare(
        'SELECT position,value,matched,signature FROM priors WHERE entity=? AND record_id=?',
      ),
      update = scratch.db.prepare(
        'UPDATE priors SET matched=1,signature=? WHERE entity=? AND record_id=? AND matched=0',
      ),
      membership = scratch.db.prepare(
        'SELECT position,value,matched,signature FROM priors ORDER BY position',
      ),
      stamp = scratch.db.prepare('SELECT total_changes() AS n'),
      schema = scratch.db.prepare('PRAGMA main.schema_version'),
      temp = scratch.db.prepare('PRAGMA temp.schema_version'),
      peer = scratch.db.prepare('PRAGMA main.data_version');
    stamp.setReadBigInts(true);
    const schemas = [schema.get()!.schema_version, temp.get()!.schema_version],
      peerVersion = peer.get()!.data_version,
      sign = (position: number, value: string, matched: number) =>
        createHmac('sha256', key)
          .update(JSON.stringify([position, value, matched]))
          .digest('hex');
    const current = () => {
      if (
        closed ||
        poisoned ||
        finished ||
        !scratch.db.isOpen ||
        stamp.get()!.n !== changes ||
        schema.get()!.schema_version !== schemas[0] ||
        temp.get()!.schema_version !== schemas[1] ||
        peer.get()!.data_version !== peerVersion
      )
        fail();
    };
    const read = (row: Record<string, unknown>): FoundPrior => {
      if (
        !Number.isSafeInteger(row.position) ||
        Number(row.position) < 0 ||
        Number(row.position) >= count ||
        typeof row.value !== 'string' ||
        (row.matched !== 0 && row.matched !== 1) ||
        row.signature !== sign(Number(row.position), row.value, row.matched)
      )
        fail();
      const value = JSON.parse(row.value as string) as PreparedRecordPrior;
      if (value.preimage) Object.freeze(value.preimage);
      return Object.freeze({ ...value, matched: row.matched === 1 });
    };
    const find = (entity: string, recordId: string): FoundPrior | undefined => {
      current();
      if (!sealed) fail();
      const row = select.get(entity, recordId);
      if (!row) return undefined;
      const found = read(row);
      if (found.entity !== entity || found.recordId !== recordId) fail();
      current();
      return found;
    };
    return Object.freeze({
      append(input: PreparedRecordPrior) {
        current();
        if (sealed) fail();
        const value: PreparedRecordPrior = {
          entity: input.entity,
          recordId: input.recordId,
          previousVersion: input.previousVersion,
          deleted: input.deleted,
          preimage: input.preimage && { hash: input.preimage.hash, bytes: input.preimage.bytes },
        };
        if (
          typeof value.entity !== 'string' ||
          !value.entity ||
          typeof value.recordId !== 'string' ||
          !value.recordId ||
          typeof value.deleted !== 'boolean' ||
          (value.previousVersion !== null &&
            (typeof value.previousVersion !== 'string' || !value.previousVersion)) ||
          (value.previousVersion === null) !== (value.preimage === null) ||
          (value.preimage !== null &&
            (!/^[a-f0-9]{64}$/.test(value.preimage.hash) ||
              !Number.isSafeInteger(value.preimage.bytes) ||
              value.preimage.bytes < 0))
        )
          fail();
        current();
        const text = JSON.stringify(value);
        try {
          if (
            insert.run(value.entity, value.recordId, count, text, sign(count, text, 0)).changes !==
            1
          )
            fail();
        } catch {
          fail();
        }
        count++;
        changes++;
        if (value.previousVersion === null) absent++;
        else pending++;
        current();
      },
      seal() {
        current();
        if (sealed) fail();
        let seen = 0;
        for (const row of membership.iterate()) {
          current();
          read(row);
          if (row.position !== seen++ || row.matched !== 0) fail();
        }
        if (seen !== count) fail();
        sealed = true;
        current();
      },
      find,
      match(
        entity: string,
        recordId: string,
        actual: { versionId: string; deleted: boolean; preimage: { hash: string; bytes: number } },
      ) {
        const found = find(entity, recordId);
        if (
          !found ||
          found.matched ||
          found.previousVersion !== actual.versionId ||
          found.deleted !== actual.deleted ||
          found.preimage?.hash !== actual.preimage.hash ||
          found.preimage?.bytes !== actual.preimage.bytes
        )
          fail();
        current();
        const row = select.get(entity, recordId)!;
        if (
          update.run(sign(Number(row.position), String(row.value), 1), entity, recordId).changes !==
          1
        )
          fail();
        changes++;
        pending--;
        current();
      },
      finish({ reachedRoot }: { reachedRoot: boolean }) {
        current();
        if (!sealed || pending !== 0 || (absent !== 0 && reachedRoot !== true)) fail();
        finished = true;
      },
      close() {
        if (closed) return;
        closed = true;
        key.fill(0);
        scratch.close();
      },
    });
  } catch (error) {
    key.fill(0);
    scratch.close();
    throw error;
  }
}
