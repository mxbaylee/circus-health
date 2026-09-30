import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import type {
  IntakeImportFeed,
  IntakeReportQueueGroup,
  IntakeReportSourceReview,
} from '../../shared/intake';
import type { IntakeIdentityReview } from '../../shared/intake-identity';
import { ImportPage } from '../../app/features/import/ImportPage';
import { selectProfile } from '../../app/data/profile';

vi.mock('../../app/features/import/ImportDetailReview', () => ({
  ImportDetailReview: ({ onBack }: { onBack: () => void }) => (
    <section aria-label="Exact selected report">
      <button onClick={onBack}>Back to overview</button>
    </section>
  ),
}));

const counts = {
  pending: 0,
  deferred: 0,
  blocked: 0,
  accepted: 0,
  keptOriginal: 0,
  superseded: 0,
  questions: 0,
};
const group: IntakeReportQueueGroup = {
  groupId: 'fictional-report',
  groupVersionId: 'fictional-v1',
  intakeId: 'fictional-intake',
  intakeVersion: 1,
  discoveryOrder: 1,
  title: 'Fictional report',
  source: null,
  date: null,
  basis: 'report_anchor',
  member: null,
  anchor: null,
  counts,
  original: {
    filename: 'fictional.pdf',
    contentUrl: '/fictional-original',
    parentSourceFileId: null,
  },
};
const feed: IntakeImportFeed = {
  view: 'active',
  groups: [group],
  totalGroups: 1,
  totalRecords: 0,
  nextCursor: null,
  counts,
  blocks: [
    {
      groupId: group.groupId,
      intakeId: group.intakeId,
      proposalId: null,
      intakeVersion: 1,
      reviewToken: 'fictional-token',
      proposalContentUrl: '/fictional-original',
      records: [],
    },
  ],
  kindCounts: {
    test: 0,
    prescription: 0,
    vision: 0,
    procedure: 0,
    history: 0,
    unsupported: 0,
    person: 0,
  },
  people: {
    groups: [],
    totalGroups: 0,
    nextCursor: null,
    counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
  },
  activity: {
    runningFiles: 0,
    queuedFiles: 0,
    pausedFiles: 0,
    filesAwaitingConversion: 0,
    remainingUnits: 0,
    extractionUnknownFiles: 1,
    extractionComplete: false,
    allCurrentReportsReviewed: true,
  },
};

function response(data: unknown) {
  return new Response(JSON.stringify({ data, meta: { revision: 1 } }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function responseWithProfile(data: unknown, profile: Record<string, unknown>) {
  return new Response(JSON.stringify({ data, meta: { revision: 2, profile } }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

it.each([true, false])(
  'refreshes feed eligibility once after host grounding (ready=%s)',
  async (readyAfterRefresh) => {
    selectProfile({ id: 'fictional-grounding-feed', name: 'Rowan', placebo: true });
    let feedReads = 0;
    let identityPosts = 0;
    const identity: IntakeIdentityReview = {
      status: 'prior_confirmation',
      blocking: false,
      message: 'Earlier fictional confirmation applies.',
      scope: null,
      evidencedIdentity: {},
      conflicts: [],
      offeredSelfFields: {},
      self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input);
        if (url.includes('/intakes/import-feed?')) {
          feedReads += 1;
          const ready = readyAfterRefresh && feedReads > 1;
          const row = {
            feedKey: 'fictional-grounded-row',
            feedOrder: '0001',
            feedKind: 'test',
            id: 'fictional-grounded-record',
            classification: 'addition',
            kind: 'observation',
            title: 'Fictional grounded ferritin',
            date: null,
            provider: 'Juniper Clinic',
            candidateId: 'fictional-grounded-candidate',
            candidateVersionId: 'fictional-grounded-version',
            reviewState: 'pending',
            confidence: 1,
            uncertainties: [],
            evidence: [],
            mapping: {
              kind: 'observation',
              subject: ready ? 'self' : 'unknown',
              testLabel: 'Ferritin',
              valueText: '42',
              unit: 'ng/mL',
            },
            supportedFields: ['testLabel', 'valueText', 'unit'],
            queueState: 'pending',
            selectable: ready,
            manuallyEdited: false,
            issues: [],
            identityReview: {
              ...identity,
              status: ready ? 'prior_confirmation' : 'confirmation_required',
              blocking: !ready,
            },
          } satisfies IntakeImportFeed['blocks'][number]['records'][number];
          return response({
            ...feed,
            totalRecords: 1,
            counts: { ...counts, pending: 1, blocked: ready ? 0 : 1 },
            groups: [{ ...group, counts: { ...counts, pending: 1, blocked: ready ? 0 : 1 } }],
            blocks: [
              {
                ...feed.blocks[0],
                proposalId: 'fictional-grounded-proposal',
                reviewToken: ready ? 'after-grounding' : 'before-grounding',
                records: [row],
              },
            ],
            kindCounts: { ...feed.kindCounts, test: 1 },
          });
        }
        if (url.includes('/identity-review')) return response(identity);
        if (url.endsWith('/intakes/limits'))
          return response({ uploadBytes: 1024, extractionBytes: 1024 });
        if (url.endsWith('/intake-batches')) return response([]);
        if (url.endsWith('/identity-scope')) {
          identityPosts += 1;
          throw Error('No second confirmation is allowed');
        }
        throw Error(`Unexpected request: ${url}`);
      }),
    );
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
          initialEntries: ['/import'],
        })}
      />,
    );
    await waitFor(() => expect(feedReads).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(feedReads).toBe(2);
    if (readyAfterRefresh)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled(),
      );
    else expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
    expect(identityPosts).toBe(0);
  },
);

function mount(path: string, data = feed, batches: unknown[] = []) {
  selectProfile({ id: 'fictional-import-navigation', name: 'Rowan', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      let result: unknown;
      if (url.includes('/intakes/import-feed?')) result = data;
      else if (url.endsWith('/intakes/limits'))
        result = { uploadBytes: 1024, extractionBytes: 1024 };
      else if (url.endsWith('/intake-batches')) result = batches;
      else if (url.includes('/intake-batches/')) result = batches[0];
      else throw new Error(`Unexpected fictional request: ${url}`);
      return new Response(JSON.stringify({ data: result, meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
  return router;
}

it('saves good selections through ImportPage, then requires a fresh approval for a rejected sibling', async () => {
  const profileId = 'fictional-mounted-partial-save';
  selectProfile({ id: profileId, name: 'Fictional Self', placebo: true });
  const records = [0, 1].map((index) => ({
    feedKey: JSON.stringify([
      'fictional-intake',
      `fictional-candidate-${index}`,
      `fictional-version-${index}`,
    ]),
    feedOrder: `000${index}`,
    feedKind: 'test' as const,
    id: `fictional-record-${index}`,
    classification: 'addition' as const,
    kind: 'observation' as const,
    title: `Fictional marker ${index}`,
    date: '2026-09-01',
    provider: 'Fictional Clinic',
    candidateId: `fictional-candidate-${index}`,
    candidateVersionId: `fictional-version-${index}`,
    selectionReviewToken: `fictional-token-${index}`,
    reviewState: 'pending' as const,
    confidence: 1,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation' as const,
      subject: 'self',
      testLabel: `Fictional marker ${index}`,
      valueText: '7',
    },
    supportedFields: ['testLabel', 'valueText'],
    queueState: 'pending' as const,
    selectable: true,
    manuallyEdited: false,
  })) satisfies IntakeImportFeed['blocks'][number]['records'];
  const displayed: IntakeImportFeed = {
    ...feed,
    groups: [{ ...group, source: 'Fictional Clinic', counts: { ...counts, pending: 2 } }],
    blocks: [{ ...feed.blocks[0]!, records }],
    totalRecords: 2,
    counts: { ...counts, pending: 2 },
    kindCounts: { ...feed.kindCounts, test: 2 },
  };
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(displayed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review'))
        return response({
          status: 'prior_confirmation',
          blocking: false,
          message: 'Fictional identity confirmed.',
          scope: null,
          evidencedIdentity: {},
          self: {
            noteId: 'person-note:self',
            version: 1,
            fullName: 'Fictional Self',
            birthDate: null,
          },
          offeredSelfFields: {},
          conflicts: [],
        });
      if (url.endsWith('/people')) return response([]);
      if (url.includes('/record-owner?')) return response({ personId: 'patient' });
      if (url.endsWith('/intakes/report-acceptance') && init?.method === 'POST') {
        posts++;
        const request = JSON.parse(String(init.body)) as {
          operationId: string;
          blocks: Array<{
            intakeId: string;
            proposalId: string | null;
            selections: Array<{
              recordId: string;
              candidateId: string;
              candidateVersionId: string;
              selectionReviewToken: string;
            }>;
          }>;
        };
        const selected = request.blocks.flatMap((block) =>
          block.selections.map((selection) => ({
            ...selection,
            intakeId: block.intakeId,
            proposalId: block.proposalId,
          })),
        );
        const items = selected.map((selection) => ({
          ...selection,
          reviewedSelectionHash: 'fictional-hash',
          operationId: `fictional-child-${posts}-${selection.recordId}`,
          label: selection.recordId.replace('record', 'marker'),
          kind: 'observation',
          personId: 'patient',
          status: posts === 1 && selection.recordId.endsWith('-1') ? 'needs_review' : 'saved',
          message: 'Review the current record, then approve again.',
          ...(posts === 1 && selection.recordId.endsWith('-1')
            ? {}
            : {
                receipt: {
                  intakeId: selection.intakeId,
                  proposalId: selection.proposalId,
                  intakeVersionBefore: 1,
                  intakeVersionAfter: 2,
                  reviewToken: 'fictional-review',
                  records: [
                    {
                      recordId: selection.recordId,
                      candidateId: selection.candidateId,
                      candidateVersionId: selection.candidateVersionId,
                      entityId: `fictional-entity-${selection.recordId}`,
                      kind: 'observation',
                      title: selection.recordId,
                      optical: false,
                      outcome: 'added',
                    },
                  ],
                },
              }),
        }));
        return response({
          receipt: {
            version: 1,
            operationId: request.operationId,
            status: 'completed',
            atomic: false,
            at: '2026-09-01',
            selectedCount: items.length,
            acceptedCount: items.filter((item) => item.status === 'saved').length,
            receipts: items.flatMap((item) => ('receipt' in item ? [item.receipt] : [])),
            items,
          },
          replayed: false,
          durability: { pending: false, mutationRevision: 1, persistedRevision: 1, error: null },
        });
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('checkbox', { name: 'Select all shown' }));
  await user.click(screen.getByRole('button', { name: 'Save 2 records' }));
  await waitFor(() => expect(posts).toBe(1));
  expect(await screen.findByText('1 saved, 1 needs review')).toBeVisible();
  expect(
    screen
      .getAllByRole('status')
      .filter((region) => region.textContent?.includes('1 saved, 1 needs review')),
  ).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'Select Fictional marker 1' })).not.toBeChecked();
  expect(screen.getByText('Review again, then approve.')).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: 'Select Fictional marker 1' }));
  await user.click(screen.getByRole('button', { name: 'Save 1 record' }));
  await waitFor(() => expect(posts).toBe(2));
  expect(await screen.findByText('1 saved')).toBeVisible();
});

it.each(['/import', '/import?q=fictional'])(
  'keeps %s on the overview even when an original-proposal report exists',
  async (path) => {
    mount(path);
    expect(await screen.findByRole('heading', { name: 'Review reports' })).toBeVisible();
    expect(
      await screen.findByText('Caught up for now · reading is not yet complete'),
    ).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Exact selected report' })).toBeNull();
    expect(screen.getByRole('tablist', { name: 'Record kinds' })).toBeVisible();
  },
);

it('retries only an unchanged source scope and stops for changed scope or queue view', async () => {
  const profileId = 'fictional-source-path-guard';
  selectProfile({ id: profileId, name: 'Rowan', placebo: true });
  const sourceGroup: IntakeReportQueueGroup = {
    ...group,
    source: 'Fictional BodySpec',
    sourceSuggestion: {
      value: 'Fictional BodySpec',
      contextId: 'fictional-source-context',
      evidence: { label: 'Source heading', locator: 'page 1' },
    },
    counts: { ...counts, pending: 1 },
  };
  const sourceRecord = {
    feedKey: 'fictional-source-record-key',
    feedOrder: '0001',
    feedKind: 'test' as const,
    id: 'fictional-source-record',
    classification: 'addition' as const,
    kind: 'observation' as const,
    title: 'Fictional composition result',
    date: '2026-09-01',
    provider: 'Unknown source',
    candidateId: 'fictional-source-candidate',
    candidateVersionId: 'fictional-source-candidate-version',
    reviewState: 'pending' as const,
    confidence: 0.98,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation' as const,
      subject: 'unknown',
      testLabel: 'Fictional composition result',
      valueText: '42',
      unit: 'invented units',
    },
    supportedFields: ['testLabel', 'valueText', 'unit'],
    queueState: 'pending' as const,
    selectable: false,
    manuallyEdited: false,
  } satisfies IntakeImportFeed['blocks'][number]['records'][number];
  const sourceFeed: IntakeImportFeed = {
    ...feed,
    groups: [sourceGroup],
    totalRecords: 1,
    counts: { ...counts, pending: 1 },
    blocks: [
      {
        ...feed.blocks[0],
        proposalId: 'fictional-source-proposal',
        records: [sourceRecord],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  };
  const review: IntakeReportSourceReview = {
    profileId,
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    view: 'active',
    scopeToken: 'fictional-source-scope-token',
    coverage: { total: 1, covered: 0, uncovered: 1, status: 'uncovered', bySource: [] },
    sourceEvidence: ['Fictional BodySpec'],
    targets: [
      {
        id: 'fictional-source-target',
        candidateId: sourceRecord.candidateId,
        candidateVersionId: sourceRecord.candidateVersionId,
        occurrence: {
          proposalId: 'fictional-source-proposal',
          recordId: sourceRecord.id,
          batchId: null,
          locator: 'page 1',
        },
        sourceRef: {
          groupId: group.groupId,
          groupVersionId: group.groupVersionId,
          contributionId: 'fictional-source-contribution',
          contextId: 'fictional-source-context',
          fingerprint: 'fictional-source-fingerprint',
        },
        title: sourceRecord.title,
        date: sourceRecord.date,
        kind: 'observation',
        effectiveSource: null,
      },
    ],
  };
  const identity: IntakeIdentityReview = {
    status: 'missing_warning',
    blocking: false,
    message: 'Identity is not printed clearly.',
    scope: null,
    evidencedIdentity: {},
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  const sameScopeRefresh: IntakeReportSourceReview = {
    ...review,
    intakeVersion: 2,
    scopeToken: 'fictional-source-scope-token-same-semantics',
  };
  const changedScopeRefresh: IntakeReportSourceReview = {
    ...review,
    intakeVersion: 3,
    scopeToken: 'fictional-source-scope-token-changed',
    coverage: { ...review.coverage, total: 2, uncovered: 2 },
    targets: [
      ...review.targets,
      {
        ...review.targets[0],
        id: 'fictional-source-target-second',
        occurrence: {
          ...review.targets[0].occurrence,
          proposalId: 'fictional-source-proposal-second',
          recordId: 'fictional-source-record-second',
          locator: 'page 2',
        },
        title: 'Fictional second composition result',
      },
    ],
  };
  let sourceReviewReads = 0;
  const sourcePosts: Record<string, unknown>[] = [];
  let releasePost!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(sourceFeed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) return response(identity);
      if (url.includes('/report-source-review')) {
        sourceReviewReads += 1;
        return response(
          sourceReviewReads === 2
            ? sameScopeRefresh
            : sourceReviewReads === 4 || sourceReviewReads === 5
              ? changedScopeRefresh
              : review,
        );
      }
      if (url.endsWith('/intakes/fictional-intake/report-source')) {
        sourcePosts.push(JSON.parse(String(init?.body)));
        if (sourcePosts.length === 1 || sourcePosts.length === 3)
          return new Response(
            JSON.stringify({
              error: { code: 'VERSION_CONFLICT', message: 'Late fictional reading progress.' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        if (sourcePosts.length === 2 || sourcePosts.length === 4) return response({});
        return new Promise<Response>((resolve) => {
          releasePost = resolve;
        });
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await user.click(
    await screen.findByRole('button', { name: 'Change source: Fictional BodySpec' }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Use Fictional BodySpec for 1 record' }),
  );
  await waitFor(() => expect(sourcePosts).toHaveLength(2));
  expect(sourcePosts[0]!.operationId).toBe(sourcePosts[1]!.operationId);
  expect(sourcePosts[0]!.version).toBe(1);
  expect(sourcePosts[1]!.version).toBe(2);
  expect(sourcePosts[1]!.scopeToken).toBe(sameScopeRefresh.scopeToken);

  await user.click(
    await screen.findByRole('button', { name: 'Change source: Fictional BodySpec' }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Use Fictional BodySpec for 1 record' }),
  );
  expect(
    await screen.findByRole('button', { name: 'Use Fictional BodySpec for 2 records' }),
  ).toBeEnabled();
  expect(sourcePosts).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Use Fictional BodySpec for 2 records' }));
  await waitFor(() => expect(sourcePosts).toHaveLength(4));
  expect(sourcePosts[3]!.operationId).not.toBe(sourcePosts[2]!.operationId);
  expect(sourcePosts[3]!.scopeToken).toBe(changedScopeRefresh.scopeToken);

  await user.click(
    await screen.findByRole('button', { name: 'Change source: Fictional BodySpec' }),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Use Fictional BodySpec for 1 record' }),
  );
  await waitFor(() => expect(sourcePosts).toHaveLength(5));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Review status' }), 'later');
  releasePost(
    new Response(
      JSON.stringify({
        error: { code: 'VERSION_CONFLICT', message: 'Late fictional reading progress.' },
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(sourceReviewReads).toBe(6);
  expect(sourcePosts).toHaveLength(5);
});

it.each([
  '/import?intake=fictional-intake&proposal=original',
  '/import?group=fictional-report',
  '/import?group=fictional-report&intake=fictional-intake&proposal=original&record=fictional-record&review=full',
])('opens explicit full review for %s and can return to all imports', async (path) => {
  const user = userEvent.setup();
  const router = mount(path);
  expect(await screen.findByRole('region', { name: 'Exact selected report' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Review reports' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'All imports' }));
  expect(await screen.findByRole('heading', { name: 'Review reports' })).toBeVisible();
  expect(router.state.location.search).toBe('');
});

it('invites the first upload instead of claiming completed reading in an empty archive', async () => {
  mount('/import', {
    ...feed,
    groups: [],
    blocks: [],
    totalGroups: 0,
    activity: {
      ...feed.activity,
      extractionUnknownFiles: 0,
      extractionComplete: true,
      readingAccounting: {
        state: 'empty',
        sourceCount: 0,
        accountedSources: 0,
        pendingSources: 0,
        unknownSources: 0,
        parentAccountedChildren: 0,
        allSourceOccurrencesAccounted: true,
        clinicalExtraction: 'no_sources',
        units: { total: 0, pending: 0, extractedClaims: 0, contextOnly: 0, unreadable: 0 },
        packageOccurrences: {
          total: 0,
          accounted: 0,
          pending: 0,
          unknownRoles: 0,
          duplicateBytes: 0,
        },
        dependencies: { missing: 0, uninspected: 0, ambiguous: 0 },
        hostReading: {
          checkpoints: 0,
          unknownSources: 0,
          pendingWindows: 0,
          dispositionedWindows: 0,
          exhaustedSources: 0,
        },
        pauseReasons: [],
      },
    },
  });
  expect(await screen.findByText('Ready for your first report')).toBeVisible();
  expect(
    screen.getByText('Choose a report above. Moxie will read it and show results here for review.'),
  ).toBeVisible();
  expect(screen.queryByText(/reading is complete/)).toBeNull();
  expect(screen.queryByText(/More may appear while Moxie reads/)).toBeNull();
});

it('publishes a completed report identity without waiting for an unrelated slow report', async () => {
  selectProfile({ id: 'fictional-import-independent-identity', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 2, blocked: 2, questions: 2 };
  const makeGroup = (suffix: string, discoveryOrder: number): IntakeReportQueueGroup => ({
    ...group,
    groupId: `fictional-report-${suffix}`,
    groupVersionId: `fictional-version-${suffix}`,
    intakeId: `fictional-intake-${suffix}`,
    discoveryOrder,
    title: `Fictional report ${suffix}`,
    counts: { ...counts, pending: 1, blocked: 1, questions: 1 },
  });
  const fastGroup = makeGroup('fast', 1);
  const slowGroup = makeGroup('slow', 2);
  const makeRecord = (suffix: string): IntakeImportFeed['blocks'][number]['records'][number] => ({
    feedKey: `fictional-record-key-${suffix}`,
    feedOrder: `000${suffix === 'fast' ? '1' : '2'}`,
    feedKind: 'test' as const,
    id: `fictional-record-${suffix}`,
    classification: 'addition' as const,
    kind: 'observation' as const,
    title: `Fictional result ${suffix}`,
    date: '2026-04-12',
    provider: 'Invented Clinic',
    candidateId: `fictional-candidate-${suffix}`,
    candidateVersionId: `fictional-candidate-version-${suffix}`,
    reviewState: 'pending' as const,
    confidence: 0.98,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation' as const,
      subject: 'unknown' as const,
      testLabel: `Fictional result ${suffix}`,
      valueText: '42',
      unit: 'imaginary units',
    },
    supportedFields: ['testLabel', 'valueText', 'unit'],
    queueState: 'pending' as const,
    selectable: false,
    manuallyEdited: false,
  });
  const data: IntakeImportFeed = {
    ...feed,
    groups: [fastGroup, slowGroup],
    totalGroups: 2,
    totalRecords: 2,
    counts: pendingCounts,
    blocks: [fastGroup, slowGroup].map((item, index) => ({
      groupId: item.groupId,
      intakeId: item.intakeId,
      proposalId: `fictional-proposal-${index + 1}`,
      intakeVersion: item.intakeVersion,
      reviewToken: `fictional-review-token-${index + 1}`,
      proposalContentUrl: '/fictional-original',
      records: [makeRecord(index === 0 ? 'fast' : 'slow')],
    })),
    kindCounts: { ...feed.kindCounts, test: 2 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  };
  const releaseSlow: ((value: Response) => void)[] = [];
  let fastReads = 0;
  const identityResponse = (
    item: IntakeReportQueueGroup,
    subject: string,
  ): IntakeIdentityReview => ({
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope: {
      profileId: 'fictional-import-independent-identity',
      intakeId: item.intakeId,
      intakeVersion: item.intakeVersion,
      groupId: item.groupId,
      groupVersionId: item.groupVersionId,
      sourceHash: `fictional-source-${item.groupId}`,
      memberId: null,
      original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
      report: { locator: 'page 1 heading', text: item.title },
      subject: { locator: 'page 1 subject', text: subject },
      verificationMode: 'literal_text_match',
      evidencedIdentity: { fullName: subject },
      membership: [],
      targets: [],
      scopeToken: `fictional-scope-${item.groupId}`,
    },
    evidencedIdentity: { fullName: subject },
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(data);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes(`/intakes/${fastGroup.intakeId}/identity-review`)) {
        fastReads += 1;
        return response(identityResponse(fastGroup, 'Fast Fictional Person'));
      }
      if (url.includes(`/intakes/${slowGroup.intakeId}/identity-review`))
        return new Promise<Response>((resolve) => {
          releaseSlow.push(resolve);
        });
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() => expect(releaseSlow).toHaveLength(1));
  expect(await screen.findByText('Fast Fictional Person')).toBeVisible();

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  await waitFor(() => expect(fastReads).toBe(2));
  expect(await screen.findByText('Fast Fictional Person')).toBeVisible();

  for (const release of releaseSlow)
    release(
      new Response(
        JSON.stringify({
          error: {
            code: 'FICTIONAL_IDENTITY_UNAVAILABLE',
            message: 'Fictional identity unavailable.',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Review person for Fictional report slow' }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review person for Fictional report slow' }));
  expect(await screen.findByText('Fictional identity unavailable.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByText('Fast Fictional Person')).toBeVisible();
});

it('does not publish a late identity response for an older exact report signature', async () => {
  selectProfile({ id: 'fictional-import-latest-identity', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const versionOne = {
    ...group,
    groupId: 'fictional-versioned-report',
    groupVersionId: 'fictional-group-version-1',
    intakeId: 'fictional-intake-version-1',
    intakeVersion: 1,
    counts: pendingCounts,
  };
  const versionTwo = {
    ...versionOne,
    groupVersionId: 'fictional-group-version-2',
    intakeId: 'fictional-intake-version-2',
    intakeVersion: 2,
  };
  const feedFor = (item: IntakeReportQueueGroup): IntakeImportFeed => ({
    ...feed,
    groups: [item],
    totalRecords: 1,
    counts: pendingCounts,
    blocks: [
      {
        groupId: item.groupId,
        intakeId: item.intakeId,
        proposalId: 'fictional-versioned-proposal',
        intakeVersion: item.intakeVersion,
        reviewToken: `fictional-review-token-${item.intakeVersion}`,
        proposalContentUrl: '/fictional-original',
        records: [
          {
            feedKey: 'fictional-versioned-record-key',
            feedOrder: '0001',
            feedKind: 'test',
            id: 'fictional-versioned-record',
            classification: 'addition',
            kind: 'observation',
            title: 'Fictional versioned result',
            date: '2026-04-12',
            provider: 'Invented Clinic',
            candidateId: 'fictional-versioned-candidate',
            candidateVersionId: `fictional-candidate-version-${item.intakeVersion}`,
            reviewState: 'pending',
            confidence: 0.98,
            uncertainties: [],
            evidence: [],
            mapping: {
              kind: 'observation',
              subject: 'unknown',
              testLabel: 'Fictional versioned result',
              valueText: '42',
              unit: 'imaginary units',
            },
            supportedFields: ['testLabel', 'valueText', 'unit'],
            queueState: 'pending',
            selectable: false,
            manuallyEdited: false,
          },
        ],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  });
  const identityFor = (item: IntakeReportQueueGroup, subject: string): IntakeIdentityReview => ({
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this exact fictional subject.',
    scope: {
      profileId: 'fictional-import-latest-identity',
      intakeId: item.intakeId,
      intakeVersion: item.intakeVersion,
      groupId: item.groupId,
      groupVersionId: item.groupVersionId,
      sourceHash: `fictional-source-${item.intakeVersion}`,
      memberId: null,
      original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
      report: { locator: 'page 1 heading', text: 'Fictional report' },
      subject: { locator: 'page 1 subject', text: subject },
      verificationMode: 'literal_text_match',
      evidencedIdentity: { fullName: subject },
      membership: [],
      targets: [],
      scopeToken: `fictional-scope-${item.intakeVersion}`,
    },
    evidencedIdentity: { fullName: subject },
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  });
  let feedReads = 0;
  let releaseOld!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) {
        feedReads += 1;
        return response(feedFor(feedReads === 1 ? versionOne : versionTwo));
      }
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes(`/intakes/${versionOne.intakeId}/identity-review`))
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      if (url.includes(`/intakes/${versionTwo.intakeId}/identity-review`))
        return response(identityFor(versionTwo, 'Fresh Fictional Person'));
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );
  await waitFor(() => expect(releaseOld).toBeTypeOf('function'));

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  expect(await screen.findByText('Fresh Fictional Person')).toBeVisible();

  releaseOld(response(identityFor(versionOne, 'Stale Fictional Person')));
  await waitFor(() => expect(screen.queryByText(/Stale Fictional Person/)).toBeNull());
  expect(screen.getByText('Fresh Fictional Person')).toBeVisible();
});

it('retains one identical in-flight identity read across ordinary feed search churn', async () => {
  const profileId = 'fictional-import-identity-churn';
  selectProfile({ id: profileId, name: 'Rowan', placebo: true, nameVersion: 1, version: 1 });
  const report = {
    ...group,
    groupId: 'fictional-churn-report',
    groupVersionId: 'fictional-churn-group-version',
    intakeId: 'fictional-churn-intake',
    intakeVersion: 7,
    counts: { ...counts, pending: 1, blocked: 1, questions: 1 },
  };
  const data: IntakeImportFeed = {
    ...feed,
    groups: [report],
    totalRecords: 1,
    counts: report.counts,
    blocks: [
      {
        groupId: report.groupId,
        intakeId: report.intakeId,
        proposalId: 'fictional-churn-proposal',
        intakeVersion: report.intakeVersion,
        reviewToken: 'fictional-churn-review-token',
        proposalContentUrl: '/fictional-original',
        records: [
          {
            feedKey: 'fictional-churn-record-key',
            feedOrder: '0001',
            feedKind: 'test',
            id: 'fictional-churn-record',
            classification: 'addition',
            kind: 'observation',
            title: 'Fictional churn result',
            date: '2026-05-01',
            provider: 'Invented Clinic',
            candidateId: 'fictional-churn-candidate',
            candidateVersionId: 'fictional-churn-candidate-version',
            reviewState: 'pending',
            confidence: 0.98,
            uncertainties: [],
            evidence: [],
            mapping: {
              kind: 'observation',
              subject: 'unknown',
              testLabel: 'Fictional churn result',
              valueText: '17',
              unit: 'imaginary units',
            },
            supportedFields: ['testLabel', 'valueText', 'unit'],
            queueState: 'pending',
            selectable: false,
            manuallyEdited: false,
          },
        ],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  };
  const refreshedData: IntakeImportFeed = {
    ...data,
    activity: { ...data.activity, runningFiles: 1 },
  };
  const identity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this exact fictional subject.',
    scope: {
      profileId,
      intakeId: report.intakeId,
      intakeVersion: report.intakeVersion,
      groupId: report.groupId,
      groupVersionId: report.groupVersionId,
      sourceHash: 'fictional-churn-source',
      memberId: null,
      original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
      report: { locator: 'page 1 heading', text: report.title },
      subject: { locator: 'page 1 subject', text: 'Stable Fictional Person' },
      verificationMode: 'literal_text_match',
      evidencedIdentity: { fullName: 'Stable Fictional Person' },
      membership: [],
      targets: [],
      scopeToken: 'fictional-churn-scope',
    },
    evidencedIdentity: { fullName: 'Stable Fictional Person' },
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  let feedReads = 0;
  let searchFeedReads = 0;
  const identityReleases: ((value: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) {
        feedReads += 1;
        if (url.includes('q=fictional+churn')) {
          searchFeedReads += 1;
          return response(refreshedData);
        }
        return response(data);
      }
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes(`/intakes/${report.intakeId}/identity-review`))
        return new Promise<Response>((resolve) => identityReleases.push(resolve));
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() => expect(identityReleases).toHaveLength(1));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), {
    target: { value: 'fictional churn' },
  });
  await waitFor(() => expect(searchFeedReads).toBe(1));
  expect(feedReads).toBeGreaterThanOrEqual(2);
  expect(await screen.findByText('Moxie is reading 1 file')).toBeVisible();
  expect(identityReleases).toHaveLength(1);

  identityReleases[0](response(identity));
  expect(await screen.findByText('Stable Fictional Person')).toBeVisible();
  expect(identityReleases).toHaveLength(1);
});

it('does not reuse an old identity error after a report disappears and is re-added', async () => {
  const profileId = 'fictional-import-identity-readded';
  selectProfile({ id: profileId, name: 'Rowan', placebo: true, nameVersion: 1, version: 1 });
  const report = {
    ...group,
    groupId: 'fictional-readded-report',
    groupVersionId: 'fictional-readded-group-version',
    intakeId: 'fictional-readded-intake',
    intakeVersion: 4,
    counts: { ...counts, pending: 1, blocked: 1, questions: 1 },
  };
  const record: IntakeImportFeed['blocks'][number]['records'][number] = {
    feedKey: 'fictional-readded-record-key',
    feedOrder: '0001',
    feedKind: 'test' as const,
    id: 'fictional-readded-record',
    classification: 'addition' as const,
    kind: 'observation' as const,
    title: 'Fictional re-added result',
    date: '2026-05-02',
    provider: 'Invented Clinic',
    candidateId: 'fictional-readded-candidate',
    candidateVersionId: 'fictional-readded-candidate-version',
    reviewState: 'pending' as const,
    confidence: 0.98,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation' as const,
      subject: 'unknown' as const,
      testLabel: 'Fictional re-added result',
      valueText: '23',
      unit: 'imaginary units',
    },
    supportedFields: ['testLabel', 'valueText', 'unit'],
    queueState: 'pending' as const,
    selectable: false,
    manuallyEdited: false,
  };
  const visible: IntakeImportFeed = {
    ...feed,
    groups: [report],
    totalRecords: 1,
    counts: report.counts,
    blocks: [
      {
        groupId: report.groupId,
        intakeId: report.intakeId,
        proposalId: 'fictional-readded-proposal',
        intakeVersion: report.intakeVersion,
        reviewToken: 'fictional-readded-review-token',
        proposalContentUrl: '/fictional-original',
        records: [record],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  };
  const hidden: IntakeImportFeed = {
    ...visible,
    groups: [],
    blocks: [],
    totalGroups: 0,
    totalRecords: 0,
    counts,
    kindCounts: { ...feed.kindCounts },
    activity: { ...visible.activity, runningFiles: 1 },
  };
  const freshIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this re-added fictional subject.',
    scope: {
      profileId,
      intakeId: report.intakeId,
      intakeVersion: report.intakeVersion,
      groupId: report.groupId,
      groupVersionId: report.groupVersionId,
      sourceHash: 'fictional-readded-source',
      memberId: null,
      original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
      report: { locator: 'page 1 heading', text: report.title },
      subject: { locator: 'page 1 subject', text: 'Re-added Fictional Person' },
      verificationMode: 'literal_text_match',
      evidencedIdentity: { fullName: 'Re-added Fictional Person' },
      membership: [],
      targets: [],
      scopeToken: 'fictional-readded-scope',
    },
    evidencedIdentity: { fullName: 'Re-added Fictional Person' },
    self: { noteId: 'person-note:self', version: 1, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  const identityReleases: ((value: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?'))
        return response(url.includes('q=hidden') ? hidden : visible);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes(`/intakes/${report.intakeId}/identity-review`))
        return new Promise<Response>((resolve) => identityReleases.push(resolve));
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() => expect(identityReleases).toHaveLength(1));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), {
    target: { value: 'hidden' },
  });
  expect(await screen.findByText('Moxie is reading 1 file')).toBeVisible();
  await waitFor(() => expect(screen.queryByText('Fictional re-added result')).toBeNull());
  identityReleases[0](
    new Response(
      JSON.stringify({
        error: { code: 'FICTIONAL_OLD_IDENTITY_ERROR', message: 'Old fictional identity error.' },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), {
    target: { value: 'visible' },
  });
  expect(await screen.findByText('Fictional re-added result')).toBeVisible();
  await waitFor(() => expect(identityReleases).toHaveLength(2));

  identityReleases[1](response(freshIdentity));
  expect(await screen.findByText('Re-added Fictional Person')).toBeVisible();
  await waitFor(() => expect(screen.queryByText('Old fictional identity error.')).toBeNull());
  expect(screen.getByText('Re-added Fictional Person')).toBeVisible();
});

it('clears a retained identity action before refreshing a back-forward cached Import page', async () => {
  selectProfile({ id: 'fictional-import-history', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const clinicalFeed = {
    ...feed,
    groups: [{ ...group, counts: pendingCounts }],
    totalRecords: 1,
    counts: pendingCounts,
    blocks: [
      {
        ...feed.blocks[0],
        proposalId: 'fictional-proposal',
        reviewToken: 'fictional-review-token',
        records: [
          {
            feedKey: 'fictional-record-key',
            feedOrder: '0001',
            feedKind: 'test',
            id: 'fictional-record',
            classification: 'addition',
            kind: 'observation',
            title: 'Fictional ferritin',
            date: '2026-04-12',
            provider: 'Unknown source',
            candidateId: 'fictional-candidate',
            candidateVersionId: 'fictional-candidate-version',
            reviewState: 'pending',
            confidence: 0.98,
            uncertainties: [],
            evidence: [],
            mapping: {
              kind: 'observation',
              subject: 'unknown',
              testLabel: 'Fictional ferritin',
              valueText: '42',
              unit: 'ng/mL',
            },
            supportedFields: ['testLabel', 'valueText', 'unit'],
            queueState: 'pending',
            selectable: false,
            manuallyEdited: false,
          },
        ],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  } as IntakeImportFeed;
  const scope = {
    profileId: 'fictional-import-history',
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    sourceHash: 'fictional-source-hash',
    memberId: null,
    original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1', text: 'Fictional report' },
    subject: { locator: 'page 1', text: 'Rowan Ellis' },
    verificationMode: 'literal_text_match' as const,
    evidencedIdentity: { fullName: 'Rowan Ellis' },
    membership: [],
    targets: [],
    scopeToken: 'fictional-scope-token',
  };
  const pendingIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope,
    evidencedIdentity: { fullName: 'Rowan Ellis' },
    self: { noteId: 'person-note:self', version: 4, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  let feedReads = 0;
  let identityReads = 0;
  let releaseRestoredFeed!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) {
        feedReads += 1;
        if (feedReads === 1) return response(clinicalFeed);
        return new Promise<Response>((resolve) => {
          releaseRestoredFeed = resolve;
        });
      }
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(
          identityReads === 1
            ? pendingIdentity
            : {
                ...pendingIdentity,
                status: 'prior_confirmation',
                blocking: false,
                message: 'A retained fictional confirmation applies.',
                scope: { ...scope, targets: [] },
              },
        );
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  expect(screen.getByRole('button', { name: 'This is me' })).toBeEnabled();

  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  await waitFor(() => expect(screen.getByRole('button', { name: 'This is me' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled();

  releaseRestoredFeed(response(clinicalFeed));
  await waitFor(() => expect(identityReads).toBe(2));
  expect(screen.queryByRole('button', { name: /This is me|Self details/ })).toBeNull();
});

it('completes one overview identity action after exact late-reading freshness validation', async () => {
  selectProfile({ id: 'fictional-import-freshness', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const identityRecord = {
    feedKey: 'fictional-record-key',
    feedOrder: '0001',
    feedKind: 'test',
    id: 'fictional-record',
    classification: 'addition',
    kind: 'observation',
    title: 'Fictional ferritin',
    date: '2026-04-12',
    provider: 'Invented Clinic',
    candidateId: 'fictional-candidate',
    candidateVersionId: 'fictional-candidate-version',
    reviewState: 'pending',
    confidence: 0.98,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional ferritin',
      valueText: '42',
      unit: 'ng/mL',
    },
    supportedFields: ['testLabel', 'valueText', 'unit'],
    queueState: 'pending',
    selectable: false,
    manuallyEdited: false,
  };
  const clinicalFeed = {
    ...feed,
    groups: [{ ...group, intakeVersion: 1, counts: pendingCounts }],
    totalRecords: 1,
    counts: pendingCounts,
    blocks: [
      {
        ...feed.blocks[0],
        proposalId: 'fictional-proposal',
        reviewToken: 'fictional-review-token',
        records: [identityRecord],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  } as IntakeImportFeed;
  const displayedScope = {
    profileId: 'fictional-import-freshness',
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    sourceHash: 'fictional-source-hash',
    memberId: null,
    original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1 heading', text: 'Fictional report' },
    subject: { locator: 'page 1 patient', text: 'Fictional Rowan Ellis · 1988-04-12' },
    verificationMode: 'literal_text_match' as const,
    evidencedIdentity: { fullName: 'Fictional Rowan Ellis', birthDate: '1988-04-12' },
    evidenceOriginalFingerprint: 'fictional-original-fingerprint',
    membership: [],
    questions: [{ prompt: 'Does this fictional report belong to you?' }],
    targets: [
      {
        candidateId: identityRecord.candidateId,
        candidateVersionId: identityRecord.candidateVersionId,
        proposalId: 'fictional-proposal',
        recordId: identityRecord.id,
        title: identityRecord.title,
        issueId: 'fictional-identity-issue',
      },
    ],
    scopeToken: 'fictional-scope-token-v1',
  };
  const displayedIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope: displayedScope,
    evidencedIdentity: displayedScope.evidencedIdentity,
    self: { noteId: 'person-note:self', version: 4, fullName: null, birthDate: null },
    offeredSelfFields: { fullName: 'Fictional Rowan Ellis', birthDate: '1988-04-12' },
    conflicts: [],
  };
  const freshIdentity: IntakeIdentityReview = {
    ...displayedIdentity,
    scope: { ...displayedScope, intakeVersion: 2, scopeToken: 'fictional-scope-token-v2' },
  };
  let identityReads = 0;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(clinicalFeed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? displayedIdentity : freshIdentity);
      }
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        if (identityPosts.length === 1)
          return new Response(
            JSON.stringify({
              error: { code: 'VERSION_CONFLICT', message: 'Late fictional reading progress.' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        return response({ id: group.intakeId, version: 3 });
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /Review person for/ }));
  await user.click(screen.getByRole('button', { name: 'This is me' }));
  expect(
    await screen.findByText(
      'Identity confirmed and the selected blank Self details were filled in the same action.',
    ),
  ).toBeVisible();
  expect(identityPosts).toHaveLength(2);
  expect(identityPosts[0]!.operationId).toBe(identityPosts[1]!.operationId);
  expect(identityPosts[0]!.version).toBe(1);
  expect(identityPosts[1]!.version).toBe(2);
  expect((identityPosts[1]!.scope as { scopeToken: string }).scopeToken).toBe(
    'fictional-scope-token-v2',
  );
  expect((identityPosts[1]!.selfUpdate as { fields: object }).fields).toEqual({
    birthDate: displayedIdentity.offeredSelfFields.birthDate,
  });
});

it('refreshes record readiness and suppresses an exhausted identity action after retaining a name', async () => {
  const profileId = 'fictional-import-exhausted-identity';
  selectProfile({
    id: profileId,
    name: 'Blue Lantern',
    placebo: true,
    nameVersion: 1,
    version: 1,
  });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const readyCounts = { ...counts, pending: 1 };
  const identityRecord = {
    feedKey: 'fictional-exhausted-record-key',
    feedOrder: '0001',
    feedKind: 'vision',
    id: 'fictional-exhausted-record',
    classification: 'unsupported',
    kind: 'document',
    title: 'Fictional lantern eyewear record',
    date: '2026-08-02',
    provider: 'Unknown source',
    candidateId: 'fictional-exhausted-candidate',
    candidateVersionId: 'fictional-exhausted-candidate-version',
    reviewState: 'pending',
    confidence: 0.97,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'document',
      subject: 'unknown',
      documentTitle: 'Fictional lantern eyewear record',
      opticalPrescription: {
        type: 'spectacle',
        eyes: [{ side: 'right', sph: { valueText: '+0.25', unit: 'fictional lens units' } }],
      },
    },
    supportedFields: ['documentTitle', 'opticalPrescription'],
    queueState: 'pending',
    selectable: false,
    manuallyEdited: false,
    issues: [],
    identityReview: {
      status: 'confirmation_required',
      blocking: true,
      message: 'Confirm this fictional report subject.',
      evidencedIdentity: { fullName: 'Fictional Alder Bay', birthDate: '1993-07-18' },
      conflicts: [],
    },
  } satisfies IntakeImportFeed['blocks'][number]['records'][number];
  const clinicalFeed = (selectable: boolean, intakeVersion: number): IntakeImportFeed => ({
    ...feed,
    groups: [
      {
        ...group,
        intakeVersion,
        counts: selectable ? readyCounts : pendingCounts,
        sourceLabelScope: {
          contextId: 'fictional-exhausted-source-context',
          evidence: { label: 'Fictional report heading', locator: 'page 1 heading' },
        },
      },
    ],
    totalRecords: 1,
    counts: selectable ? readyCounts : pendingCounts,
    blocks: [
      {
        ...feed.blocks[0],
        intakeVersion,
        proposalId: 'fictional-exhausted-proposal',
        reviewToken: `fictional-exhausted-token-${intakeVersion}`,
        records: [
          selectable
            ? {
                ...identityRecord,
                classification: 'addition',
                mapping: { ...identityRecord.mapping, subject: 'self' },
                selectable: true,
                issues: [],
                identityReview: {
                  ...identityRecord.identityReview,
                  status: 'prior_confirmation' as const,
                  blocking: false,
                  message: 'A retained confirmation for this fictional report applies.',
                },
              }
            : identityRecord,
        ],
      },
    ],
    kindCounts: { ...feed.kindCounts, vision: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  });
  const displayedScope = {
    profileId,
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    sourceHash: 'fictional-exhausted-source-hash',
    memberId: null,
    original: { filename: 'fictional-exhausted.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1 heading', text: 'Fictional copper report' },
    subject: {
      locator: 'page 1 patient',
      text: 'Fictional Alder Bay · 1993-07-18',
    },
    verificationMode: 'literal_text_match' as const,
    evidencedIdentity: { fullName: 'Fictional Alder Bay', birthDate: '1993-07-18' },
    evidenceOriginalFingerprint: 'fictional-exhausted-original-fingerprint',
    membership: [],
    questions: [{ prompt: 'Does this exact fictional report belong to you?' }],
    targets: [
      {
        candidateId: identityRecord.candidateId,
        candidateVersionId: identityRecord.candidateVersionId,
        proposalId: 'fictional-exhausted-proposal',
        recordId: identityRecord.id,
        title: identityRecord.title,
        issueId: 'fictional-exhausted-identity-issue',
      },
    ],
    scopeToken: 'fictional-exhausted-scope-token-v1',
  };
  const displayedIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope: displayedScope,
    evidencedIdentity: displayedScope.evidencedIdentity,
    self: {
      noteId: 'person-note:self',
      version: 4,
      fullName: null,
      birthDate: '1993-07-18',
    },
    offeredSelfFields: { fullName: 'Fictional Alder Bay' },
    conflicts: [],
  };
  const retainedIdentity: IntakeIdentityReview = {
    ...displayedIdentity,
    status: 'prior_confirmation',
    blocking: false,
    message: 'A retained confirmation for this fictional report applies.',
    scope: {
      ...displayedScope,
      intakeVersion: 2,
      questions: undefined,
      targets: [],
      scopeToken: 'fictional-exhausted-scope-token-v2',
    },
    offeredSelfFields: {},
  };
  let feedReads = 0;
  let identityReads = 0;
  let identityPosts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) {
        feedReads += 1;
        return response(clinicalFeed(feedReads > 1, feedReads > 1 ? 2 : 1));
      }
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? displayedIdentity : retainedIdentity);
      }
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts += 1;
        return responseWithProfile(
          { id: group.intakeId, version: 2 },
          {
            id: profileId,
            name: 'Blue Lantern',
            placebo: true,
            nameVersion: 2,
            version: 2,
          },
        );
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /Review person for/ }));
  expect((await screen.findAllByText('Confirm this fictional report subject.'))[0]).toBeVisible();
  expect(
    screen.queryByText(
      'This item is kept with its original and cannot be saved as a structured record.',
    ),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review identity' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: /Full name/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'This is me' }));

  await waitFor(() => expect(identityPosts).toBe(1));
  await waitFor(() => expect(feedReads).toBeGreaterThan(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled());
  expect(screen.queryByText(/applies to 0 records/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'This is me' })).toBeNull();
});

it('recovers the exact uncertain overview retry on a second explicit action', async () => {
  selectProfile({ id: 'fictional-import-recovery', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const identityRecord = {
    feedKey: 'fictional-recovery-record-key',
    feedOrder: '0001',
    feedKind: 'test',
    id: 'fictional-recovery-record',
    classification: 'addition',
    kind: 'observation',
    title: 'Fictional recovery result',
    date: null,
    provider: 'Invented Clinic',
    candidateId: 'fictional-recovery-candidate',
    candidateVersionId: 'fictional-recovery-candidate-version',
    reviewState: 'pending',
    confidence: null,
    uncertainties: [],
    evidence: [],
    mapping: {
      kind: 'observation',
      subject: 'unknown',
      testLabel: 'Fictional recovery result',
      valueText: '12',
      unit: 'mg',
    },
    supportedFields: ['testLabel', 'valueText', 'unit'],
    queueState: 'pending',
    selectable: false,
    manuallyEdited: false,
  };
  const clinicalFeed = {
    ...feed,
    groups: [{ ...group, intakeVersion: 1, counts: pendingCounts }],
    totalRecords: 1,
    counts: pendingCounts,
    blocks: [
      {
        ...feed.blocks[0],
        proposalId: 'fictional-proposal',
        reviewToken: 'fictional-review-token',
        records: [identityRecord],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  } as IntakeImportFeed;
  const displayedScope = {
    profileId: 'fictional-import-recovery',
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    sourceHash: 'fictional-source-hash',
    memberId: null,
    original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1 heading', text: 'Fictional report' },
    subject: { locator: 'page 1 patient', text: 'Fictional Rowan' },
    verificationMode: 'literal_text_match' as const,
    evidencedIdentity: { fullName: 'Fictional Rowan' },
    evidenceOriginalFingerprint: 'fictional-original-fingerprint',
    membership: [],
    targets: [
      {
        candidateId: identityRecord.candidateId,
        candidateVersionId: identityRecord.candidateVersionId,
        proposalId: 'fictional-proposal',
        recordId: identityRecord.id,
        title: identityRecord.title,
        issueId: 'fictional-recovery-identity-issue',
      },
    ],
    scopeToken: 'fictional-recovery-scope-token-v1',
  };
  const displayedIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope: displayedScope,
    evidencedIdentity: displayedScope.evidencedIdentity,
    self: { noteId: 'person-note:self', version: 4, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  const freshIdentity: IntakeIdentityReview = {
    ...displayedIdentity,
    scope: {
      ...displayedScope,
      intakeVersion: 2,
      scopeToken: 'fictional-recovery-scope-token-v2',
    },
  };
  let identityReads = 0;
  const identityPosts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(clinicalFeed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        return response(identityReads === 1 ? displayedIdentity : freshIdentity);
      }
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts.push(JSON.parse(String(init?.body)));
        if (identityPosts.length === 1)
          return new Response(
            JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        if (identityPosts.length === 2)
          throw new Error('Fictional connection ended after the overview retry was sent');
        return response({ id: group.intakeId, version: 3 });
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /Review person for/ }));
  const action = await screen.findByRole('button', { name: 'This is me' });
  await user.click(action);
  await waitFor(() => expect(identityPosts).toHaveLength(2));
  expect(
    await screen.findByText('Fictional connection ended after the overview retry was sent'),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: /Review person for/ }));
  await user.click(screen.getByRole('button', { name: 'This is me' }));
  expect(
    await screen.findByText(
      'This report is confirmed as yours and its supported name is retained in your saved names. Clinical records remain in review.',
    ),
  ).toBeVisible();
  expect(identityPosts).toHaveLength(3);
  expect(identityPosts[2]).toEqual(identityPosts[1]);
  expect(identityPosts[2]!.operationId).toBe(identityPosts[0]!.operationId);
});

it('does not retry after the overview unmounts during its identity freshness read', async () => {
  selectProfile({ id: 'fictional-import-unmount', name: 'Rowan', placebo: true });
  const pendingCounts = { ...counts, pending: 1, blocked: 1, questions: 1 };
  const clinicalFeed = {
    ...feed,
    groups: [{ ...group, counts: pendingCounts }],
    totalRecords: 1,
    counts: pendingCounts,
    blocks: [
      {
        ...feed.blocks[0],
        proposalId: 'fictional-proposal',
        records: [
          {
            feedKey: 'fictional-unmount-record-key',
            feedOrder: '0001',
            feedKind: 'test',
            id: 'fictional-unmount-record',
            classification: 'addition',
            kind: 'observation',
            title: 'Fictional result',
            date: null,
            provider: 'Invented Clinic',
            candidateId: 'fictional-unmount-candidate',
            candidateVersionId: 'fictional-unmount-candidate-version',
            reviewState: 'pending',
            confidence: null,
            uncertainties: [],
            evidence: [],
            mapping: {
              kind: 'observation',
              subject: 'unknown',
              testLabel: 'Fictional result',
              valueText: '12',
              unit: 'mg',
            },
            supportedFields: ['testLabel', 'valueText', 'unit'],
            queueState: 'pending',
            selectable: false,
            manuallyEdited: false,
          },
        ],
      },
    ],
    kindCounts: { ...feed.kindCounts, test: 1 },
    activity: { ...feed.activity, allCurrentReportsReviewed: false },
  } as IntakeImportFeed;
  const displayedScope = {
    profileId: 'fictional-import-unmount',
    intakeId: group.intakeId,
    intakeVersion: 1,
    groupId: group.groupId,
    groupVersionId: group.groupVersionId,
    sourceHash: 'fictional-source-hash',
    memberId: null,
    original: { filename: 'fictional.pdf', contentUrl: '/fictional-original', page: 1 },
    report: { locator: 'page 1 heading', text: 'Fictional report' },
    subject: { locator: 'page 1 patient', text: 'Fictional Rowan' },
    verificationMode: 'literal_text_match' as const,
    evidencedIdentity: { fullName: 'Fictional Rowan' },
    evidenceOriginalFingerprint: 'fictional-original-fingerprint',
    membership: [],
    targets: [
      {
        candidateId: 'fictional-unmount-candidate',
        candidateVersionId: 'fictional-unmount-candidate-version',
        proposalId: 'fictional-proposal',
        recordId: 'fictional-unmount-record',
        title: 'Fictional result',
        issueId: 'fictional-unmount-identity-issue',
      },
    ],
    scopeToken: 'fictional-unmount-scope-token',
  };
  const displayedIdentity: IntakeIdentityReview = {
    status: 'confirmation_required',
    blocking: true,
    message: 'Confirm this fictional report subject.',
    scope: displayedScope,
    evidencedIdentity: displayedScope.evidencedIdentity,
    self: { noteId: 'person-note:self', version: 4, fullName: null, birthDate: null },
    offeredSelfFields: {},
    conflicts: [],
  };
  let identityReads = 0;
  let releaseFresh!: (value: Response) => void;
  let identityPosts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/intakes/import-feed?')) return response(clinicalFeed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/identity-review')) {
        identityReads += 1;
        if (identityReads === 1) return response(displayedIdentity);
        return new Promise<Response>((resolve) => {
          releaseFresh = resolve;
        });
      }
      if (url.endsWith('/intakes/fictional-intake/identity-scope')) {
        identityPosts += 1;
        return new Response(
          JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Late progress.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fictional request: ${url}`);
    }),
  );
  const user = userEvent.setup();
  const mounted = render(
    <RouterProvider
      router={createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
        initialEntries: ['/import'],
      })}
    />,
  );

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Review person for/ })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: /Review person for/ }));
  await user.click(await screen.findByRole('button', { name: 'This is me' }));
  await waitFor(() => expect(identityReads).toBe(2));
  mounted.unmount();
  await releaseFresh(
    response({
      ...displayedIdentity,
      scope: {
        ...displayedScope,
        intakeVersion: 2,
        scopeToken: 'fictional-unmount-fresh-scope-token',
      },
    }),
  );
  await Promise.resolve();
  expect(identityPosts).toBe(1);
});

it('explains provider configuration rejection without promising an available finish time', async () => {
  mount('/import', feed, [
    {
      id: 'fictional-rejected-batch',
      status: 'running',
      automaticRun: true,
      reason: null,
      currentIndex: 0,
      createdAt: '2026-09-01T12:00:00Z',
      updatedAt: '2026-09-01T12:01:00Z',
      items: [
        {
          intakeId: group.intakeId,
          status: 'paused',
          reason: 'provider_rejected',
          automaticRun: true,
          reading: { accountedUnits: 1, totalUnits: 4, distinctReads: 1, readyRecords: 0 },
          readingJob: { activeMs: 60000, sliceStartedAt: null },
        },
      ],
    },
  ]);
  expect(await screen.findByText('Import needs attention')).toBeVisible();
  expect(
    screen.getByText(
      /Fix the provider configuration and check the connection; reading then continues automatically/,
    ),
  ).toBeVisible();
  expect(screen.getByText('Estimating…')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Resume imports' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop imports' })).toBeEnabled();
});
