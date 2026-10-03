import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { IntakePackageFailure } from '../../shared/intake.ts';
import { zipFixture } from '../../tests/fixtures/zip.ts';
import { HttpError, openDatabase } from '../database.ts';
import {
  getIntake,
  getIntakeOriginal,
  uploadIntake,
  workflowMutation,
  proposeConversion,
  importIntake,
  reviewIntake,
  saveIntakeReviewDraft,
} from '../intake.ts';
import {
  modelIntakeContext,
  MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES,
} from '../intake-model-context.ts';
import {
  recordIntakePackageFailure,
  resolveIntakePackageFailure,
  sanitizePackageFailureDetail,
} from '../intake-package-failures.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { readStoredIntakeDetails } from '../intake-state-access.ts';
import { attachPersonalDurability, rebuildProfile } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createBackup } from '../recovery.ts';
import { fictionalModel } from './fictional-model.ts';

function fixture(
  t: TestContext,
  bytes = zipFixture([{ name: 'reports/fictional.pdf', data: 'fictional retained evidence' }]),
  filename = 'fictional-delivery.zip',
) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-failures-'));
  const profileId = 'cookie-dough';
  const db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const intake = uploadIntake(db, root, profileId, {
    filename,
    newProviderName: 'Fictional clinic',
    bytes,
  });
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId, id: intake.id, bytes };
}

const failureInput = {
  operationKey: 'extract:member:fictional',
  memberId: 'member:fictional',
  ordinal: 17,
  filename: 'reports/fictional.pdf',
  locator: 'ZIP member reports/fictional.pdf',
  reasonCode: 'PACKAGE_CRC',
  detail: 'Member checksum did not match. Original retained.',
};

test('selected durable package failures name exact unfinished scope, replay without writes, and clear only matching operations', (t) => {
  const f = fixture(t);
  const before = getIntake(f.db, f.root, f.profileId, f.id);
  const record = (input = failureInput) =>
    recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, input);
  const first = record();
  assert.equal(first.version, before.version + 1);
  assert.deepEqual(Object.values(first.packageFailures!)[0], {
    sourceFileId: f.id,
    sourceHash: before.sha256,
    operationKey: failureInput.operationKey,
    originalFilename: before.filename,
    contentUrl: before.contentUrl,
    memberId: failureInput.memberId,
    ordinal: 17,
    filename: failureInput.filename,
    locator: failureInput.locator,
    reasonCode: 'PACKAGE_CRC',
    detail: failureInput.detail,
    status: 'pending',
    scope: 'incomplete',
    retryAction: 'read_member',
  });
  assert.equal(first.imported, null);
  assert.equal(first.acceptedProposalId, null);
  assert.equal(first.proposals.length, 0);
  assert.equal(first.state, 'needs_review');
  assert.equal(first.needsReview, true);
  assert.deepEqual(getIntakeOriginal(f.db, f.root, f.profileId, f.id).bytes, f.bytes);
  const work = intakeWorkCounters(f.db).primitive;
  const writes = f.db.prepare('SELECT total_changes() AS writes').get()!.writes;
  assert.equal(record().version, first.version);
  assert.equal(
    resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, { operationKey: 'inventory' })
      .version,
    first.version,
  );
  assert.equal(f.db.prepare('SELECT total_changes() AS writes').get()!.writes, writes);
  assert.equal(intakeWorkCounters(f.db).primitive.framesWritten, work.framesWritten);
  const withStructure = record({
    ...failureInput,
    operationKey: 'structure:member:fictional',
    reasonCode: 'JSON_LIMIT',
  });
  const resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(Object.keys(resolved.packageFailures!).length, 1);
  assert.equal(
    Object.values(resolved.packageFailures!)[0].operationKey,
    'structure:member:fictional',
  );
  assert.equal(resolved.version, withStructure.version + 1);
  assert.equal(resolved.needsReview, true);
  const again = record();
  assert.equal(Object.keys(again.packageFailures!).length, 2);
  assert.equal(again.version, resolved.version + 1);
});

test('accounted units stay accounted while pending package failures prevent completed review, and matching resolution preserves other work', (t) => {
  const f = fixture(t);
  const original = getIntake(f.db, f.root, f.profileId, f.id);
  workflowMutation(f.db, f.root, f.profileId, f.id, { version: original.version }, (workflow) => {
    const coverage = {
      unitId: 'unit:fictional',
      kind: 'context' as const,
      notes: 'Fictional context disposition.',
    };
    workflow.plans.push({
      id: 'plan:fictional',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      pins: {
        sourceHash: original.sha256,
        backend: 'fictional',
        model: null,
        reasoningEffort: null,
        instructionVersion: 'fictional',
        mappingVersion: 'fictional',
      },
      index: { kind: 'zip', coverage: 'inventory_only', missingAssets: [] },
      units: [
        {
          id: coverage.unitId,
          kind: 'package_member',
          locator: failureInput.locator,
          status: 'completed',
          attempts: ['batch:fictional'],
          coverage,
        },
      ],
      batches: [
        {
          id: 'batch:fictional',
          proposalId: 'proposal:fictional',
          at: '2026-01-01T00:00:00.000Z',
          coverage: [coverage],
        },
      ],
    });
  });
  const accounted = getIntake(f.db, f.root, f.profileId, f.id);
  assert.equal(accounted.pendingWorkCount, 0);
  assert.equal(accounted.needsReview, false);
  const pending = recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  assert.equal(pending.pendingWorkCount, 0);
  assert.equal(pending.needsReview, true);
  assert.equal(pending.state, 'needs_review');
  const resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.pendingWorkCount, 0);
  assert.equal(resolved.needsReview, false);
  assert.equal(resolved.state, 'pending_conversion');
  workflowMutation(f.db, f.root, f.profileId, f.id, { version: resolved.version }, (workflow) => {
    workflow.plans[0].units.push({
      id: 'unit:unfinished',
      kind: 'package_member',
      locator: 'ZIP member fictional-unread.txt',
      status: 'pending',
      attempts: [],
    });
  });
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  const stillPending = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(stillPending.pendingWorkCount, 1);
  assert.equal(stillPending.needsReview, true);
  assert.equal(stillPending.state, 'needs_review');
});

const literalEnvelope = (kind: 'context' | 'record' = 'context') =>
  JSON.stringify({
    format: 'health-record-v1',
    id: 'fictional-literal',
    kind,
    payload: 'Fictional literal source context.',
    provenance: {
      capturedVia: 'Fictional delivery',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'provider_export',
      locator: 'Fictional original',
    },
    coverage: { status: 'unknown', notes: ['Fictional source coverage remains unknown.'] },
  });

test('final failure resolution restores a validated ready original without accepting source records', (t) => {
  const f = fixture(t, Buffer.from(literalEnvelope()), 'fictional-context.jsonl');
  const initial = getIntake(f.db, f.root, f.profileId, f.id);
  assert.equal(initial.state, 'ready');
  assert.equal(initial.needsReview, false);
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  const resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'ready');
  assert.equal(resolved.needsReview, false);
  assert.equal(resolved.imported, null);
  assert.equal(resolved.acceptedProposalId, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM source_records').get()!.count, 0);
});

test('final failure resolution preserves an existing import and its accepted proposal receipt', (t) => {
  const f = fixture(t);
  const original = getIntake(f.db, f.root, f.profileId, f.id);
  const proposed = proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: original.version,
    jsonlText: literalEnvelope(),
    summary: 'Fictional source context.',
  });
  const imported = importIntake(f.db, f.root, f.profileId, f.id, {
    version: proposed.version,
    proposalId: proposed.proposals[0].id,
  });
  assert.equal(imported.state, 'imported');
  const retainedRows = f.db.prepare('SELECT COUNT(*) AS count FROM source_records').get()!.count;
  const pending = recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  assert.equal(pending.state, 'needs_review');
  const resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'imported');
  assert.equal(resolved.needsReview, false);
  assert.deepEqual(resolved.imported, imported.imported);
  assert.equal(resolved.acceptedProposalId, imported.acceptedProposalId);
  assert.deepEqual(resolved.importHistory, imported.importHistory);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM source_records').get()!.count,
    retainedRows,
  );
});

test('resolution restores a proposed context but keeps other pending candidates in review', (t) => {
  const f = fixture(t);
  const original = getIntake(f.db, f.root, f.profileId, f.id);
  const proposed = proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: original.version,
    jsonlText: literalEnvelope(),
    summary: 'Fictional proposed context.',
  });
  assert.equal(proposed.needsReview, false);
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  let resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'conversion_proposed');
  assert.equal(resolved.imported, null);
  assert.equal(resolved.acceptedProposalId, null);
  proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: resolved.version,
    jsonlText: literalEnvelope('record'),
    summary: 'Fictional unreviewed record.',
  });
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'needs_review');
  assert.equal(resolved.needsReview, true);
  assert.equal(resolved.pendingCount, 1);
  assert.equal(resolved.imported, null);
});

test('resolution preserves explicit keep-original disposition and does not let historical decisions override a later proposal', (t) => {
  const f = fixture(t);
  const original = getIntake(f.db, f.root, f.profileId, f.id);
  const proposed = proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: original.version,
    jsonlText: literalEnvelope('record'),
    summary: 'Fictional retained record.',
  });
  const review = reviewIntake(f.db, f.root, f.profileId, f.id, proposed.proposals[0].id);
  const kept = saveIntakeReviewDraft(f.db, f.root, f.profileId, f.id, {
    version: proposed.version,
    operationId: 'fictional-keep-original',
    proposalId: proposed.proposals[0].id,
    recordId: review.records[0].id,
    candidateVersionId: review.records[0].candidateVersionId!,
    disposition: 'keep_original_only',
  });
  assert.equal(kept.state, 'kept_original');
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  let resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'kept_original');
  assert.equal(resolved.imported, null);
  assert.deepEqual(resolved.workflow?.decisions, kept.workflow?.decisions);
  const later = proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: resolved.version,
    jsonlText: literalEnvelope(),
    summary: 'Later fictional context proposal.',
  });
  assert.equal(later.state, 'conversion_proposed');
  assert.equal(later.needsReview, false);
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.state, 'conversion_proposed');
  assert.equal(resolved.imported, null);
  assert.equal(resolved.acceptedProposalId, null);
  assert.deepEqual(resolved.workflow?.decisions, later.workflow?.decisions);
});

test('a historical import cannot falsely complete a different later context proposal after failure resolution', (t) => {
  const f = fixture(t, Buffer.from(literalEnvelope()), 'fictional-context.jsonl');
  const original = getIntake(f.db, f.root, f.profileId, f.id);
  const imported = importIntake(f.db, f.root, f.profileId, f.id, { version: original.version });
  assert.equal(imported.state, 'imported');
  const later = proposeConversion(f.db, f.root, f.profileId, f.id, {
    version: imported.version,
    jsonlText: literalEnvelope().replace(
      'Fictional literal source context.',
      'Later fictional source context.',
    ),
    summary: 'Later unaccepted fictional context proposal.',
  });
  assert.equal(later.state, 'conversion_proposed');
  assert.equal(later.needsReview, false);
  assert.notEqual(later.proposals.at(-1)!.id, later.acceptedProposalId);
  recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  const resolved = resolveIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    operationKey: failureInput.operationKey,
  });
  assert.equal(resolved.needsReview, false);
  assert.equal(Object.keys(resolved.packageFailures!).length, 0);
  assert.equal(resolved.state, 'needs_review');
  assert.deepEqual(resolved.imported, imported.imported);
  assert.equal(resolved.acceptedProposalId, imported.acceptedProposalId);
  assert.deepEqual(resolved.proposals, later.proposals);
});

test('failure receipts and exact originals survive backup and SQLite rebuild, including no-write replay', async (t) => {
  const f = fixture(t);
  const item = recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, failureInput);
  const backup = await createBackup(f.db, f.root, f.profileId);
  const target = join(f.root, 'rebuilt');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target);
  const db = openDatabase(rebuilt.database, f.profileId);
  attachPersonalDurability(db, { root: target, profileId: f.profileId });
  try {
    const recovered = getIntake(db, target, f.profileId, f.id);
    assert.deepEqual(recovered.packageFailures, item.packageFailures);
    assert.deepEqual(getIntakeOriginal(db, target, f.profileId, f.id).bytes, f.bytes);
    const writes = db.prepare('SELECT total_changes() AS writes').get()!.writes;
    assert.equal(
      recordIntakePackageFailure(db, target, f.profileId, f.id, failureInput).version,
      item.version,
    );
    assert.equal(db.prepare('SELECT total_changes() AS writes').get()!.writes, writes);
    assert.equal(recovered.imported, null);
    assert.equal(recovered.acceptedProposalId, null);
  } finally {
    db.close();
  }
});

test('adding a located failure writes bounded changed receipts rather than copying every pending failure', (t) => {
  const f = fixture(t);
  const frameBytes: number[] = [];
  for (let ordinal = 0; ordinal < 24; ordinal++) {
    const before = intakeWorkCounters(f.db).primitive.frameBytesWritten;
    recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
      ...failureInput,
      operationKey: `extract:member:fictional-${ordinal}`,
      memberId: `member:fictional-${ordinal}`,
      ordinal,
      detail: 'Fictional pending member. '.repeat(20),
    });
    frameBytes.push(intakeWorkCounters(f.db).primitive.frameBytesWritten - before);
  }
  assert.ok(Math.max(...frameBytes) < 4000);
  assert.ok(Math.max(...frameBytes) < Math.min(...frameBytes) * 1.5);
  const intake = getIntake(f.db, f.root, f.profileId, f.id);
  assert.equal(Object.keys(intake.packageFailures!).length, 24);
  assert.equal(readStoredIntakeDetails(f.db, f.id)?.workflow?.operations?.length || 0, 0);
});

test('failure reasons sanitize host diagnostics and bound details while source locations stay exact', (t) => {
  assert.equal(
    sanitizePackageFailureDetail(
      'Failed /private/fictional/input.zip at https://user:secret@fictional.invalid/secret\n    at worker (/tmp/fictional.ts:8:1)\n\u0000retained',
    ),
    'Failed [path] at [address] retained',
  );
  assert.equal(sanitizePackageFailureDetail('x'.repeat(10000)).length, 500);
  const f = fixture(t);
  assert.throws(
    () => recordIntakePackageFailure(f.db, f.root, 'foreign', f.id, failureInput),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
  assert.throws(
    () =>
      recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, { ...failureInput, ordinal: -1 }),
    /ordinal/,
  );
  assert.equal(getIntake(f.db, f.root, f.profileId, f.id).packageFailures, undefined);
  const filename = '🧪'.repeat(1995) + '.pdf';
  const recorded = recordIntakePackageFailure(f.db, f.root, f.profileId, f.id, {
    ...failureInput,
    filename,
    locator: 'ZIP member ' + filename,
  });
  assert.equal(Object.values(recorded.packageFailures!)[0].filename, filename);
  assert.equal(Object.values(recorded.packageFailures!)[0].locator, 'ZIP member ' + filename);
});

test('model failure section names every pending scope across bounded pages and never implies accepted records', () => {
  const failures = Object.fromEntries(
    Array.from({ length: 180 }, (_, ordinal) => [
      String(ordinal),
      {
        sourceFileId: 'fictional-package',
        sourceHash: 'a'.repeat(64),
        operationKey: `extract:member:${ordinal}`,
        originalFilename: 'fictional.zip',
        contentUrl: '/api/sources/fictional-package/content',
        memberId: `member:${ordinal}`,
        ordinal,
        filename: `reports/fictional-${ordinal}.pdf`,
        locator: `ZIP member reports/fictional-${ordinal}.pdf`,
        reasonCode: 'PACKAGE_CRC',
        detail: 'Fictional unfinished member. '.repeat(18),
        status: 'pending',
        scope: 'incomplete',
        retryAction: 'read_member',
      } satisfies IntakePackageFailure,
    ]),
  );
  const source = { id: 'fictional-package', version: 7, packageFailures: failures };
  const summary = modelIntakeContext(source);
  assert.equal(summary.packageFailures.pendingCount, 180);
  assert.equal(summary.packageFailures.exhaustiveSection, 'package_failures');
  assert.equal(summary.acceptances.currentImport, false);
  let offset = 0;
  const seen = new Set<number>();
  for (;;) {
    const result = modelIntakeContext(source, { section: 'package_failures', offset });
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) < MODEL_INTAKE_CONTEXT_MAX_PAGE_BYTES + 8000,
    );
    for (const item of result.page.items) seen.add((item as IntakePackageFailure).ordinal!);
    if (result.page.nextOffset === null) break;
    assert.ok(result.page.nextOffset > offset);
    offset = result.page.nextOffset;
  }
  assert.equal(seen.size, 180);
});
