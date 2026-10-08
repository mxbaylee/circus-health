import { launchBrowser, newTestPage } from './harness.ts';
import { sameDisplayedIdentityReview } from '../../app/data/identity-confirmation-freshness.ts';
import { startProcessRuntime } from './process-runtime.ts';
import {
  fixtureBrowserResponse,
  fixtureNativeFeedReady,
  fixtureNativeReportReady,
} from './native-intake-fixture.ts';
import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Browser, type Request } from 'playwright';
import type { Medication, Note, Observation, Procedure } from '../../shared/api.ts';
import type {
  HealthRecordEnvelope,
  IntakeReviewRecord,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake.ts';
import type { IntakePersonApplyRequest } from '../../shared/intake-people.ts';
import type { IntakeSummaryV2 } from '../../shared/intake-summary.ts';
import type {
  CollectionImportFeed,
  CollectionPeoplePage,
  CollectionReportDetail,
} from '../../shared/intake-clinical-pages.ts';
import type { IntakeClinicalReviewPage } from '../../shared/intake-clinical-review.ts';
import type { SourceAttentionQueue } from '../../shared/intake-source-text.ts';
import type {
  IntakeIdentityConfirmation,
  IntakeIdentityReview,
  IntakeIdentityScope,
  IntakeIdentityScopePage,
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
  { timeout: 600000 },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'circus-import-feed-holdout-'));
    mkdirSync(resolve(root, 'data'));
    const runtimeDirectory = createTestRuntimeDirectory();
    const runtime = await startProcessRuntime(t, {
      dataDirectory: resolve(root, 'data'),
      runtimeDirectory,
      codeRoot: process.env.CRS_TEST_CODE_ROOT,
      port: 0,
      host: '127.0.0.1',
    });
    const captureRuntimeDiagnostics = runtime.captureDiagnostics();
    let phase = 'browser setup';
    let phaseStarted = Date.now();
    let requestNumber = 0;
    const inFlight = new Map<number, { method: string; path: string; started: number }>();
    const enterPhase = (name: string) => {
      phase = name;
      phaseStarted = Date.now();
    };
    const diagnosticPath = (path: string) =>
      path
        .split('?')[0]!
        .split('/')
        .map((part) => (/%3A|^[0-9a-f-]{20,}$/i.test(part) ? ':id' : part))
        .join('/');
    t.signal.addEventListener(
      'abort',
      () =>
        console.error('Fictional holdout interrupted', {
          phase,
          phaseDurationMs: Date.now() - phaseStarted,
          inFlight: [...inFlight.values()].map((request) => ({
            method: request.method,
            path: request.path,
            durationMs: Date.now() - request.started,
          })),
        }),
      { once: true },
    );
    let browser: Browser | undefined;
    t.after(async () => {
      if (process.env.CRS_TEST_DIAGNOSTICS)
        console.error('Fictional holdout runtime:', await captureRuntimeDiagnostics());
      await browser?.close();
      await runtime.close();
      rmSync(runtimeDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    browser = await launchBrowser(t);
    const page = await newTestPage(browser, { viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) =>
      console.error('Fictional holdout browser error:', error.message),
    );
    async function captureControls(stage: string) {
      if (!process.env.CRS_TEST_SCREENSHOTS) return;
      mkdirSync(process.env.CRS_TEST_SCREENSHOTS, { recursive: true });
      const viewport = page.viewportSize();
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          'Import controls do not overflow the viewport',
        );
        if (await page.getByRole('dialog').count()) {
          const rect = await page.getByRole('dialog').evaluate((element) => {
            const box = element.getBoundingClientRect();
            return { top: box.top, height: box.height, width: box.width };
          });
          assert.ok(
            Math.abs(rect.top) < 1 && Math.abs(rect.height - 1000) < 1,
            'Sidebar occupies the viewport height from its top',
          );
          if (width === 390)
            assert.ok(Math.abs(rect.width - 390) < 1, 'Mobile sidebar uses the available width');
        }
        await page.screenshot({
          path: resolve(process.env.CRS_TEST_SCREENSHOTS, `${stage}-${width}.png`),
          fullPage: (await page.getByRole('dialog').count()) === 0,
          animations: 'disabled',
        });
      }
      if (viewport) await page.setViewportSize(viewport);
    }
    const url = `http://127.0.0.1:${runtime.port}`;
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
    enterPhase('upload and initial Import feed');
    async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const started = Date.now();
      const requestId = ++requestNumber;
      inFlight.set(requestId, { method, path: diagnosticPath(path), started });
      const captureRequestDiagnostics = process.env.CRS_TEST_DIAGNOSTICS
        ? runtime.captureDiagnostics()
        : undefined;
      try {
        let response;
        try {
          response = await page.request.fetch(url + prefix + path, {
            method,
            headers: method === 'GET' ? undefined : { Origin: url },
            data: body,
          });
        } catch (error) {
          if (captureRequestDiagnostics)
            console.error(
              'Fictional holdout failed request',
              diagnosticPath(path),
              await captureRequestDiagnostics(),
            );
          throw error;
        }
        if (process.env.CRS_TEST_DIAGNOSTICS)
          console.error(
            'Fixture request',
            diagnosticPath(path),
            Date.now() - started,
            response.status(),
          );
        const json = await response.json();
        assert.ok(response.ok(), JSON.stringify(json));
        return json.data as T;
      } finally {
        inFlight.delete(requestId);
      }
    }
    async function upload(rows: HealthRecordEnvelope[], filename: string) {
      const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const response = await page.request.post(url + prefix + '/intakes', {
        headers: { Origin: url, 'Content-Type': 'application/x-ndjson', 'X-Filename': filename },
        data: bytes,
      });
      assert.equal(response.status(), 201, await response.text());
      return { intake: (await response.json()).data as IntakeSummaryV2, bytes };
    }
    async function readIdentityTargets(scope: IntakeIdentityConfirmation['scope']) {
      if (!('format' in scope)) return scope.targets;
      const targets: IntakeIdentityScope['targets'] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({
          groupId: scope.groupId,
          scopeToken: scope.scopeToken,
          section: 'targets',
          limit: '20',
        });
        if (cursor) query.set('cursor', cursor);
        const page: IntakeIdentityScopePage = await request<IntakeIdentityScopePage>(
          `/intakes/${encodeURIComponent(scope.intakeId)}/identity-scope-page?${query}`,
        );
        assert.equal(page.scopeToken, scope.scopeToken);
        assert.equal(page.total, scope.collection.targets);
        for (const item of page.items) {
          assert.equal(item.kind, 'value', 'controlled fictional targets fit a bounded page');
          if (item.kind === 'value')
            targets.push(item.value as IntakeIdentityScope['targets'][number]);
        }
        assert.notEqual(page.nextCursor, cursor || undefined, 'identity target pages advance');
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(targets.length, scope.collection.targets);
      return targets;
    }
    const clinical = await upload(clinicalRows, 'fictional-linden-clinical.jsonl');
    const people = await upload([peopleOnly], 'fictional-linden-people.jsonl');
    const selfBefore = await request<Note>('/notes/person-note%3Aself');
    const readFeed = () =>
      request<CollectionImportFeed>('/intakes/import-feed?view=all&limit=40&bytes=65536');
    const feedRecords = (feed: CollectionImportFeed) => {
      assert.equal(
        feed.nextCursor,
        null,
        'the controlled five-record fixture fits one bounded page',
      );
      return feed.records.map((row) => {
        assert.equal(row.detail.kind, 'record');
        if (row.detail.kind !== 'record') throw new Error('Unexpected fictional record reference');
        return row.detail.record;
      });
    };
    async function readReview(intakeId: string) {
      const page = await request<IntakeClinicalReviewPage>(
        `/intakes/${encodeURIComponent(intakeId)}/review?limit=40&bytes=65536`,
      );
      assert.equal(page.format, 'health-intake-clinical-review-page-v2');
      assert.equal(
        page.nextCursor,
        null,
        'controlled review fixture fits one complete bounded page',
      );
      const records = page.items.map((item) => {
        assert.equal(item.kind, 'value');
        if (item.kind !== 'value') throw new Error('Unexpected fictional record reference');
        return item.value as IntakeReviewRecord;
      });
      assert.equal(records.length, page.total);
      return { version: page.version, records };
    }
    async function groupFor(intakeId: string, title?: string) {
      let cursor: string | null = null;
      const visited = new Set<string>();
      const groups = new Set<string>();
      do {
        const query = new URLSearchParams({ view: 'all', limit: '40', bytes: '65536' });
        if (cursor) query.set('cursor', cursor);
        const feed = await request<CollectionImportFeed>('/intakes/import-feed?' + query);
        const matches = feed.groups.filter((group) => group.intakeId === intakeId);
        for (const ref of matches) {
          if (groups.has(ref.groupId)) continue;
          groups.add(ref.groupId);
          const detail = await request<CollectionReportDetail>(
            `/intakes/report-queue/${encodeURIComponent(ref.groupId)}?intakeId=${encodeURIComponent(intakeId)}&view=all&limit=40&bytes=65536`,
          );
          if (!title || detail.group.title === title) return detail.group;
        }
        const nextCursor = feed.nextCursor;
        if (nextCursor !== null && (nextCursor === cursor || visited.has(nextCursor)))
          throw new Error('Exact fictional report lookup cursor did not advance');
        if (nextCursor !== null) visited.add(nextCursor);
        cursor = nextCursor;
      } while (cursor !== null);
      throw new Error('Missing exact fictional report ' + title);
    }
    const displayedIdentityReviews = new Map<string, IntakeIdentityReview>();
    async function openReport(
      intakeId: string,
      title?: string,
      identityExpectation: 'scoped' | 'missing_identity' = 'scoped',
    ) {
      const group = await groupFor(intakeId, title);
      // Open one fresh document after fixture writes, without also preparing
      // the same report in the document immediately discarded by a reload.
      await page.goto('about:blank');
      const identityReady = fixtureBrowserResponse(page, (response) => {
        const selected = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          selected.pathname ===
            prefix + '/intakes/' + encodeURIComponent(intakeId) + '/identity-review' &&
          selected.searchParams.get('groupId') === group.groupId
        );
      });
      const detail = await fixtureNativeReportReady(
        page,
        prefix,
        { intakeId, groupId: group.groupId },
        () =>
          page.goto(
            url + '/#/import?' + new URLSearchParams({ intake: intakeId, group: group.groupId }),
          ),
      );
      assert.equal(detail.format, 'health-intake-report-detail-v2');
      assert.equal(detail.group.intakeId, intakeId);
      assert.equal(detail.group.groupId, group.groupId);
      assert.equal(detail.group.title, group.title);
      // The first report page can precede the real retained-original identity
      // check. Keep the UI deadline for rendering its completed response.
      const identityResponse = await identityReady;
      assert.equal(identityResponse.status(), 200, await identityResponse.text());
      assert.equal(await identityResponse.finished(), null);
      const identity = (await identityResponse.json()).data as IntakeIdentityReview;
      displayedIdentityReviews.set(group.groupId, identity);
      const identityScope = identity.scopeReference || identity.scope;
      if (identityExpectation === 'missing_identity') {
        // This explicitly anonymous fixture offers individual record review,
        // not common confirmation of an invented printed report subject.
        // The exact request URL/group and report detail remain checked above.
        assert.equal(identity.scope, null);
        assert.equal(identity.scopeReference, undefined);
        assert.equal(identity.scopeFragmentReference, undefined);
        assert.equal(identity.status, 'missing_warning');
        assert.equal(identity.blocking, false);
        assert.deepEqual(identity.evidencedIdentity, {});
        assert.deepEqual(identity.offeredSelfFields, {});
        assert.deepEqual(identity.conflicts, []);
      } else {
        assert.equal(identityScope?.intakeId, intakeId);
        assert.equal(identityScope?.groupId, group.groupId);
      }
      try {
        await page.getByRole('heading', { name: String(group.title), exact: true }).waitFor();
      } catch (cause) {
        throw new Error(`Exact report did not open: ${await page.locator('body').innerText()}`, {
          cause,
        });
      }
      return group;
    }
    async function readPeople() {
      const result = await request<CollectionPeoplePage>(
        `/intakes/people/${encodeURIComponent(initial.people.groups[0]!.groupId)}?intakeId=${encodeURIComponent(people.intake.id)}&view=all&limit=40&bytes=65536`,
      );
      assert.equal(result.nextCursor, null);
      const values = result.people.map((item) => {
        assert.equal(item.kind, 'person');
        if (item.kind !== 'person') throw new Error('Unexpected fictional Person reference');
        return item.person;
      });
      assert.equal(values.length, result.totalPeople);
      return { people: values };
    }
    const initial = await readFeed();
    assert.equal(initial.counts.pending, 5);
    assert.equal(initial.counts.blocked, 5, 'every printed-subject clinical row awaits review');
    assert.equal(
      initial.counts.questions,
      11,
      'five identity prompts, five saved-name conflicts, and one uncertain reading',
    );
    const initialClinicalRecords = feedRecords(initial);
    assert.equal(initialClinicalRecords.length, 5);
    assert.equal(
      initialClinicalRecords.filter((record) => record.selectable).length,
      0,
      'no printed-subject clinical record is selectable before identity review',
    );
    for (const record of initialClinicalRecords) {
      assert.equal(record.identityReview?.status, 'conflict');
      assert.equal(record.identityReview?.blocking, true);
      assert.equal(
        record.issues?.filter(
          (issue) => issue.kind === 'identity' && issue.blocking && issue.status === 'unresolved',
        ).length,
        2,
      );
      assert.deepEqual(
        record.issues
          ?.filter((issue) => issue.blocking && issue.status === 'unresolved')
          .map((issue) => issue.kind)
          .sort(),
        record.title === 'Fictional Linden unclear result'
          ? ['identity', 'identity', 'uncertain_reading']
          : ['identity', 'identity'],
      );
    }
    assert.equal(initial.people.counts.pending, 2);
    assert.equal(initial.groups.length, 2, 'two clinical reports share one retained original');
    assert.equal(initial.people.groups.length, 1, 'People-only report has independent discovery');

    const laboratoryGroup = await openReport(
      clinical.intake.id,
      'Fictional Linden laboratory report',
    );
    const identityPanel = page.getByRole('region', { name: 'Report identity', exact: true });
    await identityPanel.getByText(/This report identifies “Fictional Sol Linden”/).waitFor();
    await captureControls('import-person-pending');
    await captureControls('import-person-sidebar');
    const initialIdentityPosts: IntakeIdentityConfirmation[] = [];
    const captureInitialIdentity = (request: Request) => {
      if (request.method() === 'POST' && request.url().endsWith('/identity-scope'))
        initialIdentityPosts.push(request.postDataJSON() as IntakeIdentityConfirmation);
    };
    page.on('request', captureInitialIdentity);
    const initialLaboratoryScope = await request<IntakeIdentityConfirmation['scope']>(
      `/intakes/${encodeURIComponent(clinical.intake.id)}/identity-scope?groupId=${encodeURIComponent(laboratoryGroup.groupId)}`,
    );
    const initialLaboratoryTargets = await readIdentityTargets(initialLaboratoryScope);
    const initialIdentityResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    await page
      .getByRole('region', { name: 'Report identity', exact: true })
      .getByLabel('Name printed on this report')
      .fill('Fictional Sol Linden');
    await identityPanel.getByRole('button', { name: 'This is me', exact: true }).click();
    const initialIdentity = await initialIdentityResponse;
    assert.equal(initialIdentity.status(), 200, await initialIdentity.text());
    const initialIdentityRequest = initialIdentity
      .request()
      .postDataJSON() as IntakeIdentityConfirmation;
    assert.equal(initialIdentityRequest.attestation, 'confirmed_displayed_identity_questions');
    assert.equal(initialIdentityRequest.scope.groupId, laboratoryGroup.groupId);
    assert.deepEqual(
      initialIdentityRequest.scope,
      initialLaboratoryScope,
      'confirmation binds the exact displayed target scope',
    );
    assert.deepEqual(initialLaboratoryTargets.map((target) => target.title).sort(), [
      'Fictional Linden copper',
      'Fictional Linden unclear result',
    ]);
    // JSONL repeats report headings in payload and metadata. It does not establish
    // one unambiguous original patient header, so each report needs its own choice.
    const laboratoryReady = await readFeed();
    enterPhase('second report identity confirmation');
    assert.equal(laboratoryReady.counts.blocked, 4);
    const visitGroup = await openReport(clinical.intake.id, 'Fictional Linden visit report');
    await page
      .getByRole('region', { name: 'Report identity', exact: true })
      .getByLabel('Name printed on this report')
      .fill('Fictional Sol Linden');
    const initialVisitScope = await request<IntakeIdentityConfirmation['scope']>(
      `/intakes/${encodeURIComponent(clinical.intake.id)}/identity-scope?groupId=${encodeURIComponent(visitGroup.groupId)}`,
    );
    const initialVisitTargets = await readIdentityTargets(initialVisitScope);
    const visitIdentityResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    await identityPanel.getByRole('button', { name: 'This is me', exact: true }).click();
    const visitIdentity = await visitIdentityResponse;
    assert.equal(visitIdentity.status(), 200, await visitIdentity.text());
    const identityReady = await until(
      readFeed,
      (value) => value.counts.blocked === 1,
      'two report confirmations to leave only the uncertain reading blocked',
    );
    enterPhase('source inspection and Later selection');
    page.off('request', captureInitialIdentity);
    assert.equal(
      initialIdentityPosts.length,
      2,
      'each report confirmation records exactly one identity operation',
    );
    assert.deepEqual(initialIdentityPosts[0], initialIdentityRequest);
    assert.equal(initialIdentityPosts[1]!.scope.groupId, visitGroup.groupId);
    assert.deepEqual(initialIdentityPosts[1]!.scope, initialVisitScope);
    assert.equal(initialVisitTargets.length, 3);
    assert.equal(identityReady.counts.pending, 5);
    assert.equal(identityReady.counts.accepted, 0, 'identity confirmation does not accept records');
    assert.equal(identityReady.counts.questions, 1);
    const selfAfterIdentity = await request<Note>('/notes/person-note%3Aself');
    assert.equal(selfAfterIdentity.person.fullName, selfBefore.person.fullName);
    assert.equal(selfAfterIdentity.person.birthDate, selfBefore.person.birthDate);
    assert.deepEqual(selfAfterIdentity.person.knownNames, ['Fictional Sol Linden']);
    assert.equal(selfAfterIdentity.person.sourceKnownNames?.[0]?.name, 'Fictional Sol Linden');
    const identityReadyRecords = feedRecords(identityReady);
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
      'both reports retain their explicit printed-person confirmations',
    );
    await page.goto('about:blank');
    await fixtureNativeFeedReady(page, prefix, () => page.goto(url + '/#/import'));
    const sourceAttention = await request<SourceAttentionQueue>('/intakes/source-attention');
    assert.equal(
      sourceAttention.sections,
      2,
      'two retained originals have source sections to inspect',
    );
    assert.deepEqual(
      sourceAttention.items.map((item) => item.intakeId).sort(),
      [clinical.intake.id, people.intake.id].sort(),
    );
    // Source inspection remains separate from the five clinical and two People rows.
    await captureControls('import-person-confirmed');
    await until(
      () => page.locator('.import-record').count(),
      (count) => count === 7,
      'seven clinical and People rows',
    );
    await page.getByLabel('Select all shown', { exact: true }).check();
    await page.getByRole('button', { name: 'Later 7', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^7 selected items updated\.$/ })
      .waitFor({ timeout: 0 });
    const deferred = await until(
      readFeed,
      (value) => value.counts.deferred === 5 && value.people.counts.later === 2,
      'all seven explicitly selected rows deferred',
    );
    enterPhase('clinical acceptance and receipt recovery');
    assert.equal(deferred.counts.pending, 0);
    assert.equal(deferred.counts.blocked, 1);
    assert.equal(
      (await request<CollectionImportFeed>('/intakes/import-feed?view=all&edited=true'))
        .totalRecords,
      0,
      'Later snapshots are not manual clinical edits',
    );
    await page.getByRole('combobox', { name: 'Review status' }).selectOption('later');
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
      const response = await route.fetch({ timeout: 180000 });
      if (!lostAcknowledgement && response.ok()) {
        lostAcknowledgement = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByLabel('Select all shown', { exact: true }).check();
    await page.getByRole('button', { name: 'Save 4 records', exact: true }).click();
    await page
      .getByText('A save has not been confirmed yet. Check its status before retrying.', {
        exact: true,
      })
      .waitFor({ timeout: 0 });
    const clinicalSaved = await until(
      readFeed,
      (value) => value.counts.accepted === 4,
      'four clinical records committed despite the lost acknowledgement',
    );
    enterPhase('People apply and definite failure');
    assert.equal(clinicalSaved.people.counts.saved, 0, 'clinical save has its own honest count');
    assert.equal(clinicalSaved.people.counts.later, 2);
    await page.getByRole('button', { name: 'Check save status', exact: true }).waitFor();
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
    enterPhase('second Person failure feedback');
    await page
      .getByText('The second fictional Person changed before saving.', { exact: true })
      .waitFor({ timeout: 0 });
    enterPhase('first Person durable result');
    const partiallySaved = await until(
      readFeed,
      (value) => value.people.counts.saved === 1 && value.people.counts.later === 1,
      'first Person saved before the second definite failure',
    );
    assert.equal(partiallySaved.counts.accepted, 4);
    const savedAfterFailure = await readPeople();
    const firstSavedPerson = savedAfterFailure.people.find((person) => person.state === 'saved')!;
    assert.ok(firstSavedPerson.saved, 'the first successful Apply has a durable destination');
    const justSavedPeople = page.getByRole('region', { name: 'Just saved People' });
    const firstDestination = justSavedPeople.getByRole('link', {
      name: new RegExp(firstSavedPerson.person.fullName),
    });
    await firstDestination.waitFor();
    assert.equal(await firstDestination.getAttribute('href'), firstSavedPerson.saved.resultUrl);
    enterPhase('retry second Person');
    await page.getByRole('button', { name: 'Add 1 person', exact: true }).click();
    await page
      .getByRole('status')
      .filter({ hasText: /^1 selected item updated\.$/ })
      .waitFor({ timeout: 0 });
    const saved = await until(
      readFeed,
      (value) => value.counts.accepted === 4 && value.people.counts.saved === 2,
      'four clinical records and two separate People saved',
    );
    enterPhase('saved destination verification');
    assert.equal(await justSavedPeople.getByRole('link').count(), 2);
    assert.equal(
      await firstDestination.getAttribute('href'),
      firstSavedPerson.saved.resultUrl,
      'the first confirmed destination remains available after retrying the second Person',
    );
    const savedPeople = await readPeople();
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
    await until(
      () => page.locator('.import-record-destination [data-saved-person-id]').count(),
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
    const peopleQueue = await readPeople();
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
      selfAfterIdentity.person,
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
    enterPhase('identity freshness retry');

    // The original click sends its displayed scope. Unrelated version-only
    // progress permits one exact-boundary retry of that same explicit action.
    const identityRow = envelope('fictional-linden-identity', 'Fictional Linden identity holdout', {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional Linden scoped result',
      valueText: '+02.00',
      unit: 'arb',
    });
    const matchedOriginal = await upload([identityRow], 'fictional-linden-alias-match.jsonl');
    const matchedGroup = await groupFor(matchedOriginal.intake.id);
    const matchedIdentity = await request<IntakeIdentityReview>(
      `/intakes/${encodeURIComponent(matchedOriginal.intake.id)}/identity-review?groupId=${encodeURIComponent(matchedGroup.groupId)}`,
    );
    assert.equal(matchedIdentity.status, 'confirmation_required');
    assert.equal(matchedIdentity.blocking, true);
    assert.equal(matchedIdentity.evidencedIdentity.fullName, undefined);
    assert.equal(matchedIdentity.confirmationCount, 0);
    // Neither a remembered spelling nor a new alias can replace original
    // patient grounding; this report also requires an explicit choice.
    identityRow.report!.subject!.text = 'Fictional Sol Birch';
    identityRow.payload = String(identityRow.payload).replaceAll(
      'Fictional Sol Linden',
      'Fictional Sol Birch',
    );
    const identity = await upload([identityRow], 'fictional-linden-identity.jsonl');
    await openReport(identity.intake.id);
    await identityPanel.getByText(/This report identifies “Fictional Sol Birch”/).waitFor();
    await identityPanel.getByLabel('Name printed on this report').fill('Fictional Sol Birch');
    const group = await groupFor(identity.intake.id);
    const displayedIdentityReview = displayedIdentityReviews.get(group.groupId)!;
    const displayedScope = await request<IntakeIdentityConfirmation['scope']>(
      `/intakes/${encodeURIComponent(identity.intake.id)}/identity-scope?groupId=${encodeURIComponent(group.groupId)}`,
    );
    const review = await readReview(identity.intake.id);
    await request(`/intakes/${encodeURIComponent(identity.intake.id)}/review-draft`, 'POST', {
      version: review.version,
      operationId: 'fictional-stale-displayed-scope',
      proposalId: null,
      recordId: review.records[0]!.id,
      candidateVersionId: review.records[0]!.candidateVersionId,
      disposition: 'pending',
    });
    let identityEventSequence = 0;
    let firstConflictResponseSequence: number | undefined;
    const identityRequestSequences = new WeakMap<Request, number>();
    const recordIdentityRequest = (request: Request) => {
      const path = new URL(request.url()).pathname;
      const base = `${prefix}/intakes/${encodeURIComponent(identity.intake.id)}`;
      if (path === base + '/identity-scope' || path === base + '/identity-review')
        identityRequestSequences.set(request, ++identityEventSequence);
    };
    const recordIdentityResponse = (response: import('playwright').Response) => {
      if (
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `${prefix}/intakes/${encodeURIComponent(identity.intake.id)}/identity-scope` &&
        response.status() === 409 &&
        firstConflictResponseSequence === undefined
      )
        firstConflictResponseSequence = ++identityEventSequence;
    };
    page.on('request', recordIdentityRequest);
    page.on('response', recordIdentityResponse);
    const freshIdentityReviewResponse = fixtureBrowserResponse(page, (response) => {
      const target = new URL(response.url());
      return (
        response.request().method() === 'GET' &&
        target.pathname ===
          `${prefix}/intakes/${encodeURIComponent(identity.intake.id)}/identity-review` &&
        target.searchParams.get('groupId') === group.groupId &&
        firstConflictResponseSequence !== undefined &&
        (identityRequestSequences.get(response.request()) || 0) > firstConflictResponseSequence
      );
    });
    const identityPosts: IntakeIdentityConfirmation[] = [];
    const captureIdentity = (request: Request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith(`/intakes/${encodeURIComponent(identity.intake.id)}/identity-scope`)
      )
        identityPosts.push(request.postDataJSON() as IntakeIdentityConfirmation);
    };
    const firstIdentityResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    const confirmedIdentityResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/identity-scope') &&
        response.status() === 200,
    );
    page.on('request', captureIdentity);
    await identityPanel.getByRole('button', { name: 'This is me', exact: true }).click();
    const firstIdentity = await firstIdentityResponse;
    assert.equal(firstIdentity.status(), 409, await firstIdentity.text());
    assert.equal((await firstIdentity.json()).error.code, 'VERSION_CONFLICT');
    const freshIdentityReviewResponseValue = await freshIdentityReviewResponse;
    assert.equal(freshIdentityReviewResponseValue.status(), 200);
    assert.ok(
      firstConflictResponseSequence !== undefined,
      'the real first409 response precedes freshness reload',
    );
    assert.ok(
      (identityRequestSequences.get(freshIdentityReviewResponseValue.request()) || 0) >
        firstConflictResponseSequence,
      'fresh review request starts after the actual409 response',
    );
    const freshIdentityReview = (await freshIdentityReviewResponseValue.json())
      .data as IntakeIdentityReview;
    const confirmedIdentity = await confirmedIdentityResponse;
    assert.equal(confirmedIdentity.status(), 200, await confirmedIdentity.text());
    await until(
      () => readReview(identity.intake.id),
      (value) => value.records[0]!.mapping.subject === 'self',
      'one explicit action confirmed after exact freshness validation',
    );
    page.off('request', captureIdentity);
    page.off('request', recordIdentityRequest);
    page.off('response', recordIdentityResponse);
    assert.equal(identityPosts.length, 2, 'one click produces only the original and bounded retry');
    assert.deepEqual(
      identityPosts[0]!.scope,
      displayedScope,
      'first send is exactly what was displayed',
    );
    assert.equal(identityPosts[0]!.attestation, 'confirmed_displayed_identity_questions');
    assert.equal(identityPosts[1]!.operationId, identityPosts[0]!.operationId);
    const retryScope = identityPosts[1]!.scope;
    assert.ok(
      'collection' in displayedScope,
      'this fixture selects a native complete displayed scope',
    );
    assert.ok('collection' in retryScope, 'retry retains the native complete scope protocol');
    assert.deepEqual(
      displayedIdentityReview.scopeReference || displayedIdentityReview.scope,
      displayedScope,
      'commitment belongs to the real displayed scope',
    );
    assert.deepEqual(
      freshIdentityReview.scopeReference || freshIdentityReview.scope,
      retryScope,
      'retry sends the real freshly reviewed scope',
    );
    assert.equal(
      displayedIdentityReview.evidenceCommitment?.format,
      'health-intake-identity-evidence-v1',
    );
    assert.match(displayedIdentityReview.evidenceCommitment!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      freshIdentityReview.evidenceCommitment?.format,
      'health-intake-identity-evidence-v1',
    );
    assert.match(freshIdentityReview.evidenceCommitment!.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      freshIdentityReview.evidenceCommitment,
      displayedIdentityReview.evidenceCommitment,
      'complete native evidence and ordered warnings are unchanged',
    );
    assert.equal(
      sameDisplayedIdentityReview(displayedIdentityReview, freshIdentityReview),
      true,
      'real complete server reviews qualify the native client freshness policy',
    );
    assert.equal(displayedScope.collection.snapshotId, 'identity:' + displayedScope.scopeToken);
    assert.equal(retryScope.collection.snapshotId, 'identity:' + retryScope.scopeToken);
    assert.notEqual(
      retryScope.collection.snapshotId,
      displayedScope.collection.snapshotId,
      'native storage snapshots remain version-bound',
    );
    const {
      intakeVersion: _oldVersion,
      scopeToken: _oldToken,
      collection: { snapshotId: _oldSnapshotId, ...originalCollection },
      ...originalFields
    } = displayedScope;
    const {
      intakeVersion: freshVersion,
      scopeToken: freshToken,
      collection: { snapshotId: _freshSnapshotId, ...freshCollection },
      ...freshFields
    } = retryScope;
    const originalBoundary = { ...originalFields, collection: originalCollection };
    const freshBoundary = { ...freshFields, collection: freshCollection };
    assert.deepEqual(freshBoundary, originalBoundary, 'no unseen identity evidence is confirmed');
    assert.equal(freshVersion, displayedScope.intakeVersion + 1);
    assert.notEqual(freshToken, displayedScope.scopeToken);
    assert.deepEqual(identityPosts[1], {
      ...identityPosts[0],
      version: freshVersion,
      scope: identityPosts[1]!.scope,
    });
    const confirmedReview = await request<IntakeIdentityReview>(
      `/intakes/${encodeURIComponent(identity.intake.id)}/identity-review?groupId=${encodeURIComponent(group.groupId)}`,
    );
    assert.equal(confirmedReview.confirmationCount, 1);
    assert.equal(
      (await readFeed()).counts.accepted,
      4,
      'identity confirmation never implicitly accepts clinical results',
    );
    enterPhase('shared report identity question');

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
    const questionsGroup = await openReport(questionsOriginal.intake.id);
    const questionScope = await request<IntakeIdentityConfirmation['scope']>(
      `/intakes/${encodeURIComponent(questionsOriginal.intake.id)}/identity-scope?groupId=${encodeURIComponent(questionsGroup.groupId)}`,
    );
    const questionTargets = await readIdentityTargets(questionScope);
    const questionEvidence = await request<IntakeIdentityScopePage>(
      `/intakes/${encodeURIComponent(questionsOriginal.intake.id)}/identity-scope-page?${new URLSearchParams({ groupId: questionsGroup.groupId, scopeToken: questionScope.scopeToken, section: 'questions', limit: '20' })}`,
    );
    assert.equal(questionEvidence.nextCursor, null);
    await page.getByText(questionPrompt, { exact: true }).waitFor();
    assert.equal(
      await page.getByText(questionPrompt, { exact: true }).count(),
      1,
      'repeated exact identity question is displayed once for this report',
    );
    await page.getByText(questionAnchor, { exact: true }).waitFor();
    await page
      .getByRole('region', { name: 'Report identity', exact: true })
      .getByLabel('Name printed on this report')
      .fill('Fictional Sol Linden');
    const questionResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/identity-scope'),
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    const confirmedQuestions = await questionResponse;
    assert.equal(confirmedQuestions.status(), 200, await confirmedQuestions.text());
    const questionRequest = confirmedQuestions
      .request()
      .postDataJSON() as IntakeIdentityConfirmation;
    assert.equal(questionRequest.attestation, 'confirmed_displayed_identity_questions');
    assert.deepEqual(questionRequest.scope, questionScope);
    assert.deepEqual(
      questionEvidence.items.map((item) => {
        assert.equal(item.kind, 'value');
        return item.kind === 'value' ? item.value : null;
      }),
      [{ prompt: questionPrompt, textAnchor: questionAnchor }],
    );
    assert.equal(questionTargets.length, 2);
    assert.ok(questionTargets.every((target) => target.issueIds?.length === 2));
    const questionsReview = await readReview(questionsOriginal.intake.id);
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
    await openReport(anonymousOriginal.intake.id, undefined, 'missing_identity');
    await page
      .getByText('Identity is not printed clearly in this report.', { exact: true })
      .waitFor();
    const anonymousReview = await readReview(anonymousOriginal.intake.id);
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
    const anonymousDecisionResponse = fixtureBrowserResponse(
      page,
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `${prefix}/intakes/${encodeURIComponent(anonymousOriginal.intake.id)}/review-draft`,
    );
    await page.getByRole('button', { name: 'This is me', exact: true }).click();
    await anonymousDecisionResponse;
    enterPhase('individual identity return to Import');
    await until(
      () => readReview(anonymousOriginal.intake.id),
      (value) => value.records[0]!.mapping.subject === 'self',
      'individual identity decision is retained',
    );
    await fixtureNativeFeedReady(page, prefix, () =>
      page.getByRole('button', { name: 'Back to Import', exact: true }).click(),
    );
    await page.getByRole('heading', { name: 'Review reports', exact: true }).waitFor();
    assert.ok(page.url().endsWith('/import'), 'secondary review returns to the new inbox');
    assert.equal((await readFeed()).counts.accepted, 4, 'returning does not accept the result');
  },
);
