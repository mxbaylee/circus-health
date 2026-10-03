import { AsyncLocalStorage } from 'node:async_hooks';

const empty = () => ({
  serializationCalls: 0,
  serializedBytes: 0,
  encodeCalls: 0,
  encodedBytes: 0,
  parseCalls: 0,
  parsedBytes: 0,
  hashCalls: 0,
  hashedBytes: 0,
  objectReadCalls: 0,
  objectReadBytes: 0,
  headReadCalls: 0,
  headReadBytes: 0,
  commitValidations: 0,
  versionValidations: 0,
  indexedVersionValidations: 0,
  validatedColumns: 0,
  decodedVersions: 0,
  indexedVersionAttempts: 0,
  fieldVisits: 0,
  replayDeleteAttempts: 0,
  replayInsertAttempts: 0,
});
type Metrics = ReturnType<typeof empty>;
type Phase = 'operation' | 'reconstruction';

/** Logical work inside record-versions.ts, including temporary rebuild
 * connections. Counts overlap by activity (encoding includes serialization),
 * retain failed attempts, and exclude SQL VM work, encryption and consumers'
 * own codecs. No records, identities or paths are retained. */
export function createRecordVersionWorkCounters() {
  return { operation: empty(), reconstruction: empty() };
}
type Counters = ReturnType<typeof createRecordVersionWorkCounters>;
const scope = new AsyncLocalStorage<{ counters: Counters; phase: Phase }>();
export function withRecordVersionWork<T>(counters: Counters, run: () => T): T {
  return scope.run({ counters, phase: 'operation' }, run);
}
export function withRecordVersionWorkPhase<T>(phase: Phase, run: () => T): T {
  const current = scope.getStore();
  return current ? scope.run({ counters: current.counters, phase }, run) : run();
}
export function recordVersionWork(metric: keyof Metrics, amount = 1): void {
  const current = scope.getStore();
  if (current) current.counters[current.phase][metric] += amount;
}
export function stringifyRecordJson(value: unknown): ReturnType<typeof JSON.stringify> {
  const current = scope.getStore();
  if (current) current.counters[current.phase].serializationCalls++;
  const text = JSON.stringify(value);
  if (current) {
    const metrics = current.counters[current.phase];
    if (text !== undefined) metrics.serializedBytes += Buffer.byteLength(text);
  }
  return text;
}
export function parseRecordJson<T = unknown>(text: string): T {
  const current = scope.getStore();
  if (current) {
    const metrics = current.counters[current.phase];
    metrics.parseCalls++;
    // Journal readers pass strings or UTF-8 Buffers through JSON.parse's
    // existing coercion. Count its actual input, including malformed attempts.
    metrics.parsedBytes += Buffer.isBuffer(text)
      ? text.byteLength
      : Buffer.byteLength(String(text));
  }
  return JSON.parse(text) as T;
}
export function recordVersionColumns<T extends string[]>(columns: T): T {
  recordVersionWork('validatedColumns', columns.length);
  return columns;
}
