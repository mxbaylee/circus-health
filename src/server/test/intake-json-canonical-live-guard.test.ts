import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { createEncryptedCanonicalIndex } from '../intake-json-canonical-encrypted.ts';
import {
  createEncryptedIntakeJsonCanonicalScratch,
  prepareIntakeJsonCanonicalSteps,
} from '../intake-json-canonical.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import type { CanonicalNodeRow, CanonicalTrieRow } from '../intake-json-canonical-index.ts';
import {
  captureIntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
} from '../intake-state-migration.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import { digest } from '../intake-state-evidence.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  intakeLookupContributorFixture,
  registerLookupOriginal,
} from './helpers/intake-lookup-contributor-fixture.ts';

const original = JSON.stringify({
  intake: { version: 1, originalName: 'fictional-canonical.txt', state: 'ready' },
});
const identity = {
  profileId: 'fictional',
  intakeId: 'fictional-canonical-original',
  sourceHash: digest(original),
};
type Scratch = ReturnType<typeof createEncryptedCanonicalIndex>;
const options = (assertCurrent = () => {}, livePointChecks = true) => ({
  identity,
  selectedHead: 'Independent fictional canonical HEAD',
  assertCurrent,
  livePointChecks,
});
const node = (id = 1): CanonicalNodeRow => ({
  id,
  kind: 'object',
  parent: -1,
  state: 'value',
  n: 0,
  key: 0,
  trie: 0,
  raw_start: 0,
  raw_bytes: 0,
  out_start: -1,
  cursor: -1,
  emitted: 0,
  phase: 0,
});
const trie = (id = 1): CanonicalTrieRow => ({
  id,
  parent: 0,
  chunk: Buffer.from([id]),
  object: 1,
  value: null,
  first_order: -1,
  key_number: -1,
  raw_start: 0,
  raw_bytes: 0,
});
function observed(t: TestContext, check = () => {}, live = true) {
  const directories: string[] = [],
    keys: Buffer[] = [],
    random = crypto.randomBytes,
    mkdtemp = fs.mkdtempSync;
  const randomMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const result = random(size);
    if (size === 32) keys.push(result);
    return result;
  }) as typeof crypto.randomBytes);
  const directoryMock = t.mock.method(fs, 'mkdtempSync', ((
    ...args: Parameters<typeof fs.mkdtempSync>
  ) => {
    const path = Reflect.apply(mkdtemp, fs, args);
    directories.push(fs.realpathSync.native(String(path)));
    return path;
  }) as typeof fs.mkdtempSync);
  syncBuiltinESMExports();
  const scratch = createEncryptedCanonicalIndex(options(check, live));
  t.after(() => {
    try {
      scratch.close();
    } finally {
      randomMock.mock.restore();
      directoryMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
  return {
    scratch,
    keys,
    directories,
    assertClosed() {
      assert.equal(keys.length, 2);
      assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
      assert.ok(directories.length === 1 && directories.every((path) => !fs.existsSync(path)));
      assert.throws(() => scratch.index.node(1), /closed/);
    },
  };
}
function exercise(s: Scratch, count = 8) {
  s.reset();
  const nodes = Array.from({ length: count }, (_, n) => node(n + 1)),
    tries = nodes.map((row) => trie(row.id));
  s.index.nodes(nodes);
  s.index.tries(tries);
  s.index.outs(nodes.map((row) => ({ id: row.id, start: row.id, bytes: 2 })));
  s.index.members(nodes.map((row) => ({ object: 1, ordinal: row.id, trie: row.id })));
  let operations = count * 4;
  for (const row of nodes) {
    assert.deepEqual(s.index.node(row.id), row);
    assert.deepEqual(s.index.trie(row.id), trie(row.id));
    assert.equal(s.index.edge(0, trie(row.id).chunk as Uint8Array), row.id);
    assert.deepEqual(s.index.out(row.id), { start: row.id, bytes: 2 });
    operations += 4;
  }
  assert.equal(s.index.firstEdge(0), 1);
  assert.equal(s.index.nextEdge(0, Buffer.from([1])), 2);
  s.index.terminal(1, 0, -1, 0, 1);
  s.index.value(1, 2);
  operations += 4;
  return operations;
}
test('live typed leaves reduce exact full policy calls with identical encrypted host work', (t) => {
  const run = (live: boolean) => {
    let checks = 0;
    const s = createEncryptedCanonicalIndex(options(() => checks++, live));
    try {
      s.reset();
      checks = 0;
      const before = s.stats();
      const operations = exercise(s);
      return { checks, operations, stats: s.stats(), before };
    } finally {
      s.close();
    }
  };
  const baseline = run(false),
    live = run(true);
  // Reset retains the original map-clear/spool/root schedule, measured separately.
  const resetCalls = (() => {
    let n = 0;
    const s = createEncryptedCanonicalIndex(options(() => n++));
    try {
      n = 0;
      s.reset();
      return n;
    } finally {
      s.close();
    }
  })();
  t.diagnostic(
    JSON.stringify({
      baseline: baseline.checks,
      live: live.checks,
      operations: live.operations,
      resetCalls,
    }),
  );
  assert.equal(live.checks, live.operations * 2 + resetCalls);
  assert.ok(baseline.checks > live.checks * 2);
  assert.deepEqual(live.stats, baseline.stats);
  assert.deepEqual(live.before, baseline.before);
});

test('live leaves reduce genuine contributor HEAD work rather than synthetic callback work', (t) => {
  const f = intakeLookupContributorFixture(t);
  registerLookupOriginal(f.db, identity.intakeId, original);
  ensureIntakeFrontierObserver(f.db);
  const witness = captureIntakeLegacyBridgeReadWitness(f.db, identity.intakeId);
  t.after(() => disposeIntakeLegacyBridgeReadWitness(witness));
  const run = (live: boolean) => {
    let checks = 0;
    const s = createEncryptedCanonicalIndex(
      options(() => {
        checks++;
        assertIntakeLegacyBridgeReadWitness(f.db, witness);
      }, live),
    );
    const work = createRecordVersionWorkCounters();
    try {
      s.reset();
      checks = 0;
      const operations = withRecordVersionWork(work, () => exercise(s, 2));
      return { checks, operations, HEAD: work.operation.headReadCalls };
    } finally {
      s.close();
    }
  };
  const baseline = run(false),
    live = run(true);
  t.diagnostic(JSON.stringify({ baseline, live }));
  assert.ok(live.HEAD > 0);
  assert.ok(baseline.HEAD > live.HEAD * 2);
});

test('unoptimized pages, children, reset and every spool method retain their per-cell schedules', () => {
  const run = (live: boolean) => {
    let checks = 0;
    const s = createEncryptedCanonicalIndex(options(() => checks++, live));
    try {
      s.reset();
      s.index.children([{ parent: 1, ordinal: 0, value: 2 }]);
      checks = 0;
      s.index.childPage(1, -1, 1);
      s.index.memberPage(1, -1, 1);
      s.index.terminalPage(1, -1, 'insertion', 1);
      s.raw.appendBytes(Buffer.from('fictional'));
      s.raw.length();
      s.raw.generation();
      s.raw.flush();
      s.raw.read(0, 1);
      s.raw.reset();
      s.output.appendBytes(Buffer.from('x'));
      s.output.length();
      s.output.generation();
      s.output.flush();
      s.output.read(0, 1);
      s.output.reset();
      s.index.children([{ parent: 1, ordinal: 1, value: 3 }]);
      s.reset();
      return checks;
    } finally {
      s.close();
    }
  };
  assert.equal(run(true), run(false));
});

for (const badKind of [
  'accessor',
  'toJSON',
  'proxy',
  'symbol',
  'hidden',
  'arrayproxy',
  'hole',
  'secondrow',
] as const)
  test(`live batch refuses ${badKind} without caller hooks and erases prior rows`, (t) => {
    let effects = 0;
    const f = observed(t);
    let row = node(),
      rows = [row];
    if (badKind === 'accessor')
      Object.defineProperty(row, 'kind', {
        enumerable: true,
        get() {
          effects++;
          return 'object';
        },
      });
    if (badKind === 'toJSON')
      Object.defineProperty(row, 'toJSON', {
        enumerable: true,
        value() {
          effects++;
          return node();
        },
      });
    if (badKind === 'proxy')
      ((row = new Proxy(row, {
        ownKeys(target) {
          effects++;
          return Reflect.ownKeys(target);
        },
      })),
        (rows = [row]));
    if (badKind === 'symbol') Object.defineProperty(row, Symbol('fictional'), { value: 1 });
    if (badKind === 'hidden') Object.defineProperty(row, 'fictional', { value: 1 });
    if (badKind === 'arrayproxy')
      rows = new Proxy(rows, {
        get(target, key, receiver) {
          effects++;
          return Reflect.get(target, key, receiver);
        },
      });
    if (badKind === 'hole') rows = new Array(1);
    if (badKind === 'secondrow') rows = [node(), {} as CanonicalNodeRow];
    assert.throws(() => f.scratch.index.nodes(rows), /typed row/);
    assert.equal(effects, 0);
    if (badKind === 'secondrow') assert.ok(f.scratch.stats().nodeWrites > 0);
    f.assertClosed();
  });

for (const property of [
  'length',
  'byteLength',
  'byteOffset',
  'buffer',
  'subarray',
  'valueOf',
  Symbol.iterator,
] as const)
  for (const placement of ['own', 'prototype'] as const)
    test(`live chunk refuses ${String(property)} ${placement} hooks without executing them`, (t) => {
      let effects = 0;
      const f = observed(t);
      const bytes = new Uint8Array([1, 2]);
      if (placement === 'own')
        Object.defineProperty(bytes, property, {
          get() {
            effects++;
            throw Error('caller hook');
          },
        });
      else
        Object.setPrototypeOf(
          bytes,
          Object.create(Uint8Array.prototype, {
            [property]: {
              get() {
                effects++;
                throw Error('caller hook');
              },
            },
          }),
        );
      assert.throws(() => f.scratch.index.edge(0, bytes), /typed row/);
      assert.equal(effects, 0);
      f.assertClosed();
    });
for (const kind of ['proxy', 'shared', 'resizable', 'detached', 'long'] as const)
  test(`live chunk refuses ${kind} backing or input`, (t) => {
    const f = observed(t);
    let bytes: Uint8Array;
    if (kind === 'shared') bytes = new Uint8Array(new SharedArrayBuffer(2));
    else if (kind === 'resizable') bytes = new Uint8Array(new ArrayBuffer(2, { maxByteLength: 4 }));
    else if (kind === 'detached') {
      const backing = new ArrayBuffer(2);
      bytes = new Uint8Array(backing);
      structuredClone(backing, { transfer: [backing] });
    } else if (kind === 'proxy') bytes = new Proxy(new Uint8Array(2), {});
    else bytes = new Uint8Array(257);
    assert.throws(() => f.scratch.index.edge(0, bytes), /typed row/);
    f.assertClosed();
  });

test('offset chunk snapshots detach from caller mutation at entry and returned DTO mutation', () => {
  for (const buffer of [false, true]) {
    let armed = false;
    const backing = buffer ? Buffer.from([9, 1, 2, 9]) : new Uint8Array([9, 1, 2, 9]),
      input = backing.subarray(1, 3);
    const s = createEncryptedCanonicalIndex(
      options(() => {
        if (armed) backing.fill(7);
      }),
    );
    try {
      armed = true;
      s.index.tries([{ ...trie(), chunk: input }]);
      armed = false;
      assert.equal(s.index.edge(0, Buffer.from([1, 2])), 1);
      const returned = s.index.trie(1)!;
      (returned.chunk as Uint8Array).fill(8);
      assert.deepEqual(s.index.trie(1)!.chunk, Buffer.from([1, 2]));
    } finally {
      s.close();
    }
  }
});

test('all enum states, maximum safe integer fields, root sentinel and 256-byte chunks stay inline with exact I/O parity', () => {
  const run = (live: boolean) => {
    const s = createEncryptedCanonicalIndex(options(() => {}, live));
    try {
      for (const kind of [
        'object',
        'array',
        'string',
        'number',
        'boolean',
        'null',
        'root',
      ] as const)
        for (const state of ['value', 'first', 'after', 'next']) {
          const row = node(Number.MAX_SAFE_INTEGER);
          for (const key of Object.keys(row))
            if (typeof row[key as keyof CanonicalNodeRow] === 'number')
              (row as unknown as Record<string, unknown>)[key] =
                key === 'id' ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
          row.kind = kind;
          row.state = state;
          s.index.nodes([row]);
          assert.deepEqual(s.index.node(row.id), row);
        }
      s.index.tries([
        { ...trie(0), parent: -1, chunk: -1 },
        {
          ...trie(Number.MAX_SAFE_INTEGER),
          parent: Number.MAX_SAFE_INTEGER,
          chunk: Buffer.alloc(256, 255),
          object: Number.MAX_SAFE_INTEGER,
          first_order: -Number.MAX_SAFE_INTEGER,
          key_number: -Number.MAX_SAFE_INTEGER,
          raw_start: -Number.MAX_SAFE_INTEGER,
          raw_bytes: -Number.MAX_SAFE_INTEGER,
        },
      ]);
      assert.equal(
        s.index.edge(Number.MAX_SAFE_INTEGER, Buffer.alloc(256, 255)),
        Number.MAX_SAFE_INTEGER,
      );
      assert.equal(s.index.trie(0)!.chunk, -1);
      const stats = s.stats();
      assert.equal(stats.scalarChunkWrites, 0);
      return stats;
    } finally {
      s.close();
    }
  };
  assert.deepEqual(run(true), run(false));
});

const reenter: Record<string, (s: Scratch) => unknown> = {
  node: (s) => s.index.node(1),
  nodes: (s) => s.index.nodes([]),
  trie: (s) => s.index.trie(1),
  tries: (s) => s.index.tries([]),
  terminal: (s) => s.index.terminal(1, 0, -1, 0, 1),
  value: (s) => s.index.value(1, 2),
  edge: (s) => s.index.edge(0, Buffer.from([1])),
  firstEdge: (s) => s.index.firstEdge(0),
  nextEdge: (s) => s.index.nextEdge(0, Buffer.from([1])),
  children: (s) => s.index.children([]),
  childPage: (s) => s.index.childPage(1, -1, 1),
  terminalPage: (s) => s.index.terminalPage(1, -1, 'insertion', 1),
  outs: (s) => s.index.outs([]),
  out: (s) => s.index.out(1),
  members: (s) => s.index.members([]),
  memberPage: (s) => s.index.memberPage(1, -1, 1),
  reset: (s) => s.reset(),
};
for (const which of ['raw', 'output'] as const) {
  reenter[which + '.appendBytes'] = (s) => s[which].appendBytes(Buffer.alloc(0));
  reenter[which + '.length'] = (s) => s[which].length();
  reenter[which + '.generation'] = (s) => s[which].generation();
  reenter[which + '.flush'] = (s) => s[which].flush();
  reenter[which + '.read'] = (s) => s[which].read(0, 0);
  reenter[which + '.reset'] = (s) => s[which].reset();
}
for (const [name, nested] of Object.entries(reenter))
  for (const boundary of [1, 2])
    test(`caught ${name} reentry at proof ${boundary} poisons the live leaf`, (t) => {
      let scratch: Scratch | undefined,
        armed = false,
        checks = 0;
      const f = observed(t, () => {
        if (armed && ++checks === boundary) assert.throws(() => nested(scratch!), /reentrant/);
      });
      scratch = f.scratch;
      armed = true;
      assert.throws(() => scratch!.index.nodes([node()]), /closed/);
      f.assertClosed();
    });
for (const boundary of [1, 2])
  test(`closing from proof ${boundary} refuses before output and erases keys`, (t) => {
    let scratch: Scratch | undefined,
      armed = false,
      n = 0;
    const f = observed(t, () => {
      if (armed && ++n === boundary) scratch!.close();
    });
    scratch = f.scratch;
    armed = true;
    assert.throws(() => scratch!.index.nodes([node()]), /closed/);
    f.assertClosed();
  });

test('malformed decoded stored row is refused before return or rewrite', (t) => {
  const f = observed(t);
  f.scratch.index.nodes([node()]);
  f.scratch.index.tries([trie()]);
  const parse = JSON.parse;
  const mock = t.mock.method(JSON, 'parse', ((raw: string, ...rest: unknown[]) => {
    const result = Reflect.apply(parse, JSON, [raw, ...rest]);
    if (raw.includes('"kind":"object"')) result.kind = { fictional: true };
    if (raw.includes('"chunk":"01"')) result.chunk = 'f'.repeat(514);
    return result;
  }) as typeof JSON.parse);
  try {
    assert.throws(() => f.scratch.index.node(1), /typed row/);
    f.assertClosed();
  } finally {
    mock.mock.restore();
  }
  const other = observed(t);
  other.scratch.index.tries([trie()]);
  const mock2 = t.mock.method(JSON, 'parse', ((raw: string, ...rest: unknown[]) => {
    const result = Reflect.apply(parse, JSON, [raw, ...rest]);
    if (raw.includes('"chunk":"01"')) result.chunk = 'f'.repeat(514);
    return result;
  }) as typeof JSON.parse);
  try {
    assert.throws(() => other.scratch.index.value(1, 2), /typed row/);
    other.assertClosed();
  } finally {
    mock2.mock.restore();
  }
});

function genuine(t: TestContext) {
  const f = intakeLookupContributorFixture(t);
  registerLookupOriginal(f.db, identity.intakeId, original);
  ensureIntakeFrontierObserver(f.db);
  const witness = captureIntakeLegacyBridgeReadWitness(f.db, identity.intakeId);
  t.after(() => disposeIntakeLegacyBridgeReadWitness(witness));
  return {
    ...f,
    check: () => assertIntakeLegacyBridgeReadWitness(f.db, witness),
    revoke: () => disposeIntakeLegacyBridgeReadWitness(witness),
    sourceRaw: f.db
      .prepare('SELECT details_json FROM source_files WHERE id=?')
      .get(identity.intakeId)!.details_json as string,
  };
}
for (const io of ['read', 'write'] as const)
  for (const fault of [
    'current',
    'HEAD',
    'source SQL',
    'SQL',
    'methods',
    'cancellation',
    'reentry',
  ] as const)
    test(`native canonical ${io} ${fault} refuses before output with erased keys`, (t) => {
      const f = genuine(t),
        refusal = Error('fictional canonical cancellation');
      let cancelled = false;
      const o = observed(t, () => {
          if (cancelled) throw refusal;
          f.check();
        }),
        s = o.scratch;
      s.index.nodes([node()]);
      assert.deepEqual(s.index.node(1), node());
      const descriptors = new Set<number>(),
        open = fs.openSync,
        close = fs.closeSync,
        read = fs.readSync,
        write = fs.writeSync;
      let fired = false;
      const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
        const fd = Reflect.apply(open, fs, args);
        if (o.directories.some((dir) => String(args[0]).startsWith(dir + '/'))) descriptors.add(fd);
        return fd;
      }) as typeof fs.openSync);
      const closeMock = t.mock.method(fs, 'closeSync', (fd: number) => {
        descriptors.delete(fd);
        return close(fd);
      });
      const mutate = () => {
        fired = true;
        if (fault === 'current') f.revoke();
        else if (fault === 'cancellation') cancelled = true;
        else if (fault === 'reentry') assert.throws(() => s.raw.generation(), /reentrant/);
        else if (fault === 'HEAD') {
          const bytes = fs.readFileSync(f.authority.headPath);
          const changed = Buffer.from(bytes);
          changed[0] ^= 1;
          fs.writeFileSync(f.authority.headPath, changed);
          fs.writeFileSync(f.authority.headPath, bytes);
        } else if (fault === 'source SQL') {
          const update = f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?');
          update.run('{"fictional":true}', identity.intakeId);
          update.run(f.sourceRaw, identity.intakeId);
        } else if (fault === 'SQL') {
          f.db.exec('CREATE TABLE fictional_canonical_attempt(value TEXT)');
          f.db.exec('DROP TABLE fictional_canonical_attempt');
        } else {
          f.db.setAuthorizer(() => 0);
          f.db.setAuthorizer(null);
        }
      };
      const readMock = t.mock.method(fs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
        const result = Reflect.apply(read, fs, args);
        if (io === 'read' && !fired && descriptors.has(args[0])) mutate();
        return result;
      }) as typeof fs.readSync);
      const writeMock = t.mock.method(fs, 'writeSync', ((
        ...args: Parameters<typeof fs.writeSync>
      ) => {
        const result = Reflect.apply(write, fs, args);
        if (io === 'write' && !fired && descriptors.has(args[0])) mutate();
        return result;
      }) as typeof fs.writeSync);
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => (io === 'read' ? s.index.node(1) : s.index.nodes([node(2)])),
          fault === 'cancellation' ? (error) => error === refusal : /authority|current/,
        );
        assert.equal(fired, true);
        o.assertClosed();
      } finally {
        readMock.mock.restore();
        writeMock.mock.restore();
        closeMock.mock.restore();
        openMock.mock.restore();
        syncBuiltinESMExports();
      }
    });

test('native refusal retains primary exception even when encrypted cleanup fails', (t) => {
  const refusal = Error('fictional native canonical write failure'),
    o = observed(t),
    write = t.mock.method(fs, 'writeSync', (() => {
      throw refusal;
    }) as typeof fs.writeSync),
    remove = t.mock.method(fs, 'rmSync', (() => {
      throw Object.assign(Error('fictional cleanup'), { code: 'EACCES' });
    }) as typeof fs.rmSync);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => o.scratch.index.nodes([node()]),
      (error) => error === refusal,
    );
    assert.ok(o.keys.every((key) => key.every((byte) => byte === 0)));
    assert.throws(() => o.scratch.index.node(1), /closed/);
  } finally {
    write.mock.restore();
    remove.mock.restore();
    syncBuiltinESMExports();
    for (const dir of o.directories) fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const live of [false, true])
  for (const replacement of ['function', 'getter'] as const)
    test(`original ${live ? 'live' : 'default'} policy remains pinned after options ${replacement} replacement`, () => {
      let reads = 0,
        revoked = false;
      const refusal = Error('fictional pinned original policy'),
        opts = options(() => {}, live);
      Object.defineProperty(opts, 'assertCurrent', {
        configurable: true,
        enumerable: true,
        get() {
          reads++;
          return () => {
            if (revoked) throw refusal;
          };
        },
      });
      const s = createEncryptedCanonicalIndex(opts);
      try {
        assert.equal(reads, 1);
        s.index.nodes([node()]);
        if (replacement === 'function')
          Object.defineProperty(opts, 'assertCurrent', { value: () => {}, configurable: true });
        else
          Object.defineProperty(opts, 'assertCurrent', {
            get() {
              reads++;
              throw Error('late options getter');
            },
            configurable: true,
          });
        revoked = true;
        assert.throws(
          () => s.index.node(1),
          (error) => error === refusal,
        );
        assert.equal(reads, 1);
        assert.equal(s.stats().closed, true);
      } finally {
        s.close();
      }
    });

for (const boundary of [1, 2])
  test(`source authority revoked at full proof ${boundary} refuses the owned result`, (t) => {
    let armed = false,
      checks = 0,
      revoked = false;
    const refusal = Error('fictional canonical boundary revocation');
    const f = observed(t, () => {
      if (armed && ++checks === boundary) revoked = true;
      if (revoked) throw refusal;
    });
    armed = true;
    assert.throws(
      () => f.scratch.index.nodes([node()]),
      (error) => error === refusal,
    );
    f.assertClosed();
  });

test('batch consumes only dense row descriptors and never a caller array iterator', () => {
  let effects = 0;
  const rows = [node(1), node(2)];
  Object.defineProperty(rows, Symbol.iterator, {
    get() {
      effects++;
      throw Error('fictional caller iterator');
    },
  });
  const s = createEncryptedCanonicalIndex(options());
  try {
    s.index.nodes(rows);
    assert.equal(s.index.node(1)!.id, 1);
    assert.equal(s.index.node(2)!.id, 2);
    assert.equal(effects, 0);
  } finally {
    s.close();
  }
});

test('bad later batch descriptor erases successful earlier row without evaluating getter', (t) => {
  let effects = 0;
  const f = observed(t),
    rows = [node(1), node(2)];
  Object.defineProperty(rows, '1', {
    enumerable: true,
    get() {
      effects++;
      throw Error('fictional row getter');
    },
  });
  assert.throws(() => f.scratch.index.nodes(rows), /typed row/);
  assert.equal(effects, 0);
  assert.ok(f.scratch.stats().nodeWrites > 0);
  f.assertClosed();
});

test('boxed scalar input is refused without coercion and generic encrypted chunk range is unchanged', (t) => {
  let effects = 0;
  const f = observed(t),
    row = node();
  row.id = {
    valueOf() {
      effects++;
      return 1;
    },
  } as unknown as number;
  assert.throws(() => f.scratch.index.nodes([row]), /typed row/);
  assert.equal(effects, 0);
  f.assertClosed();
  const generic = createEncryptedCanonicalIndex(options(() => {}, false)),
    chunk = Buffer.alloc(257, 3);
  try {
    generic.index.tries([{ ...trie(), chunk }]);
    assert.deepEqual(generic.index.trie(1)!.chunk, chunk);
  } finally {
    generic.close();
  }
});

test('actual live parser preserves long shared-prefix keys, lone UTF16, duplicates and numeric modes', () => {
  const prefix = 'fictional'.repeat(33),
    key = prefix + '\ud800';
  const source =
    '{' +
    JSON.stringify(key) +
    ':1,' +
    JSON.stringify(prefix + 'later') +
    ':2,' +
    JSON.stringify(key) +
    ':3,"2":2,"1":1,"nested":[null,true,-0,1e3,{"x":1,"x":2}]}';
  for (const mode of ['canonical', 'stringify'] as const)
    for (const preserveNumbers of [false, true]) {
      const run = (live: boolean) => {
        const scratch = createEncryptedIntakeJsonCanonicalScratch(options(() => {}, live));
        try {
          const prepared = finishIntakeCopySteps(
            prepareIntakeJsonCanonicalSteps([source], { scratch, mode, preserveNumbers }),
          );
          try {
            assert.ok(prepared.field(prepared.root, key));
            return {
              raw: [...prepared.chunks()].join(''),
              bytes: prepared.bytes,
              work: prepared.work,
            };
          } finally {
            prepared.close();
          }
        } finally {
          scratch.close();
        }
      };
      assert.deepEqual(run(true), run(false));
    }
});
