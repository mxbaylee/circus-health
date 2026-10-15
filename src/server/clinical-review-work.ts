import { setImmediate } from 'node:timers/promises';

/** One policy implementation supports transaction-bound callers and cooperative reads. */
export function finishClinicalReviewWork<T>(work: Generator<void, T, void>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}
/** No authority or transaction may cross an unchecked event-loop turn. */
export async function runClinicalReviewWork<T>(
  work: Generator<void, T, void>,
  boundary: { capture(): () => void; signal?: AbortSignal },
): Promise<T> {
  try {
    let units = 0;
    for (;;) {
      boundary.signal?.throwIfAborted();
      const next = work.next();
      if (next.done) return next.value;
      if (++units < 16) continue;
      units = 0;
      const assertResume = boundary.capture();
      await setImmediate(undefined, { signal: boundary.signal });
      boundary.signal?.throwIfAborted();
      assertResume();
    }
  } finally {
    work.return(undefined as T);
  }
}

export function* findClinicalReviewWork<T>(
  values: Iterable<T>,
  predicate: (value: T) => Generator<void, boolean, void>,
): Generator<void, T | undefined, void> {
  for (const value of values) {
    yield;
    if (yield* predicate(value)) return value;
  }
}
export function* someClinicalReviewWork<T>(
  values: Iterable<T>,
  predicate: (value: T) => Generator<void, boolean, void>,
): Generator<void, boolean, void> {
  for (const value of values) {
    yield;
    if (yield* predicate(value)) return true;
  }
  return false;
}
export function* everyClinicalReviewWork<T>(
  values: Iterable<T>,
  predicate: (value: T) => Generator<void, boolean, void>,
): Generator<void, boolean, void> {
  for (const value of values) {
    yield;
    if (!(yield* predicate(value))) return false;
  }
  return true;
}
export function* lastClinicalReviewWork<T>(
  values: Iterable<T>,
  predicate: (value: T) => Generator<void, boolean, void>,
): Generator<void, T | undefined, void> {
  let result: T | undefined;
  for (const value of values) {
    yield;
    if (yield* predicate(value)) result = value;
  }
  return result;
}
