import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportDiagnostics, type ImportDiagnostics } from '../import-diagnostics.ts';
import { openDiagnosticChunkStore } from '../diagnostic-chunk-store.ts';
import { freshKey } from '../vault-crypto.ts';
import {
  isImportRecordingCheck,
  recordingCheckFromArchive,
} from '../../shared/import-recording-check.ts';

function fixture(t: test.TestContext, maxChunks = 256) {
  const directory = mkdtempSync(join(tmpdir(), 'fictional-recording-check-'));
  const key = freshKey(),
    profileId = 'fictional-profile',
    recorders: ImportDiagnostics[] = [];
  const open = () => openDiagnosticChunkStore({ directory, key, profileId, limits: { maxChunks } });
  const recorder = (enabled = true) => {
    const value = createImportDiagnostics({
      enabled,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    recorders.push(value);
    return value;
  };
  t.after(() => {
    for (const value of recorders) value.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  });
  return { open, recorder, profileId };
}

test('zero-event checks read once per inspection and create no check receipt', async (t) => {
  const f = fixture(t),
    d = f.recorder(),
    store = f.open();
  assert.equal((await d.checkRecording(f.profileId)).status, 'not_attached');
  d.record('import.progress', {}, { profileId: f.profileId });
  d.attachEventStore(f.profileId, store);
  assert.equal(store.work().chunkWrites, 1);
  const check = await d.checkRecording(f.profileId);
  assert.equal(check.status, 'current_origin_readable');
  assert.equal(check.currentAttachment!.origin.observedBeforeAttachment, 1);
  assert.equal(check.checkedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(isImportRecordingCheck(check));
  assert.equal(store.work().chunkReads, 1);
  await d.checkRecording(f.profileId);
  assert.equal(store.work().chunkReads, 2);
  assert.equal(store.work().chunkWrites, 1);
  assert.equal(check.completeness, 'not_established');
});

test('disabled capture cannot borrow older enabled origins and writes nothing', async (t) => {
  const f = fixture(t),
    first = f.recorder();
  first.attachEventStore(f.profileId, f.open());
  const previous = await first.checkRecording(f.profileId);
  first.close();
  const d = f.recorder(false),
    store = f.open();
  d.attachEventStore(f.profileId, store);
  const check = await d.checkRecording(f.profileId);
  assert.equal(check.status, 'recording_disabled');
  assert.equal(check.currentOriginReadable, false);
  assert.equal(check.currentAttachment!.publication, 'disabled');
  assert.notEqual(
    check.currentAttachment!.origin.windowId,
    previous.currentAttachment!.origin.windowId,
  );
  assert.equal(store.work().chunkWrites, 0);
});

test('failed, lost acknowledgement and unreadable publication remain distinct', async (t) => {
  for (const mode of ['failed', 'lost-ack', 'unreadable', 'inventory-failed'] as const) {
    const f = fixture(t),
      d = f.recorder(),
      store = f.open();
    d.attachEventStore(f.profileId, {
      ...store,
      append(sequence, bytes) {
        if (mode === 'failed') throw Error('Fictional write unavailable');
        const result = store.append(sequence, bytes);
        if (mode === 'lost-ack') throw Error('Fictional acknowledgement lost');
        return result;
      },
      read(sequence) {
        if (mode === 'unreadable') throw Error('Fictional read unavailable');
        return store.read(sequence);
      },
      inventory() {
        if (mode === 'inventory-failed') throw Error('Fictional inventory unavailable');
        return store.inventory();
      },
    });
    const check = await d.checkRecording(f.profileId);
    assert.equal(
      check.status,
      mode === 'lost-ack'
        ? 'current_origin_readable'
        : mode === 'inventory-failed'
          ? 'inspection_unavailable'
          : 'current_origin_unproven',
    );
    assert.equal(check.currentOriginReadable, mode === 'lost-ack');
    assert.equal(
      check.currentAttachment!.publication,
      mode === 'unreadable' ? 'confirmed' : 'unconfirmed',
    );
    assert.ok(check.archive.coverageWarnings);
    assert.ok(isImportRecordingCheck(check));
  }
});

test('reattachment cannot borrow an old origin, and every immutable field must match', async (t) => {
  const f = fixture(t),
    d = f.recorder();
  d.attachEventStore(f.profileId, f.open());
  const first = await d.checkRecording(f.profileId);
  const store = f.open();
  d.attachEventStore(f.profileId, {
    ...store,
    append() {
      throw Error('Fictional new attachment failure');
    },
  });
  const check = await d.checkRecording(f.profileId);
  assert.equal(check.status, 'current_origin_unproven');
  assert.notEqual(
    check.currentAttachment!.origin.windowId,
    first.currentAttachment!.origin.windowId,
  );
  const archive = await d.exportArchive(f.profileId);
  const origin = archive.currentAttachment!.origin;
  for (const altered of [
    { ...origin, windowId: first.currentAttachment!.origin.windowId },
    { ...origin, attachedAt: '2026-02-01T00:00:00.000Z' },
    { ...origin, observedBeforeAttachment: 12 },
    { ...origin, recordingAtAttachment: 'disabled' as const },
  ]) {
    assert.equal(
      recordingCheckFromArchive({ ...archive, windowOrigins: [altered] }, check.checkedAt)
        .currentOriginReadable,
      false,
    );
  }
});

test('historical prefix omissions do not erase readable current-origin evidence', async (t) => {
  const f = fixture(t, 2),
    d = f.recorder();
  d.attachEventStore(f.profileId, f.open());
  for (let i = 0; i < 400; i++)
    d.record('import.progress', { accountedUnits: i }, { profileId: f.profileId });
  d.attachEventStore(f.profileId, f.open());
  const check = await d.checkRecording(f.profileId);
  assert.equal(check.status, 'current_origin_readable');
  assert.equal(check.archive.status, 'partial');
  assert.equal(check.archive.coverageWarnings, true);
});

test('lock during yielded inspection discards attachment evidence', async (t) => {
  const f = fixture(t),
    d = f.recorder();
  d.attachEventStore(f.profileId, f.open());
  const pending = d.checkRecording(f.profileId);
  d.clear(f.profileId);
  const check = await pending;
  assert.equal(check.status, 'inspection_unavailable');
  assert.equal(check.currentAttachment, null);
  assert.equal(check.currentOriginReadable, false);
});

test('response validation rejects arbitrary payloads and inconsistent positive claims', async (t) => {
  const f = fixture(t),
    d = f.recorder();
  d.attachEventStore(f.profileId, f.open());
  const good = await d.checkRecording(f.profileId);
  for (const bad of [
    {
      ...good,
      recording: 'disabled',
      status: 'recording_disabled',
      currentAttachment: {
        origin: { ...good.currentAttachment!.origin, recordingAtAttachment: 'disabled' },
        publication: 'disabled',
      },
    },
    ...['available', 'partial'].map((status) => ({
      ...good,
      status: 'not_attached',
      currentAttachment: null,
      currentOriginReadable: false,
      archive: { status, coverageWarnings: status === 'partial' },
    })),
    { ...good, recording: ['enabled'] },
    { ...good, archive: { ...good.archive, status: ['available'] } },
    { ...good, currentAttachment: { ...good.currentAttachment, publication: ['confirmed'] } },
  ])
    assert.equal(isImportRecordingCheck(bad), false);
  for (const bad of [
    { ...good, clinicalText: 'Fictional private canary' },
    { ...good, archive: { ...good.archive, extra: true } },
    { ...good, currentAttachment: { ...good.currentAttachment, extra: true } },
    {
      ...good,
      currentAttachment: {
        ...good.currentAttachment,
        origin: { ...good.currentAttachment!.origin, extra: true },
      },
    },
    { ...good, currentAttachment: null },
    { ...good, checkedAt: '2026-02-30T00:00:00.000Z' },
    { ...good, archive: { status: 'unavailable', coverageWarnings: true } },
  ])
    assert.equal(isImportRecordingCheck(bad), false);
});
