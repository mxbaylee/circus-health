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
      for (const id of f.operationIds)
        assert.equal(
          copied.get(intakeNamespace(target) + 'operation:' + id),
          f.rows.get(intakeNamespace(identity) + 'operation:' + id),
        );
    } finally {
      targetReplay.close();
    }
  } finally {
    replay.close();
  }
  assert.throws(() => replay.pieces(), /closed/);
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
