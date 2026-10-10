import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPortal } from 'react-dom';
import { ReferencedClinicalControls } from '../../app/features/intake/ReferencedClinicalControls';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeClinicalReviewContext } from '../../shared/intake-clinical-review';
import type {
  ClinicalRecordAction,
  ClinicalRecordSection,
  ClinicalRecordSectionPage,
} from '../../shared/intake-clinical-record-sections';
const profile = { id: 'fictional-section-editor', name: 'Fictional Reader', placebo: true };
const context: IntakeClinicalReviewContext = {
  intakeId: 'fictional-intake',
  proposalId: 'fictional-proposal',
  version: 7,
  reviewToken: 'review-7',
  summary: { additions: 1, duplicates: 0, unsupported: 0, uncertain: 1 },
  sourceTextStale: false,
};
const selection = {
  recordId: 'fictional-record',
  candidateVersionId: 'version-1',
  selectionReviewToken: 'selection-7',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const page = (
  section: ClinicalRecordSection,
  items: ClinicalRecordSectionPage['items'],
  extra: Partial<ClinicalRecordSectionPage> = {},
): ClinicalRecordSectionPage => ({
  format: 'health-clinical-record-section-page-v1',
  context,
  selection: { ...selection, proposalId: context.proposalId },
  section,
  total: items.length,
  items,
  nextCursor: null,
  ...extra,
});
const issue: ClinicalRecordSectionPage['items'][number] = {
  ordinal: 0,
  control: {
    kind: 'issue',
    id: 'question-1',
    issueKind: 'date',
    field: 'documentDate',
    blocking: true,
    status: 'unresolved',
    mappingKind: 'document',
    resolutionFields: ['date', 'documentDate'],
    fieldValue: '2026-01-02',
    fieldValueReferenced: false,
  },
  detail: {
    kind: 'value',
    value: { prompt: 'Which date is shown in this fictional source?', locator: 'Page 1' },
  },
};
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Resolve questions or correct this record' }));
}

it('a second issue remains actionable after saving and refreshing the same exact record', async () => {
  let current = context;
  const writes: ClinicalRecordAction[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/review-record-section'))
        return json(page('issues', [issue], { context: current }));
      writes.push(JSON.parse(String(init?.body)));
      current = { ...context, version: 8, reviewToken: 'review-8' };
      return json({ version: 8 });
    }),
  );
  const props = { selection, onRefresh: vi.fn(), onPending: () => {} };
  const view = render(<ReferencedClinicalControls context={current} {...props} />);
  await open();
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm current reading' }));
  await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
  view.rerender(<ReferencedClinicalControls context={current} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh exact record controls' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Question 1 · required' })).toBeEnabled(),
  );
});

import { MemoryRouter } from 'react-router-dom';
import { ImportRecordDetail } from '../../app/features/import/ImportDetailReview';

it('fetches a positive-version exact review once and refreshes genuine identity changes across selection switches', async () => {
  const otherProfile = {
    id: 'fictional-second-review',
    name: 'Fictional Second Reader',
    placebo: true,
  };
  replaceProfiles([profile, otherProfile]);
  const reads: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  let releaseFirst!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'http://fictional.test');
      if (url.pathname.endsWith('/review-record')) {
        reads.push({ url, signal: init?.signal });
        if (reads.length === 1) await firstRead;
        const intakeId = decodeURIComponent(url.pathname.split('/').at(-2)!);
        return json({
          format: 'health-intake-clinical-record-v2',
          context: { ...context, intakeId, proposalId: url.searchParams.get('proposalId') },
          record: {
            kind: 'reference',
            reference: {
              format: 'health-intake-clinical-review-reference-v2',
              reviewToken: context.reviewToken,
              section: 'records',
              ordinal: 0,
              bytes: 100000,
            },
            selection: { ...selection, recordId: url.searchParams.get('recordId') },
            policy: {
              canAcceptUnchanged: false,
              blockingIssueCount: 2,
              unreviewedPairChoices: false,
              classification: 'addition',
              kind: 'document',
            },
          },
        });
      }
      const intakeId = decodeURIComponent(url.pathname.split('/').at(-1)!);
      if (url.pathname.includes('/intakes/'))
        return json({
          id: intakeId,
          version: 7,
          filename: 'fictional.txt',
          mimeType: 'text/plain',
          providerId: 'fictional-provider',
          provider: 'Fictional',
          sha256: 'fictional-hash',
          bytes: 100000,
          contentUrl: '/api/sources/fictional/content',
        });
      throw new Error('Unexpected ' + url);
    }),
  );
  let props = {
    groupId: 'fictional-group',
    block: { intakeId: context.intakeId, proposalId: context.proposalId },
    recordId: selection.recordId,
    identityPanel: null,
    identityRevision: 7,
    sourcePanel: null,
    commonIdentityIssueIds: new Set<string>(),
    sourceError: '',
    onBack: () => {},
    onChanged: () => {},
    onUseSource: () => {},
    guardNavigation: false,
  };
  const component = () => (
    <MemoryRouter>
      <ImportRecordDetail {...props} />
    </MemoryRouter>
  );
  const view = render(component());
  await act(async () => {});
  expect(reads).toHaveLength(1);
  expect(reads[0]!.signal?.aborted).toBe(false);
  await act(async () => {
    view.rerender(component());
  });
  expect(reads).toHaveLength(1);
  expect(reads[0]!.signal?.aborted).toBe(false);
  await act(async () => {
    releaseFirst();
  });
  await screen.findByRole('button', { name: 'Resolve questions or correct this record' });
  const refresh = async (next: Partial<typeof props>, count: number) => {
    props = { ...props, ...next };
    await act(async () => {
      view.rerender(component());
    });
    await waitFor(() => expect(reads).toHaveLength(count));
  };
  await refresh({ identityRevision: 7 }, 1);
  await refresh({ identityRevision: 8 }, 2);
  await refresh({ groupId: 'fictional-other-group' }, 2);
  await refresh({ groupId: 'fictional-third-group', identityRevision: 9 }, 3);
  await refresh({ recordId: 'fictional-other-record', identityRevision: 11 }, 4);
  expect(reads.at(-1)!.url.searchParams.get('recordId')).toBe('fictional-other-record');
  await refresh({ identityRevision: 12 }, 5);
  await refresh(
    { block: { ...props.block, intakeId: 'fictional-other-intake' }, identityRevision: 15 },
    6,
  );
  expect(reads.at(-1)!.url.pathname).toContain('/intakes/fictional-other-intake/review-record');
  await refresh({ identityRevision: 16 }, 7);
  await refresh(
    { block: { ...props.block, proposalId: 'fictional-other-proposal' }, identityRevision: 17 },
    8,
  );
  expect(reads.at(-1)!.url.searchParams.get('proposalId')).toBe('fictional-other-proposal');
  await refresh({ identityRevision: 18 }, 9);
  await act(async () => {
    selectProfile(otherProfile);
  });
  await waitFor(() => expect(reads).toHaveLength(10));
  expect(reads.at(-1)!.url.pathname).toContain('/profiles/' + otherProfile.id + '/');
  await refresh({ identityRevision: 19 }, 11);
});

it('failed parent authority refresh retains uncertain giant-record choice for exact retry', async () => {
  let refreshFails = false;
  const writes: ClinicalRecordAction[] = [];
  const giant = {
    kind: 'reference',
    reference: {
      format: 'health-intake-clinical-review-reference-v2',
      reviewToken: context.reviewToken,
      section: 'records',
      ordinal: 0,
      bytes: 100000,
    },
    selection,
    policy: {
      canAcceptUnchanged: false,
      blockingIssueCount: 2,
      unreviewedPairChoices: false,
      classification: 'addition',
      kind: 'document',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/review-record?')) {
        if (refreshFails) throw new TypeError('Fictional refresh network failure');
        return json({ format: 'health-intake-clinical-record-v2', context, record: giant });
      }
      if (url.endsWith('/intakes/' + context.intakeId))
        return json({
          id: context.intakeId,
          version: 7,
          filename: 'fictional.txt',
          mimeType: 'text/plain',
          providerId: 'fictional-provider',
          provider: 'Fictional',
          sha256: 'fictional-hash',
          bytes: 100000,
          contentUrl: '/api/sources/fictional/content',
        });
      if (url.endsWith('/review-record-section')) return json(page('issues', [issue]));
      if (url.endsWith('/review-record-action')) {
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1) throw new TypeError('Fictional uncertain action network failure');
        refreshFails = false;
        return json({ version: 8 });
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  const props = {
    groupId: 'fictional-group',
    block: { intakeId: context.intakeId, proposalId: context.proposalId },
    recordId: selection.recordId,
    identityPanel: null,
    sourcePanel: null,
    commonIdentityIssueIds: new Set<string>(),
    sourceError: '',
    onBack: () => {},
    onChanged: () => {},
    onUseSource: () => {},
  };
  const view = render(
    <MemoryRouter>
      <ImportRecordDetail {...props} identityRevision={0} />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Resolve questions or correct this record' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm current reading' }));
  await screen.findByRole('button', { name: 'Retry exact review choice' });
  refreshFails = true;
  view.rerender(
    <MemoryRouter>
      <ImportRecordDetail {...props} identityRevision={1} />
    </MemoryRouter>,
  );
  await screen.findByText('Fictional refresh network failure');
  expect(screen.getByRole('button', { name: 'Retry exact review choice' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirm current reading' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact review choice' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
});
it('retains an unsent correction on failed refresh and blocks shared identity actions until it is handled', async () => {
  let refreshFails = false;
  const writes: ClinicalRecordAction[] = [];
  const identityChange = vi.fn(),
    identityNavigation = vi.fn(),
    dismissIdentity = vi.fn();
  const giant = {
    kind: 'reference',
    reference: {
      format: 'health-intake-clinical-review-reference-v2',
      reviewToken: context.reviewToken,
      section: 'records',
      ordinal: 0,
      bytes: 100000,
    },
    selection,
    policy: {
      canAcceptUnchanged: false,
      blockingIssueCount: 2,
      unreviewedPairChoices: false,
      classification: 'addition',
      kind: 'document',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/review-record?')) {
        if (refreshFails) throw new TypeError('Fictional refresh failure with unsent draft');
        return json({ format: 'health-intake-clinical-record-v2', context, record: giant });
      }
      if (url.endsWith('/intakes/' + context.intakeId))
        return json({
          id: context.intakeId,
          version: 7,
          filename: 'fictional.txt',
          mimeType: 'text/plain',
          providerId: 'fictional-provider',
          provider: 'Fictional',
          sha256: 'fictional-hash',
          bytes: 100000,
          contentUrl: '/api/sources/fictional/content',
        });
      if (url.endsWith('/review-record-section')) return json(page('issues', [issue]));
      if (url.endsWith('/review-record-action')) {
        writes.push(JSON.parse(String(init?.body)));
        return json({ version: 8 });
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  const props = {
    groupId: 'fictional-group',
    block: { intakeId: context.intakeId, proposalId: context.proposalId },
    recordId: selection.recordId,
    identityPanel: (
      <>
        <button onClick={identityChange}>Change shared identity</button>
        {createPortal(
          <>
            <a href="#/another-report" onClick={identityNavigation}>
              Open another identity report
            </a>
            <button data-review-context-dismiss onClick={dismissIdentity}>
              Dismiss identity dialog
            </button>
          </>,
          document.body,
        )}
      </>
    ),
    sourcePanel: null,
    commonIdentityIssueIds: new Set<string>(),
    sourceError: '',
    onBack: () => {},
    onChanged: () => {},
    onUseSource: () => {},
  };
  const view = render(
    <MemoryRouter>
      <ImportRecordDetail {...props} identityRevision={0} />
    </MemoryRouter>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Resolve questions or correct this record' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Question 1 · required' }));
  fireEvent.change(screen.getByLabelText('Corrected reading'), { target: { value: '2026-06-07' } });
  fireEvent.change(screen.getByLabelText('Reason for correction'), {
    target: { value: 'Fictional printed date' },
  });
  expect(screen.getByRole('button', { name: 'Change shared identity' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Change shared identity' }));
  expect(fireEvent.click(screen.getByRole('link', { name: 'Open another identity report' }))).toBe(
    false,
  );
  expect(identityChange).not.toHaveBeenCalled();
  expect(identityNavigation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss identity dialog' }));
  expect(dismissIdentity).toHaveBeenCalledOnce();
  refreshFails = true;
  view.rerender(
    <MemoryRouter>
      <ImportRecordDetail {...props} identityRevision={1} />
    </MemoryRouter>,
  );
  await screen.findByText('Fictional refresh failure with unsent draft');
  expect(screen.getByLabelText('Corrected reading')).toHaveValue('2026-06-07');
  expect(screen.getByLabelText('Reason for correction')).toHaveValue('Fictional printed date');
  expect(screen.getByRole('button', { name: 'Save corrected reading' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  refreshFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact record' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save corrected reading' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save corrected reading' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.patch).toMatchObject({
    mapping: { date: '2026-06-07', documentDate: '2026-06-07' },
    correctionReason: 'Fictional printed date',
  });
});

it('uses one parent navigation guard for ordinary drafts and sparse native record controls', async () => {
  const { createMemoryRouter, RouterProvider } = await import('react-router-dom');
  const { ImportRecordDetail } = await import('../../app/features/import/ImportDetailReview');
  const record = {
    id: selection.recordId,
    candidateId: 'fictional-candidate',
    candidateVersionId: selection.candidateVersionId,
    selectionReviewToken: selection.selectionReviewToken,
    kind: 'document',
    title: 'Fictional retained report',
    date: '2026-01-02',
    provider: 'Fictional Clinic',
    classification: 'addition',
    confidence: 1,
    uncertainties: [],
    evidence: [],
    supportedFields: ['documentTitle', 'documentDate'],
    mapping: {
      kind: 'document',
      subject: 'self',
      documentTitle: 'Fictional retained report',
      documentDate: '2026-01-02',
    },
    issues: [],
    questions: [],
    reviewState: 'pending',
    reportGroups: {
      format: 'health-intake-report-group-links-v1',
      count: 2,
      first: { groupId: 'fictional-group', groupVersionId: 'group-v1' },
      selection: {
        recordId: selection.recordId,
        candidateId: 'fictional-candidate',
        candidateVersionId: selection.candidateVersionId,
        proposalId: context.proposalId,
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/review-record?'))
        return json({
          format: 'health-intake-clinical-record-v2',
          context,
          record: { kind: 'record', record },
        });
      if (url.endsWith('/intakes/' + context.intakeId))
        return json({
          id: context.intakeId,
          version: 7,
          filename: 'fictional.txt',
          mimeType: 'text/plain',
          providerId: 'fictional-provider',
          provider: 'Fictional',
          sha256: 'fictional-hash',
          bytes: 1000,
          contentUrl: '/api/sources/fictional/content',
        });
      if (url.endsWith('/review-record-section')) {
        const body = JSON.parse(String(init?.body));
        return json(
          page(
            body.section,
            body.section === 'comparisons'
              ? [
                  {
                    ordinal: 0,
                    control: {
                      kind: 'pair',
                      otherRecordId: 'fictional-saved-record',
                      scopeToken: 'fictional-pair-scope',
                      targetAvailable: true,
                      reasonReferenced: false,
                    },
                    detail: {
                      kind: 'value',
                      value: {
                        comparison: {
                          id: 'fictional-saved-record',
                          kind: 'document',
                          title: 'Fictional saved report',
                          date: '2026-01-02',
                          mapping: record.mapping,
                          evidence: [],
                          previousDecision: null,
                        },
                      },
                    },
                  },
                ]
              : [],
          ),
        );
      }
      if (url.includes('/intakes?')) return json([]);
      throw new Error('Unexpected ' + url);
    }),
  );
  const router = createMemoryRouter(
    [
      {
        path: '/import',
        element: (
          <ImportRecordDetail
            groupId="fictional-group"
            block={{ intakeId: context.intakeId, proposalId: context.proposalId }}
            recordId={selection.recordId}
            identityPanel={null}
            identityRevision={0}
            sourcePanel={null}
            commonIdentityIssueIds={new Set()}
            sourceError=""
            onBack={() => {}}
            onChanged={() => {}}
            onUseSource={() => {}}
          />
        ),
      },
      { path: '/other', element: <p>Other page destination</p> },
    ],
    { initialEntries: ['/import'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByText('Find possible related saved records'));
  fireEvent.click(await screen.findByText('Fictional saved report · 2026-01-02'));
  fireEvent.change(screen.getByLabelText('Reason for this relationship'), {
    target: { value: 'These fictional reports describe different events.' },
  });
  await act(async () => {
    void router.navigate('/other');
  });
  expect(
    await screen.findByText(/Your review draft could not save. Stay here to retry before leaving/),
  ).toBeVisible();
  expect(router.state.blockers.size).toBe(1);
  expect(screen.queryByText('Other page destination')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Reason for this relationship')).toHaveValue(
    'These fictional reports describe different events.',
  );
});
