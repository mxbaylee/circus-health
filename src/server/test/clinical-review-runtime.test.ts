import { createTestRuntimeDirectory } from './runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startRuntime } from '../runtime.ts';
import type { createEncryptedProfiles } from '../encrypted-profiles.ts';
import type { getObservation } from '../queries.ts';
import type { Intake, IntakeReview, HealthRecordEnvelope } from '../../shared/intake.ts';
import type { IntakeRelatedRecordsResult } from '../../shared/clinical-review.ts';
import type {
  RecordCorrectionPreview,
  RecordCorrectionApplyResult,
} from '../../shared/record-correction.ts';
import { fictionalModel } from './fictional-model.ts';
import type {
  AcceptedMeasurement,
  MeasurementSemanticPreview,
  MeasurementSemanticApplyResult,
} from '../../shared/measurement-semantics.ts';
import { deriveMeasurement } from '../../shared/measurement.ts';
import type { Trend } from '../../shared/api.ts';
import type {
  ClinicalRelationshipPreview,
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipProjection,
  ClinicalRelationshipSide,
} from '../../shared/clinical-relationships.ts';

test('encrypted runtime authorizes related discovery and reviewed corrections without changing originals or accepting incoming evidence', async (t) => {
  fictionalModel(t);
  const origin = 'http://localhost:5180';
  const previous = process.env.CRS_PUBLIC_ORIGIN;
  process.env.CRS_PUBLIC_ORIGIN = origin;
  t.after(() => {
    if (previous === undefined) delete process.env.CRS_PUBLIC_ORIGIN;
    else process.env.CRS_PUBLIC_ORIGIN = previous;
  });
  const base = mkdtempSync(join(tmpdir(), 'fictional-clinical-review-http-'));
  mkdirSync(join(base, 'data'));
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    dataDirectory: join(base, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(async () => {
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });
  let cookie = '';
  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      raw?: string;
      anonymous?: boolean;
      origin?: string;
    } = {},
  ) {
    const method = options.method || 'POST';
    return new Promise<{ status: number; data: T; text: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: (runtime.server.address() as AddressInfo).port,
          path,
          method,
          headers: {
            Host: 'localhost:5180',
            Origin: options.origin || origin,
            Cookie: options.anonymous ? '' : cookie,
            'Content-Type': options.raw === undefined ? 'application/json' : 'application/x-ndjson',
            ...(options.raw === undefined ? {} : { 'X-Filename': 'fictional-source.jsonl' }),
          },
        },
        (response) => {
          if (!options.anonymous && response.headers['set-cookie'])
            cookie = response.headers['set-cookie'][0]!.split(';')[0]!;
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('error', reject);
          response.on('end', () => {
            let data: T;
            try {
              data = JSON.parse(text).data as T;
            } catch {
              data = undefined as T;
            }
            resolve({ status: response.statusCode!, data, text });
          });
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : (options.raw ?? JSON.stringify(options.body || {})));
    });
  }
  type Setup = ReturnType<ReturnType<typeof createEncryptedProfiles>['begin']>;
  const setup = await request<Setup>('/api/profile-setups', {
    body: { fullName: 'Fictional Fern', birthDate: '1982-04-17', name: 'Fictional Fern' },
  });
  assert.equal(setup.status, 201);
  const verified = await request<{ id: string }>(
    `/api/profile-setups/${setup.data.setupId}/verify`,
    {
      body: { acknowledged: true, recovery: setup.data.recoveryKit },
    },
  );
  assert.equal(verified.status, 201);
  const prefix = `/api/profiles/${verified.data.id}`;
  const envelope = (id: string): HealthRecordEnvelope => ({
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: { literal: '14.00 mg' },
    provenance: {
      capturedVia: 'Fictional courier',
      sourceSystem: 'Fictional Iris lab',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'fictional row ' + id,
    },
    coverage: { status: 'complete_response', notes: [] },
    clinical: {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional sample mass',
      valueText: '12.00',
      unit: 'mg',
      date: '2026-02-10',
    },
  });
  const originalText = JSON.stringify(envelope('first'));
  const uploaded = await request<Intake>(`${prefix}/intakes`, { raw: originalText });
  assert.equal(uploaded.status, 201);
  const intakePath = `${prefix}/intakes/${encodeURIComponent(uploaded.data.id)}`;
  const review = (await request<IntakeReview>(intakePath + '/review', { method: 'GET' })).data;
  const accepted = await request(intakePath + '/import', {
    body: {
      version: review.version,
      reviewToken: review.reviewToken,
      decisions: [{ recordId: review.records[0]!.id, action: 'accept', mapping: {} }],
    },
  });
  assert.equal(accepted.status, 200);
  const incoming = (
    await request<Intake>(`${prefix}/intakes`, { raw: JSON.stringify(envelope('second')) })
  ).data;
  const incomingPath = `${prefix}/intakes/${encodeURIComponent(incoming.id)}`;
  const pending = (await request<IntakeReview>(incomingPath + '/review', { method: 'GET' })).data;
  const search = {
    proposalId: null,
    recordId: pending.records[0]!.id,
    candidateVersionId: pending.records[0]!.candidateVersionId!,
  };
  const discovered = await request<IntakeRelatedRecordsResult>(incomingPath + '/related-records', {
    body: search,
  });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.data.comparisons.length, 1);
  const recordId = discovered.data.comparisons[0]!.id;
  const correctionPath = prefix + '/clinical-review/';
  const measurementPath =
    correctionPath + 'measurement?kind=observation&recordId=' + encodeURIComponent(recordId);
  assert.equal(
    (await request<AcceptedMeasurement>(measurementPath, { method: 'GET' })).data.semanticStatus,
    'none',
  );
  const semanticRequest = {
    kind: 'observation',
    recordId,
    semantics: {
      quantity: 'specimen_mass',
      dimension: 'mass',
      region: 'not_applicable',
      specimen: 'fictional_sample',
      method: 'gravimetry',
      meaning: 'fictional_sample_mass',
    },
    precision: null,
    reason: 'Explicit fictional source semantics for comparing sample mass.',
  };
  const semanticPreview = await request<MeasurementSemanticPreview>(
    correctionPath + 'measurement-preview',
    { body: semanticRequest },
  );
  assert.equal(semanticPreview.status, 200);
  const semanticApply = {
    ...semanticPreview.data.request,
    reference: semanticPreview.data.reference,
    rulesVersion: semanticPreview.data.rulesVersion,
    version: semanticPreview.data.version,
    previewToken: semanticPreview.data.previewToken,
    operationId: randomUUID(),
  };
  const semanticResult = await request<MeasurementSemanticApplyResult>(
    correctionPath + 'measurement-apply',
    { body: semanticApply },
  );
  assert.equal(semanticResult.status, 200);
  assert.equal(
    (
      await request<MeasurementSemanticApplyResult>(correctionPath + 'measurement-apply', {
        body: semanticApply,
      })
    ).data.replayed,
    true,
  );
  const measurement = await request<AcceptedMeasurement>(measurementPath, { method: 'GET' });
  assert.equal(measurement.data.semanticStatus, 'current');
  assert.equal(deriveMeasurement(measurement.data, 'g').conversion?.exactDecimal, '0.012');
  const savedBefore = (
    await request<ReturnType<typeof getObservation>>(
      `${prefix}/tests/${encodeURIComponent(recordId)}`,
      { method: 'GET' },
    )
  ).data;
  assert.ok('valueText' in savedBefore);
  const convertedPath = `${prefix}/trends?ids=${encodeURIComponent(savedBefore.testTypeId)}&unit=g`;
  const converted = await request<Trend[]>(convertedPath, { method: 'GET' });
  assert.equal(converted.status, 200);
  assert.equal(converted.data[0]!.points[0]!.valueText, '12.00');
  assert.equal(converted.data[0]!.points[0]!.unit, 'mg');
  assert.equal(converted.data[0]!.points[0]!.measurement!.conversion?.exactDecimal, '0.012');
  assert.equal(
    (await request(convertedPath.replace('&unit=g', '&unit=made-up'), { method: 'GET' })).status,
    400,
  );
  assert.equal((await request(convertedPath, { method: 'GET', anonymous: true })).status, 423);
  const correction = {
    kind: 'observation',
    recordId,
    set: { valueText: '14.00' },
    reason: 'Correct the fictional transcription to match the retained original.',
  };
  const preview = await request<RecordCorrectionPreview>(correctionPath + 'correction-preview', {
    body: correction,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.before.valueText, '12.00');
  assert.equal(preview.data.after.valueText, '14.00');
  const exactApply = {
    ...preview.data.request,
    version: preview.data.version,
    previewToken: preview.data.previewToken,
    operationId: randomUUID(),
  };
  const applied = await request<RecordCorrectionApplyResult>(correctionPath + 'correction-apply', {
    body: exactApply,
  });
  assert.equal(applied.status, 200);
  const replay = await request<RecordCorrectionApplyResult>(correctionPath + 'correction-apply', {
    body: exactApply,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.receipt, applied.data.receipt);
  const result = await request<ReturnType<typeof getObservation>>(
    `${prefix}/tests/${encodeURIComponent(recordId)}`,
    { method: 'GET' },
  );
  assert.ok('valueText' in result.data);
  assert.equal(result.data.valueText, '14.00');
  assert.equal(result.data.unit, 'mg');
  const afterCorrection = (await request<AcceptedMeasurement>(measurementPath, { method: 'GET' }))
    .data;
  assert.equal(afterCorrection.semanticStatus, 'stale');
  assert.equal(afterCorrection.binding, null);
  const staleConverted = await request<Trend[]>(convertedPath, { method: 'GET' });
  assert.equal(staleConverted.data[0]!.points[0]!.valueText, '14.00');
  assert.equal(staleConverted.data[0]!.points[0]!.measurement!.conversion, null);
  assert.equal(staleConverted.data[0]!.points[0]!.measurement!.status, 'stale_semantics');
  assert.equal((await request<Intake>(incomingPath, { method: 'GET' })).data.imported, null);
  assert.equal((await request(uploaded.data.contentUrl, { method: 'GET' })).text, originalText);
  for (const [path, body] of [
    [incomingPath + '/related-records', search],
    [correctionPath + 'correction-preview', correction],
    [correctionPath + 'correction-apply', exactApply],
    [correctionPath + 'measurement-preview', semanticRequest],
    [correctionPath + 'measurement-apply', semanticApply],
  ] as const) {
    assert.equal((await request(path, { body, anonymous: true })).status, 423);
    assert.equal((await request(path, { body, origin: 'https://foreign.example' })).status, 403);
  }
  const finalReview = (await request<IntakeReview>(incomingPath + '/review', { method: 'GET' }))
    .data;
  assert.equal(
    (
      await request(incomingPath + '/import', {
        body: {
          version: finalReview.version,
          reviewToken: finalReview.reviewToken,
          decisions: [{ recordId: finalReview.records[0]!.id, action: 'accept', mapping: {} }],
        },
      })
    ).status,
    200,
  );
  const secondRecord = (await request<Intake>(incomingPath, { method: 'GET' })).data.imported!
    .clinical!.records![0]!;
  const relationshipPath = prefix + '/clinical-relationships';
  const pairPath =
    relationshipPath +
    '/pair?' +
    new URLSearchParams({
      leftKind: 'observation',
      leftRecordId: recordId,
      rightKind: 'observation',
      rightRecordId: secondRecord.entityId,
    });
  const currentPair = await request<{
    left: ClinicalRelationshipSide;
    right: ClinicalRelationshipSide;
  }>(pairPath, { method: 'GET' });
  assert.equal(currentPair.status, 200);
  assert.equal(
    currentPair.data.left.mapping.valueText,
    '14.00',
    'pair opens the current corrected assertion',
  );
  assert.equal(currentPair.data.right.mapping.valueText, '12.00');
  assert.ok(currentPair.data.left.evidence[0]!.contentUrl);
  assert.equal((await request(pairPath, { method: 'GET', anonymous: true })).status, 423);
  assert.equal(
    (await request(pairPath, { method: 'GET', origin: 'https://foreign.example' })).status,
    403,
  );
  assert.equal(
    (
      await request(
        relationshipPath +
          '/pair?' +
          new URLSearchParams({
            leftKind: 'observation',
            leftRecordId: recordId,
            rightKind: 'observation',
            rightRecordId: 'missing-foreign-record',
          }),
        { method: 'GET' },
      )
    ).status,
    404,
  );
  const preference = {
    left: { kind: 'observation', recordId },
    right: { kind: 'observation', recordId: secondRecord.entityId },
    action: 'display_preference',
    mode: 'prefer_right',
    attestation: 'same_recorded_event',
    reason: 'The fictional original review establishes one event with two assertions.',
  };
  const pairPreview = await request<ClinicalRelationshipPreview>(relationshipPath + '/preview', {
    body: preference,
  });
  assert.equal(pairPreview.status, 200);
  const pairApply = {
    request: pairPreview.data.request,
    scope: pairPreview.data.scope,
    version: pairPreview.data.version,
    previewToken: pairPreview.data.previewToken,
    operationId: randomUUID(),
  };
  const pairResult = await request<ClinicalRelationshipApplyResult>(relationshipPath + '/apply', {
    body: pairApply,
  });
  assert.equal(pairResult.status, 200);
  const receipt = await request<ClinicalRelationshipApplyResult>(
    relationshipPath + '/operations/' + pairApply.operationId,
    { method: 'GET' },
  );
  assert.deepEqual(receipt.data.receipt, pairResult.data.receipt);
  const projectionPath =
    relationshipPath + '?kind=observation&recordId=' + encodeURIComponent(recordId);
  const projection = (
    await request<ClinicalRelationshipProjection>(projectionPath, { method: 'GET' })
  ).data;
  assert.equal(projection.display.visibleByDefault, false);
  assert.equal(projection.display.preferredRecordId, secondRecord.entityId);
  assert.equal(projection.display.oneReviewedEvent, true);
  const chart = await request<Trend[]>(
    prefix + '/trends?ids=' + encodeURIComponent(result.data.testTypeId),
    { method: 'GET' },
  );
  assert.equal(chart.status, 200);
  assert.equal(
    chart.data[0]!.points.length,
    2,
    'API retains both assertions for original-value inspection',
  );
  assert.equal(
    chart.data[0]!.points.find((point) => point.id === recordId)!.relationship!.display
      .visibleByDefault,
    false,
  );
  assert.equal(
    new Set(chart.data[0]!.points.map((point) => point.relationship!.display.countGroupId)).size,
    1,
  );
  assert.equal(
    (await request(`${prefix}/tests/${encodeURIComponent(recordId)}`, { method: 'GET' })).status,
    200,
  );
  const history = await request<{ entries: unknown[] }>(
    relationshipPath + '/history?kind=observation&recordId=' + encodeURIComponent(recordId),
    { method: 'GET' },
  );
  assert.equal(history.status, 200);
  assert.equal(history.data.entries.length, 1);
  for (const [path, body] of [
    [relationshipPath + '/preview', preference],
    [relationshipPath + '/apply', pairApply],
  ] as const) {
    assert.equal((await request(path, { body, anonymous: true })).status, 423);
    assert.equal((await request(path, { body, origin: 'https://foreign.example' })).status, 403);
  }
  assert.equal((await request(prefix + '/lock')).status, 200);
  assert.equal((await request(projectionPath, { method: 'GET' })).status, 423);
  assert.equal((await request(pairPath, { method: 'GET' })).status, 423);
  assert.equal((await request(convertedPath, { method: 'GET' })).status, 423);
  assert.equal((await request(measurementPath, { method: 'GET' })).status, 423);
  assert.equal(
    (await request(correctionPath + 'correction-preview', { body: correction })).status,
    423,
  );
  assert.equal((await request(incomingPath + '/related-records', { body: search })).status, 423);
});
