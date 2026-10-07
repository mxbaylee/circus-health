/** Cold schema reachability. Scratch joins validate live operational descriptors;
 * detached historical cells remain retained evidence, never live record handles. */
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  readSchemaRecordHeader,
  readSchemaOrder,
  readSchemaTextValue,
  iterateSchemaCellText,
  type EnvelopeCellReader,
} from './intake-collection-envelope.ts';
import { schemaKey, schemaOrdinal, type SchemaControl } from './intake-envelope-schema.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';

const fail = (message: string): never => {
  throw Error('Intake collection envelope: ' + message);
};

function* lexicalName(pieces: Iterable<string>): Generator<string> {
  let state: 'before' | 'name' | 'after' = 'before',
    escaped = false,
    colon = false;
  for (const piece of pieces) {
    let out = '';
    for (const char of piece) {
      if (state === 'before') {
        if (/^[\x20\t\r\n{,]$/.test(char)) continue;
        if (char !== '"') fail('schema lexical property name');
        state = 'name';
        out += char;
      } else if (state === 'name') {
        out += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') state = 'after';
      } else if (char === ':' && !colon) colon = true;
      else if (!/^[\x20\t\r\n]$/.test(char)) fail('schema lexical/property agreement');
    }
    if (out) yield out;
  }
  if (state !== 'after' || !colon) fail('schema lexical/property agreement');
}

export function validateIntakeSchemaReachability(
  store: EnvelopeCellReader,
  control: SchemaControl,
): void {
  for (const _step of validateIntakeSchemaReachabilitySteps(store, control)) {
    /* synchronous recovery */
  }
}
export function* validateIntakeSchemaReachabilitySteps(
  store: EnvelopeCellReader,
  control: SchemaControl,
): Generator<void> {
  let work = 0;
  const scratch = disposableSqlite('intake-schema-validation-'),
    db = scratch.db;
  try {
    db.exec(
      'CREATE TABLE records(id TEXT PRIMARY KEY,parent TEXT,ordinal INTEGER,field TEXT,semantic TEXT,path TEXT NOT NULL,parentShape TEXT,done INTEGER DEFAULT 0); CREATE INDEX records_pending ON records(done,path); CREATE TABLE expected(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE expected_counts(prefix TEXT PRIMARY KEY,count INTEGER NOT NULL);',
    );
    // This private work queue is discarded on completion, refusal or generator
    // return. Batch its writes without holding a source-database transaction or
    // changing the store checks performed across cooperative yields.
    db.exec('BEGIN');
    db.prepare("INSERT INTO records(id,path) VALUES(?,'')").run(control.root);
    const firstExpected = (key: string, value: string) => {
      const inserted = db
        .prepare('INSERT INTO expected VALUES(?,?) ON CONFLICT(key) DO NOTHING')
        .run(key, value);
      if (inserted.changes)
        db.prepare(
          'INSERT INTO expected_counts VALUES(?,1) ON CONFLICT(prefix) DO UPDATE SET count=count+1',
        ).run(key.slice(0, key.lastIndexOf(':') + 1));
    };
    const expected = (key: string, value: string) => {
      firstExpected(key, value);
      db.prepare('UPDATE expected SET value=? WHERE key=?').run(value, key);
    };
    const expectedCount = (prefix: string) =>
      Number(
        db.prepare('SELECT count FROM expected_counts WHERE prefix=?').get(prefix)?.count ?? 0,
      );
    function* rows(prefix: string) {
      let after = prefix;
      for (;;) {
        const page = store.range(after, 64, 65536, prefix);
        for (const row of page.items) {
          if (!row.key.startsWith(prefix)) return;
          yield row;
          if (row.key <= after) fail('schema traversal cursor');
          after = row.key;
        }
        if (page.complete) return;
        if (!page.items.length) fail('schema traversal cursor');
      }
    }
    const compare = function* (prefix: string): Generator<void> {
      let count = 0;
      for (const row of rows(prefix)) {
        if (++work % 64 === 0) yield;
        const wanted = db.prepare('SELECT value FROM expected WHERE key=?').get(row.key);
        if (!wanted || typeof row.value !== 'string' || row.value !== wanted.value)
          fail('phantom or inconsistent operational descriptor');
        count++;
      }
      const total = expectedCount(prefix);
      if (count !== total) fail('missing operational descriptor');
    };
    for (;;) {
      if (++work % 64 === 0) yield;
      const retained = db
        .prepare(
          'SELECT id,parent,ordinal,field,semantic,path,parentShape FROM records WHERE done=0 ORDER BY path LIMIT 1',
        )
        .get();
      if (!retained) break;
      const id = String(retained.id),
        meta = readSchemaRecordHeader(store, id);
      if (String(retained.path).length > 128 * 17) fail('schema ancestry depth');
      store.check();
      if (retained.parent === null) {
        if (meta.kind !== 'root' || meta.shape !== 'object' || store.get('p:' + id) !== undefined)
          fail('schema root ancestry');
      } else {
        const edge = JSON.parse(readSchemaTextValue(store, 'p:' + id)) as Record<string, unknown>;
        if (
          !edge ||
          Object.keys(edge).sort().join(',') !== 'field,ordinal,parent' ||
          edge.parent !== retained.parent ||
          edge.ordinal !== retained.ordinal ||
          edge.field !== retained.field
        )
          fail('schema parent/order agreement');
      }
      let count = 0,
        last = -1;
      const orderPrefix = 'o:' + id + ':';
      for (const row of rows(orderPrefix)) {
        if (++work % 64 === 0) yield;
        const suffix = row.key.slice(orderPrefix.length),
          ordinal = Number(suffix);
        if (
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          suffix !== schemaOrdinal(ordinal) ||
          ordinal <= last
        )
          fail('schema order ordinal');
        if (meta.shape === 'scalar' || (meta.shape === 'array' && ordinal !== count))
          fail('schema shape/order agreement');
        const entry = readSchemaOrder(row.value);
        let field: string | null = null;
        if (meta.shape === 'object') {
          if (entry.name === undefined) fail('object property name missing');
          const name = yield* hashIntakeJsonScalarSteps(
              iterateSchemaCellText(store, 'n:' + entry.name),
            ),
            lexical = yield* hashIntakeJsonScalarSteps(
              lexicalName(iterateSchemaCellText(store, 'c:' + entry.prefix)),
            );
          if (name.kind !== 'string' || lexical.kind !== 'string' || name.hash !== lexical.hash)
            fail('schema lexical/property agreement');
          field = name.hash;
          const previous =
            db.prepare('SELECT value FROM expected WHERE key=?').get('l:' + id + ':' + field)
              ?.value ?? 'null';
          if (store.get('d:' + id + ':' + schemaOrdinal(ordinal)) !== previous)
            fail('schema property predecessor');
          expected('f:' + id + ':' + field, JSON.stringify(entry.target));
          expected('l:' + id + ':' + field, String(ordinal));
          firstExpected('b:' + id + ':' + field, String(ordinal));
        } else if (entry.name !== undefined) fail('array property name');
        if (entry.target.type === 'record') {
          const inserted = db
            .prepare(
              'INSERT INTO records(id,parent,ordinal,field,semantic,path,parentShape) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
            )
            .run(
              entry.target.id,
              id,
              ordinal,
              field,
              meta.shape === 'object' ? id : retained.semantic,
              retained.path + '/' + schemaOrdinal(ordinal),
              meta.shape,
            );
          if (!inserted.changes) fail('duplicate or cyclic live schema record');
        }
        count++;
        last = ordinal;
      }
      if (meta.count !== count) fail('schema record count');
      yield* compare('f:' + id + ':');
      yield* compare('l:' + id + ':');
      yield* compare('b:' + id + ':');
      if (meta.shape === 'scalar' && retained.parentShape === 'array') {
        const scalar = yield* hashIntakeJsonScalarSteps(iterateSchemaCellText(store, 'c:' + id));
        expected('m:' + retained.parent + ':' + scalar.hash, id);
      }
      if (meta.shape === 'object' && retained.semantic !== null) {
        const raw = db
          .prepare('SELECT value FROM expected WHERE key=?')
          .get('f:' + id + ':' + schemaKey('id'))?.value;
        if (typeof raw === 'string') {
          const target = JSON.parse(raw) as { type: string; id: string };
          if (target.type === 'cell') {
            // A domain public ID is a string; an unknown non-scalar id remains
            // exact evidence and contributes no operational public-ID entry.
            const pieces = iterateSchemaCellText(store, 'c:' + target.id);
            const first = pieces[Symbol.iterator]().next().value;
            if (typeof first === 'string' && first.trimStart().startsWith('"')) {
              const scalar = yield* hashIntakeJsonScalarSteps(
                iterateSchemaCellText(store, 'c:' + target.id),
                [meta.kind],
              );
              firstExpected('i:' + retained.semantic + ':' + scalar.hash, id);
              expected('j:' + retained.semantic + ':' + scalar.hash, id);
            }
          }
        }
      }
      if (meta.shape === 'object') {
        const unique = expectedCount('f:' + id + ':');
        const rawUnique = store.get('u:' + id),
          rawNext = store.get('x:' + id);
        if (typeof rawUnique !== 'string' || rawUnique !== String(unique))
          fail('schema unique property count');
        if (
          typeof rawNext !== 'string' ||
          !Number.isSafeInteger(Number(rawNext)) ||
          Number(rawNext) < count ||
          Number(rawNext) <= last ||
          String(Number(rawNext)) !== rawNext
        )
          fail('schema next property ordinal');
      }
      db.prepare('UPDATE records SET done=1 WHERE id=?').run(id);
    }
    for (const row of db.prepare('SELECT id FROM records').iterate()) {
      yield* compare('i:' + row.id + ':');
      yield* compare('j:' + row.id + ':');
      yield* compare('m:' + row.id + ':');
    }
    store.check();
  } finally {
    scratch.close();
  }
}
