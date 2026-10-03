import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { sourceFileDetails } from '../intake-state-access.ts';
import { stageIntakeEnvelope } from '../intake-authority.ts';
import { validateProductionIntakeAuthority } from '../intake-state-bootstrap.ts';
import { intakeWorkCounters, recordIntakeWork, withIntakeWork } from '../intake-work-accounting.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
} from './helpers/intake-authority-fixture.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  createIntakeBatchJournalWorkCounters,
  readIntakeBatch,
  withIntakeBatchJournalWork,
  writeIntakeBatch,
} from '../intake-batch-journal.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';
import { getIntakeOriginal, uploadIntake } from '../intake.ts';
import { inspectIntakeFile, verifyIntakeFileHash } from '../intake-files.ts';
import {
  createIntakeFileWorkCounters,
  withIntakeFileWork,
  writeIntakeFileSync,
} from '../intake-file-work.ts';

test('production handles aggregate without sharing counters; full DTO and reconstruction work stay separate', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'intake-work-'));
  const db = openDatabase(join(root, 'state.sqlite'), 'fictional-accounting');
  t.after(() => {
    clearIntakeStateCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  const id = 'fictional-original';
  const value = {
    intake: { originalName: 'fictional.txt', version: 1, proposals: [], text: '😀'.repeat(250) },
  };
  registerRawIntakeFixture(db, id, JSON.stringify(value));
  transaction(db, () => {
    db.prepare('UPDATE source_files SET path=? WHERE id=?').run(
      `data/profiles/fictional-accounting/sources/${id}.txt`,
      id,
    );
    stageIntakeEnvelope(db, { id }, value);
  });
  assert.equal(intakeWorkCounters(db).warm.rawNormalizations, 1);
  const identity = { profileId: 'fictional-accounting', intakeId: id, sourceHash: 'a'.repeat(64) };
  const a = createIntakeStateStorage(db, identity);
  const b = createIntakeStateStorage(db, identity);
  const baseline = intakeWorkCounters(db);
  assert.deepEqual(a.read(), value);
  assert.equal(a.counters.readCopies, 1);
  assert.equal(b.counters.readCopies, 0);
  assert.deepEqual(b.read(), value);
  const warm = intakeWorkCounters(db);
  assert.equal(warm.primitive.readCopies - baseline.primitive.readCopies, 2);
  assert.equal(warm.primitive.coldReconstructions, baseline.primitive.coldReconstructions);
  assert.ok(warm.warm.normalizeValidationNodes > baseline.warm.normalizeValidationNodes);
  assert.deepEqual(sourceFileDetails(db, { id, kind: 'intake_original' }), value);
  const dto = intakeWorkCounters(db);
  assert.equal(dto.warm.sourceDTOHydrations - warm.warm.sourceDTOHydrations, 1);
  assert.equal(
    dto.warm.sourceDTOEnvelopeBytes - warm.warm.sourceDTOEnvelopeBytes,
    Buffer.byteLength(JSON.stringify(value)),
  );
  assert.equal(a.counters.readCopies, 1);
  assert.equal(b.counters.readCopies, 1);
  const compact = db.prepare('SELECT details_json FROM source_files WHERE id=?').get(id)!
    .details_json as string;
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(JSON.stringify(value)));
  clearIntakeStateCache(db);
  assert.deepEqual(a.read(), value);
  const cold = intakeWorkCounters(db);
  assert.equal(cold.primitive.coldReconstructions - dto.primitive.coldReconstructions, 1);
  assert.ok(cold.reconstruction.evidenceFrameReadBytes > dto.reconstruction.evidenceFrameReadBytes);
  assert.ok(cold.reconstruction.hashedBytes > dto.reconstruction.hashedBytes);
  assert.equal(cold.warm.hashedBytes, dto.warm.hashedBytes);
  validateProductionIntakeAuthority(db);
  const opened = intakeWorkCounters(db);
  assert.ok(
    opened.reconstruction.evidenceReplayVersions > cold.reconstruction.evidenceReplayVersions,
  );
  opened.primitive.readCopies = -100;
  assert.ok(intakeWorkCounters(db).primitive.readCopies > 0);
});

test('nested accounting restores database and phase attribution after exceptions', () => {
  const a = openDatabase(':memory:', 'fictional-a');
  const b = openDatabase(':memory:', 'fictional-b');
  try {
    withIntakeWork(a, 'reconstruction', () => {
      withIntakeWork(a, 'warm', () => recordIntakeWork('diffNodeVisits', 2));
      assert.throws(
        () =>
          withIntakeWork(b, 'warm', () => {
            recordIntakeWork('diffNodeVisits', 3);
            throw Error('fictional failure');
          }),
        /fictional failure/,
      );
      recordIntakeWork('diffNodeVisits', 5);
    });
    recordIntakeWork('diffNodeVisits', 100);
    assert.equal(intakeWorkCounters(a).reconstruction.diffNodeVisits, 7);
    assert.equal(intakeWorkCounters(a).warm.diffNodeVisits, 0);
    assert.equal(intakeWorkCounters(b).warm.diffNodeVisits, 3);
  } finally {
    a.close();
    b.close();
  }
});

test('journal counts actual reread, replay, diff and writes across awaited API work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batch-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileId = 'fictional-journal';
  const paths = ensureProfileDirectories(root, profileId);
  const batch: IntakeBatch = {
    id: randomUUID(),
    profileId,
    operationId: randomUUID(),
    status: 'paused',
    reason: null,
    currentIndex: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    items: [],
  };
  const counters = createIntakeBatchJournalWorkCounters();
  await withIntakeBatchJournalWork(counters, async () => {
    writeIntakeBatch(root, profileId, batch, 'initial');
    await Promise.resolve();
    batch.currentIndex = 1;
    writeIntakeBatch(root, profileId, batch, 'first');
    batch.currentIndex = 2;
    writeIntakeBatch(root, profileId, batch, 'second');
  });
  const directory = join(paths.intakeBatches, batch.id, 'events');
  const events = readdirSync(directory)
    .sort()
    .map((name) => readFileSync(join(directory, name)));
  assert.equal(counters.eventWrites, 3);
  assert.equal(counters.publishedEvents, 3);
  assert.equal(
    counters.eventWriteBytes,
    events.reduce((sum, bytes) => sum + bytes.length, 0),
  );
  assert.equal(counters.eventReads, 3);
  assert.equal(counters.eventReadBytes, 2 * events[0]!.length + events[1]!.length);
  assert.equal(counters.replayedEvents, 3);
  assert.equal(counters.replayedChanges, 1);
  assert.equal(counters.emittedChanges, 2);
  assert.ok(counters.diffSerializedBytes > counters.eventWriteBytes);
  const before = { ...counters };
  assert.deepEqual(readIntakeBatch(root, profileId, batch.id), batch);
  assert.deepEqual(counters, before);
  assert.ok(Object.values(counters).every((value) => typeof value === 'number'));
});

test('actual intake upload/retrieval counts file payloads, stream hashes, cache hits and failed writes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'intake-file-work-'));
  const profileId = 'fictional-file-work';
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('Independently fictional original 😀.\n');
  const counters = createIntakeFileWorkCounters();
  await withIntakeFileWork(counters, async () => {
    const uploaded = uploadIntake(db, root, profileId, {
      filename: 'invented.txt',
      bytes,
      newProviderName: 'Invented source',
    });
    assert.equal(counters.writes, 1);
    assert.equal(counters.writeBytes, bytes.length);
    assert.equal(counters.publications, 1);
    assert.equal(counters.fsyncCalls, 2);
    assert.ok(counters.bufferHashBytes >= bytes.length);
    await Promise.resolve();
    const before = { ...counters };
    const original = getIntakeOriginal(db, root, profileId, uploaded.id);
    assert.deepEqual(original.bytes, bytes);
    assert.equal(counters.readBytes - before.readBytes, bytes.length);
    assert.equal(counters.reads - before.reads, 1);
    const streams = { ...counters };
    inspectIntakeFile(original.path, { bytes: bytes.length, sha256: original.sourceHash });
    assert.equal(counters.inspectionBufferBytes - streams.inspectionBufferBytes, 256 * 1024);
    assert.equal(counters.streamReadAttempts - streams.streamReadAttempts, 2);
    assert.equal(counters.streamReadCalls - streams.streamReadCalls, 2);
    assert.equal(counters.streamReadBytes - streams.streamReadBytes, bytes.length);
    assert.equal(counters.streamHashCalls - streams.streamHashCalls, 1);
    assert.equal(counters.streamHashBytes - streams.streamHashBytes, bytes.length);
    const cached = { ...counters };
    verifyIntakeFileHash(original.path, { bytes: bytes.length, sha256: original.sourceHash });
    assert.equal(counters.verificationCacheHits - cached.verificationCacheHits, 1);
    assert.equal(counters.streamReadBytes, cached.streamReadBytes);
    assert.throws(() => writeIntakeFileSync(-1, bytes));
    assert.equal(counters.writeAttempts, 2);
    assert.equal(counters.writeFailures, 1);
    assert.equal(counters.writeBytes, bytes.length);
  });
  const saved = { ...counters };
  assert.throws(() => writeIntakeFileSync(-1, bytes));
  assert.deepEqual(counters, saved);
  assert.ok(Object.values(counters).every((value) => typeof value === 'number'));
});
