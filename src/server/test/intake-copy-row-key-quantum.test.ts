import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  intakeCopySerializedRowKeySteps,
  type IntakeCopyRowKeyQuantum,
} from '../intake-copy-json.ts';

function measuredKey(pieces: readonly string[]): { key: string; steps: number } {
  const work = intakeCopySerializedRowKeySteps(pieces);
  let steps = 0;
  for (;;) {
    const next = work.next();
    if (next.done) return { key: next.value, steps };
    steps++;
  }
}

function previousKey(pieces: readonly string[]): string {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const piece of pieces) {
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
  }
  return `${bytes}:${hash.digest('hex')}`;
}

test('serialized copy row keys share bounded syntax quanta without changing bytes or hash', () => {
  const syntax = Array.from({ length: 512 }, (_, index) => (index % 2 ? ':' : '"key"'));
  assert.deepEqual(measuredKey(syntax), { key: previousKey(syntax), steps: 8 });

  const long = 'a'.repeat(4095) + '\ud83d\ude00' + 'z'.repeat(80 * 1024);
  const large = measuredKey([long]);
  assert.equal(large.key, previousKey([long]));
  assert.ok(large.steps >= 5 && large.steps <= 7);

  const empty = Array.from({ length: 129 }, () => '');
  assert.deepEqual(measuredKey(empty), { key: previousKey(empty), steps: 3 });
});

test('hundreds of small row hashes share bounded comparison quanta', () => {
  const quantum: IntakeCopyRowKeyQuantum = { bytes: 0, parts: 0, rows: 0 };
  const keys: string[] = [];
  let steps = 0;
  for (let index = 0; index < 512; index++) {
    const pieces = ['{"value":', String(index % 17), '}'];
    const work = intakeCopySerializedRowKeySteps(pieces, quantum);
    for (;;) {
      const next = work.next();
      if (next.done) {
        keys.push(next.value);
        break;
      }
      assert.ok(quantum.bytes <= 16 * 1024 && quantum.parts <= 64 && quantum.rows <= 64);
      steps++;
    }
    if (++quantum.rows === 64) {
      steps++;
      quantum.bytes = quantum.parts = quantum.rows = 0;
    }
    assert.ok(quantum.bytes <= 16 * 1024 && quantum.parts <= 64 && quantum.rows <= 64);
    assert.equal(keys[index], previousKey(pieces));
  }
  if (quantum.rows || quantum.parts) steps++;
  assert.ok(steps >= 8 && steps <= 32, 'small rows do not each force a full copy guard');
  assert.equal(new Set(keys).size, 17, 'repeated rows retain exact multiplicity keys');
});
