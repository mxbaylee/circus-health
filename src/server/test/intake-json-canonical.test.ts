import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalLiteral, parseLiteralJSON } from '../intake-format.ts';
import {
  prepareIntakeJsonCanonical,
  intakeJsonCanonicalWorkObserver,
} from '../intake-json-canonical.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import type { IntakeJsonCanonicalWork } from '../intake-json-canonical.ts';
import { hashIntakeJsonScalar } from '../intake-json-scalar.ts';

function* split(text: string, width = 7) {
  for (let at = 0; at < text.length; at += width) yield text.slice(at, at + width);
}
const joined = (pieces: Iterable<string>) => [...pieces].join('');

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
