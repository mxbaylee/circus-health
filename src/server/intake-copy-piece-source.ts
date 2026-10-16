/** A private, re-iterable text source. A cursor never becomes selected authority;
 * callers retain the original managed read interval around every traversal. */
import { intakeCopyTextPieces } from './intake-copy-json.ts';

const pieceSourceBrand: unique symbol = Symbol('intake-copy-piece-source');
const ownedSources = new WeakSet<object>();

export interface IntakeCopyPieceSource {
  readonly [pieceSourceBrand]: true;
  pieces(): Iterable<string>;
}

export function intakeCopyPieceSource(pieces: () => Iterable<string>): IntakeCopyPieceSource {
  const source = Object.freeze({ [pieceSourceBrand]: true as const, pieces });
  ownedSources.add(source);
  return source;
}

export function isIntakeCopyPieceSource(value: unknown): value is IntakeCopyPieceSource {
  return typeof value === 'object' && value !== null && ownedSources.has(value);
}

export function intakeCopySourcePieces(source: string | IntakeCopyPieceSource): Iterable<string> {
  if (typeof source === 'string') return intakeCopyTextPieces(source);
  if (!isIntakeCopyPieceSource(source)) throw new Error('invalid copy piece source');
  return source.pieces();
}

export function intakeCopyPieceCursor(actual: Iterable<string>, mismatch: () => never) {
  const iterator = actual[Symbol.iterator]();
  let current = '',
    at = 0,
    closed = false;
  const next = (): boolean => {
    while (at === current.length) {
      const item = iterator.next();
      if (item.done) return false;
      current = item.value;
      at = 0;
    }
    return true;
  };
  return {
    compare(piece: string): void {
      for (let offset = 0; offset < piece.length;) {
        if (!next()) mismatch();
        const length = Math.min(piece.length - offset, current.length - at);
        if (current.slice(at, at + length) !== piece.slice(offset, offset + length)) mismatch();
        at += length;
        offset += length;
      }
    },
    finish(): void {
      if (next()) mismatch();
    },
    close(): void {
      if (closed) return;
      closed = true;
      iterator.return?.(undefined);
    },
  };
}

/** Compare exact UTF-16 code units across independently chunked streams. */
export function* compareIntakeCopyPiecesSteps(
  actual: Iterable<string>,
  expected: Iterable<string | void>,
  mismatch: () => never,
): Generator<void> {
  const iterator = actual[Symbol.iterator]();
  let current = '',
    at = 0;
  const next = (): boolean => {
    while (at === current.length) {
      const item = iterator.next();
      if (item.done) return false;
      current = item.value;
      at = 0;
    }
    return true;
  };
  try {
    for (const piece of expected) {
      if (piece === undefined) {
        yield;
        continue;
      }
      for (let offset = 0; offset < piece.length;) {
        if (!next()) mismatch();
        const length = Math.min(piece.length - offset, current.length - at);
        if (current.slice(at, at + length) !== piece.slice(offset, offset + length)) mismatch();
        at += length;
        offset += length;
        yield;
      }
    }
    if (next()) mismatch();
  } finally {
    iterator.return?.(undefined);
  }
}
