import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import fs, { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import {
  inspectIntakeCollectionGraphSteps,
  validateIntakeCollectionGraphSteps,
} from '../intake-state-graph.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import {
  COLLECTION_FORMAT,
  digest,
  intakeNamespace,
  type IntakeCollectionHeadV4,
  type IntakeStateIdentity,
  budget,
  frameIntakeChanges,
  limits,
  reconstructIntakeEvidence,
  type Head,
} from '../intake-state-evidence.ts';
import {
  applyIntakeChanges,
  serializeIntakeJson,
  type IntakeChange,
} from '../intake-state-codec.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { INTAKE_LEGACY_BRIDGE_CONTROL } from '../intake-state-migration.ts';
import { createIntakeTree, type IntakeTreeRoot } from '../intake-state-tree.ts';
import {
  initializeIntakeLog,
  rebuildIntakeLogSnapshot,
  disposeIntakeLogSnapshot,
  prepareIntakeLogAppend,
  inspectIntakeLogAppend,
  discardIntakeLogAppend,
  parseHead,
  intakeLogBaseHead,
  readIntakeLogSequence,
  type Event,
} from '../intake-state-log.ts';
import { parseIntakeCollectionReceipt } from '../intake-state-collections.ts';
import { IntakeEncryptedScratchCapacityError } from '../intake-encrypted-scratch.ts';
import {
  prepareIntakeStateCopySnapshot,
  disposeIntakeStateCopyPlan,
} from '../intake-state-bootstrap.ts';

const identity: IntakeStateIdentity = {
  profileId: 'fictional-log-source',
  intakeId: 'fictional-intake',
  sourceHash: 'a'.repeat(64),
};
const target = { ...identity, profileId: 'fictional-log-target' };
const ordered = (n: number) => String(n).padStart(16, '0');

function manifest(rows: Map<string, string>, scope = identity) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE source(key TEXT PRIMARY KEY,value TEXT NOT NULL,prefix TEXT NOT NULL);
    CREATE TABLE prepared(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE visited(key TEXT PRIMARY KEY); BEGIN;`);
  const prefix = intakeNamespace(scope);
  for (const [key, value] of rows)
    db.prepare('INSERT INTO source VALUES(?,?,?)').run(key, value, prefix);
  return {
    db,
    sourceValue(key: string, maxBytes: number) {
      const raw = db.prepare('SELECT value FROM source WHERE key=?').get(key)?.value;
      if (raw === undefined) return undefined;
      assert.ok(Buffer.byteLength(String(raw)) <= maxBytes);
      return String(raw);
    },
    put(table: 'source' | 'prepared', key: string, value: string) {
      assert.equal(table, 'prepared');
      db.prepare('INSERT INTO prepared VALUES(?,?)').run(key, value);
    },
    close: () => db.close(),
  };
}

async function fixture(v4Count = 2, inventories = false) {
  const nodes = new Map<string, string>();
  const get = (hash: string) => nodes.get(hash);
  let v4: IntakeCollectionHeadV4 | undefined;
  const operations: string[] = [];
  function graph(label: string, invalidBytes = false) {
    const tree = createIntakeTree(identity, get, new Map());
    const text = 'Independently fictional record ' + label;
    const members = tree.put(null, 'fictional-member', JSON.stringify({ kind: 'inline', text }));
    const root = tree.put(
      null,
      'fictional.records',
      JSON.stringify({
        kind: 'map',
        root: members,
        bytes: Buffer.byteLength(text) + Number(invalidBytes),
      }),
    );
    for (const write of tree.writes([root, members])) nodes.set(write.hash, write.raw);
    return root;
  }
  function inventoryBuild(sequence: number) {
    const tree = createIntakeTree(identity, get, new Map()),
      text = 'fictional payload ' + sequence;
    const payload = tree.put(null, 'member', JSON.stringify({ kind: 'inline', text }));
    const registry = tree.put(
      null,
      'fictional-inventory',
      JSON.stringify({ kind: 'inline', text: '{"fictional":true}' }),
    );
    let root = tree.put(
      null,
      'package.inventories',
      JSON.stringify({
        kind: 'map',
        root: registry,
        bytes: Buffer.byteLength('{"fictional":true}'),
      }),
    );
    root = tree.put(
      root,
      'payload',
      JSON.stringify({ kind: 'map', root: payload, bytes: Buffer.byteLength(text) }),
    );
    for (const write of tree.writes([root, payload, registry])) nodes.set(write.hash, write.raw);
    return root;
  }
  for (let sequence = 1; sequence <= v4Count; sequence++) {
    const tree = createIntakeTree(identity, get, new Map());
    const logical = { root: graph('base-' + sequence), domainVersion: sequence };
    const builds = inventories ? inventoryBuild(sequence) : graph('base-build-' + sequence);
    const operationId = randomUUID();
    operations.push(operationId);
    const result = {
      format: 'health-intake-state-result-v4',
      intakeId: identity.intakeId,
      operationId,
      storageSequence: sequence,
      logical,
      changed: true,
    };
    const receipts = tree.put(
      v4?.receipts ?? null,
      operationId,
      JSON.stringify({
        format: 'health-intake-state-receipt-v4',
        requestDigest: digest(operationId),
        result,
      }),
    );
    const history = tree.put(
      v4?.history ?? null,
      ordered(sequence),
      JSON.stringify({
        format: 'health-intake-state-history-v4',
        operationId,
        previous: v4 ?? null,
        logical,
        builds,
      }),
    );
    for (const write of tree.writes([receipts, history])) nodes.set(write.hash, write.raw);
    v4 = {
      format: COLLECTION_FORMAT,
      identity,
      storageSequence: sequence,
      logical,
      receipts,
      history,
      builds,
    };
  }
  const admission = {
    assertCurrent() {},
    lookupBaseOperation(base: Readonly<IntakeCollectionHeadV4>, operationId: string) {
      const raw = createIntakeTree(identity, get, new Map()).get(base.receipts, operationId);
      return raw === undefined
        ? { kind: 'absent' as const }
        : {
            kind: 'receipt' as const,
            identity,
            receipt: parseIntakeCollectionReceipt(raw, identity, operationId) as Event['receipt'],
          };
    },
  };
  const initialized = initializeIntakeLog(identity, v4 ? JSON.stringify(v4) : undefined);
  for (const write of initialized.writes) nodes.set(write.hash, write.raw);
  let head = initialized.head;
  async function append(logicalRoot: IntakeTreeRoot, builds = graph('suffix-build')) {
    const previous = parseHead(head, identity);
    const logical = { root: logicalRoot, domainVersion: previous.logical.domainVersion + 1 };
    const operationId = randomUUID();
    const event: Event = {
      receipt: {
        format: 'health-intake-state-receipt-v4',
        requestDigest: digest(operationId),
        result: {
          format: 'health-intake-state-result-v4',
          intakeId: identity.intakeId,
          operationId,
          storageSequence: previous.storageSequence + 1,
          logical,
          changed: JSON.stringify(previous.logical.root) !== JSON.stringify(logicalRoot),
        },
      },
      transition: {
        format: 'health-intake-state-log-transition-v1',
        operationId,
        previous,
        logical,
        builds,
      },
    };
    const snapshot = await rebuildIntakeLogSnapshot(head, identity, get, admission);
    try {
      const pending = prepareIntakeLogAppend(snapshot, event, admission);
      const prepared = inspectIntakeLogAppend(pending);
      for (const write of prepared.writes) nodes.set(write.hash, write.raw);
      head = prepared.head;
      discardIntakeLogAppend(pending);
      operations.push(operationId);
    } finally {
      disposeIntakeLogSnapshot(snapshot);
    }
  }
  const rows = () =>
    new Map([
      ...[...nodes].map(
        ([hash, raw]) => [intakeNamespace(identity) + 'node:' + hash, raw] as const,
      ),
      [intakeNamespace(identity) + 'head', head] as const,
    ]);
  return {
    nodes,
    get,
    graph,
    inventoryBuild,
    append,
    rows,
    operations,
    get head() {
      return head;
    },
  };
}

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

function observeEncryptedScratch(t: TestContext) {
  const directories: string[] = [],
    paths = new Set<string>(),
    keys: Buffer[] = [],
    mkdtemp = fs.mkdtempSync,
    open = fs.openSync,
    random = crypto.randomBytes;
  const directoryMock = t.mock.method(fs, 'mkdtempSync', ((
    ...args: Parameters<typeof fs.mkdtempSync>
  ) => {
    const directory = Reflect.apply(mkdtemp, fs, args);
    directories.push(fs.realpathSync.native(String(directory)));
    return directory;
  }) as typeof fs.mkdtempSync);
  const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    paths.add(String(args[0]));
    return Reflect.apply(open, fs, args);
  }) as typeof fs.openSync);
  const randomMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  return {
    directories,
    paths,
    keys,
    assertClosed() {
      assert.ok(directories.length > 0);
      assert.ok(directories.every((directory) => !existsSync(directory)));
      assert.ok(keys.length > 0 && keys.every((key) => key.every((byte) => byte === 0)));
    },
    restore() {
      directoryMock.mock.restore();
      openMock.mock.restore();
      randomMock.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test('actual tagged V3 graph validation encrypts transitive raw canonical fallback under V4 and V5', async (t) => {
  const sentinel = 'INDEPENDENTLY_FICTIONAL_GRAPH_RAW_SENTINEL_141';
  for (const v5 of [false, true]) {
    const f = await legacyFixture(v5, sentinel.repeat(3300)),
      before = [...f.rows],
      source = manifest(f.rows),
      observed = observeEncryptedScratch(t);
    let represented = false;
    try {
      finishIntakeCopySteps(
        inspectIntakeCollectionGraphSteps(
          source,
          identity,
          f.head,
          undefined,
          () => {},
          function* (head, legacy) {
            assert.equal(head.logical.domainVersion, 7);
            assert.ok(legacy);
            assert.equal(legacy.work.fallbackDeltaPreparations, 1);
            assert.equal([...legacy.pieces()].join(''), f.serialized);
            assert.equal([...legacy.envelopePieces()].join(''), f.raw);
            assert.equal(
              (yield* legacy.validateEnvelopeSteps(f.initial.detailsJson)).domainVersion,
              7,
            );
            assert.deepEqual(
              new Set(legacy.consumed()),
              new Set(
                [...f.rows.keys()].filter(
                  (key) =>
                    key.includes(':frame:') || key.includes(':operation:') || key.endsWith(':head'),
                ),
              ),
            );
            assert.equal(
              observed.directories.length,
              3,
              'graph, legacy and canonical have fixed separate invocations',
            );
            assert.equal(observed.keys.length, 6);
            assert.ok(observed.paths.size > 0);
            for (const path of observed.paths) {
              assert.match(path, /intake-encrypted-scratch-[^/]+\/cells\/[a-f0-9]+$/);
              assert.equal(fs.readFileSync(path).includes(Buffer.from(sentinel)), false);
            }
            represented = true;
          },
        ),
      );
      assert.equal(represented, true);
      assert.equal(
        Number(source.db.prepare('SELECT count(*) n FROM visited').get()!.n),
        f.rows.size,
      );
      observed.assertClosed();
      assert.deepEqual([...f.rows], before);
    } finally {
      observed.restore();
      source.close();
    }
  }
});

test('tagged legacy graph profile copy preserves raw representation and historical no-op through V4 and V5', async () => {
  for (const v5 of [false, true]) {
    const f = await legacyFixture(v5),
      before = [...f.rows],
      source = manifest(f.rows);
    try {
      finishIntakeCopySteps(
        inspectIntakeCollectionGraphSteps(source, identity, f.head, target.profileId),
      );
      const copied = new Map(
          source.db
            .prepare('SELECT key,value FROM prepared')
            .all()
            .map((row) => [String(row.key), String(row.value)]),
        ),
        raw = copied.get(intakeNamespace(target) + 'head')!,
        get = (hash: string) => copied.get(intakeNamespace(target) + 'node:' + hash),
        base = v5
          ? intakeLogBaseHead(parseHead(raw, target), target, get)!
          : (JSON.parse(raw) as IntakeCollectionHeadV4),
        tree = createIntakeTree(target, get, new Map()),
        bridge = JSON.parse(tree.get(base.history, ordered(1))!),
        legacy = bridge.previous.head as Head,
        recovered = reconstructIntakeEvidence(target, limits(), legacy, (key) => copied.get(key));
      assert.equal(bridge.previous.format, 'health-intake-legacy-v3');
      assert.equal(recovered.serialized, f.serialized);
      assert.equal(legacy.version, f.legacy.version);
      assert.deepEqual(legacy.usage, f.legacy.usage);
      for (const [key, text] of copied) {
        assert.ok(key.startsWith(intakeNamespace(target)));
        if (key.includes(':operation:')) {
          const result = JSON.parse(text).result;
          assert.equal(result.changed, result.version === 1);
          assert.equal(
            f.rows.has(key.replace(intakeNamespace(target), intakeNamespace(identity))),
            false,
          );
        }
      }
      const destination = manifest(copied, target);
      let represented = false;
      try {
        finishIntakeCopySteps(
          inspectIntakeCollectionGraphSteps(
            destination,
            target,
            raw,
            undefined,
            () => {},
            function* (_head, replay) {
              assert.ok(replay);
              assert.equal([...replay.envelopePieces()].join(''), f.raw);
              assert.equal(
                (yield* replay.validateEnvelopeSteps(f.initial.detailsJson)).domainVersion,
                7,
              );
              represented = true;
            },
          ),
        );
        assert.equal(represented, true);
        assert.equal(
          Number(destination.db.prepare('SELECT count(*) n FROM visited').get()!.n),
          copied.size,
        );
      } finally {
        destination.close();
      }
      assert.deepEqual([...f.rows], before);
    } finally {
      source.close();
    }
  }
});

test('actual tagged legacy graph cancels or returns with all three encrypted invocations closed', async (t) => {
  const f = await legacyFixture(true);
  for (const mode of ['session', 'head', 'return'] as const) {
    const observed = observeEncryptedScratch(t),
      before = [...f.rows],
      refusal = Object.assign(Error('fictional graph ' + mode + ' refusal'), {
        code: mode === 'session' ? 'SESSION_REVOKED' : 'HEAD_CHANGED',
      });
    let current = true;
    const steps = validateIntakeCollectionGraphSteps(
      identity,
      f.head,
      (key) => f.rows.get(key),
      () => {
        if (!current || f.rows.get(intakeNamespace(identity) + 'head') !== f.head) throw refusal;
      },
    );
    try {
      while (observed.keys.length < 6) assert.equal(steps.next().done, false);
      assert.equal(observed.directories.length, 3);
      if (mode === 'return') steps.return();
      else {
        if (mode === 'session') current = false;
        else
          f.rows.set(
            intakeNamespace(identity) + 'head',
            JSON.stringify({ ...JSON.parse(f.head), fictionalChangedHead: true }),
          );
        assert.throws(
          () => finishIntakeCopySteps(steps),
          (error) => error === refusal,
        );
      }
      observed.assertClosed();
      assert.equal(steps.next().done, true);
      if (mode === 'head') f.rows.set(intakeNamespace(identity) + 'head', f.head);
      assert.deepEqual([...f.rows], before);
    } finally {
      steps.return();
      f.rows.set(intakeNamespace(identity) + 'head', f.head);
      observed.restore();
    }
  }
});

test('graph representation callback cannot escape session revocation or a restored HEAD generation', async (t) => {
  const f = await legacyFixture(true),
    before = [...f.rows];
  for (const mode of ['session', 'restored-head'] as const) {
    const source = manifest(f.rows),
      observed = observeEncryptedScratch(t),
      refusal = Object.assign(Error('fictional callback authority refusal'), {
        code: mode === 'session' ? 'SESSION_REVOKED' : 'HEAD_CHANGED',
      });
    let active = true,
      generation = 0,
      callbackReturned = false;
    try {
      assert.throws(
        () =>
          finishIntakeCopySteps(
            inspectIntakeCollectionGraphSteps(
              source,
              identity,
              f.head,
              undefined,
              () => {
                if (
                  !active ||
                  generation !== 0 ||
                  f.rows.get(intakeNamespace(identity) + 'head') !== f.head
                )
                  throw refusal;
              },
              function* (_head, legacy) {
                assert.ok(legacy);
                assert.equal(legacy.domainVersion(), 7);
                yield;
                if (mode === 'session') active = false;
                else {
                  const key = intakeNamespace(identity) + 'head';
                  f.rows.set(key, 'fictional intervening HEAD');
                  generation++;
                  f.rows.set(key, f.head);
                }
                callbackReturned = true;
              },
            ),
          ),
        (error) => error === refusal,
      );
      assert.equal(callbackReturned, true, 'the owner seals after the external generator returns');
      assert.equal(observed.keys.length, 6);
      observed.assertClosed();
      assert.equal(Number(source.db.prepare('SELECT count(*) n FROM prepared').get()!.n), 0);
      assert.deepEqual([...f.rows], before);
    } finally {
      observed.restore();
      source.close();
    }
  }
});

test('actual tagged legacy graph internal ciphertext failure revokes sibling scopes and permits fresh retry', async (t) => {
  const f = await legacyFixture(false),
    before = [...f.rows],
    source = manifest(f.rows),
    observed = observeEncryptedScratch(t);
  try {
    assert.throws(
      () =>
        finishIntakeCopySteps(
          inspectIntakeCollectionGraphSteps(
            source,
            identity,
            f.head,
            undefined,
            () => {},
            function* (_head, legacy) {
              assert.ok(legacy);
              assert.equal(observed.directories.length, 3);
              for (const path of observed.paths) fs.rmSync(path, { force: true });
              yield* legacy.domainVersionSteps();
            },
          ),
        ),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'kind') === 'integrity',
    );
    observed.assertClosed();
    assert.deepEqual([...f.rows], before);
  } finally {
    observed.restore();
    source.close();
  }
  finishIntakeCopySteps(
    validateIntakeCollectionGraphSteps(
      identity,
      f.head,
      (key) => f.rows.get(key),
      () => {},
    ),
  );
  assert.deepEqual([...f.rows], before);
});

test('graph cleanup preserves every primary refusal and surfaces cleanup-only failure while erasing all six keys', async (t) => {
  const f = await legacyFixture(true),
    before = [...f.rows],
    nativeRm = fs.rmSync;
  for (const mode of [
    'session',
    'integrity',
    'undefined',
    'false',
    'zero',
    'null',
    'success',
    'return',
  ] as const) {
    const source = manifest(f.rows),
      observed = observeEncryptedScratch(t),
      session = Object.assign(Error('fictional primary session refusal'), {
        code: 'SESSION_REVOKED',
      }),
      cleanup = Object.assign(Error('fictional directory cleanup refused'), { code: 'EACCES' }),
      attempts = new Set<string>();
    let armed = false,
      ready = false,
      revoked = false;
    const mock = t.mock.method(fs, 'rmSync', ((...args: Parameters<typeof fs.rmSync>) => {
      if (armed && observed.directories.includes(String(args[0]))) {
        attempts.add(String(args[0]));
        throw cleanup;
      }
      return Reflect.apply(nativeRm, fs, args);
    }) as typeof fs.rmSync);
    syncBuiltinESMExports();
    const primary =
        mode === 'session'
          ? session
          : mode === 'false'
            ? false
            : mode === 'zero'
              ? 0
              : mode === 'null'
                ? null
                : undefined,
      steps = inspectIntakeCollectionGraphSteps(
        source,
        identity,
        f.head,
        undefined,
        () => {
          if (revoked) throw session;
        },
        function* (_head, legacy) {
          assert.ok(legacy);
          ready = true;
          yield;
          if (mode === 'integrity') {
            for (const path of observed.paths)
              if (path.startsWith(observed.directories[1]! + '/cells/'))
                nativeRm(path, { force: true });
            yield* legacy.domainVersionSteps();
          } else if (!['session', 'success', 'return'].includes(mode)) throw primary;
        },
      );
    try {
      while (!ready) assert.equal(steps.next().done, false);
      assert.equal(observed.keys.length, 6);
      armed = true;
      revoked = mode === 'session';
      let threw = false,
        caught: unknown;
      try {
        if (mode === 'return') steps.return();
        else finishIntakeCopySteps(steps);
      } catch (error) {
        threw = true;
        caught = error;
      }
      assert.equal(threw, true, mode);
      if (mode === 'integrity') {
        assert.equal(Reflect.get(caught as object, 'kind'), 'integrity');
        assert.notEqual(caught, cleanup);
      } else
        assert.equal(caught, mode === 'success' || mode === 'return' ? cleanup : primary, mode);
      assert.equal(attempts.size, 3, 'legacy, canonical and graph cleanup are all attempted');
      assert.ok(observed.keys.every((key) => key.every((byte) => byte === 0)));
      assert.deepEqual([...f.rows], before);
      assert.equal(steps.next().done, true);
    } finally {
      armed = false;
      try {
        steps.return();
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
        for (const directory of observed.directories)
          nativeRm(directory, { recursive: true, force: true });
        observed.assertClosed();
        observed.restore();
        source.close();
      }
    }
  }
});

test('mixed V4 anchor and V5 suffix validate every retained graph and rebind exact history', async () => {
  const f = await fixture();
  await f.append(f.graph('suffix-1'));
  await f.append(f.graph('suffix-2'));
  const source = manifest(f.rows());
  try {
    finishIntakeCopySteps(
      inspectIntakeCollectionGraphSteps(source, identity, f.head, target.profileId),
    );
    assert.equal(
      Number(source.db.prepare('SELECT count(*) n FROM visited').get()!.n),
      f.rows().size,
    );
    const copied = new Map(
      source.db
        .prepare('SELECT key,value FROM prepared')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
    const rawHead = copied.get(intakeNamespace(target) + 'head')!;
    const destination = manifest(copied, target);
    try {
      finishIntakeCopySteps(inspectIntakeCollectionGraphSteps(destination, target, rawHead));
      assert.equal(
        Number(destination.db.prepare('SELECT count(*) n FROM visited').get()!.n),
        copied.size,
      );
    } finally {
      destination.close();
    }
    const get = (hash: string) => copied.get(intakeNamespace(target) + 'node:' + hash);
    const head = parseHead(rawHead, target);
    const base = intakeLogBaseHead(head, target, get)!;
    const tree = createIntakeTree(target, get, new Map());
    assert.equal(base.storageSequence, 2);
    for (let sequence = 1; sequence <= 2; sequence++) {
      const event = JSON.parse(tree.get(base.history, ordered(sequence))!);
      assert.equal(event.operationId, f.operations[sequence - 1]);
      const receipt = JSON.parse(tree.get(base.receipts, event.operationId)!);
      assert.equal(receipt.result.storageSequence, sequence);
      if (event.previous) assert.equal(event.previous.identity.profileId, target.profileId);
    }
    for (let sequence = 3; sequence <= 4; sequence++) {
      const event = readIntakeLogSequence(rawHead, target, get, sequence, { assertCurrent() {} });
      assert.equal(event.receipt.result.operationId, f.operations[sequence - 1]);
      assert.equal(event.transition.previous.identity.profileId, target.profileId);
    }
    for (const [key, raw] of copied) {
      assert.ok(key.startsWith(intakeNamespace(target)));
      assert.equal(JSON.parse(raw).identity.profileId, target.profileId);
    }
    assert.throws(
      () => finishIntakeCopySteps(inspectIntakeCollectionGraphSteps(source, target, f.head)),
      /identity/,
    );
  } finally {
    source.close();
  }
});

test('cold graph admission refuses rehashed invalid historical logical and build graphs', async () => {
  for (const kind of ['logical', 'builds'] as const) {
    const f = await fixture();
    const invalid = f.graph('invalid-' + kind, true);
    await f.append(
      kind === 'logical' ? invalid : f.graph('valid'),
      kind === 'builds' ? invalid : undefined,
    );
    await f.append(f.graph('latest'));
    assert.throws(
      () =>
        finishIntakeCopySteps(
          validateIntakeCollectionGraphSteps(
            identity,
            f.head,
            (key) => f.rows().get(key),
            () => {},
          ),
        ),
      /collection byte summary/,
    );
  }
});

test('exact recovery inventory refuses an unselected valid row and a disconnected log row', async () => {
  for (const kind of ['tree', 'log'] as const) {
    const f = await fixture();
    await f.append(f.graph('selected'));
    if (kind === 'tree') f.graph('unselected');
    else {
      const extra = initializeIntakeLog(
        identity,
        JSON.stringify(intakeLogBaseHead(parseHead(f.head, identity), identity, f.get)),
      );
      const raw = JSON.parse(extra.writes[0]!.raw);
      // A distinct valid anchor commits a different V4 selection. It is not
      // reachable from the selected V5 head and cannot join recovery inventory.
      raw.v4Head = JSON.stringify({ ...JSON.parse(raw.v4Head), builds: null });
      const encoded = JSON.stringify(raw);
      f.nodes.set(digest(encoded), encoded);
    }
    const source = manifest(f.rows());
    try {
      assert.throws(
        () => finishIntakeCopySteps(inspectIntakeCollectionGraphSteps(source, identity, f.head)),
        /unselected copy contribution/,
      );
    } finally {
      source.close();
    }
  }
});

test('encrypted graph admission cooperatively aborts and never reads after closure', async () => {
  const f = await fixture();
  await f.append(f.graph('suffix'));
  let reads = 0;
  const steps = validateIntakeCollectionGraphSteps(
    identity,
    f.head,
    (key) => {
      reads++;
      return f.rows().get(key);
    },
    () => {},
  );
  assert.equal(steps.next().done, false);
  steps.return();
  const before = reads;
  assert.equal(steps.next().done, true);
  assert.equal(reads, before);
});

test('native V5 without an anchor preserves every suffix event through profile rebinding', async () => {
  const f = await fixture(0);
  await f.append(f.graph('native-one'));
  await f.append(f.graph('native-two'));
  const source = manifest(f.rows());
  try {
    finishIntakeCopySteps(
      inspectIntakeCollectionGraphSteps(source, identity, f.head, target.profileId),
    );
    const copied = new Map(
      source.db
        .prepare('SELECT key,value FROM prepared')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
    const raw = copied.get(intakeNamespace(target) + 'head')!;
    assert.equal(parseHead(raw, target).base, null);
    const destination = manifest(copied, target);
    try {
      finishIntakeCopySteps(inspectIntakeCollectionGraphSteps(destination, target, raw));
    } finally {
      destination.close();
    }
    for (let sequence = 1; sequence <= 2; sequence++)
      assert.equal(
        readIntakeLogSequence(
          raw,
          target,
          (hash) => copied.get(intakeNamespace(target) + 'node:' + hash),
          sequence,
          { assertCurrent() {} },
        ).receipt.result.operationId,
        f.operations[sequence - 1],
      );
  } finally {
    source.close();
  }
});

test('cold validation requires a historical V4 build root even after the suffix replaces it', async () => {
  const f = await fixture();
  const base = intakeLogBaseHead(parseHead(f.head, identity), identity, f.get)!;
  const first = JSON.parse(
    createIntakeTree(identity, f.get, new Map()).get(base.history, ordered(1))!,
  );
  await f.append(f.graph('new-final'));
  f.nodes.delete(first.builds.hash);
  assert.throws(
    () =>
      finishIntakeCopySteps(
        validateIntakeCollectionGraphSteps(
          identity,
          f.head,
          (key) => f.rows().get(key),
          () => {},
        ),
      ),
    /encoded bytes/,
  );
});

test('canonical V4 indexes reject conflicting history, receipt and future historical evidence', async () => {
  for (const fault of ['history', 'receipt', 'future', 'duplicate-operation'] as const) {
    const f = await fixture(3),
      base = intakeLogBaseHead(parseHead(f.head, identity), identity, f.get)!,
      tree = createIntakeTree(identity, f.get, new Map());
    const last = JSON.parse(tree.get(base.history, ordered(3))!),
      previous = last.previous as IntakeCollectionHeadV4;
    if (fault === 'history') {
      const first = JSON.parse(tree.get(previous.history, ordered(1))!);
      previous.history = tree.put(
        previous.history,
        ordered(1),
        JSON.stringify({ ...first, builds: null }),
      );
    } else if (fault === 'receipt') {
      const raw = JSON.parse(tree.get(previous.receipts, f.operations[0])!);
      previous.receipts = tree.put(
        previous.receipts,
        f.operations[0],
        JSON.stringify({ ...raw, requestDigest: 'f'.repeat(64) }),
      );
    } else if (fault === 'future') {
      previous.receipts = tree.put(previous.receipts, f.operations[0], null);
      previous.receipts = tree.put(
        previous.receipts,
        f.operations[2],
        tree.get(base.receipts, f.operations[2])!,
      );
    }
    let selectedHistory = tree.put(base.history, ordered(3), JSON.stringify(last));
    if (fault === 'duplicate-operation') {
      const second = JSON.parse(tree.get(base.history, ordered(2))!);
      selectedHistory = tree.put(
        selectedHistory,
        ordered(2),
        JSON.stringify({ ...second, operationId: f.operations[0] }),
      );
    }
    for (const node of tree.writes([selectedHistory, previous.receipts, previous.history]))
      f.nodes.set(node.hash, node.raw);
    const raw = JSON.stringify({ ...base, history: selectedHistory });
    assert.throws(
      () =>
        finishIntakeCopySteps(
          validateIntakeCollectionGraphSteps(
            identity,
            raw,
            (key) => f.rows().get(key),
            () => {},
          ),
        ),
      fault === 'history'
        ? /conflicting historical transition/
        : fault === 'receipt'
          ? /conflicting historical receipt/
          : fault === 'future'
            ? /historical future evidence/
            : /receipt history agreement|conflicting historical transition/,
    );
  }
});

test('graph scratch closes on generator return, cancellation and invalid graph rejection', async (t) => {
  const f = await fixture(),
    original = fs.mkdtempSync,
    directories: string[] = [];
  const mock = t.mock.method(fs, 'mkdtempSync', ((...args: Parameters<typeof fs.mkdtempSync>) => {
    const directory = Reflect.apply(original, fs, args);
    if (String(args[0]).includes('intake-encrypted-scratch-'))
      directories.push(fs.realpathSync.native(String(directory)));
    return directory;
  }) as typeof fs.mkdtempSync);
  syncBuiltinESMExports();
  try {
    for (const mode of ['return', 'cancel', 'invalid']) {
      let revoked = false;
      const refusal = Error('fictional graph cancellation');
      const steps = validateIntakeCollectionGraphSteps(
        identity,
        f.head,
        (key) => (mode === 'invalid' ? undefined : f.rows().get(key)),
        () => {
          if (revoked) throw refusal;
        },
      );
      if (mode === 'invalid') assert.throws(() => finishIntakeCopySteps(steps));
      else {
        assert.equal(steps.next().done, false);
        assert.ok(existsSync(directories.at(-1)!));
        if (mode === 'return') steps.return();
        else {
          revoked = true;
          assert.throws(
            () => steps.next(),
            (error: unknown) => error === refusal,
          );
        }
      }
      assert.ok(directories.length > 0);
      assert.ok(directories.every((directory) => !existsSync(directory)));
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('graph scratch capacity refusal cleans partial writes and permits exact-input retry', async (t) => {
  const f = await fixture();
  await f.append(f.graph('capacity-retry'));
  const before = [...f.rows()],
    directories: string[] = [],
    nativeMkdtemp = fs.mkdtempSync,
    nativeOpen = fs.openSync;
  let writes = 0;
  const directoryMock = t.mock.method(fs, 'mkdtempSync', ((
    ...args: Parameters<typeof fs.mkdtempSync>
  ) => {
    const directory = Reflect.apply(nativeMkdtemp, fs, args);
    if (String(args[0]).includes('intake-encrypted-scratch-'))
      directories.push(fs.realpathSync.native(String(directory)));
    return directory;
  }) as typeof fs.mkdtempSync);
  const refusal = Object.assign(Error('fictional graph scratch capacity'), { code: 'ENOSPC' });
  const openMock = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (
      directories.some((directory) => String(args[0]).startsWith(directory + '/cells/')) &&
      typeof args[1] === 'number' &&
      (args[1] & fs.constants.O_CREAT) !== 0 &&
      ++writes === 4
    )
      throw refusal;
    return Reflect.apply(nativeOpen, fs, args);
  });
  syncBuiltinESMExports();
  const validate = () =>
    finishIntakeCopySteps(
      validateIntakeCollectionGraphSteps(
        identity,
        f.head,
        (key) => f.rows().get(key),
        () => {},
      ),
    );
  try {
    assert.throws(
      validate,
      (error: unknown) =>
        error instanceof IntakeEncryptedScratchCapacityError &&
        error.code === 'ENOSPC' &&
        error.cause === refusal,
    );
    assert.equal(writes, 4, 'refusal follows actual partial encrypted graph writes');
    assert.equal(directories.length, 1);
    assert.ok(directories.every((directory) => !existsSync(directory)));
    assert.deepEqual([...f.rows()], before, 'capacity cannot change selected graph input');
    openMock.mock.restore();
    syncBuiltinESMExports();
    validate();
    assert.equal(directories.length, 2, 'retry creates a fresh scratch invocation');
    assert.ok(directories.every((directory) => !existsSync(directory)));
    assert.deepEqual([...f.rows()], before);
  } finally {
    openMock.mock.restore();
    directoryMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('shared inventory bytes rebind against each historical build directory context', async () => {
  const f = await fixture(2, true);
  await f.append(f.graph('inventory-suffix'), f.inventoryBuild(3));
  const source = manifest(f.rows());
  try {
    finishIntakeCopySteps(
      inspectIntakeCollectionGraphSteps(
        source,
        identity,
        f.head,
        target.profileId,
        () => {},
        undefined,
        (text, _key, sourceCollection, rebindDescriptor) => {
          const payload = sourceCollection('payload');
          assert.ok(payload);
          return JSON.stringify({ ...JSON.parse(text), payload: rebindDescriptor(payload) });
        },
      ),
    );
    const copied = new Map(
        source.db
          .prepare('SELECT key,value FROM prepared')
          .all()
          .map((row) => [String(row.key), String(row.value)]),
      ),
      raw = copied.get(intakeNamespace(target) + 'head')!,
      get = (hash: string) => copied.get(intakeNamespace(target) + 'node:' + hash),
      base = intakeLogBaseHead(parseHead(raw, target), target, get)!,
      tree = createIntakeTree(target, get, new Map());
    const builds = [1, 2].map(
      (sequence) => JSON.parse(tree.get(base.history, ordered(sequence))!).builds as IntakeTreeRoot,
    );
    builds.push(
      readIntakeLogSequence(raw, target, get, 3, { assertCurrent() {} }).transition.builds,
    );
    const payloadHashes: string[] = [];
    for (const root of builds) {
      const registry = JSON.parse(tree.get(root, 'package.inventories')!),
        payload = JSON.parse(tree.get(root, 'payload')!),
        item = JSON.parse(tree.get(registry.root, 'fictional-inventory')!),
        inventory = JSON.parse(item.text);
      assert.deepEqual(inventory.payload, payload);
      payloadHashes.push(payload.root.hash);
    }
    assert.equal(new Set(payloadHashes).size, 3);
    assert.equal(
      source.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'graph_%' LIMIT 1").get(),
      undefined,
    );
  } finally {
    source.close();
  }
});

test('bootstrap dispatches exact V5 identity and refuses unsupported format relabeling', async () => {
  const f = await fixture();
  await f.append(f.graph('bootstrap'));
  const snapshot = {
    sourceProfileId: identity.profileId,
    originals: [
      {
        id: identity.intakeId,
        kind: 'intake_original',
        sha256: identity.sourceHash,
        path: `data/profiles/${identity.profileId}/sources/fictional.txt`,
        detailsJson: '{}',
        sourcePin: null,
        preserved: {
          provider_id: null,
          bytes: 0,
          mime_type: 'text/plain',
          coverage_status: 'unknown',
          batch_id: null,
        },
      },
    ],
    rows: [...f.rows()].map(([key, value]) => ({ key, value })),
  };
  const plan = prepareIntakeStateCopySnapshot(snapshot, target.profileId);
  try {
    assert.ok(plan.counters.preparedRows > 0);
    assert.ok(plan.counters.preparedNodeBytes > 0);
  } finally {
    disposeIntakeStateCopyPlan(plan);
  }
  const relabeled = structuredClone(snapshot);
  const row = relabeled.rows.find((row) => row.key.endsWith(':head'))!;
  row.value = JSON.stringify({ ...JSON.parse(row.value), format: COLLECTION_FORMAT });
  assert.throws(
    () => prepareIntakeStateCopySnapshot(relabeled, target.profileId),
    /Invalid intake state/,
  );
});
