import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import test, { after, type TestContext } from 'node:test';
import {
  createEncryptedIntakeJsonCanonicalScratch,
  prepareIntakeJsonCanonicalSteps,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalScratch,
  type IntakeJsonCanonicalWork,
} from '../intake-json-canonical.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import { createEncryptedCanonicalIndex } from '../intake-json-canonical-encrypted.ts';
import type { CanonicalByteSpool } from '../intake-json-canonical-index.ts';
const originalStackLimit = Error.stackTraceLimit;
Error.stackTraceLimit = 40;
after(() => {
  Error.stackTraceLimit = originalStackLimit;
});

const options = (assertCurrent = () => {}, livePointChecks = true) => ({
  identity: {
    profileId: 'fictional-accounting',
    intakeId: 'fictional-accounting-original',
    sourceHash: 'a'.repeat(64),
  },
  selectedHead: 'Independently fictional accounting HEAD',
  assertCurrent,
  livePointChecks,
});
const prepared = (scratch: IntakeJsonCanonicalScratch, source = '{"fictional":1}') =>
  finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps([source], { scratch }));
function observe(t: TestContext) {
  const directories: string[] = [],
    keys: Buffer[] = [],
    random = crypto.randomBytes,
    mkdtemp = fs.mkdtempSync;
  const randomMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const bytes = random(size);
    if (size === 32) keys.push(bytes);
    return bytes;
  }) as typeof crypto.randomBytes);
  const directoryMock = t.mock.method(fs, 'mkdtempSync', ((
    ...args: Parameters<typeof fs.mkdtempSync>
  ) => {
    const directory = Reflect.apply(mkdtemp, fs, args);
    directories.push(fs.realpathSync.native(String(directory)));
    return directory;
  }) as typeof fs.mkdtempSync);
  syncBuiltinESMExports();
  t.after(() => {
    // Assertions inspect real owner cleanup before this failure-only fallback.
    for (const key of keys) key.fill(0);
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    randomMock.mock.restore();
    directoryMock.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    directories,
    keys,
    assertClosed() {
      assert.ok(directories.length > 0 && directories.every((path) => !fs.existsSync(path)));
      assert.ok(keys.length > 0 && keys.every((key) => key.every((byte) => byte === 0)));
    },
  };
}
function stableIds(t: TestContext) {
  let n = 0;
  const mock = t.mock.method(
    crypto,
    'randomUUID',
    (() => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0')) as typeof crypto.randomUUID,
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return () => {
    n = 0;
  };
}

for (const boundary of ['initial', 'reset'] as const)
  for (const caught of [false, true])
    test(`${caught ? 'caught' : 'uncaught'} acquisition reentry during ${boundary} refuses instead of silently rebinding inner bytes`, (t) => {
      const o = observe(t);
      let armed = false,
        entered = false,
        refusal: unknown,
        inner: PreparedIntakeJsonCanonical | undefined,
        scratch: IntakeJsonCanonicalScratch;
      scratch = createEncryptedIntakeJsonCanonicalScratch(
        options(() => {
          if (!armed || entered) return;
          const stack = new Error().stack ?? '';
          if (
            !stack.includes('EncryptedScratchSet.acquire') ||
            (boundary === 'reset' && !stack.includes('Object.reset'))
          )
            return;
          entered = true;
          try {
            inner = prepared(scratch, '{"fictional":1}');
            assert.fail('nested acquisition must refuse before exposing an inner preparation');
          } catch (error) {
            refusal = error;
            if (!caught) throw error;
          }
        }),
      );
      armed = true;
      assert.throws(
        () => prepared(scratch, '{"fictional":2}'),
        (error) =>
          error === refusal &&
          error instanceof Error &&
          /reentrant acquisition/.test(error.message),
      );
      assert.equal(entered, true);
      assert.equal(inner, undefined);
      assert.equal(scratch.uses, 0);
      o.assertClosed();
      assert.throws(() => prepared(scratch), /closed/);
      scratch.close();
    });

for (const boundary of ['initial', 'reset'] as const)
  test(`caught handle close during ${boundary} acquisition terminally refuses and erases keys`, (t) => {
    const o = observe(t);
    let armed = false,
      entered = false,
      refusal: unknown,
      scratch: IntakeJsonCanonicalScratch;
    scratch = createEncryptedIntakeJsonCanonicalScratch(
      options(() => {
        if (!armed || entered) return;
        const stack = new Error().stack ?? '';
        if (
          !stack.includes('EncryptedScratchSet.acquire') ||
          (boundary === 'reset' && !stack.includes('Object.reset'))
        )
          return;
        entered = true;
        try {
          scratch.close();
          assert.fail('acquiring close must refuse');
        } catch (error) {
          refusal = error;
        }
      }),
    );
    armed = true;
    assert.throws(
      () => prepared(scratch),
      (error) =>
        error === refusal && error instanceof Error && /reentrant acquisition/.test(error.message),
    );
    assert.equal(entered, true);
    o.assertClosed();
    scratch.close();
    assert.throws(() => prepared(scratch), /closed/);
  });

for (const live of [false, true])
  test(`${live ? 'live' : 'generic'} normal busy rejection remains nonpoisoning and preparation release permits healthy reuse`, () => {
    const scratch = createEncryptedIntakeJsonCanonicalScratch(options(() => {}, live));
    let first: PreparedIntakeJsonCanonical | undefined,
      second: PreparedIntakeJsonCanonical | undefined;
    try {
      first = prepared(scratch, '{"fictional":1}');
      assert.throws(() => prepared(scratch, '{"fictional":2}'), /in use/);
      assert.throws(() => scratch.close(), /in use/);
      assert.equal([...first.chunks()].join(''), '{"fictional":1}');
      first.close();
      first.close();
      second = prepared(scratch, '{"fictional":2}');
      assert.equal([...second.chunks()].join(''), '{"fictional":2}');
      assert.equal(scratch.uses, 2);
      assert.equal(scratch.reuses, 1);
      second.close();
      scratch.close();
      assert.throws(() => prepared(scratch), /closed/);
    } finally {
      first?.close();
      second?.close();
      scratch.close();
    }
  });

for (const cleanupFails of [false, true])
  test(`original acquisition policy refusal survives ${cleanupFails ? 'failing' : 'normal'} encrypted cleanup`, (t) => {
    const o = observe(t),
      refusal = Error('fictional original acquisition refusal');
    let armed = false;
    const scratch = createEncryptedIntakeJsonCanonicalScratch(
      options(() => {
        if (armed) throw refusal;
      }),
    );
    const rm = fs.rmSync;
    const mock = cleanupFails
      ? t.mock.method(fs, 'rmSync', (() => {
          throw Object.assign(Error('fictional cleanup'), { code: 'EACCES' });
        }) as typeof fs.rmSync)
      : undefined;
    syncBuiltinESMExports();
    try {
      armed = true;
      assert.throws(
        () => prepared(scratch),
        (error) => error === refusal,
      );
      assert.ok(o.keys.every((key) => key.every((byte) => byte === 0)));
      assert.throws(() => prepared(scratch), /closed/);
      scratch.close();
    } finally {
      mock?.mock.restore();
      syncBuiltinESMExports();
      if (cleanupFails) for (const dir of o.directories) rm(dir, { recursive: true, force: true });
    }
    o.assertClosed();
  });

for (const changed of ['function', 'getter'] as const)
  test(`live factory captures policy and mode once despite later ${changed} replacement`, () => {
    let policyReads = 0,
      modeReads = 0,
      revoked = false;
    const refusal = Error('fictional pinned live factory'),
      opts = options();
    Object.defineProperty(opts, 'assertCurrent', {
      enumerable: true,
      configurable: true,
      get() {
        policyReads++;
        return () => {
          if (revoked) throw refusal;
        };
      },
    });
    Object.defineProperty(opts, 'livePointChecks', {
      enumerable: true,
      configurable: true,
      get() {
        modeReads++;
        return modeReads === 1;
      },
    });
    const scratch = createEncryptedIntakeJsonCanonicalScratch(opts);
    try {
      assert.equal(policyReads, 1);
      assert.equal(modeReads, 1);
      const tree = prepared(scratch);
      tree.close();
      if (changed === 'function') {
        Object.defineProperty(opts, 'assertCurrent', { value: () => {}, configurable: true });
        Object.defineProperty(opts, 'livePointChecks', { value: false, configurable: true });
      } else {
        Object.defineProperty(opts, 'assertCurrent', {
          get() {
            policyReads++;
            throw Error('late policy getter');
          },
          configurable: true,
        });
        Object.defineProperty(opts, 'livePointChecks', {
          get() {
            modeReads++;
            throw Error('late mode getter');
          },
          configurable: true,
        });
      }
      revoked = true;
      assert.throws(
        () => prepared(scratch),
        (error) => error === refusal,
      );
      assert.equal(policyReads, 1);
      assert.equal(modeReads, 1);
    } finally {
      scratch.close();
    }
  });

test('generic factory retains both original construction policy selections', () => {
  let reads = 0,
    firstCalls = 0,
    secondCalls = 0;
  const opts = options(() => {}, false);
  Object.defineProperty(opts, 'assertCurrent', {
    get() {
      reads++;
      return reads === 1
        ? () => {
            firstCalls++;
          }
        : () => {
            secondCalls++;
          };
    },
    enumerable: true,
  });
  const scratch = createEncryptedIntakeJsonCanonicalScratch(opts);
  try {
    const tree = prepared(scratch);
    tree.close();
    assert.equal(reads, 2);
    assert.ok(firstCalls > 0);
    assert.ok(secondCalls > 0);
  } finally {
    scratch.close();
  }
});

function accountingRun(t: TestContext, source: string, live: boolean, readTwice = true) {
  let checks = 0,
    accountingChecks = 0,
    functionalLengthChecks = 0;
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const io = { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 },
    nativeRead = fs.readSync,
    nativeWrite = fs.writeSync;
  const read = t.mock.method(fs, 'readSync', ((...args: Parameters<typeof fs.readSync>) => {
    const result = Reflect.apply(nativeRead, fs, args);
    io.reads++;
    io.readBytes += result;
    return result;
  }) as typeof fs.readSync);
  const write = t.mock.method(fs, 'writeSync', ((...args: Parameters<typeof fs.writeSync>) => {
    const result = Reflect.apply(nativeWrite, fs, args);
    io.writes++;
    io.writeBytes += result;
    return result;
  }) as typeof fs.writeSync);
  syncBuiltinESMExports();
  const snapshots: Readonly<IntakeJsonCanonicalWork>[] = [];
  const scratch = createEncryptedIntakeJsonCanonicalScratch(
    options(() => {
      checks++;
      const stack = new Error().stack ?? '';
      if (stack.includes('get length')) {
        if (stack.includes('EncryptedSpool.appendBytes') || stack.includes('EncryptedSpool.flush'))
          accountingChecks++;
        else functionalLengthChecks++;
      }
    }, live),
  );
  let tree: PreparedIntakeJsonCanonical | undefined;
  try {
    tree = finishIntakeCopySteps(
      prepareIntakeJsonCanonicalSteps([source], {
        scratch,
        onWork: (work) => snapshots.push(work),
      }),
    );
    const raw = [...tree.chunks()].join('');
    if (readTwice) assert.equal([...tree.chunks()].join(''), raw);
    const bytes = tree.bytes,
      work = tree.work;
    tree.close();
    return {
      checks,
      accountingChecks,
      functionalLengthChecks,
      io,
      raw,
      bytes,
      work,
      finalWork: snapshots.at(-1)!,
    };
  } finally {
    tree?.close();
    scratch.close();
    read.mock.restore();
    write.mock.restore();
    syncBuiltinESMExports();
    Error.stackTraceLimit = previous;
  }
}

test('live accounting removes redundant metadata proofs while retaining actual bytes/work and checked functional length', (t) => {
  const reset = stableIds(t),
    source = '{"fictional":[1,true,null,"fictional text"],"duplicate":1,"duplicate":2}';
  reset();
  const generic = accountingRun(t, source, false);
  reset();
  const live = accountingRun(t, source, true);
  t.diagnostic(
    JSON.stringify({
      generic: {
        checks: generic.checks,
        accounting: generic.accountingChecks,
        length: generic.functionalLengthChecks,
      },
      live: {
        checks: live.checks,
        accounting: live.accountingChecks,
        length: live.functionalLengthChecks,
      },
      io: live.io,
    }),
  );
  assert.ok(generic.accountingChecks > 0);
  assert.equal(live.accountingChecks, 0);
  assert.ok(live.functionalLengthChecks > 0);
  assert.equal(live.functionalLengthChecks, generic.functionalLengthChecks);
  assert.deepEqual(
    { ...live, checks: 0, accountingChecks: 0 },
    { ...generic, checks: 0, accountingChecks: 0 },
  );
});

for (const bytes of [2, 3, 4095, 4096, 4097, 8191, 8192, 8193])
  test(`live ${bytes}-byte UTF8 scalar preserves chunk-boundary, repeated flush and read work`, (t) => {
    const reset = stableIds(t),
      content = bytes < 5 ? 'x'.repeat(bytes - 2) : '界' + 'x'.repeat(bytes - 5),
      source = JSON.stringify(content);
    assert.equal(Buffer.byteLength(source), bytes);
    reset();
    const generic = accountingRun(t, source, false);
    reset();
    const live = accountingRun(t, source, true);
    assert.equal(live.bytes, bytes);
    assert.equal(live.raw, source);
    assert.deepEqual(live.io, generic.io);
    assert.deepEqual(live.work, generic.work);
    assert.deepEqual(live.finalWork, generic.finalWork);
  });

test('preparation reuse creates fresh zero-length ledgers after exact generation resets', (t) => {
  const reset = stableIds(t);
  const run = (live: boolean) => {
    const scratch = createEncryptedIntakeJsonCanonicalScratch(options(() => {}, live)),
      results: unknown[] = [];
    try {
      for (const text of ['x'.repeat(4097), '界', 'y'.repeat(8191), '']) {
        const snapshots: Readonly<IntakeJsonCanonicalWork>[] = [];
        const source = JSON.stringify({ fictional: text }),
          tree = finishIntakeCopySteps(
            prepareIntakeJsonCanonicalSteps([source], {
              scratch,
              onWork: (work) => snapshots.push(work),
            }),
          );
        try {
          const raw = [...tree.chunks()].join('');
          assert.equal(raw, source);
          results.push({ raw, bytes: tree.bytes, work: tree.work });
        } finally {
          tree.close();
        }
        results.push(snapshots.at(-1));
      }
      assert.equal(scratch.uses, 4);
      assert.equal(scratch.reuses, 3);
      return results;
    } finally {
      scratch.close();
    }
  };
  reset();
  const generic = run(false);
  reset();
  assert.deepEqual(run(true), generic);
});

for (const cleanup of ['iterator', 'observer'] as const)
  test(`live acquisition preserves original policy error when ${cleanup} cleanup also throws`, (t) => {
    const o = observe(t),
      refusal = Error('fictional primary acquisition error'),
      cleanupError = Error('fictional cleanup error');
    let armed = false;
    const scratch = createEncryptedIntakeJsonCanonicalScratch(
      options(() => {
        if (armed) throw refusal;
      }),
    );
    const pieces: Iterable<string> = {
      [Symbol.iterator]() {
        return {
          next() {
            return { done: false, value: 'null' };
          },
          return() {
            if (cleanup === 'iterator') throw cleanupError;
            return { done: true, value: undefined };
          },
        };
      },
    };
    armed = true;
    assert.throws(
      () =>
        finishIntakeCopySteps(
          prepareIntakeJsonCanonicalSteps(pieces, {
            scratch,
            onWork() {
              if (cleanup === 'observer') throw cleanupError;
            },
          }),
        ),
      (error) => error === refusal,
    );
    o.assertClosed();
    scratch.close();
  });

for (const stage of ['append', 'flush'] as const)
  for (const kind of ['native', 'capacity', 'policy'] as const)
    test(`live ${stage} ${kind} failure preserves primary error, exact prior accounting and terminal keys`, (t) => {
      const reset = stableIds(t),
        o = observe(t),
        refusal =
          kind === 'capacity'
            ? Object.assign(Error('fictional space failure'), { code: 'ENOSPC' })
            : Error('fictional spool refusal');
      const run = (live: boolean) => {
        const snapshots: Readonly<IntakeJsonCanonicalWork>[] = [];
        let fired = false;
        const check = () => {
          const stack = new Error().stack ?? '';
          if (
            kind === 'policy' &&
            !fired &&
            stack.includes(
              stage === 'append' ? 'EncryptedSpool.appendBytes' : 'EncryptedSpool.flush',
            ) &&
            !stack.includes('get length')
          ) {
            fired = true;
            throw refusal;
          }
        };
        const scratch = createEncryptedIntakeJsonCanonicalScratch(options(check, live)),
          write = fs.writeSync;
        const mock = t.mock.method(fs, 'writeSync', ((...args: Parameters<typeof fs.writeSync>) => {
          const stack = new Error().stack ?? '';
          if (
            kind !== 'policy' &&
            !fired &&
            stack.includes(
              stage === 'append' ? 'EncryptedSpool.appendBytes' : 'EncryptedSpool.flush',
            )
          ) {
            fired = true;
            throw refusal;
          }
          return Reflect.apply(write, fs, args);
        }) as typeof fs.writeSync);
        syncBuiltinESMExports();
        try {
          assert.throws(
            () =>
              finishIntakeCopySteps(
                prepareIntakeJsonCanonicalSteps([JSON.stringify('fictional'.repeat(1100))], {
                  scratch,
                  onWork: (work) => snapshots.push(work),
                }),
              ),
            (error) =>
              kind === 'capacity'
                ? (error as Error & { code?: string; cause?: unknown }).code === 'ENOSPC' &&
                  (error as Error).cause === refusal
                : error === refusal,
          );
          assert.equal(fired, true);
          assert.throws(() => prepared(scratch), /closed/);
          return snapshots.at(-1)!;
        } finally {
          mock.mock.restore();
          syncBuiltinESMExports();
          scratch.close();
        }
      };
      reset();
      const generic = run(false);
      reset();
      const live = run(true);
      assert.deepEqual(live, generic);
      o.assertClosed();
    });

test('exact private spool class preserves append-after-partial-flush bookkeeping against real encrypted storage', async (t) => {
  const reset = stableIds(t),
    directory = fs.mkdtempSync(join(tmpdir(), 'fictional-canonical-class-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceURL = new URL('../intake-json-canonical.ts', import.meta.url),
    source = fs.readFileSync(sourceURL, 'utf8');
  // Only module paths and one export change. The class body is the exact current
  // implementation; no production export/test hook or replacement spool exists.
  const portable = source.replace(
    /from '(\.\/[^']+)'/g,
    (_all, relative: string) => 'from ' + JSON.stringify(new URL(relative, sourceURL).href),
  );
  const path = join(directory, 'canonical.ts');
  fs.writeFileSync(path, portable + '\nexport { EncryptedSpool as TestEncryptedSpool };\n');
  assert.equal(
    fs.readFileSync(path, 'utf8'),
    portable + '\nexport { EncryptedSpool as TestEncryptedSpool };\n',
  );
  const { TestEncryptedSpool } = (await import(
    pathToFileURL(fs.realpathSync.native(path)).href
  )) as {
    TestEncryptedSpool: new (
      spool: CanonicalByteSpool,
      work: IntakeJsonCanonicalWork,
      live?: boolean,
    ) => {
      appendBytes(bytes: Uint8Array): void;
      flush(): void;
      read(start: number, bytes: number): Iterable<Buffer>;
      readonly length: number;
    };
  };
  assert.ok(fileURLToPath(sourceURL).endsWith('/intake-json-canonical.ts'));
  const run = (live: boolean) => {
    let checks = 0,
      accounting = 0;
    const data = createEncryptedCanonicalIndex(
      options(() => {
        checks++;
        const stack = new Error().stack ?? '';
        if (
          stack.includes('get length') &&
          (stack.includes('EncryptedSpool.appendBytes') || stack.includes('EncryptedSpool.flush'))
        )
          accounting++;
      }),
    );
    const work: IntakeJsonCanonicalWork = {
      inputCodeUnits: 0,
      sqliteCalls: 0,
      scratchWrittenBytes: 0,
      scratchReadBytes: 0,
      scratchReadBufferAllocations: 0,
      scratchReadBufferReuses: 0,
      outputBytes: 0,
      maxChunkBytes: 0,
      maxBufferBytes: 0,
      maxNumberDigits: 0,
      yields: 0,
      keyIndexRows: 0,
    };
    try {
      data.reset();
      const spool = new TestEncryptedSpool(data.raw, work, live);
      checks = 0;
      spool.appendBytes(Buffer.from('界'));
      spool.flush();
      spool.flush();
      spool.appendBytes(Buffer.alloc(4093, 1));
      spool.flush();
      spool.appendBytes(Buffer.alloc(4096, 2));
      spool.appendBytes(Buffer.from([3]));
      spool.flush();
      assert.equal(spool.length, 8193);
      const read = Buffer.concat([...spool.read(0, 8193)]);
      assert.equal(read.length, 8193);
      assert.deepEqual(read.subarray(0, 3), Buffer.from('界'));
      assert.equal(Buffer.concat([...spool.read(300, 100)]).length, 100);
      spool.appendBytes(Buffer.alloc(8, 4));
      spool.flush();
      spool.flush();
      assert.equal(spool.length, 8201);
      assert.equal(work.scratchWrittenBytes, 8205);
      assert.equal(work.scratchReadBytes, 8293);
      return { work, stats: data.stats(), checks, accounting };
    } finally {
      data.close();
    }
  };
  reset();
  const generic = run(false);
  reset();
  const live = run(true);
  assert.ok(generic.accounting > 0);
  assert.equal(live.accounting, 0);
  assert.ok(live.checks < generic.checks);
  assert.deepEqual(live.work, generic.work);
  assert.deepEqual(live.stats, generic.stats);
});
