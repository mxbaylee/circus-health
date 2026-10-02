import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVaultApp } from '../server/vault-app.ts';
import type { Note } from '../shared/api.ts';
import type {
  Intake,
  IntakeReview,
  IntakeReportQueue,
  HealthRecordEnvelope,
} from '../shared/intake.ts';
import type { IntakeIdentityPerson, IntakeIdentityReview } from '../shared/intake-identity.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import { writeFictionalPdf } from './fictional-pdf-writer.ts';
import { createLargeImportOracle } from './large-import-fixture.ts';
import {
  gradeLargeImportReview,
  type LargeImportReviewAuthority,
} from './large-import-review-grader.ts';

test('independent small real upload/proposal/review snapshots remain a partial oracle result', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-review-grader-'));
  mkdirSync(join(root, 'data'));
  const app = createVaultApp({
    dataDirectory: join(root, 'data'),
    runtimeDirectory: join(root, 'runtime'),
    assistantOptions: { availability: async () => ({ available: false }) },
  });
  t.after(() => {
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request<T>(path: string, input?: unknown, bytes?: Buffer): Promise<T> {
    const response = await fetch(base + path, {
      method: input !== undefined || bytes ? 'POST' : 'GET',
      headers: {
        Origin: 'http://localhost:5173',
        Cookie: cookie,
        'Content-Type': bytes ? 'application/pdf' : 'application/json',
        ...(bytes ? { 'X-Filename': 'independent-fictional.pdf' } : {}),
      },
      ...(bytes
        ? { body: Uint8Array.from(bytes).buffer }
        : input !== undefined
          ? { body: JSON.stringify(input) }
          : {}),
      signal: t.signal,
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const result = (await response.json()) as { data: T; error?: unknown };
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  const setup = await request<{ setupId: string; recoveryKit: unknown }>('/api/profile-setups', {
    name: 'Fictional grader',
    fullName: 'Fictional Cedar Vale',
    birthDate: '1982-04-17',
    placebo: false,
  });
  const profile = await request<{ id: string }>(`/api/profile-setups/${setup.setupId}/verify`, {
    recovery: setup.recoveryKit,
    acknowledged: true,
  });
  const prefix = `/api/profiles/${profile.id}`;
  const willow = await request<Note>(prefix + '/notes', {
    kind: 'person',
    title: 'Fictional Willow Brook',
    person: { fullName: 'Fictional Willow Brook', birthDate: '1991-09-23' },
  });
  assert.ok(willow.personId);
  // Independently written content/envelopes, not oracle-to-actual copies. Blank pages
  // preserve original149/150/151 numbering without running any extraction/provider.
  const header1 = 'Report: fictional-report-1.',
    subject1 = 'Patient: Fictional Cedar Vale. DOB: 1982-04-17.';
  const header2 = 'Report: fictional-report-2.',
    subject2 = 'Patient: Fictional Willow Brook. DOB: 1991-09-23.';
  const text = new Map<number, string[]>([
    [
      1,
      [
        header1,
        subject1,
        'Performed laboratory observation FXP001 on 2026-01-12; final.',
        '<0.070 unit-X; reference 0.010 - 9.990',
      ],
    ],
    [
      2,
      [header1, subject1, 'Medication ORDER FXP002, recorded 2026-01-12: 2.50 mg oral once daily.'],
    ],
    [3, [header1, subject1, 'Performed imaging procedure FXP003 on 2026-01-12; completed.']],
    [
      149,
      [
        header1,
        subject1,
        'Laboratory table: final performed observations 2026-01-12.',
        'FX-CROSS-001 | continued on page150',
      ],
    ],
    [150, [header1, subject1, 'Continued row from page149: <0.0030 | unit-Y | 0.0010 - 0.0090']],
    [
      151,
      [
        header2,
        subject2,
        'Performed laboratory observation FXP151 on 2026-02-12; final.',
        '<0.070 unit-X; reference 0.010 - 9.990',
      ],
    ],
  ]);
  const path = join(root, 'independent.pdf');
  writeFictionalPdf(path, {
    pages: 151,
    pageAt(page) {
      return {
        font: 'Courier',
        content: Buffer.from(
          (text.get(page) ?? ['Intentionally blank fictional page'])
            .map(
              (line, index) =>
                `BT /F1 10 Tf 30 ${752 - index * 24} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET\n`,
            )
            .join(''),
        ),
      };
    },
  });
  const uploaded = await request<Intake>(prefix + '/intakes', undefined, readFileSync(path));
  const batches = await request<IntakeBatch[]>(prefix + '/intake-batches');
  for (const batch of batches.filter((batch) =>
    batch.items.some((item) => item.intakeId === uploaded.id),
  ))
    await request(prefix + `/intake-batches/${batch.id}/stop`, {});
  const observation = (
    testLabel: string,
    date: string,
    valueText = '<0.070',
    unit = 'unit-X',
    referenceText = '0.010 - 9.990',
  ) => ({
    kind: 'observation',
    testLabel,
    date,
    eventKind: 'performed',
    status: 'final',
    observationCategory: 'laboratory',
    valueText,
    unit,
    referenceText,
  });
  const independent = [
    { id: 'independent-lab', page: 1, clinical: observation('FXP001', '2026-01-12') },
    {
      id: 'independent-order',
      page: 2,
      clinical: {
        kind: 'medication',
        medicationName: 'FXP002',
        date: '2026-01-12',
        eventKind: 'order',
        medicationKind: 'order',
        dateRole: 'recorded',
        doseText: '2.50 mg',
        route: 'oral',
        frequency: 'once daily',
      },
    },
    {
      id: 'independent-procedure',
      page: 3,
      clinical: {
        kind: 'procedure',
        procedureLabel: 'FXP003',
        date: '2026-01-12',
        eventKind: 'performed',
        procedureCategory: 'imaging',
        status: 'completed',
      },
    },
    {
      id: 'independent-split',
      page: 149,
      clinical: observation('FX-CROSS-001', '2026-01-12', '<0.0030', 'unit-Y', '0.0010 - 0.0090'),
    },
    { id: 'independent-willow', page: 151, clinical: observation('FXP151', '2026-02-12') },
  ];
  const envelopes: HealthRecordEnvelope[] = independent.map((item) => ({
    format: 'health-record-v1',
    id: item.id,
    kind: 'record',
    payload: text.get(item.page)!.join('\n'),
    clinical: { ...item.clinical, subject: 'unknown' },
    provenance: {
      capturedVia: 'Independent fictional host fixture',
      sourceSystem: null,
      sourceRecordId: null,
      evidenceClass: 'transcription',
      locator:
        item.page === 149
          ? 'page 149 analyte; page 150 result unit reference'
          : `page ${item.page}`,
    },
    coverage: { status: 'partial', notes: [] },
    report: {
      key: item.page === 151 ? 'fictional-report-2' : 'fictional-report-1',
      title: 'Fictional report',
      anchor: {
        locator: item.page === 151 ? 'page 151' : 'page 1',
        text: item.page === 151 ? header2 : header1,
      },
      subject: {
        locator: item.page === 151 ? 'page 151' : 'page 1',
        text: item.page === 151 ? subject2 : subject1,
      },
    },
  }));
  const current = await request<Intake>(prefix + `/intakes/${uploaded.id}`);
  const proposed = await request<Intake>(prefix + `/intakes/${uploaded.id}/proposals`, {
    version: current.version,
    summary: 'Independent partial fictional proposals',
    jsonlText: envelopes.map((item) => JSON.stringify(item)).join('\n'),
  });
  const proposalId = proposed.proposals.at(-1)!.id;
  const review = await request<IntakeReview>(
    prefix + `/intakes/${uploaded.id}/review?proposalId=${encodeURIComponent(proposalId)}`,
  );
  assert.equal(review.records.length, 5);
  const queue = await request<IntakeReportQueue>(
    prefix + '/intakes/report-queue?view=all&limit=100',
  );
  const retained = await request<Intake>(prefix + `/intakes/${uploaded.id}`);
  const authorities: LargeImportReviewAuthority[] = [];
  for (const group of queue.groups)
    authorities.push({
      queue: group,
      retained: retained.workflow!.reportGroups!.find((item) => item.id === group.groupId)!,
      identity: await request<IntakeIdentityReview>(
        prefix +
          `/intakes/${uploaded.id}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
      ),
    });
  const savedPeople = await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people');
  const cedar = savedPeople.find((person) => person.personId === 'patient');
  const savedWillow = savedPeople.find((person) => person.personId === willow.personId);
  assert.ok(cedar);
  assert.ok(savedWillow);
  assert.equal(savedWillow.personId, willow.personId);
  const result = gradeLargeImportReview({
    oracle: createLargeImportOracle(),
    stage: 'proposal',
    originalId: uploaded.id,
    people: { 'fictional-cedar': cedar, 'fictional-willow': savedWillow },
    reviews: [review],
    authorities,
  });
  assert.equal(result.observedRecords, 5);
  assert.equal(result.exactRecords, 5, JSON.stringify(result));
  // Keep the real identity finding: the host retains the sentence-ending period
  // in each evidenced name and initially compares Willow's DOB with Self.
  // Clinical/source correctness must not erase those ownership disagreements.
  assert.equal(result.mismatches.length, 5);
  for (const mismatch of result.mismatches) {
    assert.deepEqual(mismatch.fields, []);
    assert.deepEqual(mismatch.provenance, []);
    assert.deepEqual(mismatch.ownership, ['identityConflict']);
  }
  assert.equal(result.unresolved.length, 5);
  assert.equal(result.ownershipResolved, false);
  assert.equal(result.missing.length, 896);
  assert.equal(result.unexpectedRecords, 0);
  assert.deepEqual(result.authorityIssues, []);
  assert.equal(result.passed, false);
  assert.equal(result.reviewReady, false);
});
