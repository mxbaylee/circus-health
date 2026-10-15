import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
import {
  INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS,
  prepareIntakeJsonCanonical,
  prepareIntakeJsonCanonicalSteps,
  intakeJsonCanonicalWorkObserver,
  createIntakeJsonCanonicalScratch,
  prepareIntakeJsonTreeSteps,
} from '../intake-json-canonical.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type {
  IntakeJsonCanonicalWork,
  PreparedIntakeJsonTree,
  IntakeJsonCanonicalHandle,
} from '../intake-json-canonical.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';
import { hashIntakeJsonScalar } from '../intake-json-scalar.ts';

function* split(text: string, width = 7) {
  for (let at = 0; at < text.length; at += width) yield text.slice(at, at + width);
}
const joined = (pieces: Iterable<string>) => [...pieces].join('');

function* treePieces(
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

test('tree-only preparation preserves exact stringify traversal and scalar spans without root emission', () => {
  const corpus = [
    '{"2":"two","10":"ten","a":0,"\\u0061":9,"1":1,"4294967295":4,"01":5,"0":6,"-0":7,"__proto__":{"x":1}}',
    '{"\\ud800":1,"\\udfff":2,"":3,"x":4,"xy":5,"x":6,"\\u0000":7,"\\ufeff":8}',
    '[null,true,false,0,-0,1e400,-1e400,1e-400,{"9":9,"3":3,"a":"\\ud800\\udc00\\ud800x\\udfff"}]',
    '{"outer":{"z":1,"a":[{"q":2,"q":3},[],{}]},"outer":{"retained":4},"later":5}',
    JSON.stringify({ rows: Array.from({ length: 300 }, (_, n) => ({ [String(n)]: n })) }),
    JSON.stringify({ ['fictional'.repeat(400)]: 'x'.repeat(20000) + '\ud800\ufeff\0' }),
    '123.4500e-2',
    'false',
    'null',
    '[]',
    '{}',
  ];
  for (const preserveNumbers of [false, true])
    for (const source of corpus) {
      const canonical = finishIntakeCopySteps(
          prepareIntakeJsonCanonicalSteps(split(source, 1), {
            mode: 'stringify',
            preserveNumbers,
          }),
        ),
        tree = finishIntakeCopySteps(
          prepareIntakeJsonTreeSteps(split(source, 1), { preserveNumbers }),
        );
      try {
        assert.ok(tree.work.sqliteCalls < canonical.work.sqliteCalls, 'preparation queries');
        const expected = joined(canonical.chunks());
        assert.equal(joined(treePieces(canonical)), expected);
        assert.equal(joined(treePieces(tree)), expected);
        assert.ok(
          tree.work.sqliteCalls < canonical.work.sqliteCalls,
          'preparation plus one complete clone-like traversal queries',
        );
        assert.equal(joined(treePieces(tree)), expected, 'reusable exact traversal');
        assert.equal(tree.work.inputCodeUnits, source.length);
        assert.equal(tree.work.outputBytes, 0);
        assert.equal(
          tree.work.scratchWrittenBytes,
          canonical.work.scratchWrittenBytes - canonical.bytes,
        );
        assert.equal(tree.work.maxBufferBytes, 8192);
        if (tree.kind(tree.root) === 'object' || tree.kind(tree.root) === 'array')
          assert.throws(() => tree.pieces(tree.root), /require scalar/);
        if (tree.kind(tree.root) === 'object')
          for (const field of tree.objectFields(tree.root)) {
            const name = JSON.parse(joined(field.name())) as string;
            assert.equal(field.matches(name), true);
            assert.equal(field.matches(name + '\u0000'), false);
            assert.equal(
              joined(treePieces(tree, tree.field(tree.root, name)!)),
              joined(treePieces(tree, field.value)),
            );
          }
      } finally {
        tree.close();
        canonical.close();
      }
      assert.throws(() => joined(treePieces(tree)), /closed/);
    }
});

test('tree-only parser refuses complete malformed input and closes canceled or returned preparations', () => {
  for (const source of ['[1,]', '{"x":1} false', '"\\uZZZZ"', '1e', '{"x":true', '"\u0000"'])
    assert.throws(
      () => finishIntakeCopySteps(prepareIntakeJsonTreeSteps(split(source, 1))),
      /Invalid JSON/,
    );
  for (const cancel of [false, true]) {
    let running = true,
      closed = 0;
    const steps = prepareIntakeJsonTreeSteps(
      (function* () {
        try {
          yield* split(JSON.stringify({ fictional: 'x'.repeat(20000) }));
        } finally {
          closed++;
        }
      })(),
      {
        assertRunning() {
          if (!running) throw Error('fictional canceled tree');
        },
      },
    );
    assert.equal(steps.next().done, false);
    if (cancel) {
      running = false;
      assert.throws(() => steps.next(), /canceled tree/);
    } else steps.return(undefined as never);
    assert.equal(closed, 1);
  }
});

test('tree-only scalar readers, foreign handles and shared scratch keep their existing lifecycle refusal', () => {
  const scratch = createIntakeJsonCanonicalScratch();
  let running = true;
  const tree = finishIntakeCopySteps(
      prepareIntakeJsonTreeSteps([JSON.stringify({ fictional: 'x'.repeat(20000) })], {
        scratch,
        assertRunning() {
          if (!running) throw Error('fictional tree reader canceled');
        },
      }),
    ),
    value = tree.field(tree.root, 'fictional')!;
  try {
    const reader = tree.pieces(value)[Symbol.iterator]();
    assert.equal(reader.next().done, false);
    reader.return?.();
    const canceled = tree.pieces(value)[Symbol.iterator]();
    canceled.next();
    running = false;
    assert.throws(() => canceled.next(), /reader canceled/);
    running = true;
    assert.equal(joined(tree.pieces(value)), JSON.stringify('x'.repeat(20000)));
  } finally {
    tree.close();
  }
  const next = finishIntakeCopySteps(prepareIntakeJsonTreeSteps(['{"fictional":9}'], { scratch }));
  try {
    assert.equal(scratch.uses, 2);
    assert.equal(scratch.reuses, 1);
    assert.throws(() => next.kind(value), /Foreign/);
    assert.equal(joined(treePieces(next)), '{"fictional":9}');
  } finally {
    next.close();
    scratch.close();
  }
});

test('spool read buffers are reused only after their iterator closes', async () => {
  let running = true;
  const source = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, n) => `Fictional scalar ${n} ${'x'.repeat(40)}\ud800`),
    }),
    prepared = await prepareIntakeJsonCanonical([source], {
      mode: 'stringify',
      assertRunning() {
        if (!running) throw Error('fictional canceled');
      },
    });
  try {
    assert.equal(prepared.work.scratchReadBufferAllocations, 1);
    assert.ok(prepared.work.scratchReadBufferReuses >= 300);
    const left = prepared.chunks()[Symbol.iterator](),
      right = prepared.chunks()[Symbol.iterator]();
    const a = left.next(),
      b = right.next();
    assert.equal(a.done, false);
    assert.equal(b.done, false);
    assert.equal(a.value, b.value);
    const allocations = prepared.work.scratchReadBufferAllocations;
    assert.equal(allocations, 3);
    const leftPieces = [a.value],
      rightPieces = [b.value];
    for (;;) {
      const nextA = left.next(),
        nextB = right.next();
      assert.equal(nextA.done, nextB.done);
      if (nextA.done || nextB.done) break;
      leftPieces.push(nextA.value);
      rightPieces.push(nextB.value);
    }
    assert.equal(leftPieces.join(''), source);
    assert.equal(rightPieces.join(''), source);
    for (let n = 0; n < 3; n++) {
      const early = prepared.chunks()[Symbol.iterator]();
      assert.equal(early.next().done, false);
      early.return?.();
    }
    const failing = prepared.chunks()[Symbol.iterator]();
    failing.next();
    assert.throws(
      () => failing.throw?.(Error('fictional reader stopped')),
      /fictional reader stopped/,
    );
    const canceled = prepared.chunks()[Symbol.iterator]();
    canceled.next();
    running = false;
    assert.throws(() => canceled.next(), /fictional canceled/);
    running = true;
    assert.equal(joined(prepared.chunks()), source);
    assert.equal(prepared.work.scratchReadBufferAllocations, allocations);
  } finally {
    prepared.close();
  }
});

test('explicit preparation steps preserve engine parity and cancel without publishing a partial tree', () => {
  const source =
    '{"escaped\\u006bey":"\\ud800x\\udc00","1":-0,"same":0,"same":' +
    '9'.repeat(1300) +
    ',"name":' +
    JSON.stringify('fictional-'.repeat(54000)) +
    '}';
  const steps = prepareIntakeJsonCanonicalSteps(split(source), {
    mode: 'stringify',
    preserveNumbers: true,
  });
  let turns = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) {
      try {
        assert.deepEqual(JSON.parse(joined(next.value.chunks())), JSON.parse(source));
        assert.ok(joined(next.value.chunks()).includes('9'.repeat(1300)));
        assert.equal(next.value.work.maxBufferBytes, 8192);
        assert.ok(turns > 66);
      } finally {
        next.value.close();
      }
      break;
    }
    turns++;
  }
  let running = true,
    finalized = false;
  const canceled = prepareIntakeJsonCanonicalSteps(
    (function* () {
      try {
        yield* split(source);
      } finally {
        finalized = true;
      }
    })(),
    {
      assertRunning() {
        if (!running) throw Error('fictional stopped');
      },
    },
  );
  assert.equal(canceled.next().done, false);
  running = false;
  assert.throws(() => canceled.next(), /fictional stopped/);
  assert.equal(finalized, true);
});

test('disk canonical/stringify modes match independent JSON.parse oracles including duplicate keys and UTF16 ordering', async () => {
  const values = [
    '{"2":"two","10":"ten","a":0,"\\u0061":9,"1":1,"4294967295":4,"01":5,"0":6,"-0":7,"__proto__":{"x":1}}',
    '{"𐀀":1,"":2,"":3,"x":4,"xy":5,"x":6,"\\ud800":7,"\\udfff":8}',
    '[null,true,false,0,-0,1e400,-1e400,1e-400,{"9":9,"3":3,"a":"\\ud800\\udc00\\ud800x\\udfff"}]',
    '{"outer":{"z":1,"a":[{"q":2,"q":3},[],{}]},"outer":{"retained":4},"later":5}',
    JSON.stringify('raw \ud800 and \udfff paired 😀 / \b \t \n \f \r \\ "'),
    '123.4500e-2',
    'false',
    'null',
    '[]',
    '{}',
  ];
  for (const source of values) {
    for (const mode of ['canonical', 'stringify'] as const) {
      const prepared = await prepareIntakeJsonCanonical(split(source, 1), { mode });
      try {
        const expected =
          mode === 'canonical'
            ? canonicalLiteral(JSON.parse(source))
            : JSON.stringify(JSON.parse(source));
        assert.equal(joined(prepared.chunks()), expected, `${mode}: ${source}`);
        assert.equal(joined(prepared.chunks()), expected, 'reusable output');
        assert.equal(prepared.bytes, Buffer.byteLength(expected));
        assert.equal(prepared.work.maxBufferBytes, 8192);
      } finally {
        prepared.close();
      }
      assert.throws(() => joined(prepared.chunks()), /closed/);
    }
  }
});

test('bounded addressed handles and field splits preserve unknown member evidence without reparsing', async () => {
  const source =
    '{"z":{"unknown":[1,2]},"occurrences":[{"id":"old"},{"id":"last","id":"selected","unknown":{"10":1,"2":2}}],"a":"kept"}';
  const prepared = await prepareIntakeJsonCanonical(split(source));
  try {
    assert.equal(prepared.kind(prepared.root), 'object');
    assert.equal(prepared.field(prepared.root, 'missing'), undefined);
    const parts = prepared.splitObjectField(prepared.root, 'occurrences')!;
    assert.equal(
      joined(parts.before()) + joined(prepared.pieces(parts.value)) + joined(parts.after()),
      canonicalLiteral(JSON.parse(source)),
    );
    const before = prepared.work.inputCodeUnits;
    const expected = JSON.parse(source).occurrences;
    let n = 0;
    for (const child of prepared.arrayItems(parts.value)) {
      assert.equal(joined(prepared.pieces(child)), canonicalLiteral(expected[n++]));
      assert.equal(
        JSON.parse(joined(prepared.pieces(prepared.field(child, 'id')!))),
        expected[n - 1].id,
      );
    }
    assert.equal(n, 2);
    assert.equal(prepared.work.inputCodeUnits, before, 'addressed reads never reparse input');
    const fields = [];
    for (const entry of prepared.objectFields(prepared.root)) {
      const name = joined(entry.name());
      assert.equal(entry.matches(JSON.parse(name)), true);
      assert.equal(entry.matches('absent'), false);
      fields.push(name + ':' + joined(prepared.pieces(entry.value)));
    }
    assert.equal('{' + fields.join(',') + '}', canonicalLiteral(JSON.parse(source)));
    const other = await prepareIntakeJsonCanonical(['{}']);
    try {
      assert.throws(() => prepared.kind(other.root), /Foreign/);
    } finally {
      other.close();
    }
  } finally {
    prepared.close();
  }
});

test('long property names values and disk nesting have fixed scratch buffers and no per-value cap', async () => {
  const longKey = 'k'.repeat(32768) + '😀',
    longValue = '界😀\u0000\\'.repeat(10000);
  const source =
    '{' +
    JSON.stringify(longKey) +
    ':' +
    JSON.stringify(longValue) +
    ',"b":1,' +
    JSON.stringify(longKey) +
    ':2}';
  const prepared = await prepareIntakeJsonCanonical(split(source, 257));
  try {
    assert.equal(joined(prepared.chunks()), canonicalLiteral(JSON.parse(source)));
    assert.equal(joined(prepared.pieces(prepared.field(prepared.root, longKey)!)), '2');
    assert.ok(prepared.work.yields > 10);
    assert.ok(prepared.work.scratchWrittenBytes > prepared.bytes);
    assert.equal(prepared.work.maxBufferBytes, 8192);
  } finally {
    prepared.close();
  }
  const deep = '['.repeat(1500) + '0' + ']'.repeat(1500);
  const nested = await prepareIntakeJsonCanonical(split(deep));
  try {
    assert.equal(joined(nested.chunks()), deep);
  } finally {
    nested.close();
  }
});

test('batched string output preserves escapes and surrogate spelling across yield boundaries', async () => {
  const value = 'x'.repeat(2047) + '\ud800' + '😀' + '\b\t\n\\"' + '\udfff' + '界'.repeat(4097);
  const source = '{"long":' + JSON.stringify(value) + ',"name":"first","name":"selected"}';
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical(split(source, 1), { mode });
    try {
      const expected =
        mode === 'canonical'
          ? canonicalLiteral(JSON.parse(source))
          : JSON.stringify(JSON.parse(source));
      assert.equal(joined(prepared.chunks()), expected);
      assert.equal(prepared.bytes, Buffer.byteLength(expected));
      assert.ok(prepared.work.yields > 2);
      assert.equal(prepared.work.maxBufferBytes, 8192);
    } finally {
      prepared.close();
    }
  }
});

test('binary64 canonical numbers match JSON.parse and the retained scalar hasher without long number materialization', async () => {
  const numbers = [
    '1' + '0'.repeat(8000) + 'e-8000',
    '0.' + '0'.repeat(9000) + '1e9001',
    '1.' + '0'.repeat(1400) + '1',
    '1.7976931348623157e308',
    '4.9406564584124654e-324',
    '-0e999999999999999999999999999',
    '9e99999999999999999999',
    '2.225073858507201136057409796709131975934819546351645648023426109' +
      '0'.repeat(1600) +
      'e-308',
  ];
  for (const number of numbers) {
    const prepared = await prepareIntakeJsonCanonical(split(number, 13));
    try {
      const actual = joined(prepared.chunks()),
        expected = JSON.stringify(JSON.parse(number));
      assert.equal(actual, expected);
      assert.equal(
        createHash('sha256')
          .update('[' + actual + ']')
          .digest('hex'),
        hashIntakeJsonScalar(split(number, 3)).hash,
      );
      assert.ok(prepared.work.maxNumberDigits <= 1201);
    } finally {
      prepared.close();
    }
  }
});

test('literal number mode preserves exact valid tokens with bounded buffers and unchanged default normalization', async () => {
  const large = '1' + '0'.repeat(32768) + 'e-32768';
  const source = '{"z":12.00,"a":[-0,1.20E+003,9e99999,' + large + '],"z":13.00}';
  const literal = parseLiteralJSON('{"z":13.00,"a":[-0,1.20E+003,9e99999,' + large + ']}');
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical(split(source, 13), {
      mode,
      preserveNumbers: true,
    });
    try {
      const expected = mode === 'canonical' ? canonicalLiteral(literal) : JSON.stringify(literal);
      assert.equal(joined(prepared.chunks()), expected);
      assert.equal(prepared.bytes, Buffer.byteLength(expected));
      assert.equal(prepared.work.maxBufferBytes, 8192);
      assert.ok(prepared.work.maxChunkBytes <= 8192);
      assert.ok(prepared.work.maxNumberDigits <= 1201);
      assert.ok(prepared.work.yields > 0);
    } finally {
      prepared.close();
    }
  }
  const normalized = await prepareIntakeJsonCanonical(split(source));
  try {
    assert.equal(joined(normalized.chunks()), canonicalLiteral(JSON.parse(source)));
  } finally {
    normalized.close();
  }
  for (const invalid of ['01', '-01', '1.', '1e', '1e+', '+1', '--1'])
    await assert.rejects(
      prepareIntakeJsonCanonical(split(invalid, 1), { preserveNumbers: true }),
      /Invalid/,
    );
});

test('many unknown properties use disk sort and duplicate last-value semantics in both modes', async () => {
  const fields = Array.from(
    { length: 1500 },
    (_, i) => JSON.stringify('key-' + (1500 - i)) + ':' + i,
  );
  fields.push('"key-100":99999');
  const source = '{' + fields.join(',') + '}';
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical(split(source, 1024), { mode });
    try {
      assert.equal(
        joined(prepared.chunks()),
        mode === 'canonical'
          ? canonicalLiteral(JSON.parse(source))
          : JSON.stringify(JSON.parse(source)),
      );
      assert.equal(prepared.work.maxBufferBytes, 8192);
      assert.ok(prepared.work.yields > 1);
    } finally {
      prepared.close();
    }
  }
});

test('syntax failures and cancellation close their source iterators and never return partial output', async () => {
  for (const text of [
    '{"a":1,}',
    '[1,]',
    '{"a" 1}',
    '01',
    '1e',
    '"\\u00x0"',
    '"unterminated',
    'true false',
    '\u00a0null',
  ]) {
    let closed = false;
    function* source() {
      try {
        yield* split(text, 1);
      } finally {
        closed = true;
      }
    }
    await assert.rejects(prepareIntakeJsonCanonical(source()), /Invalid/);
    assert.equal(closed, true);
  }
  let closed = false,
    checks = 0;
  function* source() {
    try {
      yield* split('[' + '0,'.repeat(10000) + '0]', 100);
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    prepareIntakeJsonCanonical(source(), {
      assertRunning() {
        if (++checks === 2) throw Error('fictional cancellation');
      },
    }),
    /fictional cancellation/,
  );
  assert.equal(closed, true);
});

test('deterministic differential objects arrays duplicate names and rounding boundaries match both JS oracles', async () => {
  let seed = 231;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const keys = [
    '',
    'a',
    '__proto__',
    '10',
    '2',
    '4294967294',
    '4294967295',
    '01',
    '𐀀',
    '',
    '\ud800',
    'constructor',
  ];
  const scalars = [
    'null',
    'true',
    'false',
    '-0',
    '1e400',
    '0.0000001',
    '9007199254740993',
    '"\\ud800"',
    '"\\ud800\\udc00"',
    '"a\\nb"',
  ];
  const value = (depth: number): string => {
    const kind = depth ? random(3) : 0;
    if (kind === 0) return scalars[random(scalars.length)]!;
    const n = random(6),
      parts = [];
    for (let at = 0; at < n; at++)
      parts.push(
        (kind === 1 ? JSON.stringify(keys[random(keys.length)]) + ':' : '') + value(depth - 1),
      );
    return (kind === 1 ? '{' : '[') + parts.join(',') + (kind === 1 ? '}' : ']');
  };
  const sources = Array.from({ length: 100 }, () => value(4));
  const halfway = '1.00000000000000011102230246251565404236316680908203125';
  sources.push(halfway, halfway + '0'.repeat(2000) + '1');
  for (const source of sources)
    for (const mode of ['canonical', 'stringify'] as const) {
      const prepared = await prepareIntakeJsonCanonical(split(source, random(17) + 1), { mode });
      try {
        assert.equal(
          joined(prepared.chunks()),
          mode === 'canonical'
            ? canonicalLiteral(JSON.parse(source))
            : JSON.stringify(JSON.parse(source)),
        );
        assert.ok(prepared.work.maxChunkBytes <= 8195);
      } finally {
        prepared.close();
      }
    }
});

test('work observer reports successful rereads and failed preparation once without retaining identities', async () => {
  const snapshots: Readonly<IntakeJsonCanonicalWork>[] = [];
  const prepared = await prepareIntakeJsonCanonical(['{"fictional":1}'], {
    onWork: (work) => snapshots.push(work),
  });
  assert.equal(snapshots.length, 0);
  joined(prepared.chunks());
  joined(prepared.chunks());
  const readBytes = prepared.work.scratchReadBytes;
  prepared.close();
  prepared.close();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.scratchReadBytes, readBytes);
  assert.ok(Object.values(snapshots[0]!).every((value) => typeof value === 'number'));
  await assert.rejects(
    prepareIntakeJsonCanonical(['{"broken":1,}'], { onWork: (work) => snapshots.push(work) }),
  );
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots[1]!.inputCodeUnits > 0);
});

test('database work bridge accumulates spool calls and bytes while keeping true high-water values', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const onWork = intakeJsonCanonicalWorkObserver(db, 'reconstruction');
    for (let n = 0; n < 2; n++) {
      const prepared = await prepareIntakeJsonCanonical(['{"fictional":"界"}'], { onWork });
      try {
        joined(prepared.chunks());
      } finally {
        prepared.close();
      }
    }
    await assert.rejects(prepareIntakeJsonCanonical(['[1,]'], { onWork }));
    const counters = intakeWorkCounters(db);
    assert.equal(counters.warm.jsonCanonicalSqliteCalls, 0);
    assert.ok(counters.reconstruction.jsonCanonicalSqliteCalls > 0);
    assert.ok(
      counters.reconstruction.jsonCanonicalInputCodeUnits > 2 * '{"fictional":"界"}'.length,
    );
    assert.equal(counters.reconstruction.jsonCanonicalPeakBufferBytes, 8192);
    assert.equal(
      counters.reconstruction.jsonCanonicalPeakChunkBytes,
      Buffer.byteLength('{"fictional":"界"}'),
    );
    assert.equal(
      counters.reconstruction.jsonCanonicalOutputBytes,
      2 * Buffer.byteLength('{"fictional":"界"}'),
    );
  } finally {
    db.close();
  }
});

test('row and member caches keep SQLite lookups per value and per matched member bounded', async () => {
  // 300 fictional objects, each with five members and one nested object: 2701 values.
  const items = Array.from({ length: 300 }, (_, index) => ({
    op: 'set',
    path: ['fictional', String(index)],
    value: { n: index, s: 'fictional' },
    note: 'fictional note',
    extra: true,
  }));
  const values = 300 * 9 + 1,
    names = ['op', 'path', 'value', 'note', 'extra'];
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical([JSON.stringify(items)], {
      mode,
      preserveNumbers: mode === 'stringify',
    });
    try {
      const preparation = prepared.work.sqliteCalls;
      // Uncached and written through, preparation re-read each node row ~11
      // times and rewrote it ~8 times per value (33.7 and 24.1 calls/value).
      assert.ok(
        preparation <= (mode === 'canonical' ? 24 : 14) * values,
        `${mode} preparation ${preparation} SQLite calls for ${values} values`,
      );
      let before = prepared.work.sqliteCalls,
        matched = 0;
      for (const item of prepared.arrayItems(prepared.root)) {
        for (const member of prepared.objectFields(item)) {
          assert.ok(names.some((name) => member.matches(name)));
          matched++;
        }
        const beforeFields = prepared.work.sqliteCalls;
        for (const name of names) assert.notEqual(prepared.field(item, name), undefined);
        assert.equal(
          prepared.work.sqliteCalls,
          beforeFields,
          'matched short fields need no lookup',
        );
      }
      assert.equal(matched, 300 * 5);
      const matching = prepared.work.sqliteCalls - before;
      // Five array pages plus one member page per object; matching itself does
      // not rediscover a short name with another SQLite query.
      assert.equal(matching, 305, `${mode} matching SQLite calls for 300 objects`);
      before = prepared.work.sqliteCalls;
      for (const item of prepared.arrayItems(prepared.root))
        for (const name of names) assert.notEqual(prepared.field(item, name), undefined);
      const fields = prepared.work.sqliteCalls - before;
      assert.ok(fields <= 30 * 300, `${mode} field reads ${fields} SQLite calls for 300 objects`);
      console.info(
        JSON.stringify({
          fixture: 'fictional-canonical-lookups',
          mode,
          values,
          preparation,
          matching,
          fields,
        }),
      );
    } finally {
      prepared.close();
    }
  }
});

test('short member matching keeps exact UTF-16 identity and falls back beyond its bound', async () => {
  const short = 'x'.repeat(256),
    longer = 'x'.repeat(257),
    multi = 'x'.repeat(INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS + 1),
    names = ['', 'op', '\ud800', '\udc00', '\u0000', short, longer, multi];
  const source =
    '{' + names.map((name, index) => JSON.stringify(name) + ':' + index).join(',') + ',"op":99}';
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical(split(source, 13), { mode });
    let closedMember: { matches(name: string): boolean } | undefined;
    try {
      const members = [...prepared.objectFields(prepared.root)];
      for (const member of members) {
        const name = JSON.parse(joined(member.name())) as string,
          before = prepared.work.sqliteCalls;
        assert.equal(member.matches(name), true);
        const matching = prepared.work.sqliteCalls - before;
        assert.equal(matching, name.length <= 256 ? 0 : Math.ceil(name.length / 1024));
        assert.equal(member.matches(name + '\u0000'), false);
        assert.equal(member.matches('absent'), false);
        const value = prepared.field(prepared.root, name)!;
        assert.equal(
          joined(prepared.pieces(value)),
          String(name === 'op' ? 99 : names.indexOf(name)),
        );
      }
      assert.equal(
        prepared.field(prepared.root, 'absent'),
        undefined,
        'mismatches never seed absence',
      );
      closedMember = members[0];
    } finally {
      prepared.close();
    }
    assert.throws(() => closedMember!.matches(''), /closed/);
  }
});

// Old engine order: one index edge per UTF-16 code unit, visited in ascending
// unit order, a name before its extensions. That is JS code-unit comparison;
// it is spelled out here independently of Array.prototype.sort.
function codeUnitOrder(left: string, right: string): number {
  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    const difference = left.charCodeAt(at) - right.charCodeAt(at);
    if (difference) return difference;
  }
  return left.length - right.length;
}

test('member names around index chunk boundaries keep exact code-unit order and lookups in both modes', async () => {
  const width = INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS;
  let seed = 4231;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % max;
  };
  // UTF-8 byte order and UTF-16 unit order disagree for U+E000..U+FFFF versus
  // surrogates; BOM, NUL and lone surrogates are ordinary name units here.
  const units = ['\u0000', '﻿', '\ud800', '\udbff', '\udc00', '\udfff', '', '￿'];
  units.push('a', 'b', '0', '1', '9', '界', '\u007f', '"', '\\', '\n', '\u001f');
  const pair = ['😀', '􏿿', '𐀀'];
  const piece = () => (random(5) === 0 ? pair[random(pair.length)]! : units[random(units.length)]!);
  const lengths = [0, 1, 2, 9, 10, 11];
  if (width > 1)
    lengths.push(width - 2, width - 1, width, width + 1, 2 * width - 1, 2 * width, 2 * width + 1);
  const prefixes = ['', 'x'.repeat(Math.max(0, width - 1)), 'x'.repeat(width), 'fictional-'];
  const name = () => {
    let text = prefixes[random(prefixes.length)]!;
    const length = lengths[random(lengths.length)]!;
    while (text.length < length) text += piece();
    return text;
  };
  // Raw or escaped spelling of the same decoded name, including split pairs.
  const spell = (text: string) => {
    let out = '"';
    for (const char of text) {
      for (let at = 0; at < char.length; at++) {
        const code = char.charCodeAt(at);
        const raw = code >= 0x20 && code !== 0x22 && code !== 0x5c;
        out +=
          raw && random(3)
            ? char[at]
            : code === 0x22 || code === 0x5c
              ? '\\' + char[at]
              : '\\u' + code.toString(16).padStart(4, random(2) ? '0' : '0');
      }
    }
    return out + '"';
  };
  for (let round = 0; round < 24; round++) {
    const names = Array.from({ length: 12 + random(12) }, name);
    // Duplicate some names: first position, last value.
    for (let n = 0; n < 4; n++) names.push(names[random(names.length)]!);
    const members = names.map((key, index) => spell(key) + ':' + index);
    const nested = '{' + members.slice(0, 6).join(',') + '}';
    const source = '{' + members.join(',') + ',' + spell(names[0]!) + ':[' + nested + ']}';
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const ordered = Object.keys(parsed).sort(codeUnitOrder);
    assert.deepEqual(ordered, Object.keys(parsed).sort(), 'oracles agree');
    for (const mode of ['canonical', 'stringify'] as const) {
      const prepared = await prepareIntakeJsonCanonical(split(source, random(29) + 1), { mode });
      try {
        const expected = mode === 'canonical' ? canonicalLiteral(parsed) : JSON.stringify(parsed);
        assert.equal(joined(prepared.chunks()), expected, `${mode} round ${round}`);
        const fields = [...prepared.objectFields(prepared.root)].map((entry) => ({
          name: JSON.parse(joined(entry.name())) as string,
          entry,
        }));
        assert.deepEqual(
          fields.map((field) => field.name),
          mode === 'canonical' ? ordered : Object.keys(parsed),
        );
        for (const { name: key, entry } of fields) {
          assert.equal(entry.matches(key), true);
          assert.equal(entry.matches(key + '\u0000'), false);
          const value = prepared.field(prepared.root, key)!;
          assert.equal(
            joined(prepared.pieces(value)),
            mode === 'canonical' ? canonicalLiteral(parsed[key]) : JSON.stringify(parsed[key]),
          );
        }
        for (const absent of ['\ud800\u0000', 'x'.repeat(width + 3), '﻿﻿﻿'])
          if (!Object.hasOwn(parsed, absent))
            assert.equal(prepared.field(prepared.root, absent), undefined);
      } finally {
        prepared.close();
      }
    }
  }
});

test('member-name index rows and SQLite calls scale with members, not name characters', async () => {
  // 120 fictional objects, each with six 40- to 90-unit names, plus one long name.
  const long = 'fictional-long-name-'.repeat(400);
  const names = Array.from(
    { length: 6 },
    (_, index) => `fictional-member-${index}-` + 'segment-'.repeat(3 + index * 2),
  );
  const objects = Array.from({ length: 120 }, (_, item) =>
    Object.fromEntries(names.map((key, index) => [key, item * 10 + index])),
  );
  const source = JSON.stringify({ items: objects, [long]: 'fictional' });
  const values = 1 + 1 + 1 + 120 * 7 + 1,
    objectsCount = 121,
    rowsPerName = (text: string) => Math.ceil(text.length / INTAKE_JSON_CANONICAL_KEY_CHUNK_UNITS);
  const expectedRows =
    objectsCount +
    120 * names.reduce((total, key) => total + rowsPerName(key), 0) +
    rowsPerName('items') +
    rowsPerName(long);
  for (const mode of ['canonical', 'stringify'] as const) {
    const prepared = await prepareIntakeJsonCanonical(split(source, 4096), { mode });
    try {
      assert.equal(
        joined(prepared.chunks()),
        mode === 'canonical'
          ? canonicalLiteral(JSON.parse(source))
          : JSON.stringify(JSON.parse(source)),
      );
      const characters = 120 * names.reduce((total, key) => total + key.length, 0);
      // The previous per-unit index wrote one row per name character (~59,000).
      assert.ok(
        prepared.work.keyIndexRows <= expectedRows,
        `${mode} ${prepared.work.keyIndexRows} index rows for ${values} values`,
      );
      assert.ok(prepared.work.keyIndexRows < characters / 20);
      assert.ok(
        prepared.work.sqliteCalls <= 16 * values,
        `${mode} ${prepared.work.sqliteCalls} SQLite calls for ${values} values`,
      );
      console.info(
        JSON.stringify({
          fixture: 'fictional-canonical-name-index',
          mode,
          values,
          characters,
          keyIndexRows: prepared.work.keyIndexRows,
          sqliteCalls: prepared.work.sqliteCalls,
        }),
      );
    } finally {
      prepared.close();
    }
  }
});

test('a reused canonical scratch set matches fresh preparations and expires earlier handles', async () => {
  const values = [
    '{"b":[1,2,{"z":"' + 'fictional-'.repeat(3000) + '"}],"a":"x","10":true,"2":null}',
    '{"short":1}',
    '["\\ud800x",{"k":"v","a":[]},-0.5e3]',
    '"fictional scalar"',
  ];
  const scratch = createIntakeJsonCanonicalScratch();
  try {
    for (const mode of ['canonical', 'stringify'] as const)
      for (const source of values) {
        const fresh = await prepareIntakeJsonCanonical(split(source), { mode });
        const expected = joined(fresh.chunks());
        fresh.close();
        const reused = await prepareIntakeJsonCanonical(split(source), { mode, scratch });
        assert.equal(joined(reused.chunks()), expected);
        const root = reused.root;
        reused.close();
        assert.throws(() => reused.kind(root), /closed/);
      }
    // A failed preparation leaves the set reusable from emptied state.
    await assert.rejects(
      prepareIntakeJsonCanonical(split('{"a":1,"a":'), { scratch }),
      /Invalid JSON canonical input/,
    );
    const held = await prepareIntakeJsonCanonical(split('{"b":2,"a":1}'), { scratch });
    // One preparation at a time: a second one is refused while the first is open.
    await assert.rejects(prepareIntakeJsonCanonical(split('1'), { scratch }), /in use/);
    assert.throws(() => scratch.close(), /in use/);
    assert.equal(joined(held.chunks()), '{"a":1,"b":2}');
    held.close();
    assert.equal(scratch.uses, 2 * values.length + 2);
    assert.equal(scratch.reuses, scratch.uses - 1);
  } finally {
    scratch.close();
  }
  await assert.rejects(prepareIntakeJsonCanonical(split('1'), { scratch }), /closed/);
});
