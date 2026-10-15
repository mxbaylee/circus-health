import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortableSourceIndex } from '../portable-source-index.ts';

const pieces = (text: string) =>
  function* () {
    for (let at = 0; at < text.length; at += 4093) yield text.slice(at, at + 4093);
  };

test('fictional long source IDs resolve exactly to selected lexical rows', () => {
  const index = createPortableSourceIndex(() => {});
  const prefix = 'fictional-id-🌿'.repeat(70_000);
  const first = prefix + '-first';
  const second = prefix + '-second';
  const firstRow = JSON.stringify({ id: first, details_json: 'fictional-first' });
  const secondRow = JSON.stringify({ id: second, details_json: 'fictional-second' });
  try {
    index.add(pieces(first), pieces(firstRow));
    index.add(pieces(second), pieces(secondRow));
    const selected = index.find(pieces(second));
    assert.ok(selected);
    assert.equal([...selected()].join(''), secondRow);
    assert.equal(index.find(pieces(prefix + '-absent')), undefined);
    assert.equal([...index.find(pieces(first))!()].join(''), firstRow);
  } finally {
    index.close();
  }
});

test('incomplete lexical row consumption poisons the private index', () => {
  const index = createPortableSourceIndex(() => {});
  try {
    index.add(pieces('fictional-source'), pieces('{"id":"fictional-source"}'));
    const selected = index.find(pieces('fictional-source'))!;
    const cursor = selected()[Symbol.iterator]();
    assert.equal(cursor.next().done, false);
    cursor.return?.();
    assert.throws(() => index.find(pieces('fictional-source')), /unavailable/);
  } finally {
    index.close();
  }
});

test('requested ID drift refuses instead of selecting a later source', () => {
  const index = createPortableSourceIndex(() => {});
  try {
    index.add(pieces('fictional-one'), pieces('{"row":1}'));
    index.add(pieces('fictional-two'), pieces('{"row":2}'));
    let calls = 0;
    assert.throws(
      () => index.find(() => pieces(++calls === 1 ? 'fictional-one' : 'fictional-two')()),
      /requested source ID changed/,
    );
    assert.equal(calls, 2);
    assert.throws(() => index.find(pieces('fictional-one')), /unavailable/);
  } finally {
    index.close();
  }
});

test('duplicate exact selected IDs refuse', () => {
  const index = createPortableSourceIndex(() => {});
  try {
    index.add(pieces('fictional-duplicate'), pieces('{"row":1}'));
    index.add(pieces('fictional-duplicate'), pieces('{"row":2}'));
    assert.throws(() => index.find(pieces('fictional-duplicate')), /Duplicate portable source ID/);
  } finally {
    index.close();
  }
});

test('checkpoint cannot reenter lookup or add before the first read', () => {
  let index!: ReturnType<typeof createPortableSourceIndex>;
  let reenter = false;
  index = createPortableSourceIndex(() => {
    if (!reenter) return;
    reenter = false;
    assert.throws(() => index.add(pieces('injected'), pieces('{}')), /reentry/);
  });
  try {
    index.add(pieces('fictional-source'), pieces('{"row":1}'));
    reenter = true;
    assert.throws(() => index.find(pieces('fictional-source')), /unavailable/);
    assert.throws(() => index.find(pieces('fictional-source')), /unavailable/);
  } finally {
    index.close();
  }
});
