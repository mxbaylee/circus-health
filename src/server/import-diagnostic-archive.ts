import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { diagnosticChunkLimits } from './diagnostic-chunk-limits.ts';
import type { DiagnosticChunkStore } from './diagnostic-chunk-store.ts';
import type { ImportDiagnosticEvent } from './import-diagnostics.ts';
import type {
  ImportDiagnosticArchive,
  ImportDiagnosticCheckpoint,
  ImportDiagnosticOrigin,
} from '../shared/import-performance.ts';

export const diagnosticArchiveLimits = Object.freeze({
  ...diagnosticChunkLimits,
  maxEventsPerChunk: 128,
  maxExportBytes: 24 * 1024 * 1024,
  flushIntervalMs: 5_000,
});
const format = 'circus-import-events-v3';
// Five safe integer counters and their fixed keys fit this reserve, including JSON framing.
const checkpointReserveBytes = 512;
// Fixed coverage keys, UUID and four safe integer counters fit this export-only reserve.
const coverageReserveBytes = 512;
const originReserveBytes = 512;
const counterKeys = [
  'observedEvents',
  'persistedEvents',
  'droppedEvents',
  'oversizedEvents',
  'writeFailures',
] as const;
function checkpoint(counts: ImportDiagnosticCheckpoint): ImportDiagnosticCheckpoint {
  return Object.fromEntries(
    counterKeys.map((key) => [key, counts[key]]),
  ) as unknown as ImportDiagnosticCheckpoint;
}
function validCheckpoint(value: unknown): value is ImportDiagnosticCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === counterKeys.length &&
    counterKeys.every((key) => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) &&
    Number(row.oversizedEvents) <= Number(row.droppedEvents) &&
    Number(row.persistedEvents) <= Number(row.observedEvents) - Number(row.droppedEvents)
  );
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validOrigin(value: unknown): value is ImportDiagnosticOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 4 &&
    typeof row.windowId === 'string' &&
    uuid.test(row.windowId) &&
    typeof row.attachedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.attachedAt) &&
    Number.isFinite(Date.parse(row.attachedAt)) &&
    new Date(row.attachedAt).toISOString() === row.attachedAt &&
    (row.recordingAtAttachment === 'enabled' || row.recordingAtAttachment === 'disabled') &&
    Number.isSafeInteger(row.observedBeforeAttachment) &&
    Number(row.observedBeforeAttachment) >= 0
  );
}
interface State {
  store: DiagnosticChunkStore;
  prefix: string;
  pending: string[];
  bytes: number;
  sequence: number | null;
  blocked: boolean;
  counts: ImportDiagnosticArchive['currentWindow'];
  saved: ImportDiagnosticCheckpoint;
  origin: ImportDiagnosticOrigin;
  originConfirmed: boolean;
  frozen?: { bytes: Buffer; events: number; checkpoint: ImportDiagnosticCheckpoint };
  timer?: NodeJS.Timeout;
}

/** Bounded sanitized metadata only; all persistence is optional to clinical work. */
export function createImportDiagnosticArchive(
  enabled: boolean,
  sanitize: (value: unknown) => ImportDiagnosticEvent | null,
  now: () => Date = () => new Date(),
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
  const dirty = (state: State) =>
    (enabled && !state.originConfirmed) ||
    !!state.frozen ||
    state.pending.length > 0 ||
    counterKeys.some((key) => state.counts[key] !== state.saved[key]);
  const schedule = (profileId: string, state: State) => {
    if (state.timer || !dirty(state)) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (states.get(profileId) === state) flush(profileId);
    }, diagnosticArchiveLimits.flushIntervalMs);
    state.timer.unref();
  };
  function flush(profileId: string) {
    const state = states.get(profileId);
    if (!state || !dirty(state)) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    // One frozen retry plus one changed-accounting checkpoint; never loop on failures.
    for (let attempt = 0; attempt < 2 && dirty(state); attempt++) {
      try {
        if (!state.frozen) {
          const boundary = checkpoint({
            ...state.counts,
            persistedEvents: state.counts.persistedEvents + state.pending.length,
          });
          state.frozen = {
            bytes: Buffer.from(
              state.prefix +
                state.pending.join(',') +
                '],"checkpoint":' +
                JSON.stringify(boundary) +
                '}',
            ),
            events: state.pending.length,
            checkpoint: boundary,
          };
        }
        state.sequence ??= state.store.inventory().nextSequence;
        state.store.append(state.sequence, state.frozen.bytes);
        state.counts.persistedEvents += state.frozen.events;
        state.saved = state.frozen.checkpoint;
        state.originConfirmed = true;
        state.pending = [];
        state.bytes = Buffer.byteLength(state.prefix) + checkpointReserveBytes;
        state.sequence = null;
        state.frozen = undefined;
        state.blocked = false;
      } catch {
        state.counts.writeFailures++;
        state.blocked = true;
        break;
      }
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
    state.frozen?.bytes.fill(0);
    state.frozen = undefined;
    try {
      state.store.close();
    } catch {
      /* Optional diagnostic cleanup cannot stop profile lock. */
    }
  }
  return {
    attached(profileId: string) {
      return states.has(profileId);
    },
    attach(
      profileId: string,
      windowId: string,
      store: DiagnosticChunkStore,
      observedBeforeAttachment = 0,
    ) {
      if (!uuid.test(windowId)) throw Error('Invalid diagnostic window');
      const origin: ImportDiagnosticOrigin = {
        windowId,
        attachedAt: now().toISOString(),
        recordingAtAttachment: enabled ? 'enabled' : 'disabled',
        observedBeforeAttachment,
      };
      if (!validOrigin(origin)) throw Error('Invalid diagnostic origin');
      detach(profileId);
      const prefix = `{"format":"${format}","windowId":"${windowId}","origin":${JSON.stringify(origin)},"events":[`;
      states.set(profileId, {
        store,
        prefix,
        pending: [],
        bytes: Buffer.byteLength(prefix) + checkpointReserveBytes,
        sequence: null,
        blocked: false,
        counts: emptyCounts(windowId),
        saved: checkpoint(emptyCounts(windowId)),
        origin,
        originConfirmed: false,
      });
      if (enabled) flush(profileId);
    },
    record(profileId: string, event: ImportDiagnosticEvent) {
      const state = states.get(profileId);
      if (!enabled || !state) return;
      state.counts.observedEvents++;
      const json = JSON.stringify(event);
      const bytes = Buffer.byteLength(json);
      if (
        bytes + Buffer.byteLength(state.prefix) + checkpointReserveBytes >
        diagnosticArchiveLimits.maxChunkBytes
      ) {
        state.counts.oversizedEvents++;
        state.counts.droppedEvents++;
        schedule(profileId, state);
        return;
      }
      if (
        !state.blocked &&
        state.bytes + bytes + (state.pending.length ? 1 : 0) > diagnosticArchiveLimits.maxChunkBytes
      )
        flush(profileId);
      if (state.blocked) {
        state.counts.droppedEvents++;
        schedule(profileId, state);
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
        windowOrigins: [],
        currentAttachment: null,
        currentWindow: emptyCounts(null),
        windowCheckpoints: [],
        windowCoverageScope: 'retained_readable_checkpoints',
        windowCoverage: [],
        events: [],
      };
      if (!state) return result;
      flush(profileId);
      result.currentWindow = { ...state.counts, pendingEvents: state.pending.length };
      result.currentAttachment = {
        origin: { ...state.origin },
        publication: enabled ? (state.originConfirmed ? 'confirmed' : 'unconfirmed') : 'disabled',
      };
      const detached = () => states.get(profileId) !== state;
      const discard = () => ({
        ...result,
        status: 'unavailable' as const,
        retainedChunks: 0,
        encryptedBytes: 0,
        missingChunksWithinInventory: null,
        currentWindow: emptyCounts(null),
        windowCheckpoints: [],
        windowCoverage: [],
        windowOrigins: [],
        currentAttachment: null,
        events: [],
      });
      try {
        const inventory = state.store.inventory();
        result.retainedChunks = inventory.chunks.length;
        result.encryptedBytes = inventory.encryptedBytes;
        result.missingChunksWithinInventory = inventory.missingChunksWithinInventory;
        let outputBytes = Buffer.byteLength(JSON.stringify(result)) + 4096;
        // Reserve fixed metadata space before events, so an event cap cannot hide later checkpoints.
        let checkpointReserve =
          inventory.chunks.length *
          (checkpointReserveBytes + coverageReserveBytes + originReserveBytes);
        let eventsTruncated = false;
        const lastSequence = new Map<string, number>();
        const checkpointByWindow = new Map<
          string,
          ImportDiagnosticCheckpoint & { windowId: string }
        >();
        const coverageByWindow = new Map<
          string,
          ImportDiagnosticArchive['windowCoverage'][number]
        >();
        const originsByWindow = new Map<string, ImportDiagnosticOrigin>();
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
            Object.keys(record).length !== 5 ||
            record.format !== format ||
            typeof record.windowId !== 'string' ||
            !uuid.test(record.windowId) ||
            !validOrigin(record.origin) ||
            record.origin.windowId !== record.windowId ||
            record.origin.recordingAtAttachment !== 'enabled' ||
            !Array.isArray(record.events) ||
            record.events.length > diagnosticArchiveLimits.maxEventsPerChunk ||
            !validCheckpoint(record.checkpoint) ||
            record.checkpoint.persistedEvents < record.events.length
          ) {
            result.invalidChunks++;
            continue;
          }
          const prior = checkpointByWindow.get(record.windowId);
          const priorOrigin = originsByWindow.get(record.windowId);
          const boundary = record.checkpoint;
          if (
            (priorOrigin &&
              (priorOrigin.attachedAt !== record.origin.attachedAt ||
                priorOrigin.recordingAtAttachment !== record.origin.recordingAtAttachment ||
                priorOrigin.observedBeforeAttachment !== record.origin.observedBeforeAttachment)) ||
            (prior &&
              (counterKeys.some((key) => boundary[key] < prior[key]) ||
                boundary.persistedEvents - prior.persistedEvents < record.events.length))
          ) {
            result.invalidChunks++;
            continue;
          }
          const next = { windowId: record.windowId, ...boundary };
          const checkpointBytes = Buffer.byteLength(JSON.stringify(next)) + 1;
          const previousBytes = prior ? Buffer.byteLength(JSON.stringify(prior)) + 1 : 0;
          if (
            outputBytes - previousBytes + checkpointBytes >
            diagnosticArchiveLimits.maxExportBytes
          ) {
            result.outputTruncated = true;
            continue;
          }
          outputBytes += checkpointBytes - previousBytes;
          checkpointReserve -= checkpointBytes - previousBytes;
          if (prior) Object.assign(prior, next);
          else {
            result.windowCheckpoints.push(next);
            checkpointByWindow.set(record.windowId, next);
          }
          if (!priorOrigin) {
            originsByWindow.set(record.windowId, record.origin);
            result.windowOrigins.push({ ...record.origin });
            outputBytes += originReserveBytes;
            checkpointReserve -= originReserveBytes;
          }
          let coverage = coverageByWindow.get(record.windowId);
          if (!coverage) {
            coverage = {
              windowId: record.windowId,
              checkpointedPersistedEvents: 0,
              readableEvents: 0,
              exportedEvents: 0,
              knownPersistedNotExportedEvents: 0,
            };
            coverageByWindow.set(record.windowId, coverage);
            result.windowCoverage.push(coverage);
            // Reserve its maximum final representation before including event detail.
            outputBytes += coverageReserveBytes;
            checkpointReserve -= coverageReserveBytes;
          }
          coverage.checkpointedPersistedEvents = boundary.persistedEvents;
          for (const value of record.events) {
            const event = sanitize(value);
            if (!event || event.sequence <= (lastSequence.get(record.windowId) ?? -1)) {
              result.invalidEvents++;
              continue;
            }
            lastSequence.set(record.windowId, event.sequence);
            coverage.readableEvents++;
            if (eventsTruncated) continue;
            const exported = { windowId: record.windowId, event: anonymize(event) };
            const bytes = Buffer.byteLength(JSON.stringify(exported));
            if (
              outputBytes + checkpointReserve + bytes + 1 >
              diagnosticArchiveLimits.maxExportBytes
            ) {
              result.outputTruncated = true;
              eventsTruncated = true;
              continue;
            }
            outputBytes += bytes + 1;
            result.events.push(exported);
            coverage.exportedEvents++;
          }
        }
      } catch {
        result.status = 'unavailable';
        result.readFailures++;
      }
      if (detached()) return discard();
      for (const coverage of result.windowCoverage)
        coverage.knownPersistedNotExportedEvents = Math.max(
          0,
          coverage.checkpointedPersistedEvents - coverage.exportedEvents,
        );
      if (
        result.status === 'available' &&
        (result.readFailures ||
          result.invalidChunks ||
          result.invalidEvents ||
          result.outputTruncated ||
          result.missingChunksWithinInventory ||
          result.currentWindow.writeFailures ||
          result.currentWindow.droppedEvents ||
          result.currentWindow.pendingEvents ||
          result.windowCoverage.some((item) => item.knownPersistedNotExportedEvents > 0) ||
          result.windowCheckpoints.some(
            (item) => item.droppedEvents || item.oversizedEvents || item.writeFailures,
          ))
      )
        result.status = 'partial';
      return result;
    },
  };
}
