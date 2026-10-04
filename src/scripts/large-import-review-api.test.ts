import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createVaultApp } from '../server/vault-app.ts';
import type { Note, Observation, Medication, Procedure } from '../shared/api.ts';
import type {
  HealthRecordEnvelope,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../shared/intake.ts';
import type {
  IntakeIdentityPerson,
  IntakeIdentityConfirmation,
} from '../shared/intake-identity.ts';
import type { IntakeRead } from '../shared/intake-summary.ts';
import { isIntakeSummary } from '../shared/intake-summary.ts';
import type {
  CollectionReportDetail,
  CollectionReportGroupSummary,
} from '../shared/intake-clinical-pages.ts';
import {
  collectQualificationFeed,
  readQualificationReview,
  readQualificationIdentity,
} from './qualification-intake-read.ts';
import type { IntakeBatch } from '../shared/intake-batch.ts';
import { writeFictionalPdf } from './fictional-pdf-writer.ts';
import { createLargeImportOracle } from './large-import-fixture.ts';
import {
  gradeLargeImportReview,
  type NativeLargeImportReviewAuthority,
} from './large-import-review-grader.ts';
import {
  gradeLargeImportAccepted,
  type LargeImportAcceptedEntity,
} from './large-import-accepted-grader.ts';
import { removeQualificationCache } from './provider-qualification-acceptance.ts';

test('independent small real upload/proposal/review snapshots remain a partial oracle result', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fictional-review-grader-')));
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
  async function request<T>(
    path: string,
    input?: unknown,
    bytes?: Buffer,
    rejection?: string,
  ): Promise<T> {
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
    const result = (await response.json()) as { data: T; error?: { code?: string } };
    if (rejection) {
      assert.equal(response.ok, false);
      assert.equal(result.error?.code, rejection);
      return result.data;
    }
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
  const originalBytes = readFileSync(path);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');
  const uploaded = await request<IntakeRead>(prefix + '/intakes', undefined, originalBytes);
  assert.equal(uploaded.sha256, originalHash);
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
  const current = await request<IntakeRead>(prefix + `/intakes/${uploaded.id}`);
  const proposed = await request<IntakeRead>(prefix + `/intakes/${uploaded.id}/proposals`, {
    version: current.version,
    summary: 'Independent partial fictional proposals',
    jsonlText: envelopes.map((item) => JSON.stringify(item)).join('\n'),
  });
  const proposedFeed = await collectQualificationFeed(request, prefix);
  const proposalIds = new Set(proposedFeed.blocks.map((block) => block.proposalId));
  assert.equal(proposalIds.size, 1);
  const proposalId = [...proposalIds][0];
  assert.ok(proposalId);
  assert.equal(proposed.id, uploaded.id);
  const review = await readQualificationReview(
    request,
    prefix + `/intakes/${uploaded.id}/review?proposalId=${encodeURIComponent(proposalId)}`,
  );
  assert.equal(review.records.length, 5);
  async function authoritiesSnapshot(): Promise<NativeLargeImportReviewAuthority[]> {
    const retained = await request<IntakeRead>(prefix + '/intakes/' + uploaded.id);
    assert.ok(isIntakeSummary(retained));
    const selected: NativeLargeImportReviewAuthority[] = [];
    const queue = await request<{
      format: 'health-intake-report-queue-page-v2';
      groups: { kind: 'group'; group: CollectionReportGroupSummary }[];
      nextCursor: string | null;
    }>(prefix + '/intakes/report-queue?view=all&limit=100');
    assert.equal(queue.format, 'health-intake-report-queue-page-v2');
    assert.equal(queue.nextCursor, null);
    for (const entry of queue.groups) {
      assert.equal(entry.kind, 'group');
      const group = entry.group;
      const pages: CollectionReportDetail['records'][] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const detail: CollectionReportDetail = await request<CollectionReportDetail>(
          prefix +
            '/intakes/report-queue/' +
            encodeURIComponent(group.groupId) +
            '?view=all&limit=100&intakeId=' +
            encodeURIComponent(uploaded.id) +
            (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        );
        assert.deepEqual(detail.group, group);
        pages.push(detail.records);
        cursor = detail.records.nextCursor;
        if (cursor) {
          assert.equal(seen.has(cursor), false);
          seen.add(cursor);
        }
      } while (cursor);
      const inspected = await readQualificationIdentity(
        request,
        prefix +
          '/intakes/' +
          uploaded.id +
          '/identity-review?groupId=' +
          encodeURIComponent(group.groupId),
      );
      selected.push({
        format: 'qualification-native-report-v1',
        group,
        records: pages,
        sourceHash: retained.sha256,
        identity: inspected.review,
        inspectedScope: inspected.inspectedScope,
      });
    }
    return selected;
  }
  const authorities = await authoritiesSnapshot();
  const retained = await request<IntakeRead>(prefix + '/intakes/' + uploaded.id);
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
  assert.equal(result.ownershipResolved, false);
  assert.equal(result.missing.length, 896);
  assert.equal(result.unexpectedRecords, 0);
  assert.deepEqual(result.authorityIssues, []);
  assert.equal(result.passed, false);
  assert.equal(result.reviewReady, false);
  for (const mutate of [
    (item: NativeLargeImportReviewAuthority) => {
      item.records[0]!.records.pop();
    },
    (item: NativeLargeImportReviewAuthority) => {
      item.records[0]!.nextCursor = 'unfinished';
    },
    (item: NativeLargeImportReviewAuthority) => {
      item.records[0]!.version++;
    },
    (item: NativeLargeImportReviewAuthority) => {
      item.sourceHash = 'wrong-original';
    },
  ]) {
    const incomplete = structuredClone(authorities);
    mutate(incomplete[0]!);
    const rejected = gradeLargeImportReview({
      oracle: createLargeImportOracle(),
      stage: 'proposal',
      originalId: uploaded.id,
      people: { 'fictional-cedar': cedar, 'fictional-willow': savedWillow },
      reviews: [review],
      authorities: incomplete,
    });
    assert.ok(rejected.authorityIssues.includes('conflictingAuthority'));
    assert.equal(rejected.passed, false);
  }

  const peopleBefore = await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people');
  const notesBefore = await Promise.all(
    peopleBefore.map((person) => request<Note>(prefix + `/notes/${person.noteId}`)),
  );
  const workflowBefore = await request<IntakeRead>(prefix + `/intakes/${uploaded.id}`);
  const identityPath = prefix + `/intakes/${uploaded.id}/identity-scope`;
  async function identity(groupId: string) {
    return readQualificationIdentity(
      request,
      prefix +
        '/intakes/' +
        uploaded.id +
        '/identity-review?groupId=' +
        encodeURIComponent(groupId),
    );
  }
  function confirmation(
    reading: Awaited<ReturnType<typeof identity>>,
    operationId: string,
    person?: IntakeIdentityPerson,
  ): IntakeIdentityConfirmation {
    return {
      version: reading.confirmationScope.intakeVersion,
      scope: reading.confirmationScope,
      operationId,
      outcome: person ? 'this_is_person' : 'this_is_me',
      printedName: person ? 'Fictional Willow Brook' : 'Fictional Cedar Vale',
      attestation: 'confirmed_displayed_identity_questions',
      ...(person
        ? { personSelection: { noteId: person.noteId, expectedVersion: person.version } }
        : {}),
    };
  }
  const cedarGroup = authorities.find(
    (authority) =>
      (authority.group.report as { key?: string } | null)?.key === 'fictional-report-1',
  )!;
  const willowGroup = authorities.find(
    (authority) =>
      (authority.group.report as { key?: string } | null)?.key === 'fictional-report-2',
  )!;
  assert.ok(cedarGroup);
  assert.ok(willowGroup);
  const cedarReading = await identity(cedarGroup.group.groupId);
  const willowReading = await identity(willowGroup.group.groupId);
  assert.equal(cedarReading.review.evidencedIdentity.fullName, 'Fictional Cedar Vale');
  assert.equal(willowReading.review.evidencedIdentity.fullName, 'Fictional Willow Brook');
  await request(
    identityPath,
    confirmation(willowReading, 'wrong-self'),
    undefined,
    'IDENTITY_CONFLICT',
  );
  await request(
    identityPath,
    {
      ...confirmation(cedarReading, 'wrong-person', savedWillow),
      printedName: 'Fictional Cedar Vale',
    },
    undefined,
    'IDENTITY_CONFLICT',
  );
  const stalePerson = confirmation(willowReading, 'stale-person', {
    ...savedWillow,
    version: savedWillow.version + 1,
  });
  await request(identityPath, stalePerson, undefined, 'PERSON_VERSION_CONFLICT');
  const alteredScope = confirmation(cedarReading, 'altered-scope');
  alteredScope.scope = {
    ...alteredScope.scope,
    subject: { ...alteredScope.scope.subject, text: subject2 },
  };
  await request(identityPath, alteredScope, undefined, 'IDENTITY_SCOPE');
  assert.deepEqual(await request<IntakeRead>(prefix + `/intakes/${uploaded.id}`), workflowBefore);
  assert.deepEqual(
    await Promise.all(
      peopleBefore.map((person) => request<Note>(prefix + `/notes/${person.noteId}`)),
    ),
    notesBefore,
  );

  const cedarInput = confirmation(await identity(cedarGroup.group.groupId), 'confirm-cedar');
  const cedarConfirmed = await request<IntakeRead>(identityPath, cedarInput);
  assert.deepEqual(await request<IntakeRead>(identityPath, cedarInput), cedarConfirmed);
  // The first successful write invalidates the other displayed intake snapshot.
  await request(
    identityPath,
    confirmation(willowReading, 'stale-scope', savedWillow),
    undefined,
    'VERSION_CONFLICT',
  );
  const stillWillow = await identity(willowGroup.group.groupId);
  // A different DOB from an earlier confirmed report on this same original
  // requires Willow's own explicit choice; Cedar's receipt cannot assign her.
  assert.equal(stillWillow.review.assignedPerson, undefined);
  assert.equal(stillWillow.review.blocking, true);
  assert.equal(stillWillow.review.status, 'confirmation_required');
  const confirmedCedarReview = await identity(cedarGroup.group.groupId);
  assert.equal(confirmedCedarReview.review.confirmationCount, 1);
  assert.equal(confirmedCedarReview.inspectedScope.groupId, cedarGroup.group.groupId);
  const currentPeople = await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people');
  const currentWillow = currentPeople.find((person) => person.personId === willow.personId)!;
  const willowInput = confirmation(stillWillow, 'confirm-willow', currentWillow);
  const willowConfirmed = await request<IntakeRead>(identityPath, willowInput);
  assert.deepEqual(await request<IntakeRead>(identityPath, willowInput), willowConfirmed);
  assert.deepEqual(
    await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people'),
    peopleBefore,
  );
  assert.deepEqual(
    await Promise.all(
      peopleBefore.map((person) => request<Note>(prefix + `/notes/${person.noteId}`)),
    ),
    notesBefore,
  );
  const finalIntake = await request<IntakeRead>(prefix + `/intakes/${uploaded.id}`);
  assert.equal(finalIntake.sha256, originalHash);
  assert.equal(finalIntake.id, retained.id);
  for (const [groupId, printedName, subject] of [
    [cedarGroup.group.groupId, 'Fictional Cedar Vale', subject1],
    [willowGroup.group.groupId, 'Fictional Willow Brook', subject2],
  ] as const) {
    const confirmed = await identity(groupId);
    assert.equal(confirmed.review.confirmationCount, 1);
    assert.equal(confirmed.inspectedScope.sourceHash, originalHash);
    assert.equal(confirmed.inspectedScope.subject.text, subject);
    assert.equal(confirmed.review.evidencedIdentity.fullName, printedName);
  }
  const finalReview = await readQualificationReview(
    request,
    prefix + `/intakes/${uploaded.id}/review?proposalId=${encodeURIComponent(proposalId)}`,
  );
  for (const record of finalReview.records) {
    const initial = review.records.find((item) => item.id === record.id)!;
    const {
      subject: _initialSubject,
      personId: _initialPerson,
      ...initialClinical
    } = initial.mapping;
    const { subject: _finalSubject, personId: _finalPerson, ...finalClinical } = record.mapping;
    assert.deepEqual(finalClinical, initialClinical);
    assert.deepEqual(record.evidence, initial.evidence);
    assert.equal(record.identityReview?.blocking, false);
    assert.equal(record.mapping.subject, record.mapping.testLabel === 'FXP151' ? 'other' : 'self');
    assert.equal(
      record.mapping.personId,
      record.mapping.testLabel === 'FXP151' ? willow.personId : undefined,
    );
  }
  const finalAuthorities = await authoritiesSnapshot();
  const finalGrade = gradeLargeImportReview({
    oracle: createLargeImportOracle(),
    stage: 'review',
    originalId: uploaded.id,
    people: { 'fictional-cedar': cedar, 'fictional-willow': savedWillow },
    reviews: [finalReview],
    authorities: finalAuthorities,
  });
  assert.equal(finalGrade.exactRecords, 5, JSON.stringify(finalGrade));
  assert.deepEqual(finalGrade.mismatches, []);
  assert.deepEqual(finalGrade.unresolved, []);
  assert.deepEqual(finalGrade.authorityIssues, []);
  assert.equal(finalGrade.missing.length, 896);
  assert.equal(finalGrade.ownershipResolved, false);
  assert.equal(finalGrade.clinicalProvenancePassed, false);
  assert.equal(finalGrade.reviewReady, false);
  assert.equal(finalGrade.passed, false);
  const originalResponse = await fetch(
    base + finalAuthorities[0]!.inspectedScope!.original.contentUrl,
    { headers: { Cookie: cookie }, signal: t.signal },
  );
  assert.equal(originalResponse.ok, true);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await originalResponse.arrayBuffer()))
      .digest('hex'),
    originalHash,
  );
  // Acceptance is explicit and limited to this fresh fictional profile. Capture
  // exact current versions; the whole 901-assertion oracle still remains incomplete.
  const acceptance: IntakeReportAcceptanceRequest = {
    operationId: 'cf28d806-8e1d-4d69-9b61-38f460bc9768',
    blocks: [
      {
        intakeId: uploaded.id,
        proposalId,
        intakeVersion: finalReview.version,
        reviewToken: finalReview.reviewToken,
        selections: finalReview.records.map((record) => {
          assert.ok(record.candidateId && record.candidateVersionId);
          return {
            recordId: record.id,
            candidateId: record.candidateId,
            candidateVersionId: record.candidateVersionId,
            mapping: {},
          };
        }),
      },
    ],
  };
  const accepted = await request<IntakeReportAcceptanceResult>(
    prefix + '/intakes/report-acceptance',
    acceptance,
  );
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.receipt.acceptedCount, 5);
  async function checkReceipt() {
    const fetched = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance/' + acceptance.operationId,
    );
    assert.deepEqual(fetched.receipt, accepted.receipt);
    const replay = await request<IntakeReportAcceptanceResult>(
      prefix + '/intakes/report-acceptance',
      acceptance,
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, accepted.receipt);
  }
  const collections = {
    observation: 'tests',
    medication: 'medications',
    procedure: 'procedures',
  } as const;
  async function acceptedSnapshot() {
    const entities: LargeImportAcceptedEntity[] = [];
    for (const part of accepted.receipt.receipts)
      for (const entry of part.records) {
        assert.notEqual(entry.kind, 'document');
        if (entry.kind === 'observation')
          entities.push({
            kind: entry.kind,
            record: await request<Observation>(
              prefix + `/tests/${encodeURIComponent(entry.entityId)}`,
            ),
          });
        else if (entry.kind === 'medication')
          entities.push({
            kind: entry.kind,
            record: await request<Medication>(
              prefix + `/medications/${encodeURIComponent(entry.entityId)}`,
            ),
          });
        else if (entry.kind === 'procedure')
          entities.push({
            kind: entry.kind,
            record: await request<Procedure>(
              prefix + `/procedures/${encodeURIComponent(entry.entityId)}`,
            ),
          });
      }
    const people = await request<IntakeIdentityPerson[]>(prefix + '/record-ownership/people');
    assert.deepEqual(people, peopleBefore);
    assert.deepEqual(
      await Promise.all(people.map((person) => request<Note>(prefix + `/notes/${person.noteId}`))),
      notesBefore,
    );
    // Lists and details must agree for both owners; default-Self list filtering
    // cannot hide the family record or masquerade as a whole-profile count.
    for (const person of people)
      for (const kind of ['observation', 'medication', 'procedure'] as const) {
        const listed = await request<Array<Observation | Medication | Procedure>>(
          prefix +
            `/${collections[kind]}?personId=${encodeURIComponent(person.personId)}&limit=100${kind === 'medication' ? '&status=all' : ''}`,
        );
        const expected = entities.filter(
          (entity) => entity.kind === kind && entity.record.personId === person.personId,
        );
        assert.deepEqual(
          listed.map((record) => record.id).sort(),
          expected.map((entity) => entity.record.id).sort(),
        );
        assert.ok(listed.every((record) => record.personId === person.personId));
      }
    const grade = gradeLargeImportAccepted({
      oracle: createLargeImportOracle(),
      originalId: uploaded.id,
      people: {
        'fictional-cedar': people.find((person) => person.personId === 'patient')!,
        'fictional-willow': people.find((person) => person.personId === willow.personId)!,
      },
      records: entities,
      transactions: [{ request: acceptance, reviews: [finalReview], receipt: accepted.receipt }],
    });
    assert.equal(grade.exactRecords, 5, JSON.stringify(grade));
    assert.equal(grade.observedRecordsPassed, true, JSON.stringify(grade));
    assert.equal(grade.receiptsPassed, true, JSON.stringify(grade));
    assert.equal(grade.missing.length, 896);
    assert.equal(grade.passed, false);
    const source = await fetch(
      base + prefix + `/sources/${encodeURIComponent(uploaded.id)}/content`,
      { headers: { Cookie: cookie }, signal: t.signal },
    );
    assert.equal(source.ok, true);
    const bytes = Buffer.from(await source.arrayBuffer());
    assert.deepEqual(bytes, originalBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), originalHash);
    return entities;
  }
  await checkReceipt();
  const before = await acceptedSnapshot();
  await request(prefix + '/lock', {});
  assert.equal(app.manager.opened.has(profile.id), false);
  removeQualificationCache(join(root, 'data'), profile.id, new Set([profile.id]));
  await request(prefix + '/unlock', { recovery: setup.recoveryKit });
  assert.equal(app.manager.opened.get(profile.id)!.metrics.cacheHit, false);
  const after = await acceptedSnapshot();
  assert.deepEqual(after, before);
  await checkReceipt();
  assert.deepEqual(await acceptedSnapshot(), before);
});
