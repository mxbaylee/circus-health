import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  applyIntakeChanges,
  serializeIntakeJson,
  type IntakeChange,
  type IntakeJson,
} from '../intake-state-codec.ts';
import {
  limits,
  budget,
  frameIntakeChanges,
  reconstructIntakeEvidence,
  intakeNamespace,
  CHUNK_BYTES,
  type Head,
  type Frame,
  type Reference,
} from '../intake-state-evidence.ts';
import { prepareIntakeLegacyReplay } from '../intake-state-legacy-replay.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { intakeCopyTrimmedPieces } from '../intake-copy-json.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';
import {
  LEGACY_NATIVE_DELTA_BYTES,
  prepareIntakeLegacyDeltaTreeSteps,
} from '../intake-legacy-delta-tree.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import type {
  PreparedIntakeJsonCanonical,
  PreparedIntakeJsonTree,
  IntakeJsonCanonicalHandle,
} from '../intake-json-canonical.ts';

function* deltaPieces(
  tree: PreparedIntakeJsonTree,
  handle: IntakeJsonCanonicalHandle = tree.root,
): Generator<string> {
  const kind = tree.kind(handle);
  if (kind !== 'array' && kind !== 'object') {
    yield* tree.pieces(handle);
    return;
  }
  yield kind === 'array' ? '[' : '{';
  let first = true;
  if (kind === 'array')
    for (const child of tree.arrayItems(handle)) {
      if (!first) yield ',';
      first = false;
      yield* deltaPieces(tree, child);
    }
  else
    for (const field of tree.objectFields(handle)) {
      if (!first) yield ',';
      first = false;
      yield* field.name();
      yield ':';
      yield* deltaPieces(tree, field.value);
    }
  yield kind === 'array' ? ']' : '}';
}

function deltaTree(text: string, width = 19, checkpoint = () => {}) {
  let native: boolean | undefined,
    returned = 0,
    returnCalls = 0;
  const source = (function* () {
    try {
      for (let at = 0; at < text.length; at += width) yield text.slice(at, at + width);
    } finally {
      returned++;
    }
  })();
  const tree = finishIntakeCopySteps(
    prepareIntakeLegacyDeltaTreeSteps(
      {
        [Symbol.iterator]() {
          return {
            next: () => source.next(),
            return() {
              returnCalls++;
              return source.return();
            },
          };
        },
      },
      checkpoint,
      (value) => {
        native = value;
      },
    ),
  );
  return { tree, native, returned, returnCalls };
}

test('bounded native delta trees preserve exact bytes, handles and fallback eligibility', () => {
  const exact = JSON.stringify({
    '2': -0,
    op: 'fictional',
    text: 'Fictional \\" \u0000\ud800\udc00\ud800\udc00',
    data: [null, true, false, 1e-9, Number.MAX_SAFE_INTEGER],
    unknown: { retained: 'fictional' },
  });
  const f = deltaTree(exact);
  try {
    assert.equal(f.native, true);
    assert.equal(f.returned, 1);
    assert.equal(f.returnCalls, 1);
    const native = f.tree as PreparedIntakeJsonCanonical;
    assert.equal([...native.chunks()].join(''), exact);
    assert.equal([...deltaPieces(f.tree)].join(''), exact);
    assert.equal(f.tree.work.sqliteCalls, 0);
    const split = native.splitObjectField(f.tree.root, 'text')!;
    assert.throws(() => f.tree.field(split.value, 'text'), /JSON field requires object/);
    assert.throws(
      () => [...f.tree.objectFields(split.value)],
      /JSON field iteration requires object/,
    );
    assert.throws(() => [...f.tree.arrayItems(f.tree.root)], /JSON array iteration requires array/);
    assert.equal(
      [...split.before(), ...f.tree.pieces(split.value), ...split.after()].join(''),
      exact,
    );
    assert.equal(f.tree.field(f.tree.root, 'constructor'), undefined);
    assert.equal(f.tree.field(f.tree.root, '__proto__'), undefined);
    for (const member of f.tree.objectFields(f.tree.root)) {
      const name = JSON.parse([...member.name()].join('')) as string;
      assert.equal(member.matches(name), true);
      assert.equal(member.matches(name + '\u0000'), false);
    }
    const other = deltaTree('[1]');
    try {
      assert.throws(() => f.tree.kind(other.tree.root), /Foreign/);
    } finally {
      other.tree.close();
    }
  } finally {
    f.tree.close();
  }
  assert.throws(() => f.tree.kind(f.tree.root), /closed/);
  for (const text of ['[1.0,-0,1e0]', '{"op":1,"op":2}', '{"2":2,"1":1}', '["\\u0061"]', ' [1] ']) {
    const fallback = deltaTree(text);
    try {
      assert.equal(fallback.native, false, text);
      assert.ok(fallback.tree.work.sqliteCalls > 0);
    } finally {
      fallback.tree.close();
    }
  }
});

test('native delta byte node and depth bounds retain the original streaming path', () => {
  for (const [text, expected] of [
    [JSON.stringify('x'.repeat(LEGACY_NATIVE_DELTA_BYTES - 2)), true],
    [JSON.stringify('x'.repeat(LEGACY_NATIVE_DELTA_BYTES - 1)), false],
    [JSON.stringify(Array(8191).fill(0)), true],
    [JSON.stringify(Array(8192).fill(0)), false],
    ['['.repeat(96) + '0' + ']'.repeat(96), true],
    ['['.repeat(97) + '0' + ']'.repeat(97), false],
    [JSON.stringify('fictional'.repeat(20000)), false],
  ] as const) {
    const f = deltaTree(text, 1031);
    try {
      assert.equal(f.native, expected, `${text.length} units`);
      assert.equal([...deltaPieces(f.tree)].join(''), text);
      assert.equal(f.returned, 1);
      assert.equal(f.returnCalls, 1);
    } finally {
      f.tree.close();
    }
  }
  for (const width of [1, 2048]) {
    for (const [text, expected] of [
      [JSON.stringify('🌿'.repeat((LEGACY_NATIVE_DELTA_BYTES - 4) / 4) + 'xy'), true],
      [JSON.stringify('🌿'.repeat((LEGACY_NATIVE_DELTA_BYTES - 4) / 4) + 'xyz'), false],
    ] as const) {
      assert.equal(Buffer.byteLength(text), LEGACY_NATIVE_DELTA_BYTES + (expected ? 0 : 1));
      const f = deltaTree(text, width);
      try {
        assert.equal(f.native, expected, `UTF-8 byte boundary with ${width}-unit pieces`);
        assert.equal([...deltaPieces(f.tree)].join(''), text);
      } finally {
        f.tree.close();
      }
    }
  }
});

test('native delta chunks keep surrogate pairs intact and malformed frame UTF-8 still refuses', () => {
  const text = JSON.stringify('🌿'.repeat(2048)),
    delta = deltaTree(text, 1);
  try {
    assert.equal(delta.native, true);
    const digest = createHash('sha256');
    for (const piece of (delta.tree as PreparedIntakeJsonCanonical).chunks()) digest.update(piece);
    assert.equal(digest.digest('hex'), hash(text));
  } finally {
    delta.tree.close();
  }
  const f = fixture([[{ op: 'set', path: [], value: { fictional: 'UTF-8 evidence' } }]]),
    key = intakeNamespace(identity) + 'frame:' + f.head.tip.id,
    frame = JSON.parse(f.rows.get(key)!) as { data: string; payloadHash: string },
    bytes = Buffer.from(frame.data, 'base64');
  assert.equal(f.head.usage.frames, 1);
  bytes[0] = 255;
  frame.data = bytes.toString('base64');
  frame.payloadHash = createHash('sha256').update(bytes).digest('hex');
  const raw = JSON.stringify(frame),
    head = { ...f.head, tip: { ...f.head.tip, sha256: hash(raw) } };
  f.rows.set(key, raw);
  assert.throws(
    () => prepareIntakeLegacyReplay(identity, f.caps, head, (key) => f.rows.get(key)),
    /encoded data|UTF-8|encoding/,
  );
});

test('native delta checkpoints refuse mutation, close once and do not return partial handles', () => {
  let checks = 0,
    closed = 0,
    selected = 0;
  const source = (function* () {
    try {
      yield JSON.stringify(Array(200).fill('fictional'));
    } finally {
      closed++;
    }
  })();
  assert.throws(
    () =>
      finishIntakeCopySteps(
        prepareIntakeLegacyDeltaTreeSteps(
          source,
          () => {
            if (++checks === 9) throw Error('fictional original changed');
          },
          () => selected++,
        ),
      ),
    /original changed/,
  );
  assert.equal(closed, 1);
  assert.equal(selected, 0);
  let running = true;
  const f = deltaTree('["fictional"]', 19, () => {
    if (!running) throw Error('fictional cancelled');
  });
  try {
    running = false;
    assert.throws(() => [...(f.tree as PreparedIntakeJsonCanonical).chunks()], /cancelled/);
    assert.throws(() => [...f.tree.arrayItems(f.tree.root)], /cancelled/);
  } finally {
    f.tree.close();
  }
});

test('native legacy delta preparation does not bypass unsafe member refusal', () => {
  const caps = limits(),
    remaining = budget(caps, { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 }),
    evidence = frameIntakeChanges(
      identity,
      [{ op: 'set', path: [], value: JSON.parse('{"__proto__":{"fictional":true}}') }],
      hash('{}'),
      randomUUID(),
      caps,
      undefined,
      remaining,
    ),
    rows = new Map(evidence.frames.map((frame) => [frame.key, frame.serialized]));
  assert.throws(
    () => prepareIntakeLegacyReplay(identity, caps, evidence.head, (key) => rows.get(key)),
    /legacy delta key/,
  );
  assert.equal(Object.hasOwn(Object.prototype, 'fictional'), false);
});

const identity = {
  profileId: 'fictional-legacy-replay',
  intakeId: 'fictional-legacy-intake',
  sourceHash: 'f'.repeat(64),
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(versions: IntakeChange[][]) {
  const rows = new Map<string, string>(),
    serialized: string[] = [],
    operationIds: string[] = [],
    caps = limits();
  let head: Head | undefined, state: IntakeJson | undefined;
  for (const changes of versions) {
    const remaining = budget(
      caps,
      head?.usage ?? {
        bytes: 0,
        frames: 0,
        nodes: 0,
        operations: 0,
        stringWork: 0,
      },
    );
    state = applyIntakeChanges(state, changes, remaining);
    const text = serializeIntakeJson(state),
      operationId = randomUUID(),
      evidence = frameIntakeChanges(
        identity,
        changes,
        hash(text),
        operationId,
        caps,
        head,
        remaining,
      );
    for (const frame of evidence.frames) rows.set(frame.key, frame.serialized);
    rows.set(intakeNamespace(identity) + 'operation:' + operationId, evidence.receipt);
    rows.set(intakeNamespace(identity) + 'head', evidence.serializedHead);
    head = evidence.head;
    serialized.push(text);
    operationIds.push(operationId);
  }
  return { rows, head: head!, caps, serialized, operationIds };
}

test('legacy object cursors retain numeric and Unicode order without a temporary sort', (t) => {
  const f = fixture([
    [
      {
        op: 'set',
        path: [],
        value: {
          '10': 'ten',
          '2': 'two',
          '4294967294': 'largest numeric key',
          '01': 'numeric lookalike',
          '4294967295': 'ordinary key',
          a: 'ordinary',
          '\u00e9': 'accent',
          '\ud83d\ude00': 'smile',
        },
      },
    ],
    [{ op: 'move-key', path: [], key: 'a', before: null }],
  ]);
  const originalPrepare = DatabaseSync.prototype.prepare;
  const plans = new Set<'entries' | 'entryNodes'>();
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const kind = sql.includes('ORDER BY numeric IS NULL,numeric,ordinal')
      ? 'entries'
      : sql.includes('ORDER BY e.numeric IS NULL,e.numeric,e.ordinal')
        ? 'entryNodes'
        : undefined;
    if (kind) {
      const details = originalPrepare
        .call(this, 'EXPLAIN QUERY PLAN ' + sql)
        .all(1)
        .map((row) => String(row.detail));
      assert.ok(
        details.some((detail) => detail.includes('entries_object_order')),
        sql,
      );
      assert.ok(
        details.every((detail) => !detail.includes('USE TEMP B-TREE')),
        sql,
      );
      plans.add(kind);
    }
    return originalPrepare.call(this, sql);
  });
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(version, fingerprint, pieces) {
      assert.equal(fingerprint, hash(f.serialized[version - 1]!));
      assert.equal([...pieces()].join(''), f.serialized[version - 1]);
    },
  });
  try {
    assert.deepEqual([...plans].sort(), ['entries', 'entryNodes']);
    assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
  } finally {
    replay.close();
  }
});

test('tree-only legacy fallback keeps duplicate and scalar spelling semantics through exact fingerprints and receipts', () => {
  const changes: IntakeChange[] = [
      {
        op: 'set',
        path: [],
        value: {
          '10': 10,
          '2': 2,
          first: 'retained',
          number: 12.5,
          zero: 0,
          escaped: 'A\u0000\ufeff\ud800\udc00',
          payload: 'fictional'.repeat(20000),
        },
      },
    ],
    f = fixture([changes]),
    literal = JSON.stringify(changes)
      .replace('"2":2,"10":10', '"10":10,"2":2')
      .replace('"first":"retained"', '"first":"discarded","first":"retained"')
      .replace('"number":12.5', '"number":12.5000')
      .replace('"zero":0', '"zero":-0')
      .replace(
        JSON.stringify('A\u0000\ufeff\ud800\udc00'),
        '"\\u0041\\u0000\\ufeff\\ud800\\udc00"',
      );
  assert.equal(JSON.stringify(JSON.parse(literal)), JSON.stringify(changes));
  const prefix = intakeNamespace(identity),
    receiptKey = prefix + 'operation:' + f.operationIds[0],
    receipt = f.rows.get(receiptKey)!,
    template = JSON.parse(f.rows.get(prefix + 'frame:' + f.head.tip.id)!) as Frame;
  const reframed = (text: string, payloadHash = hash(text)) => {
    const payload = Buffer.from(text),
      chunks = Math.ceil(payload.length / CHUNK_BYTES),
      rows = new Map([[receiptKey, receipt]]);
    let tip: Reference | null = null,
      bytes = Buffer.byteLength(receipt);
    for (let chunk = 0; chunk < chunks; chunk++) {
      const frame: Frame = {
          ...template,
          id: randomUUID(),
          sequence: chunk + 1,
          previous: tip,
          chunk,
          chunks,
          payloadHash,
          data: payload.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES).toString('base64'),
        },
        raw = JSON.stringify(frame);
      rows.set(prefix + 'frame:' + frame.id, raw);
      bytes += Buffer.byteLength(raw);
      tip = { id: frame.id, sequence: frame.sequence, sha256: hash(raw) };
    }
    const head: Head = { ...f.head, tip: tip!, usage: { ...f.head.usage, bytes, frames: chunks } };
    rows.set(prefix + 'head', JSON.stringify(head));
    return { rows, head };
  };
  const exact = reframed(literal),
    original = reconstructIntakeEvidence(identity, f.caps, exact.head, (key) =>
      exact.rows.get(key),
    ),
    replay = prepareIntakeLegacyReplay(identity, f.caps, exact.head, (key) => exact.rows.get(key));
  try {
    assert.equal(replay.work.nativeDeltaPreparations, 0);
    assert.equal(replay.work.fallbackDeltaPreparations, 1);
    assert.equal(replay.fingerprint, hash(f.serialized[0]!));
    assert.equal([...replay.pieces()].join(''), f.serialized[0]);
    assert.deepEqual(replay.head.usage, original.head.usage);
  } finally {
    replay.close();
  }
  const badHash = reframed(literal, '0'.repeat(64));
  assert.throws(
    () => prepareIntakeLegacyReplay(identity, f.caps, badHash.head, (key) => badHash.rows.get(key)),
    /payload hash/,
  );
  const malformed = reframed(literal + ' false');
  assert.throws(
    () =>
      prepareIntakeLegacyReplay(identity, f.caps, malformed.head, (key) => malformed.rows.get(key)),
    /Invalid JSON/,
  );
  const badReceipt = reframed(literal);
  badReceipt.rows.set(receiptKey, receipt.replace(template.fingerprint, '0'.repeat(64)));
  assert.throws(
    () =>
      prepareIntakeLegacyReplay(identity, f.caps, badReceipt.head, (key) =>
        badReceipt.rows.get(key),
      ),
    /operation receipt/,
  );
});
function forbidLargeParse<T>(action: () => T): T {
  const original = JSON.parse;
  JSON.parse = ((text: string, ...args: unknown[]) => {
    assert.ok(text.length <= 65536, 'legacy replay must never parse a giant value');
    return Reflect.apply(original, JSON, [text, ...args]);
  }) as typeof JSON.parse;
  try {
    return action();
  } finally {
    JSON.parse = original;
  }
}

const operations = (literal: string): IntakeChange[][] => [
  [
    {
      op: 'set',
      path: [],
      value: {
        intake: { version: 1, originalName: 'fictional.txt', metadata: { unknown: literal } },
        text: literal + '\ud800x\udc00',
        array: [1, { unknown: literal }, 3],
        object: { '10': 10, '2': 2, first: { unknown: literal }, second: 'retained', last: null },
        unknown: { numbers: [-0, 0.000000001, 9007199254740992], nested: [true, false, null] },
      },
    },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 2 },
    { op: 'set', path: ['array', '3'], value: { unknown: literal } },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 3 },
    { op: 'remove', path: ['object', 'second'] },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 4 },
    { op: 'truncate', path: ['array'], length: 3 },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 5 },
    { op: 'splice', path: ['text'], offset: 2, remove: 3, text: '\udfffFictional\ud800' },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 6 },
    { op: 'move-key', path: ['object'], key: 'last', before: 'first' },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 7 },
    {
      op: 'array-splice',
      path: ['array'],
      offset: 1,
      remove: 1,
      values: [{ unknown: literal }, 'inserted', null],
    },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 8 },
    { op: 'array-move', path: ['array'], from: 0, to: 4 },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 9 },
    { op: 'array-move', path: ['array'], from: 4, to: 0 },
  ],
  [
    { op: 'set', path: ['intake', 'version'], value: 10 },
    { op: 'move-key', path: ['object'], key: 'last', before: null },
  ],
  [],
];

test('legacy array append preserves existing rows and exact version fingerprints', (t) => {
  const existing = Array.from({ length: 128 }, (_, index) => index),
    f = fixture([
      [{ op: 'set', path: [], value: { intake: { version: 1 }, values: existing } }],
      [
        { op: 'set', path: ['intake', 'version'], value: 2 },
        {
          op: 'array-splice',
          path: ['values'],
          offset: existing.length,
          remove: 0,
          values: ['fictional-append', null, true],
        },
      ],
    ]),
    originalRun = StatementSync.prototype.run;
  let removed = 0,
    reordered = 0,
    appended = 0;
  t.mock.method(StatementSync.prototype, 'run', function (this: StatementSync, ...args: unknown[]) {
    if (this.sourceSQL === 'DELETE FROM entries WHERE parent=?') removed++;
    if (this.sourceSQL === 'INSERT INTO reordered(key,numeric,child) VALUES(?,?,?)') reordered++;
    if (this.sourceSQL === 'INSERT INTO entries VALUES(?,?,?,?,?)') appended++;
    return Reflect.apply(originalRun, this, args);
  });
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(version, fingerprint) {
      assert.equal(fingerprint, hash(f.serialized[version - 1]!));
      if (version === 1) removed = reordered = appended = 0;
    },
  });
  try {
    assert.equal([...replay.pieces()].join(''), f.serialized[1]);
    assert.equal(removed, 0, 'append must not delete existing array entries');
    assert.equal(reordered, 0, 'append must not restage existing array entries');
    assert.equal(appended, 3, 'append writes only newly inserted array entries');
  } finally {
    replay.close();
  }
});

test('legacy replay and whitespace scratch batch all prepared row writes', (t) => {
  const f = fixture(operations('Fictional batched legacy state.')),
    prepare = DatabaseSync.prototype.prepare;
  let writes = 0,
    autocommitWrites = 0;
  const probe = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) {
        writes++;
        if (!this.isTransaction) autocommitWrites++;
      }
      return prepare.call(this, sql);
    },
  );
  try {
    const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key));
    try {
      assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
      const copied = new Map<string, string>();
      replay.rebind({ ...identity, profileId: 'fictional-batched-copy' }, (key, value) =>
        copied.set(key, value),
      );
      assert.ok(copied.size > 0);
    } finally {
      replay.close();
    }
    assert.equal(
      [...intakeCopyTrimmedPieces(['  first ', ' '.repeat(8192), 'last  '])].join(''),
      'first' + ' '.repeat(8193) + 'last',
    );
  } finally {
    probe.mock.restore();
  }
  assert.ok(writes > 0, 'real replay and whitespace scratch writes were exercised');
  assert.equal(autocommitWrites, 0, 'no scratch write starts a per-row transaction');
});

test('disk replay accounts actual versions and operations without charging warm or unrelated owners', () => {
  const db = new DatabaseSync(':memory:'),
    ordinaryDb = new DatabaseSync(':memory:'),
    versions = operations('Fictional accounted state.'),
    f = fixture(versions),
    expected = {
      versions: versions.length,
      operations: versions.reduce((total, changes) => total + changes.length, 0),
    };
  try {
    const replay = withIntakeWork(db, 'reconstruction', () =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key)),
    );
    try {
      withIntakeWork(ordinaryDb, 'reconstruction', () =>
        reconstructIntakeEvidence(identity, f.caps, f.head, (key) => f.rows.get(key)),
      );
      for (const owner of [db, ordinaryDb]) {
        const work = intakeWorkCounters(owner);
        assert.equal(work.reconstruction.evidenceReplayVersions, expected.versions);
        assert.equal(work.reconstruction.evidenceReplayOperations, expected.operations);
        assert.equal(work.warm.evidenceReplayVersions, 0);
        assert.equal(work.warm.evidenceReplayOperations, 0);
      }
      const baseline = intakeWorkCounters(db),
        ordinaryBaseline = intakeWorkCounters(ordinaryDb);
      withIntakeWork(db, 'warm', () => {
        assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
        const target = { ...identity, profileId: 'fictional-accounted-copy' },
          copied = new Map<string, string>(),
          head = replay.rebind(target, (key, raw) => copied.set(key, raw));
        assert.equal(head.version, f.head.version);
        assert.equal(copied.size, f.head.usage.frames + f.operationIds.length);
      });
      const warm = intakeWorkCounters(db);
      assert.equal(warm.warm.evidenceReplayVersions, 0);
      assert.equal(warm.warm.evidenceReplayOperations, 0);
      assert.equal(
        warm.reconstruction.evidenceReplayVersions,
        baseline.reconstruction.evidenceReplayVersions,
      );
      assert.equal(
        warm.reconstruction.evidenceReplayOperations,
        baseline.reconstruction.evidenceReplayOperations,
      );
      const unscoped = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) =>
        f.rows.get(key),
      );
      unscoped.close();
      assert.deepEqual(intakeWorkCounters(db), warm, 'unscoped work cannot borrow an old owner');
      assert.deepEqual(intakeWorkCounters(ordinaryDb), ordinaryBaseline);
    } finally {
      replay.close();
    }
  } finally {
    db.close();
    ordinaryDb.close();
  }
});

test('disk replay keeps visited work visible after refusal and charges no replay before frame authentication', () => {
  const db = new DatabaseSync(':memory:'),
    versions = operations('Fictional refused accounted state.'),
    f = fixture(versions),
    missingReceipt = intakeNamespace(identity) + 'operation:' + f.operationIds[1];
  try {
    assert.throws(
      () =>
        withIntakeWork(db, 'reconstruction', () =>
          prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) =>
            key === missingReceipt ? undefined : f.rows.get(key),
          ),
        ),
      /encoded bytes/,
    );
    const refused = intakeWorkCounters(db);
    assert.equal(refused.reconstruction.evidenceReplayVersions, 2);
    assert.equal(
      refused.reconstruction.evidenceReplayOperations,
      versions.slice(0, 2).reduce((total, changes) => total + changes.length, 0),
    );
    assert.equal(refused.warm.evidenceReplayVersions, 0);
    assert.equal(refused.warm.evidenceReplayOperations, 0);
    const frameKey = intakeNamespace(identity) + 'frame:' + f.head.tip.id;
    assert.throws(
      () =>
        withIntakeWork(db, 'reconstruction', () =>
          prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) =>
            key === frameKey ? f.rows.get(key)! + ' ' : f.rows.get(key),
          ),
        ),
      /bytes\/hash/,
    );
    const unauthenticated = intakeWorkCounters(db);
    assert.equal(
      unauthenticated.reconstruction.evidenceReplayVersions,
      refused.reconstruction.evidenceReplayVersions,
    );
    assert.equal(
      unauthenticated.reconstruction.evidenceReplayOperations,
      refused.reconstruction.evidenceReplayOperations,
    );
    const invalidOperation = frameIntakeChanges(
        identity,
        [
          { op: 'fictional-invalid-operation', path: [] },
          { op: 'set', path: [], value: { retained: 'Fictional unvisited state.' } },
        ],
        hash('{}'),
        randomUUID(),
        f.caps,
        undefined,
        budget(f.caps, { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 }),
      ),
      invalidFrames = new Map(
        invalidOperation.frames.map((frame) => [frame.key, frame.serialized]),
      );
    assert.throws(
      () =>
        withIntakeWork(db, 'reconstruction', () =>
          prepareIntakeLegacyReplay(identity, f.caps, invalidOperation.head, (key) =>
            invalidFrames.get(key),
          ),
        ),
      /legacy delta operation/,
    );
    const partial = intakeWorkCounters(db);
    assert.equal(
      partial.reconstruction.evidenceReplayVersions -
        unauthenticated.reconstruction.evidenceReplayVersions,
      1,
    );
    assert.equal(
      partial.reconstruction.evidenceReplayOperations -
        unauthenticated.reconstruction.evidenceReplayOperations,
      1,
      'invalid first operation is visited; the trailing operation is not charged',
    );
  } finally {
    db.close();
  }
});

test('disk replay matches the original decoder at every version for all seven operations and exact budgets', () => {
  const f = fixture(operations('Independently fictional \\" \ud800\udc00\ud800 value.')),
    ordinary = reconstructIntakeEvidence(identity, f.caps, f.head, (key) => f.rows.get(key));
  let versions = 0;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(version, fingerprint, pieces) {
      assert.equal([...pieces()].join(''), f.serialized[version - 1]);
      assert.equal(fingerprint, hash(f.serialized[version - 1]!));
      versions++;
    },
  });
  try {
    assert.equal(versions, f.serialized.length);
    assert.equal(replay.work.nativeDeltaPreparations, f.serialized.length);
    assert.equal(replay.work.fallbackDeltaPreparations, 0);
    assert.equal([...replay.pieces()].join(''), ordinary.serialized);
    assert.equal(replay.fingerprint, ordinary.fingerprint);
    assert.equal(replay.semanticBytes, ordinary.semanticBytes);
    assert.deepEqual(new Set(replay.consumed()), ordinary.consumed);
    assert.equal(replay.domainVersion(), 10);
    assert.equal(
      replay.work.serializedBytes,
      f.serialized.reduce((n, text) => n + Buffer.byteLength(text), 0),
    );
    const target = { ...identity, profileId: 'fictional-replay-target-with-longer-name' },
      copied = new Map<string, string>(),
      head = replay.rebind(target, (key, value) => copied.set(key, value));
    copied.set(intakeNamespace(target) + 'head', JSON.stringify(head));
    assert.equal(head.version, f.head.version);
    assert.deepEqual({ ...head.usage, bytes: f.head.usage.bytes }, f.head.usage);
    const targetReplay = prepareIntakeLegacyReplay(target, f.caps, head, (key) => copied.get(key), {
      onVersion(version, fingerprint, pieces) {
        assert.equal([...pieces()].join(''), f.serialized[version - 1]);
        assert.equal(fingerprint, hash(f.serialized[version - 1]!));
      },
    });
    try {
      const sourceIds = new Set(
        [...f.rows.keys()].map((key) => key.slice(intakeNamespace(identity).length)),
      );
      const receipts = [...copied]
        .filter(([key]) => key.includes(':operation:'))
        .map(([, raw]) => JSON.parse(raw));
      assert.equal(receipts.length, f.operationIds.length);
      for (const [key] of copied)
        if (!key.endsWith(':head'))
          assert.equal(sourceIds.has(key.slice(intakeNamespace(target).length)), false);
      for (const id of f.operationIds) {
        const prior = JSON.parse(f.rows.get(intakeNamespace(identity) + 'operation:' + id)!);
        const receipt = receipts.find((row) => row.result.version === prior.result.version);
        assert.ok(receipt);
        assert.notEqual(receipt.result.operationId, id);
        assert.deepEqual({ ...receipt, result: { ...receipt.result, operationId: id } }, prior);
      }
    } finally {
      targetReplay.close();
    }
  } finally {
    replay.close();
  }
  assert.throws(() => replay.pieces(), /closed/);
});

test('copied multipart legacy operations use fresh private identities without changing public receipt values', () => {
  const publicOperation = randomUUID(),
    value = {
      publicReceipt: { operationId: publicOperation, status: 'accepted' },
      retained: 'Independently fictional copied scalar. '.repeat(5000),
    },
    f = fixture([[{ op: 'set', path: [], value }]]),
    replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key));
  assert.ok(f.head.usage.frames > 1);
  try {
    const copiedIds = new Set<string>();
    for (const profileId of ['fictional-first-copy', 'fictional-second-copy']) {
      const target = { ...identity, profileId },
        copied = new Map<string, string>(),
        head = replay.rebind(target, (key, raw) => copied.set(key, raw));
      copied.set(intakeNamespace(target) + 'head', JSON.stringify(head));
      const receipts = [...copied].filter(([key]) => key.includes(':operation:'));
      assert.equal(receipts.length, 1);
      const receipt = JSON.parse(receipts[0]![1]);
      assert.notEqual(receipt.result.operationId, f.operationIds[0]);
      assert.notEqual(receipt.result.operationId, publicOperation);
      for (const [key, raw] of copied) {
        if (key.endsWith(':head')) continue;
        const suffix = key.slice(intakeNamespace(target).length);
        assert.equal(copiedIds.has(suffix), false, 'independent copies do not reuse private IDs');
        copiedIds.add(suffix);
        if (key.includes(':frame:')) {
          const frame = JSON.parse(raw);
          assert.equal(frame.operationId, receipt.result.operationId);
          assert.notEqual(frame.id, frame.previous?.id);
        }
      }
      const restored = reconstructIntakeEvidence(target, f.caps, head, (key) => copied.get(key));
      assert.equal(restored.serialized, f.serialized[0]);
      assert.deepEqual(restored.value, value);
      assert.equal(head.usage.frames, f.head.usage.frames);
      assert.equal(head.version, f.head.version);
    }
  } finally {
    replay.close();
  }
});

test('legacy rebind refuses overlapping and callback-reentrant copies and releases its private mapping', () => {
  const f = fixture([
      [{ op: 'set', path: [], value: { retained: 'Fictional multipart state. '.repeat(5000) } }],
    ]),
    sourceRows = [...f.rows],
    replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key)),
    target = { ...identity, profileId: 'fictional-rebind-lifetime' };
  assert.ok(f.head.usage.frames > 1);
  const check = (copied: Map<string, string>, head: Head) => {
    copied.set(intakeNamespace(target) + 'head', JSON.stringify(head));
    assert.equal(
      reconstructIntakeEvidence(target, f.caps, head, (key) => copied.get(key)).serialized,
      f.serialized[0],
    );
    assert.deepEqual([...f.rows], sourceRows, 'rebind never changes source evidence');
  };
  try {
    const copied = new Map<string, string>(),
      pending = replay.rebindSteps(target, (key, raw) => copied.set(key, raw));
    assert.equal(pending.next().done, false);
    const overlapping = replay.rebindSteps(target, () => {
      assert.fail('refused overlapping copy must not write');
    });
    assert.throws(() => overlapping.next(), /legacy rebind already in flight/);
    let step = pending.next();
    while (!step.done) step = pending.next();
    check(copied, step.value);

    const reentrantCopy = new Map<string, string>();
    let callbacks = 0;
    const reentrantHead = replay.rebind(target, (key, raw) => {
      callbacks++;
      assert.throws(
        () =>
          replay.rebind(target, () => {
            assert.fail('refused callback-reentrant copy must not write');
          }),
        /legacy rebind already in flight/,
      );
      reentrantCopy.set(key, raw);
    });
    assert.equal(callbacks, f.head.usage.frames + f.operationIds.length);
    check(reentrantCopy, reentrantHead);

    const cancelled = replay.rebindSteps(target, () => {
      assert.fail('cancelled copy stops before its first write');
    });
    assert.equal(cancelled.next().done, false);
    assert.equal(cancelled.return(f.head).done, true);
    assert.throws(
      () =>
        replay.rebind(target, () => {
          throw Error('Fictional rebind writer refusal');
        }),
      /Fictional rebind writer refusal/,
    );
    const retry = new Map<string, string>();
    check(
      retry,
      replay.rebind(target, (key, raw) => retry.set(key, raw)),
    );
  } finally {
    replay.close();
  }
});

test(
  'all seven legacy operations retain fixed scalar/frame buffers with giant unknown values',
  { timeout: 180000 },
  () => {
    const f = fixture(operations('Independently fictional escaped \\" value. '.repeat(55000))),
      expected = f.serialized.map(hash);
    let versions = 0;
    const replay = forbidLargeParse(() =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
        onVersion(version, fingerprint, pieces) {
          const actual = createHash('sha256');
          for (const piece of pieces()) {
            assert.ok(Buffer.byteLength(piece) <= 8192);
            actual.update(piece);
          }
          assert.equal(actual.digest('hex'), expected[version - 1]);
          assert.equal(fingerprint, expected[version - 1]);
          versions++;
        },
      }),
    );
    try {
      assert.equal(versions, f.serialized.length);
      assert.equal(replay.work.peakScalarBufferBytes, 4096);
      // One positioned write per full bounded buffer, not one per decoded piece.
      assert.ok(
        replay.work.scalarScratchWrites <= Math.ceil(replay.work.scalarScratchBytes / 4096) + 4,
      );
      assert.ok(replay.work.peakFrameBytes <= 65536);
      assert.ok(replay.work.inputBytes > 2 * 1024 * 1024);
      assert.equal(replay.domainVersion(), 10);
    } finally {
      replay.close();
    }
  },
);

test('legacy short strings emit one bounded exact piece per scalar in every version', () => {
  const f = fixture([
    [
      {
        op: 'set',
        path: [],
        value: { values: ['', '\n"\\', '\ud800x\udc00', '\u0000'.repeat(512), 'x'.repeat(512)] },
      },
    ],
    [{ op: 'splice', path: ['values', '4'], offset: 2, remove: 3, text: '\ud800' }],
  ]);
  let seen = 0;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(version, fingerprint, pieces) {
      const chunks = [...pieces()];
      assert.equal(chunks.length, 14);
      assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 3074));
      assert.equal(chunks.join(''), f.serialized[version - 1]);
      assert.equal(fingerprint, hash(f.serialized[version - 1]!));
      seen++;
    },
  });
  try {
    assert.equal(seen, 2);
    assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
  } finally {
    replay.close();
  }
});

test('disk replay preserves recursive piece boundaries through deep mixed values and early return', () => {
  function* originalPieces(node: unknown): Generator<string> {
    if (Array.isArray(node)) {
      yield '[';
      for (let index = 0; index < node.length; index++) {
        if (index) yield ',';
        yield* originalPieces(node[index]);
      }
      yield ']';
    } else if (node !== null && typeof node === 'object') {
      yield '{';
      let first = true;
      for (const [name, child] of Object.entries(node)) {
        if (!first) yield ',';
        first = false;
        yield JSON.stringify(name) + ':';
        yield* originalPieces(child);
      }
      yield '}';
    } else yield JSON.stringify(node)!;
  }

  let value: IntakeJson = {
    '2': null,
    empty: [],
    short: 'Fictional \\n"\\',
    values: [true, false, -12.5, 0, '', { inner: 'fictional' }],
  };
  for (let depth = 0; depth < 40; depth++) value = { branch: depth % 2 ? value : [value] };
  const expected = [...originalPieces(value)],
    f = fixture([[{ op: 'set', path: [], value }]]);
  assert.equal(expected.join(''), f.serialized[0]);
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(_version, _fingerprint, pieces) {
      assert.deepEqual([...pieces()], expected);
    },
  });
  try {
    for (const stop of [1, 2, 3, 9, 43, 85]) {
      const iterator = replay.pieces()[Symbol.iterator]();
      for (let index = 0; index < stop; index++) assert.equal(iterator.next().done, false);
      iterator.return?.();
      assert.deepEqual([...replay.pieces()], expected);
    }
  } finally {
    replay.close();
  }
});

test('disk replay accepts the admitted maximum-depth empty container', () => {
  let value: IntakeJson = {};
  for (let depth = 0; depth < 64; depth++) value = { child: value };
  const f = fixture([[{ op: 'set', path: [], value }]]),
    replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key));
  try {
    assert.equal([...replay.pieces()].join(''), f.serialized[0]);
  } finally {
    replay.close();
  }
});

test('disk replay keeps a primary read failure while closing every nested cursor', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: { nested: { values: Array(65).fill(1) } } }]]),
    primary = new Error('fictional primary read failure'),
    cleanup = new Error('fictional cursor cleanup failure');
  let armed = false,
    failed = false,
    opened = 0,
    closed = 0,
    closeAttempts = 0;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    checkpoint() {
      if (!armed) return;
      failed = true;
      throw primary;
    },
  });
  const iterate = StatementSync.prototype.iterate;
  t.mock.method(
    StatementSync.prototype,
    'iterate',
    function (this: StatementSync, ...args: unknown[]) {
      const source = Reflect.apply(iterate, this, args) as ReturnType<StatementSync['iterate']>;
      if (!this.sourceSQL.startsWith('SELECT e.ordinal,e.key,e.numeric,e.child,n.kind'))
        return source;
      opened++;
      let returned = false;
      return {
        next: () => source.next(),
        return() {
          if (!returned) {
            returned = true;
            closed++;
          }
          source.return?.();
          if (failed && ++closeAttempts === 2) throw cleanup;
          return { done: true, value: undefined };
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  );
  try {
    const pieces = replay.pieces();
    armed = true;
    assert.throws(
      () => [...pieces],
      (error) => error === primary,
    );
    assert.ok(opened >= 3);
    assert.equal(closed, opened);
    assert.ok(closeAttempts >= 3);
    armed = false;
    assert.equal([...replay.pieces()].join(''), f.serialized[0]);
  } finally {
    replay.close();
  }
});

test('disk replay bounds a cyclic scratch cursor independently of admitted input', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: { nested: {} } }]]),
    replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key)),
    iterate = StatementSync.prototype.iterate;
  t.mock.method(
    StatementSync.prototype,
    'iterate',
    function (this: StatementSync, ...args: unknown[]) {
      const source = Reflect.apply(iterate, this, args) as ReturnType<StatementSync['iterate']>;
      if (!this.sourceSQL.startsWith('SELECT e.ordinal,e.key,e.numeric,e.child,n.kind'))
        return source;
      return {
        next() {
          const result = source.next();
          return result.done
            ? result
            : { done: false, value: { ...result.value, child: args[0], kind: 'object' } };
        },
        return: () => source.return?.(),
        [Symbol.iterator]() {
          return this;
        },
      };
    },
  );
  try {
    assert.throws(() => [...replay.pieces()], /legacy delta depth/);
  } finally {
    replay.close();
  }
});

test('legacy scalar reads remain detached across interleaved and checkpoint-nested readers', () => {
  const f = fixture(operations('Fictional \ud800x\udc00\n"'.repeat(400))),
    expected = f.serialized.at(-1)!;
  let nested: (() => void) | undefined;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    checkpoint() {
      const action = nested;
      nested = undefined;
      action?.();
    },
    onVersion(version, fingerprint, pieces) {
      assert.equal([...pieces()].join(''), f.serialized[version - 1]);
      assert.equal(fingerprint, hash(f.serialized[version - 1]!));
    },
  });
  try {
    const left = replay.pieces()[Symbol.iterator](),
      right = replay.pieces()[Symbol.iterator](),
      leftPieces: string[] = [],
      rightPieces: string[] = [];
    let nestedReads = 0;
    nested = () => {
      assert.equal([...replay.pieces()].join(''), expected);
      nestedReads++;
    };
    for (;;) {
      const a = left.next(),
        b = right.next();
      assert.equal(a.done, b.done);
      if (a.done || b.done) break;
      leftPieces.push(a.value);
      rightPieces.push(b.value);
    }
    assert.equal(nestedReads, 1);
    assert.equal(leftPieces.join(''), expected);
    assert.equal(rightPieces.join(''), expected);
    assert.equal(replay.work.peakScalarBufferBytes, 4096);
  } finally {
    replay.close();
  }
});

test('many small replayed splices are read back without one scratch write per value', () => {
  // Nine fictional versions each splice 40 small string values; each splice
  // and each version's serialization reads back values written moments earlier.
  const versions: IntakeChange[][] = [
    [
      {
        op: 'set',
        path: [],
        value: {
          intake: { version: 1, originalName: 'fictional.txt' },
          rows: Array.from({ length: 40 }, (_, index) => ({ label: `Fictional row ${index}` })),
        },
      },
    ],
  ];
  for (let version = 2; version <= 9; version++)
    versions.push([
      { op: 'set', path: ['intake', 'version'], value: version },
      ...Array.from({ length: 40 }, (_, index): IntakeChange => ({
        op: 'splice',
        path: ['rows', String(index), 'label'],
        offset: 9,
        remove: 3,
        text: `row v${version}`,
      })),
    ]);
  const f = fixture(versions),
    expected = f.serialized.map(hash);
  let versionsSeen = 0;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    onVersion(version, fingerprint, pieces) {
      const actual = createHash('sha256');
      for (const piece of pieces()) actual.update(piece);
      assert.equal(actual.digest('hex'), expected[version - 1]);
      assert.equal(fingerprint, expected[version - 1]);
      versionsSeen++;
    },
  });
  try {
    assert.equal(versionsSeen, 9);
    assert.equal(replay.work.peakScalarBufferBytes, 4096);
    // Reading a value still in the bounded buffer copies it from that buffer;
    // only full buffers are written, never one positioned write per read.
    const full = Math.ceil(replay.work.scalarScratchBytes / 4096);
    assert.ok(
      replay.work.scalarScratchWrites <= full + 4,
      `scratch writes ${replay.work.scalarScratchWrites} for ${full} full buffers`,
    );
  } finally {
    replay.close();
  }
});

test(
  'bounded raw legacy projection preserves every duplicate metadata occurrence and exact number spelling',
  { timeout: 180000 },
  () => {
    const giant = 'Independently fictional raw metadata '.repeat(60000),
      raw =
        ' {"unknown":1,"unknown":2,"intake":{"version":0,"metadata":{"first":12.00}},"\\u0069ntake":{"version":8,"originalName":"fictional.txt","metadata":{"unknown":' +
        JSON.stringify(giant) +
        ',"number":12.5000},"metadata":{"last":' +
        JSON.stringify(giant) +
        '}}} \n',
      initial = prepareInitialIntakeEnvelope(raw),
      f = fixture([[{ op: 'set', path: [], value: initial.state }]]);
    const replay = forbidLargeParse(() =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key)),
    );
    try {
      assert.equal(
        forbidLargeParse(() => replay.domainVersion()),
        8,
      );
      assert.equal(
        forbidLargeParse(() => replay.validateEnvelope(initial.detailsJson)).domainVersion,
        8,
      );
      assert.throws(
        () => replay.validateEnvelope(initial.detailsJson.replace('12.00', '12.01')),
        /metadata conflicts/,
      );
    } finally {
      replay.close();
    }
  },
);

test('legacy replay rejects forged usage, corrupt receipts, missing frames and cancellation', () => {
  const f = fixture(operations('Fictional bounded refusal value')),
    invalidHead = { ...f.head, usage: { ...f.head.usage, nodes: f.head.usage.nodes - 1 } };
  assert.throws(
    () => prepareIntakeLegacyReplay(identity, f.caps, invalidHead, (key) => f.rows.get(key)),
    /usage agreement/,
  );
  for (const kind of ['frame', 'receipt'] as const) {
    const rows = new Map(f.rows),
      key =
        kind === 'frame'
          ? intakeNamespace(identity) + 'frame:' + f.head.tip.id
          : intakeNamespace(identity) + 'operation:' + f.operationIds[0];
    if (kind === 'frame') rows.delete(key);
    else rows.set(key, rows.get(key)!.replace('"changed":true', '"changed":false'));
    assert.throws(() =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (name) => rows.get(name)),
    );
  }
  let checks = 0;
  assert.throws(
    () =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
        checkpoint() {
          if (++checks === 15) throw Error('Fictional cancelled');
        },
      }),
    /Fictional cancelled/,
  );
});
