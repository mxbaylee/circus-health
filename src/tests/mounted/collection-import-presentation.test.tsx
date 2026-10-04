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
import { ImportPage } from '../../app/features/import/ImportPage';
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
for (const succeeds of [true, false]) {
  it(`keeps native uploads unavailable while limits load and handles their ${succeeds ? 'arrival' : 'failure'}`, async () => {
    let releaseLimits!: (response: Response) => void;
    const limits = new Promise<Response>((resolve) => {
      releaseLimits = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.endsWith('/import-feed')) return json(feed([record('first')]));
        if (url.pathname.endsWith('/intake-batches')) return json([]);
        if (url.pathname.endsWith('/intakes/limits')) return limits;
        if (url.pathname.includes('/report-queue/'))
          return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
        if (url.pathname.endsWith('/identity-review')) return json(identity);
        throw new Error('Unexpected ' + url);
      }),
    );
    const { container } = render(
      <MemoryRouter initialEntries={['/import']}>
        <ImportPage />
      </MemoryRouter>,
    );
    const selection = await screen.findByRole('checkbox', {
      name: 'Select Fictional glucose first',
    });
    await waitFor(() => expect(selection).toBeEnabled());
    const input = container.querySelector('input[type=file]')!;
    expect(input).toBeDisabled();
    expect(screen.getByText('Getting ready to upload…')).toBeVisible();
    await act(async () => {
      releaseLimits(
        succeeds
          ? json({ uploadBytes: 1024, extractionBytes: 1024 })
          : new Response(
              JSON.stringify({
                error: { code: 'FICTIONAL_LIMITS_FAILURE', message: 'Unavailable' },
              }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            ),
      );
    });
    if (succeeds) await waitFor(() => expect(input).toBeEnabled());
    else {
      expect(
        await screen.findByText('Uploads are unavailable. Reload the page to try again.'),
      ).toBeVisible();
      expect(input).toBeDisabled();
    }
    expect(screen.queryByText('Getting ready to upload…')).not.toBeInTheDocument();
  });
}
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
function mountIdentityWindow(initial: CollectionImportFeed, reload = vi.fn()) {
  const firstPage = { reload, error: null };
  const view = (current: CollectionImportFeed) => (
    <MemoryRouter initialEntries={['/import']}>
      <CollectionImportReview
        initial={current}
        path="/intakes/import-feed?view=active&state=pending&limit=40&bytes=65536"
        firstPage={firstPage}
        onChanged={vi.fn()}
        sourceProps={{ onChanged: vi.fn() }}
        onUpload={vi.fn()}
        busy={false}
        status=""
        error=""
      />
    </MemoryRouter>
  );
  const mounted = render(view(initial));
  return {
    ...mounted,
    replace: (current: CollectionImportFeed) => mounted.rerender(view(current)),
  };
}
function heldIdentity() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, release: (value: unknown = identity) => resolve(json(value)), reject };
}
function identityDispatchFetch(
  load: (url: URL, signal: AbortSignal | null | undefined) => Promise<Response>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, options: RequestInit = {}) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/identity-review')) return load(url, options.signal);
      if (url.pathname.includes('/report-queue/')) {
        const groupId = decodeURIComponent(url.pathname.split('/').at(-1)!);
        const intakeId = url.searchParams.get('intakeId')!;
        return json({
          format: 'health-intake-report-detail-v2',
          group: { ...header(groupId), intakeId, records: { intakeId, groupId } },
        });
      }
      throw new Error('Unexpected ' + url);
    }),
  );
}
it('dispatches a source second identity group only after its first settles while another source stays concurrent', async () => {
  const first = heldIdentity();
  const calls: string[] = [];
  identityDispatchFetch(async (url) => {
    const group = url.searchParams.get('groupId')!;
    calls.push(group);
    return group === 'first-group' ? first.promise : json(identity);
  });
  const independent = { ...record('independent', 'independent-group'), intakeId: 'other-intake' };
  mountIdentityWindow(
    feed([record('first', 'first-group'), record('second', 'second-group'), independent]),
  );
  await waitFor(() => expect(calls).toEqual(['first-group', 'independent-group']));
  await act(async () => first.release());
  await waitFor(() => expect(calls).toEqual(['first-group', 'independent-group', 'second-group']));
});
it('releases the next identity group after a failed first read without retrying the failed group', async () => {
  const first = heldIdentity();
  const calls: string[] = [];
  identityDispatchFetch(async (url) => {
    const group = url.searchParams.get('groupId')!;
    calls.push(group);
    return group === 'first-group' ? first.promise : json(identity);
  });
  mountIdentityWindow(feed([record('first', 'first-group'), record('second', 'second-group')]));
  await waitFor(() => expect(calls).toEqual(['first-group']));
  await act(async () => first.reject(new Error('Controlled first identity read failed')));
  await waitFor(() => expect(calls).toEqual(['first-group', 'second-group']));
  await act(async () => {});
  expect(calls).toEqual(['first-group', 'second-group']);
});
it('cancels a queued identity group on unmount', async () => {
  const first = heldIdentity();
  const calls: string[] = [];
  let dispatchedSignal: AbortSignal | null | undefined;
  identityDispatchFetch(async (url, signal) => {
    calls.push(url.searchParams.get('groupId')!);
    dispatchedSignal = signal;
    return first.promise;
  });
  const mounted = mountIdentityWindow(
    feed([record('first', 'first-group'), record('second', 'second-group')]),
  );
  await waitFor(() => expect(calls).toEqual(['first-group']));
  mounted.unmount();
  expect(dispatchedSignal?.aborted).toBe(true);
  await act(async () => first.release());
  expect(calls).toEqual(['first-group']);
});
it('cancels old queued identity work on refresh and preserves the newer same-signature request after old completion', async () => {
  const oldFirst = heldIdentity(),
    freshFirst = heldIdentity();
  const calls: string[] = [],
    signals: Array<AbortSignal | null | undefined> = [];
  identityDispatchFetch(async (url, signal) => {
    const group = url.searchParams.get('groupId')!;
    calls.push(group);
    signals.push(signal);
    return group === 'first-group'
      ? calls.length === 1
        ? oldFirst.promise
        : freshFirst.promise
      : json(identity);
  });
  const initial = feed([record('first', 'first-group'), record('second', 'second-group')]);
  const mounted = mountIdentityWindow(initial);
  await waitFor(() => expect(calls).toEqual(['first-group']));
  mounted.replace({
    ...initial,
    records: [...initial.records],
  });
  await waitFor(() => expect(calls).toEqual(['first-group', 'first-group']));
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  await act(async () => oldFirst.release());
  expect(calls).toEqual(['first-group', 'first-group']);
  await act(async () =>
    freshFirst.release({
      ...identity,
      evidencedIdentity: { fullName: 'Fictional Fresh Identity' },
    }),
  );
  await waitFor(() => expect(calls).toEqual(['first-group', 'first-group', 'second-group']));
  expect(await screen.findByText(/Fictional Fresh Identity/)).toBeInTheDocument();
  // A successfully settled shared transport closes its controller as well.
  expect(signals[1]?.aborted).toBe(true);
});
it('cancels queued old-profile identity work and dispatches only the new profile after replacement', async () => {
  const oldFirst = heldIdentity(),
    freshFirst = heldIdentity();
  const calls: Array<{ path: string; group: string }> = [];
  identityDispatchFetch(async (url) => {
    const group = url.searchParams.get('groupId')!;
    calls.push({ path: url.pathname, group });
    return group === 'first-group'
      ? calls.length === 1
        ? oldFirst.promise
        : freshFirst.promise
      : json(identity);
  });
  const initial = feed([record('first', 'first-group'), record('second', 'second-group')]);
  const mounted = mountIdentityWindow(initial);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => {
    const replacement = { ...profile, id: 'replacement-identity-profile' };
    replaceProfiles([profile, replacement]);
    selectProfile(replacement);
    mounted.replace({
      ...initial,
      records: initial.records.map((row) => ({
        ...row,
        intakeId: 'replacement-intake',
        reviewToken: 'replacement-' + row.groupId,
      })),
    });
  });
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.path).toContain(
    '/profiles/replacement-identity-profile/intakes/replacement-intake/',
  );
  await act(async () => oldFirst.release());
  expect(calls).toHaveLength(2);
  await act(async () => freshFirst.release());
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls.map((call) => call.group)).toEqual(['first-group', 'first-group', 'second-group']);
  expect(calls[2]!.path).toContain('/profiles/replacement-identity-profile/');
});
it('refreshes once for each sequential grounded scope and does not repeat for an unchanged displayed window', async () => {
  const first = heldIdentity();
  const calls: string[] = [];
  const reload = vi.fn();
  identityDispatchFetch(async (url) => {
    const group = url.searchParams.get('groupId')!;
    calls.push(group);
    return group === 'first-group'
      ? first.promise
      : json({ ...identity, status: 'evidenced_match', scope: { scopeToken: 'second-scope' } });
  });
  const initial = feed([
    record('first', 'first-group', true),
    record('second', 'second-group', true),
  ]);
  const mounted = mountIdentityWindow(initial, reload);
  await waitFor(() => expect(calls).toEqual(['first-group']));
  expect(reload).not.toHaveBeenCalled();
  await act(async () =>
    first.release({ ...identity, status: 'evidenced_match', scope: { scopeToken: 'first-scope' } }),
  );
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  mounted.replace({ ...initial, records: [...initial.records] });
  await act(async () => {});
  expect(calls).toEqual(['first-group', 'second-group']);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('shares the native first feed with ImportPage and refreshes the exact visible window after parent changes', async () => {
  let releaseBatch!: (response: Response) => void;
  let releaseIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  let grounded = false;
  let revised = false;
  const feeds: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) {
        feeds.push(url);
        expect(url.searchParams.get('limit')).toBe('40');
        expect(url.searchParams.get('bytes')).toBe('65536');
        return json(
          feed([
            record(
              url.searchParams.has('cursor') ? (revised ? 'updated-next' : 'next') : 'first',
              'visible-group',
              !grounded,
            ),
          ]),
        );
      }
      if (url.pathname.endsWith('/intake-batches'))
        return new Promise<Response>((resolve) => {
          releaseBatch = resolve;
        });
      if (url.pathname.endsWith('/intakes/limits'))
        return json({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.pathname.includes('/report-queue/'))
        return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
      if (url.pathname.endsWith('/identity-review')) {
        await identityReady;
        grounded = true;
        return json({
          ...identity,
          status: 'evidenced_match',
          scope: { scopeToken: 'grounded-scope' },
        });
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/import']}>
      <ImportPage />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  await act(async () => {});
  expect(feeds).toHaveLength(1);
  await act(async () => {
    releaseBatch(
      json([
        {
          id: 'fictional-batch',
          status: 'complete',
          items: [{ intakeId: 'fictional-intake', status: 'review_ready', reason: null }],
        },
      ]),
    );
  });
  await waitFor(() => expect(feeds).toHaveLength(2));
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  await act(async () => {
    releaseIdentity();
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled());
  expect(feeds).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  expect(
    await screen.findByRole('checkbox', { name: 'Select Fictional glucose next' }),
  ).toBeEnabled();
  expect(feeds).toHaveLength(4);
  expect(feeds.at(-1)!.searchParams.get('cursor')).toBe('next');
  revised = true;
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  expect(
    await screen.findByRole('checkbox', { name: 'Select Fictional glucose updated-next' }),
  ).toBeEnabled();
  expect(
    screen.queryByRole('checkbox', { name: 'Select Fictional glucose first' }),
  ).not.toBeInTheDocument();
  expect(feeds).toHaveLength(6);
  expect(feeds.at(-1)!.searchParams.get('cursor')).toBe('next');
});
it('blocks stale later-window writes after a failed parent refresh and retries the same cursor', async () => {
  let parentReads = 0;
  let cursorReads = 0;
  let writes = 0;
  let releaseParent!: (value: Response) => void;
  let releaseCursor!: (value: Response) => void;
  const first = feed([record('first')]);
  const next = feed([record('next')]);
  const fresh = feed([record('fresh-next')]);
  const failed = () =>
    new Response(
      JSON.stringify({
        error: { code: 'FICTIONAL_REFRESH_FAILURE', message: 'Fictional parent refresh failed.' },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) {
        if (url.searchParams.has('cursor')) {
          expect(url.searchParams.get('cursor')).toBe('next');
          cursorReads++;
          if (cursorReads === 2)
            return new Promise<Response>((resolve) => {
              releaseCursor = resolve;
            });
          return json(cursorReads === 1 ? next : fresh);
        }
        parentReads++;
        if (parentReads === 2 || parentReads === 4) return failed();
        if (parentReads === 3)
          return new Promise<Response>((resolve) => {
            releaseParent = resolve;
          });
        return json(first);
      }
      if (url.pathname.endsWith('/intake-batches')) return json([]);
      if (url.pathname.endsWith('/intakes/limits'))
        return json({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.pathname.includes('/report-queue/'))
        return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
      if (url.pathname.endsWith('/identity-review')) return json(identity);
      if (url.pathname.endsWith('/review-record'))
        return json({
          format: 'health-intake-clinical-record-v2',
          context: {
            intakeId: 'fictional-intake',
            proposalId: 'fictional-proposal',
            version: 7,
            reviewToken: 'ready-token',
          },
          record: next.records[0]!.detail,
        });
      if (url.pathname.endsWith('/review-draft')) {
        expect(JSON.parse(String(init?.body)).disposition).toBe('review_later');
        writes++;
        return json({});
      }
      throw new Error('Unexpected ' + url);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/import']}>
      <ImportPage />
    </MemoryRouter>,
  );
  await screen.findByRole('checkbox', { name: 'Select Fictional glucose first' });
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  await screen.findByRole('checkbox', { name: 'Select Fictional glucose next' });
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  await screen.findByText('Fictional parent refresh failed.');
  expect(writes).toBe(1);
  expect(parentReads).toBe(2);
  expect(cursorReads).toBe(1);
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  expect(document.querySelector('input[type=file]')).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  await act(async () => {});
  expect(writes).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh import review' }));
  await waitFor(() => expect(parentReads).toBe(3));
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  expect(document.querySelector('input[type=file]')).toBeEnabled();
  await act(async () => {
    releaseParent(json(first));
  });
  await waitFor(() => expect(cursorReads).toBe(2));
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  await act(async () => {
    releaseCursor(json(fresh));
  });
  await screen.findByRole('checkbox', { name: 'Select Fictional glucose fresh-next' });
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled();
  expect(
    screen.queryByRole('checkbox', { name: 'Select Fictional glucose first' }),
  ).not.toBeInTheDocument();
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  fireEvent(window, restored);
  await screen.findByText('Fictional parent refresh failed.');
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh import review' }));
  await waitFor(() => expect(cursorReads).toBe(3));
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled();
  expect(parentReads).toBe(5);
  expect(writes).toBe(1);
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

it('opens the complete Documents union before paging and clears unrelated page selection', async () => {
  const initial = feed(Array.from({ length: 40 }, (_, index) => record('test-' + index)));
  initial.totalRecords = 42;
  initial.counts.pending = 42;
  initial.kindCounts = { ...initial.kindCounts, test: 40, history: 1, unsupported: 1 };
  initial.nextCursor = 'unfiltered-next';
  const document = (id: string, kind: 'history' | 'unsupported') => {
    const row = record(id);
    row.feedKind = kind;
    if (row.detail.kind !== 'record') throw Error('Expected fictional inline record');
    row.detail.record.feedKind = kind;
    row.detail.record.title = id;
    row.detail.record.kind = kind === 'history' ? 'document' : 'unsupported';
    row.detail.record.mapping = { kind: row.detail.record.kind, documentTitle: id };
    row.detail.record.selectable = kind === 'history';
    return row;
  };
  const history = document('Fictional history document', 'history'),
    unsupported = document('Fictional unsupported document', 'unsupported'),
    reads: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) {
        reads.push(url);
        if (url.searchParams.get('kind') === 'documents') {
          const next = url.searchParams.get('cursor') === 'documents-next';
          return json({
            ...initial,
            records: [next ? unsupported : history],
            totalRecords: 2,
            nextCursor: next ? null : 'documents-next',
          });
        }
        return json(initial);
      }
      if (url.pathname.includes('/report-queue/'))
        return json({ format: 'health-intake-report-detail-v2', group: header('visible-group') });
      if (url.pathname.endsWith('/identity-review')) return json(identity);
      throw new Error('Unexpected ' + url);
    }),
  );
  mount(initial);
  const previous = await screen.findByRole('checkbox', { name: 'Select Fictional glucose test-0' });
  await waitFor(() => expect(previous).toBeEnabled());
  fireEvent.click(previous);
  expect(previous).toBeChecked();
  fireEvent.click(screen.getByRole('tab', { name: /^Documents\s*2$/ }));
  const selected = await screen.findByRole('checkbox', {
    name: 'Select Fictional history document',
  });
  expect(screen.getByRole('tab', { name: /^Documents\s*2$/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    screen.queryByRole('checkbox', { name: 'Select Fictional glucose test-0' }),
  ).not.toBeInTheDocument();
  expect(selected).not.toBeChecked();
  fireEvent.click(selected);
  expect(selected).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }));
  const next = await screen.findByRole('checkbox', {
    name: 'Select Fictional unsupported document',
  });
  expect(next).not.toBeChecked();
  expect(
    screen.queryByRole('checkbox', { name: 'Select Fictional history document' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled();
  expect(
    reads.some(
      (url) => url.searchParams.get('kind') === 'documents' && !url.searchParams.has('cursor'),
    ),
  ).toBe(true);
  expect(
    reads.some(
      (url) =>
        url.searchParams.get('kind') === 'documents' &&
        url.searchParams.get('cursor') === 'documents-next',
    ),
  ).toBe(true);
  expect(reads.some((url) => url.searchParams.get('cursor') === 'unfiltered-next')).toBe(false);
});
