import { AsyncLocalStorage } from 'node:async_hooks';

/** Opt-in fixed numeric totals, scoped to the caller's asynchronous operation. */
export function createIntakeBatchJournalWorkCounters() {
  return {
    proxyPropertyReads: 0,
    proxyEnumeratedKeys: 0,
    currentAssertions: 0,
    readCalls: 0,
    writeCalls: 0,
    directoryEntries: 0,
    eventReads: 0,
    eventReadBytes: 0,
    replayedEvents: 0,
    replayedChanges: 0,
    replayPathVisits: 0,
    diffCalls: 0,
    diffSerializationCalls: 0,
    diffSerializedBytes: 0,
    emittedChanges: 0,
    emittedRemovals: 0,
    eventWrites: 0,
    eventWriteBytes: 0,
    publishedEvents: 0,
    copyValidationReads: 0,
    copyValidationReadBytes: 0,
    copiedEvents: 0,
    copiedEventBytes: 0,
    headReads: 0,
    headReadBytes: 0,
    headWrites: 0,
    headWriteBytes: 0,
    hashCalls: 0,
    hashedBytes: 0,
    eventSerializationCalls: 0,
    eventSerializedBytes: 0,
    headSerializationCalls: 0,
    headSerializedBytes: 0,
    mutationOperations: 0,
    mutationPathVisits: 0,
    mutationCloneNodes: 0,
    mutationStringUnits: 0,
    dtoCloneCalls: 0,
    dtoCloneNodes: 0,
    dtoStringUnits: 0,
    proxyPathSerializationCalls: 0,
    proxyPathSerializedUnits: 0,
    headComparisonFields: 0,
    changeCloneNodes: 0,
    changeStringUnits: 0,
    replayCloneNodes: 0,
    replayStringUnits: 0,
    fileSyncCalls: 0,
    directorySyncCalls: 0,
    authorityStats: 0,
    lockAcquisitions: 0,
  };
}
export type IntakeBatchJournalWork = ReturnType<typeof createIntakeBatchJournalWorkCounters>;
const work = new AsyncLocalStorage<IntakeBatchJournalWork>();
export function withIntakeBatchJournalWork<T>(counters: IntakeBatchJournalWork, run: () => T): T {
  return work.run(counters, run);
}
export function countIntakeBatchWork(metric: keyof IntakeBatchJournalWork, amount = 1): void {
  const counters = work.getStore();
  if (counters) counters[metric] += amount;
}
