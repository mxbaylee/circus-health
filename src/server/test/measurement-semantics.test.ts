import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import { uploadIntake, reviewIntake, importIntake } from '../intake.ts';
import {
  previewDirectRecordCorrection,
  applyDirectRecordCorrection,
} from '../clinical-review-routes.ts';
import {
  previewMeasurementSemantics,
  applyMeasurementSemantics,
  acceptedMeasurement,
  acceptedMeasurements,
} from '../measurement-semantics.ts';
import {
  compareMeasurements,
  deriveMeasurement,
  type MeasurementSemantics,
} from '../../shared/measurement.ts';
import type {
  MeasurementSemanticPreview,
  MeasurementSemanticRequest,
} from '../../shared/measurement-semantics.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
const semantics: MeasurementSemantics = {
  quantity: 'fictional:analyte-mass-concentration',
  dimension: 'mass_concentration',
  region: 'not_applicable',
  specimen: 'fictional:serum',
  method: 'fictional:method-a',
  meaning: 'measured_concentration',
};
function fixture(
  t: TestContext,
  state?: { root: string; profileId: string; db: ReturnType<typeof openDatabase> },
) {
  const root = state?.root || mkdtempSync(join(tmpdir(), 'fictional-measurement-')),
    profileId = state?.profileId || 'cookie-dough';
  const db =
    state?.db || openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  if (!state)
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
  const upload = (id: string, valueText = '1.20', unit = 'mg/dL') => {
    const item = uploadIntake(db, root, profileId, {
      filename: id + '.jsonl',
      newProviderName: 'Fictional laboratory',
      bytes: Buffer.from(
        JSON.stringify({
          format: 'health-record-v1',
          id,
          kind: 'record',
          payload: { literal: valueText },
          clinical: {
            kind: 'observation',
            subject: 'self',
            testLabel: 'Fictional concentration',
            valueText,
            unit,
            date: '2026-02-10',
          },
          provenance: {
            capturedVia: null,
            sourceSystem: 'Fictional system',
            sourceRecordId: id,
            evidenceClass: 'provider_export',
            locator: 'Fictional line ' + id,
          },
          coverage: { status: 'complete_response', notes: [] },
        }),
      ),
    });
    const review = reviewIntake(db, root, profileId, item.id);
    importIntake(db, root, profileId, item.id, {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    });
    const recordId = String(
      db
        .prepare(
          'SELECT o.id FROM observations o JOIN source_records s ON o.source_record_id=s.id WHERE s.source_file_id=?',
        )
        .get(item.id)!.id,
    );
    return { item, recordId };
  };
  const original = upload('fictional-measured');
  const request: MeasurementSemanticRequest = {
    kind: 'observation',
    recordId: original.recordId,
    semantics,
    precision: null,
    reason: 'Explicitly reviewed the fictional source quantity, specimen and method.',
  };
  const preview = (value: unknown = request) =>
    previewMeasurementSemantics(db, root, profileId, value);
  const applyInput = (
    selected: MeasurementSemanticPreview,
    operationId = 'fictional-semantic',
  ) => ({
    ...selected.request,
    reference: selected.reference,
    rulesVersion: selected.rulesVersion,
    version: selected.version,
    previewToken: selected.previewToken,
    operationId,
  });
  const apply = (selected: MeasurementSemanticPreview, operationId?: string) =>
    applyMeasurementSemantics(db, root, profileId, applyInput(selected, operationId));
  return { db, root, profileId, upload, original, request, preview, applyInput, apply };
}

test('explicit semantic decision enables exact comparison without changing accepted rows, originals or same-day event identities', (t) => {
  const f = fixture(t),
    other = f.upload('fictional-second', '12.0', 'mg/L');
  const rows = f.db.prepare('SELECT * FROM observations ORDER BY id').all(),
    sources = f.db.prepare('SELECT * FROM source_records ORDER BY id').all();
  assert.equal(
    acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId)
      .semanticStatus,
    'none',
  );
  const a = f.preview();
  assert.equal(a.source.valueText, '1.20');
  assert.equal(a.source.unit, 'mg/dL');
  const first = f.apply(a);
  assert.equal(first.replayed, false);
  f.apply(f.preview({ ...f.request, recordId: other.recordId }), 'fictional-second-semantics');
  const left = acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId),
    right = acceptedMeasurement(f.db, f.root, f.profileId, 'observation', other.recordId);
  assert.equal(left.semanticStatus, 'current');
  assert.equal(left.binding!.decisionId, first.decision.id);
  const comparison = compareMeasurements(left, right, 'g/L');
  assert.equal(comparison.status, 'exact');
  assert.equal(comparison.mergeAuthorized, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM observations ORDER BY id').all(), rows);
  assert.deepEqual(f.db.prepare('SELECT * FROM source_records ORDER BY id').all(), sources);
  assert.equal(f.apply(a).replayed, true);
  assert.deepEqual(f.apply(a).decision, first.decision);
});

test('semantic replacement/revocation retains history and exact replay cannot revive a revoked binding', (t) => {
  const f = fixture(t),
    firstPreview = f.preview(),
    first = f.apply(firstPreview);
  const replacement = f.apply(
    f.preview({ ...f.request, semantics: { ...semantics, method: 'fictional:method-b' } }),
    'fictional-replacement',
  );
  assert.equal(replacement.decision.previousDecisionId, first.decision.id);
  const revoke = f.apply(
    f.preview({
      ...f.request,
      semantics: null,
      precision: null,
      reason: 'Explicitly withdraw the unsupported semantic review.',
    }),
    'fictional-revoke',
  );
  assert.equal(revoke.decision.previousDecisionId, replacement.decision.id);
  assert.equal(
    acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId)
      .semanticStatus,
    'revoked',
  );
  assert.deepEqual(f.apply(firstPreview).decision, first.decision);
  assert.equal(
    acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId).binding,
    null,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Measurement semantic decision'")
      .get()!.n,
    3,
  );
});

test('accepted record correction A to B to A invalidates earlier semantic pin without erasing that reviewed decision', (t) => {
  const f = fixture(t),
    preview = f.preview(),
    first = f.apply(preview);
  const correct = (valueText: string, operationId: string) => {
    const correction = previewDirectRecordCorrection(f.db, f.root, f.profileId, {
      kind: 'observation',
      recordId: f.original.recordId,
      set: { valueText },
      reason: 'Fictional transcription correction.',
    });
    applyDirectRecordCorrection(f.db, f.root, f.profileId, {
      ...correction.request,
      version: correction.version,
      previewToken: correction.previewToken,
      operationId,
    });
  };
  correct('1.21', 'fictional-correction-b');
  correct('1.20', 'fictional-correction-a');
  const current = acceptedMeasurement(
    f.db,
    f.root,
    f.profileId,
    'observation',
    f.original.recordId,
  );
  assert.equal(current.source.valueText, '1.20');
  assert.equal(current.semanticStatus, 'stale');
  assert.equal(current.binding, null);
  assert.deepEqual(f.apply(preview).decision, first.decision);
  assert.throws(() => f.apply(preview, 'fictional-stale-operation'), {
    code: 'MEASUREMENT_SCOPE_CHANGED',
  });
  assert.equal(
    f.apply(f.preview(), 'fictional-reviewed-again').decision.previousDecisionId,
    first.decision.id,
  );
});

test('wrong profile, changed scope, invalid semantics/precision and same-operation changed request fail', (t) => {
  const f = fixture(t);
  assert.throws(() => previewMeasurementSemantics(f.db, f.root, 'other-profile', f.request), {
    code: 'PROFILE_BOUNDARY',
  });
  assert.throws(
    () => acceptedMeasurement(f.db, f.root, 'other-profile', 'observation', f.original.recordId),
    { code: 'PROFILE_BOUNDARY' },
  );
  for (const value of [
    { ...f.request, semantics: { ...semantics, method: 'unknown' } },
    { ...f.request, semantics: { ...semantics, specimen: '' } },
    { ...f.request, semantics: { ...semantics, dimension: 'volume' } },
    {
      ...f.request,
      precision: { increment: '0.07', basis: 'explicit_review', evidence: 'fictional' },
    },
    {
      ...f.request,
      precision: { increment: '0', basis: 'explicit_review', evidence: 'fictional' },
    },
    { ...f.request, reason: '' },
    { ...f.request, subject: 'other' },
    { ...f.request, kind: 'document' },
  ])
    assert.throws(() => f.preview(value));
  const preview = f.preview();
  const tampered = f.applyInput(preview);
  tampered.reference = { ...tampered.reference, evidenceHash: 'other-evidence' };
  assert.throws(() => applyMeasurementSemantics(f.db, f.root, f.profileId, tampered), {
    code: 'MEASUREMENT_SCOPE_CHANGED',
  });
  f.apply(preview);
  assert.throws(
    () =>
      applyMeasurementSemantics(f.db, f.root, f.profileId, {
        ...f.applyInput(preview),
        reason: 'Changed request',
      }),
    { code: 'OPERATION_CONFLICT' },
  );
});

test('retained original bytes are rechecked before fresh semantic writes and projections', (t) => {
  const f = fixture(t),
    preview = f.preview();
  const path = profileOriginal(
    f.root,
    f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.original.item.id)!.path,
    f.profileId,
  );
  const bytes = readFileSync(path);
  writeFileSync(path, Buffer.from('Changed fictional original'));
  assert.throws(() => f.apply(preview), { code: 'SOURCE_CHANGED' });
  assert.throws(
    () => acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId),
    { code: 'SOURCE_CHANGED' },
  );
  writeFileSync(path, bytes);
  assert.equal(f.apply(preview).replayed, false);
});

test('durable semantic precision, historical receipt and rebuildable conversion survive portable recovery', async (t) => {
  const f = fixture(t),
    preview = f.preview({
      ...f.request,
      precision: {
        increment: '0.01',
        basis: 'explicit_review',
        evidence: 'Fictional source explicitly rounds to one hundredth.',
      },
    });
  const first = f.apply(preview),
    before = deriveMeasurement(
      acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId),
      'mg/L',
    );
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'recovered');
  const recovered = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(recovered.database, f.profileId);
  try {
    assert.deepEqual(
      deriveMeasurement(
        acceptedMeasurement(db, target, f.profileId, 'observation', f.original.recordId),
        'mg/L',
      ),
      before,
    );
    const replay = applyMeasurementSemantics(db, target, f.profileId, f.applyInput(preview));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.decision, first.decision);
  } finally {
    db.close();
  }
});

test('exact inline accepted unit supports semantic preview, apply and portable rebuild', async (t) => {
  const f = fixture(t),
    inline = f.upload('fictional-inline-unit', '5mg/dL', 'mg/dL'),
    request = { ...f.request, recordId: inline.recordId },
    preview = f.preview(request);
  assert.equal(preview.source.valueText, '5mg/dL');
  assert.equal(preview.source.unit, 'mg/dL');
  const applied = f.apply(preview, 'fictional-inline-unit-semantics');
  assert.equal(applied.replayed, false);
  const before = acceptedMeasurement(f.db, f.root, f.profileId, 'observation', inline.recordId);
  assert.equal(before.semanticStatus, 'current');
  assert.equal(deriveMeasurement(before, 'mg/L').conversion!.exactDecimal, '50');

  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'recovered-inline-unit'),
    rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const recovered = acceptedMeasurement(db, target, f.profileId, 'observation', inline.recordId);
    assert.deepEqual(recovered, before);
    assert.equal(deriveMeasurement(recovered, 'mg/L').conversion!.exactDecimal, '50');
  } finally {
    db.close();
  }
});

test('real encrypted cache loss restores accepted semantics/precision and exact replay without making derived values durable authority', async (t) => {
  const { manager, dataDirectory } = vaultFixture(t),
    { profile, recoveryKit } = await newProfile(manager, 'Fictional Measurement Review');
  const state = manager.opened.get(profile.id)!,
    f = fixture(t, { root: state.root, db: state.db, profileId: profile.id });
  const preview = f.preview(),
    first = f.apply(preview),
    before = acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId);
  manager.lock(profile.id);
  rmSync(join(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const rebuilt = manager.opened.get(profile.id)!;
  assert.equal(rebuilt.metrics.cacheHit, false);
  assert.deepEqual(
    acceptedMeasurement(rebuilt.db, rebuilt.root, profile.id, 'observation', f.original.recordId),
    before,
  );
  const replay = applyMeasurementSemantics(
    rebuilt.db,
    rebuilt.root,
    profile.id,
    f.applyInput(preview),
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.decision, first.decision);
  assert.equal(deriveMeasurement(before, 'mg/L').conversion!.exactDecimal, '12');
});

test('journal insertion failure rolls back and portable publication retry preserves one accepted operation', (t) => {
  const f = fixture(t),
    preview = f.preview();
  f.db.exec(
    "CREATE TEMP TRIGGER reject_measurement BEFORE INSERT ON manual_batches WHEN NEW.title='Measurement semantic decision' BEGIN SELECT RAISE(ABORT,'fictional semantic failure'); END",
  );
  assert.throws(() => f.apply(preview), /fictional semantic failure/);
  f.db.exec('DROP TRIGGER reject_measurement');
  assert.equal(
    acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId)
      .semanticStatus,
    'none',
  );
  const pending = applyMeasurementSemantics(f.db, f.root, f.profileId, f.applyInput(preview), {
    exportFn: () => {
      throw new Error('Fictional export retry');
    },
  });
  assert.equal(pending.durability!.pending, true);
  const replay = f.apply(preview);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.decision, pending.decision);
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Measurement semantic decision'")
      .get()!.n,
    1,
  );
});

test('actual accepted observation with a separate stored comparator stays a bound at the host adapter', (t) => {
  const f = fixture(t);
  // A retained accepted representation can carry its qualifier in the canonical
  // observation column while the accepted mapping preserves only the numeric text.
  transaction(f.db, () =>
    f.db.prepare('UPDATE observations SET comparator=? WHERE id=?').run('<', f.original.recordId),
  );
  const selected = f.preview();
  assert.equal(selected.source.valueText, '1.20');
  assert.equal(selected.source.comparator, '<');
  f.apply(selected);
  const source = acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId);
  const converted = deriveMeasurement(source, 'mg/L');
  assert.equal(converted.conversion!.comparator, '<');
  assert.equal(converted.conversion!.valueRole, 'bound');
  assert.equal(converted.conversion!.exactDecimal, '12');
  assert.equal(compareMeasurements(source, source, 'mg/L').status, 'bounded');
  transaction(f.db, () =>
    f.db.prepare('UPDATE observations SET comparator=? WHERE id=?').run('>', f.original.recordId),
  );
  assert.equal(
    acceptedMeasurement(f.db, f.root, f.profileId, 'observation', f.original.recordId)
      .semanticStatus,
    'stale',
  );
});

test('bounded batch verification is reused only within that read, preserves explicit occurrences and never truncates', (t) => {
  const f = fixture(t);
  f.apply(f.preview());
  const refs = Array.from({ length: 28 }, () => ({
    kind: 'observation' as const,
    recordId: f.original.recordId,
  }));
  const batch = acceptedMeasurements(f.db, f.root, f.profileId, refs);
  assert.equal(batch.count, 28);
  assert.equal(batch.complete, true);
  assert.equal(batch.verifiedOriginalCount, 1);
  assert.ok(batch.measurements.every((item) => item.semanticStatus === 'current'));
  assert.throws(
    () =>
      acceptedMeasurements(
        f.db,
        f.root,
        f.profileId,
        Array.from({ length: 257 }, () => refs[0]!),
      ),
    { code: 'MEASUREMENT_BATCH_LIMIT' },
  );
  const path = profileOriginal(
    f.root,
    f.db.prepare('SELECT path FROM source_files WHERE id=?').get(f.original.item.id)!.path,
    f.profileId,
  );
  writeFileSync(path, Buffer.from('Changed fictional source after the preceding read'));
  assert.throws(() => acceptedMeasurements(f.db, f.root, f.profileId, refs), {
    code: 'SOURCE_CHANGED',
  });
});
