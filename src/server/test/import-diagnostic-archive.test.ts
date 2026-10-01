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
    Buffer.from(JSON.stringify({ format: 'circus-import-events-v1', windowId, events })),
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
  assert.equal(archive.events[0]!.windowId, live.eventWindow.windowId);
  assert.equal(archive.events[0]!.event.context.importId, live.events[0]!.context.importId);
  assert.equal(archive.events[0]!.event.context.requestId, requestId);
  assert.equal(archive.events.at(-1)!.event.sequence, live.events.at(-1)!.sequence);
  assert.equal(store.work().chunkWrites, 3);
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
    for (let i = 0; i < size; i++)
      d.record('import.progress', { accountedUnits: 1 }, { profileId: f.profileId });
    const measured = store.work();
    assert.equal(measured.chunkWrites, size / 128);
    assert.equal(measured.chunkReads, 0);
    assert.equal(measured.indexScans, 1);
    work.push(measured.plaintextBytesWritten);
    d.close();
  }
  assert.ok(work[1]! > work[0]! * 1.9 && work[1]! < work[0]! * 2.1);
});

test('ambiguous publication retries identical bytes and bounds dropped work while persistence fails', async (t) => {
  const f = fixture(t),
    store = f.open(),
    d = createImportDiagnostics({ enabled: true });
  let attempts = 0;
  const flaky: DiagnosticChunkStore = {
    ...store,
    append(sequence, bytes) {
      attempts++;
      const result = store.append(sequence, bytes);
      if (attempts === 1) throw Error('Fictional lost acknowledgement');
      return result;
    },
  };
  d.attachEventStore(f.profileId, flaky);
  for (let i = 0; i < 132; i++)
    assert.doesNotThrow(() => d.record('import.progress', {}, { profileId: f.profileId }));
  assert.equal(attempts, 1, 'no append retry per event while a frozen chunk is pending');
  const exported = await d.exportArchive(f.profileId);
  assert.equal(attempts, 2);
  assert.equal(exported.events.length, 128);
  assert.equal(store.work().chunkWrites, 1);
  assert.equal(exported.currentWindow.droppedEvents, 4);
  assert.equal(exported.currentWindow.writeFailures, 1);
  assert.equal(exported.currentWindow.pendingEvents, 0);
  assert.equal(exported.status, 'partial');
  d.close();
});

test('persistent failure and oversized observations remain bounded and explicit', async (t) => {
  const f = fixture(t),
    store = f.open();
  let attempts = 0;
  const broken: DiagnosticChunkStore = {
    ...store,
    append() {
      attempts++;
      throw Error('Fictional disk failure');
    },
  };
  const d = createImportDiagnostics({ enabled: true });
  d.attachEventStore(f.profileId, broken);
  for (let i = 0; i < 300; i++) d.record('import.progress', {}, { profileId: f.profileId });
  const result = await d.exportArchive(f.profileId);
  assert.equal(attempts, 2);
  assert.equal(result.currentWindow.pendingEvents, 128);
  assert.equal(result.currentWindow.droppedEvents, 172);
  assert.equal(result.status, 'partial');
  d.close();
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
  archive.close();
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
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= diagnosticArchiveLimits.maxExportBytes);
  archive.close();
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
      if (attempts === 1) throw Error('Fictional temporary failure');
      return store.append(sequence, bytes);
    },
  });
  archive.record(f.profileId, event());
  assert.equal(store.work().chunkWrites, 0);
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 1);
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 2);
  assert.equal(store.work().chunkWrites, 1);
  const result = await archive.export(f.profileId, (value) => value);
  assert.equal(result.events.length, 1);
  assert.equal(result.currentWindow.writeFailures, 1);
  archive.close();
  t.mock.timers.tick(diagnosticArchiveLimits.flushIntervalMs);
  assert.equal(attempts, 2);
});
