import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { createIntakeGraphScratch } from '../intake-state-graph-scratch.ts';
import { COLLECTION_FORMAT, digest, intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeTree, type IntakeTreeRef } from '../intake-state-tree.ts';
import {
  inspectIntakeCollectionGraphSteps,
  validateIntakeCollectionGraphSteps,
} from '../intake-state-graph.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import {
  captureIntakeLegacyBridgeReadWitness,
  assertIntakeLegacyBridgeReadWitness,
  disposeIntakeLegacyBridgeReadWitness,
} from '../intake-state-migration.ts';
import { ensureIntakeFrontierObserver } from '../intake-lookup-frontier-observer.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import {
  intakeLookupContributorFixture,
  registerLookupOriginal,
} from './helpers/intake-lookup-contributor-fixture.ts';

const original = JSON.stringify({
  intake: { version: 1, originalName: 'fictional.txt', state: 'ready' },
});
const identity = {
  profileId: 'fictional',
  intakeId: 'fictional-summary-original',
  sourceHash: digest(original),
};
const ref = (n: number): IntakeTreeRef => ({
  hash: digest('fictional-summary-' + n),
  count: 1,
  height: 1,
  first: 'fictional-key-' + n,
  last: 'fictional-key-' + n,
});
type Scratch = ReturnType<typeof createIntakeGraphScratch>;

function graph() {
  const nodes = new Map<string, string>(),
    tree = createIntakeTree(identity, (hash) => nodes.get(hash), new Map()),
    text = 'Independent fictional graph member.',
    members = tree.put(null, 'fictional-member', JSON.stringify({ kind: 'inline', text })),
    root = tree.put(
      null,
      'fictional.records',
      JSON.stringify({ kind: 'map', root: members, bytes: Buffer.byteLength(text) }),
    ),
    operationId = '00000000-0000-4000-8000-000000000001',
    logical = { root, domainVersion: 1 },
    receipts = tree.put(
      null,
      operationId,
      JSON.stringify({
        format: 'health-intake-state-receipt-v4',
        requestDigest: digest(operationId),
        result: {
          format: 'health-intake-state-result-v4',
          intakeId: identity.intakeId,
          operationId,
          storageSequence: 1,
          logical,
          changed: true,
        },
      }),
    ),
    history = tree.put(
      null,
      '0000000000000001',
      JSON.stringify({
        format: 'health-intake-state-history-v4',
        operationId,
        previous: null,
        logical,
        builds: null,
      }),
    );
  for (const node of tree.writes([root, members, receipts, history]))
    nodes.set(node.hash, node.raw);
  const rows = new Map(
    [...nodes].map(([hash, raw]) => [intakeNamespace(identity) + 'node:' + hash, raw]),
  );
  const head = JSON.stringify({
    format: COLLECTION_FORMAT,
    identity,
    storageSequence: 1,
    logical,
    receipts,
    history,
    builds: null,
  });
  return { rows, head };
}

test('actual live graph opts into bounded summary checks while generic inspection keeps its schedule', (t) => {
  const f = graph();
  const run = (live: boolean) => {
    let checks = 0,
      reads = 0;
    const checkpoint = () => checks++,
      read = (key: string) => {
        reads++;
        return f.rows.get(key);
      };
    finishIntakeCopySteps(
      live
        ? validateIntakeCollectionGraphSteps(identity, f.head, read, checkpoint)
        : inspectIntakeCollectionGraphSteps(
            {
              sourceValue: read,
              put() {
                assert.fail('unexpected copy write');
              },
            },
            identity,
            f.head,
            undefined,
            checkpoint,
          ),
    );
    return { checks, reads };
  };
  const baseline = run(false),
    live = run(true);
  t.diagnostic(JSON.stringify({ baseline, live }));
  assert.equal(live.reads, baseline.reads);
  assert.ok(live.reads > 0);
  assert.ok(live.checks <= 80, 'fixed four-node graph keeps full policy work bounded');
  assert.ok(live.checks < baseline.checks);
});

test('live source callback gets a full closing proof before returned bytes are decoded', () => {
  const f = graph(),
    refusal = Error('fictional source callback revoked');
  let revoked = false,
    reads = 0;
  assert.throws(
    () =>
      finishIntakeCopySteps(
        validateIntakeCollectionGraphSteps(
          identity,
          f.head,
          () => {
            reads++;
            revoked = true;
            return 'invalid bytes must remain unconsumed';
          },
          () => {
            if (revoked) throw refusal;
          },
        ),
      ),
    (error) => error === refusal,
  );
  assert.equal(reads, 1);
});

function genuine(t: TestContext) {
  const f = intakeLookupContributorFixture(t);
  registerLookupOriginal(f.db, identity.intakeId, original);
  ensureIntakeFrontierObserver(f.db);
  const witness = captureIntakeLegacyBridgeReadWitness(f.db, identity.intakeId);
  t.after(() => disposeIntakeLegacyBridgeReadWitness(witness));
  return {
    ...f,
    sourceRaw: f.db
      .prepare('SELECT details_json FROM source_files WHERE id=?')
      .get(identity.intakeId)!.details_json as string,
    check: () => assertIntakeLegacyBridgeReadWitness(f.db, witness),
    revoke: () => disposeIntakeLegacyBridgeReadWitness(witness),
  };
}

function exercise(scratch: Scratch, nodes: number) {
  let operations = 0;
  for (let n = 0; n < nodes; n++) {
    const node = ref(n);
    if (n === 0) node.first = node.last = '\0'.repeat(1024);
    assert.equal(scratch.seen(node.hash, 'map'), undefined);
    scratch.remember(node, 'map', n, n + 1);
    scratch.enqueue(node, 'map', n);
    scratch.enqueue(node, 'map', n);
    assert.deepEqual(scratch.seen(node.hash, 'map'), { ref: node, bytes: n, maxSequence: n + 1 });
    assert.deepEqual(scratch.nested(node.hash, 'map'), { ref: node, kind: 'map', bytes: n });
    operations += 6;
  }
  for (;;) {
    const next = scratch.nextNested();
    operations++;
    if (!next) break;
    scratch.finishNested(next.ref, next.kind);
    operations++;
  }
  return operations;
}

test('live summary checks bound full proofs without changing encrypted AVL work or default checks', (t) => {
  // Scalar IDs participate in immutable page hashes/AVL ordering. Fix only
  // those test IDs so equal physical work is comparable across invocations.
  let scalarId = 0;
  const uuid = t.mock.method(
    crypto,
    'randomUUID',
    () => `00000000-0000-4000-8000-${String(++scalarId).padStart(12, '0')}`,
  );
  syncBuiltinESMExports();
  t.after(() => {
    uuid.mock.restore();
    syncBuiltinESMExports();
  });
  for (const nodes of [1, 48]) {
    const run = (live: boolean) => {
      scalarId = 0;
      let checks = 0;
      const scratch = createIntakeGraphScratch(
        identity,
        'fictional selected graph',
        () => checks++,
        {
          liveSummaryChecks: live,
        },
      );
      try {
        checks = 0;
        const operations = exercise(scratch, nodes);
        return { checks, operations, stats: scratch.stats() };
      } finally {
        scratch.close();
      }
    };
    const baseline = run(false),
      live = run(true);
    t.diagnostic(
      JSON.stringify({
        nodes,
        baseline: baseline.checks,
        live: live.checks,
        operations: live.operations,
      }),
    );
    assert.deepEqual(live.stats, baseline.stats);
    assert.equal(live.checks, live.operations * 2);
    assert.ok(baseline.checks > live.checks * 2, 'existing per-cell path exceeds the live bound');
    assert.ok(live.stats.peakCachePages <= 128);
    assert.ok(live.stats.scalarChunkWrites > 0);
  }
  // Pin a small default schedule independently of the option and tree depth.
  let checks = 0;
  const scratch = createIntakeGraphScratch(identity, 'fictional empty graph', () => checks++);
  try {
    checks = 0;
    scratch.seen(ref(0).hash, 'map');
    assert.equal(checks, 2);
  } finally {
    scratch.close();
  }
});

test('live summary boundary reduces actual genuine contributor proof work', (t) => {
  const f = genuine(t);
  const run = (live: boolean) => {
    let checks = 0;
    const scratch = createIntakeGraphScratch(
      identity,
      'fictional genuine graph',
      () => {
        checks++;
        f.check();
      },
      { liveSummaryChecks: live },
    );
    const work = createRecordVersionWorkCounters();
    try {
      checks = 0;
      const operations = withRecordVersionWork(work, () => exercise(scratch, 1));
      return { checks, operations, work: work.operation };
    } finally {
      scratch.close();
    }
  };
  const baseline = run(false),
    live = run(true);
  t.diagnostic(
    JSON.stringify({
      baseline: { checks: baseline.checks, HEAD: baseline.work.headReadCalls },
      live: { checks: live.checks, HEAD: live.work.headReadCalls },
      operations: live.operations,
    }),
  );
  assert.equal(live.checks, live.operations * 2);
  assert.ok(live.work.headReadCalls > 0);
  assert.ok(baseline.work.headReadCalls > live.work.headReadCalls * 2);
});

test('live reference copies preserve allowed key order and remain detached', () => {
  const scratch = createIntakeGraphScratch(identity, 'fictional ordered graph', () => {}, {
    liveSummaryChecks: true,
  });
  try {
    const node = ref(0),
      scrambled = {
        last: node.last,
        first: node.first,
        height: node.height,
        count: node.count,
        hash: node.hash,
      };
    scratch.remember(scrambled, 'map', 1, 2);
    const result = scratch.seen(node.hash, 'map')!;
    assert.equal(JSON.stringify(result.ref), JSON.stringify(scrambled));
    scrambled.first = 'changed';
    result.ref.last = 'changed';
    assert.equal(scratch.seen(node.hash, 'map')!.ref.first, node.first);
    assert.equal(scratch.seen(node.hash, 'map')!.ref.last, node.last);
    assert.equal('then' in result, false);
    assert.equal(Symbol.iterator in result, false);
  } finally {
    scratch.close();
  }
});

test('copy and stack methods retain their per-cell checkpoint schedule in live mode', () => {
  const run = (live: boolean) => {
    let checks = 0;
    const scratch = createIntakeGraphScratch(identity, 'fictional copy schedule', () => checks++, {
      liveSummaryChecks: live,
    });
    try {
      checks = 0;
      scratch.rememberCopy(ref(0).hash, 'map', '', ref(0), 1);
      assert.deepEqual(scratch.copied(ref(0).hash, 'map'), { ref: ref(0), bytes: 1 });
      scratch.push(ref(0), 'map', '');
      assert.deepEqual(scratch.top()!.ref, ref(0));
      scratch.pop();
      return checks;
    } finally {
      scratch.close();
    }
  };
  const baseline = run(false);
  assert.ok(baseline > 10);
  assert.equal(run(true), baseline);
});

for (const malformed of ['getter', 'toJSON', 'proxy', 'symbol', 'hidden'] as const)
  test(`live summary refuses ${malformed} input without invoking caller code`, () => {
    let effects = 0;
    const scratch = createIntakeGraphScratch(identity, 'fictional malformed graph', () => {}, {
      liveSummaryChecks: true,
    });
    let node = ref(0);
    if (malformed === 'getter')
      Object.defineProperty(node, 'hash', {
        enumerable: true,
        get() {
          effects++;
          return ref(0).hash;
        },
      });
    if (malformed === 'toJSON')
      Object.defineProperty(node, 'toJSON', {
        value() {
          effects++;
          return ref(0);
        },
        enumerable: true,
      });
    if (malformed === 'proxy')
      node = new Proxy(node, {
        ownKeys(target) {
          effects++;
          return Reflect.ownKeys(target);
        },
      });
    if (malformed === 'symbol')
      Object.defineProperty(node, Symbol('fictional extra'), { value: 1 });
    if (malformed === 'hidden') Object.defineProperty(node, 'fictionalExtra', { value: 1 });
    assert.throws(() => scratch.remember(node, 'map', 1, 1), /graph scratch reference/);
    assert.equal(effects, 0);
    assert.equal(fs.existsSync(scratch.directory), false);
    assert.throws(() => scratch.seen(ref(0).hash, 'map'), /closed/);
  });

const reenter = {
  seen: (scratch: Scratch) => scratch.seen(ref(0).hash, 'map'),
  remember: (scratch: Scratch) => scratch.remember(ref(0), 'map', 1, 1),
  nested: (scratch: Scratch) => scratch.nested(ref(0).hash, 'map'),
  enqueue: (scratch: Scratch) => scratch.enqueue(ref(0), 'map', 1),
  nextNested: (scratch: Scratch) => scratch.nextNested(),
  finishNested: (scratch: Scratch) => scratch.finishNested(ref(0), 'map'),
  copied: (scratch: Scratch) => scratch.copied(ref(0).hash, 'map'),
  rememberCopy: (scratch: Scratch) => scratch.rememberCopy(ref(0).hash, 'map', '', ref(0), 1),
  push: (scratch: Scratch) => scratch.push(ref(0), 'map', ''),
  top: (scratch: Scratch) => scratch.top(),
  pop: (scratch: Scratch) => scratch.pop(),
};
for (const nested of Object.keys(reenter) as Array<keyof typeof reenter>)
  for (const boundary of ['entry', 'exit'] as const)
    test(`caught ${nested} reentry during ${boundary} poisons live operation`, () => {
      let scratch: Scratch | undefined,
        checks = 0,
        armed = false;
      scratch = createIntakeGraphScratch(
        identity,
        'fictional reentry graph',
        () => {
          if (!armed || ++checks !== (boundary === 'entry' ? 1 : 2)) return;
          assert.throws(() => reenter[nested](scratch!), /reentrant/);
        },
        { liveSummaryChecks: true },
      );
      armed = true;
      assert.throws(() => scratch!.remember(ref(0), 'map', 1, 1), /closed/);
      assert.equal(fs.existsSync(scratch.directory), false);
      assert.throws(() => scratch!.nextNested(), /closed/);
    });

for (const boundary of ['entry', 'exit'] as const)
  test(`closing callback at ${boundary} refuses before exposing summary`, () => {
    let scratch: Scratch | undefined,
      checks = 0,
      armed = false;
    scratch = createIntakeGraphScratch(
      identity,
      'fictional close graph',
      () => {
        if (armed && ++checks === (boundary === 'entry' ? 1 : 2)) scratch!.close();
      },
      { liveSummaryChecks: true },
    );
    armed = true;
    assert.throws(() => scratch!.remember(ref(0), 'map', 1, 1), /closed/);
    assert.equal(fs.existsSync(scratch.directory), false);
    assert.throws(() => scratch!.top(), /closed/);
  });

for (const fault of [
  'current',
  'cancellation',
  'HEAD',
  'source SQL',
  'SQL',
  'methods',
  'reentry',
] as const)
  test(`native scratch I/O ${fault} mutation is refused by the original closing proof`, (t) => {
    const f = genuine(t),
      controller = new AbortController(),
      scratch = createIntakeGraphScratch(
        identity,
        'fictional native graph',
        () => {
          controller.signal.throwIfAborted();
          f.check();
        },
        {
          liveSummaryChecks: true,
        },
      );
    t.after(() => scratch.close());
    const nativeWrite = fs.writeSync;
    let fired = false;
    const mock = t.mock.method(fs, 'writeSync', ((...args: Parameters<typeof fs.writeSync>) => {
      const result = Reflect.apply(nativeWrite, fs, args);
      if (!fired) {
        fired = true;
        if (fault === 'current') f.revoke();
        else if (fault === 'cancellation') controller.abort(Error('fictional cancellation'));
        else if (fault === 'reentry') assert.throws(() => scratch.top(), /reentrant/);
        else if (fault === 'HEAD') {
          const original = fs.readFileSync(f.authority.headPath);
          const changed = Buffer.from(original);
          changed[0] ^= 1;
          fs.writeFileSync(f.authority.headPath, changed);
          fs.writeFileSync(f.authority.headPath, original);
        } else if (fault === 'source SQL') {
          const update = f.db.prepare('UPDATE source_files SET details_json=? WHERE id=?');
          update.run('{"fictional":true}', identity.intakeId);
          update.run(f.sourceRaw, identity.intakeId);
        } else if (fault === 'SQL') {
          f.db.exec('CREATE TABLE fictional_native_attempt(value TEXT)');
          f.db.exec('DROP TABLE fictional_native_attempt');
        } else {
          f.db.setAuthorizer(() => 0);
          f.db.setAuthorizer(null);
        }
      }
      return result;
    }) as typeof fs.writeSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => scratch.remember(ref(0), 'map', 1, 1), /authority|current|cancellation/);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(fired, true);
    assert.equal(fs.existsSync(scratch.directory), false);
    assert.throws(() => scratch.seen(ref(0).hash, 'map'), /closed/);
  });

for (const fault of ['HEAD', 'reentry', 'cancellation'] as const)
  test(`native scratch read ${fault} refuses before exposing cached plaintext and erases keys`, (t) => {
    const f = genuine(t),
      refusal = Error('fictional read cancellation'),
      keys: Buffer[] = [],
      nativeRandom = crypto.randomBytes;
    const random = t.mock.method(crypto, 'randomBytes', ((size: number) => {
      const bytes = nativeRandom(size);
      if (size === 32) keys.push(bytes);
      return bytes;
    }) as typeof crypto.randomBytes);
    syncBuiltinESMExports();
    let cancelled = false;
    const scratch = createIntakeGraphScratch(
      identity,
      'fictional native read graph',
      () => {
        if (cancelled) throw refusal;
        f.check();
      },
      { liveSummaryChecks: true },
    );
    t.after(() => scratch.close());
    assert.equal(keys.length, 2);
    scratch.remember(ref(0), 'map', 1, 1);
    assert.deepEqual(scratch.seen(ref(0).hash, 'map'), { ref: ref(0), bytes: 1, maxSequence: 1 });
    const nativeOpen = fs.openSync,
      nativeClose = fs.closeSync,
      nativeRead = fs.readSync,
      scratchFiles = new Set<number>();
    let fired = false;
    const open = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
      const fd = Reflect.apply(nativeOpen, fs, args);
      if (String(args[0]).startsWith(scratch.directory + '/')) scratchFiles.add(fd);
      return fd;
    }) as typeof fs.openSync);
    const close = t.mock.method(fs, 'closeSync', (fd: number) => {
      scratchFiles.delete(fd);
      return nativeClose(fd);
    });
    const read = t.mock.method(fs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
      const result = Reflect.apply(nativeRead, fs, args);
      if (!fired && scratchFiles.has(args[0])) {
        fired = true;
        if (fault === 'HEAD') {
          const original = fs.readFileSync(f.authority.headPath);
          fs.writeFileSync(f.authority.headPath, original);
          fs.writeFileSync(f.authority.headPath, original);
        } else if (fault === 'reentry')
          assert.throws(() => scratch.copied(ref(0).hash, 'map'), /reentrant/);
        else cancelled = true;
      }
      return result;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => scratch.seen(ref(0).hash, 'map'),
        fault === 'cancellation' ? (error) => error === refusal : /authority/,
      );
      assert.equal(
        fired,
        true,
        'fault ran on an actual scratch read after a successful cached read',
      );
      assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
      assert.equal(fs.existsSync(scratch.directory), false);
      assert.throws(() => scratch.nextNested(), /closed/);
    } finally {
      read.mock.restore();
      close.mock.restore();
      open.mock.restore();
      random.mock.restore();
      syncBuiltinESMExports();
    }
  });

test('native I/O refusal survives cleanup failure and never exposes a result', (t) => {
  const refusal = Error('fictional native write refusal'),
    nativeWrite = fs.writeSync,
    nativeRemove = fs.rmSync,
    scratch = createIntakeGraphScratch(identity, 'fictional failed graph', () => {}, {
      liveSummaryChecks: true,
    });
  const write = t.mock.method(fs, 'writeSync', (() => {
      throw refusal;
    }) as typeof nativeWrite),
    remove = t.mock.method(fs, 'rmSync', (() => {
      throw Object.assign(Error('fictional cleanup refusal'), { code: 'EACCES' });
    }) as typeof nativeRemove);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => scratch.remember(ref(0), 'map', 1, 1),
      (error) => error === refusal,
    );
    assert.throws(() => scratch.seen(ref(0).hash, 'map'), /closed/);
    assert.equal(scratch.stats().cleanupFailures, 1);
  } finally {
    write.mock.restore();
    remove.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(scratch.directory, { recursive: true, force: true });
  }
});
