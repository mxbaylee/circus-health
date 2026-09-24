import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, type Browser, type Request } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';
import type { Medication, Note, Observation, Procedure } from '../../shared/api.ts';
import type {
  HealthRecordEnvelope,
  Intake,
  IntakeImportFeed,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
  IntakeReview,
} from '../../shared/intake.ts';
import type { IntakePeopleQueue, IntakePersonApplyRequest } from '../../shared/intake-people.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityScope,
} from '../../shared/intake-identity.ts';
import type { VisionPrescriptionRecord } from '../../shared/vision.ts';

const report = (title: string) => ({
  key: title,
  title,
  anchor: { locator: 'page 1 heading', text: title },
  subject: { locator: 'page 1 patient', text: 'Fictional Sol Linden' },
});
function envelope(
  id: string,
  title: string,
  clinical: HealthRecordEnvelope['clinical'],
): HealthRecordEnvelope {
  return {
    format: 'health-record-v1',
    id,
    kind: 'record',
    payload: `${title}. Patient: Fictional Sol Linden. Independent fictional entry ${id}: ${JSON.stringify(clinical)}.`,
    provenance: {
      capturedVia: 'Fictional encrypted holdout',
      sourceSystem: 'Fictional Linden archive',
      sourceRecordId: id,
      evidenceClass: 'provider_export',
      locator: 'page 1 ' + id,
    },
    coverage: { status: 'partial', notes: [] },
    report: report(title),
    clinical,
  };
}
const clinicalRows: HealthRecordEnvelope[] = [
  envelope('fictional-linden-copper', 'Fictional Linden laboratory report', {
    kind: 'observation',
    subject: 'self',
    testLabel: 'Fictional Linden copper',
    valueText: '<003.40',
    unit: 'ug/L',
    date: '2025-11',
    eventKind: 'performed',
  }),
  {
    ...envelope('fictional-linden-blocked', 'Fictional Linden laboratory report', {
      kind: 'observation',
      subject: 'self',
      testLabel: 'Fictional Linden unclear result',
      valueText: '+009.00',
      unit: 'arb',
      date: '2025-11',
    }),
    reviewIssues: [
      { kind: 'uncertain_reading', field: 'valueText', prompt: 'Is this fictional result 9 or 8?' },
    ],
  },
  envelope('fictional-linden-medication', 'Fictional Linden visit report', {
    kind: 'medication',
    subject: 'self',
    medicationName: 'Fictional Linden capsule',
    doseText: '0.250 mg',
    frequency: 'every 36 hours',
    medicationKind: 'order',
    dateRole: 'recorded',
    date: '2025-11-04',
  }),
  envelope('fictional-linden-imaging', 'Fictional Linden visit report', {
    kind: 'procedure',
    subject: 'self',
    procedureLabel: 'Fictional Linden abdominal imaging',
    procedureCategory: 'imaging',
    eventKind: 'performed',
    status: 'completed',
    date: '2025-11-05',
  }),
  envelope('fictional-linden-contact-lens', 'Fictional Linden visit report', {
    kind: 'document',
    subject: 'self',
    documentTitle: 'Fictional Linden contact lens prescription',
    date: '2025-11-06',
    documentDate: '2025-11-06',
    opticalPrescription: {
      type: 'contact_lens',
      prescribedDateText: '6 November 2025',
      expiresDateText: '6 November 2027',
      eyes: [
        {
          side: 'right',
          sph: { valueText: '-00.75' },
          baseCurve: { valueText: '08.60', unit: 'mm' },
        },
        { side: 'left', sph: { valueText: '+00.25' } },
      ],
    },
  }),
];
const peopleOnly: HealthRecordEnvelope = {
  ...envelope('fictional-linden-people', 'Fictional Linden people evidence', undefined),
  payload:
    'Fictional Linden people evidence. Dr. Ellis Meadow can be reached at +1 202 555 0196. Uncle River Vale reported fictional migraine symptoms.',
  people: [
    {
      id: 'fictional-ellis-meadow',
      fullName: 'Ellis Meadow',
      role: 'clinician',
      title: 'Dr. Ellis Meadow',
      phone: '+1 202 555 0196',
      evidence: [
        {
          textAnchor: 'Dr. Ellis Meadow can be reached at +1 202 555 0196.',
          supports: ['fullName', 'title', 'phone'],
          locator: 'page 1 clinician',
        },
      ],
    },
    {
      id: 'fictional-river-vale',
      fullName: 'River Vale',
      role: 'relative',
      relationship: 'Uncle',
      medicalHistory: 'fictional migraine symptoms',
      evidence: [
        {
          textAnchor: 'Uncle River Vale reported fictional migraine symptoms.',
          supports: ['fullName', 'relationship', 'medicalHistory'],
          locator: 'page 1 relative',
        },
      ],
    },
  ],
};
async function until<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error('Timed out waiting for ' + description);
}

test(
  'encrypted Import holdout defers blocked work, saves exact destinations and recovers a lost acceptance acknowledgement',
  { timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-import-feed-holdout-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startRuntime({
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      codeRoot: process.env.CIRCUS_TEST_CODE_ROOT,
      port: 0,
      host: '127.0.0.1',
      assistantOptions: { availability: () => ({ available: false }) },
    });
    let browser: Browser | undefined;
    t.after(async () => {
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15000);
    const url = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    await page.goto(url);
    const profileId = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()).data;
      };
      const runtime = await (await fetch('/api/runtime')).json();
      if (!runtime.encrypted) throw new Error('Encrypted holdout runtime required');
      const setup = await post('/api/profile-setups', {
        fullName: 'Fictional Import Holdout',
        birthDate: '1982-04-17',
        name: 'Fictional Import Holdout',
      });
      return (
        await post(`/api/profile-setups/${setup.setupId}/verify`, {
          acknowledged: true,
          recovery: setup.recoveryKit,
        })
      ).id as string;
    });
    const prefix = `/api/profiles/${profileId}`;
    async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await page.request.fetch(url + prefix + path, {
        method,
        headers: method === 'GET' ? undefined : { Origin: url },
        data: body,
      });
      const json = await response.json();
      assert.ok(response.ok(), JSON.stringify(json));
      return json.data as T;
    }
    async function upload(rows: HealthRecordEnvelope[], filename: string) {
      const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const response = await page.request.post(url + prefix + '/intakes', {
        headers: { Origin: url, 'Content-Type': 'application/x-ndjson', 'X-Filename': filename },
        data: bytes,
      });
      assert.equal(response.status(), 201, await response.text());
      return { intake: (await response.json()).data as Intake, bytes };
    }
    const clinical = await upload(clinicalRows, 'fictional-linden-clinical.jsonl');
    const people = await upload([peopleOnly], 'fictional-linden-people.jsonl');
    const selfBefore = await request<Note>('/notes/person-note%3Aself');
    const readFeed = () => request<IntakeImportFeed>('/intakes/import-feed?view=all');
    const initial = await readFeed();
    assert.equal(initial.counts.pending, 5);
    assert.equal(initial.counts.blocked, 5, 'every printed-subject clinical row awaits review');
    assert.equal(initial.counts.questions, 6, 'five identity issues plus one uncertain reading');
    const initialClinicalRecords = initial.blocks.flatMap((block) => block.records);
    assert.equal(initialClinicalRecords.length, 5);
    assert.equal(
      initialClinicalRecords.filter((record) => record.selectable).length,
      0,
      'no printed-subject clinical record is selectable before identity review',
    );
    for (const record of initialClinicalRecords) {
      assert.equal(record.identityReview?.status, 'confirmation_required');
      assert.equal(record.identityReview?.blocking, true);
      assert.equal(
        record.issues?.filter(
          (issue) => issue.kind === 'identity' && issue.blocking && issue.status === 'unresolved',
        ).length,
        1,
      );
      assert.deepEqual(
        record.issues
          ?.filter((issue) => issue.blocking && issue.status === 'unresolved')
          .map((issue) => issue.kind)
          .sort(),
        record.title === 'Fictional Linden unclear result'
          ? ['identity', 'uncertain_reading']
          : ['identity'],
      );
    }
    assert.equal(initial.people.counts.pending, 2);
    assert.equal(initial.groups.length, 2, 'two clinical reports share one retained original');
    assert.equal(initial.people.groups.length, 1, 'People-only report has independent discovery');

    await page.goto(url + '/#/import');
    await page.reload();
    const laboratoryReport = page.getByRole('region', {
      name: /Fictional Linden laboratory report/,
    });
    await laboratoryReport
      .getByText('This report identifies “Fictional Sol Linden”. Is it yours?', { exact: true })
      .waitFor();
    const initialIdentityPosts: IntakeIdentityConfirmation[] = [];
    const captureInitialIdentity = (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/identity-scope'))
        initialIdentityPosts.push(request.postDataJSON() as IntakeIdentityConfirmation);
    };
    page.on('request', captureInitialIdentity);
    const initialIdentityResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    await laboratoryReport.getByRole('button', { name: 'This is me', exact: true }).click();
    const initialIdentity = await initialIdentityResponse;
    assert.equal(initialIdentity.status(), 200, await initialIdentity.text());
    const initialIdentityRequest = initialIdentity
      .request()
      .postDataJSON() as IntakeIdentityConfirmation;
    assert.equal(initialIdentityRequest.attestation, 'confirmed_displayed_report_subject');
    assert.equal(
      initialIdentityRequest.scope.groupId,
      initial.groups.find((group) => group.title === 'Fictional Linden laboratory report')!.groupId,
    );
    assert.deepEqual(initialIdentityRequest.scope.targets.map((target) => target.title).sort(), [
      'Fictional Linden copper',
      'Fictional Linden unclear result',
    ]);
    const identityReady = await until(
      readFeed,
      (value) => value.counts.blocked === 1,
      'one same-original printed-subject confirmation to leave only the uncertain reading blocked',
    );
    page.off('request', captureInitialIdentity);
    assert.equal(
      initialIdentityPosts.length,
      1,
      'one click records exactly one identity operation',
    );
    assert.deepEqual(initialIdentityPosts[0], initialIdentityRequest);
    assert.equal(identityReady.counts.pending, 5);
    assert.equal(identityReady.counts.accepted, 0, 'identity confirmation does not accept records');
    assert.equal(identityReady.counts.questions, 1);
    const identityReadyRecords = identityReady.blocks.flatMap((block) => block.records);
    assert.equal(identityReadyRecords.filter((record) => record.selectable).length, 4);
    const stillBlocked = identityReadyRecords.filter((record) => !record.selectable);
    assert.equal(stillBlocked.length, 1);
    assert.equal(stillBlocked[0]!.title, 'Fictional Linden unclear result');
    assert.deepEqual(
      stillBlocked[0]!.issues
        ?.filter((issue) => issue.blocking && issue.status === 'unresolved')
        .map((issue) => issue.kind),
      ['uncertain_reading'],
    );
    assert.ok(
      identityReadyRecords.every(
        (record) =>
          record.identityReview?.status === 'prior_confirmation' &&
          record.issues
            ?.filter((issue) => issue.kind === 'identity')
            .every((issue) => !issue.blocking && issue.status === 'resolved'),
      ),
      'the exact same-original and printed-person confirmation applies across both reports',
    );
    await page.reload();
    await page.getByRole('tab', { name: /^All\s*7$/ }).waitFor();
    await page.getByRole('tab', { name: /^People\s*2$/ }).waitFor();
    await until(
      () => page.locator('.import-record').count(),
      (count) => count === 7,
      'seven clinical and People rows',
    );
    await page.getByLabel('Select all shown', { exact: true }).check();
    await page.getByRole('button', { name: 'Later 7', exact: true }).click();
    const deferred = await until(
      readFeed,
      (value) => value.counts.deferred === 5 && value.people.counts.later === 2,
      'all seven explicitly selected rows deferred',
    );
    assert.equal(deferred.counts.pending, 0);
    assert.equal(deferred.counts.blocked, 1);
    assert.equal(
      (await request<IntakeImportFeed>('/intakes/import-feed?view=all&edited=true')).totalRecords,
      0,
      'Later snapshots are not manual clinical edits',
    );
    await page.getByRole('combobox', { name: 'Review status' }).selectOption('later');
    await page.getByRole('tab', { name: /^All\s*7$/ }).waitFor();
    await until(
      () => page.locator('.import-record').count(),
      (count) => count === 7,
      'all deferred rows',
    );

    const acceptanceRequests: IntakeReportAcceptanceRequest[] = [];
    let lostAcknowledgement = false;
    let rejectedReceiptProbe = false;
    let receiptUnavailable = true;
    await page.route('**/intakes/report-acceptance/*', async (route) => {
      if (route.request().method() === 'GET' && receiptUnavailable) {
        rejectedReceiptProbe = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'FICTIONAL_RECEIPT_UNAVAILABLE',
              message: 'Fictional receipt check temporarily unavailable.',
            },
          }),
        });
      } else await route.continue();
    });
    await page.route('**/intakes/report-acceptance', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      acceptanceRequests.push(route.request().postDataJSON() as IntakeReportAcceptanceRequest);
      const response = await route.fetch();
      if (!lostAcknowledgement && response.ok()) {
        lostAcknowledgement = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByLabel('Select all shown', { exact: true }).check();
    await page.getByRole('button', { name: 'Save 4 records', exact: true }).click();
    const clinicalSaved = await until(
      readFeed,
      (value) => value.counts.accepted === 4,
      'four clinical records committed despite the lost acknowledgement',
    );
    assert.equal(clinicalSaved.people.counts.saved, 0, 'clinical save has its own honest count');
    assert.equal(clinicalSaved.people.counts.later, 2);
    await page
      .getByText('A save has not been confirmed yet. Check its status before retrying.', {
        exact: true,
      })
      .waitFor();
    await page
      .getByText('Save was not confirmed. Check the saved receipt before retrying.', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Add 2 people', exact: true }).isDisabled(),
      true,
      'uncertain receipt blocks another mutation after the failed check finishes',
    );
    receiptUnavailable = false;
    await page.getByRole('button', { name: 'Check save status', exact: true }).click();
    const peopleApplyRequests: IntakePersonApplyRequest[] = [];
    const peopleApplyPattern = '**/intakes/people-apply';
    await page.route(peopleApplyPattern, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      peopleApplyRequests.push(route.request().postDataJSON() as IntakePersonApplyRequest);
      if (peopleApplyRequests.length === 2) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'FICTIONAL_SECOND_PERSON_CHANGED',
              message: 'The second fictional Person changed before saving.',
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Add 2 people', exact: true }).click();
    const partiallySaved = await until(
      readFeed,
      (value) => value.people.counts.saved === 1 && value.people.counts.later === 1,
      'first Person saved before the second definite failure',
    );
    assert.equal(partiallySaved.counts.accepted, 4);
    await page
      .getByText('The second fictional Person changed before saving.', { exact: true })
      .waitFor();
    const savedAfterFailure = await request<IntakePeopleQueue>(
      `/intakes/people/${encodeURIComponent(initial.people.groups[0]!.groupId)}`,
    );
    const firstSavedPerson = savedAfterFailure.people.find((person) => person.state === 'saved')!;
    assert.ok(firstSavedPerson.saved, 'the first successful Apply has a durable destination');
    const justSavedPeople = page.getByRole('region', { name: 'Just saved People' });
    const firstDestination = justSavedPeople.getByRole('link', {
      name: new RegExp(firstSavedPerson.person.fullName),
    });
    await firstDestination.waitFor();
    assert.equal(await firstDestination.getAttribute('href'), firstSavedPerson.saved.resultUrl);
    await page.getByRole('button', { name: 'Add 1 person', exact: true }).click();
    const saved = await until(
      readFeed,
      (value) => value.counts.accepted === 4 && value.people.counts.saved === 2,
      'four clinical records and two separate People saved',
    );
    assert.equal(await justSavedPeople.getByRole('link').count(), 2);
    assert.equal(
      await firstDestination.getAttribute('href'),
      firstSavedPerson.saved.resultUrl,
      'the first confirmed destination remains available after retrying the second Person',
    );
    const savedPeople = await request<IntakePeopleQueue>(
      `/intakes/people/${encodeURIComponent(initial.people.groups[0]!.groupId)}`,
    );
    assert.equal(peopleApplyRequests.length, 3, 'only the failed Person is retried');
    for (const person of savedPeople.people)
      assert.equal(
        peopleApplyRequests.filter((request) => request.proposalId === person.id).length,
        person.id === firstSavedPerson.id ? 1 : 2,
        person.id === firstSavedPerson.id
          ? 'the first confirmed Person is never applied again'
          : 'the definite failed Person is the only retried proposal',
      );
    await page.unroute(peopleApplyPattern);
    await page.getByRole('combobox', { name: 'Review status' }).selectOption('saved');
    await page.getByRole('tab', { name: /^People\s*2$/ }).click();
    await until(
      () => page.locator('.import-record-destination').count(),
      (count) => count === 2,
      'both durable saved Person row destinations',
    );
    for (const person of savedPeople.people) {
      assert.ok(person.saved, 'every saved Person proposal exposes its durable receipt');
      const durableLink = page.locator(
        `.import-record-destination a[data-saved-person-id="${person.saved.personId}"]`,
      );
      const expectedResultUrl = person.saved.resultUrl;
      let consecutiveExactSnapshots = 0;
      const renderedDestination = await until(
        () =>
          durableLink.evaluateAll((links) => ({
            count: links.length,
            hrefs: links.map((link) => link.getAttribute('href')),
          })),
        (value) => {
          if (value.count === 1 && value.hrefs[0] === expectedResultUrl)
            consecutiveExactSnapshots += 1;
          else consecutiveExactSnapshots = 0;
          return consecutiveExactSnapshots === 3;
        },
        `one stable exact durable destination for ${person.person.fullName}`,
      );
      assert.deepEqual(renderedDestination, { count: 1, hrefs: [expectedResultUrl] });
    }
    assert.equal(saved.counts.deferred, 1, 'the selected blocked result remains deferred');
    assert.equal(saved.counts.blocked, 1);
    assert.equal(lostAcknowledgement, true);
    assert.equal(rejectedReceiptProbe, true);
    assert.equal(
      acceptanceRequests.length,
      1,
      'receipt recovery does not manufacture a second operation',
    );
    const acceptedRequest = acceptanceRequests[0]!;
    assert.equal(
      acceptedRequest.blocks.length,
      1,
      'same-proposal selections across reports are coalesced',
    );
    assert.equal(acceptedRequest.blocks[0]!.selections.length, 4);
    const result = await request<IntakeReportAcceptanceResult>(
      `/intakes/report-acceptance/${acceptedRequest.operationId}`,
    );
    assert.equal(result.receipt.selectedCount, 4);
    const records = result.receipt.receipts.flatMap((receipt) => receipt.records);
    const observation = records.find((record) => record.kind === 'observation')!;
    const medication = records.find((record) => record.kind === 'medication')!;
    const procedure = records.find((record) => record.kind === 'procedure')!;
    const document = records.find((record) => record.kind === 'document')!;
    assert.ok(observation && medication && procedure && document);
    const observed = await request<Observation>(
      `/tests/${encodeURIComponent(observation.entityId)}`,
    );
    assert.equal(observed.valueText, '<003.40');
    assert.equal(observed.unit, 'ug/L');
    assert.equal(observed.date, '2025-11');
    const prescribed = await request<Medication>(
      `/medications/${encodeURIComponent(medication.entityId)}`,
    );
    assert.equal(prescribed.doseText, '0.250 mg');
    assert.equal(prescribed.frequency, 'every 36 hours');
    assert.equal(
      prescribed.currentStatus,
      'not_current',
      'a prescription does not assert current medication use',
    );
    const performed = await request<Procedure>(
      `/procedures/${encodeURIComponent(procedure.entityId)}`,
    );
    assert.equal(performed.category, 'imaging');
    assert.equal(performed.date, '2025-11-05');
    const vision = await request<VisionPrescriptionRecord[]>(
      `/vision-prescriptions?documentId=${encodeURIComponent(document.entityId)}`,
    );
    assert.equal(vision.length, 1);
    assert.equal(vision[0]!.opticalPrescription.type, 'contact_lens');
    assert.equal(vision[0]!.opticalPrescription.eyes[0]!.sph?.valueText, '-00.75');
    assert.equal(vision[0]!.opticalPrescription.eyes[0]!.baseCurve?.valueText, '08.60');
    assert.equal(vision[0]!.opticalPrescription.expiresDateText, '6 November 2027');
    const peopleQueue = await request<IntakePeopleQueue>(
      `/intakes/people/${encodeURIComponent(initial.people.groups[0]!.groupId)}`,
    );
    assert.equal(peopleQueue.people.length, 2);
    for (const person of peopleQueue.people) {
      assert.ok(person.saved);
      const note = await request<Note>(`/notes/${encodeURIComponent(person.saved.noteId)}`);
      assert.equal(note.person.fullName, person.person.fullName);
      if (person.person.fullName === 'Ellis Meadow') {
        assert.equal(note.person.phone, '+1 202 555 0196');
        assert.deepEqual(note.person.tags, ['Professional']);
      } else {
        assert.equal(note.person.medicalHistory, 'fictional migraine symptoms');
        assert.equal(note.person.relationship, 'Uncle');
      }
    }
    assert.deepEqual(
      (await request<Note>('/notes/person-note%3Aself')).person,
      selfBefore.person,
      'relative history and clinician contact never modify Self',
    );
    for (const original of [clinical, people]) {
      const response = await page.request.get(url + original.intake.contentUrl);
      assert.equal(response.status(), 200, await response.text());
      assert.deepEqual(
        await response.body(),
        original.bytes,
        'original JSONL remains byte exact after review and acceptance',
      );
    }

    // The original click sends its displayed scope. Unrelated version-only
    // progress permits one exact-boundary retry of that same explicit action.
    const identityRow = envelope('fictional-linden-identity', 'Fictional Linden identity holdout', {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional Linden scoped result',
      valueText: '+02.00',
      unit: 'arb',
    });
    const identity = await upload([identityRow], 'fictional-linden-identity.jsonl');
    await page.goto(url + '/#/import');
    await page.reload();
    await page
      .getByText('This report identifies “Fictional Sol Linden”. Is it yours?', { exact: true })
      .waitFor();
    const identityFeed = await request<IntakeImportFeed>('/intakes/import-feed');
    const group = identityFeed.groups.find((item) => item.intakeId === identity.intake.id)!;
    const displayedScope = await request<IntakeIdentityScope>(
      `/intakes/${encodeURIComponent(identity.intake.id)}/identity-scope?groupId=${encodeURIComponent(group.groupId)}`,
    );
    const review = await request<IntakeReview>(
      `/intakes/${encodeURIComponent(identity.intake.id)}/review`,
    );
    await request(`/intakes/${encodeURIComponent(identity.intake.id)}/review-draft`, 'POST', {
      version: review.version,
      operationId: 'fictional-stale-displayed-scope',
      proposalId: null,
      recordId: review.records[0]!.id,
      candidateVersionId: review.records[0]!.candidateVersionId,
      disposition: 'pending',
    });
    const identityPosts: IntakeIdentityConfirmation[] = [];
    const captureIdentity = (request: Request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(`/intakes/${encodeURIComponent(identity.intake.id)}/identity-scope`)
      )
        identityPosts.push(request.postDataJSON() as IntakeIdentityConfirmation);
    };
    const firstIdentityResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    const confirmedIdentityResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/identity-scope') &&
        response.status() === 200,
    );
    page.on('request', captureIdentity);
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    const firstIdentity = await firstIdentityResponse;
    assert.equal(firstIdentity.status(), 409, await firstIdentity.text());
    assert.equal((await firstIdentity.json()).error.code, 'VERSION_CONFLICT');
    const confirmedIdentity = await confirmedIdentityResponse;
    assert.equal(confirmedIdentity.status(), 200, await confirmedIdentity.text());
    await until(
      () => request<IntakeReview>(`/intakes/${encodeURIComponent(identity.intake.id)}/review`),
      (value) => value.records[0]!.mapping.subject === 'self',
      'one explicit action confirmed after exact freshness validation',
    );
    page.off('request', captureIdentity);
    assert.equal(identityPosts.length, 2, 'one click produces only the original and bounded retry');
    assert.deepEqual(
      identityPosts[0]!.scope,
      displayedScope,
      'first send is exactly what was displayed',
    );
    assert.equal(identityPosts[0]!.attestation, 'confirmed_displayed_report_subject');
    assert.equal(identityPosts[1]!.operationId, identityPosts[0]!.operationId);
    const {
      intakeVersion: _oldVersion,
      scopeToken: _oldToken,
      ...originalBoundary
    } = displayedScope;
    const {
      intakeVersion: freshVersion,
      scopeToken: freshToken,
      ...freshBoundary
    } = identityPosts[1]!.scope;
    assert.deepEqual(freshBoundary, originalBoundary, 'no unseen identity evidence is confirmed');
    assert.equal(freshVersion, displayedScope.intakeVersion + 1);
    assert.notEqual(freshToken, displayedScope.scopeToken);
    assert.deepEqual(identityPosts[1], {
      ...identityPosts[0],
      version: freshVersion,
      scope: identityPosts[1]!.scope,
    });
    const confirmedIntake = await request<Intake>(
      `/intakes/${encodeURIComponent(identity.intake.id)}`,
    );
    assert.equal(confirmedIntake.workflow?.identityConfirmations?.length, 1);
    assert.equal(
      (await readFeed()).counts.accepted,
      4,
      'identity confirmation never implicitly accepts clinical results',
    );

    const questionPrompt = 'Does the printed patient Fictional Sol Linden identify you?';
    const questionAnchor = 'Patient: Fictional Sol Linden';
    const questionRows = ['first', 'second'].map((key) => ({
      ...envelope('fictional-explicit-subject-' + key, 'Fictional explicit subject report', {
        kind: 'observation',
        subject: 'unknown',
        testLabel: 'Fictional explicit subject result ' + key,
        valueText: '+03.00',
        unit: 'arb',
      }),
      reviewIssues: [
        { kind: 'identity', field: 'subject', prompt: questionPrompt, textAnchor: questionAnchor },
      ],
    }));
    const questionsOriginal = await upload(questionRows, 'fictional-explicit-subject.jsonl');
    await page.reload();
    await page.getByText(questionPrompt, { exact: true }).waitFor();
    assert.equal(
      await page.getByText(questionPrompt, { exact: true }).count(),
      1,
      'repeated exact identity question is displayed once for this report',
    );
    await page.getByText(questionAnchor, { exact: true }).waitFor();
    const questionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    const confirmedQuestions = await questionResponse;
    assert.equal(confirmedQuestions.status(), 200, await confirmedQuestions.text());
    const questionRequest = confirmedQuestions.request().postDataJSON() as {
      scope: IntakeIdentityScope;
      attestation: string;
    };
    assert.equal(questionRequest.attestation, 'confirmed_displayed_identity_questions');
    assert.deepEqual(questionRequest.scope.questions, [
      { prompt: questionPrompt, textAnchor: questionAnchor },
    ]);
    assert.equal(questionRequest.scope.targets.length, 2);
    assert.ok(questionRequest.scope.targets.every((target) => target.issueIds?.length === 2));
    const questionsReview = await request<IntakeReview>(
      `/intakes/${encodeURIComponent(questionsOriginal.intake.id)}/review`,
    );
    assert.ok(questionsReview.records.every((record) => record.mapping.subject === 'self'));
    assert.ok(
      questionsReview.records.every((record) =>
        record
          .issues!.filter((issue) => issue.kind === 'identity')
          .every((issue) => issue.status === 'resolved'),
      ),
    );
    assert.equal(
      (await readFeed()).counts.accepted,
      4,
      'explicit question confirmation does not accept either result',
    );

    const anonymous = envelope('fictional-anonymous-result', 'Fictional anonymous report', {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional anonymous measurement',
      valueText: '17.20',
      unit: 'arb',
      date: '2026-06-01',
    });
    anonymous.report!.subject = null;
    anonymous.payload =
      'Fictional anonymous report. A measurement of 17.20 arb. No printed patient.';
    const anonymousOriginal = await upload([anonymous], 'fictional-anonymous.jsonl');
    await page.reload();
    const anonymousCard = page.getByRole('region', { name: /Fictional anonymous report/ });
    await anonymousCard.getByRole('link', { name: 'Review report', exact: true }).click();
    await page
      .getByText('Identity is not printed clearly in this report.', { exact: true })
      .waitFor();
    const anonymousReview = await request<IntakeReview>(
      `/intakes/${encodeURIComponent(anonymousOriginal.intake.id)}/review`,
    );
    const anonymousRecordLink = page.locator('.import-detail-record-link').filter({
      hasText: 'Fictional anonymous measurement',
    });
    await anonymousRecordLink.waitFor();
    assert.match(
      (await anonymousRecordLink.getAttribute('href')) || '',
      new RegExp(`record=${encodeURIComponent(anonymousReview.records[0]!.id)}`),
    );
    await anonymousRecordLink.click();
    assert.equal(
      new URLSearchParams(page.url().split('?')[1]).get('record'),
      anonymousReview.records[0]!.id,
      'the warning report exposes an exact record link without selecting a replacement',
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    await until(
      () =>
        request<IntakeReview>(`/intakes/${encodeURIComponent(anonymousOriginal.intake.id)}/review`),
      (value) => value.records[0]!.mapping.subject === 'self',
      'individual identity decision is retained',
    );
    await page.getByRole('button', { name: 'Back to Import', exact: true }).click();
    await page.getByRole('heading', { name: 'Review reports', exact: true }).waitFor();
    assert.ok(page.url().endsWith('/import'), 'secondary review returns to the new inbox');
    assert.equal((await readFeed()).counts.accepted, 4, 'returning does not accept the result');
  },
);
