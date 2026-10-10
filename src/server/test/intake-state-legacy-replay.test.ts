import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
  type Head,
} from '../intake-state-evidence.ts';
import { prepareIntakeLegacyReplay } from '../intake-state-legacy-replay.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { intakeCopyTrimmedPieces } from '../intake-copy-json.ts';
import { intakeWorkCounters, withIntakeWork } from '../intake-work-accounting.ts';

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
      assert.ok(replay.work.peakFrameBytes <= 65536);
      assert.ok(replay.work.inputBytes > 2 * 1024 * 1024);
      assert.equal(replay.domainVersion(), 10);
    } finally {
      replay.close();
    }
  },
);

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
