import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import {
  applyIntakeChanges,
  serializeIntakeJson,
  type IntakeChange,
  type IntakeJson,
} from '../intake-state-codec.ts';
import {
  budget,
  frameIntakeChanges,
  intakeNamespace,
  limits,
  reconstructIntakeEvidence,
  type Head,
} from '../intake-state-evidence.ts';
import {
  prepareIntakeLegacyReplay,
  prepareIntakeLegacyReplaySteps,
} from '../intake-state-legacy-replay.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeLegacyEncryptedScratch } from '../intake-state-legacy-encrypted.ts';
import { IntakeEncryptedScratchCapacityError } from '../intake-encrypted-scratch.ts';

const identity = {
  profileId: 'fictional-encrypted-legacy',
  intakeId: 'fictional-encrypted-intake',
  sourceHash: 'b'.repeat(64),
};
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
function fixture(versions: IntakeChange[][]) {
  const rows = new Map<string, string>(),
    serialized: string[] = [],
    caps = limits();
  let head: Head | undefined, state: IntakeJson | undefined;
  for (const changes of versions) {
    const remaining = budget(
      caps,
      head?.usage ?? { bytes: 0, frames: 0, nodes: 0, operations: 0, stringWork: 0 },
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
  }
  return { rows, serialized, caps, head: head! };
}
const binding = (head: Head) => ({ selectedHead: JSON.stringify(head), assertCurrent() {} });
const initial = (text: string): IntakeJson => ({
  intake: { version: 1, originalName: 'fictional.txt', metadata: { unknown: text } },
  text,
  array: [1, 2, 3],
  object: { '10': 10, '2': 2, first: 1, last: 2 },
});
const operations = (text: string): IntakeChange[][] => [
  [{ op: 'set', path: [], value: initial(text) }],
  [{ op: 'set', path: ['array', '3'], value: 4 }],
  [{ op: 'remove', path: ['object', 'last'] }],
  [{ op: 'set', path: ['object', 'after'], value: 5 }],
  [{ op: 'truncate', path: ['array'], length: 2 }],
  [{ op: 'splice', path: ['text'], offset: 2, remove: 3, text: '\udfffnew\ud800' }],
  [{ op: 'move-key', path: ['object'], key: 'after', before: 'first' }],
  [{ op: 'array-splice', path: ['array'], offset: 1, remove: 1, values: [true, null, 'new'] }],
  [{ op: 'array-move', path: ['array'], from: 0, to: 3 }],
  [],
];

test('encrypted replay matches original decoder every version for all seven operations and exact budgets', () => {
  const f = fixture(operations('Independently fictional \ud800x\udfff text.')),
    ordinary = reconstructIntakeEvidence(identity, f.caps, f.head, (key) => f.rows.get(key));
  let versions = 0;
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    encryptedScratch: binding(f.head),
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
    assert.equal(replay.domainVersion(), 1);
    assert.equal(
      replay.work.serializedBytes,
      f.serialized.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    );
    assert.equal(replay.work.nativeDeltaPreparations, f.serialized.length);
    const target = { ...identity, profileId: 'fictional-encrypted-target' },
      copy = new Map<string, string>(),
      head = replay.rebind(target, (key, value) => copy.set(key, value));
    copy.set(intakeNamespace(target) + 'head', JSON.stringify(head));
    const recovered = reconstructIntakeEvidence(target, f.caps, head, (key) => copy.get(key));
    assert.equal(recovered.serialized, ordinary.serialized);
    for (const key of copy.keys())
      if (!key.endsWith(':head'))
        assert.equal(
          f.rows.has(key.replace(intakeNamespace(target), intakeNamespace(identity))),
          false,
        );
  } finally {
    replay.close();
  }
});

test('encrypted by-name index preserves distinct lone surrogate and replacement-character names', () => {
  const object = {
      '\ud800': 'first',
      '\ud801': 'second',
      '\ufffd': 'replacement',
      '01': 1,
      '4294967294': 2,
      '4294967295': 3,
    },
    f = fixture([
      [{ op: 'set', path: [], value: { intake: { version: 1 }, object } }],
      [
        { op: 'set', path: ['object', '\ud800'], value: 'changed' },
        { op: 'remove', path: ['object', '\ud801'] },
      ],
      [
        { op: 'set', path: ['object', '\ud801'], value: 'reinserted' },
        { op: 'move-key', path: ['object'], key: '\ud801', before: '01' },
      ],
    ]);
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    encryptedScratch: binding(f.head),
    onVersion(version, _fingerprint, pieces) {
      assert.equal([...pieces()].join(''), f.serialized[version - 1]);
    },
  });
  try {
    assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
  } finally {
    replay.close();
  }
});

test('encrypted legacy scalar spool preserves splice unit offsets, dirty tails and overlapping readers', () => {
  const text = '界😀\ud800x\udfff'.repeat(700),
    f = fixture(operations(text));
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    encryptedScratch: binding(f.head),
  });
  try {
    const first = replay.pieces()[Symbol.iterator](),
      second = replay.pieces()[Symbol.iterator]();
    const prefix = first.next().value;
    second.next();
    second.next();
    assert.equal(prefix, '{');
    first.return?.();
    second.return?.();
    assert.equal([...replay.pieces()].join(''), f.serialized.at(-1));
    assert.equal(replay.work.peakScalarBufferBytes, 4096);
    assert.ok(replay.work.scalarScratchWrites <= Math.ceil(replay.work.scalarScratchBytes / 4096));
  } finally {
    replay.close();
  }
});

test('encrypted legacy delta fallback and raw envelope projections use encrypted canonical scratch', (t) => {
  const sentinel = 'INDEPENDENTLY_FICTIONAL_ENCRYPTED_RAW_141',
    raw =
      ' {"unknown":1,"intake":{"version":0,"metadata":{"first":12.00}},"\\u0069ntake":{"version":8,"originalName":"fictional.txt","metadata":{"number":12.5000,"unknown":' +
      JSON.stringify(sentinel.repeat(4000)) +
      '},"metadata":{"last":2}}} \n',
    initial = prepareInitialIntakeEnvelope(raw),
    f = fixture([[{ op: 'set', path: [], value: initial.state }]]),
    open = fs.openSync,
    paths = new Set<string>();
  const mock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    paths.add(String(args[0]));
    return open(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
    try {
      assert.equal(replay.work.fallbackDeltaPreparations, 1);
      assert.equal(replay.domainVersion(), 8);
      assert.equal(replay.validateEnvelope(initial.detailsJson).domainVersion, 8);
      assert.ok(paths.size > 0);
      for (const path of paths) {
        assert.match(path, /intake-encrypted-scratch-[^/]+\/cells\/[a-f0-9]+$/);
        assert.equal(fs.readFileSync(path).includes(Buffer.from(sentinel)), false);
      }
      assert.throws(
        () => replay.validateEnvelope(initial.detailsJson.replace('12.00', '12.01')),
        /metadata conflicts/,
      );
      assert.throws(() => replay.domainVersion(), /closed legacy replay/);
    } finally {
      replay.close();
    }
    assert.ok([...paths].every((path) => !fs.existsSync(path)));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('encrypted replay rebind rejects overlap, survives returned or refused writers, and never changes source', () => {
  const f = fixture(operations('fictional copied state')),
    before = [...f.rows],
    target = { ...identity, profileId: 'fictional-rebind-target' },
    replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
  try {
    const pending = replay.rebindSteps(target, () => assert.fail('returned before writes'));
    assert.equal(pending.next().done, false);
    assert.throws(() => replay.rebind(target, () => {}), /already in flight/);
    pending.return(f.head);
    const refusal = Error('fictional writer failure');
    assert.throws(
      () =>
        replay.rebind(target, () => {
          throw refusal;
        }),
      (error) => error === refusal,
    );
    const copy = new Map<string, string>(),
      head = replay.rebind(target, (key, value) => {
        assert.throws(() => replay.rebind(target, () => {}), /already in flight/);
        copy.set(key, value);
      });
    assert.equal(
      reconstructIntakeEvidence(target, f.caps, head, (key) => copy.get(key)).serialized,
      f.serialized.at(-1),
    );
    assert.deepEqual([...f.rows], before);
  } finally {
    replay.close();
  }
});

test('encrypted legacy scratch needs exact explicit binding and preserves ENOSPC/session refusal identity', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: initial('fictional') }]]);
  for (const selectedHead of ['', undefined])
    assert.throws(
      () =>
        prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: { ...binding(f.head), selectedHead: selectedHead as string },
        }),
      /requires selected HEAD/,
    );
  assert.throws(
    () =>
      prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
        encryptedScratch: { ...binding(f.head), assertCurrent: undefined as unknown as () => void },
      }),
    /requires selected HEAD and current scope/,
  );
  const keys: Buffer[] = [],
    random = crypto.randomBytes;
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: { ...binding(f.head), capacity: { files: 0 } },
        }),
      IntakeEncryptedScratchCapacityError,
    );
    assert.ok(keys.length === 4 && keys.every((key) => key.every((byte) => byte === 0)));
    let revoked = false;
    const refusal = Object.assign(Error('fictional revoked'), { code: 'SESSION_REVOKED' });
    const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: {
        ...binding(f.head),
        assertCurrent() {
          if (revoked) throw refusal;
        },
      },
    });
    revoked = true;
    try {
      assert.throws(
        () => [...replay.pieces()],
        (error) => error === refusal,
      );
      assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
    } finally {
      replay.close();
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('encrypted legacy cancellation closes sources, ciphertext and keys without plaintext fallback', (t) => {
  const f = fixture([
      [
        {
          op: 'set',
          path: [],
          value: initial('INDEPENDENTLY_FICTIONAL_LEGACY_SENTINEL'.repeat(400)),
        },
      ],
    ]),
    open = fs.openSync,
    paths = new Set<string>();
  const mock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    paths.add(String(args[0]));
    return open(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    const steps = prepareIntakeLegacyReplaySteps(
      identity,
      f.caps,
      f.head,
      (key) => f.rows.get(key),
      { encryptedScratch: binding(f.head) },
    );
    assert.equal(steps.next().done, false);
    steps.return(undefined as never);
    assert.ok([...paths].every((path) => !fs.existsSync(path)));
    paths.clear();
    const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
    try {
      assert.ok(paths.size > 0);
      for (const path of paths) {
        assert.match(path, /intake-encrypted-scratch-[^/]+\/cells\/[a-f0-9]+$/);
        assert.equal(
          fs.readFileSync(path).includes(Buffer.from('INDEPENDENTLY_FICTIONAL_LEGACY_SENTINEL')),
          false,
        );
      }
    } finally {
      replay.close();
    }
    assert.ok([...paths].every((path) => !fs.existsSync(path)));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('typed legacy order/count index preserves max ordinal after delete and bounded range/reset work', () => {
  const scratch = createIntakeLegacyEncryptedScratch({ identity, ...binding({} as Head) }),
    index = scratch.index;
  try {
    for (let n = 0; n < 70; n++)
      index.add(1, { ordinal: n, key: 'fictional' + n, numeric: null, child: n });
    index.remove(1, index.named(1, 'fictional69')!);
    assert.equal(index.nextOrdinal(1), 69);
    assert.equal(index.count(1), 69);
    index.add(1, { ordinal: 69, key: 'new', numeric: null, child: 100 });
    for (const _ of index.truncateSteps(1, 0)) void _;
    assert.equal(index.count(1), 0);
    assert.equal(index.nextOrdinal(1), 0);
    index.add(1, { ordinal: 0, key: '\ud800', numeric: null, child: 1 });
    index.add(1, { ordinal: 1, key: '\ud801', numeric: null, child: 2 });
    assert.equal(index.named(1, '\ud800')!.child, 1);
    assert.equal(index.named(1, '\ud801')!.child, 2);
    for (const entry of index.entries(1, false)) index.reorder(entry);
    for (const _ of index.finishOrderSteps(1)) void _;
    assert.equal(index.count(1), 2);
    assert.ok(scratch.stats().peakCachePages <= 128);
    assert.ok(scratch.stats().nodeWrites < scratch.stats().preparations * 40);
  } finally {
    scratch.close();
  }
});

test('legacy scope revocation inside active canonical fallback erases both invocation keys', (t) => {
  const f = fixture([
      [{ op: 'set', path: [], value: initial('fictional fallback '.repeat(8000)) }],
    ]),
    paths = new Set<string>(),
    directories = new Map<string, number>(),
    keys: Buffer[] = [],
    open = fs.openSync,
    random = crypto.randomBytes,
    refusal = Object.assign(Error('fictional active fallback revoked'), {
      code: 'SESSION_REVOKED',
    });
  let armed = false;
  const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]),
      at = path.indexOf('/cells/');
    if (at >= 0) {
      paths.add(path);
      const directory = path.slice(0, at);
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
      if (directories.size === 2 && [...directories.values()][1]! >= 6) armed = true;
    }
    return open(...args);
  }) as typeof fs.openSync);
  const keyMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: {
            ...binding(f.head),
            assertCurrent() {
              if (armed) throw refusal;
            },
          },
        }),
      (error) => error === refusal,
    );
    assert.equal(directories.size, 2);
    assert.equal(keys.length, 4);
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
    assert.ok([...paths].every((path) => !fs.existsSync(path)));
  } finally {
    openMock.mock.restore();
    keyMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('actual legacy ENOSPC and missing reachable ciphertext preserve refusal, cleanup and fresh retry', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: initial('fictional retry '.repeat(500)) }]]),
    original = [...f.rows],
    open = fs.openSync,
    paths = new Set<string>();
  let noSpace = true;
  const mock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (path.includes('/cells/')) {
      paths.add(path);
      if (noSpace) throw Object.assign(Error('fictional no space'), { code: 'ENOSPC' });
    }
    return open(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: binding(f.head),
        }),
      (error) => error instanceof IntakeEncryptedScratchCapacityError && error.code === 'ENOSPC',
    );
    assert.ok([...paths].every((path) => !fs.existsSync(path)));
    noSpace = false;
    paths.clear();
    const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
    try {
      for (const path of paths) fs.rmSync(path);
      assert.throws(() => [...replay.pieces()], { kind: 'integrity' });
    } finally {
      replay.close();
    }
    assert.deepEqual(
      [...f.rows],
      original,
      'failed scratch never changes accepted fictional evidence',
    );
    const retry = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
    try {
      assert.equal([...retry.pieces()].join(''), f.serialized.at(-1));
    } finally {
      retry.close();
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('partial canonical construction erases already-owned legacy and canonical keys', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: initial('fictional constructor failure') }]]),
    random = crypto.randomBytes,
    keys: Buffer[] = [],
    refusal = Error('fictional fourth key allocation refused');
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    if (size === 32 && keys.length === 3) throw refusal;
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: binding(f.head),
        }),
      (error) => error === refusal,
    );
    assert.equal(keys.length, 3);
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('every exposed encrypted replay failure immediately revokes both scopes and stale iterators', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: initial('fictional lifecycle') }]]),
    open = fs.openSync,
    random = crypto.randomBytes,
    paths = new Set<string>(),
    keys: Buffer[] = [],
    target = { ...identity, profileId: 'fictional-lifecycle-copy' };
  const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (path.includes('/cells/')) paths.add(path);
    return open(...args);
  }) as typeof fs.openSync);
  const keyMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  type Replay = ReturnType<typeof prepareIntakeLegacyReplay>;
  let retainedVersionPieces: () => Iterable<string>;
  const cases: Array<[string, (replay: Replay) => unknown]> = [
    ['pieces', (replay) => [...replay.pieces()]],
    ['envelopePieces', (replay) => [...replay.envelopePieces()]],
    ['consumed', (replay) => [...replay.consumed()]],
    ['retained onVersion pieces', () => [...retainedVersionPieces()]],
    ['domainVersion', (replay) => replay.domainVersion()],
    [
      'domainVersionSteps',
      (replay) => {
        const steps = replay.domainVersionSteps();
        for (;;) {
          if (steps.next().done) break;
        }
      },
    ],
    ['validateEnvelope', (replay) => replay.validateEnvelope('{}')],
    [
      'validateEnvelopeSteps',
      (replay) => {
        const steps = replay.validateEnvelopeSteps('{}');
        for (;;) {
          if (steps.next().done) break;
        }
      },
    ],
    ['rebind', (replay) => replay.rebind(target, () => {})],
    [
      'rebindSteps',
      (replay) => {
        const steps = replay.rebindSteps(target, () => {});
        for (;;) {
          if (steps.next().done) break;
        }
      },
    ],
  ];
  try {
    for (const [name, action] of cases) {
      paths.clear();
      keys.length = 0;
      const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: binding(f.head),
          onVersion(_version, _fingerprint, pieces) {
            retainedVersionPieces = pieces;
          },
        }),
        stale = replay.pieces()[Symbol.iterator]();
      assert.equal(stale.next().done, false);
      assert.equal(keys.length, 4);
      for (const path of paths) fs.rmSync(path, { force: true });
      try {
        assert.throws(() => action(replay), name);
        assert.ok(
          keys.every((key) => key.every((byte) => byte === 0)),
          name + ' erases all four keys before caller close',
        );
        assert.ok(
          [...paths].every((path) => !fs.existsSync(path)),
          name + ' cleans both directories',
        );
        assert.throws(
          () => stale.next(),
          /closed legacy replay/,
          name + ' revokes already-started iterator',
        );
        assert.throws(() => replay.pieces(), /closed legacy replay/);
        assert.throws(() => replay.envelopePieces(), /closed legacy replay/);
        assert.throws(() => [...replay.consumed()], /closed legacy replay/);
        assert.throws(() => replay.domainVersion(), /closed legacy replay/);
      } finally {
        replay.close();
        stale.return?.();
      }
    }
  } finally {
    openMock.mock.restore();
    keyMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('writer error shape is recoverable only while reentrant reads have not poisoned the replay', (t) => {
  const f = fixture([[{ op: 'set', path: [], value: initial('fictional writer lifecycle') }]]),
    target = { ...identity, profileId: 'fictional-writer-lifecycle' },
    open = fs.openSync,
    random = crypto.randomBytes,
    paths = new Set<string>(),
    keys: Buffer[] = [];
  const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (path.includes('/cells/')) paths.add(path);
    return open(...args);
  }) as typeof fs.openSync);
  const keyMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  try {
    const healthy = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
      encryptedScratch: binding(f.head),
    });
    try {
      for (const refusal of [
        Object.assign(Error('fictional writer integrity label'), { kind: 'integrity' }),
        undefined,
        'fictional writer refusal',
      ]) {
        assert.throws(
          () =>
            healthy.rebind(target, () => {
              throw refusal;
            }),
          (error) => error === refusal,
        );
        assert.equal([...healthy.pieces()].join(''), f.serialized.at(-1));
        assert.ok(
          keys.every((key) => key.some((byte) => byte !== 0)),
          'writer-owned exception does not revoke healthy scopes',
        );
      }
    } finally {
      healthy.close();
    }
    for (const rethrow of [false, true]) {
      paths.clear();
      keys.length = 0;
      const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
          encryptedScratch: binding(f.head),
        }),
        outer = Error('fictional writer rethrow');
      try {
        assert.throws(
          () =>
            replay.rebind(target, () => {
              for (const path of paths) fs.rmSync(path, { force: true });
              assert.throws(() => replay.domainVersion(), { kind: 'integrity' });
              if (rethrow) throw outer;
            }),
          (error) => (rethrow ? error === outer : /closed/.test(String(error))),
        );
        assert.ok(
          keys.every((key) => key.every((byte) => byte === 0)),
          'caught internal failure still revokes both scopes',
        );
        assert.throws(() => replay.rebind(target, () => {}), /closed legacy replay/);
      } finally {
        replay.close();
      }
    }
  } finally {
    openMock.mock.restore();
    keyMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('returning an active canonical reader releases it without revoking healthy replay reuse', (t) => {
  const initial = prepareInitialIntakeEnvelope(
      JSON.stringify({
        intake: {
          version: 8,
          originalName: 'fictional.txt',
          metadata: { unknown: 'fictional '.repeat(16000) },
        },
      }),
    ),
    f = fixture([[{ op: 'set', path: [], value: initial.state }]]),
    keys: Buffer[] = [],
    random = crypto.randomBytes;
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    encryptedScratch: binding(f.head),
  });
  try {
    const steps = replay.domainVersionSteps();
    assert.equal(steps.next().done, false);
    assert.equal(steps.next().done, false);
    steps.return(undefined as never);
    assert.ok(keys.every((key) => key.some((byte) => byte !== 0)));
    assert.equal(replay.domainVersion(), 8);
  } finally {
    replay.close();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
});

test('revoking a suspended exposed canonical reader erases both scopes after delegated cleanup', (t) => {
  const initial = prepareInitialIntakeEnvelope(
      JSON.stringify({
        intake: {
          version: 8,
          originalName: 'fictional.txt',
          metadata: { unknown: 'fictional '.repeat(16000) },
        },
      }),
    ),
    f = fixture([[{ op: 'set', path: [], value: initial.state }]]),
    keys: Buffer[] = [],
    random = crypto.randomBytes,
    refusal = Object.assign(Error('fictional suspended-reader revocation'), {
      code: 'SESSION_REVOKED',
    });
  let revoked = false;
  const mock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const key = random(size);
    if (size === 32) keys.push(key);
    return key;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  const replay = prepareIntakeLegacyReplay(identity, f.caps, f.head, (key) => f.rows.get(key), {
    encryptedScratch: {
      ...binding(f.head),
      assertCurrent() {
        if (revoked) throw refusal;
      },
    },
  });
  try {
    const steps = replay.domainVersionSteps();
    assert.equal(steps.next().done, false);
    assert.equal(steps.next().done, false);
    revoked = true;
    assert.throws(
      () => steps.next(),
      (error) => error === refusal,
    );
    assert.equal(keys.length, 4);
    assert.ok(
      keys.every((key) => key.every((byte) => byte === 0)),
      'busy sibling is closed after delegated parser finally releases it',
    );
    assert.throws(() => replay.domainVersion(), /closed legacy replay/);
  } finally {
    replay.close();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
