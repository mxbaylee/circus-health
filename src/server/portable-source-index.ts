/** Disposable exact ID lookup for selected portable source rows. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';

const PART_UNITS = 4096;
type Kind = 'id' | 'row';
type Fingerprint = Readonly<{ hash: string; units: number }>;
type Stored = Fingerprint & Readonly<{ count: number }>;

function* parts(source: Iterable<string>): Generator<string> {
  for (const input of source)
    for (let at = 0; at < input.length; at += PART_UNITS) yield input.slice(at, at + PART_UNITS);
}

function sameUnits(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  let x = a.next();
  let y = b.next();
  let atX = 0;
  let atY = 0;
  let equal = true;
  try {
    for (;;) {
      if (x.done || y.done) {
        if (!!x.done !== !!y.done) equal = false;
        if (!x.done) for (; !x.done; x = a.next());
        if (!y.done) for (; !y.done; y = b.next());
        return equal;
      }
      const count = Math.min(x.value.length - atX, y.value.length - atY);
      if (x.value.slice(atX, atX + count) !== y.value.slice(atY, atY + count)) equal = false;
      atX += count;
      atY += count;
      if (atX === x.value.length) {
        x = a.next();
        atX = 0;
      }
      if (atY === y.value.length) {
        y = b.next();
        atY = 0;
      }
    }
  } finally {
    a.return?.();
    b.return?.();
  }
}

export interface PortableSourceIndex {
  add(id: () => Iterable<string>, row: () => Iterable<string>): void;
  find(id: () => Iterable<string>): (() => Iterable<string>) | undefined;
  close(): void;
}

/** Hash narrows disk candidates; every returned identity is compared exactly. */
export function createPortableSourceIndex(checkpoint: () => void): PortableSourceIndex {
  const scratch = disposableSqlite('health-portable-sources-');
  const db = scratch.db;
  const key = randomBytes(32);
  let closed = false;
  let failed = false;
  let operating = false;
  const enter = () => {
    if (operating) {
      failed = true;
      throw Error('Portable source index reentry');
    }
    if (closed || failed) throw Error('Portable source index unavailable');
    operating = true;
  };
  const current = () => {
    if (closed || failed) throw Error('Portable source index unavailable');
    checkpoint();
    if (closed || failed) throw Error('Portable source index unavailable');
  };
  const sign = (source: bigint, kind: Kind, ordinal: number, value: Buffer) =>
    createHmac('sha256', key).update(`${source}:${kind}:${ordinal}:`).update(value).digest('hex');
  const seal = (source: bigint, id: Stored, row: Stored) =>
    createHmac('sha256', key)
      .update(`${source}:${id.hash}:${id.units}:${id.count}:${row.hash}:${row.units}:${row.count}`)
      .digest('hex');
  try {
    db.exec(`CREATE TABLE sources(ordinal INTEGER PRIMARY KEY,hash TEXT,units INTEGER,
      id_parts INTEGER,row_hash TEXT,row_units INTEGER,row_parts INTEGER,seal TEXT);
      CREATE INDEX sources_hash ON sources(hash,units);
      CREATE TABLE pieces(source_ordinal INTEGER NOT NULL,kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL,value BLOB NOT NULL,mac TEXT NOT NULL,
        PRIMARY KEY(source_ordinal,kind,ordinal));`);
    const insert = db.prepare(
      'INSERT INTO pieces(source_ordinal,kind,ordinal,value,mac) VALUES(?,?,?,?,?)',
    );
    const requestSource = 0n;
    const readRequest = function* (stored: Stored): Generator<string> {
      const hash = createHash('sha256');
      let units = 0;
      let count = 0;
      for (const entry of db
        .prepare(
          "SELECT ordinal,value,mac FROM pieces WHERE source_ordinal=0 AND kind='id' ORDER BY ordinal",
        )
        .iterate()) {
        current();
        const ordinal = Number(entry.ordinal);
        const raw = entry.value;
        if (
          ordinal !== count++ ||
          !(raw instanceof Uint8Array) ||
          raw.byteLength > PART_UNITS * 2 ||
          raw.byteLength % 2
        )
          throw Error('Portable requested source ID changed');
        const value = Buffer.from(raw);
        if (entry.mac !== sign(requestSource, 'id', ordinal, value))
          throw Error('Portable requested source ID changed');
        hash.update(value);
        units += value.length / 2;
        yield value.toString('utf16le');
      }
      current();
      if (count !== stored.count || units !== stored.units || hash.digest('hex') !== stored.hash)
        throw Error('Portable requested source ID changed');
    };
    const read = function* (source: bigint, kind: Kind): Generator<string> {
      current();
      const metadata = db
        .prepare(
          'SELECT hash,units,id_parts,row_hash,row_units,row_parts,seal FROM sources WHERE ordinal=?',
        )
        .get(source);
      if (!metadata) throw Error('Portable source index changed');
      const id: Stored = {
        hash: String(metadata.hash),
        units: Number(metadata.units),
        count: Number(metadata.id_parts),
      };
      const row: Stored = {
        hash: String(metadata.row_hash),
        units: Number(metadata.row_units),
        count: Number(metadata.row_parts),
      };
      if (
        ![id.units, id.count, row.units, row.count].every(Number.isSafeInteger) ||
        metadata.seal !== seal(source, id, row)
      )
        throw Error('Portable source index changed');
      const selected = kind === 'id' ? id : row;
      const hash = createHash('sha256');
      let units = 0;
      let expected = 0;
      let completed = false;
      try {
        for (const entry of db
          .prepare(
            'SELECT ordinal,value,mac FROM pieces WHERE source_ordinal=? AND kind=? ORDER BY ordinal',
          )
          .iterate(source, kind)) {
          current();
          const ordinal = Number(entry.ordinal);
          const raw = entry.value;
          if (
            ordinal !== expected++ ||
            !(raw instanceof Uint8Array) ||
            raw.byteLength > PART_UNITS * 2 ||
            raw.byteLength % 2
          )
            throw Error('Portable source index changed');
          const value = Buffer.from(raw);
          if (entry.mac !== sign(source, kind, ordinal, value))
            throw Error('Portable source index changed');
          hash.update(value);
          units += value.length / 2;
          yield value.toString('utf16le');
        }
        current();
        if (
          expected !== selected.count ||
          units !== selected.units ||
          hash.digest('hex') !== selected.hash
        )
          throw Error('Portable source index changed');
        completed = true;
      } finally {
        if (kind === 'row' && !completed) failed = true;
      }
    };
    return {
      add(id, row) {
        enter();
        try {
          current();
          const inserted = db.prepare('INSERT INTO sources DEFAULT VALUES').run();
          const source = BigInt(inserted.lastInsertRowid);
          const write = (kind: Kind, provider: () => Iterable<string>): Stored => {
            const hash = createHash('sha256');
            let count = 0;
            let units = 0;
            for (const part of parts(provider())) {
              current();
              const value = Buffer.from(part, 'utf16le');
              insert.run(source, kind, count, value, sign(source, kind, count, value));
              hash.update(value);
              units += part.length;
              count++;
              if (!Number.isSafeInteger(units) || !Number.isSafeInteger(count))
                throw Error('Portable source index is not addressable');
            }
            return { hash: hash.digest('hex'), units, count };
          };
          const selected = write('id', id);
          const storedRow = write('row', row);
          db.prepare(
            'UPDATE sources SET hash=?,units=?,id_parts=?,row_hash=?,row_units=?,row_parts=?,seal=? WHERE ordinal=?',
          ).run(
            selected.hash,
            selected.units,
            selected.count,
            storedRow.hash,
            storedRow.units,
            storedRow.count,
            seal(source, selected, storedRow),
            source,
          );
          current();
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          operating = false;
        }
      },
      find(id) {
        enter();
        try {
          current();
          db.prepare("DELETE FROM pieces WHERE source_ordinal=0 AND kind='id'").run();
          const hash = createHash('sha256');
          let count = 0;
          let units = 0;
          for (const part of parts(id())) {
            current();
            const value = Buffer.from(part, 'utf16le');
            insert.run(requestSource, 'id', count, value, sign(requestSource, 'id', count, value));
            hash.update(value);
            units += part.length;
            count++;
            if (!Number.isSafeInteger(units) || !Number.isSafeInteger(count))
              throw Error('Portable source ID is not addressable');
          }
          const wanted: Stored = { hash: hash.digest('hex'), units, count };
          let match: bigint | undefined;
          for (const candidate of db
            .prepare('SELECT ordinal FROM sources WHERE hash=? AND units=? ORDER BY ordinal')
            .iterate(wanted.hash, wanted.units)) {
            current();
            const source = BigInt(candidate.ordinal as number | bigint);
            if (!sameUnits(readRequest(wanted), read(source, 'id'))) continue;
            if (match !== undefined) throw Error('Duplicate portable source ID');
            match = source;
          }
          if (!sameUnits(parts(id()), readRequest(wanted)))
            throw Error('Portable requested source ID changed');
          current();
          const selected = match;
          return selected === undefined ? undefined : () => read(selected, 'row');
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          operating = false;
        }
      },
      close() {
        if (closed) return;
        if (operating) {
          failed = true;
          throw Error('Portable source index reentry');
        }
        closed = true;
        key.fill(0);
        scratch.close();
      },
    };
  } catch (error) {
    key.fill(0);
    scratch.close();
    throw error;
  }
}
