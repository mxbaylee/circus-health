import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { diagnosticChunkLimits, type DiagnosticChunkStore } from './diagnostic-chunk-store.ts';
import type { ImportDiagnosticEvent } from './import-diagnostics.ts';
import type { ImportDiagnosticArchive } from '../shared/import-performance.ts';

export const diagnosticArchiveLimits = Object.freeze({
  ...diagnosticChunkLimits,
  maxEventsPerChunk: 128,
  maxExportBytes: 24 * 1024 * 1024,
  flushIntervalMs: 5_000,
});
const format = 'circus-import-events-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface State {
  store: DiagnosticChunkStore;
  prefix: string;
  pending: string[];
  bytes: number;
  sequence: number | null;
  blocked: boolean;
  counts: ImportDiagnosticArchive['currentWindow'];
  timer?: NodeJS.Timeout;
}

/** Bounded sanitized metadata only; all persistence is optional to clinical work. */
export function createImportDiagnosticArchive(
  enabled: boolean,
  sanitize: (value: unknown) => ImportDiagnosticEvent | null,
) {
  const states = new Map<string, State>();
  const emptyCounts = (windowId: string | null): State['counts'] => ({
    windowId,
    observedEvents: 0,
    persistedEvents: 0,
    pendingEvents: 0,
    droppedEvents: 0,
    oversizedEvents: 0,
    writeFailures: 0,
  });
  const schedule = (profileId: string, state: State) => {
    if (state.timer || !state.pending.length) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (states.get(profileId) === state) flush(profileId);
    }, diagnosticArchiveLimits.flushIntervalMs);
    state.timer.unref();
  };
  function flush(profileId: string) {
    const state = states.get(profileId);
    if (!state || !state.pending.length) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    try {
      state.sequence ??= state.store.inventory().nextSequence;
      const bytes = Buffer.from(state.prefix + state.pending.join(',') + ']}');
      state.store.append(state.sequence, bytes);
      state.counts.persistedEvents += state.pending.length;
      state.pending = [];
      state.bytes = Buffer.byteLength(state.prefix) + 2;
      state.sequence = null;
      state.blocked = false;
    } catch {
      state.counts.writeFailures++;
      // Freeze bytes after an ambiguous publication so retries remain identical.
      state.blocked = true;
    }
    schedule(profileId, state);
  }
  function detach(profileId: string) {
    const state = states.get(profileId);
    if (!state) return;
    flush(profileId);
    states.delete(profileId);
    if (state.timer) clearTimeout(state.timer);
    state.pending = [];
    try {
      state.store.close();
    } catch {
      /* Optional diagnostic cleanup cannot stop profile lock. */
    }
  }
  return {
    attach(profileId: string, windowId: string, store: DiagnosticChunkStore) {
      if (!uuid.test(windowId)) throw Error('Invalid diagnostic window');
      detach(profileId);
      const prefix = `{"format":"${format}","windowId":"${windowId}","events":[`;
      states.set(profileId, {
        store,
        prefix,
        pending: [],
        bytes: Buffer.byteLength(prefix) + 2,
        sequence: null,
        blocked: false,
        counts: emptyCounts(windowId),
      });
    },
    record(profileId: string, event: ImportDiagnosticEvent) {
      const state = states.get(profileId);
      if (!enabled || !state) return;
      state.counts.observedEvents++;
      const json = JSON.stringify(event);
      const bytes = Buffer.byteLength(json);
      if (bytes + Buffer.byteLength(state.prefix) + 2 > diagnosticArchiveLimits.maxChunkBytes) {
        state.counts.oversizedEvents++;
        state.counts.droppedEvents++;
        return;
      }
      if (
        !state.blocked &&
        state.bytes + bytes + (state.pending.length ? 1 : 0) > diagnosticArchiveLimits.maxChunkBytes
      )
        flush(profileId);
      if (state.blocked) {
        state.counts.droppedEvents++;
        return;
      }
      state.bytes += bytes + (state.pending.length ? 1 : 0);
      state.pending.push(json);
      if (state.pending.length >= diagnosticArchiveLimits.maxEventsPerChunk) flush(profileId);
      else schedule(profileId, state);
    },
    flush,
    detach,
    close() {
      for (const id of [...states.keys()]) detach(id);
    },
    async export(
      profileId: string,
      anonymize: (event: ImportDiagnosticEvent) => ImportDiagnosticEvent,
    ): Promise<ImportDiagnosticArchive<ImportDiagnosticEvent>> {
      const state = states.get(profileId);
      const result: ImportDiagnosticArchive<ImportDiagnosticEvent> = {
        storage: 'encrypted_chunks',
        status: state ? 'available' : 'not_attached',
        recording: enabled ? 'enabled' : 'disabled',
        limits: {
          ...diagnosticChunkLimits,
          maxExportBytes: diagnosticArchiveLimits.maxExportBytes,
        },
        retainedChunks: 0,
        encryptedBytes: 0,
        missingChunksWithinInventory: null,
        readFailures: 0,
        invalidChunks: 0,
        invalidEvents: 0,
        outputTruncated: false,
        omittedBeforeInventory: null,
        crashTailEvents: null,
        completeness: 'not_established',
        currentWindow: emptyCounts(null),
        events: [],
      };
      if (!state) return result;
      flush(profileId);
      result.currentWindow = { ...state.counts, pendingEvents: state.pending.length };
      const detached = () => states.get(profileId) !== state;
      const discard = () => ({
        ...result,
        status: 'unavailable' as const,
        retainedChunks: 0,
        encryptedBytes: 0,
        missingChunksWithinInventory: null,
        currentWindow: emptyCounts(null),
        events: [],
      });
      try {
        const inventory = state.store.inventory();
        result.retainedChunks = inventory.chunks.length;
        result.encryptedBytes = inventory.encryptedBytes;
        result.missingChunksWithinInventory = inventory.missingChunksWithinInventory;
        let outputBytes = Buffer.byteLength(JSON.stringify(result)) + 4096;
        const lastSequence = new Map<string, number>();
        for (const chunk of inventory.chunks) {
          // Decrypt/validate only one bounded chunk before yielding to foreground requests.
          await yieldToRequests();
          if (detached()) return discard();
          let value: unknown;
          try {
            value = JSON.parse(state.store.read(chunk.sequence).toString('utf8'));
          } catch {
            result.readFailures++;
            continue;
          }
          const record =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
          if (
            !record ||
            record.format !== format ||
            typeof record.windowId !== 'string' ||
            !uuid.test(record.windowId) ||
            !Array.isArray(record.events) ||
            record.events.length > diagnosticArchiveLimits.maxEventsPerChunk
          ) {
            result.invalidChunks++;
            continue;
          }
          for (const value of record.events) {
            const event = sanitize(value);
            if (!event || event.sequence <= (lastSequence.get(record.windowId) ?? -1)) {
              result.invalidEvents++;
              continue;
            }
            lastSequence.set(record.windowId, event.sequence);
            const exported = { windowId: record.windowId, event: anonymize(event) };
            const bytes = Buffer.byteLength(JSON.stringify(exported));
            if (outputBytes + bytes + 1 > diagnosticArchiveLimits.maxExportBytes) {
              result.outputTruncated = true;
              break;
            }
            outputBytes += bytes + 1;
            result.events.push(exported);
          }
          if (result.outputTruncated) break;
        }
      } catch {
        result.status = 'unavailable';
        result.readFailures++;
      }
      if (detached()) return discard();
      if (
        result.status === 'available' &&
        (result.readFailures ||
          result.invalidChunks ||
          result.invalidEvents ||
          result.outputTruncated ||
          result.missingChunksWithinInventory ||
          result.currentWindow.writeFailures ||
          result.currentWindow.droppedEvents ||
          result.currentWindow.pendingEvents)
      )
        result.status = 'partial';
      return result;
    },
  };
}
