import type { DatabaseSync } from 'node:sqlite';

// Fixed numeric counters only. No identities, paths, values or operation histories
// are retained. Weak ownership lasts as long as the connection, including cache
// invalidation so failed/rolled-back work remains observable.
const primitiveTemplate = {
  handlesCreated: 0,
  coldReconstructions: 0,
  warmLoads: 0,
  ancestorReads: 0,
  candidateCopies: 0,
  patchOperations: 0,
  normalizedStateBytes: 0,
  candidateCopyBytes: 0,
  framesWritten: 0,
  frameBytesWritten: 0,
  readCopies: 0,
  readCopyBytes: 0,
  serializedReadBytes: 0,
  metadataReads: 0,
  metadataReadBytes: 0,
};
const hostTemplate = {
  normalizeCalls: 0,
  normalizeValidationNodes: 0,
  normalizeCloneNodes: 0,
  normalizeValidatedStringUnits: 0,
  serializationCalls: 0,
  serializedBytes: 0,
  diffCalls: 0,
  diffNodeVisits: 0,
  diffStringComparedUnits: 0,
  arrayMatchSerializedBytes: 0,
  arrayMatchItems: 0,
  diffAlignmentSteps: 0,
  diffTraceCells: 0,
  hashCalls: 0,
  hashedBytes: 0,
  jsonParseCalls: 0,
  jsonParseBytes: 0,
  evidenceDecodeCopyBytes: 0,
  evidenceBufferCopiedBytes: 0,
  evidenceFrameReads: 0,
  evidenceFrameReadBytes: 0,
  evidenceReceiptReads: 0,
  evidenceReceiptReadBytes: 0,
  evidenceReplayVersions: 0,
  evidenceReplayOperations: 0,
  envelopeHydrations: 0,
  envelopeTextReads: 0,
  envelopeSerializedBytes: 0,
  envelopeSerializationCalls: 0,
  rawNormalizations: 0,
  sourceDTOHydrations: 0,
  sourceDTOEnvelopeBytes: 0,
};
export type IntakeHostWork = typeof hostTemplate;
export type IntakeWorkPhase = 'warm' | 'reconstruction';
export interface IntakeWorkCounters {
  primitive: typeof primitiveTemplate;
  warm: IntakeHostWork;
  reconstruction: IntakeHostWork;
}
const connections = new WeakMap<DatabaseSync, IntakeWorkCounters>();
function countersFor(db: DatabaseSync): IntakeWorkCounters {
  let counters = connections.get(db);
  if (!counters) {
    counters = {
      primitive: { ...primitiveTemplate },
      warm: { ...hostTemplate },
      reconstruction: { ...hostTemplate },
    };
    connections.set(db, counters);
  }
  return counters;
}
/** Snapshots cannot alter the measured counters. Initial/conversion/open intervals
 * should be sampled separately. Counts overlap by activity, are logical work, and
 * are not physical allocation or total CPU instructions. JSON runtime internals,
 * SQLite VM/index work and accepted-record internal codecs/hashes are unmeasured. */
export function intakeWorkCounters(db: DatabaseSync): IntakeWorkCounters {
  const counters = countersFor(db);
  return {
    primitive: { ...counters.primitive },
    warm: { ...counters.warm },
    reconstruction: { ...counters.reconstruction },
  };
}
let active: { db: DatabaseSync; phase: IntakeWorkPhase; counters: IntakeHostWork } | undefined;
/** Synchronous production boundaries only; restores attribution even on failure.
 * Nested calls on the same database retain an enclosing reconstruction phase. */
export function withIntakeWork<T>(db: DatabaseSync, phase: IntakeWorkPhase, run: () => T): T {
  const previous = active;
  if (previous?.db === db && previous.phase === 'reconstruction') phase = 'reconstruction';
  active = { db, phase, counters: countersFor(db)[phase] };
  try {
    return run();
  } finally {
    active = previous;
  }
}
export function recordIntakeWork(metric: keyof IntakeHostWork, amount = 1): void {
  if (active) active.counters[metric] += amount;
}
/** Charge a known existing serialization, never serialize solely for accounting. */
export function recordIntakeSerialization(text: string): string {
  recordIntakeWork('serializationCalls');
  recordIntakeWork('serializedBytes', Buffer.byteLength(text));
  return text;
}
export function recordIntakePrimitiveWork(
  db: DatabaseSync,
  metric: keyof typeof primitiveTemplate,
  amount = 1,
): void {
  countersFor(db).primitive[metric] += amount;
}
/** Keep every handle's old counters independent while also aggregating handles
 * created internally by production readers/writers. */
export function createIntakePrimitiveCounters(db: DatabaseSync) {
  recordIntakePrimitiveWork(db, 'handlesCreated');
  const counters = { ...primitiveTemplate };
  return {
    counters,
    count(metric: keyof typeof primitiveTemplate, amount = 1) {
      counters[metric] += amount;
      recordIntakePrimitiveWork(db, metric, amount);
    },
  };
}
