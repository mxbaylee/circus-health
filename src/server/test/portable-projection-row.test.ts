import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareIntakeJsonCanonicalSteps,
  type PreparedIntakeJsonCanonical,
} from '../intake-json-canonical.ts';
import { portableProjectionCells } from '../portable-projection-row.ts';

function parsed(raw: string): PreparedIntakeJsonCanonical {
  const pieces = function* () {
    for (let at = 0; at < raw.length; at += 4096) yield raw.slice(at, at + 4096);
  };
  const steps = prepareIntakeJsonCanonicalSteps(pieces(), { mode: 'stringify' });
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

test('portable projection cells preserve JSON.parse/Stringify scalar semantics', () => {
  const text = 'Ω😀'.repeat(30_000) + '\u0000\ud800';
  const row = parsed(
    `{"id":"fictional","note":"old","quantity":7,"large":1e309,"optional":null,"note":${JSON.stringify(text)}}`,
  );
  try {
    const cells = portableProjectionCells(row, ['id', 'note', 'quantity', 'large', 'optional']);
    assert.deepEqual(
      cells.map((cell) => cell.name),
      ['id', 'note', 'quantity', 'large', 'optional'],
    );
    const values = Object.fromEntries(
      cells.map((cell) => [
        cell.name,
        cell.kind === 'text'
          ? [...cell.pieces()].join('')
          : cell.kind === 'number'
            ? cell.value
            : null,
      ]),
    );
    assert.deepEqual(values, {
      id: 'fictional',
      note: text,
      quantity: 7,
      large: null,
      optional: null,
    });
  } finally {
    row.close();
  }
});

test('portable projection refuses unknown giant keys and unsupported values', () => {
  const unknown = parsed(`{"${'x'.repeat(100_000)}":"value"}`);
  try {
    assert.throws(
      () => portableProjectionCells(unknown, ['id']),
      /Unknown portable projection column/,
    );
  } finally {
    unknown.close();
  }
  const boolean = parsed('{"id":true}');
  try {
    assert.throws(
      () => portableProjectionCells(boolean, ['id']),
      /Unsupported portable projection value/,
    );
  } finally {
    boolean.close();
  }
});
