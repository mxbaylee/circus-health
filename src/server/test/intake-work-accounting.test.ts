import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeSourceMetadata, sourceFileDetails } from '../intake-state-access.ts';
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
  trackIntakeBatch,
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
  // Verified immutable state needs detached result copies, not another input
  // validation. Keep that real copying visible under its own accounting scope.
  assert.equal(warm.warm.normalizeValidationNodes, baseline.warm.normalizeValidationNodes);
  assert.equal(warm.warm.normalizeCalls, baseline.warm.normalizeCalls);
  assert.equal(warm.warm.trustedCloneCalls - baseline.warm.trustedCloneCalls, 2);
  assert.ok(warm.warm.trustedCloneNodes > baseline.warm.trustedCloneNodes);
  assert.equal(
    warm.primitive.readCopyBytes - baseline.primitive.readCopyBytes,
    2 * Buffer.byteLength(JSON.stringify(value)),
  );
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

test('journal attributes asynchronous warm writes, detached snapshots and cold recovery separately', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'batch-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileId = 'fictional-journal';
  const paths = ensureProfileDirectories(root, profileId);
  const initial: IntakeBatch = {
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
  const batch = trackIntakeBatch(initial);
  const creation = createIntakeBatchJournalWorkCounters();
  withIntakeBatchJournalWork(creation, () => writeIntakeBatch(root, profileId, batch, 'initial'));
  const counters = createIntakeBatchJournalWorkCounters();
  let detached: typeof counters | undefined;
  await withIntakeBatchJournalWork(counters, async () => {
    batch.currentIndex = 1;
    writeIntakeBatch(root, profileId, batch, 'first');
    detached = { ...counters };
    await Promise.resolve();
    batch.currentIndex = 2;
    writeIntakeBatch(root, profileId, batch, 'second');
  });
  assert.equal(detached!.eventWrites, 1, 'numeric snapshot cannot change after subsequent writes');
  detached!.eventWrites = -100;
  assert.equal(counters.eventWrites, 2, 'mutating a snapshot cannot alter accumulated work');
  const directory = join(paths.intakeBatches, batch.id, 'events');
  const events = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readFileSync(join(directory, name)));
  assert.equal(events.length, 3);
  assert.equal(counters.publishedEvents, 2);
  assert.equal(creation.eventWriteBytes, events[0]!.length);
  assert.equal(counters.eventWriteBytes, events[1]!.length + events[2]!.length);
  assert.equal(counters.eventSerializedBytes, counters.eventWriteBytes);
  assert.equal(counters.headWrites, 2);
  assert.ok(counters.headWriteBytes > 0);
  assert.equal(counters.eventReads, 0);
  assert.equal(counters.eventReadBytes, 0);
  assert.equal(counters.replayedEvents, 0);
  assert.equal(counters.replayedChanges, 0);
  assert.equal(counters.directoryEntries, 0);
  assert.equal(counters.diffCalls, 0);
  assert.equal(counters.diffSerializedBytes, 0);
  assert.equal(counters.emittedChanges, 2);
  assert.ok(counters.hashedBytes >= counters.eventWriteBytes);
  const before = { ...counters };
  const cold = createIntakeBatchJournalWorkCounters();
  assert.deepEqual(
    withIntakeBatchJournalWork(cold, () => readIntakeBatch(root, profileId, batch.id)),
    { ...initial, currentIndex: 2 },
  );
  assert.deepEqual(
    counters,
    before,
    'a later cold read cannot retroactively change a warm interval',
  );
  assert.equal(cold.eventReads, 3);
  assert.equal(cold.replayedEvents, 3);
  assert.equal(
    cold.eventReadBytes,
    events.reduce((sum, bytes) => sum + bytes.length, 0),
  );
  assert.equal(cold.eventWrites, 0);
  assert.ok(cold.hashedBytes >= cold.eventReadBytes);
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
    clearIntakeStateCache(db);
    const metadataBefore = intakeWorkCounters(db);
    const original = getIntakeOriginal(db, root, profileId, uploaded.id);
    assert.deepEqual(original.bytes, bytes);
    assert.equal(original.filename, 'invented.txt');
    const metadataAfter = intakeWorkCounters(db);
    assert.equal(metadataAfter.warm.envelopeHydrations, metadataBefore.warm.envelopeHydrations);
    assert.equal(
      metadataAfter.primitive.coldReconstructions,
      metadataBefore.primitive.coldReconstructions,
    );
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

test('compact original headers preserve raw duplicate semantics and reject missing selected authority', (t) => {
  const db = openDatabase(':memory:', 'fictional-header');
  t.after(() => db.close());
  memoryRecordAuthority(db);
  const id = 'fictional-raw-header';
  registerRawIntakeFixture(
    db,
    id,
    '{"unknown":{"retained":true},"intake":{"originalName":"first.txt","version":1},"intake":{"originalName":"earlier.txt","originalName":"last.txt","version":2,"workflow":{"format":"health-intake-workflow-v1"}}}',
  );
  clearIntakeStateCache(db);
  const before = intakeWorkCounters(db);
  assert.equal(intakeSourceMetadata(db, id).originalName, 'last.txt');
  const after = intakeWorkCounters(db);
  assert.equal(after.warm.envelopeHydrations, before.warm.envelopeHydrations);
  assert.equal(after.primitive.coldReconstructions, before.primitive.coldReconstructions);
  transaction(db, () => db.prepare("DELETE FROM app_meta WHERE key GLOB '*:head'").run());
  assert.throws(() => intakeSourceMetadata(db, id), /missing selected intake head/);
});
