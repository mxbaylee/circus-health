import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import {
  inspectIntakeCollectionGraphSteps,
  validateIntakeCollectionGraphSteps,
} from '../intake-state-graph.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import {
  COLLECTION_FORMAT,
  digest,
  intakeNamespace,
  limits,
  budget,
  frameIntakeChanges,
  reconstructIntakeEvidence,
  type IntakeCollectionHeadV4,
  type Head,
} from '../intake-state-evidence.ts';
import {
  applyIntakeChanges,
  serializeIntakeJson,
  type IntakeChange,
} from '../intake-state-codec.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from '../intake-state-migration.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import {
  initializeIntakeLog,
  parseHead,
  rebuildIntakeLogSnapshot,
  disposeIntakeLogSnapshot,
  prepareIntakeLogAppend,
  inspectIntakeLogAppend,
  discardIntakeLogAppend,
  type Event,
} from '../intake-state-log.ts';
import { parseIntakeCollectionReceipt } from '../intake-state-collections.ts';
import { prepareIntakeLegacyReplay } from '../intake-state-legacy-replay.ts';

const identity = {
  profileId: 'fictional-log-source',
  intakeId: 'fictional-intake',
  sourceHash: 'a'.repeat(64),
};
const ordered = (n: number) => String(n).padStart(16, '0');
async function legacyFixture(v5: boolean, text = 'fictional graph legacy text') {
  const raw =
      ' {"unknown":{"number":12.00},"intake":{"version":7,"originalName":"fictional.zip","metadata":{"unknown":' +
      JSON.stringify(text) +
      ',"duplicate":1,"duplicate":2}}} \n',
    initial = prepareInitialIntakeEnvelope(raw),
    serialized = serializeIntakeJson(initial.state),
    caps = limits(),
    prefix = intakeNamespace(identity),
    rows = new Map<string, string>();
  let legacy: Head | undefined;
  const versions: IntakeChange[][] = [[{ op: 'set', path: [], value: initial.state }], []];
  for (const changes of versions) {
    const work = budget(
      caps,
      legacy?.usage ?? { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 },
    );
    applyIntakeChanges(legacy ? initial.state : undefined, changes, work);
    const evidence = frameIntakeChanges(
      identity,
      changes,
      digest(serialized),
      randomUUID(),
      caps,
      legacy,
      work,
    );
    for (const frame of evidence.frames) rows.set(frame.key, frame.serialized);
    rows.set(prefix + 'operation:' + evidence.result.operationId, evidence.receipt);
    legacy = evidence.head;
  }
  const get = (hash: string) => rows.get(prefix + 'node:' + hash),
    tree = createIntakeTree(identity, get, new Map()),
    control = tree.put(
      null,
      'representation',
      JSON.stringify({ kind: 'inline', text: INTAKE_LEGACY_BRIDGE_CONTROL }),
    ),
    logical = {
      domainVersion: 7,
      root: tree.put(
        null,
        'envelope.control',
        JSON.stringify({
          kind: 'map',
          root: control,
          bytes: Buffer.byteLength(INTAKE_LEGACY_BRIDGE_CONTROL),
        }),
      ),
    },
    operationId = randomUUID(),
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
          changed: false,
        },
      }),
    ),
    history = tree.put(
      null,
      ordered(1),
      JSON.stringify({
        format: 'health-intake-state-history-v4',
        operationId,
        previous: { format: 'health-intake-legacy-v3', head: legacy },
        logical,
        builds: null,
      }),
    );
  for (const node of tree.writes([logical.root, control, receipts, history]))
    rows.set(prefix + 'node:' + node.hash, node.raw);
  let head = JSON.stringify({
    format: COLLECTION_FORMAT,
    identity,
    storageSequence: 1,
    logical,
    receipts,
    history,
    builds: null,
  });
  if (v5) {
    const initialized = initializeIntakeLog(identity, head);
    for (const node of initialized.writes) rows.set(prefix + 'node:' + node.hash, node.raw);
    head = initialized.head;
    const admission = {
        assertCurrent() {},
        lookupBaseOperation(base: Readonly<IntakeCollectionHeadV4>, id: string) {
          const raw = createIntakeTree(identity, get, new Map()).get(base.receipts, id);
          return raw === undefined
            ? { kind: 'absent' as const }
            : {
                kind: 'receipt' as const,
                identity,
                receipt: parseIntakeCollectionReceipt(raw, identity, id) as Event['receipt'],
              };
        },
      },
      snapshot = await rebuildIntakeLogSnapshot(head, identity, get, admission),
      operationId = randomUUID();
    try {
      const pending = prepareIntakeLogAppend(
        snapshot,
        {
          receipt: {
            format: 'health-intake-state-receipt-v4',
            requestDigest: digest(operationId),
            result: {
              format: 'health-intake-state-result-v4',
              intakeId: identity.intakeId,
              operationId,
              storageSequence: 2,
              logical,
              changed: false,
            },
          },
          transition: {
            format: 'health-intake-state-log-transition-v1',
            operationId,
            previous: parseHead(head, identity),
            logical,
            builds: null,
          },
        },
        admission,
      );
      try {
        const prepared = inspectIntakeLogAppend(pending);
        for (const node of prepared.writes) rows.set(prefix + 'node:' + node.hash, node.raw);
        head = prepared.head;
      } finally {
        discardIntakeLogAppend(pending);
      }
    } finally {
      disposeIntakeLogSnapshot(snapshot);
    }
  }
  rows.set(prefix + 'head', head);
  return { rows, head, raw, serialized, initial, legacy: legacy! };
}

function stableIds(t: TestContext) {
  let id = 0;
  const mock = t.mock.method(
    crypto,
    'randomUUID',
    () => '00000000-0000-4000-8000-' + String(++id).padStart(12, '0'),
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return () => {
    id = 0;
  };
}
for (const v5 of [false, true])
  test(
    'live tagged V' +
      (v5 ? '5' : '4') +
      ' retains exact graph work with one full legacy policy path',
    async (t) => {
      const reset = stableIds(t),
        f = await legacyFixture(v5),
        before = [...f.rows];
      const run = (live: boolean) => {
        reset();
        let callbacks = 0,
          yields = 0;
        const reads: string[] = [],
          io = { readCalls: 0, readBytes: 0, writeCalls: 0, writeBytes: 0 };
        const nativeRead = fs.readSync,
          nativeWrite = fs.writeSync;
        const readMock = t.mock.method(fs, 'readSync', ((
          ...args: Parameters<typeof fs.readSync>
        ) => {
          const result = Reflect.apply(nativeRead, fs, args);
          io.readCalls++;
          io.readBytes += result;
          return result;
        }) as typeof fs.readSync);
        const writeMock = t.mock.method(fs, 'writeSync', ((
          ...args: Parameters<typeof fs.writeSync>
        ) => {
          const result = Reflect.apply(nativeWrite, fs, args);
          io.writeCalls++;
          io.writeBytes += result;
          return result;
        }) as typeof fs.writeSync);
        syncBuiltinESMExports();
        const read = (key: string, maxBytes: number) => {
          reads.push(key);
          const raw = f.rows.get(key);
          if (raw !== undefined) assert.ok(Buffer.byteLength(raw) <= maxBytes);
          return raw;
        };
        try {
          const steps = live
            ? validateIntakeCollectionGraphSteps(identity, f.head, read, () => {
                callbacks++;
              })
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
                () => {
                  callbacks++;
                },
              );
          for (;;) {
            const next = steps.next();
            if (next.done) break;
            yields++;
          }
          return { callbacks, yields, reads, io };
        } finally {
          readMock.mock.restore();
          writeMock.mock.restore();
          syncBuiltinESMExports();
        }
      };
      const generic = run(false),
        live = run(true);
      t.diagnostic(
        JSON.stringify({
          v5,
          generic: { callbacks: generic.callbacks },
          live: { callbacks: live.callbacks },
          reads: live.reads.length,
          yields: live.yields,
          io: live.io,
        }),
      );
      assert.deepEqual(live.reads, generic.reads);
      assert.deepEqual(
        live.io,
        generic.io,
        'ciphertext transport work is unchanged; only redundant full policy invocations are removed',
      );
      assert.equal(live.yields, generic.yields);
      assert.equal(live.reads.length, v5 ? 25 : 17);
      assert.equal(live.yields, v5 ? 41 : 37);
      assert.equal(generic.callbacks, v5 ? 6483 : 6434);
      assert.equal(live.callbacks, v5 ? 3296 : 3239);
      assert.ok(
        live.callbacks < 3400,
        'tiny tagged graph has one full legacy policy callback per boundary',
      );
      assert.ok(
        generic.callbacks > 6300,
        'generic inspection retains its separate checkpoint schedule',
      );
      assert.deepEqual([...f.rows], before);
      // Decode the retained raw ancestor independently; the bridge keeps lexical
      // duplicates, its no-op version, exact consumed namespace and domain value.
      const replay = prepareIntakeLegacyReplay(identity, limits(), f.legacy, (key) =>
        f.rows.get(key),
      );
      try {
        assert.equal([...replay.pieces()].join(''), f.serialized);
        assert.equal([...replay.envelopePieces()].join(''), f.raw);
        assert.equal(replay.domainVersion(), 7);
        assert.deepEqual(
          new Set(replay.consumed()),
          new Set(
            [...f.rows.keys()].filter(
              (key) =>
                key.includes(':frame:') || key.includes(':operation:') || key.endsWith(':head'),
            ),
          ),
        );
        const target = { ...identity, profileId: 'fictional-log-target' },
          copied = new Map<string, string>();
        const head = replay.rebind(target, (key, value) => copied.set(key, value));
        assert.equal(head.version, f.legacy.version);
        assert.deepEqual(head.usage, f.legacy.usage);
        assert.equal(
          reconstructIntakeEvidence(target, limits(), head, (key) => copied.get(key)).serialized,
          f.serialized,
        );
      } finally {
        replay.close();
      }
    },
  );

test('generic encrypted replay preserves distinct and identical callback side effects', async (t) => {
  const reset = stableIds(t),
    f = await legacyFixture(false);
  const run = (same: boolean) => {
    reset();
    let authority = 0,
      progress = 0,
      sideEffects = 0,
      next = 'authority';
    const policy = () => {
      sideEffects++;
    };
    const replay = prepareIntakeLegacyReplay(
      identity,
      limits(),
      f.legacy,
      (key) => f.rows.get(key),
      {
        checkpoint: same
          ? policy
          : () => {
              assert.equal(next, 'progress');
              next = 'authority';
              progress++;
            },
        encryptedScratch: {
          selectedHead: f.head,
          assertCurrent: same
            ? policy
            : () => {
                assert.equal(next, 'authority');
                next = 'progress';
                authority++;
              },
        },
      },
    );
    try {
      assert.equal([...replay.envelopePieces()].join(''), f.raw);
      assert.equal(replay.domainVersion(), 7);
    } finally {
      replay.close();
    }
    assert.equal(next, 'authority');
    if (!same) {
      assert.ok(authority > 100);
      assert.equal(authority, progress);
    }
    return { authority, progress, sideEffects };
  };
  const distinct = run(false),
    same = run(true);
  assert.equal(same.sideEffects, distinct.authority + distinct.progress);
});

for (const mode of ['source', 'callback', 'yield', 'legacy I/O', 'canonical I/O'] as const)
  test(
    'live tagged legacy ' + mode + ' refusal preserves primary error and erases every owned key',
    async (t) => {
      stableIds(t);
      const f = await legacyFixture(true),
        before = [...f.rows],
        refusal = Error('fictional ' + mode + ' revocation');
      const directories: string[] = [],
        keys: Buffer[] = [],
        descriptors = new Map<number, string>();
      const nativeDirectory = fs.mkdtempSync,
        nativeRandom = crypto.randomBytes,
        nativeOpen = fs.openSync,
        nativeClose = fs.closeSync,
        nativeWrite = fs.writeSync;
      const directory = t.mock.method(fs, 'mkdtempSync', ((
        ...args: Parameters<typeof fs.mkdtempSync>
      ) => {
        const result = Reflect.apply(nativeDirectory, fs, args);
        directories.push(fs.realpathSync.native(String(result)));
        return result;
      }) as typeof fs.mkdtempSync);
      const random = t.mock.method(crypto, 'randomBytes', ((size: number) => {
        const result = nativeRandom(size);
        if (size === 32) keys.push(result);
        return result;
      }) as typeof crypto.randomBytes);
      const open = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
        const fd = Reflect.apply(nativeOpen, fs, args);
        descriptors.set(fd, String(args[0]));
        return fd;
      }) as typeof fs.openSync);
      const close = t.mock.method(fs, 'closeSync', (fd: number) => {
        descriptors.delete(fd);
        return nativeClose(fd);
      });
      let revoked = false,
        fired = false,
        callbacks = 0,
        reads = 0;
      const write = t.mock.method(fs, 'writeSync', ((...args: Parameters<typeof fs.writeSync>) => {
        const result = Reflect.apply(nativeWrite, fs, args),
          scope =
            mode === 'legacy I/O'
              ? directories[1]
              : mode === 'canonical I/O'
                ? directories[2]
                : undefined;
        if (!fired && scope && descriptors.get(args[0])?.startsWith(scope + '/')) {
          fired = true;
          revoked = true;
        }
        return result;
      }) as typeof fs.writeSync);
      syncBuiltinESMExports();
      const steps = validateIntakeCollectionGraphSteps(
        identity,
        f.head,
        (key) => {
          reads++;
          if (mode === 'source') {
            fired = true;
            revoked = true;
          }
          return f.rows.get(key);
        },
        () => {
          callbacks++;
          if (mode === 'callback' && callbacks === 10) {
            fired = true;
            revoked = true;
          }
          if (revoked) throw refusal;
        },
      );
      try {
        if (mode === 'yield') {
          assert.equal(steps.next().done, false);
          fired = true;
          revoked = true;
        }
        assert.throws(
          () => finishIntakeCopySteps(steps),
          (error) => error === refusal,
        );
        assert.equal(fired, true);
        assert.ok(keys.length >= 2 && keys.every((key) => key.every((byte) => byte === 0)));
        assert.ok(directories.every((path) => !fs.existsSync(path)));
        const readCount = reads;
        assert.equal(steps.next().done, true);
        assert.equal(reads, readCount);
        assert.deepEqual([...f.rows], before);
      } finally {
        write.mock.restore();
        close.mock.restore();
        open.mock.restore();
        random.mock.restore();
        directory.mock.restore();
        syncBuiltinESMExports();
        steps.return(undefined as never);
      }
    },
  );
