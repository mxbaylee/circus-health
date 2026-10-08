import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type {
  Intake,
  IntakeImportFeed,
  IntakeReportAcceptanceResult,
  IntakeReportQueueDetail,
  IntakeReportQueueRecord,
  IntakeReportSourceReview,
  IntakeReview,
} from '../../shared/intake';
import type { IntakeIdentityReview } from '../../shared/intake-identity';
import type {
  CollectionReportDetail,
  CollectionImportFeed,
} from '../../shared/intake-clinical-pages';
import type {
  ClinicalRecordAction,
  ClinicalRecordSectionPage,
} from '../../shared/intake-clinical-record-sections';
import {
  ImportDetailReview,
  ImportRecordDetail,
} from '../../app/features/import/ImportDetailReview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { ImportPage } from '../../app/features/import/ImportPage';

vi.mock('../../app/components/SourceDialog', () => ({
  SourcePreview: () => <div>Retained original preview</div>,
}));

async function openPersonContext() {
  fireEvent.click(await screen.findByRole('button', { name: /person for this report/ }));
}

async function openSourceContext() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change source for this report' }));
}

const intake = {
  id: 'fictional-intake',
  version: 7,
  filename: 'fictional-labs.pdf',
  mimeType: 'application/pdf',
  providerId: 'fictional-provider',
  provider: 'Juniper Clinic',
  sha256: 'fictional-sha256',
  bytes: 1200,
  contentUrl: '/api/sources/fictional-intake/content',
} as Intake;

const record: IntakeReportQueueRecord = {
  id: 'fictional-record',
  classification: 'addition' as const,
  kind: 'observation' as const,
  title: 'Ferritin',
  date: '2026-04-12',
  provider: 'Juniper Clinic',
  candidateId: 'fictional-candidate',
  candidateVersionId: 'fictional-candidate-v1',
  reviewState: 'pending' as const,
  confidence: 0.98,
  uncertainties: [],
  evidence: [
    {
      label: 'Page 1',
      locator: 'page 1, laboratory table',
      contentUrl: '/api/sources/fictional-intake/content#page=1',
    },
  ],
  mapping: {
    kind: 'observation' as const,
    subject: 'self' as const,
    testLabel: 'Ferritin',
    valueText: '42',
    unit: 'ng/mL',
    date: '2026-04-12',
  },
  supportedFields: ['testLabel', 'valueText', 'unit', 'date'],
  queueState: 'pending' as const,
  selectable: true,
};

const block = {
  intakeId: intake.id,
  proposalId: 'fictional-proposal',
  intakeVersion: intake.version,
  reviewToken: 'fictional-review-token',
  proposalContentUrl: '/api/proposals/fictional-proposal',
  records: [record],
};

const reportDetail: IntakeReportQueueDetail = {
  view: 'all',
  group: {
    groupId: 'fictional-report',
    groupVersionId: 'fictional-report-v1',
    intakeId: intake.id,
    intakeVersion: intake.version,
    discoveryOrder: 1,
    title: 'Spring lab report',
    source: 'Juniper Clinic',
    date: '2026-04-12',
    basis: 'report_anchor',
    original: {
      filename: intake.filename,
      contentUrl: intake.contentUrl,
      parentSourceFileId: null,
    },
    member: null,
    anchor: null,
    counts: {
      pending: 1,
      deferred: 0,
      blocked: 0,
      accepted: 0,
      keptOriginal: 0,
      superseded: 0,
      questions: 0,
    },
  },
  blocks: [block],
  totalRecords: 1,
  nextCursor: null,
};

const review: IntakeReview = {
  intakeId: intake.id,
  proposalId: block.proposalId,
  version: intake.version,
  reviewToken: block.reviewToken,
  summary: { additions: 1, duplicates: 0, unsupported: 0, uncertain: 0 },
  records: [record],
  sourceContext: [],
  coverageGaps: [],
};

const identityReview: IntakeIdentityReview = {
  status: 'confirmation_required',
  blocking: true,
  message: 'Confirm the exact retained subject evidence.',
  evidencedIdentity: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
  self: {
    noteId: 'person-note:self',
    version: 4,
    fullName: null,
    birthDate: null,
  },
  offeredSelfFields: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
  conflicts: [],
  scope: {
    profileId: 'fictional-profile',
    intakeId: intake.id,
    intakeVersion: intake.version,
    groupId: reportDetail.group.groupId,
    groupVersionId: reportDetail.group.groupVersionId,
    sourceHash: intake.sha256,
    memberId: null,
    original: { filename: intake.filename, contentUrl: intake.contentUrl, page: 1 },
    report: { locator: 'page 1', text: 'Spring lab report' },
    subject: { locator: 'page 1', text: 'Rowan Ellis · 1988-04-12' },
    verificationMode: 'literal_text_match',
    evidencedIdentity: { fullName: 'Rowan Ellis', birthDate: '1988-04-12' },
    membership: [],
    targets: [
      {
        candidateId: record.candidateId!,
        candidateVersionId: record.candidateVersionId!,
        proposalId: block.proposalId,
        recordId: record.id,
        title: record.title,
        issueId: 'fictional-identity-issue',
      },
    ],
    scopeToken: 'fictional-scope-token',
  },
};

function nativeReportDetail(): CollectionReportDetail {
  const coverage = {
    total: 1,
    covered: 0,
    uncovered: 1,
    status: 'uncovered' as const,
    sourceCount: 0,
    bySource: { items: [], total: 0, nextCursor: null },
  };
  return {
    format: 'health-intake-report-detail-v2',
    group: {
      ...reportDetail.group,
      format: 'health-intake-report-group-v2',
      groupOrdinal: 0,
      sourceScope: null,
      report: null,
      reportContext: null,
      peopleCounts: { pending: 0, later: 0, excluded: 0, saved: 0 },
      sourceCoverage: { current: coverage, saved: coverage },
      sourceReview: null,
      records: { intakeId: intake.id, groupId: reportDetail.group.groupId },
      people: { intakeId: intake.id, groupId: reportDetail.group.groupId },
    },
    records: {
      format: 'health-intake-report-record-page-v2',
      intakeId: intake.id,
      version: intake.version,
      scope: 'clinical_records',
      view: 'all',
      records: [
        {
          kind: 'record',
          groupId: reportDetail.group.groupId,
          proposalId: block.proposalId,
          reviewToken: block.reviewToken,
          queueState: 'pending',
          selectable: false,
          record: {
            ...record,
            identityReview: {
              status: identityReview.status,
              blocking: identityReview.blocking,
              message: identityReview.message,
              evidencedIdentity: identityReview.evidencedIdentity,
              conflicts: identityReview.conflicts,
            },
          },
        },
      ],
      totalRecords: 2,
      nextCursor: 'fictional-second-page',
    },
    people: {
      format: 'health-intake-people-page-v2',
      intakeId: intake.id,
      groupId: reportDetail.group.groupId,
      selectedPersonId: null,
      people: [],
      totalPeople: 0,
      counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
      nextCursor: null,
    },
  };
}

it('keeps an unknown list feed unavailable and retries without exposing provisional review', async () => {
  selectProfile({ id: 'fictional-list-error', name: 'Rowan', placebo: true });
  let feedReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) {
        feedReads += 1;
        return new Response(
          JSON.stringify({
            error: { code: 'UNAVAILABLE', message: 'Fictional feed unavailable.' },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.pathname.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      return response([]);
    }),
  );
  const view = render(
    <MemoryRouter initialEntries={['/import']}>
      <ImportPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional feed unavailable.');
  expect(view.container.querySelector('#import-review-title')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry import review' }));
  await waitFor(() => expect(feedReads).toBe(2));
  expect(view.container.querySelector('#import-review-title')).toBeNull();
});

it.each(['native', 'legacy', 'legacy-error'] as const)(
  'mounts a direct %s report once after its initial feed settles, then refreshes once for grounding',
  async (format) => {
    selectProfile({ id: 'fictional-direct-feed-' + format, name: 'Rowan', placebo: true });
    const detail = nativeReportDetail();
    const initial = detail.records.records[0]!;
    expect(initial.kind).toBe('record');
    if (initial.kind !== 'record') throw Error('Expected the complete fictional selected record');
    const feedRecord = {
      ...initial.record,
      feedKey: 'fictional-direct-key',
      feedOrder: '0',
      feedKind: 'test' as const,
      manuallyEdited: false,
    };
    const nativeFeed: CollectionImportFeed = {
      format: 'health-intake-import-feed-v2',
      view: 'all',
      records: [
        {
          intakeId: intake.id,
          groupId: detail.group.groupId,
          groupOrdinal: 0,
          proposalId: block.proposalId,
          intakeVersion: intake.version,
          reviewToken: block.reviewToken,
          feedKey: feedRecord.feedKey,
          feedOrder: feedRecord.feedOrder,
          feedKind: feedRecord.feedKind,
          manuallyEdited: false,
          detail: { kind: 'record', record: feedRecord },
        },
      ],
      totalRecords: 1,
      totalGroups: 1,
      nextCursor: null,
      counts: detail.group.counts,
      kindCounts: {
        test: 1,
        procedure: 0,
        history: 0,
        prescription: 0,
        vision: 0,
        person: 0,
        unsupported: 0,
      },
      groups: [],
      people: {
        groups: [],
        totalGroups: 0,
        counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
        nextCursor: null,
      },
      activity: {
        format: 'activity',
        binding: 'fictional',
        runningFiles: 0,
        pausedFiles: 0,
        queuedFiles: 0,
        filesAwaitingConversion: 0,
        remainingUnits: { state: 'exact', value: 0 },
        extractionUnknownFiles: 0,
        extractionComplete: true,
        allCurrentReportsReviewed: false,
        readingAccounting: { state: 'referenced', scope: 'all', binding: 'fictional' },
      },
    };
    const legacyFeed: IntakeImportFeed = {
      view: 'all',
      groups: [reportDetail.group],
      blocks: [{ ...block, groupId: detail.group.groupId, records: [feedRecord] }],
      totalRecords: 1,
      totalGroups: 1,
      nextCursor: null,
      counts: nativeFeed.counts,
      kindCounts: nativeFeed.kindCounts,
      people: { groups: [], totalGroups: 0, counts: nativeFeed.people.counts, nextCursor: null },
      activity: {
        runningFiles: 0,
        pausedFiles: 0,
        queuedFiles: 0,
        filesAwaitingConversion: 0,
        remainingUnits: 0,
        extractionUnknownFiles: 0,
        extractionComplete: true,
        allCurrentReportsReviewed: false,
      },
    };
    let releaseFeed!: () => void;
    let releaseIdentity!: () => void;
    let feedStarted = false;
    let grounded = false;
    const feedReady = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const identityReady = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    const reports: URL[] = [];
    let identityReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.endsWith('/import-feed')) {
          feedStarted = true;
          await feedReady;
          return format === 'legacy-error'
            ? new Response(
                JSON.stringify({
                  error: { code: 'UNAVAILABLE', message: 'Fictional feed unavailable.' },
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } },
              )
            : response(format === 'native' ? nativeFeed : legacyFeed);
        }
        if (url.pathname.includes('/report-queue/')) {
          reports.push(url);
          const reviewed = {
            ...record,
            title: grounded
              ? 'Fictional grounded direct record'
              : 'Fictional blocked direct record',
            selectable: grounded,
            identityReview: { ...identityReview, blocking: !grounded },
          };
          return response(
            format === 'native'
              ? {
                  ...detail,
                  records: {
                    ...detail.records,
                    totalRecords: 1,
                    nextCursor: null,
                    records: [
                      {
                        ...initial,
                        record: reviewed,
                        selectable: grounded,
                        reviewToken: grounded ? 'grounded-direct' : block.reviewToken,
                      },
                    ],
                  },
                }
              : { ...reportDetail, blocks: [{ ...block, records: [reviewed] }] },
          );
        }
        if (url.pathname.endsWith('/identity-review')) {
          identityReads += 1;
          await identityReady;
          grounded = true;
          return response({
            ...identityReview,
            status: 'evidenced_match',
            blocking: false,
            offeredSelfFields: {},
          });
        }
        if (url.pathname.endsWith('/intakes/limits'))
          return response({ uploadBytes: 1024, extractionBytes: 1024 });
        if (url.pathname.includes('/intakes/people/'))
          return response({
            groupId: detail.group.groupId,
            people: [],
            totalPeople: 0,
            peopleNextCursor: null,
          });
        if (url.pathname.endsWith('/report-source-review'))
          return response({
            profileId: 'fictional-direct-feed-' + format,
            intakeId: intake.id,
            intakeVersion: intake.version,
            groupId: detail.group.groupId,
            groupVersionId: reportDetail.group.groupVersionId,
            view: 'all',
            scopeToken: 'fictional-source-scope',
            targets: [],
            sourceEvidence: [],
            coverage: { total: 1, covered: 0, uncovered: 1, status: 'uncovered', bySource: [] },
          } satisfies IntakeReportSourceReview);
        return response([]);
      }),
    );
    render(
      <MemoryRouter initialEntries={['/import?group=fictional-report&intake=fictional-intake']}>
        <ImportPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(feedStarted).toBe(true));
    await act(async () => {});
    expect(reports).toHaveLength(0);
    expect(identityReads).toBe(0);
    await act(async () => releaseFeed());
    expect(
      await screen.findByRole('link', {
        name: /Fictional blocked direct record/,
      }),
    ).toBeVisible();
    expect(reports).toHaveLength(1);
    await waitFor(() => expect(identityReads).toBeGreaterThan(0));
    await act(async () => releaseIdentity());
    expect(
      await screen.findByRole('link', {
        name: /Fictional grounded direct record/,
      }),
    ).toBeVisible();
    await act(async () => {});
    expect(reports).toHaveLength(2);
  },
);

it('waits for acknowledged identity grounding before refreshing readiness and retains a later referenced page', async () => {
  selectProfile({ id: 'fictional-native-detail', name: 'Rowan', placebo: true });
  const detail = nativeReportDetail();
  let confirmed = false;
  let grounded = false;
  let finishGrounding: (() => void) | undefined;
  let finishNextPage: (() => void) | undefined;
  const reports: URL[] = [];
  let identityReads = 0;
  const changed = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.includes('/report-queue/')) {
        reports.push(url);
        if (url.searchParams.has('cursor'))
          await new Promise<void>((resolve) => {
            finishNextPage = resolve;
          });
        return response(
          url.searchParams.has('cursor')
            ? {
                ...detail,
                records: {
                  ...detail.records,
                  records: [
                    {
                      kind: 'record_reference',
                      groupId: reportDetail.group.groupId,
                      proposalId: block.proposalId,
                      queueState: 'pending',
                      selectable: true,
                      reviewToken: 'referenced-record-token',
                      selection: {
                        recordId: 'fictional-next-record',
                        candidateVersionId: 'fictional-next-v1',
                      },
                      reference: {
                        format: 'health-intake-clinical-review-reference-v2',
                        section: 'records',
                        ordinal: 1,
                        bytes: 70000,
                        reviewToken: 'referenced-record-token',
                      },
                    },
                  ],
                  nextCursor: null,
                },
              }
            : {
                ...detail,
                records: {
                  ...detail.records,
                  records: detail.records.records.map((row) =>
                    row.kind === 'record'
                      ? {
                          ...row,
                          selectable: grounded,
                          record: {
                            ...row.record,
                            title: grounded
                              ? 'Fictional grounded ready record'
                              : 'Fictional blocked record',
                            selectable: grounded,
                            identityReview: { ...row.record.identityReview!, blocking: !grounded },
                          },
                        }
                      : row,
                  ),
                },
              },
        );
      }
      if (url.pathname.endsWith('/identity-review')) {
        identityReads += 1;
        if (confirmed && !grounded)
          await new Promise<void>((resolve) => {
            finishGrounding = () => {
              grounded = true;
              resolve();
            };
          });
        return response({
          ...identityReview,
          status: confirmed ? 'prior_confirmation' : 'confirmation_required',
          blocking: !confirmed,
          offeredSelfFields: {},
          scope: {
            ...identityReview.scope,
            scopeToken: confirmed ? 'confirmed-scope' : 'initial-scope',
          },
        });
      }
      if (url.pathname.endsWith('/identity-scope') && init?.method === 'POST') {
        confirmed = true;
        return response(intake);
      }
      if (url.pathname.endsWith('/intakes/' + intake.id)) return response([]);
      throw new Error('Unexpected ' + url);
    }),
  );
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{ groupId: reportDetail.group.groupId, intakeId: intake.id }}
        onBack={vi.fn()}
        onChanged={changed}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'This is me' }));
  await waitFor(() => expect(finishGrounding).toBeDefined());
  expect(reports).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
  expect(
    screen.getByRole('link', { name: 'Review exact record — Fictional blocked record' }),
  ).toBeVisible();
  await act(async () => finishGrounding!());
  expect(await screen.findByText('This report already matches Self.')).toBeVisible();
  expect(
    await screen.findByRole('link', {
      name: 'Review exact record — Fictional grounded ready record',
    }),
  ).toBeVisible();
  expect(reports).toHaveLength(2);
  expect(identityReads).toBe(2);
  expect(changed).toHaveBeenCalledOnce();
  expect(
    reports.every(
      (url) => url.searchParams.get('limit') === '40' && url.searchParams.get('bytes') === '65536',
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next report records' }));
  await waitFor(() => expect(finishNextPage).toBeDefined());
  expect(screen.getByText('This report already matches Self.')).toBeVisible();
  expect(screen.queryByRole('link', { name: /Review exact record/ })).toBeNull();
  await act(async () => finishNextPage!());
  await screen.findByRole('button', { name: 'First report records' });
  expect(
    await screen.findByRole('link', { name: 'Review exact record — Referenced clinical record' }),
  ).toHaveAttribute('href', expect.stringContaining('fictional-next-record'));
  await act(async () => {});
  expect(reports).toHaveLength(3);
  expect(identityReads).toBe(2);
  expect(reports[2]!.searchParams.get('cursor')).toBe('fictional-second-page');
});

function response(data: unknown) {
  return new Response(JSON.stringify({ data, meta: { revision: 1 } }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const acceptedResult = (operationId: string): IntakeReportAcceptanceResult => ({
  receipt: {
    operationId,
    status: 'accepted',
    atomic: true,
    at: '2026-09-14T12:00:00Z',
    selectedCount: 1,
    acceptedCount: 1,
    receipts: [
      {
        intakeId: intake.id,
        proposalId: block.proposalId,
        intakeVersionBefore: intake.version,
        intakeVersionAfter: intake.version + 1,
        reviewToken: block.reviewToken,
        records: [
          {
            recordId: record.id,
            entityId: 'fictional-saved-ferritin',
            candidateId: record.candidateId!,
            candidateVersionId: record.candidateVersionId!,
            kind: 'observation',
            title: record.title,
            optical: false,
            outcome: 'added',
          },
        ],
      },
    ],
  },
  replayed: false,
  durability: {
    pending: false,
    mutationRevision: intake.version + 1,
    persistedRevision: intake.version + 1,
    error: null,
  },
});

it.each([true, false])(
  'refreshes blocked detail rows once after host grounding (ready=%s)',
  async (readyAfterRefresh) => {
    selectProfile({ id: 'fictional-grounding-detail', name: 'Rowan', placebo: true });
    let detailReads = 0;
    const onBack = vi.fn();
    const prior: IntakeIdentityReview = {
      ...identityReview,
      status: 'prior_confirmation',
      blocking: false,
      offeredSelfFields: {},
      scope: { ...identityReview.scope!, targets: [] },
    };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('/intakes/report-queue/fictional-report')) {
          detailReads += 1;
          return response({
            ...reportDetail,
            blocks: [
              {
                ...block,
                reviewToken:
                  readyAfterRefresh && detailReads > 1 ? 'after-grounding' : 'before-grounding',
                records: [
                  {
                    ...record,
                    selectable: readyAfterRefresh && detailReads > 1,
                    identityReview: {
                      ...prior,
                      status:
                        readyAfterRefresh && detailReads > 1
                          ? 'prior_confirmation'
                          : 'confirmation_required',
                      blocking: !readyAfterRefresh || detailReads === 1,
                    },
                  },
                ],
              },
            ],
          });
        }
        if (url.includes('/identity-review')) return response(prior);
        if (url.includes('/intakes/people/fictional-report'))
          return response({
            groupId: 'fictional-report',
            people: [],
            totalPeople: 0,
            peopleNextCursor: null,
          });
        throw Error(`Unexpected request: ${url}`);
      }),
    );
    render(
      <MemoryRouter>
        <ImportDetailReview
          selection={{ groupId: 'fictional-report' }}
          onBack={onBack}
          onChanged={() => {}}
          onUseSource={() => {}}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(detailReads).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(detailReads).toBe(2);
    await openPersonContext();
    expect(await screen.findByText('This report already matches Self.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onBack).toHaveBeenCalledOnce();
    expect(requests.some((url) => url.endsWith('/identity-scope'))).toBe(false);
    expect(requests.some((url) => url.includes('/report-acceptance'))).toBe(false);
  },
);

it('shows the unverified model birth date in direct report review without requiring confirmation', async () => {
  selectProfile({ id: 'fictional-model-date-detail', name: 'Rowan', placebo: true });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: 'evidenced_match',
          blocking: false,
          evidencedIdentity: { fullName: 'Rowan Ellis' },
          self: { ...identityReview.self, birthDate: '1989-04-12' },
          scope: {
            ...identityReview.scope!,
            evidencedIdentity: { fullName: 'Rowan Ellis' },
          },
          offeredSelfFields: {},
          warnings: [
            {
              kind: 'model_birth_date_mismatch',
              modelBirthDate: '1988-04-12',
              savedBirthDate: '1989-04-12',
              personName: 'Rowan Ellis',
            },
          ],
        } satisfies IntakeIdentityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      throw Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{ groupId: 'fictional-report' }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  const warning = await screen.findByText(/automatic reading suggested a date of birth/);
  const notice = warning.closest('[role="status"]')!;
  expect(notice).toHaveTextContent('1988-04-12');
  expect(notice).toHaveTextContent('1989-04-12');
  expect(notice).toHaveTextContent('Rowan Ellis');
  fireEvent.click(within(notice as HTMLElement).getByRole('button', { name: 'Review person' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(
    within(screen.getByRole('dialog')).getByText(/automatic reading suggested a date of birth/),
  ).toBeVisible();
  expect(screen.queryByText(/Printed date of birth:/)).toBeNull();
  expect(requests.some((url) => url.endsWith('/identity-scope'))).toBe(false);
});

it.each([
  {
    label: 'name-only Self match',
    status: 'evidenced_match' as const,
    birthDate: undefined,
    otherPerson: false,
    cue: 'For Rowan Ellis (you?)',
    action: 'Review',
  },
  {
    label: 'name-only other-person match',
    status: 'evidenced_match' as const,
    birthDate: undefined,
    otherPerson: true,
    cue: 'For Rowan Ellis (?)',
    action: 'Review',
  },
  {
    label: 'birth-date supported Self match',
    status: 'evidenced_match' as const,
    birthDate: '1988-04-12',
    otherPerson: false,
    cue: 'For Rowan Ellis (you)',
    action: 'Change',
  },
  {
    label: 'prior Self confirmation',
    status: 'prior_confirmation' as const,
    birthDate: undefined,
    otherPerson: false,
    cue: 'For Rowan Ellis (you)',
    action: 'Change',
  },
])('shows $label as $action in direct report review', async (state) => {
  selectProfile({ id: `fictional-person-cue-${state.label}`, name: 'Rowan', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: state.status,
          blocking: false,
          evidencedIdentity: {
            fullName: 'Rowan Ellis',
            ...(state.birthDate ? { birthDate: state.birthDate } : {}),
          },
          offeredSelfFields: {},
          ...(state.otherPerson
            ? {
                assignedPerson: {
                  noteId: 'person-note:fictional-other',
                  personId: 'fictional-other',
                  version: 1,
                  fullName: 'Rowan Ellis',
                },
              }
            : {}),
        } satisfies IntakeIdentityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      throw Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{ groupId: 'fictional-report' }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: `${state.action} person for this report` }),
    ).toHaveTextContent(state.cue),
  );
  const control = screen.getByRole('button', { name: `${state.action} person for this report` });
  expect(control).toHaveTextContent(state.action);
});

it('keeps saved records intact and offers retry when their destination receipt cannot load', async () => {
  selectProfile({ id: 'fictional-saved-links', name: 'Rowan', placebo: true });
  let available = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response({
          ...reportDetail,
          blocks: [
            { ...block, records: [{ ...record, reviewState: 'accepted', queueState: 'accepted' }] },
          ],
        });
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake')) {
        if (!available)
          return new Response(
            JSON.stringify({
              error: { code: 'TEST_UNAVAILABLE', message: 'Temporarily unavailable' },
            }),
            { status: 400 },
          );
        return response({
          ...intake,
          acceptedProposalId: block.proposalId,
          imported: {
            clinical: {
              records: [
                {
                  recordId: record.id,
                  entityId: 'fictional-saved-entity',
                  kind: 'observation',
                  title: 'Saved fictional ferritin',
                  outcome: 'added',
                },
              ],
            },
          },
        });
      }
      throw Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{ groupId: 'fictional-report' }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Your saved records are unchanged');
  available = true;
  await user.click(screen.getByRole('button', { name: 'Retry saved links' }));
  expect(await screen.findByRole('link', { name: /Saved fictional ferritin/ })).toHaveAttribute(
    'href',
    '/tests?result=fictional-saved-entity&visibility=all',
  );
  expect(
    screen.queryByText('Saved record links could not load. Your saved records are unchanged.'),
  ).not.toBeInTheDocument();
});

it.each(['review_later', 'keep_original_only'] as const)(
  'requires Return to review before a deep-linked %s record can be saved',
  async (disposition) => {
    selectProfile({ id: `fictional-deferred-${disposition}`, name: 'Rowan', placebo: true });
    let currentDisposition: typeof disposition | 'pending' = disposition;
    const savedDraft = () => ({
      ...record,
      draft: {
        mapping: record.mapping,
        resolutions: [],
        disposition: currentDisposition,
        decision: {
          recordId: record.id,
          mapping: record.mapping,
          action: currentDisposition === 'pending' ? 'accept' : 'skip',
        },
      },
    });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
        if (url.includes('/identity-review'))
          return response({
            ...identityReview,
            status: 'evidenced_match',
            blocking: false,
            offeredSelfFields: {},
          });
        if (url.includes('/intakes/people/fictional-report'))
          return response({
            groupId: 'fictional-report',
            people: [],
            totalPeople: 0,
            peopleNextCursor: null,
          });
        if (url.includes('/intakes/fictional-intake/review-record?'))
          return response({ ...review, records: [savedDraft()] });
        if (url.endsWith('/intakes/fictional-intake/review-draft')) {
          currentDisposition = JSON.parse(String(init?.body)).disposition;
          return response(intake);
        }
        if (url.endsWith('/intakes/fictional-intake')) return response(intake);
        throw Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    render(
      <ImportDetailReview
        selection={{
          groupId: 'fictional-report',
          intakeId: intake.id,
          proposalId: block.proposalId,
          recordId: record.id,
        }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />,
    );
    const resume = await screen.findByRole('button', { name: 'Return to review' });
    expect(screen.queryByRole('button', { name: 'Confirm and save record' })).toBeNull();
    expect(requests.some((url) => url.includes('/report-acceptance'))).toBe(false);
    await user.click(resume);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm and save record' })).toBeEnabled(),
    );
    expect(currentDisposition).toBe('pending');
    expect(requests.some((url) => url.includes('/report-acceptance'))).toBe(false);
  },
);

it('keeps exact report links inside Import with intake, proposal, and record selection', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  const link = await screen.findByRole('link', { name: /Ferritin/ });
  expect(link).toHaveAttribute(
    'href',
    '#/import?group=fictional-report&intake=fictional-intake&proposal=fictional-proposal&record=fictional-record&review=full',
  );
  expect(document.querySelector('a[href*="sources?view=import"]')).toBeNull();
});

it('opens every clinical field in the exact Import detail and autosaves the retained draft', async () => {
  selectProfile({ id: 'fictional-profile-detail', name: 'Rowan', placebo: true });
  const requests: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review')) return response(review);
      if (url.endsWith('/intakes/fictional-intake/review-draft')) return response(intake);
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  expect(await screen.findByRole('heading', { name: 'Ferritin' })).toBeVisible();
  expect(screen.getByText('Retained original preview')).toBeInTheDocument();
  expect(screen.getByLabelText('Test name')).toHaveValue('Ferritin');
  expect(screen.getByLabelText('Result')).toHaveValue('42');
  expect(screen.getByLabelText('Unit')).toHaveValue('ng/mL');
  expect(screen.getByLabelText('Clinical date')).toHaveValue('2026-04-12');

  await user.clear(screen.getByLabelText('Result'));
  await user.type(screen.getByLabelText('Result'), '43');
  await waitFor(
    () =>
      expect(
        requests.some(
          ({ url, body }) =>
            url.endsWith('/intakes/fictional-intake/review-draft') &&
            body &&
            JSON.parse(body).mapping.valueText === '43',
        ),
      ).toBe(true),
    { timeout: 2_000 },
  );
});

it('warns only for a different retained source match and explains transcription coverage', async () => {
  selectProfile({ id: 'fictional-profile-copy', name: 'Rowan', placebo: true });
  const comparedRecord: IntakeReportQueueRecord = {
    ...record,
    classification: 'duplicate',
    duplicateOf: {
      id: 'fictional-prior-entity',
      label: 'Previously accepted assertion',
      date: null,
      sameSourceRecord: false,
      persistedMatch: true,
    },
    uncertainties: [
      'Model transcription covers only part of this source entry. Whole-file reading progress is tracked separately; the retained original remains available.',
    ],
  };
  const comparedReview: IntakeReview = {
    ...review,
    summary: { ...review.summary, additions: 0, duplicates: 1, uncertain: 1 },
    records: [comparedRecord],
    coverageGaps: [
      {
        id: comparedRecord.id,
        label: comparedRecord.title,
        detail: comparedRecord.uncertainties[0],
        evidence: comparedRecord.evidence,
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response({
          ...reportDetail,
          blocks: [{ ...block, records: [comparedRecord] }],
        });
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: 'evidenced_match',
          blocking: false,
          offeredSelfFields: {},
        });
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review')) return response(comparedReview);
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const view = render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  expect(
    await screen.findByText(/the saved record and this source evidence remain retained/i),
  ).toBeVisible();
  expect(screen.queryByText(/both originals remain retained/i)).toBeNull();
  expect(screen.getByText('Transcription notes and coverage')).toBeVisible();
  expect(
    screen.getAllByText(/Whole-file reading progress is tracked separately/i).length,
  ).toBeGreaterThan(0);

  view.unmount();
  comparedRecord.duplicateOf!.sameSourceRecord = true;
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  expect(await screen.findByRole('heading', { name: 'Ferritin' })).toBeVisible();
  expect(screen.queryByText(/Matches Previously accepted assertion/i)).toBeNull();
});

it('keeps an uncertain exact-record acceptance gated until its original receipt or retry resolves', async () => {
  selectProfile({ id: 'fictional-exact-recovery', name: 'Rowan', placebo: true });
  let acceptancePosts = 0;
  const requests: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: 'evidenced_match',
          blocking: false,
          offeredSelfFields: {},
        });
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review')) return response(review);
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      if (url.endsWith('/intakes/report-acceptance')) {
        acceptancePosts += 1;
        if (acceptancePosts === 1) throw new TypeError('Fictional response lost');
        const operationId = JSON.parse(String(init?.body)).operationId;
        return response(acceptedResult(operationId));
      }
      if (url.includes('/intakes/report-acceptance/'))
        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Receipt not visible yet.' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        );
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{
          groupId: 'fictional-report',
          intakeId: intake.id,
          proposalId: block.proposalId,
          recordId: record.id,
        }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );

  await user.click(await screen.findByRole('button', { name: 'Confirm and save record' }));
  expect(
    await screen.findByText('A save has not been confirmed yet. Check its status before retrying.'),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm and save record' })).toBeDisabled();
  expect(acceptancePosts).toBe(1);

  await user.click(screen.getByRole('button', { name: 'Retry this save' }));
  await waitFor(() => expect(acceptancePosts).toBe(2));
  const bodies = requests
    .filter(({ url, body }) => url.endsWith('/intakes/report-acceptance') && body)
    .map(({ body }) => JSON.parse(body!));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(await screen.findByText('This exact record was saved to your profile.')).toBeVisible();
  // Every review GET in this fixture still returns pending. The durable receipt
  // must remove repeat acceptance immediately, without waiting for that refresh.
  expect(screen.queryByRole('button', { name: 'Confirm and save record' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review later' })).toBeNull();
});

it('shows a stale draft comparison with explicit newer-value and reapply choices', async () => {
  selectProfile({ id: 'fictional-draft-conflict', name: 'Rowan', placebo: true });
  let reviewReads = 0;
  let draftPosts = 0;
  const currentRecord = { ...record, mapping: { ...record.mapping, valueText: '44' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/review-draft')) {
        draftPosts += 1;
        if (draftPosts === 1)
          return new Response(
            JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Review changed.' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          version: intake.version + 1,
          mapping: { valueText: '43' },
        });
        return response({ ...intake, version: intake.version + 2 });
      }
      if (url.includes('/intakes/fictional-intake/review')) {
        reviewReads += 1;
        return response(
          reviewReads === 1
            ? review
            : { ...review, version: intake.version + 1, records: [currentRecord] },
        );
      }
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  const resultField = await screen.findByLabelText('Result');
  await user.clear(resultField);
  await user.type(resultField, '43');
  await user.click(await screen.findByRole('button', { name: 'Review newer saved changes' }));
  expect(await screen.findByRole('region', { name: 'Review draft conflict' })).toHaveTextContent(
    '44',
  );
  expect(screen.getByRole('region', { name: 'Review draft conflict' })).toHaveTextContent(
    'Related-record decisions: None',
  );
  expect(screen.getByRole('region', { name: 'Review draft conflict' })).toHaveTextContent(
    'Issue resolutions: None',
  );
  expect(screen.getByRole('region', { name: 'Review draft conflict' })).toHaveTextContent(
    'Saved answers: None',
  );
  expect(screen.getByRole('region', { name: 'Review draft conflict' })).toHaveTextContent(
    'Reusable mapping rule: None',
  );
  expect(screen.getByRole('button', { name: 'Use newer saved fields' })).toBeEnabled();
  await user.click(
    screen.getByRole('button', { name: 'Save my reviewed fields over these changes' }),
  );
  await waitFor(() => expect(draftPosts).toBe(2));
});

it('rejects a mismatched exact tuple only after searching later report pages', async () => {
  selectProfile({ id: 'fictional-paginated-tuple', name: 'Rowan', placebo: true });
  const laterRecord = { ...record, id: 'fictional-later-record' };
  const firstPage = { ...reportDetail, blocks: [], nextCursor: 'fictional-next-page' };
  const laterPage = {
    ...reportDetail,
    blocks: [{ ...block, records: [laterRecord] }],
    nextCursor: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response(url.includes('cursor=fictional-next-page') ? laterPage : firstPage);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review'))
        return response({ ...review, records: [laterRecord] });
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const view = render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: laterRecord.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  expect(await screen.findByRole('heading', { name: 'Ferritin' })).toBeVisible();

  view.rerender(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: 'fictional-wrong-intake',
        proposalId: block.proposalId,
        recordId: laterRecord.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  expect(
    await screen.findByText(/exact proposal record is no longer in this report version/i),
  ).toBeVisible();
});

it('restores reviewed file metadata suggestions and safe conflict choices in exact detail', async () => {
  selectProfile({ id: 'fictional-metadata-detail', name: 'Rowan', placebo: true });
  let metadataPosts = 0;
  const metadataRecord = {
    ...record,
    issues: [
      {
        id: 'fictional-metadata-hint',
        kind: 'information' as const,
        prompt: 'The retained report identifies its care area and topic.',
        blocking: false,
        status: 'unresolved' as const,
        field: null,
        locator: 'page 1, heading',
        questionId: null,
        metadataSuggestion: { careArea: 'Vision', topics: ['Corrective lenses'] },
      },
    ],
  };
  const metadataReview = { ...review, records: [metadataRecord] };
  const newer = {
    ...intake,
    version: intake.version + 1,
    metadata: {
      source: 'Saved fictional source',
      careArea: 'Medical',
      documentType: null,
      topics: [],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response({
          ...reportDetail,
          blocks: [{ ...block, records: [metadataRecord] }],
        });
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review')) return response(metadataReview);
      if (url.endsWith('/intakes/fictional-intake/metadata')) {
        metadataPosts += 1;
        return new Response(
          JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'File details changed.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/intakes/fictional-intake'))
        return response(metadataPosts ? newer : intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await user.click(await screen.findByRole('button', { name: 'Use suggested care area: Vision' }));
  expect(await screen.findByRole('region', { name: 'File details conflict' })).toHaveTextContent(
    'Saved fictional source',
  );
  expect(metadataPosts).toBe(1);
  expect(screen.getByRole('button', { name: 'Keep newer saved file details' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Apply my reviewed file details' })).toBeEnabled();
});

it('pins metadata writes to the initiating profile before the request starts', async () => {
  const firstProfile = { id: 'fictional-metadata-first', name: 'Rowan', placebo: true };
  const nextProfile = { id: 'fictional-metadata-next', name: 'Casey', placebo: true };
  replaceProfiles([firstProfile, nextProfile]);
  selectProfile(firstProfile);
  const metadataRecord = {
    ...record,
    issues: [
      {
        id: 'fictional-profile-metadata-hint',
        kind: 'information' as const,
        prompt: 'The retained report identifies its care area.',
        blocking: false,
        status: 'unresolved' as const,
        field: null,
        locator: 'page 1, heading',
        questionId: null,
        metadataSuggestion: { careArea: 'Vision' },
      },
    ],
  };
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/intakes/fictional-intake/metadata')) {
        writes.push(url);
        return response({ ...intake, version: intake.version + 1 });
      }
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response({ ...reportDetail, blocks: [{ ...block, records: [metadataRecord] }] });
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review'))
        return response({ ...review, records: [metadataRecord] });
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const view = render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  const suggestion = await screen.findByRole('button', {
    name: 'Use suggested care area: Vision',
  });

  act(() => {
    fireEvent.click(suggestion);
    selectProfile(nextProfile);
    view.rerender(
      <ImportDetailReview
        selection={{
          groupId: 'fictional-report',
          intakeId: intake.id,
          proposalId: block.proposalId,
          recordId: record.id,
        }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />,
    );
  });

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Ferritin' })).toBeVisible());
  expect(writes).toEqual([]);
});

it('keeps uncertain metadata edits across refresh and blocks navigation until resolved', async () => {
  selectProfile({ id: 'fictional-metadata-dirty', name: 'Rowan', placebo: true });
  const onBack = vi.fn();
  let identitySaved = false;
  const metadataRecord = {
    ...record,
    issues: [
      {
        id: 'fictional-dirty-metadata-hint',
        kind: 'information' as const,
        prompt: 'The retained report identifies its care area.',
        blocking: false,
        status: 'unresolved' as const,
        field: null,
        locator: 'page 1, heading',
        questionId: null,
        metadataSuggestion: { careArea: 'Vision' },
      },
    ],
  };
  const refreshedIntake = {
    ...intake,
    version: intake.version + 1,
    metadata: { source: null, careArea: 'Medical', documentType: null, topics: [] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report'))
        return response({ ...reportDetail, blocks: [{ ...block, records: [metadataRecord] }] });
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identitySaved = true;
        return response(refreshedIntake);
      }
      if (url.endsWith('/intakes/fictional-intake/metadata'))
        throw new TypeError('Fictional metadata response lost');
      if (url.includes('/intakes/fictional-intake/review'))
        return response({ ...review, records: [metadataRecord] });
      if (url.endsWith('/intakes/fictional-intake'))
        return response(identitySaved ? refreshedIntake : intake);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={onBack}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await user.click(await screen.findByRole('button', { name: 'Use suggested care area: Vision' }));
  expect(await screen.findByRole('button', { name: 'Save file details' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use suggested care area: Vision' })).toBeNull();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Back to Import' }));
  expect(onBack).not.toHaveBeenCalled();
  await openPersonContext();
  await user.click(screen.getByRole('button', { name: 'This is me and add selected details' }));
  await waitFor(() => expect(identitySaved).toBe(true));
  expect(await screen.findByRole('button', { name: 'Save file details' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use suggested care area: Vision' })).toBeNull();
  expect(screen.getByText(/file-organization labels are separate/i)).toBeInTheDocument();
});

it('keeps exact identity and selected blank Self fields in one deep-linked Import action', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const requests: { url: string; body?: string }[] = [];
  let identityConfirmed = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response(
          identityConfirmed
            ? {
                ...identityReview,
                status: 'prior_confirmation',
                blocking: false,
                message: 'The retained fictional confirmation still applies.',
                self: {
                  ...identityReview.self,
                  version: identityReview.self.version + 1,
                  fullName: 'Rowan Ellis',
                  birthDate: '1988-04-12',
                },
                offeredSelfFields: {},
                scope: { ...identityReview.scope!, intakeVersion: intake.version + 1, targets: [] },
              }
            : identityReview,
        );
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityConfirmed = true;
        return response({ ...intake, version: intake.version + 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <StrictMode>
      <ImportDetailReview
        selection={{ groupId: 'fictional-report', intakeId: intake.id }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </StrictMode>,
  );

  await openPersonContext();
  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Date of birth/ })).toBeChecked();
  });
  await user.click(screen.getByRole('button', { name: 'This is me and add selected details' }));
  await waitFor(() =>
    expect(
      requests.some(({ url, body }) => {
        if (!url.endsWith('/intakes/fictional-intake/identity-scope') || !body) return false;
        const value = JSON.parse(body);
        return (
          value.outcome === 'this_is_me' &&
          value.selfUpdate?.expectedVersion === 4 &&
          value.selfUpdate?.fields.fullName === undefined &&
          value.selfUpdate?.fields.birthDate === '1988-04-12'
        );
      }),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await openPersonContext();
  expect(
    await screen.findByText(
      'Identity and the selected blank Self details were confirmed in one action. Clinical records are not saved yet.',
    ),
  ).toBeVisible();
  expect(await screen.findByText('This report already matches Self.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
  expect(
    requests.filter(({ url }) => url.endsWith('/intakes/fictional-intake/identity-scope')),
  ).toHaveLength(1);
});

it('preserves a declined date of birth when a name offer arrives in the same deep-linked report', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const birthDateOnly: IntakeIdentityReview = {
    ...identityReview,
    offeredSelfFields: { birthDate: '1988-04-12' },
  };
  let identityReads = 0;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? birthDateOnly : identityReview);
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        return response({ ...intake, version: intake.version + 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  const birthDate = await screen.findByRole('checkbox', { name: /Date of birth/ });
  await waitFor(() => expect(birthDate).toBeChecked());
  await user.click(birthDate);
  expect(birthDate).not.toBeChecked();

  const refreshIdentity = () => {
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    fireEvent(window, restored);
  };
  refreshIdentity();
  await waitFor(() => expect(identityReads).toBe(2));
  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Date of birth/ })).not.toBeChecked();
  });

  refreshIdentity();
  await waitFor(() => expect(identityReads).toBe(3));
  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Date of birth/ })).not.toBeChecked();
  });

  await user.click(screen.getByRole('button', { name: 'This is me and add selected details' }));
  await waitFor(() => expect(identityPosts).toHaveLength(1));
  expect(identityPosts[0]!.selfUpdate).toBeUndefined();
});

it('completes one deep-linked identity action after exact late-reading freshness validation', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const freshIdentity: IntakeIdentityReview = {
    ...identityReview,
    scope: {
      ...identityReview.scope!,
      intakeVersion: identityReview.scope!.intakeVersion + 1,
      scopeToken: 'fictional-fresh-scope-token',
    },
  };
  let identityReads = 0;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? identityReview : freshIdentity);
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        if (identityPosts.length === 1)
          return new Response(
            JSON.stringify({
              error: { code: 'VERSION_CONFLICT', message: 'Late fictional reading progress.' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        return response({ ...intake, version: intake.version + 2 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await openPersonContext();
  expect(
    await screen.findByText(
      'Identity and the selected blank Self details were confirmed in one action. Clinical records are not saved yet.',
    ),
  ).toBeVisible();
  expect(identityPosts).toHaveLength(2);
  expect(identityPosts[0]!.operationId).toBe(identityPosts[1]!.operationId);
  expect(identityPosts[0]!.version).toBe(intake.version);
  expect(identityPosts[1]!.version).toBe(intake.version + 1);
  expect((identityPosts[1]!.scope as { scopeToken: string }).scopeToken).toBe(
    'fictional-fresh-scope-token',
  );
  expect((identityPosts[1]!.selfUpdate as { fields: object }).fields).toEqual({
    birthDate: identityReview.offeredSelfFields.birthDate,
  });
});

it('recovers the exact uncertain second identity request without a third operation', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const freshIdentity: IntakeIdentityReview = {
    ...identityReview,
    scope: {
      ...identityReview.scope!,
      intakeVersion: identityReview.scope!.intakeVersion + 1,
      scopeToken: 'fictional-recovery-scope-token',
    },
  };
  let identityReads = 0;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? identityReview : freshIdentity);
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        if (identityPosts.length === 1)
          return new Response(
            JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        if (identityPosts.length === 2)
          throw new Error('Fictional connection ended after the retry was sent');
        return response({ ...intake, version: intake.version + 2 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  const action = await screen.findByRole('button', {
    name: 'This is me and add selected details',
  });
  await user.click(action);
  await waitFor(() => expect(identityPosts).toHaveLength(2));
  expect(
    await screen.findByText('Fictional connection ended after the retry was sent'),
  ).toBeVisible();
  await user.click(action);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await openPersonContext();
  expect(
    await screen.findByText(
      'Identity and the selected blank Self details were confirmed in one action. Clinical records are not saved yet.',
    ),
  ).toBeVisible();
  expect(identityPosts).toHaveLength(3);
  expect(identityPosts[2]).toEqual(identityPosts[1]);
  expect(identityPosts[2]!.operationId).toBe(identityPosts[0]!.operationId);
});

it('never reuses a retained uncertain identity request in another profile', async () => {
  replaceProfiles([
    { id: 'fictional-profile-a', name: 'Rowan A', placebo: true },
    { id: 'fictional-profile-b', name: 'Rowan B', placebo: true },
  ]);
  selectProfile({ id: 'fictional-profile-a', name: 'Rowan A', placebo: true });
  const posts: { url: string; request: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        const profileId = url.includes('fictional-profile-b')
          ? 'fictional-profile-b'
          : 'fictional-profile-a';
        return response({
          ...identityReview,
          scope: { ...identityReview.scope!, profileId },
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        posts.push({ url, request: JSON.parse(String(init?.body)) });
        if (posts.length === 1) throw new Error('Fictional uncertain first response');
        return response({ ...intake, version: intake.version + 1 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  expect(await screen.findByText('Fictional uncertain first response')).toBeVisible();
  await act(async () => {
    selectProfile({ id: 'fictional-profile-b', name: 'Rowan B', placebo: true });
  });
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'This is me and add selected details' }),
    ).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'This is me and add selected details' }));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[0]!.url).toContain('/profiles/fictional-profile-a/');
  expect(posts[1]!.url).toContain('/profiles/fictional-profile-b/');
  expect(posts[1]!.request.operationId).not.toBe(posts[0]!.request.operationId);
  expect((posts[1]!.request.scope as { profileId: string }).profileId).toBe('fictional-profile-b');
});

it('does not retry when a BFCache restore invalidates the action during its fresh read', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let releaseFresh!: (value: Response) => void;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(identityReview);
        if (identityReads === 2)
          return new Promise<Response>((resolve) => {
            releaseFresh = resolve;
          });
        return response({
          ...identityReview,
          scope: {
            ...identityReview.scope!,
            intakeVersion: identityReview.scope!.intakeVersion + 1,
            scopeToken: 'fictional-restored-scope-token',
          },
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  await waitFor(() => expect(identityReads).toBe(2));
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  releaseFresh(
    response({
      ...identityReview,
      scope: {
        ...identityReview.scope!,
        intakeVersion: identityReview.scope!.intakeVersion + 1,
        scopeToken: 'fictional-fresh-scope-token',
      },
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'This is me and add selected details' }),
    ).toBeEnabled(),
  );
  expect(identityPosts).toHaveLength(1);
});

it('does not retry after the deep-link selection changes during its fresh read', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let releaseFresh!: (value: Response) => void;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(identityReview);
        return new Promise<Response>((resolve) => {
          releaseFresh = resolve;
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  const mounted = render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  await waitFor(() => expect(identityReads).toBe(2));
  mounted.rerender(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        personId: 'fictional-new-person-selection',
      }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  await act(async () => {
    releaseFresh(
      response({
        ...identityReview,
        scope: {
          ...identityReview.scope!,
          intakeVersion: identityReview.scope!.intakeVersion + 1,
          scopeToken: 'fictional-stale-selection-scope-token',
        },
      }),
    );
  });
  expect(identityPosts).toHaveLength(1);
});

it('does not publish or retry after the deep-linked view unmounts during its fresh read', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let releaseFresh!: (value: Response) => void;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(identityReview);
        return new Promise<Response>((resolve) => {
          releaseFresh = resolve;
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  const mounted = render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  await waitFor(() => expect(identityReads).toBe(2));
  mounted.unmount();
  await act(async () => {
    releaseFresh(
      response({
        ...identityReview,
        scope: {
          ...identityReview.scope!,
          intakeVersion: identityReview.scope!.intakeVersion + 1,
          scopeToken: 'fictional-unmounted-scope-token',
        },
      }),
    );
  });
  expect(identityPosts).toHaveLength(1);
});

it('refreshes an already-resolved identity race without asking for another confirmation', async () => {
  selectProfile({ id: 'fictional-identity-race', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let identityPosts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(
          identityReads === 1
            ? identityReview
            : {
                ...identityReview,
                status: 'prior_confirmation',
                blocking: false,
                message: 'The retained fictional confirmation still applies.',
                self: {
                  ...identityReview.self,
                  version: identityReview.self.version + 1,
                  fullName: 'Rowan Ellis',
                  birthDate: '1988-04-12',
                },
                offeredSelfFields: {},
                scope: { ...identityReview.scope!, intakeVersion: intake.version + 1, targets: [] },
              },
        );
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: 'IDENTITY_ALREADY_RESOLVED',
              message: 'This fictional identity is already resolved.',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );

  await openPersonContext();
  await user.click(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await openPersonContext();
  expect(
    await screen.findByText(
      'This report identity was already confirmed. No additional confirmation was recorded.',
    ),
  ).toBeVisible();
  expect(await screen.findByText('This report already matches Self.')).toBeVisible();
  expect(screen.queryByText(/confirm again/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
  expect(identityPosts).toBe(1);
});

it('disables deep-linked identity confirmation while a restored page refreshes current policy', async () => {
  selectProfile({ id: 'fictional-detail-history', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let releaseIdentity!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(identityReview);
        return new Promise<Response>((resolve) => {
          releaseIdentity = resolve;
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  await openPersonContext();
  expect(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  ).toBeEnabled();

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'This is me and add selected details' }),
    ).toBeNull(),
  );
  expect(screen.getByText('Checking retained identity evidence…')).toBeVisible();

  releaseIdentity(
    response({
      ...identityReview,
      status: 'prior_confirmation',
      blocking: false,
      message: 'The retained fictional confirmation still applies.',
      self: {
        ...identityReview.self,
        version: identityReview.self.version + 1,
        fullName: 'Rowan Ellis',
        birthDate: '1988-04-12',
      },
      offeredSelfFields: {},
      scope: { ...identityReview.scope!, intakeVersion: intake.version + 1, targets: [] },
    }),
  );
  expect(await screen.findByText('This report already matches Self.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
});

it('keeps a restored stale identity action unavailable when refresh fails', async () => {
  selectProfile({ id: 'fictional-detail-refresh-failure', name: 'Rowan', placebo: true });
  let identityReads = 0;
  let identityPosts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(reportDetail);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(identityReview);
        if (identityReads === 2)
          return new Response(
            JSON.stringify({
              error: { code: 'FICTIONAL_UNAVAILABLE', message: 'Identity refresh unavailable.' },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        return response({
          ...identityReview,
          status: 'prior_confirmation',
          blocking: false,
          message: 'The retained fictional confirmation still applies.',
          self: {
            ...identityReview.self,
            version: identityReview.self.version + 1,
            fullName: 'Rowan Ellis',
            birthDate: '1988-04-12',
          },
          offeredSelfFields: {},
          scope: { ...identityReview.scope!, intakeVersion: intake.version + 1, targets: [] },
        });
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts += 1;
        return response(intake);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  await openPersonContext();
  expect(
    await screen.findByRole('button', { name: 'This is me and add selected details' }),
  ).toBeEnabled();

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  expect(await screen.findByRole('button', { name: 'Retry identity check' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
  expect(identityPosts).toBe(0);

  await user.click(screen.getByRole('button', { name: 'Retry identity check' }));
  expect(await screen.findByText('This report already matches Self.')).toBeVisible();
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
  expect(identityPosts).toBe(0);
});

it('keeps report-scoped source confirmation available from exact Import detail', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const requests: { url: string; body?: string }[] = [];
  const sourceDetail: IntakeReportQueueDetail = {
    ...reportDetail,
    group: {
      ...reportDetail.group,
      source: null,
      sourceLabelScope: {
        contextId: 'fictional-source-scope',
        evidence: {
          label: 'Page 1 source heading',
          locator: 'page 1',
          contentUrl: '/api/sources/fictional-intake/content#page=1',
        },
      },
    },
  };
  const sourceReview: IntakeReportSourceReview = {
    profileId: 'fictional-profile',
    intakeId: 'fictional-intake',
    intakeVersion: intake.version,
    groupId: 'fictional-report',
    groupVersionId: 'fictional-report-v1',
    view: 'all',
    scopeToken: 'fictional-source-scope-token',
    coverage: {
      total: 1,
      covered: 0,
      uncovered: 1,
      status: 'uncovered',
      bySource: [],
    },
    sourceEvidence: [],
    targets: [
      {
        id: 'fictional-source-target',
        candidateId: 'fictional-candidate',
        candidateVersionId: 'fictional-candidate-v1',
        occurrence: {
          proposalId: 'fictional-proposal',
          recordId: 'fictional-record',
          batchId: null,
          locator: 'page 1',
        },
        sourceRef: {
          groupId: 'fictional-report',
          groupVersionId: 'fictional-report-v1',
          contributionId: 'fictional-contribution',
          contextId: 'fictional-source-scope',
          fingerprint: 'fictional-source-ref-fingerprint',
        },
        title: 'Ferritin',
        date: '2026-04-12',
        kind: 'observation',
        effectiveSource: null,
      },
    ],
  };
  const refreshedSourceReview: IntakeReportSourceReview = {
    ...sourceReview,
    intakeVersion: intake.version + 1,
    scopeToken: 'fictional-source-scope-token-refreshed',
    coverage: { ...sourceReview.coverage, total: 2, uncovered: 2 },
    targets: [
      ...sourceReview.targets,
      {
        ...sourceReview.targets[0],
        id: 'fictional-source-target-second',
        occurrence: {
          ...sourceReview.targets[0].occurrence,
          proposalId: 'fictional-proposal-second',
          recordId: 'fictional-record-second',
          locator: 'page 2',
        },
        title: 'Fictional transferrin',
      },
    ],
  };
  let sourceReviewReads = 0;
  const onUseSource = vi
    .fn<
      (
        groupId: string,
        source: string,
        displayedReview?: IntakeReportSourceReview,
      ) => Promise<string | null>
    >()
    .mockResolvedValueOnce('The exact source scope changed. Review it again.')
    .mockResolvedValueOnce(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/intakes/report-queue/fictional-report')) return response(sourceDetail);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/report-source-review')) {
        sourceReviewReads += 1;
        if (sourceReviewReads === 1)
          return new Response(
            JSON.stringify({
              error: { code: 'UNAVAILABLE', message: 'Fictional source preflight unavailable.' },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        return response(sourceReviewReads === 2 ? sourceReview : refreshedSourceReview);
      }
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.endsWith('/intakes/fictional-intake/report-source'))
        return response({ intake, confirmation: {} });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={onUseSource}
    />,
  );

  await openSourceContext();
  const label = await screen.findByLabelText('Report label');
  expect(
    screen.getByText(/Add a source for this report and eligible results you save/),
  ).toBeVisible();
  expect(screen.getByText(/Original issuer and upload history stay unchanged/)).toBeVisible();
  await user.type(label, 'Fictional Juniper Lab');
  expect(await screen.findByRole('alert')).toHaveTextContent(/source preflight unavailable/);
  await user.click(screen.getByRole('button', { name: 'Retry affected records' }));
  expect(label).toHaveValue('Fictional Juniper Lab');
  expect(
    await screen.findByRole('button', { name: 'Use report label for 1 record' }),
  ).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Use report label for 1 record' }));
  expect(
    await screen.findByRole('button', { name: 'Use report label for 2 records' }),
  ).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/exact source scope changed/);
  expect(label).toHaveValue('Fictional Juniper Lab');
  await user.click(screen.getByRole('button', { name: 'Use report label for 2 records' }));
  await waitFor(() =>
    expect(onUseSource).toHaveBeenLastCalledWith(
      'fictional-report',
      'Fictional Juniper Lab',
      refreshedSourceReview,
    ),
  );
  expect(onUseSource).toHaveBeenCalledTimes(2);
});

it('does not install a late failed-action source preflight into another report', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Rowan', placebo: true });
  const detailFor = (groupId: string, intakeId: string): IntakeReportQueueDetail => ({
    ...reportDetail,
    group: {
      ...reportDetail.group,
      groupId,
      intakeId,
      source: null,
      sourceLabelScope: {
        contextId: `${groupId}-source-context`,
        evidence: { label: `${groupId} source`, locator: 'page 1' },
      },
    },
  });
  const reviewFor = (groupId: string, intakeId: string): IntakeReportSourceReview => ({
    profileId: 'fictional-profile',
    intakeId,
    intakeVersion: 7,
    groupId,
    groupVersionId: reportDetail.group.groupVersionId,
    view: 'all',
    scopeToken: `${groupId}-scope-token`,
    coverage: { total: 1, covered: 0, uncovered: 1, status: 'uncovered', bySource: [] },
    sourceEvidence: [],
    targets: [
      {
        id: `${groupId}-target`,
        candidateId: 'fictional-candidate',
        candidateVersionId: 'fictional-candidate-v1',
        occurrence: {
          proposalId: 'fictional-proposal',
          recordId: 'fictional-record',
          batchId: null,
          locator: 'page 1',
        },
        sourceRef: {
          groupId,
          groupVersionId: reportDetail.group.groupVersionId,
          contributionId: `${groupId}-contribution`,
          contextId: `${groupId}-source-context`,
          fingerprint: `${groupId}-fingerprint`,
        },
        title: `${groupId} record`,
        date: '2026-04-12',
        kind: 'observation',
        effectiveSource: null,
      },
    ],
  });
  const reviewA = reviewFor('fictional-report-a', 'fictional-intake-a');
  const reviewB = reviewFor('fictional-report-b', 'fictional-intake-b');
  const lateA = {
    ...reviewA,
    scopeToken: 'fictional-report-a-late-token',
    coverage: { ...reviewA.coverage, total: 2, uncovered: 2 },
    targets: [...reviewA.targets, { ...reviewA.targets[0], id: 'fictional-report-a-late-target' }],
  };
  let resolveLateA!: (value: Response) => void;
  let aReviewReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/report-queue/fictional-report-a'))
        return response(detailFor('fictional-report-a', 'fictional-intake-a'));
      if (url.includes('/report-queue/fictional-report-b'))
        return response(detailFor('fictional-report-b', 'fictional-intake-b'));
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('groupId=fictional-report-a')) {
        aReviewReads += 1;
        if (aReviewReads === 1) return response(reviewA);
        return new Promise<Response>((resolve) => {
          resolveLateA = resolve;
        });
      }
      if (url.includes('groupId=fictional-report-b')) return response(reviewB);
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const onUseSource = vi.fn(async () => 'The exact source scope changed. Review it again.');
  const { rerender } = render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report-a', intakeId: 'fictional-intake-a' }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={onUseSource}
    />,
  );
  const user = userEvent.setup();
  await openSourceContext();
  const label = await screen.findByLabelText('Report label');
  await user.type(label, 'Fictional source A');
  await user.click(await screen.findByRole('button', { name: 'Use report label for 1 record' }));
  await waitFor(() => expect(aReviewReads).toBe(2));

  rerender(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report-b', intakeId: 'fictional-intake-b' }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={onUseSource}
    />,
  );
  expect(
    await screen.findByRole('button', { name: 'Use report label for 1 record' }),
  ).toBeVisible();
  resolveLateA(response(lateA));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Use report label for 2 records' })).toBeNull(),
  );
});

it('shows the applied source consistently over a retained original issuer and old suggestion', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Cookie', placebo: true });
  const coverage = {
    total: 1,
    covered: 1,
    uncovered: 0,
    status: 'single' as const,
    bySource: [{ source: 'Cookie Clinic', count: 1 }],
  };
  const sourceDetail: IntakeReportQueueDetail = {
    ...reportDetail,
    group: {
      ...reportDetail.group,
      source: 'Fictional original issuer',
      sourceSuggestion: {
        value: 'Fictional old suggestion',
        contextId: 'fictional-context',
        evidence: { label: 'Original issuer', locator: 'page 1' },
      },
      sourceCoverage: {
        current: coverage,
        saved: { total: 0, covered: 0, uncovered: 0, status: 'empty', bySource: [] },
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/report-queue/fictional-report')) return response(sourceDetail);
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/report-source-review'))
        return response({ targets: [], coverage, sourceEvidence: ['Fictional original issuer'] });
      if (url.includes('/intakes/people/fictional-report'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      return response(intake);
    }),
  );
  const onUseSource = vi.fn();
  render(
    <ImportDetailReview
      selection={{ groupId: 'fictional-report', intakeId: intake.id }}
      onBack={() => {}}
      onChanged={() => {}}
      onUseSource={onUseSource}
    />,
  );
  const change = await screen.findByRole('button', { name: 'Change source for this report' });
  expect(change).toHaveTextContent('Cookie Clinic');
  expect(change).not.toHaveTextContent('Suggested');
  fireEvent.click(change);
  expect(await screen.findByLabelText('Report label')).toHaveValue('Cookie Clinic');
  expect(screen.getByText(/Reviewed source: Cookie Clinic\./)).toBeVisible();
  expect(screen.queryByText(/Suggested source—not applied yet/)).toBeNull();
  expect(onUseSource).not.toHaveBeenCalled();
});

it('keeps a detailed dirty source transcription open and blocks acceptance, later and close', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Cookie Doe', placebo: true });
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        posts.push(url);
        return response(intake);
      }
      if (url.includes('/source-preview'))
        return response({ text: 'Cookie Doe original unit 5.8 mg.' });
      if (url.endsWith('/source-text'))
        return response({
          status: 'available',
          summary: {
            pages: 1,
            spans: 1,
            unresolved: 1,
            exceptions: 0,
            inspectedPages: 0,
            status: 'needs-review',
          },
          revision: {
            format: 'intake-source-text-v1',
            id: 'cookie-text-one',
            parentRevisionId: null,
            profileId: 'fictional-profile',
            intakeId: intake.id,
            sourceHash: 'a'.repeat(64),
            createdAt: '2026-09-27T00:00:00Z',
            adapter: { name: 'fictional', version: '1' },
            pages: [{ page: 1, disposition: 'extracted', inspected: false }],
            spans: [
              {
                id: 'cookie-span',
                text: 'Cookie Doe original unit 5.8 mg.',
                region: { page: 1 },
                provenance: 'native',
              },
            ],
            issues: [],
            relations: [],
            protectedPages: [],
            review: null,
          },
        });
      if (url.includes('/intakes/report-queue/')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: 'evidenced_match',
          blocking: false,
          offeredSelfFields: {},
        });
      if (url.includes('/intakes/people/'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/review')) return response(review);
      if (url.includes('/related-records')) return response({ records: [], nextCursor: null });
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      return response([]);
    }),
  );
  const onBack = vi.fn();
  render(
    <ImportDetailReview
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={onBack}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  const accept = await screen.findByRole('button', { name: 'Confirm and save record' });
  expect(accept).toBeEnabled();
  const disclosure = screen.getByText('Extracted text & corrections').closest('details')!;
  disclosure.open = true;
  fireEvent(disclosure, new Event('toggle'));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Cookie Doe unsaved correction 5.8 g.' },
  });
  await waitFor(() => expect(accept).toBeDisabled());
  await userEvent.click(
    within(accept.parentElement!).getByRole('button', { name: 'Review later' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Back to Import' }));
  expect(screen.getByDisplayValue('Cookie Doe unsaved correction 5.8 g.')).toBeVisible();
  expect(screen.getByText('Save or discard the source text draft before leaving.')).toBeVisible();
  expect(onBack).not.toHaveBeenCalled();
  expect(posts.filter((url) => !url.endsWith('/import-diagnostics'))).toEqual([]);
});

it('shows all core fields and resolves only the edited uncertainty without accepting or changing identity', async () => {
  selectProfile({ id: 'fictional-profile', name: 'Cookie Doe', placebo: true });
  const pending = {
    ...record,
    issues: [
      {
        id: 'cookie-value',
        kind: 'uncertain_reading' as const,
        field: 'valueText',
        prompt: 'Verify this result.',
        blocking: true,
        status: 'unresolved' as const,
        locator: 'page 2',
        questionId: null,
      },
      {
        id: 'cookie-date',
        kind: 'date' as const,
        field: 'date',
        prompt: 'Verify the date.',
        blocking: true,
        status: 'unresolved' as const,
        locator: 'page 2',
        questionId: null,
      },
      {
        id: 'cookie-identity',
        kind: 'identity' as const,
        field: 'subject',
        prompt: 'Does this record belong to you?',
        blocking: true,
        status: 'unresolved' as const,
        locator: 'page 2',
        questionId: null,
      },
    ],
  };
  const writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return response({ ...intake, version: 8 });
      }
      if (url.includes('/intakes/report-queue/'))
        return response({ ...reportDetail, blocks: [{ ...block, records: [pending] }] });
      if (url.includes('/identity-review')) return response(identityReview);
      if (url.includes('/intakes/people/'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/review')) return response({ ...review, records: [pending] });
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      return response([]);
    }),
  );
  const onBack = vi.fn();
  render(
    <ImportDetailReview
      embedded
      selection={{
        groupId: 'fictional-report',
        intakeId: intake.id,
        proposalId: block.proposalId,
        recordId: record.id,
      }}
      onBack={onBack}
      onChanged={() => {}}
      onUseSource={() => {}}
    />,
  );
  const result = await screen.findByRole('textbox', { name: 'Result' });
  expect(screen.getByRole('textbox', { name: 'Test name' })).toHaveValue('Ferritin');
  expect(screen.getByRole('textbox', { name: 'Unit' })).toHaveValue('ng/mL');
  expect(screen.getByLabelText('Date', { exact: true })).toHaveAttribute('type', 'date');
  expect(screen.queryByText('Does this record belong to you?')).toBeNull();
  expect(screen.queryByText('Extracted text & corrections')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm and save record' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review later' })).toBeNull();
  fireEvent.change(result, { target: { value: '43' } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(writes.filter((write) => write.url.endsWith('/review-draft'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  const draftWrites = writes.filter((write) => write.url.endsWith('/review-draft'));
  expect(draftWrites).toHaveLength(1);
  expect(draftWrites[0].body.mapping.valueText).toBe('43');
  expect(draftWrites[0].body.mapping.unit).toBe('ng/mL');
  expect(draftWrites[0].body.resolutions).toEqual([
    { issueId: 'cookie-value', outcome: 'corrected', mapping: { valueText: '43' } },
  ]);
  expect(writes.some((write) => /accept|identity-scope/.test(write.url))).toBe(false);
});

for (const foreignChange of [false, true])
  it(`waits for the displayed own-draft authority before approval, preserving foreign-change rejection (${foreignChange})`, async () => {
    selectProfile({ id: 'fictional-approval-refresh', name: 'Rowan', placebo: true });
    let updated = false;
    let holdRefresh = true;
    let substituteForeign = false;
    const releases: (() => void)[] = [];
    const acceptanceBodies: {
      operationId: string;
      blocks: { selections: { selectionReviewToken: string; mapping: { valueText: string } }[] }[];
    }[] = [];
    const currentReview = () => ({
      ...review,
      version: updated ? 8 : 7,
      records: [
        {
          ...record,
          selectionReviewToken: substituteForeign
            ? 'foreign-source-token'
            : updated
              ? 'reviewed-own-patch'
              : 'original-token',
          mapping: { ...record.mapping, valueText: updated ? '43' : '42' },
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/review-draft') && init?.method === 'POST') {
          updated = true;
          return response({ ...intake, version: 8 });
        }
        if (url.includes('/intakes/fictional-intake/review')) {
          if (updated && holdRefresh) await new Promise<void>((resolve) => releases.push(resolve));
          return response(currentReview());
        }
        if (url.endsWith('/intakes/report-acceptance')) {
          const body = JSON.parse(String(init?.body));
          acceptanceBodies.push(body);
          return response(acceptedResult(body.operationId));
        }
        if (url.includes('/intakes/report-queue/')) return response(reportDetail);
        if (url.includes('/identity-review'))
          return response({
            ...identityReview,
            status: 'evidenced_match',
            blocking: false,
            offeredSelfFields: {},
          });
        if (url.includes('/intakes/people/'))
          return response({
            groupId: 'fictional-report',
            people: [],
            totalPeople: 0,
            peopleNextCursor: null,
          });
        if (url.endsWith('/intakes/fictional-intake'))
          return response({ ...intake, version: updated ? 8 : 7 });
        return response([]);
      }),
    );
    render(
      <MemoryRouter>
        <ImportDetailReview
          selection={{
            groupId: 'fictional-report',
            intakeId: intake.id,
            proposalId: block.proposalId,
            recordId: record.id,
          }}
          onBack={() => {}}
          onChanged={() => {}}
          onUseSource={() => {}}
        />
      </MemoryRouter>,
    );
    const save = await screen.findByRole('button', { name: 'Confirm and save record' });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Result', { exact: true }), { target: { value: '43' } });
    await waitFor(() => expect(releases.length).toBeGreaterThan(0));
    // An acknowledged autosave is not yet displayed approval authority. Do not
    // invite an approval click while its old token is still on screen.
    expect(save).toBeDisabled();
    expect(acceptanceBodies).toHaveLength(0);
    await act(async () => {
      holdRefresh = false;
      for (const release of releases) release();
    });
    await waitFor(() => expect(save).toBeEnabled());
    substituteForeign = foreignChange;
    await userEvent.click(save);
    if (foreignChange) {
      expect(
        await screen.findByText(
          'This exact record changed. Review the current proposal before saving.',
        ),
      ).toBeVisible();
      expect(acceptanceBodies).toHaveLength(0);
    } else {
      expect(await screen.findByText('This exact record was saved to your profile.')).toBeVisible();
      expect(acceptanceBodies).toHaveLength(1);
      expect(acceptanceBodies[0]!.blocks[0]!.selections[0]!).toMatchObject({
        selectionReviewToken: 'reviewed-own-patch',
        mapping: { valueText: '43' },
      });
    }
  });

it('recovers the exact second saved sibling from a partial bulk receipt before review refresh catches up', async () => {
  const profileId = 'fictional-second-sibling-recovery';
  selectProfile({ id: profileId, name: 'Rowan', placebo: true });
  const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  sessionStorage.setItem(`circus-health:report-acceptance:${profileId}`, operationId);
  const base = acceptedResult(operationId);
  const second = base.receipt.receipts[0]!;
  const first = {
    ...second,
    records: [
      {
        ...second.records[0]!,
        recordId: 'first-sibling',
        candidateId: 'first-candidate',
        candidateVersionId: 'first-version',
        entityId: 'first-saved-entity',
        title: 'First fictional sibling',
      },
    ],
  };
  const recovered: IntakeReportAcceptanceResult = {
    ...base,
    replayed: true,
    receipt: {
      ...base.receipt,
      version: 1,
      atomic: false,
      status: 'completed',
      selectedCount: 2,
      acceptedCount: 2,
      receipts: [first, second],
      items: [first, second].map((receipt, i) => ({
        status: 'saved',
        intakeId: receipt.intakeId,
        proposalId: receipt.proposalId,
        recordId: receipt.records[0]!.recordId,
        candidateId: receipt.records[0]!.candidateId,
        candidateVersionId: receipt.records[0]!.candidateVersionId,
        operationId: `fictional-child-${i}`,
        selectionReviewToken: 'fictional-token',
        reviewedSelectionHash: 'fictional-hash',
        receipt,
      })),
    },
  };
  let acceptancePosts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/intakes/report-acceptance') && init?.method === 'POST') acceptancePosts++;
      if (url.includes('/intakes/report-acceptance/')) return response(recovered);
      if (url.includes('/intakes/report-queue/')) return response(reportDetail);
      if (url.includes('/identity-review'))
        return response({
          ...identityReview,
          status: 'evidenced_match',
          blocking: false,
          offeredSelfFields: {},
        });
      if (url.includes('/intakes/people/'))
        return response({
          groupId: 'fictional-report',
          people: [],
          totalPeople: 0,
          peopleNextCursor: null,
        });
      if (url.includes('/intakes/fictional-intake/review')) return response(review);
      if (url.endsWith('/intakes/fictional-intake')) return response(intake);
      if (url.includes('/record-owner')) return response({ personId: 'patient' });
      return response([]);
    }),
  );
  render(
    <MemoryRouter>
      <ImportDetailReview
        selection={{
          groupId: 'fictional-report',
          intakeId: intake.id,
          proposalId: block.proposalId,
          recordId: record.id,
        }}
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText('This exact record was saved to your profile.')).toBeVisible();
  const destination = await screen.findByRole('region', { name: 'Saved destination' });
  expect(within(destination).getByRole('link')).toHaveAttribute(
    'href',
    '/tests?result=fictional-saved-ferritin&visibility=all',
  );
  expect(screen.queryByRole('button', { name: 'Confirm and save record' })).toBeNull();
  expect(screen.queryByText('This record needs review before saving.')).toBeNull();
  expect(acceptancePosts).toBe(0);
});

it('uses exact section controls for native selected-record related discovery without a legacy full-review request', async () => {
  selectProfile({ id: 'fictional-native-related', name: 'Rowan', placebo: true });
  const selected = { ...record, selectionReviewToken: 'selected-native-token' };
  const nativeContext = {
    intakeId: intake.id,
    proposalId: block.proposalId,
    version: intake.version,
    reviewToken: block.reviewToken,
    summary: review.summary,
    sourceTextStale: false,
  };
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/review-record?'))
        return response({
          format: 'health-intake-clinical-record-v2',
          context: nativeContext,
          record: { kind: 'record', record: selected },
        });
      if (url.endsWith(`/intakes/${intake.id}`)) return response(intake);
      if (url.endsWith('/review-record-section')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          recordId: record.id,
          candidateVersionId: record.candidateVersionId,
          section: 'comparisons',
          comparisonSearch: { query: '', limit: 20 },
        });
        return response({
          format: 'health-clinical-record-section-page-v1',
          context: nativeContext,
          selection: {
            proposalId: block.proposalId,
            recordId: record.id,
            candidateVersionId: record.candidateVersionId,
            selectionReviewToken: selected.selectionReviewToken,
          },
          section: 'comparisons',
          items: [],
          total: 0,
          nextCursor: null,
          discoveryPage: {
            query: '',
            limit: 20,
            returned: 0,
            hasMore: false,
            nextCursor: null,
            truncated: false,
            maximumResults: 200,
          },
        });
      }
      throw new Error(`Unexpected native selected request ${url}`);
    }),
  );
  render(
    <MemoryRouter>
      <ImportRecordDetail
        groupId="fictional-report"
        block={block}
        recordId={record.id}
        identityPanel={null}
        identityRevision={0}
        sourcePanel={null}
        commonIdentityIssueIds={new Set()}
        sourceError=""
        onBack={() => {}}
        onChanged={() => {}}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Find possible related saved records'));
  expect(screen.getByRole('region', { name: 'Paired evidence review' })).toBeVisible();
  expect(await screen.findByLabelText('Search related saved records')).toBeVisible();
  expect(screen.getByText('0 related records in this search result window.')).toBeVisible();
  expect(requests.some((url) => url.includes('/related-records'))).toBe(false);
});

it.each([false, true])(
  'accepts the retained native relationship only with its displayed exact authority (foreign change=%s)',
  async (foreignChange) => {
    selectProfile({ id: 'fictional-native-pair-approval', name: 'Rowan', placebo: true });
    let version = intake.version;
    let selected = { ...record, selectionReviewToken: 'native-before-pair' };
    let substituteForeign = false;
    const actions: ClinicalRecordAction[] = [];
    const acceptances: Record<string, any>[] = [];
    const context = () => ({
      intakeId: intake.id,
      proposalId: block.proposalId,
      version,
      reviewToken: `native-review-${version}`,
      summary: review.summary,
      sourceTextStale: false,
    });
    const retainedChoice = {
      otherRecordId: 'fictional-saved-marker',
      outcome: 'distinct' as const,
      reason: 'Separate fictional source identifiers; retain both literal values.',
      scope: {
        format: 'intake-pair-scope-v1' as const,
        profileId: 'fictional-native-pair-approval',
        incoming: {
          kind: 'observation' as const,
          sourceRecordId: record.id,
          identity: 'fictional-incoming',
          version: 'fictional-incoming-v1',
          stateHash: 'fictional-incoming-state',
          evidenceHash: 'fictional-incoming-evidence',
        },
        saved: {
          kind: 'observation' as const,
          recordId: 'fictional-saved-marker',
          sourceRecordId: 'fictional-saved-source',
          identity: 'fictional-saved',
          version: 'fictional-saved-v1',
          stateHash: 'fictional-saved-state',
          evidenceHash: 'fictional-saved-evidence',
        },
        token: 'fictional-exact-pair-scope',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.includes('/review-record?'))
          return response({
            format: 'health-intake-clinical-record-v2',
            context: context(),
            record: {
              kind: 'record',
              record: substituteForeign
                ? { ...selected, selectionReviewToken: 'foreign-native-source-token' }
                : selected,
            },
          });
        if (url.endsWith(`/intakes/${intake.id}`)) return response({ ...intake, version });
        if (url.endsWith('/review-record-section')) {
          const command = JSON.parse(String(init?.body));
          return response({
            format: 'health-clinical-record-section-page-v1',
            context: context(),
            selection: {
              proposalId: block.proposalId,
              recordId: record.id,
              candidateVersionId: record.candidateVersionId!,
              selectionReviewToken: selected.selectionReviewToken,
            },
            section: command.section,
            total: 1,
            nextCursor: null,
            items: [
              {
                ordinal: 0,
                control: {
                  kind: 'pair',
                  otherRecordId: retainedChoice.otherRecordId,
                  scopeToken: retainedChoice.scope.token,
                  targetAvailable: true,
                  reasonReferenced: false,
                  draftScopeStatus: actions.length ? 'current' : 'none',
                  ...(actions.length ? retainedChoice : {}),
                },
                detail: {
                  kind: 'value',
                  value: {
                    comparison: {
                      id: retainedChoice.otherRecordId,
                      title: 'Fictional saved marker',
                      kind: 'observation',
                      mapping: { ...record.mapping, valueText: '41' },
                      evidence: [],
                    },
                  },
                },
              },
            ],
          } satisfies ClinicalRecordSectionPage);
        }
        if (url.endsWith('/review-record-action')) {
          const command = JSON.parse(String(init?.body)) as ClinicalRecordAction;
          actions.push(command);
          expect(command.pair).toMatchObject({
            otherRecordId: retainedChoice.otherRecordId,
            scopeToken: retainedChoice.scope.token,
            outcome: retainedChoice.outcome,
            reason: retainedChoice.reason,
          });
          version++;
          selected = {
            ...selected,
            selectionReviewToken: 'native-retained-pair',
            draft: {
              id: command.operationId,
              proposalId: block.proposalId,
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: {},
              disposition: 'pending',
              at: '2026-10-04T00:00:00Z',
              resolutions: [],
              decision: {
                recordId: record.id,
                action: 'accept',
                mapping: {},
                comparisons: [retainedChoice],
              },
            },
            comparisonDrafts: [{ otherRecordId: retainedChoice.otherRecordId, status: 'current' }],
          };
          return response({ ...intake, version });
        }
        if (url.endsWith('/intakes/report-acceptance')) {
          const command = JSON.parse(String(init?.body));
          acceptances.push(command);
          return response(acceptedResult(command.operationId));
        }
        if (url.endsWith('/test-types') || url.endsWith('/rules')) return response([]);
        if (url.includes('/accepted-records')) return response([]);
        if (url.includes('/record-owner')) return response({ personId: 'patient' });
        throw new Error(`Unexpected native pair request ${url}`);
      }),
    );
    render(
      <MemoryRouter>
        <ImportRecordDetail
          groupId="fictional-report"
          block={block}
          recordId={record.id}
          identityPanel={null}
          identityRevision={0}
          sourcePanel={null}
          commonIdentityIssueIds={new Set()}
          sourceError=""
          onBack={() => {}}
          onChanged={() => {}}
          onUseSource={() => {}}
        />
      </MemoryRouter>,
    );
    const save = await screen.findByRole('button', { name: 'Confirm and save record' });
    fireEvent.click(screen.getByText('Find possible related saved records'));
    const relationship = await screen.findByRole('group', {
      name: 'Relationship with this record',
    });
    fireEvent.change(within(relationship).getByRole('combobox'), { target: { value: 'distinct' } });
    fireEvent.change(within(relationship).getByLabelText('Reason for this relationship'), {
      target: { value: retainedChoice.reason },
    });
    expect(save).toBeDisabled();
    fireEvent.click(within(relationship).getByRole('button', { name: 'Save this relationship' }));
    await waitFor(() => expect(actions).toHaveLength(1));
    await waitFor(() => expect(save).toBeEnabled());
    substituteForeign = foreignChange;
    await userEvent.click(save);
    if (foreignChange) {
      expect(
        await screen.findByText(
          'This exact record changed. Review the current proposal before saving.',
        ),
      ).toBeVisible();
      expect(acceptances).toHaveLength(0);
    } else {
      expect(await screen.findByText('This exact record was saved to your profile.')).toBeVisible();
      expect(acceptances).toHaveLength(1);
      expect(acceptances[0]).toMatchObject({ mode: 'partial-v1' });
      expect(acceptances[0]!.blocks[0].selections).toEqual([
        {
          recordId: record.id,
          candidateId: record.candidateId,
          candidateVersionId: record.candidateVersionId,
          selectionReviewToken: 'native-retained-pair',
          mapping: {},
          useRetainedDecision: true,
        },
      ]);
    }
  },
);
it('keeps the selected record mounted and report retry actionable while an external report command is uncertain', async () => {
  selectProfile({ id: 'fictional-external-pending', name: 'Fictional Reader', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/review-record?'))
        return response({
          format: 'health-intake-clinical-record-v2',
          context: {
            intakeId: intake.id,
            proposalId: block.proposalId,
            version: intake.version,
            reviewToken: block.reviewToken,
            summary: review.summary,
            sourceTextStale: false,
          },
          record: { kind: 'record', record },
        });
      if (url.endsWith('/intakes/' + intake.id)) return response(intake);
      if (url.includes('/test-types')) return response([]);
      if (url.includes('/rules')) return response([]);
      throw new Error('Unexpected ' + url);
    }),
  );
  const back = vi.fn(),
    retry = vi.fn();
  const beforeClose = { current: null as (() => Promise<boolean>) | null };
  const props = {
    groupId: 'fictional-report',
    block,
    recordId: record.id,
    identityPanel: <button onClick={retry}>Retry exact report command</button>,
    identityRevision: 7,
    sourcePanel: null,
    commonIdentityIssueIds: new Set<string>(),
    sourceError: '',
    onBack: back,
    onChanged: () => {},
    onUseSource: () => {},
    beforeCloseRef: beforeClose,
  };
  const mounted = render(
    <MemoryRouter>
      <ImportRecordDetail {...props} contextPending />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Ferritin' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Import' }));
  expect(back).not.toHaveBeenCalled();
  expect(await beforeClose.current?.()).toBe(false);
  const retryButton = screen.getByRole('button', { name: 'Retry exact report command' });
  expect(retryButton).toBeEnabled();
  fireEvent.click(retryButton);
  expect(retry).toHaveBeenCalledOnce();
  mounted.rerender(
    <MemoryRouter>
      <ImportRecordDetail {...props} contextPending={false} />
    </MemoryRouter>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Back to Import' }));
  await waitFor(() => expect(back).toHaveBeenCalledOnce());
});

it.each(['saved', 'foreign revision', 'lost reply', 'scope change', 'unmount'] as const)(
  'publishes native acceptance intent only on explicit approval after correcting an unsupported record (%s)',
  async (outcome) => {
    const profileId = 'fictional-corrected-acceptance';
    selectProfile({ id: profileId, name: 'Fictional Reader', placebo: true });
    let version = intake.version;
    let revision = 40;
    let selected: IntakeReportQueueRecord = {
      ...record,
      classification: 'unsupported',
      selectionReviewToken: 'fictional-unsupported-token',
    };
    const writes: Record<string, any>[] = [];
    const acceptances: Record<string, any>[] = [];
    let heldReads = 0;
    let releasedRead = false;
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const operations = new Map<string, { version: number; revision: number }>();
    const context = () => ({
      intakeId: intake.id,
      proposalId: block.proposalId,
      version,
      reviewToken: `fictional-current-review-${version}`,
      summary: review.summary,
      sourceTextStale: false,
    });
    const reply = (data: unknown, at = revision) =>
      new Response(JSON.stringify({ data, meta: { revision: at } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.includes('/review-record?')) {
          if (
            (outcome === 'scope change' || outcome === 'unmount') &&
            writes.some((write) => write.decision.action === 'accept') &&
            !releasedRead
          ) {
            heldReads++;
            await readGate;
          }
          return reply({
            format: 'health-intake-clinical-record-v2',
            context: context(),
            record: { kind: 'record', record: selected },
          });
        }
        if (url.endsWith('/review-draft')) {
          const command = JSON.parse(String(init?.body));
          writes.push(command);
          const prior = operations.get(command.operationId);
          if (prior) return reply({ ...intake, version: prior.version }, prior.revision);
          const fromVersion = version;
          const fromRevision = revision;
          expect(command.version).toBe(version);
          version++;
          revision++;
          operations.set(command.operationId, { version, revision });
          selected = {
            ...selected,
            classification: 'addition',
            selectionReviewToken: `fictional-corrected-token-${version}`,
            mapping: { ...selected.mapping, ...command.mapping },
            draft: {
              id: command.operationId,
              proposalId: block.proposalId,
              recordId: record.id,
              candidateId: record.candidateId!,
              candidateVersionId: record.candidateVersionId!,
              mapping: command.mapping,
              disposition: command.disposition,
              decision: command.decision,
              resolutions: command.resolutions,
              answers: command.answers,
              at: '2026-10-04T00:00:00Z',
            },
          };
          const certifiedRevision = revision;
          if (command.decision.action === 'accept' && outcome === 'lost reply')
            throw new TypeError('Fictional lost acceptance-intent acknowledgement');
          if (command.decision.action === 'accept' && outcome === 'foreign revision') revision++;
          return reply(
            {
              ...intake,
              version,
              reviewDraftTransition: {
                format: 'health-intake-own-draft-transition-v1',
                profileId,
                intakeId: intake.id,
                proposalId: block.proposalId,
                recordId: record.id,
                candidateId: record.candidateId,
                candidateVersionId: record.candidateVersionId,
                operationId: command.operationId,
                fromVersion,
                toVersion: version,
                fromRevision,
                toRevision: certifiedRevision,
              },
            },
            certifiedRevision,
          );
        }
        if (url.endsWith(`/intakes/${intake.id}`)) return reply({ ...intake, version });
        if (url.endsWith('/review-record-section')) {
          const command = JSON.parse(String(init?.body));
          return reply({
            format: 'health-clinical-record-section-page-v1',
            context: context(),
            selection: {
              proposalId: block.proposalId,
              recordId: record.id,
              candidateVersionId: record.candidateVersionId,
              selectionReviewToken: selected.selectionReviewToken,
            },
            section: command.section,
            total: 0,
            nextCursor: null,
            items: [],
          });
        }
        if (url.endsWith('/intakes/report-acceptance')) {
          const command = JSON.parse(String(init?.body));
          acceptances.push(command);
          expect(selected.draft!.decision!.action).toBe('accept');
          expect(command.blocks[0].selections[0]).toMatchObject({
            selectionReviewToken: selected.selectionReviewToken,
            useRetainedDecision: true,
            mapping: {},
          });
          return reply(acceptedResult(command.operationId));
        }
        if (url.endsWith('/test-types') || url.endsWith('/rules')) return reply([]);
        if (url.includes('/accepted-records')) return reply([]);
        if (url.includes('/record-owner')) return reply({ personId: 'patient' });
        throw new Error(`Unexpected corrected approval request ${url}`);
      }),
    );
    const detail = (groupId = 'fictional-report') => (
      <MemoryRouter>
        <ImportRecordDetail
          groupId={groupId}
          block={block}
          recordId={record.id}
          identityPanel={null}
          identityRevision={0}
          sourcePanel={null}
          commonIdentityIssueIds={new Set()}
          sourceError=""
          onBack={() => {}}
          onChanged={() => {}}
          onUseSource={() => {}}
        />
      </MemoryRouter>
    );
    const view = render(detail());
    const save = await screen.findByRole('button', { name: 'Confirm and save record' });
    fireEvent.change(screen.getByLabelText('Result', { exact: true }), { target: { value: '43' } });
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(save).toBeEnabled());
    expect(selected.classification).toBe('addition');
    expect(selected.draft!.decision!.action).toBe('skip');
    expect(acceptances).toHaveLength(0);
    await userEvent.click(save);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].decision).toEqual({ ...writes[0].decision, action: 'accept' });
    expect(writes[1].mapping).toEqual(writes[0].mapping);
    expect(writes[1].resolutions).toEqual(writes[0].resolutions);
    expect(writes[1].answers).toEqual(writes[0].answers);
    if (outcome === 'scope change' || outcome === 'unmount') {
      await waitFor(() => expect(heldReads).toBeGreaterThan(0));
      if (outcome === 'unmount') view.unmount();
      else {
        view.rerender(detail('fictional-other-report'));
        view.rerender(detail());
      }
      await act(async () => {
        releasedRead = true;
        releaseRead();
      });
      if (outcome === 'unmount') {
        expect(acceptances).toHaveLength(0);
        return;
      }
    }
    if (outcome === 'foreign revision' || outcome === 'scope change') {
      expect(
        await screen.findByText(
          'This exact record changed. Review the current proposal before saving.',
        ),
      ).toBeVisible();
      expect(acceptances).toHaveLength(0);
      return;
    }
    if (outcome === 'lost reply') {
      expect(
        await screen.findByText('Review the saved choices before confirming this record again.'),
      ).toBeVisible();
      expect(acceptances).toHaveLength(0);
      await userEvent.click(screen.getByRole('button', { name: 'Retry draft save' }));
      await waitFor(() => expect(writes).toHaveLength(3));
      expect(writes[2]).toEqual(writes[1]);
      await waitFor(() => expect(save).toBeEnabled());
      expect(acceptances).toHaveLength(0);
      await userEvent.click(save);
    }
    expect(await screen.findByText('This exact record was saved to your profile.')).toBeVisible();
    expect(acceptances).toHaveLength(1);
  },
);
