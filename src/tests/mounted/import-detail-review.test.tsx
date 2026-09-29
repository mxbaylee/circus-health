import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type {
  Intake,
  IntakeReportAcceptanceResult,
  IntakeReportQueueDetail,
  IntakeReportQueueRecord,
  IntakeReportSourceReview,
  IntakeReview,
} from '../../shared/intake';
import type { IntakeIdentityReview } from '../../shared/intake-identity';
import { ImportDetailReview } from '../../app/features/import/ImportDetailReview';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

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
        if (url.includes('/intakes/fictional-intake/review?'))
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
    '#/import?group=fictional-report&intake=fictional-intake&proposal=fictional-proposal&record=fictional-record',
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
