import type {
  IntakeJsonCanonicalHandle,
  PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';

/** Reuse the scalar decoder's JSON.parse-compatible UTF-16 unit stream. */
export function* portableJsonStringPieces(
  parsed: PreparedIntakeJsonCanonical,
  handle: IntakeJsonCanonicalHandle,
): Generator<string> {
  if (parsed.kind(handle) !== 'string') throw Error('Portable JSON field is not text');
  let pending = '';
  const steps = hashIntakeJsonScalarSteps(parsed.pieces(handle), [], (unit) => {
    pending += unit;
  });
  const flush = (final: boolean) => {
    const size = !final && /[\uD800-\uDBFF]$/.test(pending) ? pending.length - 1 : pending.length;
    const ready = pending.slice(0, size);
    pending = pending.slice(size);
    return ready;
  };
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) {
        if (next.value.kind !== 'string') throw Error('Portable JSON field is not text');
        const final = flush(true);
        if (final) yield final;
        return;
      }
      const piece = flush(false);
      if (piece) yield piece;
    }
  } finally {
    steps.return(undefined as never);
  }
}
