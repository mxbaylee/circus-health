import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIntakeJsonLexical } from '../intake-json-lexical.ts';

test('lexical spans preserve duplicate names, escapes, primitive tokens and giant strings without a value buffer', async () => {
  const text =
    ' { "same": 1, "s\\u0061me": [true, null, {"🌿":"' +
    'Fictional🌿'.repeat(20000) +
    '"}], "last":-1.23e+4 } \n';
  const parsed = await prepareIntakeJsonLexical(
    (function* () {
      for (let i = 0; i < text.length; i += 31) yield text.slice(i, i + 31);
    })(),
  );
  try {
    assert.equal([...parsed.pieces(0, text.length)].join(''), text);
    const fields = [...parsed.children(parsed.root)];
    assert.equal(fields.length, 3);
    assert.deepEqual(
      fields.map((f) => [...parsed.pieces(f.nameStart!, f.nameEnd!)].join('')),
      ['"same"', '"s\\u0061me"', '"last"'],
    );
    const values = [...parsed.children(fields[1]!)];
    assert.deepEqual(
      values.map((f) => f.shape),
      ['scalar', 'scalar', 'object'],
    );
    assert.equal(
      JSON.parse([...parsed.pieces(fields[1]!.start, fields[1]!.end)].join(''))[2]['🌿'],
      'Fictional🌿'.repeat(20000),
    );
    assert.ok(parsed.work.peakBufferBytes <= 8192);
    assert.equal(parsed.work.nodes, 8);
  } finally {
    parsed.close();
  }
  assert.throws(() => [...parsed.pieces(0, 1)], /Invalid lexical span/);
});

test('lexical preparation refuses malformed JSON and closes on cancellation', async () => {
  for (const text of ['[1,]', '{"one":}', '"unterminated'])
    await assert.rejects(prepareIntakeJsonLexical([text]), /JSON syntax/);
  let closed = false,
    calls = 0;
  await assert.rejects(
    prepareIntakeJsonLexical(['[1,2,3]'], {
      assertRunning() {
        if (++calls > 2) throw Error('Fictional cancellation');
      },
      onWork() {
        closed = true;
      },
    }),
    /Fictional cancellation/,
  );
  assert.equal(closed, true);
});

test('lexical preparation yields during a single growing string token', async () => {
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  await assert.rejects(
    prepareIntakeJsonLexical(['"' + 'Fictional'.repeat(10000) + '"'], {
      assertRunning() {
        if (cancelled) throw Error('Fictional scheduled cancellation');
      },
    }),
    /Fictional scheduled cancellation/,
  );
});
