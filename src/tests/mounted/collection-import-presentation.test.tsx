import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, MemoryRouter, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  CollectionImportReview,
  CollectionReportReview,
} from '../../app/features/import/CollectionImportReview';
import type {
  CollectionFeedRecord,
  CollectionImportFeed,
  CollectionReportGroupSummary,
} from '../../shared/intake-clinical-pages';
import {
  ImportReviewPresentation,
  type ImportReviewModel,
} from '../../app/features/import/ImportReviewPresentation';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: () => null,
}));
vi.mock('../../app/features/import/ImportDetailReview', () => ({
  ImportRecordDetail: () => null,
  ImportDetailReview: ({
    beforeCloseRef,
    onBack,
    selection,
    guardNavigation,
    externalPending,
  }: {
    beforeCloseRef?: { current: (() => Promise<boolean>) | null };
    onBack: () => void;
    selection: { recordId: string };
    guardNavigation?: boolean;
    externalPending?: boolean;
  }) => {
    const [dirty, setDirty] = useState(false);
    useEffect(() => {
      if (beforeCloseRef) beforeCloseRef.current = async () => !dirty;
      return () => {
        if (beforeCloseRef) beforeCloseRef.current = null;
      };
    }, [dirty, beforeCloseRef]);
    return (
      <section
        aria-label="Exact inline draft"
        data-guard-navigation={String(guardNavigation)}
        data-external-pending={String(externalPending)}
      >
        <p>{selection.recordId}</p>
        <input aria-label="Fictional draft value" onChange={() => setDirty(true)} />
        <button
          onClick={() => {
            setDirty(false);
            onBack();
          }}
        >
          Update fictional draft
        </button>
      </section>
    );
  },
}));
const profile = {
  id: 'fictional-collection-presentation',
  name: 'Fictional Reader',
  placebo: true,
};
const record = (id: string, groupId = 'visible-group', blocked = false): CollectionFeedRecord => ({
  intakeId: 'fictional-intake',
  groupId,
  groupOrdinal: 0,
  proposalId: 'fictional-proposal',
  intakeVersion: 7,
  reviewToken: blocked ? 'blocked-token' : 'ready-token',
  feedKind: 'test',
  feedKey: JSON.stringify(['fictional-intake', id, 'version-' + id]),
  feedOrder: id,
  manuallyEdited: false,
  detail: {
    kind: 'record',
    record: {
      id,
      title: 'Fictional glucose ' + id,
      provider: 'Fictional Clinic',
      date: '2026-08-10',
      kind: 'observation',
      classification: 'addition',
      confidence: 1,
      uncertainties: [],
      evidence: [],
      mapping: {
        kind: 'observation',
        testLabel: 'Fictional glucose ' + id,
        valueText: '87',
        unit: 'mg/dL',
        date: '2026-08-10',
      },
      supportedFields: [],
      candidateId: id,
      candidateVersionId: 'version-' + id,
      selectionReviewToken: blocked ? 'selected-blocked' : 'selected-ready',
      queueState: 'pending',
      selectable: !blocked,
      feedKey: JSON.stringify(['fictional-intake', id, 'version-' + id]),
      feedOrder: id,
      feedKind: 'test',
      manuallyEdited: false,
      ...(blocked
        ? {
            identityReview: {
              status: 'confirmation_required' as const,
              blocking: true,
              message: 'Check the fictional person.',
              evidencedIdentity: {},
              conflicts: [],
            },
          }
        : {}),
    },
  },
});
const feed = (rows: CollectionFeedRecord[]): CollectionImportFeed => ({
  format: 'health-intake-import-feed-v2',
  view: 'active',
  records: rows,
  totalRecords: 10001,
  totalGroups: 5001,
  nextCursor: 'next',
  counts: {
    pending: 10001,
    deferred: 0,
    blocked: rows.filter((row) => row.detail.kind === 'record' && !row.detail.record.selectable)
      .length,
    accepted: 0,
    keptOriginal: 0,
    superseded: 0,
    questions: 0,
  },
  kindCounts: {
    test: 10001,
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
});
const coverage = {
  total: 1,
  covered: 0,
  uncovered: 1,
  status: 'uncovered' as const,
  sourceCount: 0,
  bySource: { items: [], total: 0, nextCursor: null },
};
const header = (groupId: string): CollectionReportGroupSummary => ({
  format: 'health-intake-report-group-v2',
  intakeId: 'fictional-intake',
  intakeVersion: 7,
  groupId,
  groupOrdinal: 0,
  groupVersionId: 'group-v1',
  basis: 'fictional',
  discoveryOrder: 1,
  title: 'Fictional chemistry report',
  source: null,
  sourceScope: null,
  date: '2026-08-10',
  original: {
    filename: 'fictional-chemistry.pdf',
    contentUrl: '/api/sources/fictional-intake/content',
    parentSourceFileId: null,
  },
  member: null,
  report: null,
  reportContext: null,
  counts: feed([]).counts,
  peopleCounts: { pending: 0, later: 0, excluded: 0, saved: 0 },
  sourceCoverage: { current: coverage, saved: coverage },
  sourceReview: null,
  records: { intakeId: 'fictional-intake', groupId },
  people: { intakeId: 'fictional-intake', groupId },
});
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
const identity = {
  status: 'missing_warning',
  blocking: false,
  message: 'The fictional report has no printed identity.',
  scope: null,
  evidencedIdentity: {},
  self: { noteId: 'self', version: 1, fullName: 'Fictional Reader' },
  offeredSelfFields: {},
  conflicts: [],
};
function Location() {
  return <p aria-label="Current route">{useLocation().pathname + useLocation().search}</p>;
}
function mount(initial: CollectionImportFeed, route = '/import') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Location />
      <CollectionImportReview
        initial={initial}
        path="/intakes/import-feed?view=active"
        onChanged={vi.fn()}
        sourceProps={{ onChanged: vi.fn() }}
        onUpload={vi.fn()}
        busy={false}
        status=""
        error=""
      />
    </MemoryRouter>,
  );
}
beforeEach(() => {
  sessionStorage.clear();
  replaceProfiles([profile]);
  selectProfile(profile);
});
it('reuses inline correction and original dialogs for one visible page, preserving dirty navigation guards', async () => {
  const first = feed([record('first')]);
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      requests.push(url.pathname + url.search);
      if (url.pathname.endsWith('/import-feed'))
        return json(
          url.searchParams.has('cursor')
            ? { ...first, records: [record('second', 'next-group')], nextCursor: null }
            : first,
        );
      if (url.pathname.includes('/report-queue/'))
        return json({
          format: 'health-intake-report-detail-v2',
          group: header(url.pathname.split('/').at(-1)!),
        });
      if (url.pathname.endsWith('/identity-review')) return json(identity);
      throw new Error('Unexpected ' + url);
    }),
  );
  mount(first);
  await screen.findByText('Fictional chemistry report');
  fireEvent.click(screen.getByRole('button', { name: 'Original' }));
  const original = await screen.findByRole('link', { name: 'Open retained original' });
  expect(original).toHaveAttribute('target', '_blank');
  expect(original.getAttribute('href')).toContain(
    '/api/profiles/' + profile.id + '/sources/fictional-intake/content',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional glucose first' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByRole('region', { name: 'Exact inline draft' });
  expect(document.querySelectorAll('.import-record-accordion')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Fictional draft value' }), {
    target: { value: '88' },
  });
  fireEvent.click(screen.getByRole('button', { name: /person for Fictional chemistry report/ }));
  await act(async () => {});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  await act(async () => {});
  expect(requests.filter((path) => path.includes('cursor=next'))).toHaveLength(0);
  expect(screen.getByLabelText('Current route')).toHaveTextContent('/import');
  fireEvent.click(screen.getByRole('button', { name: 'Update fictional draft' }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Exact inline draft' })).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  await screen.findByRole('checkbox', { name: 'Select Fictional glucose second' });
  expect(
    screen.queryByRole('checkbox', { name: 'Select Fictional glucose first' }),
  ).not.toBeInTheDocument();
  expect(
    requests
      .filter((path) => path.includes('/report-queue/'))
      .map((path) => new URL(path, 'https://fictional.invalid').pathname.split('/').at(-1)),
  ).toEqual(['visible-group', 'next-group']);
  expect(screen.getByText(/10,001 clinical records/)).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional glucose second' }));
  fireEvent.click(screen.getByRole('button', { name: 'First records' }));
  expect(
    await screen.findByRole('checkbox', { name: 'Select Fictional glucose first' }),
  ).not.toBeChecked();
});
it('grounds only displayed report identity and refreshes readiness once without a blocked response loop', async () => {
  const blocked = feed([
    record('first', 'visible-group', true),
    record('second', 'visible-group', true),
  ]);
  let feedReads = 0;
  const identityGroups: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) {
        feedReads++;
        return json(
          feedReads === 1
            ? blocked
            : {
                ...blocked,
                records: [record('first'), record('second')],
                counts: { ...blocked.counts, blocked: 0 },
              },
        );
      }
      if (url.pathname.includes('/report-queue/'))
        return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
      if (url.pathname.endsWith('/identity-review')) {
        identityGroups.push(url.searchParams.get('groupId')!);
        return json({
          ...identity,
          status: 'evidenced_match',
          scope: { scopeToken: 'same-confirmed-scope' },
        });
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  mount(blocked);
  await waitFor(() =>
    expect(
      screen
        .getAllByRole('button', { name: 'Confirm & save' })
        .every((button) => !button.hasAttribute('disabled')),
    ).toBe(true),
  );
  await act(async () => {});
  expect(feedReads).toBe(2);
  expect(new Set(identityGroups)).toEqual(new Set(['visible-group']));
  expect(identityGroups.length).toBeLessThanOrEqual(3);
  expect(screen.getAllByRole('checkbox', { name: /Select Fictional glucose/ })).toHaveLength(2);
});
it('opens a direct selected record inline without replacing the import route', async () => {
  const data = feed([record('first')]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) return json(data);
      if (url.pathname.includes('/report-queue/'))
        return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
      if (url.pathname.endsWith('/identity-review')) return json(identity);
      throw new Error('Unexpected ' + url);
    }),
  );
  const route =
    '/import?intake=fictional-intake&group=visible-group&proposal=fictional-proposal&record=first';
  mount(data, route);
  expect(await screen.findByRole('region', { name: 'Exact inline draft' })).toBeVisible();
  expect(document.querySelectorAll('.import-record-accordion')).toHaveLength(1);
  expect(screen.getByLabelText('Current route')).toHaveTextContent(route);
});
it('retains an uncertain report-wide source command and blocks overview Back until exact retry', async () => {
  const first = record('first');
  const detail = {
    format: 'health-intake-report-detail-v2' as const,
    group: header('visible-group'),
    records: {
      format: 'health-intake-report-record-page-v2' as const,
      intakeId: 'fictional-intake',
      version: 7,
      scope: 'clinical_records' as const,
      view: 'all' as const,
      records: [],
      totalRecords: 1,
      nextCursor: null,
    },
    people: {
      format: 'health-intake-people-page-v2' as const,
      intakeId: 'fictional-intake',
      groupId: 'visible-group',
      selectedPersonId: null,
      people: [],
      totalPeople: 0,
      counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
      nextCursor: null,
    },
  };
  const sourceReview = {
    format: 'health-intake-report-source-review-v2',
    profileId: profile.id,
    intakeId: first.intakeId,
    intakeVersion: 7,
    groupId: first.groupId,
    groupVersionId: 'group-v1',
    scopeToken: 'fictional-source-scope',
    view: 'all',
    targets: { items: [], total: 1, nextCursor: null },
    coverage,
    sourceEvidence: { items: [], total: 0, nextCursor: null },
    conflictingSourceEvidence: false,
  };
  const writes: unknown[] = [];
  const back = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.includes('/report-queue/')) return json(detail);
      if (url.pathname.endsWith('/identity-review')) return json(identity);
      if (url.pathname.endsWith('/report-source-review')) return json(sourceReview);
      if (url.pathname.endsWith('/report-source')) {
        writes.push(JSON.parse(String(init?.body)));
        if (writes.length === 1) throw new TypeError('Fictional response lost');
        return json({});
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  render(
    <MemoryRouter>
      <CollectionReportReview
        initial={detail}
        selection={{ intakeId: first.intakeId, groupId: first.groupId }}
        onBack={back}
        onChanged={vi.fn()}
        onUseSource={() => {}}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Source label for this report'));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Source' }), {
    target: { value: 'Fictional chemistry clinic' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use source for 1 records' }));
  await screen.findByText('Fictional response lost');
  expect(screen.getByRole('button', { name: 'Back to Import' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Source' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Import' }));
  expect(back).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Use source for 1 records' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Back to Import' })).toBeEnabled());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Back to Import' }));
  expect(back).toHaveBeenCalledOnce();
});
it('keeps an uncertain native identity sheet mounted when refreshed discovery confirms or removes its report', async () => {
  const report = {
    id: 'visible-group',
    source: 'Fictional Clinic',
    sourceConfirmed: true,
    reportType: 'Fictional chemistry report',
    date: '2026-08-10',
    subject: { label: 'Fictional Reader', evidence: 'named' as const, confirmed: false },
  };
  const model: ImportReviewModel = {
    contextKey: 'fictional',
    selectionWindowKey: 'page-one',
    reports: [report],
    records: [
      {
        id: 'first',
        reportId: report.id,
        kind: 'Test results',
        label: 'Fictional glucose',
        originalLabel: 'Fictional glucose',
        value: '87',
        status: 'review',
        eligible: false,
      },
    ],
  };
  function Pending({ onPending }: { onPending: (pending: boolean) => void }) {
    useEffect(() => {
      onPending(true);
      return () => onPending(false);
    }, []);
    return <p>Unconfirmed exact identity command</p>;
  }
  const context: NonNullable<
    React.ComponentProps<typeof ImportReviewPresentation>['renderReportContext']
  > = (_tab, _report, _close, onPending) => <Pending onPending={onPending} />;
  const mounted = render(<ImportReviewPresentation model={model} renderReportContext={context} />);
  fireEvent.click(screen.getByRole('button', { name: /Review person for/ }));
  await screen.findByText('Unconfirmed exact identity command');
  mounted.rerender(
    <ImportReviewPresentation
      model={{
        ...model,
        reports: [{ ...report, subject: { ...report.subject, confirmed: true } }],
      }}
      renderReportContext={context}
    />,
  );
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  mounted.rerender(
    <ImportReviewPresentation
      model={{ ...model, reports: [], records: [] }}
      renderReportContext={context}
    />,
  );
  expect(screen.getByText('Unconfirmed exact identity command')).toBeVisible();
  expect(screen.getByRole('dialog')).toBeVisible();
});
for (const fallback of [false, true])
  it(`owns one DataRouter guard for a direct inline URL and uncertain overview source choice (fallback=${fallback})`, async () => {
    const data = feed([record('first')]);
    const route =
      '/import?intake=fictional-intake&group=visible-group&proposal=fictional-proposal&record=' +
      (fallback ? 'off-page' : 'first');
    const sourceReview = {
      format: 'health-intake-report-source-review-v2',
      profileId: profile.id,
      intakeId: 'fictional-intake',
      intakeVersion: 7,
      groupId: 'visible-group',
      groupVersionId: 'group-v1',
      scopeToken: 'fictional-source-scope',
      view: 'all',
      targets: { items: [], total: 1, nextCursor: null },
      coverage,
      sourceEvidence: { items: [], total: 0, nextCursor: null },
      conflictingSourceEvidence: false,
    };
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.endsWith('/import-feed')) return json(data);
        if (url.pathname.includes('/report-queue/'))
          return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
        if (url.pathname.endsWith('/identity-review')) return json(identity);
        if (url.pathname.endsWith('/report-source-review')) return json(sourceReview);
        if (url.pathname.endsWith('/report-source')) {
          writes.push(JSON.parse(String(init?.body)));
          if (writes.length === 1) throw new TypeError('Fictional direct-link reply lost');
          return json({});
        }
        throw new Error('Unexpected ' + url);
      }),
    );
    const warning = vi.spyOn(console, 'warn');
    const router = createMemoryRouter(
      [
        { path: '/away', element: <p>Fictional previous page</p> },
        {
          path: '/import',
          element: (
            <CollectionImportReview
              initial={data}
              path="/intakes/import-feed?view=active"
              onChanged={vi.fn()}
              sourceProps={{ onChanged: vi.fn() }}
              onUpload={vi.fn()}
              busy={false}
              status=""
              error=""
            />
          ),
        },
      ],
      { initialEntries: ['/away', route], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    const inline = await screen.findByRole('region', { name: 'Exact inline draft' });
    expect(inline).toHaveAttribute('data-guard-navigation', 'false');
    await screen.findByText('Fictional chemistry report');
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    const dialog = await screen.findByRole('dialog');
    if (fallback)
      expect(
        screen.getByRole('region', { name: 'Exact inline draft', hidden: true }),
      ).toBeInTheDocument();
    else
      expect(
        screen.queryByRole('region', { name: 'Exact inline draft', hidden: true }),
      ).not.toBeInTheDocument();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Source' }), {
      target: { value: 'Fictional source choice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use source for 1 records' }));
    await screen.findByText('Fictional direct-link reply lost');
    if (fallback)
      expect(
        screen.getByRole('region', { name: 'Exact inline draft', hidden: true }),
      ).toHaveAttribute('data-external-pending', 'true');
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(router.state.blockers.size).toBe(1));
    expect(router.state.location.pathname + router.state.location.search).toBe(route);
    expect(dialog).toBeVisible();
    expect(writes).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep reviewing', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Use source for 1 records' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      await router.navigate(-1);
    });
    expect(await screen.findByText('Fictional previous page')).toBeVisible();
    expect(warning.mock.calls.flat().join(' ')).not.toContain('only supports one blocker');
  });
