import { AsyncLocalStorage } from 'node:async_hooks';

export function createPortableWorkCounters() {
  return {
    generationRows: 0,
    generationBytes: 0,
    journalReadBytes: 0,
    maxRowBytes: 0,
    maxReadBufferBytes: 0,
    fileHashBytes: 0,
    fileHashCalls: 0,
    bufferHashBytes: 0,
    bufferHashCalls: 0,
    lineIndexReadBytes: 0,
    rangeReadBytes: 0,
    rangeReadCalls: 0,
    maxRangeBytes: 0,
    fileCopyCalls: 0,
    fileCopyBytes: 0,
    outputBytes: 0,
    maxOutputChunkBytes: 0,
  };
}
type Counters = ReturnType<typeof createPortableWorkCounters>;
const scope = new AsyncLocalStorage<Counters>();
export function withPortableWork<T>(counters: Counters, run: () => T): T {
  return scope.run(counters, run);
}
/** Counts actual traversal, including failures; retains no record data. */
export function portableWork(metric: keyof Counters, amount: number, maximum = false): void {
  const counters = scope.getStore();
  if (counters)
    counters[metric] = maximum ? Math.max(counters[metric], amount) : counters[metric] + amount;
}
