import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import {
  createEncryptedIntakeJsonCanonicalScratch,
  prepareIntakeJsonCanonicalSteps,
  prepareIntakeJsonTreeSteps,
  type PreparedIntakeJsonTree,
  type IntakeJsonCanonicalHandle,
} from '../intake-json-canonical.ts';
import { createEncryptedCanonicalIndex } from '../intake-json-canonical-encrypted.ts';
import { IntakeEncryptedScratchCapacityError } from '../intake-encrypted-scratch.ts';

const options = () => ({
  identity: {
    profileId: 'fictional-canonical-profile',
    intakeId: 'fictional-canonical-intake',
    sourceHash: 'a'.repeat(64),
  },
  selectedHead: 'Independently fictional canonical HEAD',
  assertCurrent() {},
});
function* split(source: string, width = 13) {
  for (let at = 0; at < source.length; at += width) yield source.slice(at, at + width);
}
const joined = (pieces: Iterable<string>) => [...pieces].join('');
function* treePieces(tree: PreparedIntakeJsonTree, handle = tree.root): Generator<string> {
  const kind = tree.kind(handle);
  if (kind !== 'object' && kind !== 'array') return yield* tree.pieces(handle);
  yield kind === 'array' ? '[' : '{';
  let first = true;
  if (kind === 'array')
    for (const child of tree.arrayItems(handle)) {
      if (!first) yield ',';
      first = false;
      yield* treePieces(tree, child);
    }
  else
    for (const field of tree.objectFields(handle)) {
      if (!first) yield ',';
      first = false;
      yield* field.name();
      yield ':';
      yield* treePieces(tree, field.value);
    }
  yield kind === 'array' ? ']' : '}';
}
function checkFields(tree: PreparedIntakeJsonTree, handle: IntakeJsonCanonicalHandle = tree.root) {
  const kind = tree.kind(handle);
  if (kind === 'object') {
    for (const field of tree.objectFields(handle)) {
      const name = JSON.parse(joined(field.name())) as string;
      assert.equal(field.matches(name), true);
      assert.equal(field.matches(name + '\0'), false);
      assert.equal(
        joined(treePieces(tree, tree.field(handle, name)!)),
        joined(treePieces(tree, field.value)),
      );
      checkFields(tree, field.value);
    }
    assert.equal(tree.field(handle, 'fictional-absent-member'), undefined);
  } else if (kind === 'array')
    for (const child of tree.arrayItems(handle)) checkFields(tree, child);
}

test('encrypted canonical and stringify match default scratch for exact duplicate, number and UTF16 semantics', () => {
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  const corpus = [
    '{"2":2,"10":10,"a":0,"\\u0061":9,"1":1,"4294967295":4,"01":5,"0":6,"-0":7,"__proto__":{"x":1}}',
    '{"\\ud800":1,"\\ud801":2,"\\udfff":3,"":4,"x":5,"xy":6,"x":7,"\\u0000":8,"\\ufeff":9}',
    '[null,true,false,0,-0,1e400,-1e400,1e-400,123.4500e-2,{"a":"\\ud800\\udc00\\ud800x\\udfff"}]',
    '{"outer":{"z":1,"a":[{"q":2,"q":3},[],{}]},"outer":{"retained":4},"later":5}',
    JSON.stringify({
      ['x'.repeat(127)]: 1,
      ['x'.repeat(128)]: 2,
      ['x'.repeat(129)]: 3,
      ['x'.repeat(1024) + '\ud800']: '界'.repeat(3000) + '\0\ufeff',
    }),
    'false',
    'null',
    '[]',
    '{}',
  ];
  try {
    for (const mode of ['canonical', 'stringify'] as const)
      for (const preserveNumbers of [false, true])
        for (const source of corpus) {
          const plain = finishIntakeCopySteps(
            prepareIntakeJsonCanonicalSteps(split(source, 1), { mode, preserveNumbers }),
          );
          const encrypted = finishIntakeCopySteps(
            prepareIntakeJsonCanonicalSteps(split(source, 1), { mode, preserveNumbers, scratch }),
          );
          try {
            assert.equal(joined(encrypted.chunks()), joined(plain.chunks()));
            assert.equal(joined(treePieces(encrypted)), joined(treePieces(plain)));
            assert.equal(encrypted.bytes, plain.bytes);
            assert.equal(encrypted.work.sqliteCalls, 0);
            assert.equal(encrypted.work.maxBufferBytes, 8192);
            checkFields(encrypted);
          } finally {
            plain.close();
            encrypted.close();
          }
        }
  } finally {
    scratch.close();
  }
});

test('encrypted tree-only spans, paged arrays/members and shared reuse preserve exact traversal', () => {
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  try {
    const source = JSON.stringify({
      rows: Array.from({ length: 70 }, (_, n) => ({
        [String(70 - n)]: n,
        ['name' + n]: [n, n + 1],
      })),
    });
    const plain = finishIntakeCopySteps(prepareIntakeJsonTreeSteps(split(source)));
    const encrypted = finishIntakeCopySteps(prepareIntakeJsonTreeSteps(split(source), { scratch }));
    const oldPiecesIterable = encrypted.pieces(
      encrypted.field(
        [...encrypted.arrayItems(encrypted.field(encrypted.root, 'rows')!)][0]!,
        '70',
      )!,
    );
    const oldPieces = oldPiecesIterable[Symbol.iterator]();
    try {
      assert.equal(joined(treePieces(encrypted)), joined(treePieces(plain)));
      checkFields(encrypted);
      assert.throws(() => scratch.close(), /in use/);
      assert.throws(
        () => finishIntakeCopySteps(prepareIntakeJsonTreeSteps(['{}'], { scratch })),
        /in use/,
      );
    } finally {
      plain.close();
      encrypted.close();
    }
    const next = finishIntakeCopySteps(prepareIntakeJsonTreeSteps(['{"fresh":2}'], { scratch }));
    try {
      assert.equal(next.field(next.root, 'rows'), undefined);
      assert.equal(joined(treePieces(next)), '{"fresh":2}');
      assert.throws(() => oldPieces.next(), /closed/);
      assert.throws(() => encrypted.kind(encrypted.root), /closed/);
      assert.throws(() => next.kind(encrypted.root), /Foreign/);
      assert.equal(scratch.uses, 2);
      assert.equal(scratch.reuses, 1);
    } finally {
      next.close();
    }
  } finally {
    scratch.close();
  }
});

test('encrypted scalar/output range reads preserve UTF8 boundaries and overlapping readers', () => {
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  const value = '界😀'.repeat(2300) + '\ud800\0tail';
  const prepared = finishIntakeCopySteps(
    prepareIntakeJsonCanonicalSteps([JSON.stringify({ value })], { scratch }),
  );
  try {
    const field = prepared.field(prepared.root, 'value')!;
    const left = prepared.pieces(field)[Symbol.iterator](),
      right = prepared.pieces(field)[Symbol.iterator]();
    const a = left.next(),
      before = a.value;
    assert.equal(right.next().value, before);
    right.next();
    assert.equal(a.value, before, 'independent decrypted read buffers');
    left.return?.();
    right.return?.();
    assert.equal(JSON.parse(joined(prepared.pieces(field))), value);
    const separated = prepared.splitObjectField(prepared.root, 'value')!;
    assert.equal(
      joined(separated.before()) +
        joined(prepared.pieces(separated.value)) +
        joined(separated.after()),
      joined(prepared.chunks()),
    );
  } finally {
    prepared.close();
    scratch.close();
  }
});

test('encrypted provider writes ciphertext files only and erases keys and files on close', (t) => {
  const open = fs.openSync,
    random = crypto.randomBytes;
  const paths: string[] = [],
    keys: Buffer[] = [];
  const openMock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    paths.push(String(args[0]));
    return open(...args);
  }) as typeof fs.openSync);
  const keyMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const value = random(size);
    if (size === 32) keys.push(value);
    return value;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  const sentinel = 'INDEPENDENTLY_FICTIONAL_PLAINTEXT_SENTINEL_141';
  try {
    const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
    const prepared = finishIntakeCopySteps(
      prepareIntakeJsonCanonicalSteps([JSON.stringify({ [sentinel]: sentinel.repeat(110) })], {
        scratch,
      }),
    );
    try {
      assert.ok(paths.length > 0);
      assert.ok(
        paths.every((path) => /intake-encrypted-scratch-[^/]+\/cells\/[a-f0-9]+$/.test(path)),
      );
      for (const path of new Set(paths))
        assert.equal(fs.readFileSync(path).includes(Buffer.from(sentinel)), false);
      assert.equal(JSON.parse(joined(prepared.chunks()))[sentinel], sentinel.repeat(110));
    } finally {
      prepared.close();
      scratch.close();
    }
    assert.ok(keys.length === 2 && keys.every((key) => key.every((byte) => byte === 0)));
    assert.ok(paths.every((path) => !fs.existsSync(path)));
  } finally {
    openMock.mock.restore();
    keyMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('encrypted preparation returns, parse failures and cancellation release scratch without stale handles', () => {
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  try {
    for (const source of ['[1,]', '{"a":}', '"\\uxxxx"'])
      assert.throws(
        () => finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps([source], { scratch })),
        /Invalid/,
      );
    let closed = false;
    function* source() {
      try {
        yield* split(JSON.stringify({ fictional: 'x'.repeat(20000) }));
      } finally {
        closed = true;
      }
    }
    const steps = prepareIntakeJsonCanonicalSteps(source(), { scratch });
    assert.equal(steps.next().done, false);
    steps.return(undefined as never);
    assert.equal(closed, true);
    const refusal = Error('fictional caller cancellation');
    let running = true;
    const canceled = prepareIntakeJsonCanonicalSteps(
      split(JSON.stringify({ fictional: 'x'.repeat(20000) })),
      {
        scratch,
        assertRunning() {
          if (!running) throw refusal;
        },
      },
    );
    assert.equal(canceled.next().done, false);
    running = false;
    assert.throws(
      () => canceled.next(),
      (error) => error === refusal,
    );
    const last = finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(['{}'], { scratch }));
    last.close();
  } finally {
    scratch.close();
  }
});

test('encrypted current revocation preserves refusal identity and closes invocation keys', (t) => {
  const random = crypto.randomBytes,
    keys: Buffer[] = [];
  const keyMock = t.mock.method(crypto, 'randomBytes', ((size: number) => {
    const value = random(size);
    if (size === 32) keys.push(value);
    return value;
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  let revoked = false;
  const refusal = Object.assign(Error('fictional session revoked'), { code: 'SESSION_REVOKED' });
  const scratch = createEncryptedIntakeJsonCanonicalScratch({
    ...options(),
    assertCurrent() {
      if (revoked) throw refusal;
    },
  });
  const prepared = finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(['{"a":1}'], { scratch }));
  try {
    revoked = true;
    assert.throws(
      () => prepared.field(prepared.root, 'a'),
      (error) => error === refusal,
    );
    assert.ok(keys.every((key) => key.every((byte) => byte === 0)));
    assert.throws(() => joined(prepared.chunks()), /closed/);
  } finally {
    prepared.close();
    scratch.close();
    keyMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('encrypted canonical capacity refusal and actual ENOSPC preserve classification without fallback', (t) => {
  for (const capacity of [{ files: 0 }, { bytes: 1 }]) {
    const scratch = createEncryptedIntakeJsonCanonicalScratch({ ...options(), capacity });
    try {
      assert.throws(
        () => finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(['{}'], { scratch })),
        IntakeEncryptedScratchCapacityError,
      );
    } finally {
      scratch.close();
    }
  }
  const open = fs.openSync;
  const mock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).includes('/cells/'))
      throw Object.assign(Error('fictional no space'), { code: 'ENOSPC' });
    return open(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try {
    const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
    try {
      assert.throws(
        () => finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(['{}'], { scratch })),
        (error) => error instanceof IntakeEncryptedScratchCapacityError && error.code === 'ENOSPC',
      );
    } finally {
      scratch.close();
    }
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('typed canonical adapter orders exact bytes and retains bounded ciphertext work across reset', () => {
  const adapter = createEncryptedCanonicalIndex(options());
  try {
    adapter.reset();
    const root = {
      id: 1,
      parent: -1,
      chunk: -1,
      object: 1,
      value: null,
      first_order: -1,
      key_number: -1,
      raw_start: 0,
      raw_bytes: 0,
    };
    adapter.index.tries([root]);
    const chunks = [
      Buffer.from('d800', 'hex'),
      Buffer.from('0000', 'hex'),
      Buffer.from('d801', 'hex'),
      Buffer.from('00000000', 'hex'),
    ];
    adapter.index.tries(chunks.map((chunk, n) => ({ ...root, id: n + 2, parent: 1, chunk })));
    const ordered = chunks
      .map((chunk, n) => ({ chunk, id: n + 2 }))
      .sort((a, b) => Buffer.compare(a.chunk, b.chunk));
    let id = adapter.index.firstEdge(1);
    for (const row of ordered) {
      assert.equal(id, row.id);
      id = adapter.index.nextEdge(1, row.chunk);
    }
    assert.equal(id, undefined);
    for (let n = 0; n < 100; n++) adapter.index.outs([{ id: n, start: n * 3, bytes: 3 }]);
    const before = adapter.stats();
    assert.ok(before.peakCachePages <= 128);
    assert.ok(before.peakPreparedWritePages <= before.peakPreparationPageBound);
    assert.ok(before.filesRetained > 100, 'immutable superseded pages remain counted');
    assert.ok(before.nodeWrites < before.preparations * 40, 'bounded AVL mutation paths');
    adapter.reset();
    assert.equal(adapter.index.firstEdge(1), undefined);
    assert.equal(adapter.index.out(0), undefined);
    assert.ok(
      adapter.stats().filesRetained >= before.filesRetained,
      'reset never prunes prior ciphertext',
    );
    assert.equal(adapter.raw.length(), 0);
  } finally {
    adapter.close();
  }
});

test('encrypted node eviction and deterministic mixed nested values preserve the default result', () => {
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  try {
    const sources = [JSON.stringify(Array.from({ length: 1030 }, (_, n) => n))];
    let seed = 141;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 8; n++) {
      const members: string[] = [];
      for (let k = 0; k < 12; k++) {
        const key = ['a', '2', '\ud800', '', 'x'.repeat(128), '__proto__'][next() % 6]!;
        members.push(
          JSON.stringify(key) +
            ':' +
            JSON.stringify([next() / 17, { nested: String(next()), bool: !!(next() % 2) }]),
        );
      }
      sources.push('{' + members.join(',') + '}');
    }
    for (const source of sources) {
      const plain = finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps(split(source)));
      const encrypted = finishIntakeCopySteps(
        prepareIntakeJsonCanonicalSteps(split(source), { scratch }),
      );
      try {
        assert.equal(joined(encrypted.chunks()), joined(plain.chunks()));
      } finally {
        plain.close();
        encrypted.close();
      }
    }
  } finally {
    scratch.close();
  }
});

test('missing reachable ciphertext refuses an encrypted canonical reader and cleans the invocation', (t) => {
  const open = fs.openSync,
    paths = new Set<string>();
  const mock = t.mock.method(fs, 'openSync', ((...args: Parameters<typeof fs.openSync>) => {
    const path = String(args[0]);
    if (path.includes('/cells/')) paths.add(path);
    return open(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  const source = JSON.stringify({ fictional: 'x'.repeat(9000) });
  const scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  const prepared = finishIntakeCopySteps(prepareIntakeJsonCanonicalSteps([source], { scratch }));
  try {
    for (const path of paths) fs.rmSync(path);
    assert.throws(() => joined(prepared.chunks()), { kind: 'integrity' });
    assert.ok(
      [...paths].every((path) => !fs.existsSync(path)),
      'refusal cleans ciphertext',
    );
  } finally {
    prepared.close();
    scratch.close();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const retryScratch = createEncryptedIntakeJsonCanonicalScratch(options());
  try {
    const retry = finishIntakeCopySteps(
      prepareIntakeJsonCanonicalSteps([source], { scratch: retryScratch }),
    );
    try {
      assert.equal(joined(retry.chunks()), source);
    } finally {
      retry.close();
    }
  } finally {
    retryScratch.close();
  }
});

test('encrypted object pages preserve shared-prefix long keys and duplicate positions across trie flushes', () => {
  const prefix = 'A'.repeat(129),
    names = [
      ...Array.from({ length: 141 }, (_, n) => prefix + String(n).padStart(3, '0')),
      '4294967294',
      '4294967295',
      '',
      '\ud800',
      '\ud801',
      '\ufffd',
      '01',
      '0',
    ];
  const source =
      '{' +
      names.map((name, n) => JSON.stringify(name) + ':' + n).join(',') +
      ',' +
      JSON.stringify(names[0]) +
      ':999,' +
      JSON.stringify(names[70]) +
      ':1000}',
    object = JSON.parse(source) as Record<string, number>,
    scratch = createEncryptedIntakeJsonCanonicalScratch(options());
  assert.equal(Object.keys(object).length, 149);
  try {
    for (const mode of ['canonical', 'stringify'] as const) {
      const plain = finishIntakeCopySteps(
          prepareIntakeJsonCanonicalSteps(split(source, 17), { mode }),
        ),
        encrypted = finishIntakeCopySteps(
          prepareIntakeJsonCanonicalSteps(split(source, 17), { mode, scratch }),
        );
      try {
        assert.equal(joined(encrypted.chunks()), joined(plain.chunks()));
        assert.deepEqual(
          [...encrypted.objectFields(encrypted.root)].map((field) =>
            JSON.parse(joined(field.name())),
          ),
          mode === 'canonical' ? Object.keys(object).sort() : Object.keys(object),
        );
        assert.equal(joined(encrypted.pieces(encrypted.field(encrypted.root, names[0]!)!)), '999');
        assert.equal(
          joined(encrypted.pieces(encrypted.field(encrypted.root, names[70]!)!)),
          '1000',
        );
      } finally {
        plain.close();
        encrypted.close();
      }
    }
    const tree = finishIntakeCopySteps(prepareIntakeJsonTreeSteps(split(source, 17), { scratch }));
    try {
      assert.deepEqual(
        [...tree.objectFields(tree.root)].map((field) => JSON.parse(joined(field.name()))),
        Object.keys(object),
      );
      assert.equal(joined(treePieces(tree)), JSON.stringify(object));
    } finally {
      tree.close();
    }
  } finally {
    scratch.close();
  }
});
