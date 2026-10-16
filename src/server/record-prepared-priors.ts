import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';

const nativeExec = DatabaseSync.prototype.exec,
  HASH_BYTES = 16384,
  HASH_PIECES = 64;
type HashQuantum = { bytes: number; pieces: number };
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
    busy = false,
    building = false,
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
    Reflect.apply(nativeExec, scratch.db, ['BEGIN']);
    building = true;
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
      peerVersion = peer.get()!.data_version;
    const signSteps = function* (
      position: number,
      value: string,
      matched: number,
      quantum: HashQuantum,
    ): Generator<void, string> {
      const hmac = createHmac('sha256', key);
      const piece = function* (text: string): Generator<void, void> {
        const bytes = Buffer.from(text);
        if (quantum.bytes + bytes.length > HASH_BYTES) {
          yield;
          quantum.bytes = quantum.pieces = 0;
        }
        hmac.update(bytes);
        quantum.bytes += bytes.length;
        quantum.pieces++;
        if (quantum.bytes === HASH_BYTES || quantum.pieces === HASH_PIECES) {
          yield;
          quantum.bytes = quantum.pieces = 0;
        }
      };
      // Preserve the original JSON-array UTF-8 framing without escaping a whole value.
      yield* piece(`[${position},"`);
      for (let offset = 0; offset < value.length;) {
        let end = Math.min(offset + 2048, value.length);
        if (
          end < value.length &&
          value.charCodeAt(end - 1) >= 0xd800 &&
          value.charCodeAt(end - 1) <= 0xdbff &&
          value.charCodeAt(end) >= 0xdc00 &&
          value.charCodeAt(end) <= 0xdfff
        )
          end--;
        yield* piece(JSON.stringify(value.slice(offset, end)).slice(1, -1));
        offset = end;
      }
      yield* piece(`",${matched}]`);
      return hmac.digest('hex');
    };
    const sign = (position: number, value: string, matched: number) => {
      const steps = signSteps(position, value, matched, { bytes: 0, pieces: 0 });
      let step = steps.next();
      while (!step.done) step = steps.next();
      return step.value;
    };
    const current = () => {
      if (
        closed ||
        poisoned ||
        finished ||
        !scratch.db.isOpen ||
        scratch.db.isTransaction !== building ||
        stamp.get()!.n !== changes ||
        schema.get()!.schema_version !== schemas[0] ||
        temp.get()!.schema_version !== schemas[1] ||
        peer.get()!.data_version !== peerVersion
      )
        fail();
    };
    const validateRow = (row: Record<string, unknown>) => {
      if (
        !Number.isSafeInteger(row.position) ||
        Number(row.position) < 0 ||
        Number(row.position) >= count ||
        typeof row.value !== 'string' ||
        (row.matched !== 0 && row.matched !== 1)
      )
        fail();
    };
    const decode = (row: Record<string, unknown>): FoundPrior => {
      const value = JSON.parse(row.value as string) as PreparedRecordPrior;
      if (value.preimage) Object.freeze(value.preimage);
      return Object.freeze({ ...value, matched: row.matched === 1 });
    };
    const read = (row: Record<string, unknown>): FoundPrior => {
      validateRow(row);
      if (row.signature !== sign(Number(row.position), String(row.value), Number(row.matched)))
        fail();
      return decode(row);
    };
    const find = (entity: string, recordId: string): FoundPrior | undefined => {
      current();
      if (busy || !sealed) fail();
      const row = select.get(entity, recordId);
      if (!row) return undefined;
      const found = read(row);
      if (found.entity !== entity || found.recordId !== recordId) fail();
      current();
      return found;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      key.fill(0);
      scratch.close();
    };
    const sealSteps = function* (): Generator<void, void> {
      const quantum = { bytes: 0, pieces: 0 };
      let seen = 0;
      for (const row of membership.iterate()) {
        current();
        validateRow(row);
        if (
          row.signature !==
          (yield* signSteps(Number(row.position), String(row.value), Number(row.matched), quantum))
        )
          fail();
        decode(row);
        if (row.position !== seen++ || row.matched !== 0) fail();
      }
      if (seen !== count) fail();
    };
    const beginSeal = () => {
      current();
      if (busy || sealed) fail();
      busy = true;
    };
    const commit = (guard: () => void) => {
      guard();
      Reflect.apply(nativeExec, scratch.db, ['COMMIT']);
      building = false;
      guard();
    };
    return Object.freeze({
      append(input: PreparedRecordPrior) {
        current();
        if (busy || sealed) fail();
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
        beginSeal();
        try {
          commit(current);
          const steps = sealSteps();
          while (!steps.next().done) current();
          current();
          sealed = true;
        } catch (error) {
          close();
          throw error;
        } finally {
          busy = false;
        }
      },
      async sealAsync(assertRunning: () => void) {
        beginSeal();
        const guard = () => {
          assertRunning();
          current();
        };
        const steps = sealSteps();
        try {
          commit(guard);
          guard();
          let step = steps.next();
          while (!step.done) {
            guard();
            await setImmediate();
            guard();
            step = steps.next();
          }
          guard();
          sealed = true;
        } catch (error) {
          close();
          throw error;
        } finally {
          try {
            steps.return(undefined);
          } catch (error) {
            if (!closed) throw error;
          } finally {
            busy = false;
          }
        }
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
        if (busy || !sealed || pending !== 0 || (absent !== 0 && reachedRoot !== true)) fail();
        finished = true;
      },
      close,
    });
  } catch (error) {
    key.fill(0);
    scratch.close();
    throw error;
  }
}
