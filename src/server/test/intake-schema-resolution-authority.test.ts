import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { collectionCellReader, createSchemaEnvelopeReader } from '../intake-collection-envelope.ts';
import { parseSchemaControl, schemaOrdinal, schemaKey } from '../intake-envelope-schema.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

async function fixture(t: test.TestContext, extras = 0, original?: string) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-schema-resolve-authority-'));
  const path = join(root, 'current.sqlite');
  const identity = {
    profileId: 'fictional-schema-memo',
    intakeId: 'fictional-original',
    sourceHash: 'c'.repeat(64),
  };
  const db = openDatabase(path, identity.profileId);
  const authority = memoryRecordAuthority(db);
  const initial = prepareInitialIntakeEnvelope(
    original ??
      '{"intake":{"version":0,"scope":{"subject":{"value":"old"},"subject":{"value":"new"}},"records":' +
        JSON.stringify(Array.from({ length: extras }, (_, id) => ({ id }))) +
        '}}',
  );
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.json',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  const selected = collectionCellReader(db, source);
  const control = parseSchemaControl(
    selected.collections.get(
      selected.collections.openView(),
      'logical',
      'envelope.control',
      'representation',
    ),
  );
  const reader = createSchemaEnvelopeReader(selected.store, control, selected.head.logical);
  const nest = reader.child(reader.child(reader.root(), 'intake')!, 'scope')!;
  const record = reader.child(nest, 'subject')!;
  const id = reader.address(record);
  const read = () => reader.resolve(id).kind;
  const expected = read();
  const descriptor = selected.collections.collection(
    selected.collections.openView(),
    'logical',
    'envelope.data',
  )!;
  const prefix = intakeNamespace(identity) + 'node:';
  function nodeFor(cell: string) {
    let ref = descriptor.root;
    while (ref) {
      const key = prefix + ref.hash;
      const raw = String(db.prepare('SELECT value FROM main.app_meta WHERE key=?').get(key)!.value);
      const node = JSON.parse(raw);
      if (node.key === cell) return { key, raw, cell };
      ref = cell < node.key ? node.left : node.right;
    }
    throw Error('Missing selected schema cell ' + cell);
  }
  const cells = ['r:' + id];
  let cursor = id;
  while (cursor !== control.root) {
    cells.push('p:' + cursor);
    const edge = JSON.parse(String(selected.store.get('p:' + cursor)));
    cells.push(
      edge.field === null
        ? 'o:' + edge.parent + ':' + schemaOrdinal(edge.ordinal)
        : 'f:' + edge.parent + ':' + edge.field,
    );
    cursor = edge.parent;
  }
  assert.ok(cells.length >= 7);
  return {
    db,
    path,
    source,
    authority,
    selected,
    control,
    reader,
    nest,
    id,
    read,
    expected,
    nodes: cells.map(nodeFor),
    nodeFor,
  };
}
const restore = (db: DatabaseSync, row: { key: string; raw: string }) =>
  db.prepare('INSERT OR REPLACE INTO main.app_meta(key,value) VALUES(?,?)').run(row.key, row.raw);

for (const external of [false, true])
  test(`resolved schema records refuse each warmed header and ancestry cell after ${external ? 'peer' : 'local'} corruption`, async (t) => {
    const f = await fixture(t),
      writer = external ? new DatabaseSync(f.path) : f.db;
    try {
      for (const row of f.nodes) {
        assert.equal(f.read(), f.expected);
        writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
        assert.throws(f.read, /tree|collection|schema/, 'cannot reuse resolved ' + row.cell);
        restore(writer, row);
        assert.equal(f.read(), f.expected);
        writer.prepare('DELETE FROM main.app_meta WHERE key=?').run(row.key);
        assert.throws(
          f.read,
          /tree|collection|schema|encoded bytes/,
          'cannot ignore deleted ' + row.cell,
        );
        restore(writer, row);
      }
    } finally {
      if (external) writer.close();
    }
  });

test('resolved schema records authenticate again after modify-restore and refuse rollback-only repairs', async (t) => {
  const f = await fixture(t),
    row = f.nodes[0]!;
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
  restore(f.db, row);
  let before = intakeWorkCounters(f.db).warm.collectionNodeReads;
  assert.equal(f.read(), f.expected);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionNodeReads > before,
    'local ABA requires current authentication',
  );
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
  f.db.exec('SAVEPOINT fictional_schema_repair');
  try {
    restore(f.db, row);
    before = intakeWorkCounters(f.db).warm.collectionNodeReads;
    assert.equal(f.read(), f.expected);
    assert.ok(
      intakeWorkCounters(f.db).warm.collectionNodeReads > before,
      'no resolved-record reuse inside a savepoint',
    );
  } finally {
    f.db.exec('ROLLBACK TO fictional_schema_repair; RELEASE fictional_schema_repair');
  }
  assert.throws(f.read, /tree|collection|schema/);
  restore(f.db, row);
  assert.equal(f.read(), f.expected);
});

test('schema first and last resolution and subtree boundaries retain duplicate-field semantics', async (t) => {
  const f = await fixture(t);
  const first = createSchemaEnvelopeReader(
    f.selected.store,
    f.control,
    f.selected.head.logical,
    undefined,
    'first',
  );
  const firstNest = first.child(first.child(first.root(), 'intake')!, 'scope')!;
  const old = first.child(firstNest, 'subject')!;
  assert.equal([...first.recordChunks(old)].join(''), '{"value":"old"}');
  assert.equal([...f.reader.recordChunks(f.reader.resolve(f.id))].join(''), '{"value":"new"}');
  assert.throws(() => first.resolve(f.id), /shadowed|detached/);
  assert.throws(() => f.reader.resolve(first.address(old)), /shadowed|detached/);
  const sub = f.reader.subtree(f.nest);
  assert.equal([...sub.recordChunks(sub.resolve(f.id))].join(''), '{"value":"new"}');
  assert.throws(() => sub.resolve(f.control.root), /ancestry|schema|collection|encoded bytes/);
});

test('copied and replaced schema stores retain observable fallback validation', async (t) => {
  const f = await fixture(t);
  let headers = 0;
  const copied = {
    ...f.selected.store,
    get(key: string) {
      if (key.startsWith('r:')) headers++;
      return f.selected.store.get(key);
    },
  };
  const reader = createSchemaEnvelopeReader(copied, f.control, f.selected.head.logical);
  reader.resolve(f.id);
  reader.resolve(f.id);
  assert.equal(headers, 2, 'custom stores execute original header reads on every resolution');
  const original = f.selected.store.get;
  f.selected.store.get = (key: string) => (key === 'r:' + f.id ? '{}' : original(key));
  try {
    assert.throws(f.read, /record header/);
  } finally {
    f.selected.store.get = original;
  }
  assert.equal(f.read(), f.expected);
  let roots = 0;
  const control = {
    ...f.control,
    get root() {
      roots++;
      return f.control.root;
    },
  };
  const accessor = createSchemaEnvelopeReader(f.selected.store, control, f.selected.head.logical);
  accessor.resolve(f.id);
  const before = roots;
  accessor.resolve(f.id);
  assert.ok(
    roots > before,
    'accessor control retains observable access rather than an inert copied baseline',
  );
});

test('resolved schema memo keeps exact accepted HEAD checks with unchanged SQL', async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  const saved = Buffer.from(f.authority.objects.get('head')!),
    replacement = Buffer.from(other.authority.objects.get('head')!);
  assert.notDeepEqual(saved, replacement);
  for (const value of [null, Buffer.from('{}'), replacement]) {
    assert.equal(f.read(), f.expected);
    const items = intakeWorkCounters(f.db).warm.collectionItemsRead;
    assert.equal(f.read(), f.expected);
    assert.equal(
      intakeWorkCounters(f.db).warm.collectionItemsRead,
      items,
      'established warm resolved-record hit before authority mutation',
    );
    const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
    if (value === null) f.authority.objects.delete('head');
    else f.authority.objects.set('head', value);
    try {
      assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
      assert.throws(
        f.read,
        /invalid head|accepted authority requires configured current projection|Intake envelope authority: requires configured current accepted authority/,
      );
    } finally {
      f.authority.objects.set('head', saved);
    }
    assert.equal(f.read(), f.expected);
  }
});

test('resolved schema memo refuses TEMP shadow rebinding then recovers after explicit clear', async (t) => {
  const f = await fixture(t),
    row = f.nodes[0]!;
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  f.db.exec(
    `CREATE TEMP VIEW app_meta AS SELECT key,CASE WHEN key=${literal(row.key)} THEN '{}' ELSE value END AS value FROM main.app_meta`,
  );
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  assert.throws(f.read, /tree|schema|collection/);
  f.db.exec('DROP VIEW temp.app_meta');
  assert.equal(f.read(), f.expected);
  clearIntakeStateCache(f.db);
  const before = intakeWorkCounters(f.db).warm.collectionItemsRead;
  assert.equal(f.read(), f.expected);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionItemsRead > before,
    'retained reader cannot retain resolved metadata across registry clear',
  );
  f.db.close();
  assert.throws(f.read, /closed|not open|database/i);
});

for (const external of [false, true])
  test(`resolved schema hit rejects committed ${external ? 'peer' : 'local'} ABA during final HEAD proof`, async (t) => {
    const f = await fixture(t),
      writer = external ? new DatabaseSync(f.path) : f.db;
    const original = f.authority.storage.read;
    let calls = 0,
      target = 0,
      armed = false,
      completed = false;
    f.authority.storage.read = (name) => {
      if (name === 'head') {
        calls++;
        if (armed && calls === target) {
          writer
            .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
            .run('fictional-final-schema-aba', 'value');
          writer.prepare('DELETE FROM main.app_meta WHERE key=?').run('fictional-final-schema-aba');
          completed = true;
        }
      }
      return original(name);
    };
    try {
      assert.equal(f.read(), f.expected);
      assert.ok(calls > 0);
      target = calls;
      calls = 0;
      armed = true;
      assert.throws(f.read, /authority changed|stale|generation|collection/);
      assert.equal(completed, true, 'both commits occurred during last actual HEAD read');
      assert.equal(
        writer
          .prepare('SELECT value FROM main.app_meta WHERE key=?')
          .get('fictional-final-schema-aba'),
        undefined,
      );
    } finally {
      f.authority.storage.read = original;
      if (external) writer.close();
    }
    assert.equal(f.read(), f.expected);
  });

test('schema resolve memo evicts older entries beyond the shared 32-record bound', async (t) => {
  const f = await fixture(t, 40);
  const intake = f.reader.child(f.reader.root(), 'intake')!;
  const records = f.reader.children(intake, 'records', { items: 100, bytes: 262144 }).records;
  assert.equal(records.length, 40);
  const ids = records.map((record) => f.reader.address(record));
  for (const id of ids) f.reader.resolve(id);
  let before = intakeWorkCounters(f.db).warm.collectionItemsRead;
  f.reader.resolve(ids.at(-1)!);
  assert.equal(
    intakeWorkCounters(f.db).warm.collectionItemsRead,
    before,
    'newest proven header stays cached',
  );
  before = intakeWorkCounters(f.db).warm.collectionItemsRead;
  f.reader.resolve(ids[0]!);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionItemsRead > before,
    'older proof is evicted, not retained in an unbounded reader cache',
  );
});

test('replacing a lower collection getter cannot seed a forged resolved-header memo', async (t) => {
  const f = await fixture(t);
  const original = f.selected.collections.get;
  const raw = original(f.selected.collections.openView(), 'logical', 'envelope.data', 'r:' + f.id);
  assert.equal(typeof raw, 'string');
  const fake = JSON.stringify({
    ...JSON.parse(raw as string),
    kind: 'fictional-forged-header-kind',
  });
  f.selected.collections.get = (view, area, collection, key) =>
    area === 'logical' && collection === 'envelope.data' && key === 'r:' + f.id
      ? fake
      : original(view, area, collection, key);
  try {
    assert.equal(
      f.read(),
      'fictional-forged-header-kind',
      'mutable custom owner API follows uncached original behavior',
    );
  } finally {
    f.selected.collections.get = original;
  }
  assert.equal(
    f.read(),
    f.expected,
    'restored authority never returns fabricated metadata from the override',
  );
  assert.equal(f.read(), f.expected);
});

test('proxy stores and mutable control roots preserve uncached resolution behavior', async (t) => {
  const f = await fixture(t);
  const proxy = new Proxy(f.selected.store, {});
  const proxied = createSchemaEnvelopeReader(proxy, f.control, f.selected.head.logical);
  proxied.resolve(f.id);
  let before = intakeWorkCounters(f.db).warm.collectionItemsRead;
  assert.equal(proxied.resolve(f.id).kind, f.expected);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionItemsRead > before,
    'even transparent proxies retain cold observable reads',
  );
  const control = { ...f.control };
  const mutable = createSchemaEnvelopeReader(f.selected.store, control, f.selected.head.logical);
  assert.equal(mutable.resolve(f.id).kind, f.expected);
  control.root = f.id;
  assert.equal(mutable.root().kind, f.expected);
  assert.throws(() => mutable.resolve(f.control.root), /ancestry|schema|collection|encoded bytes/);
  control.root = f.control.root;
  assert.equal(mutable.resolve(f.id).kind, f.expected);
});

for (const kind of ['same-key-reentry', 'clear-during-admission'] as const)
  test(`resolved schema cold admission handles ${kind} from the final HEAD read`, async (t) => {
    const f = await fixture(t);
    const original = f.authority.storage.read;
    let calls = 0,
      target = 0,
      armed = false,
      completed = false;
    let nested: string | undefined;
    f.authority.storage.read = (name) => {
      if (name === 'head') {
        calls++;
        if (armed && calls === target) {
          armed = false;
          if (kind === 'same-key-reentry') nested = f.read();
          else f.selected.collections.clearSchemaRecordCache();
          completed = true;
        }
      }
      return original(name);
    };
    try {
      f.selected.collections.clearSchemaRecordCache();
      assert.equal(f.read(), f.expected);
      assert.ok(calls > 0);
      target = calls;
      f.selected.collections.clearSchemaRecordCache();
      calls = 0;
      armed = true;
      assert.equal(f.read(), f.expected);
      assert.equal(completed, true, 'hook completed at the last actual cold HEAD proof');
      if (kind === 'same-key-reentry') assert.equal(nested, f.expected);
    } finally {
      f.authority.storage.read = original;
    }
    let before = intakeWorkCounters(f.db).warm.collectionItemsRead;
    assert.equal(f.read(), f.expected);
    if (kind === 'same-key-reentry')
      assert.equal(
        intakeWorkCounters(f.db).warm.collectionItemsRead,
        before,
        'nested and outer admission leave the same exact reusable entry',
      );
    else
      assert.ok(
        intakeWorkCounters(f.db).warm.collectionItemsRead > before,
        'clear during admission prevents the old attempt from repopulating its cleared memo',
      );
    before = intakeWorkCounters(f.db).warm.collectionItemsRead;
    assert.equal(f.read(), f.expected);
    assert.equal(intakeWorkCounters(f.db).warm.collectionItemsRead, before);
  });

test('cold schema scope shares checks while retaining complete ancestry at two sizes', async (t) => {
  for (const extras of [0, 40]) {
    const f = await fixture(t, extras);
    const view = f.selected.collections.openView();
    f.selected.collections.clearSchemaRecordCache();
    const original = f.authority.storage.read;
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head') heads++;
      return original(name);
    };
    const before = { ...intakeWorkCounters(f.db).warm };
    try {
      const result = f.selected.collections.resolveSchemaRecord(
        view,
        f.control.mode,
        f.control.root,
        f.id,
        'last',
      );
      const after = intakeWorkCounters(f.db).warm;
      const witnessQueries =
        after.collectionReadWitnessQueries - before.collectionReadWitnessQueries;
      const items = after.collectionItemsRead - before.collectionItemsRead;
      t.diagnostic(
        JSON.stringify({ fixture: 'cold schema scope', extras, heads, witnessQueries, items }),
      );
      assert.equal(result.kind, f.expected);
      assert.ok(items >= f.nodes.length, 'complete header and ancestry remain inspected');
      assert.equal(heads, 2, 'one entry and one final physical HEAD proof');
      assert.equal(
        witnessQueries,
        4,
        'entry and final SQL witnesses; selected binding reuses entry',
      );
    } finally {
      f.authority.storage.read = original;
    }
  }
});

test('cold schema scope refuses a missing physical HEAD at its final proof without SQL changes', async (t) => {
  const f = await fixture(t);
  const view = f.selected.collections.openView();
  f.selected.collections.clearSchemaRecordCache();
  const original = f.authority.storage.read;
  const changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  let heads = 0;
  f.authority.storage.read = (name) => {
    if (name === 'head' && ++heads === 2) return null;
    return original(name);
  };
  try {
    assert.throws(
      () =>
        f.selected.collections.resolveSchemaRecord(
          view,
          f.control.mode,
          f.control.root,
          f.id,
          'last',
        ),
      /accepted authority|invalid head|current projection/,
    );
    assert.equal(heads, 2);
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
  } finally {
    f.authority.storage.read = original;
  }
  assert.equal(f.read(), f.expected);
});

for (const external of [false, true])
  test(
    'cold schema scope refuses final-proof SQL ABA from ' +
      (external ? 'peer' : 'local') +
      ' writes',
    async (t) => {
      const f = await fixture(t);
      const writer = external ? new DatabaseSync(f.path) : f.db;
      const view = f.selected.collections.openView();
      f.selected.collections.clearSchemaRecordCache();
      const original = f.authority.storage.read;
      let heads = 0,
        changed = false;
      f.authority.storage.read = (name) => {
        if (name === 'head' && ++heads === 2) {
          writer
            .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
            .run('fictional-cold-schema-aba', 'value');
          writer.prepare('DELETE FROM main.app_meta WHERE key=?').run('fictional-cold-schema-aba');
          changed = true;
        }
        return original(name);
      };
      try {
        assert.throws(
          () =>
            f.selected.collections.resolveSchemaRecord(
              view,
              f.control.mode,
              f.control.root,
              f.id,
              'last',
            ),
          /authority changed|stale|generation|collection/,
        );
        assert.equal(changed, true);
      } finally {
        f.authority.storage.read = original;
        if (external) writer.close();
      }
      assert.equal(f.read(), f.expected);
    },
  );

test('named field lookup shares one sealed scope without losing lexical values', async (t) => {
  for (const extras of [0, 40]) {
    const f = await fixture(t, extras);
    const record = f.reader.resolve(f.id);
    assert.deepEqual(f.reader.field(record, 'value'), { kind: 'value', value: 'new' });
    const original = f.authority.storage.read;
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head') heads++;
      return original(name);
    };
    const before = { ...intakeWorkCounters(f.db).warm };
    try {
      assert.deepEqual(f.reader.field(record, 'value'), { kind: 'value', value: 'new' });
      const after = intakeWorkCounters(f.db).warm;
      const witnessQueries =
        after.collectionReadWitnessQueries - before.collectionReadWitnessQueries;
      const items = after.collectionItemsRead - before.collectionItemsRead;
      t.diagnostic(
        JSON.stringify({ fixture: 'named field scope', extras, heads, witnessQueries, items }),
      );
      assert.equal(
        heads,
        5,
        'one sealed source view, field entry/final proofs and two payload checks',
      );
      assert.equal(
        witnessQueries,
        20,
        'two six-query scopes and two four-query scopes share their entry certificates',
      );
      assert.equal(items, 6, 'four field witnesses and both original payload reads are retained');
    } finally {
      f.authority.storage.read = original;
    }
  }
});

for (const selection of ['first', 'last'] as const)
  for (const external of [false, true])
    test(
      'named field scope refuses every field and ancestry cell: ' +
        selection +
        '/' +
        (external ? 'peer' : 'local'),
      async (t) => {
        const f = await fixture(t);
        const reader = createSchemaEnvelopeReader(
          f.selected.store,
          f.control,
          f.selected.head.logical,
          undefined,
          selection,
        );
        const record = reader.resolve(
          reader.address(reader.child(reader.child(reader.root(), 'intake')!, 'scope')!),
        );
        const id = reader.address(record);
        const key = schemaKey('subject');
        const ordinal = Number(
          f.selected.store.get((selection === 'first' ? 'b:' : 'l:') + id + ':' + key),
        );
        const orderKey = 'o:' + id + ':' + schemaOrdinal(ordinal);
        const order = JSON.parse(String(f.selected.store.get(orderKey)));
        const cells = [
          'r:' + id,
          'p:' + id,
          'f:' + id + ':' + key,
          (selection === 'first' ? 'b:' : 'l:') + id + ':' + key,
          orderKey,
          'n:' + order.name,
        ];
        const rows = cells.map(f.nodeFor);
        const writer = external ? new DatabaseSync(f.path) : f.db;
        const read = () => reader.field(reader.child(record, 'subject')!, 'value');
        const expected = { kind: 'value', value: selection === 'first' ? 'old' : 'new' };
        try {
          for (const row of rows) {
            assert.deepEqual(read(), expected);
            writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
            assert.throws(read, /tree|collection|schema|encoded bytes/, row.cell);
            restore(writer, row);
            assert.deepEqual(read(), expected);
            writer.prepare('DELETE FROM main.app_meta WHERE key=?').run(row.key);
            assert.throws(read, /tree|collection|schema|encoded bytes/, row.cell);
            restore(writer, row);
          }
        } finally {
          if (external) writer.close();
        }
        assert.deepEqual(read(), expected);
      },
    );

for (const mode of ['physical-head', 'local-aba', 'peer-aba', 'temp-schema', 'registry'] as const)
  test('named field scope refuses ' + mode + ' during its final proof', async (t) => {
    const f = await fixture(t);
    const writer = mode === 'peer-aba' ? new DatabaseSync(f.path) : f.db;
    const original = f.authority.storage.read;
    const view = f.selected.collections.openView();
    const read = () =>
      f.selected.collections.resolveSchemaField(
        view,
        f.control.mode,
        f.control.root,
        f.id,
        'last',
        'value',
      );
    const expected = read();
    assert.equal(expected.target?.type, 'cell');
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head' && ++heads === 2) {
        if (mode === 'physical-head') return null;
        if (mode === 'registry') clearIntakeStateCache(f.db);
        else if (mode === 'temp-schema')
          f.db.exec(
            'CREATE TEMP TABLE fictional_field_shadow(id); DROP TABLE fictional_field_shadow',
          );
        else {
          writer
            .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
            .run('fictional-field-aba', 'value');
          writer.prepare('DELETE FROM main.app_meta WHERE key=?').run('fictional-field-aba');
        }
      }
      return original(name);
    };
    try {
      assert.throws(read, /authority|stale|generation|collection|current projection|encoded bytes/);
      assert.equal(
        heads,
        2,
        'refusal occurs at the final physical check of the fixed field operation',
      );
    } finally {
      f.authority.storage.read = original;
      if (mode === 'peer-aba') writer.close();
    }
    const fresh = collectionCellReader(f.db, f.source);
    assert.deepEqual(
      fresh.collections.resolveSchemaField(
        fresh.collections.openView(),
        f.control.mode,
        f.control.root,
        f.id,
        'last',
        'value',
      ),
      expected,
    );
  });

test('named field scope preserves complete fragmented escaped names, missing fields and detached results', async (t) => {
  const name = 'fictional-🧷-"-\\-'.repeat(1100);
  const original = JSON.stringify({
    intake: {
      version: 0,
      scope: { subject: { value: 'new', [name]: 'complete fictional value' } },
    },
  });
  const f = await fixture(t, 0, original);
  const record = f.reader.resolve(f.id);
  const expected = { kind: 'value', value: 'complete fictional value' };
  assert.deepEqual(f.reader.field(record, name), expected);
  assert.deepEqual(f.reader.field(record, 'missing'), { kind: 'missing' });
  // Custom/proxy readers keep their independently checked point-read behavior.
  const fallback = createSchemaEnvelopeReader(
    new Proxy(f.selected.store, {}),
    f.control,
    f.selected.head.logical,
  );
  assert.deepEqual(fallback.field(fallback.resolve(f.id), name), expected);
  const view = f.selected.collections.openView();
  const first = f.selected.collections.resolveSchemaField(
    view,
    f.control.mode,
    f.control.root,
    f.id,
    'last',
    name,
  );
  const id = first.target!.id;
  first.target!.id = '0'.repeat(64);
  const next = f.selected.collections.resolveSchemaField(
    view,
    f.control.mode,
    f.control.root,
    f.id,
    'last',
    name,
  );
  assert.equal(next.target!.id, id, 'returned targets are not shared mutable cache objects');
});

test('named field scope refuses rollback-only repairs and does not borrow cached missing fields', async (t) => {
  const f = await fixture(t);
  const record = f.reader.resolve(f.id);
  const row = f.nodeFor('f:' + f.id + ':' + schemaKey('value'));
  const read = () => f.reader.field(record, 'value');
  assert.deepEqual(read(), { kind: 'value', value: 'new' });
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
  f.db.exec('SAVEPOINT fictional_field_repair');
  try {
    restore(f.db, row);
    assert.deepEqual(read(), { kind: 'value', value: 'new' });
  } finally {
    f.db.exec('ROLLBACK TO fictional_field_repair; RELEASE fictional_field_repair');
  }
  assert.throws(read, /tree|collection|schema/);
  restore(f.db, row);
  assert.deepEqual(read(), { kind: 'value', value: 'new' });
  assert.deepEqual(f.reader.field(record, 'missing'), { kind: 'missing' });
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', f.nodes[0]!.key);
  assert.throws(() => f.reader.field(record, 'missing'), /tree|collection|schema/);
});

async function stagedFixture(t: test.TestContext, extras = 0) {
  const f = await fixture(t, extras);
  const build = 'mutation.' + randomUUID();
  const collections = f.selected.collections;
  const operationId = randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId,
      requestDigest: 'e'.repeat(64),
      domainVersion: f.selected.head.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: build,
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
      ],
    }),
  );
  const selected = collectionCellReader(f.db, f.source, 'builds', build);
  const staged = createSchemaEnvelopeReader(selected.store, f.control, selected.head.logical);
  return { ...f, build, staged, stagedStore: selected.store };
}

for (const extras of [0, 40])
  test(`staged schema reads share published-reader proof work: ${extras} unrelated records`, async (t) => {
    const f = await stagedFixture(t, extras);
    const original = f.authority.storage.read;
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head') heads++;
      return original(name);
    };
    t.after(() => {
      f.authority.storage.read = original;
    });
    const measure = (read: () => unknown) => {
      read();
      const start = heads;
      const before = { ...intakeWorkCounters(f.db).warm };
      const value = read();
      const after = intakeWorkCounters(f.db).warm;
      return {
        value,
        heads: heads - start,
        witnessQueries: after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
        items: after.collectionItemsRead - before.collectionItemsRead,
      };
    };
    const published = measure(() => f.reader.resolve(f.id).kind);
    const staged = measure(() => f.staged.resolve(f.id).kind);
    const publishedRecord = f.reader.resolve(f.id),
      stagedRecord = f.staged.resolve(f.id);
    const publishedField = measure(() => f.reader.field(publishedRecord, 'value'));
    const stagedField = measure(() => f.staged.field(stagedRecord, 'value'));
    t.diagnostic(JSON.stringify({ extras, published, staged, publishedField, stagedField }));
    assert.deepEqual(staged.value, published.value);
    assert.deepEqual(stagedField.value, { kind: 'value', value: 'new' });
    assert.deepEqual(
      staged,
      published,
      'same ancestry proof without reopening a scope for each staged cell',
    );
    assert.deepEqual(stagedField, publishedField, 'same field proof and exact payload reads');
  });

function changeStagedHeader(
  f: Awaited<ReturnType<typeof stagedFixture>>,
  build: string,
  kind: string,
) {
  const collections = f.selected.collections;
  const header = JSON.parse(
    String(collections.get(collections.openView(), 'builds', build, 'r:' + f.id)),
  );
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId: randomUUID(),
      requestDigest: 'd'.repeat(64),
      domainVersion: f.selected.head.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: build,
          op: 'put',
          key: 'r:' + f.id,
          value: JSON.stringify({ ...header, kind }),
        },
      ],
    }),
  );
}

test('staged schema memo binds the exact build and refreshes only after a checked checkpoint', async (t) => {
  const f = await stagedFixture(t);
  const collections = f.selected.collections,
    other = 'mutation.' + randomUUID();
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId: randomUUID(),
      requestDigest: 'b'.repeat(64),
      domainVersion: f.selected.head.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: other,
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
      ],
    }),
  );
  const otherStore = collectionCellReader(f.db, f.source, 'builds', other);
  const otherReader = createSchemaEnvelopeReader(
    otherStore.store,
    f.control,
    otherStore.head.logical,
  );
  assert.equal(f.staged.resolve(f.id).kind, 'subject');
  assert.equal(otherReader.resolve(f.id).kind, 'subject');
  const oldView = collections.openView();
  changeStagedHeader(f, f.build, 'fictional-staged-kind');
  assert.deepEqual(collections.binding(collections.openView())!.logical, f.selected.head.logical);
  assert.throws(
    () =>
      collections.resolveSchemaRecord(
        oldView,
        f.control.mode,
        f.control.root,
        f.id,
        'last',
        'builds',
        f.build,
      ),
    /stale collection view/,
  );
  assert.equal(f.staged.resolve(f.id).kind, 'fictional-staged-kind');
  assert.equal(otherReader.resolve(f.id).kind, 'subject');
  assert.equal(f.reader.resolve(f.id).kind, 'subject');
  changeStagedHeader(f, other, 'fictional-other-kind');
  assert.equal(otherReader.resolve(f.id).kind, 'fictional-other-kind');
  assert.equal(f.staged.resolve(f.id).kind, 'fictional-staged-kind');
});

for (const external of [false, true])
  test(`staged schema reads reject warm ancestry corruption and deletion: ${external ? 'peer' : 'local'}`, async (t) => {
    const f = await stagedFixture(t);
    const writer = external ? new DatabaseSync(f.path) : f.db;
    const read = () => f.staged.field(f.staged.resolve(f.id), 'value');
    const expected = { kind: 'value', value: 'new' };
    try {
      for (const row of f.nodes) {
        assert.deepEqual(read(), expected);
        writer.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
        assert.throws(read, /tree|collection|schema|encoded bytes/, row.cell);
        restore(writer, row);
        assert.deepEqual(read(), expected);
        writer.prepare('DELETE FROM main.app_meta WHERE key=?').run(row.key);
        assert.throws(read, /tree|collection|schema|encoded bytes/, row.cell);
        restore(writer, row);
      }
    } finally {
      if (external) writer.close();
    }
    assert.deepEqual(read(), expected);
  });

for (const mode of ['physical-head', 'local-aba', 'peer-aba', 'temp-schema', 'registry'] as const)
  test(`staged field scope rejects ${mode} at its final proof`, async (t) => {
    const f = await stagedFixture(t);
    const writer = mode === 'peer-aba' ? new DatabaseSync(f.path) : f.db;
    const original = f.authority.storage.read;
    const view = f.selected.collections.openView();
    const read = () =>
      f.selected.collections.resolveSchemaField(
        view,
        f.control.mode,
        f.control.root,
        f.id,
        'last',
        'value',
        'builds',
        f.build,
      );
    const expected = read();
    assert.equal(expected.target?.type, 'cell');
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head' && ++heads === 2) {
        if (mode === 'physical-head') return null;
        if (mode === 'registry') clearIntakeStateCache(f.db);
        else if (mode === 'temp-schema')
          f.db.exec(
            'CREATE TEMP TABLE fictional_staged_shadow(id); DROP TABLE fictional_staged_shadow',
          );
        else {
          writer
            .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
            .run('fictional-staged-aba', 'value');
          writer.prepare('DELETE FROM main.app_meta WHERE key=?').run('fictional-staged-aba');
        }
      }
      return original(name);
    };
    try {
      assert.throws(read, /authority|stale|generation|collection|current projection|encoded bytes/);
      assert.equal(heads, 2);
    } finally {
      f.authority.storage.read = original;
      if (mode === 'peer-aba') writer.close();
    }
    const fresh = collectionCellReader(f.db, f.source, 'builds', f.build);
    assert.deepEqual(
      fresh.collections.resolveSchemaField(
        fresh.collections.openView(),
        f.control.mode,
        f.control.root,
        f.id,
        'last',
        'value',
        'builds',
        f.build,
      ),
      expected,
    );
  });

test('staged field scope preserves duplicate selection and refuses rollback-only repairs', async (t) => {
  const f = await stagedFixture(t);
  for (const selection of ['first', 'last'] as const) {
    const reader = createSchemaEnvelopeReader(
      f.stagedStore,
      f.control,
      f.selected.head.logical,
      undefined,
      selection,
    );
    const scope = reader.child(reader.child(reader.root(), 'intake')!, 'scope')!;
    const subject = reader.child(scope, 'subject')!;
    assert.deepEqual(reader.field(subject, 'value'), {
      kind: 'value',
      value: selection === 'first' ? 'old' : 'new',
    });
  }
  const row = f.nodeFor('f:' + f.id + ':' + schemaKey('value'));
  const record = f.staged.resolve(f.id),
    read = () => f.staged.field(record, 'value');
  assert.deepEqual(read(), { kind: 'value', value: 'new' });
  f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run('{}', row.key);
  f.db.exec('SAVEPOINT fictional_staged_repair');
  try {
    restore(f.db, row);
    assert.deepEqual(read(), { kind: 'value', value: 'new' });
  } finally {
    f.db.exec('ROLLBACK TO fictional_staged_repair; RELEASE fictional_staged_repair');
  }
  assert.throws(read, /tree|collection|schema/);
  restore(f.db, row);
  assert.deepEqual(read(), { kind: 'value', value: 'new' });
});

for (const extras of [0, 40])
  test(`fixed schema reads seal one witness interval: ${extras} unrelated records`, async (t) => {
    const f = await stagedFixture(t, extras);
    const collections = f.selected.collections;
    const view = collections.openView();
    const original = f.authority.storage.read;
    let heads = 0;
    f.authority.storage.read = (name) => {
      if (name === 'head') heads++;
      return original(name);
    };
    try {
      for (const area of ['logical', 'builds'] as const) {
        const collection = area === 'logical' ? 'envelope.data' : f.build;
        for (const operation of ['header', 'field'] as const) {
          const read = () =>
            operation === 'header'
              ? collections.resolveSchemaRecord(
                  view,
                  f.control.mode,
                  f.control.root,
                  f.id,
                  'last',
                  area,
                  collection,
                )
              : collections.resolveSchemaField(
                  view,
                  f.control.mode,
                  f.control.root,
                  f.id,
                  'last',
                  'value',
                  area,
                  collection,
                );
          const expected = read();
          const before = intakeWorkCounters(f.db).warm;
          const beforeHeads = heads;
          assert.deepEqual(read(), expected);
          const after = intakeWorkCounters(f.db).warm;
          const measured = {
            extras,
            area,
            operation,
            heads: heads - beforeHeads,
            witnessQueries:
              after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
            items: after.collectionItemsRead - before.collectionItemsRead,
          };
          t.diagnostic(JSON.stringify(measured));
          assert.equal(measured.heads, 2, 'entry and final physical HEAD are both checked');
          assert.equal(
            measured.items,
            operation === 'header' ? 0 : 4,
            'preserve the complete field witnesses',
          );
          assert.equal(
            measured.witnessQueries,
            4,
            'one two-query entry witness and one final witness; no duplicate selected-binding snapshot',
          );
        }
      }
      assert.deepEqual(f.reader.field(f.reader.resolve(f.id), 'value'), {
        kind: 'value',
        value: 'new',
      });
      assert.deepEqual(f.staged.field(f.staged.resolve(f.id), 'value'), {
        kind: 'value',
        value: 'new',
      });
    } finally {
      f.authority.storage.read = original;
    }
  });

for (const mode of ['local-aba', 'peer-aba', 'temp-schema', 'registry'] as const)
  test(`schema witness reuse refuses ${mode} immediately after its entry snapshot`, async (t) => {
    const f = await fixture(t);
    const writer = mode === 'peer-aba' ? new DatabaseSync(f.path) : f.db;
    const prepare = f.db.prepare;
    let armed = false,
      fired = 0;
    f.db.prepare = function (sql: string) {
      const statement = prepare.call(f.db, sql);
      if (sql === 'PRAGMA temp.schema_version') {
        const get = statement.get;
        statement.get = (...args: unknown[]) => {
          const result = Reflect.apply(get, statement, args) as ReturnType<typeof get>;
          if (armed) {
            armed = false;
            fired++;
            if (mode === 'registry') clearIntakeStateCache(f.db);
            else if (mode === 'temp-schema')
              f.db.exec(
                'CREATE TEMP TABLE fictional_entry_witness(id); DROP TABLE fictional_entry_witness',
              );
            else {
              writer
                .prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)')
                .run('fictional-entry-aba', 'value');
              writer.prepare('DELETE FROM main.app_meta WHERE key=?').run('fictional-entry-aba');
            }
          }
          return result;
        };
      }
      return statement;
    };
    try {
      const collections = createIntakeStateStorage(f.db, {
        profileId: 'fictional-schema-memo',
        intakeId: f.source.id,
        sourceHash: f.source.sha256,
      }).collections;
      const view = collections.openView();
      const read = () =>
        collections.resolveSchemaField(view, f.control.mode, f.control.root, f.id, 'last', 'value');
      assert.equal(read().target?.type, 'cell');
      armed = true;
      assert.throws(read, /authority changed|stale|expired|collection/);
      assert.equal(fired, 1, 'one mutation immediately after the captured entry witness');
    } finally {
      armed = false;
      f.db.prepare = prepare;
      if (mode === 'peer-aba') writer.close();
    }
    assert.deepEqual(f.reader.field(f.reader.resolve(f.id), 'value'), {
      kind: 'value',
      value: 'new',
    });
  });
