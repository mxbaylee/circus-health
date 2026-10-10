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
  ancestryReferencesSpooled: 0,
  ancestryReferencesReplayed: 0,
  segmentIndexPagesRead: 0,
  segmentIndexPagesWritten: 0,
  segmentReferencesSpooled: 0,
  segmentReferencesReplayed: 0,
  maxSegmentReferencesBuffered: 0,
  versionValidations: 0,
  indexedVersionValidations: 0,
  validatedColumns: 0,
  decodedVersions: 0,
  journalRecordsSpooled: 0,
  journalRecordSpoolBytes: 0,
  maxJournalRecordBufferBytes: 0,
  maxJournalRecordDecodeWindowBytes: 0,
  indexedVersionAttempts: 0,
  fieldVisits: 0,
  replayDeleteAttempts: 0,
  replayInsertAttempts: 0,
  vaultBackingColdReplays: 0,
  vaultBackingColdDecodedVersions: 0,
  vaultBackingReuses: 0,
  vaultBackingRejectedOwner: 0,
  vaultBackingRejectedMethods: 0,
  vaultBackingRejectedHead: 0,
  vaultBackingRejectedPhysical: 0,
  vaultBackingRejectedSequence: 0,
  vaultBackingRejectedWorkspace: 0,
  vaultBackingRejectedParents: 0,
  vaultBackingRejectedScope: 0,
  vaultBackingCertificateWrites: 0,
  vaultBackingChangedVersions: 0,
  vaultBackingPhysicalMembersVerified: 0,
  contributorBackingPhysicalMemberVisits: 0,
  contributorBackingColdDecodedVersions: 0,
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
const replayCheckpoints = new AsyncLocalStorage<() => void>();
/** Background replay drivers can report bounded work without carrying records. */
export function withRecordReplayCheckpoints<T>(checkpoint: () => void, run: () => T): T {
  return replayCheckpoints.run(checkpoint, run);
}
export function recordReplayCheckpoint(): void {
  replayCheckpoints.getStore()?.();
}
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

export function recordVersionWorkMaximum(metric: keyof Metrics, amount: number): void {
  const current = scope.getStore();
  if (current)
    current.counters[current.phase][metric] = Math.max(
      current.counters[current.phase][metric],
      amount,
    );
}
