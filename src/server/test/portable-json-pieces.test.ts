import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareIntakeJsonCanonicalSteps,
  type PreparedIntakeJsonCanonical,
} from '../intake-json-canonical.ts';
import { portableJsonStringPieces } from '../portable-json-pieces.ts';

test('portable string pieces preserve JSON.parse text and UTF-8 across boundaries', () => {
  const value =
    'a'.repeat(4093) + '😀' + 'Ω'.repeat(80_000) + '\u0000\n\t' + '\ud800' + '\ud83d\ude00';
  const encoded = JSON.stringify({ value });
  const source = function* () {
    for (let at = 0; at < encoded.length; at += 4096) yield encoded.slice(at, at + 4096);
  };
  const steps = prepareIntakeJsonCanonicalSteps(source(), { mode: 'stringify' });
  let tree: PreparedIntakeJsonCanonical | undefined;
  for (;;) {
    const next = steps.next();
    if (next.done) {
      tree = next.value;
      break;
    }
  }
  assert.ok(tree);
  try {
    const handle = tree.field(tree.root, 'value');
    assert.ok(handle);
    const pieces = [...portableJsonStringPieces(tree, handle)];
    assert.ok(pieces.length > 4);
    assert.ok(pieces.every((piece) => piece.length <= 4097));
    assert.equal(pieces.join(''), value);
    assert.deepEqual(Buffer.concat(pieces.map((piece) => Buffer.from(piece))), Buffer.from(value));
  } finally {
    tree.close();
  }
});
