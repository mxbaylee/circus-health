import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImportDiagnostics, type ImportDiagnosticEvent } from '../import-diagnostics.ts';
import {
  createImportDiagnosticArchive,
  diagnosticArchiveLimits,
} from '../import-diagnostic-archive.ts';
import { openDiagnosticChunkStore, type DiagnosticChunkStore } from '../diagnostic-chunk-store.ts';
import { freshKey } from '../vault-crypto.ts';

function fixture(t: test.TestContext, maxChunks?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-archive-'));
  const key = freshKey();
  const profileId = 'fictional-profile';
  t.after(() => {
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  const open = () =>
    openDiagnosticChunkStore({
      directory,
      key,
      profileId,
      limits: { maxChunks: maxChunks ?? 256 },
    });
  return { directory, profileId, open };
}
function event(sequence = 1): ImportDiagnosticEvent {
  return {
    schemaVersion: 1,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    monotonicMs: sequence,
    event: 'import.progress',
    context: { importId: 'fictional-source.pdf' },
    fields: { accountedUnits: sequence },
  };
}
function writeChunk(
  store: DiagnosticChunkStore,
  windowId: string,
  events: unknown[],
  sequence = 1,
) {
  store.append(
    sequence,
    Buffer.from(
      JSON.stringify({
        format: 'circus-import-events-v3',
        windowId,
        origin: {
          windowId,
          attachedAt: '2026-01-01T00:00:00.000Z',
          recordingAtAttachment: 'enabled',
          observedBeforeAttachment: 0,
        },
        events,
        checkpoint: {
          observedEvents: events.length,
          persistedEvents: events.length,
          droppedEvents: 0,
          oversizedEvents: 0,
          writeFailures: 0,
        },
      }),
    ),
  );
}

test('retained metadata survives lock/reopen with capture off, joins the live window and re-salts exports', async (t) => {
  const f = fixture(t),
    d = createImportDiagnostics({ enabled: true, capacity: 10 }),
    store = f.open();
  const requestId = randomUUID();
  d.attachEventStore(f.profileId, store);
  for (let i = 0; i < 300; i++)
    d.record(
      'import.progress',
      { accountedUnits: i, unsafeText: 'Fictional secret narrative' },
      { profileId: f.profileId, importId: 'fictional-source.pdf', requestId },
    );
  const salt = Buffer.alloc(32, 1);
  const live = d.exportSnapshot(f.profileId, salt);
  const archive = await d.exportArchive(f.profileId, salt);
  assert.equal(live.events.length, 10);
  assert.equal(archive.events.length, 300);
  assert.equal(archive.status, 'available');
  assert.equal(archive.currentWindow.persistedEvents, 300);
  assert.deepEqual(archive.windowCoverage, [
    {
      windowId: archive.currentWindow.windowId,
      checkpointedPersistedEvents: 300,
      readableEvents: 300,
      exportedEvents: 300,
      knownPersistedNotExportedEvents: 0,
    },
  ]);
  assert.equal(archive.events[0]!.windowId, live.eventWindow.windowId);
  assert.equal(archive.events[0]!.event.context.importId, live.events[0]!.context.importId);
  assert.equal(archive.events[0]!.event.context.requestId, requestId);
  assert.equal(archive.events.at(-1)!.event.sequence, live.events.at(-1)!.sequence);
  assert.equal(store.work().chunkWrites, 4);
  assert.doesNotMatch(
    JSON.stringify(archive),
    /fictional-source|secret narrative|fictional-profile/,
  );
  for (const name of readdirSync(f.directory))
    assert.equal(
      readFileSync(join(f.directory, name)).includes(Buffer.from('fictional-source')),
      false,
    );
  d.detachSummaryStore(f.profileId);
  assert.equal((await d.exportArchive(f.profileId)).status, 'not_attached');
  assert.throws(() => store.inventory(), /closed/);
  d.close();
  const restored = createImportDiagnostics();
  const next = f.open();
  restored.attachEventStore(f.profileId, next);
  restored.record('import.progress', { accountedUnits: 999 }, { profileId: f.profileId });
  const recovered = await restored.exportArchive(f.profileId, Buffer.alloc(32, 2));
  assert.equal(recovered.events.length, 300);
  assert.equal(recovered.recording, 'disabled');
  assert.equal(recovered.currentWindow.observedEvents, 0);
  assert.equal(recovered.crashTailEvents, null);
  assert.equal(recovered.omittedBeforeInventory, null);
  assert.equal(recovered.completeness, 'not_established');
  assert.deepEqual(recovered.windowCheckpoints, archive.windowCheckpoints);
  assert.deepEqual(recovered.windowCoverage, archive.windowCoverage);
  assert.equal(recovered.windowCheckpoints.length, 1);
  assert.equal(recovered.windowCheckpoints[0]!.persistedEvents, 300);
  assert.notEqual(
    recovered.events[0]!.event.context.importId,
    archive.events[0]!.event.context.importId,
  );
  assert.equal(next.work().chunkWrites, 0);
  assert.notEqual(recovered.currentWindow.windowId, archive.currentWindow.windowId);
  restored.close();
});

test('default-off capture creates no chunks and record work scales only with new chunks', async (t) => {
  const off = fixture(t),
    disabled = createImportDiagnostics(),
    quiet = off.open();
  disabled.attachEventStore(off.profileId, quiet);
  for (let i = 0; i < 100; i++)
    disabled.record('import.progress', {}, { profileId: off.profileId });
  assert.equal((await disabled.exportArchive(off.profileId)).events.length, 0);
  assert.deepEqual(readdirSync(off.directory), []);
  disabled.close();
  const work = [];
  for (const size of [256, 512]) {
    const f = fixture(t),
      d = createImportDiagnostics({ enabled: true, now: () => new Date('2026-01-01T00:00:00Z') }),
      store = f.open();
    d.attachEventStore(f.profileId, store);
    const attachmentBytes = store.work().plaintextBytesWritten;
    for (let i = 0; i < size; i++)
      d.record('import.progress', { accountedUnits: 1 }, { profileId: f.profileId });
    const measured = store.work();
    assert.equal(measured.chunkWrites, size / 128 + 1);
    assert.equal(measured.chunkReads, 0);
    assert.equal(measured.indexScans, 1);
    work.push(measured.plaintextBytesWritten - attachmentBytes);
    d.close();
  }
  assert.ok(work[1]! > work[0]! * 1.9 && work[1]! < work[0]! * 2.1);
});

test('ambiguous publication retries identical bytes and bounds dropped work while persistence fails', async (t) => {
  const f = fixture(t),
    store = f.open(),
    d = createImportDiagnostics({ enabled: true });
  let attempts = 0;
  const attemptedBytes: Buffer[] = [];
  const flaky: DiagnosticChunkStore = {
    ...store,
    append(sequence, bytes) {
      attempts++;
      attemptedBytes.push(Buffer.from(bytes));
      const result = store.append(sequence, bytes);
      if (attempts === 2) throw Error('Fictional lost acknowledgement');
      return result;
    },
  };
  d.attachEventStore(f.profileId, flaky);
  for (let i = 0; i < 132; i++)
    assert.doesNotThrow(() => d.record('import.progress', {}, { profileId: f.profileId }));
  assert.equal(
    attempts,
    2,
    'origin plus no append retry per event while a frozen chunk is pending',
  );
  const exported = await d.exportArchive(f.profileId);
  assert.equal(attempts, 4, 'origin, retry plus one coalesced loss checkpoint');
  assert.deepEqual(attemptedBytes[1], attemptedBytes[2]);
  assert.equal(exported.events.length, 128);
  assert.equal(store.work().chunkWrites, 3);
  assert.equal(exported.currentWindow.droppedEvents, 4);
  assert.equal(exported.currentWindow.writeFailures, 1);
  assert.equal(exported.currentWindow.pendingEvents, 0);
  assert.equal(exported.status, 'partial');
  assert.deepEqual(exported.windowCheckpoints, [
    {
      windowId: exported.currentWindow.windowId,
      observedEvents: 132,
      persistedEvents: 128,
      droppedEvents: 4,
      oversizedEvents: 0,
      writeFailures: 1,
    },
  ]);
  d.close();
  const restored = createImportDiagnostics();
  t.after(() => restored.close());
  restored.attachEventStore(f.profileId, f.open());
  const afterRestart = await restored.exportArchive(f.profileId);
  assert.equal(afterRestart.currentWindow.droppedEvents, 0);
  assert.equal(afterRestart.status, 'partial');
  assert.equal(afterRestart.events.length, 128);
  assert.deepEqual(afterRestart.windowCheckpoints, exported.windowCheckpoints);
});

test('persistent failure and oversized observations remain bounded and explicit', async (t) => {
  const f = fixture(t),
    store = f.open();
  let attempts = 0;
  const broken: DiagnosticChunkStore = {
    ...store,
    append(sequence, bytes) {
      attempts++;
      if (attempts === 1) return store.append(sequence, bytes);
      throw Error('Fictional disk failure');
    },
  };
  const d = createImportDiagnostics({ enabled: true });
  d.attachEventStore(f.profileId, broken);
  for (let i = 0; i < 300; i++) d.record('import.progress', {}, { profileId: f.profileId });
  const result = await d.exportArchive(f.profileId);
  assert.equal(attempts, 3);
  assert.equal(result.currentWindow.pendingEvents, 128);
  assert.equal(result.currentWindow.droppedEvents, 172);
  assert.equal(result.status, 'partial');
  d.close();
  const failedRecovery = createImportDiagnostics();
  t.after(() => failedRecovery.close());
  failedRecovery.attachEventStore(f.profileId, f.open());
  const unknownTail = await failedRecovery.exportArchive(f.profileId);
  assert.equal(unknownTail.windowCheckpoints[0]!.persistedEvents, 0);
  assert.equal(unknownTail.crashTailEvents, null);
  assert.equal(unknownTail.completeness, 'not_established');
  const other = fixture(t),
    archive = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  archive.attach(other.profileId, randomUUID(), other.open());
  archive.record(other.profileId, {
    ...event(),
    context: { importId: 'x'.repeat(diagnosticArchiveLimits.maxChunkBytes) },
  });
  const oversized = await archive.export(other.profileId, (value) => value);
  assert.equal(oversized.currentWindow.oversizedEvents, 1);
  assert.equal(oversized.currentWindow.droppedEvents, 1);
  assert.equal(oversized.events.length, 0);
  assert.equal(oversized.windowCheckpoints[0]!.oversizedEvents, 1);
  archive.close();
  const oversizedRecovery = createImportDiagnostics();
  t.after(() => oversizedRecovery.close());
  oversizedRecovery.attachEventStore(other.profileId, other.open());
  const recoveredOversized = await oversizedRecovery.exportArchive(other.profileId);
  assert.equal(recoveredOversized.status, 'partial');
  assert.deepEqual(recoveredOversized.windowCheckpoints, oversized.windowCheckpoints);
});

test('recovered schema corruption, private strings and duplicate sequences are rejected explicitly', async (t) => {
  const f = fixture(t),
    store = f.open(),
    windowId = randomUUID();
  writeChunk(store, windowId, [
    event(1),
    { ...event(2), fields: { privateNarrative: 'Fictional medical canary' } },
    { ...event(3), context: { profileId: 'Fictional medical canary' } },
    { ...event(4), event: 'import.privatecanary' },
    { ...event(5), raw: 'Fictional medical canary' },
    event(1),
    event(6),
    { ...event(7), fields: { privateMedicalCanary: 1 } },
    { ...event(8), fields: { arbitraryMedicalCanary: true } },
    { ...event(9), fields: { nullMedicalCanary: null } },
  ]);
  store.append(
    2,
    Buffer.from(JSON.stringify({ format: 'unsupported', medical: 'Fictional medical canary' })),
  );
  const d = createImportDiagnostics();
  d.attachEventStore(f.profileId, store);
  const result = await d.exportArchive(f.profileId);
  assert.deepEqual(
    result.events.map((e) => e.event.sequence),
    [1, 6],
  );
  assert.equal(result.invalidEvents, 8);
  assert.equal(result.invalidChunks, 1);
  assert.deepEqual(result.windowCoverage, [
    {
      windowId,
      checkpointedPersistedEvents: 10,
      readableEvents: 2,
      exportedEvents: 2,
      knownPersistedNotExportedEvents: 8,
    },
  ]);
  assert.equal(result.status, 'partial');
  assert.doesNotMatch(
    JSON.stringify(result),
    /medical canary|privatecanary|privateNarrative|MedicalCanary/,
  );
  writeFileSync(join(f.directory, '0000000000000001.enc'), 'Fictional corrupted ciphertext');
  const damaged = await d.exportArchive(f.profileId);
  assert.equal(damaged.readFailures, 1);
  assert.equal(damaged.status, 'partial');
  d.close();
});

test('export yields to foreground work and discards plaintext if the profile locks mid-export', async (t) => {
  const f = fixture(t),
    store = f.open(),
    d = createImportDiagnostics({ enabled: true });
  d.attachEventStore(f.profileId, store);
  for (let i = 0; i < 300; i++) d.record('import.progress', {}, { profileId: f.profileId });
  d.exportSnapshot(f.profileId);
  const pending = d.exportArchive(f.profileId);
  await new Promise<void>((done) =>
    setImmediate(() => {
      d.clear(f.profileId);
      done();
    }),
  );
  const result = await pending;
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.events, []);
  assert.equal(result.currentWindow.windowId, null);
  assert.deepEqual(result.windowCheckpoints, []);
  assert.deepEqual(result.windowCoverage, []);
  assert.deepEqual(result.windowOrigins, []);
  assert.equal(result.currentAttachment, null);
  assert.equal((await d.exportArchive('another-profile')).status, 'not_attached');
  d.close();
});

test('retention remains explicit without claiming a loss-free current inventory is a complete run', async (t) => {
  const f = fixture(t, 2),
    d = createImportDiagnostics({ enabled: true }),
    store = f.open();
  d.attachEventStore(f.profileId, store);
  for (let i = 0; i < 384; i++)
    d.record('import.progress', { accountedUnits: i }, { profileId: f.profileId });
  const result = await d.exportArchive(f.profileId);
  assert.equal(result.retainedChunks, 2);
  assert.equal(result.events.length, 256);
  assert.equal(result.events[0]!.event.fields.accountedUnits, 128);
  assert.equal(result.omittedBeforeInventory, null);
  assert.equal(result.completeness, 'not_established');
  assert.equal(result.windowCheckpoints.length, 1);
  assert.equal(result.windowCheckpoints[0]!.persistedEvents, 384);
  assert.equal(result.missingChunksWithinInventory, 0);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.windowCoverage, [
    {
      windowId: result.currentWindow.windowId,
      checkpointedPersistedEvents: 384,
      readableEvents: 256,
      exportedEvents: 256,
      knownPersistedNotExportedEvents: 128,
    },
  ]);
  assert.equal(store.work().chunkWrites, 4);
  d.close();
});

test('serialized export output stays bounded even when anonymization expands stored identifiers', async (t) => {
  const f = fixture(t),
    store = f.open();
  const archive = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  archive.attach(f.profileId, randomUUID(), store);
  for (let i = 0; i < 4096; i++) archive.record(f.profileId, event(i));
  const result = await archive.export(f.profileId, (value) => ({
    ...value,
    context: { importId: 'x'.repeat(8000) },
  }));
  assert.equal(result.outputTruncated, true);
  assert.equal(result.status, 'partial');
  assert.ok(result.events.length > 0 && result.events.length < 4096);
  assert.equal(
    result.windowCheckpoints[0]!.persistedEvents,
    4096,
    'later checkpoints remain visible after event truncation',
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= diagnosticArchiveLimits.maxExportBytes);
  assert.deepEqual(result.windowCoverage, [
    {
      windowId: result.currentWindow.windowId,
      checkpointedPersistedEvents: 4096,
      readableEvents: 4096,
      exportedEvents: result.events.length,
      knownPersistedNotExportedEvents: 4096 - result.events.length,
    },
  ]);
  archive.close();
});

test('unreadable and invalid earlier chunks retain exact omission counts from a later checkpoint', async (t) => {
  for (const failure of ['unreadable', 'invalid'] as const) {
    const f = fixture(t),
      store = f.open(),
      d = createImportDiagnostics({ enabled: true });
    d.attachEventStore(f.profileId, {
      ...store,
      read(sequence) {
        if (sequence === 2) {
          if (failure === 'unreadable') throw Error('Fictional read failure');
          return Buffer.from('{}');
        }
        return store.read(sequence);
      },
    });
    for (let i = 0; i < 256; i++) d.record('import.progress', {}, { profileId: f.profileId });
    const result = await d.exportArchive(f.profileId);
    assert.equal(result.status, 'partial');
    assert.equal(result.readFailures, failure === 'unreadable' ? 1 : 0);
    assert.equal(result.invalidChunks, failure === 'invalid' ? 1 : 0);
    assert.deepEqual(result.windowCoverage, [
      {
        windowId: result.currentWindow.windowId,
        checkpointedPersistedEvents: 256,
        readableEvents: 128,
        exportedEvents: 128,
        knownPersistedNotExportedEvents: 128,
      },
    ]);
    assert.equal(store.work().chunkWrites, 3);
    d.close();
  }
});

test('interleaved profile sequences do not imply omissions or mix window evidence', async (t) => {
  const first = fixture(t),
    second = fixture(t);
  const d = createImportDiagnostics({ enabled: true });
  const otherProfile = 'fictional-other-profile';
  d.attachEventStore(first.profileId, first.open());
  d.attachEventStore(otherProfile, second.open());
  for (let i = 0; i < 256; i++) {
    d.record('import.progress', { accountedUnits: 1 }, { profileId: first.profileId });
    d.record('import.progress', { accountedUnits: 2 }, { profileId: otherProfile });
  }
  for (const [profileId, expected] of [
    [first.profileId, 1],
    [otherProfile, 2],
  ] as const) {
    const result = await d.exportArchive(profileId);
    assert.equal(result.status, 'available');
    assert.equal(result.windowCoverage[0]!.checkpointedPersistedEvents, 256);
    assert.equal(result.windowCoverage[0]!.readableEvents, 256);
    assert.equal(result.windowCoverage[0]!.knownPersistedNotExportedEvents, 0);
    assert.equal(result.windowOrigins.length, 1);
    assert.equal(result.windowOrigins[0]!.windowId, result.currentWindow.windowId);
    assert.equal(result.windowOrigins[0]!.observedBeforeAttachment, 0);
    assert.equal(result.events[1]!.event.sequence - result.events[0]!.event.sequence, 2);
    assert.ok(result.events.every((row) => row.event.fields.accountedUnits === expected));
  }
  d.close();
});

test('scheduled flush retries a frozen publication without new observations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t),
    store = f.open();
  let attempts = 0;
  const archive = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  archive.attach(f.profileId, randomUUID(), {
    ...store,
    append(sequence, bytes) {
      attempts++;
      if (attempts === 2) throw Error('Fictional temporary failure');
      return store.append(sequence, bytes);
    },
  });
  archive.record(f.profileId, event());
  assert.equal(store.work().chunkWrites, 1);
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 2);
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 4);
  assert.equal(store.work().chunkWrites, 3);
  const result = await archive.export(f.profileId, (value) => value);
  assert.equal(result.events.length, 1);
  assert.equal(result.currentWindow.writeFailures, 1);
  archive.close();
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 4);
});

test('loss-only counters coalesce on the timer and unchanged export/flush/close writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t),
    store = f.open();
  const archive = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  archive.attach(f.profileId, randomUUID(), store);
  archive.flush(f.profileId);
  await archive.export(f.profileId, (value) => value);
  assert.equal(store.work().chunkWrites, 1);
  for (let i = 0; i < 100; i++)
    archive.record(f.profileId, {
      ...event(i),
      context: { importId: 'x'.repeat(diagnosticArchiveLimits.maxChunkBytes) },
    });
  assert.equal(store.work().chunkWrites, 1, 'not one chunk per oversized observation');
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(store.work().chunkWrites, 2);
  const result = await archive.export(f.profileId, (value) => value);
  assert.equal(result.windowCheckpoints[0]!.droppedEvents, 100);
  archive.flush(f.profileId);
  await archive.export(f.profileId, (value) => value);
  const before = store.work();
  archive.close();
  const restoredStore = f.open();
  assert.equal(restoredStore.inventory().chunks.length, before.chunkWrites);
  restoredStore.close();
});

test('latest cumulative checkpoints stay separate across windows and survive close-only publication', async (t) => {
  const f = fixture(t);
  const first = createImportDiagnostics({ enabled: true });
  first.attachEventStore(f.profileId, f.open());
  for (let i = 0; i < 256; i++) first.record('import.progress', {}, { profileId: f.profileId });
  const firstWindow = (await first.exportArchive(f.profileId)).currentWindow.windowId;
  first.close();
  const second = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  const secondWindow = randomUUID();
  second.attach(f.profileId, secondWindow, f.open());
  for (let i = 0; i < 3; i++)
    second.record(f.profileId, {
      ...event(i),
      context: { importId: 'x'.repeat(diagnosticArchiveLimits.maxChunkBytes) },
    });
  second.close();
  const recovered = createImportDiagnostics();
  t.after(() => recovered.close());
  recovered.attachEventStore(f.profileId, f.open());
  const result = await recovered.exportArchive(f.profileId);
  assert.equal(result.events.length, 256);
  assert.equal(result.windowCheckpoints.length, 2);
  assert.equal(
    result.windowCheckpoints.find((item) => item.windowId === firstWindow)!.persistedEvents,
    256,
  );
  assert.equal(
    result.windowCheckpoints.find((item) => item.windowId === secondWindow)!.droppedEvents,
    3,
  );
  assert.equal(result.status, 'partial');
  assert.equal(result.currentWindow.observedEvents, 0);
});

test('evicting an entire lost window leaves previous history unknown', async (t) => {
  const f = fixture(t, 1);
  const lost = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  lost.attach(f.profileId, randomUUID(), f.open());
  lost.record(f.profileId, {
    ...event(),
    context: { importId: 'x'.repeat(diagnosticArchiveLimits.maxChunkBytes) },
  });
  lost.close();
  const next = createImportDiagnostics({ enabled: true });
  next.attachEventStore(f.profileId, f.open());
  next.record('import.progress', {}, { profileId: f.profileId });
  next.close();
  const recovered = createImportDiagnostics();
  t.after(() => recovered.close());
  recovered.attachEventStore(f.profileId, f.open());
  const result = await recovered.exportArchive(f.profileId);
  assert.equal(result.windowCheckpoints.length, 1);
  assert.equal(result.windowCoverage.length, 1);
  assert.equal(result.windowCoverage[0]!.knownPersistedNotExportedEvents, 0);
  assert.equal(result.windowOrigins.length, 1);
  assert.equal(result.windowOrigins[0]!.windowId, result.windowCheckpoints[0]!.windowId);
  assert.equal(result.windowCheckpoints[0]!.droppedEvents, 0);
  assert.equal(result.omittedBeforeInventory, null);
  assert.equal(result.crashTailEvents, null);
  assert.equal(result.completeness, 'not_established');
});

test('strict checkpoint envelopes reject unsupported schemas, private keys and unsafe or regressing counters', async (t) => {
  const f = fixture(t),
    store = f.open(),
    windowId = randomUUID();
  const base = {
    format: 'circus-import-events-v3',
    windowId,
    origin: {
      windowId,
      attachedAt: '2026-01-01T00:00:00.000Z',
      recordingAtAttachment: 'enabled',
      observedBeforeAttachment: 0,
    },
    events: [],
    checkpoint: {
      observedEvents: 4,
      persistedEvents: 0,
      droppedEvents: 4,
      oversizedEvents: 1,
      writeFailures: 1,
    },
  };
  const invalid = [
    { ...base, format: 'circus-import-events-v1' },
    { ...base, private: 'Fictional secret checkpoint canary' },
    { ...base, checkpoint: { ...base.checkpoint, private: 'Fictional secret checkpoint canary' } },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, 'Fictional secret checkpoint canary'].map(
      (value) => ({ ...base, checkpoint: { ...base.checkpoint, observedEvents: value } }),
    ),
    { ...base, checkpoint: { ...base.checkpoint, oversizedEvents: 5 } },
    { ...base, checkpoint: { ...base.checkpoint, persistedEvents: 1 } },
    { ...base, checkpoint: [] },
  ];
  let sequence = 1;
  for (const chunk of invalid) store.append(sequence++, Buffer.from(JSON.stringify(chunk)));
  store.append(sequence++, Buffer.from(JSON.stringify(base)));
  store.append(
    sequence++,
    Buffer.from(JSON.stringify({ ...base, checkpoint: { ...base.checkpoint, writeFailures: 0 } })),
  );
  // A payload requires new persisted events, even when all counters are individually monotone.
  store.append(
    sequence++,
    Buffer.from(
      JSON.stringify({
        ...base,
        events: [event()],
        checkpoint: { ...base.checkpoint, observedEvents: 5, persistedEvents: 1 },
      }),
    ),
  );
  store.append(
    sequence,
    Buffer.from(
      JSON.stringify({
        ...base,
        events: [event(2)],
        checkpoint: { ...base.checkpoint, observedEvents: 6, persistedEvents: 1 },
      }),
    ),
  );
  store.close();
  const restored = createImportDiagnostics();
  t.after(() => restored.close());
  restored.attachEventStore(f.profileId, f.open());
  const result = await restored.exportArchive(f.profileId);
  assert.equal(result.invalidChunks, invalid.length + 2);
  assert.equal(result.windowCheckpoints.length, 1);
  assert.equal(result.windowCheckpoints[0]!.writeFailures, 1);
  assert.equal(result.status, 'partial');
  assert.equal(JSON.stringify(result).includes('canary'), false);
});

test('checkpoint reserve keeps nearly full event payloads inside the plaintext chunk limit', async (t) => {
  const f = fixture(t),
    store = f.open();
  let largestChunk = 0;
  const archive = createImportDiagnosticArchive(true, (value) => value as ImportDiagnosticEvent);
  archive.attach(f.profileId, randomUUID(), {
    ...store,
    append(sequence, bytes) {
      largestChunk = Math.max(largestChunk, bytes.byteLength);
      assert.ok(bytes.byteLength <= diagnosticArchiveLimits.maxChunkBytes);
      return store.append(sequence, bytes);
    },
  });
  for (let i = 0; i < 3; i++)
    archive.record(f.profileId, {
      ...event(i),
      context: { importId: 'x'.repeat(diagnosticArchiveLimits.maxChunkBytes - 1000) },
    });
  const result = await archive.export(f.profileId, (value) => ({ ...value, context: {} }));
  assert.equal(result.events.length, 3);
  assert.ok(largestChunk > diagnosticArchiveLimits.maxChunkBytes - 1000);
  assert.equal(result.windowCheckpoints[0]!.persistedEvents, 3);
  archive.close();
});

test('attachment origin precedes first archived observation and preserves pre-attachment count', async (t) => {
  const f = fixture(t),
    store = f.open();
  let at = '2026-01-01T00:00:00.000Z';
  const d = createImportDiagnostics({ enabled: true, now: () => new Date(at) });
  d.record('import.progress', {}, { profileId: f.profileId });
  const before = d.exportSnapshot(f.profileId);
  at = '2026-01-01T01:00:00.000Z';
  d.attachEventStore(f.profileId, store);
  assert.equal(store.work().chunkWrites, 1);
  const zero = await d.exportArchive(f.profileId);
  assert.equal(zero.events.length, 0);
  assert.deepEqual(zero.windowOrigins, [
    {
      windowId: before.eventWindow.windowId,
      attachedAt: at,
      recordingAtAttachment: 'enabled',
      observedBeforeAttachment: 1,
    },
  ]);
  assert.equal(zero.windowCheckpoints[0]!.observedEvents, 0);
  at = '2026-01-01T02:00:00.000Z';
  d.record('import.progress', {}, { profileId: f.profileId });
  const after = await d.exportArchive(f.profileId);
  assert.deepEqual(after.windowOrigins, zero.windowOrigins);
  assert.equal(after.events[0]!.event.timestamp, at);
  assert.equal(after.currentWindow.persistedEvents, 1);
  d.close();
  const recovered = createImportDiagnostics({ now: () => new Date('2026-02-01T00:00:00.000Z') });
  recovered.attachEventStore(f.profileId, f.open());
  const restored = await recovered.exportArchive(f.profileId);
  assert.deepEqual(restored.windowOrigins, zero.windowOrigins);
  assert.equal(restored.currentAttachment!.origin.recordingAtAttachment, 'disabled');
  assert.equal(restored.currentAttachment!.publication, 'disabled');
  recovered.close();
});

test('enabled zero-event origins recover without a first event and prefix eviction retains repeated origin', async (t) => {
  for (const records of [0, 256]) {
    const f = fixture(t, 1),
      store = f.open(),
      d = createImportDiagnostics({ enabled: true });
    d.attachEventStore(f.profileId, store);
    const origin = (await d.exportArchive(f.profileId)).windowOrigins[0]!;
    for (let i = 0; i < records; i++) d.record('import.progress', {}, { profileId: f.profileId });
    d.close();
    const recovered = createImportDiagnostics();
    recovered.attachEventStore(f.profileId, f.open());
    const restored = await recovered.exportArchive(f.profileId);
    assert.deepEqual(restored.windowOrigins, [origin]);
    assert.equal(restored.events.length, Math.min(records, 128));
    assert.equal(restored.currentAttachment!.publication, 'disabled');
    recovered.close();
  }
});

test('reattachment creates a fresh live window while flushing and preserving earlier archive evidence', async (t) => {
  const f = fixture(t),
    d = createImportDiagnostics({ enabled: true });
  d.attachEventStore(f.profileId, f.open());
  d.record('import.progress', { accountedUnits: 1 }, { profileId: f.profileId });
  const first = d.exportSnapshot(f.profileId);
  d.attachEventStore(f.profileId, f.open());
  const second = d.exportSnapshot(f.profileId);
  assert.notEqual(second.eventWindow.windowId, first.eventWindow.windowId);
  assert.equal(second.events.length, 0);
  assert.equal(second.eventWindow.observedEvents, 0);
  d.record('import.progress', { accountedUnits: 2 }, { profileId: f.profileId });
  const result = await d.exportArchive(f.profileId);
  assert.equal(result.status, 'available');
  assert.equal(result.windowOrigins.length, 2);
  assert.deepEqual(
    result.windowCheckpoints.map((row) => row.persistedEvents),
    [1, 1],
  );
  assert.equal(result.events[0]!.windowId, first.eventWindow.windowId);
  assert.equal(result.events[1]!.windowId, second.eventWindow.windowId);
  d.close();
});

test('origin publication acknowledgement stays separate from readable evidence and retries identical bytes', async (t) => {
  for (const mode of ['failed', 'lost-ack', 'unreadable'] as const) {
    const f = fixture(t),
      store = f.open(),
      bytes: Buffer[] = [];
    let fail = true;
    const d = createImportDiagnostics({ enabled: true });
    d.attachEventStore(f.profileId, {
      ...store,
      append(sequence, value) {
        bytes.push(Buffer.from(value));
        if (mode === 'failed' && fail) throw Error('Fictional unavailable storage');
        const result = store.append(sequence, value);
        if (mode === 'lost-ack' && fail) throw Error('Fictional missing acknowledgement');
        return result;
      },
      read(sequence) {
        if (mode === 'unreadable') throw Error('Fictional unavailable read');
        return store.read(sequence);
      },
    });
    d.record('import.progress', {}, { profileId: f.profileId });
    const initial = await d.exportArchive(f.profileId);
    assert.equal(
      initial.currentAttachment!.publication,
      mode === 'unreadable' ? 'confirmed' : 'unconfirmed',
    );
    assert.equal(initial.windowOrigins.length, mode === 'lost-ack' ? 1 : 0);
    if (mode !== 'unreadable') {
      assert.deepEqual(bytes[0], bytes[1]);
      fail = false;
      const retried = await d.exportArchive(f.profileId);
      assert.deepEqual(bytes[0], bytes[2]);
      assert.equal(retried.currentAttachment!.publication, 'confirmed');
      assert.equal(retried.windowOrigins.length, 1);
      assert.equal(retried.currentWindow.droppedEvents, 1);
      assert.equal(retried.currentWindow.persistedEvents, 0);
    }
    d.close();
  }
});

test('strict origin validation rejects conflicting and malformed origin envelopes', async (t) => {
  const f = fixture(t),
    store = f.open(),
    windowId = randomUUID();
  const origin = {
    windowId,
    attachedAt: '2026-01-01T00:00:00.000Z',
    recordingAtAttachment: 'enabled',
    observedBeforeAttachment: 0,
  };
  const checkpoint = {
    observedEvents: 0,
    persistedEvents: 0,
    droppedEvents: 0,
    oversizedEvents: 0,
    writeFailures: 0,
  };
  const base = { format: 'circus-import-events-v3', windowId, origin, events: [], checkpoint };
  store.append(1, Buffer.from(JSON.stringify(base)));
  const invalid = [
    { ...base, format: 'circus-import-events-v2' },
    { ...base, origin: { ...origin, extra: 'Fictional private origin canary' } },
    { ...base, origin: { ...origin, windowId: randomUUID() } },
    { ...base, origin: { ...origin, attachedAt: '2026-02-30T00:00:00.000Z' } },
    { ...base, origin: { ...origin, attachedAt: '2026-01-02T00:00:00.000Z' } },
    { ...base, origin: { ...origin, recordingAtAttachment: 'disabled' } },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'unknown'].map((observedBeforeAttachment) => ({
      ...base,
      origin: { ...origin, observedBeforeAttachment },
    })),
    { ...base, origin: { ...origin, observedBeforeAttachment: 1 } },
  ];
  for (const [index, chunk] of invalid.entries())
    store.append(index + 2, Buffer.from(JSON.stringify(chunk)));
  const d = createImportDiagnostics();
  d.attachEventStore(f.profileId, store);
  const result = await d.exportArchive(f.profileId);
  assert.equal(result.invalidChunks, invalid.length);
  assert.deepEqual(result.windowOrigins, [origin]);
  assert.equal(result.status, 'partial');
  assert.doesNotMatch(JSON.stringify(result), /private origin canary/);
  d.close();
});

test('many zero-event attachments retain bounded origins with one write each and one-pass export', async (t) => {
  const f = fixture(t),
    d = createImportDiagnostics({ enabled: true });
  let current: DiagnosticChunkStore;
  for (let i = 0; i < 40; i++) {
    current = f.open();
    d.attachEventStore(f.profileId, current);
    assert.equal(current.work().chunkWrites, 1);
    assert.equal(current.work().chunkReads, 0);
  }
  const result = await d.exportArchive(f.profileId);
  assert.equal(result.windowOrigins.length, 40);
  assert.equal(new Set(result.windowOrigins.map((origin) => origin.windowId)).size, 40);
  assert.equal(current!.work().chunkWrites, 1);
  assert.equal(current!.work().chunkReads, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= diagnosticArchiveLimits.maxExportBytes);
  d.close();
});
