import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createPrivateEnvelopeCandidate } from '../intake-envelope-candidate.ts';
import { openContributorRecordStorage } from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext, genuine = false, count = 48) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-private-read-'));
  const identity = {
    profileId: 'fictional-private-read',
    intakeId: 'fictional-original',
    sourceHash: hash('Independently fictional retained source'),
  };
  ensureProfileDirectories(root, identity.profileId);
  const db = openDatabase(join(root, 'current.sqlite'), identity.profileId);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, 'fictional.txt', identity.sourceHash, 0, 'intake_original', '{}');
  const objects = new Map<string, Buffer>();
  // This supported fallback deliberately has no factory identity/cache hook.
  const contributor = genuine
    ? openContributorRecordStorage(root, identity.profileId, { initialize: true })
    : undefined;
  const storage: RecordStorage = contributor ?? {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable: (name, bytes) => objects.set(name, Buffer.from(bytes)),
    publishHead: (bytes) => objects.set('head', Buffer.from(bytes)),
  };
  attachRecordDurability(db, { profileId: identity.profileId, storage });
  const collections = createIntakeStateStorage(db, identity).collections;
  const id = randomUUID();
  const prepared = collections.prepare(collections.openView(), {
    operationId: id,
    requestDigest: hash(id),
    domainVersion: 1,
    changes: [
      ...Array.from({ length: count }, (_, index) => ({
        area: 'logical' as const,
        collection: 'envelope.data',
        op: 'put' as const,
        key: 'fictional-' + String(index).padStart(3, '0'),
        value: 'Exact fictional value ' + index,
      })),
      { area: 'builds', collection: 'bytes', op: 'appendBytes', bytes: Buffer.alloc(4096, 'f') },
      { area: 'builds', collection: 'bytes', op: 'appendBytes', bytes: Buffer.alloc(4096, 'f') },
      {
        area: 'logical',
        collection: 'envelope.data',
        op: 'putBytes',
        key: 'fragmented',
        fromArea: 'builds',
        fromCollection: 'bytes',
      },
    ],
  });
  transaction(db, () => collections.stage(prepared));
  const source = { sha256: identity.sourceHash, details_json: '{}' };
  let scratch: DatabaseSync | undefined;
  const open = () => {
    const current = createIntakeStateStorage(db, identity).collections;
    const operationId = randomUUID();
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('CREATE TABLE nodes(hash TEXT PRIMARY KEY')) scratch = this;
      return result;
    };
    try {
      return current.createPrivateEnvelopeMutation(current.openView(), source, {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: 1,
      });
    } finally {
      DatabaseSync.prototype.exec = exec;
    }
  };
  const candidate = open();
  t.after(() => {
    candidate.close();
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    contributor?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, identity, candidate, open, objects, storage, scratch: () => scratch! };
}

test('one bounded private getter seals original AVL reads once on fallback storage', (t) => {
  const f = fixture(t);
  const beforeHead = f.storage.read('head');
  const fragmented = f.candidate.store.get('fragmented');
  assert.ok(fragmented && typeof fragmented !== 'string');
  const reads = [
    () => assert.equal(f.candidate.store.get('fictional-000'), 'Exact fictional value 0'),
    () => assert.equal(f.candidate.store.range('', 16, 8192).items.length, 16),
    () => {
      const page = f.candidate.store.chunks(fragmented, undefined, 8192);
      assert.equal(Buffer.concat(page.chunks).toString(), 'f'.repeat(8192));
    },
  ];
  for (const read of reads) {
    const before = intakeWorkCounters(f.db);
    const records = createRecordVersionWorkCounters();
    withRecordVersionWork(records, read);
    const after = intakeWorkCounters(f.db);
    const witnesses =
      after.warm.collectionReadWitnessQueries - before.warm.collectionReadWitnessQueries;
    assert.equal(witnesses, 4, 'one original SQL witness at entry and exit');
    assert.equal(
      records.operation.headReadCalls,
      2,
      'real physical accepted HEAD at both boundaries',
    );
    assert.ok(
      after.primitive.metadataReads > before.primitive.metadataReads,
      'original node reads remain counted',
    );
  }
  assert.deepEqual(f.storage.read('head'), beforeHead);
});

function populateSealCandidate(f: ReturnType<typeof fixture>) {
  for (let start = 0; start < 192; start += 64)
    f.candidate.apply(
      Array.from({ length: 64 }, (_, offset) => ({
        area: 'builds' as const,
        collection: 'envelope.data',
        op: 'put' as const,
        key: 'seal-fictional-' + String(start + offset).padStart(3, '0'),
        value: 'Independently fictional sealed value ' + (start + offset),
      })),
    );
  f.candidate.apply([
    {
      area: 'builds',
      collection: 'envelope.data',
      op: 'put',
      key: 'seal-fictional-000',
      value: 'The final fictional value supersedes private construction',
    },
  ]);
  f.candidate.apply([
    ...Array.from({ length: 32 }, () => ({
      area: 'builds' as const,
      collection: 'seal-fictional-bytes',
      op: 'appendBytes' as const,
      bytes: Buffer.alloc(4096, 's'),
    })),
    {
      area: 'builds',
      collection: 'envelope.data',
      op: 'putBytes',
      key: 'seal-fictional-fragmented',
      fromArea: 'builds',
      fromCollection: 'seal-fictional-bytes',
    },
  ]);
}

test('private sealing bounds original authority work by cooperative slices and preserves exact new nodes', async (t) => {
  const f = fixture(t);
  populateSealCandidate(f);
  const beforeHead = f.storage.read('head');
  const immutableBefore = [...f.objects].map(([name, bytes]) => [name, Buffer.from(bytes)]);
  const expected = new Map<string, string>();
  const original = f.db.prepare('SELECT value FROM app_meta WHERE key=?');
  const visit = (ref: { hash: string } | null) => {
    if (!ref || expected.has(ref.hash)) return;
    if (original.get(intakeNamespace(f.identity) + 'node:' + ref.hash)) return;
    const row = f.scratch().prepare('SELECT raw FROM nodes WHERE hash=?').get(ref.hash);
    if (!row) return; // Original subtrees are authenticated boundaries, not new writes.
    const raw = String(row.raw);
    assert.equal(hash(raw), ref.hash);
    expected.set(ref.hash, raw);
    const node = JSON.parse(raw);
    visit(node.left);
    visit(node.right);
    if (node.value.startsWith('{')) {
      const value = JSON.parse(node.value);
      if (value.kind === 'bytes') visit(value.root);
      if (value.kind === 'collection') visit(value.descriptor.root);
    }
  };
  visit(f.candidate.descriptor().root);
  assert.ok(expected.size > 128, 'the exact final graph requires multiple seal slices');
  assert.ok(
    Number(f.scratch().prepare('SELECT count(*) n FROM nodes').get()!.n) > expected.size,
    'superseded private nodes must stay outside the roster',
  );
  let checkpoints = 0;
  const before = intakeWorkCounters(f.db);
  const records = createRecordVersionWorkCounters();
  const roster = await withRecordVersionWork(records, () => f.candidate.seal(() => checkpoints++));
  const after = intakeWorkCounters(f.db);
  const witnesses =
    after.warm.collectionReadWitnessQueries - before.warm.collectionReadWitnessQueries;
  t.diagnostic(
    JSON.stringify({
      nodes: expected.size,
      checkpoints,
      witnesses,
      heads: records.operation.headReadCalls,
    }),
  );
  assert.deepEqual(
    [...roster.rows()].map(({ hash, raw }) => [hash, raw]),
    [...expected].sort(([a], [b]) => a.localeCompare(b)),
  );
  assert.equal(roster.count, expected.size);
  const digest = createHash('sha256');
  for (const [id, raw] of [...expected].sort(([a], [b]) => a.localeCompare(b)))
    digest.update(id).update(raw);
  assert.equal(roster.digest, digest.digest('hex'));
  assert.equal(
    roster.bytes,
    [...expected.values()].reduce((sum, raw) => sum + Buffer.byteLength(raw), 0),
  );
  assert.deepEqual([...f.objects], immutableBefore, 'sealing publishes no immutable authority');
  assert.deepEqual(f.storage.read('head'), beforeHead);
  assert.ok(
    witnesses <= checkpoints * 12 + 32,
    'authority witnesses scale with checked slices, not retained nodes',
  );
  assert.ok(
    records.operation.headReadCalls <= checkpoints * 4 + 16,
    'physical authority is freshly checked at each slice boundary',
  );
});

test('fixed private read envelopes preserve every original edge at different AVL heights', async (t) => {
  const heights: number[] = [];
  for (const count of [8, 48])
    await t.test(`${count} original entries`, (scope) => {
      const f = fixture(scope, false, count);
      const prefix = intakeNamespace(f.identity);
      const selectedHead = String(
        f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'head')!.value,
      );
      const path: string[] = [];
      let ref = f.candidate.descriptor().root;
      while (ref) {
        const raw = String(
          f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'node:' + ref.hash)!
            .value,
        );
        const node = JSON.parse(raw);
        path.push(raw);
        if (node.key === 'fictional-000') break;
        ref = 'fictional-000' < node.key ? node.left : node.right;
      }
      heights.push(path.length);
      const nodeBytes = path.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0);
      for (const warm of [false, true]) {
        const before = intakeWorkCounters(f.db);
        const records = createRecordVersionWorkCounters();
        withRecordVersionWork(records, () =>
          assert.equal(f.candidate.store.get('fictional-000'), 'Exact fictional value 0'),
        );
        const after = intakeWorkCounters(f.db);
        assert.equal(
          after.warm.collectionReadWitnessQueries - before.warm.collectionReadWitnessQueries,
          4,
        );
        assert.equal(records.operation.headReadCalls, 2);
        assert.equal(
          after.warm.collectionNodeReads - before.warm.collectionNodeReads,
          path.length,
          'every original edge is reread, including warm cached nodes',
        );
        assert.equal(
          after.warm.hashCalls - before.warm.hashCalls,
          warm ? 0 : path.length,
          'only exact validated cached nodes reuse their prior hash',
        );
        assert.equal(after.warm.hashedBytes - before.warm.hashedBytes, warm ? 0 : nodeBytes);
        assert.equal(
          after.primitive.metadataReads - before.primitive.metadataReads,
          path.length + 4,
        );
        assert.equal(
          after.primitive.metadataReadBytes - before.primitive.metadataReadBytes,
          nodeBytes +
            2 * Buffer.byteLength(f.identity.profileId) +
            2 * Buffer.byteLength(selectedHead),
        );
      }
    });
  assert.ok(heights[1]! > heights[0]!, 'the fixtures exercise different original path lengths');
});

/** Inject after a real original node read, without changing its returned bytes. */
function afterOriginalNode(action: () => void, anyNode = false) {
  const get = StatementSync.prototype.get;
  let fired = false;
  StatementSync.prototype.get = function (...args) {
    const value = Reflect.apply(get, this, args);
    if (
      !fired &&
      this.sourceSQL.includes('CASE WHEN length(CAST(value AS BLOB))<=?') &&
      String(args[1]).includes('node:') &&
      typeof value?.value === 'string' &&
      (anyNode || JSON.parse(value.value).key === 'fictional-000')
    ) {
      fired = true;
      action();
    }
    return value;
  };
  return () => {
    StatementSync.prototype.get = get;
    assert.equal(fired, true, 'fault reached an actual original-backed AVL node');
  };
}

for (const fault of ['physical-head', 'source', 'peer', 'scratch', 'cancel'] as const)
  test(`private sealing refuses ${fault} drift during an actual host yield`, async (t) => {
    const f = fixture(t);
    populateSealCandidate(f);
    const head = f.storage.read('head')!;
    const peer = fault === 'peer' ? new DatabaseSync(join(f.root, 'current.sqlite')) : undefined;
    t.after(() => peer?.close());
    const controller = new AbortController();
    let fired = false;
    setImmediate(() => {
      fired = true;
      if (fault === 'physical-head') f.objects.set('head', Buffer.from('fictional altered HEAD'));
      if (fault === 'source')
        f.db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run('{"fictional":"changed"}', f.identity.intakeId);
      if (fault === 'peer')
        peer!
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run('{"fictional":"peer change"}', f.identity.intakeId);
      if (fault === 'scratch') f.scratch().exec('UPDATE descriptors SET value=value');
      if (fault === 'cancel') controller.abort(Error('Fictional seal cancellation'));
    });
    try {
      await assert.rejects(f.candidate.seal(() => controller.signal.throwIfAborted()));
    } finally {
      f.objects.set('head', head);
    }
    assert.equal(fired, true, 'fault ran between real seal slices');
    assert.equal(f.scratch().isOpen, false, 'failed seal releases scratch');
    assert.throws(f.candidate.check, /workspace changed|expired/);
    assert.deepEqual(f.storage.read('head'), head);
  });

for (const fault of ['physical-head', 'source', 'peer', 'scratch', 'method', 'cache'] as const)
  test(`seal queue refuses ${fault} at an actual original node inside its slice`, async (t) => {
    const f = fixture(t);
    populateSealCandidate(f);
    const head = f.storage.read('head')!;
    const originalMethod = f.db.function;
    const peer = fault === 'peer' ? new DatabaseSync(join(f.root, 'current.sqlite')) : undefined;
    t.after(() => peer?.close());
    const restore = afterOriginalNode(() => {
      if (fault === 'physical-head') f.objects.set('head', Buffer.from('fictional altered HEAD'));
      if (fault === 'source')
        f.db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run('{"fictional":"changed"}', f.identity.intakeId);
      if (fault === 'peer')
        peer!.exec("INSERT INTO app_meta(key,value) VALUES('fictional_peer_marker','changed')");
      if (fault === 'scratch') f.scratch().exec('UPDATE descriptors SET value=value');
      if (fault === 'method') f.db.function = new Proxy(originalMethod, {});
      if (fault === 'cache') clearIntakeStateCache(f.db);
    }, true);
    try {
      await assert.rejects(f.candidate.seal());
    } finally {
      restore();
      f.objects.set('head', head);
      f.db.function = originalMethod;
    }
    assert.equal(f.scratch().isOpen, false);
    assert.deepEqual(f.storage.read('head'), head);
  });

for (const reentry of ['get', 'apply', 'close', 'readNode', 'seal', 'finalize'] as const)
  test(`caught ${reentry} reentry poisons the current seal slice`, async (t) => {
    const f = fixture(t);
    populateSealCandidate(f);
    const head = f.storage.read('head');
    let pending: Promise<unknown> | undefined;
    const restore = afterOriginalNode(() => {
      if (reentry === 'seal') pending = f.candidate.seal().catch((error: unknown) => error);
      else if (reentry === 'finalize')
        pending = f.candidate.finalizeBuilds([]).catch((error: unknown) => error);
      else
        assert.throws(() => {
          if (reentry === 'get') f.candidate.store.get('fictional-001');
          if (reentry === 'apply') f.candidate.apply([]);
          if (reentry === 'close') f.candidate.close();
          if (reentry === 'readNode') f.candidate.readNode('f'.repeat(64));
        }, /reentrant/);
    }, true);
    try {
      await assert.rejects(f.candidate.seal(), /poisoned|reentrant|expired|changed/);
    } finally {
      restore();
    }
    if (pending) assert.match(String(await pending), /reentrant/);
    assert.equal(f.scratch().isOpen, false);
    assert.deepEqual(f.storage.read('head'), head);
  });

function afterRosterRow(action: (row: Record<string, unknown>) => void) {
  const iterate = StatementSync.prototype.iterate;
  let fired = false;
  StatementSync.prototype.iterate = function (...args) {
    const rows = Reflect.apply(iterate, this, args);
    if (!this.sourceSQL.includes('FROM roster JOIN nodes')) return rows;
    return new Proxy(rows, {
      get(target, key) {
        if (key === 'next')
          return () => {
            const result = target.next();
            if (!fired && !result.done) {
              fired = true;
              action(result.value);
            }
            return result;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => {
    StatementSync.prototype.iterate = iterate;
    assert.equal(fired, true, 'fault reached the actual digest traversal');
  };
}

for (const fault of [
  'physical-head',
  'peer',
  'scratch',
  'reentry',
  'raw',
  'signature',
  'ref',
] as const)
  test(`seal digest refuses ${fault} during a synchronous slice`, async (t) => {
    const f = fixture(t);
    populateSealCandidate(f);
    const head = f.storage.read('head')!;
    const peer = fault === 'peer' ? new DatabaseSync(join(f.root, 'current.sqlite')) : undefined;
    t.after(() => peer?.close());
    const restore = afterRosterRow((row) => {
      if (fault === 'physical-head') f.objects.set('head', Buffer.from('fictional altered HEAD'));
      if (fault === 'peer')
        peer!.exec("INSERT INTO app_meta(key,value) VALUES('fictional_peer_marker','changed')");
      if (fault === 'scratch') f.scratch().exec('UPDATE descriptors SET value=value');
      if (fault === 'reentry') assert.throws(() => f.candidate.apply([]), /reentrant/);
      if (fault === 'raw') row.raw = String(row.raw).replace('fictional', 'altered');
      if (fault === 'signature') row.signature = 'fictional invalid signature';
      if (fault === 'ref') row.ref = '{}';
    });
    try {
      await assert.rejects(f.candidate.seal());
    } finally {
      restore();
      f.objects.set('head', head);
    }
    assert.equal(f.scratch().isOpen, false);
    assert.deepEqual(f.storage.read('head'), head);
  });

test('sealing inside a raw transaction retains per-node authority fallback', async (t) => {
  const f = fixture(t);
  populateSealCandidate(f);
  f.db.exec('SAVEPOINT fictional_transaction_seal');
  try {
    const records = createRecordVersionWorkCounters();
    const roster = await withRecordVersionWork(records, () => f.candidate.seal());
    assert.ok(roster.count > 128);
    assert.ok(
      records.operation.headReadCalls > roster.count,
      'transaction reads retain the original per-node fallback',
    );
  } finally {
    f.db.exec('ROLLBACK TO fictional_transaction_seal; RELEASE fictional_transaction_seal');
  }
});

for (const fault of [
  'physical-head',
  'source',
  'selected-head',
  'scratch',
  'method',
  'cache',
  'close',
] as const)
  test(`private getter refuses ${fault} drift at the last original AVL node`, (t) => {
    const f = fixture(t);
    const head = f.storage.read('head')!;
    const transactions = f.db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n;
    const functionMethod = f.db.function;
    const restore = afterOriginalNode(() => {
      if (fault === 'physical-head')
        f.objects.set('head', Buffer.from('fictional corrupt physical HEAD'));
      if (fault === 'source')
        f.db
          .prepare('UPDATE source_files SET details_json=? WHERE id=?')
          .run('{"fictional":"changed"}', f.identity.intakeId);
      if (fault === 'selected-head') {
        const key = intakeNamespace(f.identity) + 'head';
        const selected = JSON.parse(
          String(f.db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value),
        );
        selected.logical.domainVersion++;
        f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(selected), key);
      }
      if (fault === 'scratch') f.scratch().exec('UPDATE descriptors SET value=value');
      if (fault === 'method') f.db.function = new Proxy(functionMethod, {});
      if (fault === 'cache') clearIntakeStateCache(f.db);
      if (fault === 'close') f.db.close();
    });
    try {
      assert.throws(() => f.candidate.store.get('fictional-000'));
    } finally {
      restore();
      f.objects.set('head', head);
      if (f.db.isOpen) f.db.function = functionMethod;
    }
    assert.throws(f.candidate.check, /workspace changed|closed|expired/);
    if (f.db.isOpen)
      assert.equal(
        f.db.prepare('SELECT count(*) n FROM __record_transactions').get()!.n,
        transactions,
      );
    assert.deepEqual(f.storage.read('head'), head, 'the getter published no accepted receipt');
    assert.equal(f.scratch().isOpen, false, 'failed lexical scope releases private scratch');
  });

for (const reentry of ['get', 'apply', 'close', 'readNode', 'seal', 'finalize'] as const)
  test(`caught ${reentry} reentry poisons the outer private getter`, async (t) => {
    const f = fixture(t);
    const head = f.storage.read('head');
    let pending: Promise<unknown> | undefined;
    const restore = afterOriginalNode(() => {
      if (reentry === 'seal') pending = f.candidate.seal().catch((error: unknown) => error);
      else if (reentry === 'finalize')
        pending = f.candidate.finalizeBuilds([]).catch((error: unknown) => error);
      else
        assert.throws(() => {
          if (reentry === 'get') f.candidate.store.get('fictional-001');
          if (reentry === 'apply') f.candidate.apply([]);
          if (reentry === 'close') f.candidate.close();
          if (reentry === 'readNode') f.candidate.readNode('f'.repeat(64));
        }, /reentrant/);
    });
    try {
      assert.throws(() => f.candidate.store.get('fictional-000'), /poisoned|expired|reentrant/);
    } finally {
      restore();
    }
    if (pending) assert.match(String(await pending), /reentrant/);
    assert.deepEqual(f.storage.read('head'), head);
    assert.equal(f.scratch().isOpen, false);
  });

test('private getter authenticates corrupt original node bytes even with a warm cache', (t) => {
  const f = fixture(t);
  assert.equal(f.candidate.store.get('fictional-000'), 'Exact fictional value 0');
  const node = f.db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB '*node:*'")
    .all()
    .find((row) => JSON.parse(String(row.value)).key === 'fictional-000')!;
  const value = JSON.parse(String(node.value));
  value.value = JSON.stringify({ kind: 'inline', text: 'fictional unreviewed alteration' });
  f.db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(value), node.key!);
  assert.throws(() => f.candidate.store.get('fictional-000'), /reference|hash|digest/);
  assert.equal(f.scratch().isOpen, false);
});

test('genuine contributor HEAD drift at the last original node refuses a cached status', (t) => {
  const f = fixture(t, true);
  const head = f.storage.read('head')!;
  assert.ok(f.storage.headIdentity?.(), 'actual registered storage supplies its own identity');
  assert.equal(f.candidate.store.get('fictional-000'), 'Exact fictional value 0');
  const restore = afterOriginalNode(() =>
    f.storage.publishHead(Buffer.from('fictional changed physical HEAD')),
  );
  try {
    assert.throws(() => f.candidate.store.get('fictional-000'));
  } finally {
    restore();
    f.storage.publishHead(head);
  }
  assert.throws(f.candidate.check, /workspace changed/);
  const fresh = f.open();
  try {
    assert.equal(fresh.store.get('fictional-000'), 'Exact fictional value 0');
  } finally {
    fresh.close();
  }
  assert.deepEqual(f.storage.read('head'), head);
});

test('a peer commit cannot rebase a private getter witness', (t) => {
  const f = fixture(t);
  const peer = new DatabaseSync(join(f.root, 'current.sqlite'));
  t.after(() => peer.close());
  const before = Number(f.db.prepare('SELECT total_changes() n').get()!.n);
  const restore = afterOriginalNode(() =>
    peer.exec("INSERT INTO app_meta(key,value) VALUES('fictional_peer_marker','changed')"),
  );
  try {
    assert.throws(() => f.candidate.store.get('fictional-000'), /authority changed/);
  } finally {
    restore();
  }
  assert.equal(
    Number(f.db.prepare('SELECT total_changes() n').get()!.n),
    before,
    'only the peer committed',
  );
  const fresh = f.open();
  try {
    assert.equal(fresh.store.get('fictional-000'), 'Exact fictional value 0');
  } finally {
    fresh.close();
  }
});

for (const fault of ['throw', 'rollback'] as const)
  test(`private getter ${fault} clears lexical ownership and allows a fresh exact read`, (t) => {
    const f = fixture(t);
    const head = f.storage.read('head');
    const restore = afterOriginalNode(() => {
      if (fault === 'throw') throw Error('Fictional original-node read failure');
      f.db.exec('SAVEPOINT fictional_read_fault');
      f.db
        .prepare('UPDATE source_files SET details_json=? WHERE id=?')
        .run('{"fictional":"rolled back"}', f.identity.intakeId);
      f.db.exec('ROLLBACK TO fictional_read_fault; RELEASE fictional_read_fault');
    });
    try {
      assert.throws(() => f.candidate.store.get('fictional-000'));
    } finally {
      restore();
    }
    const fresh = f.open();
    try {
      assert.equal(fresh.store.get('fictional-000'), 'Exact fictional value 0');
    } finally {
      fresh.close();
    }
    assert.deepEqual(f.storage.read('head'), head);
  });

test('private getters inside a raw transaction retain per-edge authority fallback', (t) => {
  const f = fixture(t);
  f.db.exec('SAVEPOINT fictional_transaction_read');
  try {
    const records = createRecordVersionWorkCounters();
    withRecordVersionWork(records, () =>
      assert.equal(f.candidate.store.get('fictional-000'), 'Exact fictional value 0'),
    );
    assert.ok(
      records.operation.headReadCalls > 2,
      'transaction fallback checks every original edge',
    );
  } finally {
    f.db.exec('ROLLBACK TO fictional_transaction_read; RELEASE fictional_transaction_read');
  }
  const fresh = f.open();
  try {
    assert.equal(fresh.store.get('fictional-000'), 'Exact fictional value 0');
  } finally {
    fresh.close();
  }
});

for (const escaped of ['thenable', 'iterator'] as const)
  test(`private read scope refuses an escaped ${escaped}`, (t) => {
    const db = new DatabaseSync(':memory:');
    const candidate = createPrivateEnvelopeCandidate({
      db,
      identity: {
        profileId: 'fictional-escape',
        intakeId: 'fictional',
        sourceHash: hash('fictional'),
      },
      nodePrefix: 'fictional:',
      collection: 'data',
      descriptor: { kind: 'map', root: null, bytes: 0 },
      readOriginal: () => undefined,
      assertOriginal() {},
      readOriginalScope<T>(read: () => T): T {
        read();
        return (escaped === 'thenable' ? { then() {} } : { next() {} }) as T;
      },
    });
    t.after(() => {
      candidate.close();
      db.close();
    });
    assert.throws(() => candidate.store.get('missing'), /synchronously/);
    assert.throws(candidate.check, /workspace changed/);
  });
