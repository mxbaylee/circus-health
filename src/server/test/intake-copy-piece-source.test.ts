import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareIntakeCopyPiecesSteps,
  intakeCopyPieceSource,
  intakeCopySourcePieces,
  isIntakeCopyPieceSource,
} from '../intake-copy-piece-source.ts';
import { finishIntakeCopySteps } from '../intake-copy-work.ts';

test('copy piece sources require a private owned handle and preserve exact UTF-16 units', () => {
  const value = 'fictional-' + 'x'.repeat(9000) + '😀';
  const source = intakeCopyPieceSource(() => [value.slice(0, 4000), value.slice(4000)]);
  assert.equal(isIntakeCopyPieceSource(source), true);
  assert.equal([...intakeCopySourcePieces(source)].join(''), value);
  assert.ok([...intakeCopySourcePieces(value)].every((part) => part.length <= 4096));
  assert.equal(isIntakeCopyPieceSource({ pieces: () => [value] }), false);
  assert.throws(
    () => [...intakeCopySourcePieces({ pieces: () => [value] } as never)],
    /invalid copy piece source/,
  );
  finishIntakeCopySteps(
    compareIntakeCopyPiecesSteps(source.pieces(), [value.slice(0, 8000), value.slice(8000)], () => {
      throw Error('fictional mismatch');
    }),
  );
  assert.throws(
    () =>
      finishIntakeCopySteps(
        compareIntakeCopyPiecesSteps(source.pieces(), [value + 'z'], () => {
          throw Error('fictional mismatch');
        }),
      ),
    /fictional mismatch/,
  );
});
