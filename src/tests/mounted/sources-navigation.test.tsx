import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { Sources } from '../../app/pages/Sources';
import { selectProfile } from '../../app/data/profile';

vi.mock('../../app/components/SourceDialog', () => ({
  SourceDialog: () => null,
  SourcePreview: () => null,
  SourceRecordView: () => null,
}));
vi.mock('../../app/components/RelatedNotes', () => ({ RelatedNotes: () => null }));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));

it('keeps source tabs separate from filters and preserves URL filters across keyboard navigation', async () => {
  selectProfile({ id: 'fictional-sources', name: 'Cookie Dough', placebo: true });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [], meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const user = userEvent.setup();
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources?q=fictional&visibility=archived&offset=30&recordOffset=30'],
  });
  render(<RouterProvider router={router} />);
  const tabs = screen.getByRole('tablist', { name: 'Source browsing' });
  const search = screen.getByRole('textbox', { name: 'Search source files' });
  expect(tabs).not.toContainElement(search);
  expect(search.closest('.collection-toolbar')).toContainElement(
    screen.getByText('Inactive', { selector: '.people-filter-pill > span' }),
  );
  within(tabs).getByRole('tab', { name: 'Files' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(within(tabs).getByRole('tab', { name: 'Records' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'source-records-tab');
  expect(router.state.location.search).toContain('view=records');
  expect(router.state.location.search).toContain('visibility=archived');
  expect(router.state.location.search).toContain('q=fictional');
  expect(router.state.location.search).not.toContain('offset=');
  expect(router.state.location.search).not.toContain('recordOffset=');
  await waitFor(() =>
    expect(
      requests.some(
        (url) =>
          url.includes('/source-records?') &&
          url.includes('q=fictional') &&
          url.includes('visibility=archived'),
      ),
    ).toBe(true),
  );
  await user.keyboard('{End}');
  expect(within(tabs).getByRole('tab', { name: 'Documents' })).toHaveFocus();
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'source-documents-tab');
  await user.keyboard('{Home}');
  expect(within(tabs).getByRole('tab', { name: 'Files' })).toHaveFocus();
  expect(router.state.location.search).not.toContain('view=');
});

it.each(['view=import&return=import&', '', 'view=records&return=import&'])(
  'redirects historical Sources Import links with prefix %s to the exact Import selection',
  async (prefix) => {
    selectProfile({ id: 'fictional-import-navigation', name: 'Fictional Rowan', placebo: true });
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ data: [], meta: { revision: 1 } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const router = createMemoryRouter(
      [
        { path: '/sources', element: <Sources /> },
        { path: '/import', element: <div>Dedicated Import</div> },
      ],
      {
        initialEntries: [
          `/sources?${prefix}intake=fictional-intake&group=fictional-report&report=fictional-report-alias&proposal=fictional-proposal&record=fictional-pending-row&q=retained`,
        ],
      },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText('Dedicated Import');
    expect(requests.some((url) => /\/(sources|source-records|documents)([/?]|$)/.test(url))).toBe(
      false,
    );
    expect(router.state.location.pathname).toBe('/import');
    const params = new URLSearchParams(router.state.location.search);
    expect(params.has('view')).toBe(false);
    expect(params.has('return')).toBe(false);
    expect(params.get('intake')).toBe('fictional-intake');
    expect(params.get('group')).toBe('fictional-report');
    expect(params.get('report')).toBe('fictional-report-alias');
    expect(params.get('proposal')).toBe('fictional-proposal');
    expect(params.get('record')).toBe('fictional-pending-row');
    expect(params.get('q')).toBe('retained');
    expect(requests.some((url) => url.includes('/source-records/fictional-pending-row'))).toBe(
      false,
    );
  },
);

it('lists retained proposal records through their exact original-file lineage', async () => {
  selectProfile({ id: 'fictional-sources', name: 'Cookie Dough', placebo: true });
  const requests: string[] = [];
  const originalFile = {
    id: 'root-original',
    providerId: 'fictional-provider',
    provider: 'Fictional Vision',
    reviewedSourceProviderId: 'fictional-reviewed-provider',
    reviewedSource: 'Fictional Reviewed Source Label',
    path: 'fictional/prescription.png',
    sha256: 'fictional-hash',
    bytes: 42,
    mimeType: 'image/png',
    kind: 'intake_original',
    coverageStatus: 'original_retained; clinical_coverage_unknown',
    details: {},
    contentUrl: '/fictional-original',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      let data: unknown = [];
      if (url.includes('/sources/root-original')) data = originalFile;
      else if (url.includes('/sources?')) data = [originalFile];
      else if (url.includes('/source-records?'))
        data = [
          {
            id: 'retained-proposal-record',
            sourceFileId: 'proposal-file',
            providerId: 'fictional-provider',
            provider: 'Fictional Reviewed Vision',
            sourceKey: 'line:1',
            kind: 'intake_document',
            label: 'Fictional optical prescription',
            date: null,
            raw: {},
            locator: { originalSourceFileId: 'root-original' },
            extractionStatus: 'projected_reviewed',
          },
        ];
      return new Response(JSON.stringify({ data, meta: { revision: 1, total: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources?file=root-original'],
  });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText('Fictional optical prescription')).toBeVisible();
  expect(screen.getByText('Record source: Fictional Reviewed Vision')).toBeVisible();
  expect(screen.queryByText('Date not recorded')).toBeNull();
  expect(screen.getAllByText('File acquisition source: Fictional Vision').length).toBeGreaterThan(
    0,
  );
  expect(screen.getByText('Reviewed source label: Fictional Reviewed Source Label')).toBeVisible();
  expect(
    within(screen.getByText('Reviewed source label', { selector: 'dt' }).parentElement!).getByText(
      'Fictional Reviewed Source Label',
    ),
  ).toBeVisible();
  expect(screen.getByText('Linked to a saved health record', { exact: false })).toBeVisible();
  expect(screen.getAllByText('Original retained').length).toBeGreaterThan(0);
  const coverage = screen.getByText(
    'Full-file coverage was not recorded when this snapshot was created',
  );
  expect(coverage).not.toBeVisible();
  const historical = screen.getByText('Historical extraction details').closest('details')!;
  await userEvent.setup().click(within(historical).getByText('Historical extraction details'));
  expect(coverage).toBeVisible();
  expect(
    within(historical).getByRole('link', { name: 'Open current Import review' }),
  ).toHaveAttribute('href', '/import');
  expect(screen.getAllByText(/current Import review/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/clinical_coverage_unknown/)).toBeNull();
  expect(screen.queryByText(/No retained records are linked/)).toBeNull();
  expect(
    requests.some(
      (url) =>
        url.includes('/source-records?') &&
        url.includes('originalSourceFileId=root-original') &&
        !url.includes('sourceFileId=root-original'),
    ),
  ).toBe(true);
});

it('requests the compact file-reference view for a selected retained record', async () => {
  selectProfile({ id: 'fictional-sources', name: 'Cookie Dough', placebo: true });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [], meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources?view=records&record=fictional-selected-record'],
  });
  render(<RouterProvider router={router} />);

  await waitFor(() =>
    expect(
      requests.some((url) =>
        url.includes('/source-records/fictional-selected-record?fileView=reference'),
      ),
    ).toBe(true),
  );
});

it('keeps a present source-record date scoped in the records list and detail', async () => {
  selectProfile({ id: 'fictional-dated-sources', name: 'Cookie Dough', placebo: true });
  const datedRecord = {
    id: 'fictional-dated-record',
    sourceFileId: 'fictional-source-file',
    providerId: 'fictional-provider',
    provider: 'Fictional Source',
    sourceKey: 'line:3',
    kind: 'intake_record',
    label: 'Fictional dated source record',
    date: '2026-09-03',
    raw: {},
    locator: {},
    extractionStatus: 'projected_reviewed',
    fileView: 'reference',
  };
  const undatedRecord = {
    ...datedRecord,
    id: 'fictional-undated-record',
    label: 'Fictional undated source record',
    date: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      const data = url.includes('/source-records/fictional-dated-record?fileView=reference')
        ? datedRecord
        : [datedRecord, undatedRecord];
      return new Response(JSON.stringify({ data, meta: { revision: 1, total: 2 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources?view=records&record=fictional-dated-record'],
  });
  render(<RouterProvider router={router} />);

  expect((await screen.findAllByText('Source record date: Sep 3, 2026')).length).toBeGreaterThan(0);
  expect(screen.getByText('No source-record date summary')).toBeVisible();
  expect(screen.queryByText('Date not recorded')).toBeNull();
  await userEvent.setup().click(screen.getByText('Files, evidence and health records'));
  expect(screen.getByText(/source record date is an optional summary/i)).toBeVisible();
});

it('keeps source review inside the selected original without a second inventory banner', async () => {
  selectProfile({ id: 'fictional-empty-import', name: 'Cookie Doe', placebo: true });
  const requests: string[] = [];
  const file = {
    id: 'empty-source',
    path: 'cookie-empty.pdf',
    filename: 'cookie-empty.pdf',
    kind: 'original',
    coverageStatus: 'unknown',
    mimeType: 'text/plain',
    proposals: [],
    bytes: 100,
    details: {},
    sha256: 'fictional',
    contentUrl: '/api/sources/empty-source/content',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      const data = url.includes('/source-issues?')
        ? { status: 'unavailable', issues: [], summary: { specificIssues: 0 }, nextOffset: null }
        : url.endsWith('/sources/empty-source') || url.endsWith('/intakes/empty-source')
          ? file
          : url.includes('/sources?')
            ? [file]
            : [];
      return new Response(JSON.stringify({ data, meta: { revision: 1, complete: true } }));
    }),
  );
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources'],
  });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'cookie-empty.pdf' }));
  expect(screen.getByRole('button', { name: 'Review source text' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Originals and source review' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Source areas to review' })).toBeNull();
  expect(requests.some((url) => url.includes('/intakes?'))).toBe(false);
  await user.click(screen.getByRole('tab', { name: 'Documents' }));
  expect(screen.queryByRole('button', { name: 'Review source text' })).toBeNull();
});

it('source document detail keeps one person-change action', async () => {
  selectProfile({ id: 'fictional-source-actions', name: 'Fictional profile', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (input) =>
        new Response(
          JSON.stringify({
            data: String(input).endsWith('/documents/fictional-document')
              ? {
                  id: 'fictional-document',
                  personId: 'patient',
                  title: 'Fictional document',
                  date: null,
                  sourceRecordId: 'fictional-source',
                  text: 'Fictional retained words',
                  extra: {},
                }
              : [],
            meta: { revision: 1 },
          }),
        ),
    ),
  );
  const router = createMemoryRouter([{ path: '/sources', element: <Sources /> }], {
    initialEntries: ['/sources?document=fictional-document'],
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'Fictional document' });
  await userEvent.setup().click(screen.getByRole('button', { name: 'More entry actions' }));
  expect(screen.getAllByRole('button', { name: 'Change person' })).toHaveLength(1);
});
