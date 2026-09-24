import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { fictionalModel } from './fictional-model.ts';
import * as intake from '../intake.ts';
import { listIntakeReportQueue } from '../intake-report-queue.ts';
import { intakeReadingAccounting } from '../intake-reading-accounting.ts';
import {
  conversionCheckpoint,
  conversionResumeContext,
  conversionReadingState,
  recordConversionPageTiming,
} from '../intake-continuation.ts';
import { accountedUnitKind } from '../intake-unit-accounting.ts';
import { writeChat } from '../assistant-journal.ts';
import { writeIntakeBatch } from '../intake-batch-journal.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import type { Intake, IntakeExtractionCoverage } from '../../shared/intake.ts';
import type { IntakeBatch } from '../../shared/intake-batch.ts';

function fixture(t: TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-reading-accounting-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const current = (id: string) => intake.getIntake(db, root, profileId, id);
  const upload = (
    text: string | Uint8Array = 'Independently invented source text',
    filename = 'fictional.txt',
  ) =>
    intake.uploadIntake(db, root, profileId, {
      filename,
      bytes: Buffer.from(text),
      newProviderName: 'Invented source',
    });
  const plan = (item: Intake) =>
    intake.createIntakePlan(db, root, profileId, item.id, { version: current(item.id).version });
  const account = (item: Intake, kinds: IntakeExtractionCoverage['kind'][]) => {
    const latest = current(item.id),
      active = latest.workflow!.plans.find((plan) => plan.status === 'active')!;
    const operationId = randomUUID();
    return intake.submitIntakeBatch(db, root, profileId, item.id, {
      version: latest.version,
      operationId,
      planId: active.id,
      summary: 'Fictional scoped source accounting',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: operationId,
        kind: 'context',
        payload: { text: 'Invented source context' },
        provenance: {
          capturedVia: null,
          sourceSystem: 'Fictional',
          sourceRecordId: null,
          evidenceClass: 'unknown',
          locator: 'Retained scope',
        },
        coverage: {
          status: 'partial',
          notes: ['Source disposition is separate from extraction quality'],
        },
      }),
      coverage: kinds.map((kind, index) => ({
        unitId: active.units[index]!.id,
        kind,
        notes: 'Fictional ' + kind + ' disposition',
      })),
    });
  };
  const activity = () => listIntakeReportQueue(db, root, profileId).activity;
  return { db, root, profileId, current, upload, plan, account, activity };
}

test('empty, unplanned, pending and explicitly accounted sources have different states; none invent clinical completeness', async (t) => {
  const f = fixture(t);
  assert.equal(f.activity().readingAccounting!.state, 'empty');
  const item = f.upload();
  assert.equal(f.activity().readingAccounting!.state, 'unknown');
  assert.equal(f.activity().readingAccounting!.unknownSources, 1);
  await f.plan(item);
  assert.equal(f.activity().readingAccounting!.state, 'pending');
  assert.equal(f.activity().readingAccounting!.units.pending, 1);
  f.account(item, ['inspected']);
  assert.equal(f.activity().readingAccounting!.allSourceOccurrencesAccounted, false);
  f.account(item, ['extracted']);
  const activity = f.activity(),
    accounting = activity.readingAccounting!;
  assert.equal(accounting.state, 'accounted');
  assert.equal(accounting.allSourceOccurrencesAccounted, true);
  assert.equal(accounting.units.extractedClaims, 1);
  assert.equal(accounting.clinicalExtraction, 'unknown');
  assert.equal(accounting.hostReading.unknownSources, 1);
  assert.equal(activity.extractionComplete, false);
});

test('all supported image formats use one durable unit and preserve accounted disposition across rebuild', async (t) => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(2, 2);
  canvas.getContext('2d').fillRect(0, 0, 2, 2);
  const sources = [
    { filename: 'fictional.png', mimeType: 'image/png', bytes: canvas.toBuffer('image/png') },
    { filename: 'fictional.jpg', mimeType: 'image/jpeg', bytes: canvas.toBuffer('image/jpeg') },
    { filename: 'fictional.webp', mimeType: 'image/webp', bytes: canvas.toBuffer('image/webp') },
  ];
  const f = fixture(t);
  for (const source of sources) {
    let item: Intake = f.upload(source.bytes, source.filename);
    assert.equal(item.mimeType, source.mimeType);
    item = await f.plan(item);
    const active = item.workflow!.plans.find((plan) => plan.status === 'active')!;
    assert.deepEqual(
      active.units.map(({ kind, locator, status }) => ({ kind, locator, status })),
      [{ kind: 'image', locator: 'whole retained image', status: 'pending' }],
    );
    item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
      version: item.version,
      summary: 'Model summary alone does not account for the image.',
      jsonlText: JSON.stringify({
        format: 'health-record-v1',
        id: `context-${source.mimeType}`,
        kind: 'context',
        payload: { text: 'Independently fictional visual context' },
        provenance: {
          capturedVia: 'Fictional image',
          sourceSystem: null,
          sourceRecordId: null,
          evidenceClass: 'transcription',
          locator: 'whole image',
        },
        coverage: { status: 'complete_response', notes: ['Whole source model response'] },
      }),
    });
    const beforeReceipt = f.activity().readingAccounting!;
    assert.equal(beforeReceipt.allSourceOccurrencesAccounted, false);
    assert.ok(beforeReceipt.units.pending > 0);
    f.account(item, ['extracted']);
  }
  const accounting = f.activity().readingAccounting!;
  assert.equal(accounting.state, 'accounted');
  assert.equal(accounting.sourceCount, 3);
  assert.equal(accounting.units.total, 3);
  assert.equal(accounting.units.extractedClaims, 3);
  assert.equal(accounting.allSourceOccurrencesAccounted, true);
  assert.equal(accounting.clinicalExtraction, 'unknown');

  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'image-rebuilt'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const restored = listIntakeReportQueue(db, target, f.profileId).activity.readingAccounting!;
    assert.deepEqual(restored, accounting);
    assert.equal(restored.allSourceOccurrencesAccounted, true);
    assert.equal(restored.clinicalExtraction, 'unknown');
  } finally {
    db.close();
  }
});

test('unreadable binary and status or proposal claims cannot acquire image accounting', async (t) => {
  const f = fixture(t);
  let item: Intake = f.upload(Uint8Array.from([0xff, 0xfe, 0xfd, 0xfc]), 'fictional.bin');
  assert.equal(item.mimeType, 'application/octet-stream');
  await assert.rejects(f.plan(item), (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'PLAN_UNSUPPORTED';
  });
  item = intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: f.current(item.id).version,
    summary: 'Unsupported bytes were described without host image evidence.',
    jsonlText: JSON.stringify({
      format: 'health-record-v1',
      id: 'unsupported-summary',
      kind: 'context',
      payload: { text: 'Fictional binary summary' },
      provenance: {
        capturedVia: null,
        sourceSystem: null,
        sourceRecordId: null,
        evidenceClass: 'unknown',
        locator: 'unknown binary',
      },
      coverage: { status: 'complete_response', notes: [] },
    }),
  });
  item.state = 'imported';
  const accounting = intakeReadingAccounting(f.db, f.root, f.profileId, [item], []);
  assert.equal(accounting.state, 'unknown');
  assert.equal(accounting.units.total, 0);
  assert.equal(accounting.allSourceOccurrencesAccounted, false);
  assert.equal(accounting.clinicalExtraction, 'unknown');
});

for (const kind of ['context', 'unreadable'] as const)
  test(`${kind} disposition stops redundant unit scheduling, preserves partial evidence and can be deliberately reopened`, async (t) => {
    const f = fixture(t),
      item = f.upload();
    await f.plan(item);
    let saved = f.account(item, [kind]);
    assert.equal(saved.pendingWorkCount, 0);
    assert.equal(saved.workflow!.plans[0]!.units[0]!.status, 'partial');
    const checkpoint = conversionCheckpoint(
      {},
      { ...saved, workflow: saved.workflow! },
      f.profileId,
    );
    checkpoint.pending.push({
      tool: 'health_intake_plan',
      args: { id: item.id, unitId: saved.workflow!.plans[0]!.units[0]!.id },
    });
    const retained = structuredClone(checkpoint);
    const resume = conversionResumeContext(checkpoint, { ...saved, workflow: saved.workflow! });
    assert.equal(resume.pendingUnits, 0);
    assert.equal(resume.pendingReadWindows, 0);
    assert.deepEqual(checkpoint, retained, 'raw cursors remain available for explicit retry');
    const accounting = f.activity().readingAccounting!;
    assert.equal(accounting.state, 'accounted_with_gaps');
    assert.equal(accounting.allSourceOccurrencesAccounted, true);
    assert.equal(
      kind === 'context' ? accounting.units.contextOnly : accounting.units.unreadable,
      1,
    );
    saved = f.account(item, ['inspected']);
    assert.equal(saved.pendingWorkCount, 1);
    const retry = conversionResumeContext(checkpoint, { ...saved, workflow: saved.workflow! });
    assert.equal(retry.pendingUnits, 1);
    assert.equal(retry.pendingReadWindows, 1);
    assert.equal(saved.workflow!.plans[0]!.batches.length, 2);
  });

test('a status flag or role claim alone cannot account missing extraction units', async (t) => {
  const f = fixture(t),
    item = await f.plan(f.upload());
  const plan = item.workflow!.plans[0]!;
  plan.units[0]!.status = 'completed';
  assert.equal(accountedUnitKind(plan, plan.units[0]!), null);
  const accounting = intakeReadingAccounting(f.db, f.root, f.profileId, [item], []);
  assert.equal(accounting.allSourceOccurrencesAccounted, false);
  plan.pins.sourceHash = 'fictional-stale-hash';
  assert.equal(intakeReadingAccounting(f.db, f.root, f.profileId, [item], []).state, 'unknown');
});

test('host checkpoint evidence is source/profile pinned and distinguishes pending reads from explicit dispositions', async (t) => {
  const f = fixture(t),
    item = await f.plan(f.upload());
  const chatId = randomUUID();
  intake.linkIntakeConversion(f.db, f.root, f.profileId, item.id, chatId);
  let saved = f.current(item.id);
  const checkpoint = conversionCheckpoint({}, { ...saved, workflow: saved.workflow! }, f.profileId);
  checkpoint.seen.push('fictional-successful-window');
  checkpoint.pending.push({
    tool: 'health_intake_plan',
    args: { id: item.id, unitId: saved.workflow!.plans[0]!.units[0]!.id },
  });
  writeChat(
    f.root,
    f.profileId,
    { id: chatId, conversionCheckpoint: checkpoint, reading: { reason: 'time_limit' } },
    'fictional',
  );
  let result = f.activity().readingAccounting!;
  assert.equal(result.hostReading.pendingWindows, 1);
  assert.equal(result.hostReading.checkpoints, 1);
  assert.deepEqual(result.pauseReasons, [{ reason: 'time_limit', files: 1 }]);
  saved = f.account(item, ['unreadable']);
  result = f.activity().readingAccounting!;
  assert.equal(result.hostReading.pendingWindows, 0);
  assert.equal(result.hostReading.dispositionedWindows, 1);
  assert.equal(result.hostReading.exhaustedSources, 0);
  writeChat(
    f.root,
    f.profileId,
    {
      id: chatId,
      conversionCheckpoint: { ...checkpoint, profileId: 'foreign' },
      reading: { reason: 'reading_exhausted' },
    },
    'fictional-invalid-scope',
  );
  result = f.activity().readingAccounting!;
  assert.equal(result.hostReading.checkpoints, 0);
  assert.equal(result.hostReading.unknownSources, 1);
  assert.equal(result.hostReading.exhaustedSources, 0);
  assert.equal(saved.workflow!.decisions.length, 0);
});

test('known missing/supplied assets and unknown package roles remain explicit accounting gaps', async (t) => {
  const f = fixture(t),
    item = await f.plan(
      f.upload(
        '<html><body><p>Fictional source</p><img src="missing.png"></body></html>',
        'fictional.html',
      ),
    );
  f.account(
    item,
    item.workflow!.plans[0]!.units.map(() => 'extracted'),
  );
  const result = f.activity().readingAccounting!;
  assert.equal(result.allSourceOccurrencesAccounted, true);
  assert.equal(result.state, 'accounted_with_gaps');
  assert.ok(result.dependencies.missing > 0);
  assert.equal(result.clinicalExtraction, 'unknown');
});

test('latest source-pinned pauses distinguish time, no-progress and exhaustion without calling a finished batch complete extraction', async (t) => {
  const f = fixture(t),
    item = await f.plan(f.upload());
  const batch: IntakeBatch = {
    id: randomUUID(),
    profileId: f.profileId,
    operationId: 'fictional-batch',
    status: 'complete',
    reason: null,
    currentIndex: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    items: [
      {
        intakeId: item.id,
        sourceHash: item.sha256,
        filename: item.filename,
        mimeType: item.mimeType,
        status: 'review_ready',
        reason: 'bounded_pass_ready',
        chatId: null,
        proposalIds: [],
        startedAt: null,
        endedAt: null,
        reading: {
          status: 'paused',
          reason: 'no_progress',
          turns: 2,
          readyRecords: 1,
          remainingUnits: 1,
          pendingReadWindows: 1,
          coverage: 'reading_progress_only',
        },
      },
    ],
  };
  writeIntakeBatch(f.root, f.profileId, batch, 'fictional-paused');
  assert.deepEqual(f.activity().readingAccounting!.pauseReasons, [
    { reason: 'no_progress', files: 1 },
  ]);
  assert.equal(f.activity().readingAccounting!.hostReading.exhaustedSources, 0);
  batch.items[0]!.sourceHash = 'wrong-original';
  writeIntakeBatch(f.root, f.profileId, batch, 'fictional-stale-scope');
  assert.deepEqual(f.activity().readingAccounting!.pauseReasons, []);
});

test('exact ZIP occurrence accounting preserves duplicate copies and survives backup/rebuild with raw partial dispositions', async (t) => {
  const { readIntakePackageMember } = await import('../intake-package.ts');
  const bytes = zipFixture([
    { name: 'first.txt', data: 'Invented source text' },
    { name: 'copy.txt', data: 'Invented source text' },
  ]);
  const f = fixture(t);
  const original = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional.zip',
    bytes,
    newProviderName: 'Fictional package',
  });
  const planned = await f.plan(original);
  const members = planned.workflow!.plans[0]!.index.members!;
  const child = await readIntakePackageMember({
    db: f.db,
    root: f.root,
    profileId: f.profileId,
    id: original.id,
    memberId: members[0]!.memberId,
  });
  f.account(original, ['context']);
  let accounting = f.activity().readingAccounting!;
  assert.equal(accounting.packageOccurrences.total, 2);
  assert.equal(accounting.packageOccurrences.accounted, 1);
  assert.equal(accounting.packageOccurrences.pending, 1);
  assert.equal(accounting.packageOccurrences.duplicateBytes, 1);
  assert.equal(accounting.parentAccountedChildren, 1);
  assert.equal(accounting.allSourceOccurrencesAccounted, false);
  f.account(original, ['context', 'unreadable']);
  accounting = f.activity().readingAccounting!;
  assert.equal(accounting.allSourceOccurrencesAccounted, true);
  assert.equal(accounting.packageOccurrences.accounted, 2);
  assert.equal(accounting.packageOccurrences.unknownRoles, 2);
  assert.equal(accounting.clinicalExtraction, 'unknown');
  assert.ok(child.sourceFileId);
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'recovered'),
    restored = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const db = openDatabase(restored.database, f.profileId);
  try {
    assert.deepEqual(
      listIntakeReportQueue(db, target, f.profileId).activity.readingAccounting,
      accounting,
    );
  } finally {
    db.close();
  }
});

test('recent page intervals are observed within one turn, bounded and reset for a new context', (t) => {
  const f = fixture(t),
    item = f.upload();
  const current = { ...f.current(item.id), workflow: f.current(item.id).workflow! };
  const cp = conversionCheckpoint({}, current, 'cookie-dough');
  cp.turns = 1;
  recordConversionPageTiming(cp, '2026-09-23T01:00:00.000Z', 12);
  let reading = conversionReadingState(cp, current);
  assert.equal(
    reading.pageTiming?.recentIntervalMs,
    null,
    'first page has no prior completion interval',
  );
  assert.equal(reading.pageTiming?.lastReadMs, 12);
  for (let i = 1; i <= 8; i++)
    recordConversionPageTiming(cp, `2026-09-23T01:00:${String(i).padStart(2, '0')}.000Z`, i);
  reading = conversionReadingState(cp, current);
  assert.equal(reading.pageTiming?.intervalSamples, 5);
  assert.equal(reading.pageTiming?.recentIntervalMs, 1000);
  const recovered = JSON.parse(JSON.stringify(cp));
  recovered.turns++;
  reading = conversionReadingState(recovered, current);
  assert.equal(reading.pageTiming?.turn, 2);
  assert.equal(reading.pageTiming?.recentIntervalMs, null);
  assert.equal(reading.pageTiming?.lastCompletedAt, null);
  recordConversionPageTiming(recovered, '2026-09-23T02:00:00.000Z', 25);
  reading = conversionReadingState(recovered, current);
  assert.equal(reading.pageTiming?.intervalSamples, 0, 'restart gap must not become a page cost');
  assert.equal(reading.pageTiming?.lastReadMs, 25);
});
