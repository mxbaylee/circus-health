import { zipFixture } from '../../tests/fixtures/zip.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories, profileOriginal } from '../profile-storage.ts';
import * as intake from '../intake.ts';
import {
  previewDirectRecordCorrection,
  applyDirectRecordCorrection,
  handleClinicalReviewRoute,
} from '../clinical-review-routes.ts';
import { getObservation } from '../queries.ts';
import { clinicalRecordHistory } from '../clinical-history.ts';
import { createBackup } from '../recovery.ts';
import { rebuildProfile } from '../portable.ts';
import type { HealthRecordEnvelope } from '../../shared/intake.ts';
import type {
  RecordCorrectionRequest,
  RecordCorrectionPreview,
  CorrectionSupportingReference,
  RecordCorrectionApplyResult,
} from '../../shared/record-correction.ts';

function envelope(id: string, value = '12.00'): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: value },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional component',
      valueText: value,
      unit: 'mg',
      date: '2026-02-10',
    },
    provenance: {
      capturedVia: null,
      sourceSystem: 'Fictional source ' + id,
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'Fictional section ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
  };
}
function fixture(
  t: TestContext,
  opened?: { root: string; profileId: string; db: ReturnType<typeof openDatabase> },
) {
  const root = opened?.root || mkdtempSync(join(tmpdir(), 'fictional-direct-correction-')),
    profileId = opened?.profileId || 'cookie-dough';
  const db =
    opened?.db || openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  if (!opened)
    t.after(() => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    });
  const original = intake.uploadIntake(db, root, profileId, {
    filename: 'fictional-accepted.jsonl',
    bytes: Buffer.from(JSON.stringify(envelope('accepted'))),
    newProviderName: 'Fictional Clinic',
  });
  const review = intake.reviewIntake(db, root, profileId, original.id);
  intake.importIntake(db, root, profileId, original.id, {
    version: review.version,
    reviewToken: review.reviewToken,
    decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
  });
  const recordId = String(db.prepare('SELECT id FROM observations').get()!.id);
  const request: RecordCorrectionRequest = {
    kind: 'observation',
    recordId,
    set: { valueText: '14.00' },
    reason: 'The reviewed fictional source supports this transcription correction.',
  };
  const preview = (input: unknown = request) =>
    previewDirectRecordCorrection(db, root, profileId, input);
  const apply = (selected: RecordCorrectionPreview, operationId = 'fictional-direct-operation') =>
    applyDirectRecordCorrection(db, root, profileId, {
      ...selected.request,
      version: selected.version,
      previewToken: selected.previewToken,
      operationId,
    });
  const incoming = () => {
    const source = intake.uploadIntake(db, root, profileId, {
      filename: 'fictional-support.txt',
      bytes: Buffer.from('Fictional supporting original: corrected literal 14.00 mg'),
      newProviderName: 'Fictional Second Clinic',
    });
    const item = intake.proposeConversion(db, root, profileId, source.id, {
      version: source.version,
      summary: 'Fictional supporting occurrence',
      jsonlText: JSON.stringify(envelope('supporting', '14.00')),
    });
    const proposalId = item.proposals[0]!.id;
    const record = intake.reviewIntake(db, root, profileId, item.id, proposalId).records[0]!;
    const ref: CorrectionSupportingReference = {
      intakeId: item.id,
      proposalId,
      recordId: record.id,
      candidateId: record.candidateId!,
      candidateVersionId: record.candidateVersionId!,
      originalSourceFileId: item.id,
    };
    return { item, record, ref };
  };
  return { db, root, profileId, original, recordId, request, preview, apply, incoming };
}
const extra = (dto: unknown) =>
  (
    dto as {
      extra: {
        recordCorrections: Record<string, unknown>[];
        import: { recordException: Record<string, unknown> };
      };
    }
  ).extra;

test('direct preview and apply preserve originals and return the actual corrected DTO, reason and durable receipt', (t) => {
  const f = fixture(t);
  const bytes = intake.getIntakeOriginal(f.db, f.root, f.profileId, f.original.id).bytes;
  const raw = f.db.prepare('SELECT * FROM source_records ORDER BY id').all();
  const preview = f.preview();
  assert.equal(preview.before.valueText, '12.00');
  assert.equal(preview.after.valueText, '14.00');
  assert.equal(preview.destination.apiUrl, '/api/tests/' + encodeURIComponent(f.recordId));
  assert.ok(preview.editableFields.includes('valueText'));
  assert.ok(!preview.editableFields.includes('subject'));
  assert.equal((getObservation(f.db, f.recordId) as { valueText: string }).valueText, '12.00');
  const result = f.apply(preview);
  assert.equal(result.replayed, false);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.receipt.result.reason, f.request.reason);
  const dto = getObservation(f.db, f.recordId);
  assert.equal((dto as { valueText: string }).valueText, '14.00');
  assert.equal(extra(dto).recordCorrections[0]!.reason, f.request.reason);
  assert.deepEqual(f.db.prepare('SELECT * FROM source_records ORDER BY id').all(), raw);
  assert.deepEqual(intake.getIntakeOriginal(f.db, f.root, f.profileId, f.original.id).bytes, bytes);
  assert.deepEqual(f.apply(preview).receipt, result.receipt);
  assert.equal(f.apply(preview).replayed, true);
});

test('grouped numeric corrections update only the shared projection and survive a durable rebuild', (t) => {
  const f = fixture(t);
  const request = {
    ...f.request,
    set: { valueText: '>= -9,876.250 mg' },
    reason: 'The independently fictional source supports this exact grouped literal.',
  };
  const preview = f.preview(request);
  assert.equal(preview.before.valueText, '12.00');
  assert.equal(preview.after.valueText, '>= -9,876.250 mg');
  f.apply(preview, 'fictional-grouped-correction');
  const corrected = getObservation(f.db, f.recordId);
  assert.ok('valueText' in corrected, 'Correction must still resolve to an observation DTO');
  assert.equal(corrected.valueText, '>= -9,876.250 mg');
  assert.equal(corrected.value, -9876.25);
  assert.equal(corrected.comparator, '>=');
  assert.equal(corrected.unit, 'mg');
  assert.equal(corrected.date, '2026-02-10');
  assert.equal(corrected.datePrecision, 'day');

  const target = join(f.root, 'grouped-correction-rebuilt');
  const rebuilt = rebuildProfile(f.root, f.profileId, target);
  const db = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(getObservation(db, f.recordId), corrected);
  } finally {
    db.close();
  }
});

test('supporting incoming original is retained in accepted history while its draft is untouched, deferred and later superseded', async (t) => {
  const f = fixture(t),
    incoming = f.incoming();
  const current = intake.getIntake(f.db, f.root, f.profileId, incoming.item.id);
  intake.saveIntakeReviewDraft(f.db, f.root, f.profileId, current.id, {
    version: current.version,
    operationId: 'fictional-pending-draft',
    proposalId: incoming.ref.proposalId,
    recordId: incoming.record.id,
    candidateVersionId: incoming.record.candidateVersionId!,
    mapping: { valueText: '14.00' },
    disposition: 'review_later',
  });
  const before = structuredClone(intake.getIntake(f.db, f.root, f.profileId, current.id).workflow);
  const preview = f.preview({ ...f.request, supportingEvidence: [incoming.ref] });
  assert.equal(preview.supportingEvidence[0]!.originalSourceHash, incoming.item.sha256);
  assert.equal(preview.supportingEvidence[0]!.contentUrl, incoming.item.contentUrl);
  const result = f.apply(preview);
  assert.deepEqual(intake.getIntake(f.db, f.root, f.profileId, current.id).workflow, before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.deepEqual(
    extra(getObservation(f.db, f.recordId)).recordCorrections[0]!.supportingEvidence,
    preview.supportingEvidence,
  );
  assert.deepEqual(
    extra(getObservation(f.db, f.recordId)).import.recordException.supportingEvidence,
    preview.supportingEvidence,
  );
  const updated = intake.getIntake(f.db, f.root, f.profileId, current.id);
  intake.proposeConversion(f.db, f.root, f.profileId, current.id, {
    version: updated.version,
    summary: 'Later independently fictional proposal',
    jsonlText: JSON.stringify(envelope('supporting', '15.00')),
  });
  assert.deepEqual(
    f.apply(preview).receipt,
    result.receipt,
    'lost-response replay retains its earlier exact supporting scope',
  );
  assert.throws(() => f.preview({ ...f.request, supportingEvidence: [incoming.ref] }), {
    code: 'CORRECTION_EVIDENCE_CHANGED',
  });
  const backup = await createBackup(f.db, f.root, f.profileId),
    target = join(f.root, 'recovered');
  const rebuilt = rebuildProfile(join(backup.path, 'files'), f.profileId, target),
    db = openDatabase(rebuilt.database, f.profileId);
  try {
    const recovered = applyDirectRecordCorrection(db, target, f.profileId, {
      ...preview.request,
      version: preview.version,
      previewToken: preview.previewToken,
      operationId: 'fictional-direct-operation',
    });
    assert.equal(recovered.replayed, true);
    assert.deepEqual(recovered.receipt, result.receipt);
    assert.deepEqual(
      extra(getObservation(db, f.recordId)).recordCorrections[0]!.supportingEvidence,
      preview.supportingEvidence,
    );
    const savedIncoming = intake.getIntake(db, target, f.profileId, current.id);
    assert.deepEqual(savedIncoming.workflow!.reviewDrafts, before!.reviewDrafts);
    assert.equal(savedIncoming.workflow!.decisions.length, 0);
    assert.ok(
      JSON.stringify(
        db
          .prepare("SELECT coverage_json FROM manual_batches WHERE title='Import record exception'")
          .all(),
      ).includes(incoming.ref.originalSourceFileId),
    );
  } finally {
    db.close();
  }
});

for (const field of [
  'candidateId',
  'candidateVersionId',
  'recordId',
  'proposalId',
  'originalSourceFileId',
] as const)
  test(`wrong supporting ${field} cannot attach an arbitrary source or occurrence`, (t) => {
    const f = fixture(t),
      incoming = f.incoming();
    const other = intake.uploadIntake(f.db, f.root, f.profileId, {
      filename: 'unrelated.txt',
      bytes: Buffer.from('Unrelated fictional evidence'),
      newProviderName: 'Fictional Other',
    });
    const ref = {
      ...incoming.ref,
      [field]: field === 'originalSourceFileId' ? other.id : 'wrong-reference',
    };
    assert.throws(() => f.preview({ ...f.request, supportingEvidence: [ref] }));
    assert.equal(extra(getObservation(f.db, f.recordId)).recordCorrections, undefined);
  });

test('wrong profile, invalid fields, missing reason and medication reclassification fail before mutation', (t) => {
  const f = fixture(t);
  assert.throws(() => previewDirectRecordCorrection(f.db, f.root, 'other-profile', f.request), {
    code: 'PROFILE_BOUNDARY',
  });
  for (const set of [
    { subject: 'other' },
    { sourceRecordId: 'different-source' },
    { madeUp: 'x' },
    { kind: 'medication', medicationName: 'Fictional medicine' },
  ])
    assert.throws(() => f.preview({ ...f.request, set }));
  assert.throws(() => f.preview({ ...f.request, reason: '' }), { code: 'CORRECTION_INPUT' });
  assert.throws(() => f.preview({ ...f.request, profileId: 'injected' }), {
    code: 'CORRECTION_INPUT',
  });
  assert.equal((getObservation(f.db, f.recordId) as { valueText: string }).valueText, '12.00');
});

test('stale preview and same-operation changed content cannot replace a reviewed decision; replay points to current destination', (t) => {
  const f = fixture(t),
    first = f.preview(),
    stale = f.preview({ ...f.request, set: { valueText: '16.00' } });
  const applied = f.apply(first);
  assert.throws(() => f.apply(stale, 'fictional-stale'), { code: 'CLINICAL_REVIEW_CHANGED' });
  assert.throws(
    () =>
      applyDirectRecordCorrection(f.db, f.root, f.profileId, {
        ...first.request,
        reason: 'A different request',
        version: first.version,
        previewToken: first.previewToken,
        operationId: applied.operationId,
      }),
    { code: 'OPERATION_CONFLICT' },
  );
  const next = f.preview({
    ...f.request,
    set: {
      kind: 'procedure',
      procedureLabel: 'Fictional procedure',
      procedureCategory: 'laboratory',
    },
  });
  const moved = f.apply(next, 'fictional-move');
  assert.equal(moved.destination.kind, 'procedure');
  assert.match(moved.destination.apiUrl, /^\/api\/procedures\//);
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM procedures WHERE id=?').get(f.recordId)!.n, 1);
  const replay = f.apply(first);
  assert.deepEqual(replay.receipt, applied.receipt);
  assert.equal(replay.destination.kind, 'procedure');
});

test('changed supporting bytes and changed incoming evidence invalidate fresh Apply', (t) => {
  const f = fixture(t),
    incoming = f.incoming(),
    preview = f.preview({ ...f.request, supportingEvidence: [incoming.ref] });
  const file = f.db.prepare('SELECT path FROM source_files WHERE id=?').get(incoming.item.id)!;
  const path = profileOriginal(f.root, file.path, f.profileId),
    original = readFileSync(path);
  writeFileSync(path, Buffer.from('Changed independently fictional supporting original'));
  assert.throws(() => f.apply(preview), { code: 'SOURCE_CHANGED' });
  writeFileSync(path, original);
  const item = intake.getIntake(f.db, f.root, f.profileId, incoming.item.id);
  intake.proposeConversion(f.db, f.root, f.profileId, item.id, {
    version: item.version,
    summary: 'Changed fictional candidate',
    jsonlText: JSON.stringify(envelope('supporting', '17.00')),
  });
  assert.throws(() => f.apply(preview), { code: 'CLINICAL_REVIEW_CHANGED' });
});

test('failed receipt insertion rolls back correction, source exception and incoming support history together', (t) => {
  const f = fixture(t),
    incoming = f.incoming(),
    preview = f.preview({ ...f.request, supportingEvidence: [incoming.ref] });
  f.db.exec(
    "CREATE TEMP TRIGGER reject_correction_receipt BEFORE INSERT ON manual_batches WHEN NEW.title='Applied clinical review' BEGIN SELECT RAISE(ABORT, 'fictional receipt failure'); END",
  );
  assert.throws(() => f.apply(preview), /fictional receipt failure/);
  f.db.exec('DROP TRIGGER reject_correction_receipt');
  assert.equal((getObservation(f.db, f.recordId) as { valueText: string }).valueText, '12.00');
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM manual_batches WHERE title='Import record exception'")
      .get()!.n,
    0,
  );
  assert.equal(f.apply(preview).replayed, false);
});

test('route dispatch is bounded, profile scoped and exposes explicit preview/apply without accepting an incoming row', async (t) => {
  const f = fixture(t),
    incoming = f.incoming();
  let response: unknown, maxBytes: number | undefined;
  const context = {
    ...f,
    resource: 'clinical-review',
    id: 'correction-preview',
    method: 'POST',
    req: { headers: { 'content-type': 'application/json' } },
    body: async (_req: unknown, max?: number) => {
      maxBytes = max;
      return Buffer.from(JSON.stringify({ ...f.request, supportingEvidence: [incoming.ref] }));
    },
    respond: (value: unknown) => {
      response = value;
    },
  } as unknown as Parameters<typeof handleClinicalReviewRoute>[0];
  assert.equal(await handleClinicalReviewRoute(context), true);
  assert.equal(maxBytes, 256 * 1024);
  const preview = response as RecordCorrectionPreview;
  await handleClinicalReviewRoute({
    ...context,
    id: 'correction-apply',
    body: async () =>
      Buffer.from(
        JSON.stringify({
          ...preview.request,
          operationId: 'fictional-route-apply',
          version: preview.version,
          previewToken: preview.previewToken,
        }),
      ),
  });
  assert.equal((response as RecordCorrectionApplyResult).receipt.result.after.valueText, '14.00');
  await assert.rejects(
    () => handleClinicalReviewRoute({ ...context, profileId: 'other-profile' }),
    { code: 'PROFILE_BOUNDARY' },
  );
  await assert.rejects(
    () => handleClinicalReviewRoute({ ...context, body: async () => Buffer.from('{') }),
    { code: 'INVALID_JSON' },
  );
  assert.equal(await handleClinicalReviewRoute({ ...context, resource: 'unrelated' }), false);
  assert.equal(
    await handleClinicalReviewRoute({ ...context, id: 'future-relationship-action' }),
    false,
  );
  await assert.rejects(() => handleClinicalReviewRoute({ ...context, method: 'GET' }), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(
    () =>
      handleClinicalReviewRoute({
        ...context,
        req: { headers: { 'content-type': 'text/plain' } } as typeof context.req,
      }),
    { code: 'CONTENT_TYPE' },
  );
});

test('encrypted correction support, exact operation receipt and clinical history survive complete cache loss', async (t) => {
  const { vaultFixture, newProfile } = await import('./helpers/vault-fixture.ts');
  const { manager, dataDirectory } = vaultFixture(t);
  const { profile, recoveryKit } = await newProfile(manager, 'Fictional Direct Correction');
  const state = manager.opened.get(profile.id)!;
  const f = fixture(t, { root: state.root, db: state.db, profileId: profile.id });
  const incoming = f.incoming();
  const preview = f.preview({ ...f.request, supportingEvidence: [incoming.ref] });
  const result = f.apply(preview);
  const history = clinicalRecordHistory(f.db, {
    profileId: profile.id,
    kind: 'observation',
    recordId: f.recordId,
  });
  assert.ok(JSON.stringify(history).includes(incoming.ref.originalSourceFileId));
  const dto = getObservation(f.db, f.recordId);
  manager.lock(profile.id);
  rmSync(join(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const rebuilt = manager.opened.get(profile.id)!;
  assert.equal(rebuilt.metrics.cacheHit, false);
  assert.deepEqual(getObservation(rebuilt.db, f.recordId), dto);
  assert.deepEqual(
    clinicalRecordHistory(rebuilt.db, {
      profileId: profile.id,
      kind: 'observation',
      recordId: f.recordId,
    }),
    history,
  );
  const replay = applyDirectRecordCorrection(rebuilt.db, rebuilt.root, profile.id, {
    ...preview.request,
    version: preview.version,
    previewToken: preview.previewToken,
    operationId: result.operationId,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, result.receipt);
  assert.equal(rebuilt.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
  assert.equal(
    intake.getIntake(rebuilt.db, rebuilt.root, profile.id, incoming.item.id).workflow!.decisions
      .length,
    0,
  );
});

test('package correction support requires the exact retained member, not outer ZIP or equal-byte sibling', async (t) => {
  const { fictionalModel } = await import('./fictional-model.ts');
  const { readIntakePackageMember } = await import('../intake-package.ts');
  fictionalModel(t);
  const f = fixture(t);
  const bytes = zipFixture([
    { name: 'first.txt', data: 'Fictional corrected result 14.00 mg' },
    { name: 'copy.txt', data: 'Fictional corrected result 14.00 mg' },
  ]);
  const source = intake.uploadIntake(f.db, f.root, f.profileId, {
    filename: 'fictional-support.zip',
    bytes,
    newProviderName: 'Fictional Package',
  });
  const planned = await intake.createIntakePlan(f.db, f.root, f.profileId, source.id, {
    version: source.version,
  });
  const members = planned.workflow!.plans[0]!.index.members!;
  const value = envelope('package-support', '14.00');
  value.report = {
    key: 'fictional-section',
    title: 'Fictional report',
    memberId: members[0]!.memberId,
    anchor: { locator: 'line 1', text: 'Fictional corrected result' },
    subject: null,
  };
  const proposed = intake.proposeConversion(f.db, f.root, f.profileId, source.id, {
    version: planned.version,
    summary: 'Fictional member support',
    jsonlText: JSON.stringify(value),
  });
  const proposalId = proposed.proposals[0]!.id;
  const record = intake.reviewIntake(f.db, f.root, f.profileId, source.id, proposalId).records[0]!;
  const ref: CorrectionSupportingReference = {
    intakeId: source.id,
    proposalId,
    recordId: record.id,
    candidateId: record.candidateId!,
    candidateVersionId: record.candidateVersionId!,
    originalSourceFileId: source.id,
  };
  assert.throws(() => f.preview({ ...f.request, supportingEvidence: [ref] }), {
    code: 'CORRECTION_EVIDENCE',
  });
  const context = { db: f.db, root: f.root, profileId: f.profileId, id: source.id };
  const sibling = await readIntakePackageMember({ ...context, memberId: members[1]!.memberId });
  assert.throws(
    () =>
      f.preview({
        ...f.request,
        supportingEvidence: [{ ...ref, originalSourceFileId: sibling.sourceFileId }],
      }),
    { code: 'CORRECTION_EVIDENCE' },
  );
  const exact = await readIntakePackageMember({ ...context, memberId: members[0]!.memberId });
  const preview = f.preview({
    ...f.request,
    supportingEvidence: [{ ...ref, originalSourceFileId: exact.sourceFileId }],
  });
  assert.equal(preview.supportingEvidence[0]!.memberId, members[0]!.memberId);
  const applied = f.apply(preview);
  assert.equal(
    applied.receipt.result.supportingEvidence![0]!.originalSourceFileId,
    exact.sourceFileId,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM observations').get()!.n, 1);
});
