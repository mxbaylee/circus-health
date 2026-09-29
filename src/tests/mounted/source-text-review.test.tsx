import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import {
  ImportReviewPresentation,
  type ImportReviewModel,
} from '../../app/features/import/ImportReviewPresentation';
import { SourceAttentionReview } from '../../app/features/import/SourceAttentionReview';
import { SourceTextReview } from '../../app/features/intake/SourceTextReview';
import { SourceReaderObservations } from '../../app/features/import/SourceReaderObservations';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  IntakeSourceText,
  SourceTextReviewRequest,
  SourceTextRevision,
  SourceReaderCoverage,
} from '../../shared/intake-source-text';

it('explicitly falls back to original context when a requested page is unavailable', async () => {
  setup();
  render(<SourceTextReview intakeId="fictional-source" embedded initialPage={999} />);
  expect(await screen.findByText(/Referenced page 999 is unavailable/)).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Page 1 transcription' })).toBeVisible();
});

it('keeps reader observations distinct and historical, with version-pinned pagination', async () => {
  const { fetcher } = setup();
  const paths: string[] = [];
  const initial: SourceReaderCoverage = {
    intakeVersion: 7,
    summary: { units: 24, pending: 1, partial: 0, unreadable: 0, context: 23, stale: 1 },
    entries: [
      {
        planId: 'cookie-plan',
        unitId: 'cookie-unit',
        status: 'completed',
        kind: 'pages',
        locator: 'Page 2',
        pages: [2],
        coverageKind: 'context',
        notes: 'Cookie Doe administration, no clinical draft proposed.',
        stale: true,
      },
    ],
    offset: 0,
    nextOffset: 20,
  };
  fetcher.mockImplementation(async (input) => {
    paths.push(String(input));
    return Response.json({
      data: {
        readerCoverage: String(input).includes('readerOffset=20')
          ? {
              ...initial,
              offset: 20,
              nextOffset: null,
              entries: [
                {
                  ...initial.entries[0],
                  unitId: 'cookie-last',
                  notes: 'Cookie Doe last retained note.',
                  stale: false,
                },
              ],
            }
          : initial,
      },
    });
  });
  const review = vi.fn();
  const { rerender } = render(
    <SourceReaderObservations
      intakeId="fictional-source"
      initial={initial}
      blocked={false}
      onReview={review}
      renderReview={() => null}
      onPageChange={() => {}}
    />,
  );
  expect(paths).toEqual([]);
  const details = screen.getByText(/Reader observations ·/).closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(await screen.findByText('Earlier source text — read again')).toBeVisible();
  expect(screen.getByText(/not verified transcription or human inspection/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /Reader marked contextual material/ }));
  expect(review).toHaveBeenCalledWith(initial.entries[0]);
  await userEvent.click(screen.getByRole('button', { name: 'More reader observations' }));
  expect(await screen.findByText('Cookie Doe last retained note.')).toBeVisible();
  expect(
    paths.some((path) => path.includes('readerOffset=20&readerLimit=20&readerVersion=7')),
  ).toBe(true);
  rerender(
    <SourceReaderObservations
      intakeId="fictional-source"
      initial={initial}
      blocked
      onReview={review}
      renderReview={() => null}
      onPageChange={() => {}}
    />,
  );
  expect(screen.getByRole('button', { name: 'Previous reader observations' })).toBeDisabled();
  details.open = false;
  fireEvent(details, new Event('toggle'));
  expect(details.open).toBe(true);
});

it('refreshes opened reader notes after correction without unmounting a dirty editor', async () => {
  const { fetcher } = setup();
  const initial: SourceReaderCoverage = {
    intakeVersion: 7,
    summary: { units: 1, pending: 0, partial: 0, unreadable: 0, context: 1 },
    entries: [
      {
        planId: 'cookie-plan',
        unitId: 'cookie-unit',
        status: 'completed',
        kind: 'pages',
        locator: 'Page 2',
        pages: [2],
        coverageKind: 'context',
        notes: 'Cookie Doe retained note.',
      },
    ],
    offset: 0,
    nextOffset: null,
  };
  let current = initial;
  fetcher.mockImplementation(async () => Response.json({ data: { readerCoverage: current } }));
  const renderNotes = (data: SourceReaderCoverage, blocked: boolean) => (
    <SourceReaderObservations
      intakeId="fictional-source"
      initial={data}
      blocked={blocked}
      onReview={() => {}}
      onPageChange={() => {}}
      renderReview={() => (
        <textarea aria-label="Cookie source draft" defaultValue="Unsaved Cookie Doe correction" />
      )}
    />
  );
  const { rerender } = render(renderNotes(initial, false));
  const details = screen.getByText(/Reader observations ·/).closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  const editor = screen.getByRole('textbox', { name: 'Cookie source draft' });
  fireEvent.change(editor, { target: { value: 'Cookie Doe dirty original remains' } });
  current = {
    ...initial,
    intakeVersion: 8,
    summary: { ...initial.summary, stale: 1 },
    entries: [{ ...initial.entries[0], stale: true }],
  };
  rerender(renderNotes(current, true));
  expect(screen.getByText(/These displayed observations are from an earlier/)).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Cookie source draft' })).toBe(editor);
  expect(editor).toHaveValue('Cookie Doe dirty original remains');
  rerender(renderNotes(current, false));
  expect(await screen.findByText('Earlier source text — read again')).toBeVisible();
  await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
  expect(screen.queryByText(/These displayed observations are from an earlier/)).toBeNull();
});

const revision: SourceTextRevision = {
  protectedPages: [],
  format: 'intake-source-text-v1',
  id: 'rev-one',
  parentRevisionId: null,
  profileId: 'fictional',
  intakeId: 'fictional-source',
  sourceHash: 'a'.repeat(64),
  createdAt: '2026-09-26T00:00:00Z',
  review: null,
  adapter: { name: 'fictional', version: '1' },
  pages: [
    { page: 1, width: 600, height: 900, disposition: 'partial', inspected: false },
    { page: 2, disposition: 'extracted', inspected: false },
  ],
  spans: [
    {
      id: 'span-one',
      text: 'Fictional administrative passage',
      region: { page: 1, box: [0.1, 0.1, 0.3, 0.2] },
      provenance: 'native',
    },
    { id: 'span-two', text: 'A fictional continuation', region: { page: 2 }, provenance: 'native' },
  ],
  relations: [],
  issues: [
    {
      id: 'issue-one',
      region: { page: 1, box: [0.6, 0.7, 0.1, 0.1] },
      kind: 'coverage',
      detail: 'Check the faint margin',
      status: 'open',
    },
  ],
};
const available = (value = revision): IntakeSourceText => ({
  status: 'available',
  revision: value,
  summary: {
    pages: 2,
    spans: value.spans.length,
    unresolved: 1,
    exceptions: 0,
    inspectedPages: 0,
    status: 'needs-review',
  },
});
function setup(
  handler?: (request: SourceTextReviewRequest, index: number) => Response | Promise<Response>,
  unavailable = false,
) {
  const profile = { id: 'fictional', name: 'Fictional reviewer', placebo: true, locked: false };
  replaceProfiles([profile]);
  selectProfile(profile);
  const writes: SourceTextReviewRequest[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    if (options?.method === 'POST') {
      const body = JSON.parse(String(options.body)) as SourceTextReviewRequest;
      writes.push(body);
      if (handler) return handler(body, writes.length);
      return Response.json({
        data: available({
          ...revision,
          id: 'rev-two',
          spans: body.spans || revision.spans,
          review: {
            operationId: body.operationId,
            expectedRevisionId: body.expectedRevisionId,
            action: body.action,
            scope: body.scope,
            actor: 'fictional-reviewer',
            at: '2026-09-26T01:00:00Z',
            clarification: body.clarification,
          },
        }),
      });
    }
    if (path.includes('/source-issues'))
      return Response.json({
        data: {
          status: 'available',
          revisionId: revision.id,
          sourceHash: revision.sourceHash,
          adapter: revision.adapter,
          summary: {
            pages: 2,
            specificIssues: 1,
            coverageIssues: 0,
            exceptions: 0,
            inspectedPages: 0,
            totalIssues: 1,
          },
          issues: revision.issues.map((issue) => ({
            ...issue,
            category: 'detected',
            precision: 'region',
          })),
          offset: 0,
          nextOffset: null,
        },
      });
    if (path.includes('/source-preview'))
      return Response.json({
        data: { dataUrl: 'data:image/png;base64,AA==', width: 600, height: 900 },
      });
    return Response.json({
      data: unavailable ? { status: 'unavailable', revision: null, summary: null } : available(),
    });
  });
  vi.stubGlobal('fetch', fetcher);
  return { writes, fetcher };
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'Review source text' }));
  await screen.findByRole('textbox', { name: 'Passage 1 · native' });
}

it('makes full unflagged page context editable without accepting clinical records', async () => {
  const { writes } = setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Corrected administrative wording' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Add missing text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 2 · human' }), {
    target: { value: 'Previously omitted footer' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByText(/Correction saved/);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    expectedRevisionId: 'rev-one',
    sourceHash: revision.sourceHash,
    scope: { page: 1 },
    action: 'correct',
  });
  expect(writes[0].scope.box).toBeUndefined();
  expect(writes[0].spans?.map((span) => span.text)).toEqual([
    'Corrected administrative wording',
    'Previously omitted footer',
  ]);
  expect(screen.queryByRole('button', { name: /Accept clinical/ })).toBeNull();
});

it('retries unknown saves with the same operation and locks editing until resolved', async () => {
  const { writes } = setup(async (body, index) => {
    if (index === 1) throw new Error('Connection dropped');
    return Response.json({ data: available({ ...revision, id: 'saved-two', spans: body.spans! }) });
  });
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Retained correction' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByRole('button', { name: 'Retry identical source save' });
  expect(screen.getByRole('textbox', { name: 'Passage 1 · human' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Retry identical source save' }));
  await screen.findByText(/Correction saved/);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it('preserves conflicting drafts for comparison and never blindly retries stale writes', async () => {
  const { writes } = setup(() =>
    Response.json(
      { error: { code: 'SOURCE_TEXT_CONFLICT', message: 'Changed revision' } },
      { status: 409 },
    ),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'My draft' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByText(/This source revision changed/);
  expect(screen.getByDisplayValue('My draft')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry identical source save' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Load latest saved revision' }));
  await screen.findByRole('heading', { name: 'Latest saved page 1' });
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Keep latest saved version' }));
  expect(screen.getByDisplayValue('Fictional administrative passage')).toBeInTheDocument();
});

it('saves external clarification separately without replacing unreadable source text', async () => {
  const { writes } = setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Clarification from memory or another source' }),
    { target: { value: 'I remember an additional appointment' } },
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save separate clarification' }));
  await screen.findByText('Clarification saved separately from extracted text.');
  expect(writes[0]).toMatchObject({
    action: 'clarification',
    clarification: 'I remember an additional appointment',
  });
  expect(writes[0].spans).toBeUndefined();
});

it('distinguishes deferred and unreadable scope and requires reasons', async () => {
  const { writes } = setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  await userEvent.click(screen.getByRole('button', { name: 'Keep unreadable exception' }));
  expect(await screen.findByText('Give a reason for this source disposition.')).toBeVisible();
  expect(writes).toHaveLength(0);
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Disposition applies to' }),
    'issue-one',
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason or source context' }), {
    target: { value: 'Source is too faint' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Review later' }));
  await screen.findByText('Saved for later. This scope remains unfinished.');
  expect(writes[0]).toMatchObject({
    action: 'later',
    scope: revision.issues[0].region,
    reason: 'Source is too faint',
  });
});

it('preserves page navigation drafts and swaps non-square rotated bounds without changing source coordinates', async () => {
  setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  const image = await screen.findByRole('img', { name: 'Original page 1' });
  await userEvent.click(screen.getByRole('button', { name: 'Rotate source clockwise' }));
  expect(image.parentElement).toHaveStyle({ transform: 'translate(-50%, -50%) rotate(90deg)' });
  expect(image.parentElement?.parentElement).toHaveStyle({ width: '900px', height: '600px' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Unsaved' },
  });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Page or section' }), '2');
  expect(
    await screen.findByText('Save or discard your current draft before changing pages.'),
  ).toBeVisible();
  expect(screen.getByDisplayValue('Unsaved')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Discard unsaved source draft' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Page or section' }), '2');
  expect(await screen.findByDisplayValue('A fictional continuation')).toBeVisible();
});

it('keeps absent extraction explicitly unavailable and requires an intentional local extraction', async () => {
  const { fetcher, writes } = setup(undefined, true);
  render(
    <StrictMode>
      <SourceTextReview intakeId="fictional-source" />
    </StrictMode>,
  );
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Review source text' }));
  expect(await screen.findByText(/Text has not been extracted yet/)).toBeVisible();
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Extract source text locally' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(
    fetcher.mock.calls.some(
      ([path, options]) => String(path).endsWith('/source-extract') && options?.method === 'POST',
    ),
  ).toBe(true);
});

it('edits cross-page relationships with stable passage references', async () => {
  const { writes } = setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  await userEvent.click(screen.getByText('Reading order and table relationships'));
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'First passage' }),
    'span-one',
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Second passage' }),
    'span-two',
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /^Relationship$/ }),
    'header-for',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add relationship' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByText(/Correction saved/);
  expect(writes[0].relations).toEqual([
    expect.objectContaining({
      from: 'span-one',
      to: 'span-two',
      kind: 'header-for',
      provenance: 'human',
    }),
  ]);
});

it('blocks same-route query navigation until an unsaved source edit is resolved', async () => {
  setup();
  const { createMemoryRouter, RouterProvider, Link } = await import('react-router-dom');
  const router = createMemoryRouter(
    [
      {
        path: '/import',
        element: (
          <>
            <Link to="/import?group=another">Another report</Link>
            <SourceTextReview intakeId="fictional-source" />
          </>
        ),
      },
    ],
    { initialEntries: ['/import?group=first'] },
  );
  render(<RouterProvider router={router} />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Unsaved source wording' },
  });
  await userEvent.click(screen.getByRole('link', { name: 'Another report' }));
  await screen.findByText('Your review draft could not save. Stay here to retry before leaving.');
  expect(router.state.location.search).toBe('?group=first');
  expect(screen.getByDisplayValue('Unsaved source wording')).toBeVisible();
});

it('never displays a preceding profile draft after the profile changes', async () => {
  setup();
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Old profile draft' },
  });
  const { act } = await import('@testing-library/react');
  act(() =>
    selectProfile({
      id: 'fictional-two',
      name: 'Another fictional reviewer',
      placebo: true,
      locked: false,
    }),
  );
  await waitFor(() => expect(screen.queryByDisplayValue('Old profile draft')).toBeNull());
});

it('shows an original with no clinical proposals directly in source review', async () => {
  setup();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('rootOnly=')
      ? Response.json({
          data: [
            {
              id: 'fictional-source',
              filename: 'Fictional original.pdf',
              mimeType: 'application/pdf',
            },
          ],
          meta: { complete: true },
        })
      : String(input).includes('/source-issues')
        ? Response.json({
            data: {
              status: 'unavailable',
              revisionId: null,
              sourceHash: revision.sourceHash,
              summary: null,
              issues: [],
              offset: 0,
              nextOffset: null,
            },
          })
        : Response.json({ data: available() }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<ImportSourceTextBrowser onChanged={() => {}} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Fictional original.pdf' }));
  await open();
  expect(screen.getByRole('heading', { name: 'Page 1 transcription' })).toBeVisible();
  expect(
    fetcher.mock.calls.some(
      ([path]) =>
        String(path) === '/api/profiles/fictional/intakes?rootOnly=true&limit=30&offset=0',
    ),
  ).toBe(true);
});

it('continues pending local extraction with the current revision and preserves reviewed page text', async () => {
  setup();
  const pendingRevision = {
    ...revision,
    protectedPages: [1],
    issues: [
      ...revision.issues,
      {
        id: 'p2-pending',
        region: { page: 2 },
        kind: 'coverage' as const,
        detail: 'Page waiting for extraction',
        status: 'open' as const,
      },
    ],
  };
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'POST') {
        calls.push(JSON.parse(String(options.body)));
        return Response.json({
          data: available({ ...pendingRevision, id: 'progress-two', issues: revision.issues }),
        });
      }
      if (String(input).includes('source-preview'))
        return Response.json({
          data: { dataUrl: 'data:image/png;base64,AA==', width: 600, height: 900 },
        });
      return Response.json({ data: available(pendingRevision) });
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  await userEvent.click(screen.getByRole('button', { name: 'Extract next pages locally' }));
  await screen.findByText(
    'Local extraction progress saved. Remaining pages and exceptions stay visible.',
  );
  expect(calls).toEqual([expect.objectContaining({ expectedRevisionId: 'rev-one' })]);
  expect(calls[0].page).toBeUndefined();
  expect(screen.getByDisplayValue('Fictional administrative passage')).toBeVisible();
});

it('recovers an initial extraction published before its response was lost without repeating extraction', async () => {
  setup();
  let published = false;
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'POST') {
        posts++;
        published = true;
        throw new Error('Response lost after publication');
      }
      if (String(input).includes('source-preview'))
        return Response.json({ data: { text: 'Fictional original source' } });
      return Response.json({
        data: published ? available() : { status: 'unavailable', revision: null, summary: null },
      });
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review source text' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Extract source text locally' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Check saved extraction' }));
  expect(await screen.findByDisplayValue('Fictional administrative passage')).toBeVisible();
  expect(posts).toBe(1);
  expect(await screen.findByLabelText('Literal original section 1')).toHaveTextContent(
    'Fictional original source',
  );
});

it('lets a rejected invalid draft be repaired without treating it as an unknown save', async () => {
  setup(() =>
    Response.json(
      { error: { code: 'SOURCE_TEXT_INVALID', message: 'Invalid literal span' } },
      { status: 400 },
    ),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: '' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByText('Invalid literal span');
  expect(screen.getByRole('textbox', { name: 'Passage 1 · human' })).not.toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Retry identical source save' })).toBeNull();
});

it('searches a pinned retained revision and opens the matching original page without a model call', async () => {
  const { fetcher } = setup();
  const base = fetcher.getMockImplementation()!;
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input);
      requests.push(path);
      if (path.includes('/source-search'))
        return Response.json({
          data: {
            revisionId: 'rev-one',
            sourceHash: revision.sourceHash,
            matches: [
              {
                spanId: 'span-two',
                page: 2,
                character: 12,
                text: 'A fictional continuation',
                provenance: 'native',
              },
            ],
            nextOffset: null,
            nextCharacter: 0,
            caseSensitive: true,
          },
        });
      return base(input, options);
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  await userEvent.type(
    screen.getByRole('searchbox', { name: 'Find retained text' }),
    'continuation',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Find in source text' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Page 2 · native: A fictional continuation' }),
  );
  expect(await screen.findByDisplayValue('A fictional continuation')).toBeVisible();
  expect(
    requests.some((path) =>
      path.includes('source-search?query=continuation&revisionId=rev-one&offset=0&character=0'),
    ),
  ).toBe(true);
  expect(requests.every((path) => !path.includes('/assistant'))).toBe(true);
});

it('requires explicit selection after saved transcription to resolve an unreadable question', async () => {
  setup();
  const unreadable: SourceTextRevision = {
    ...revision,
    spans: [{ ...revision.spans[0], provenance: 'human', region: { page: 1 } }],
    issues: [
      {
        id: 'faint',
        kind: 'unreadable',
        status: 'unreadable',
        region: { page: 1 },
        detail: 'Faint fictional text',
      },
      {
        id: 'unsupported',
        kind: 'unsupported',
        status: 'open',
        region: { page: 1 },
        detail: 'Unsupported attachment',
      },
    ],
  };
  const writes: SourceTextReviewRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'POST') {
        writes.push(JSON.parse(String(options.body)));
        return Response.json({ data: available(unreadable) });
      }
      if (String(input).includes('source-preview'))
        return Response.json({ data: { text: 'Fictional original' } });
      return Response.json({ data: available(unreadable) });
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await userEvent.click(screen.getByRole('button', { name: 'Review source text' }));
  const checkbox = await screen.findByRole('checkbox', {
    name: 'Resolve with my saved transcription: Faint fictional text',
  });
  expect(checkbox).not.toBeChecked();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'I inspected this whole page' }));
  await screen.findByText('Source review saved. Accepted clinical record versions are unchanged.');
  expect(writes[0].resolveIssueIds).toBeUndefined();
  await userEvent.click(checkbox);
  await userEvent.click(screen.getByRole('button', { name: 'I inspected this whole page' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].resolveIssueIds).toEqual(['faint']);
  expect(writes[1].action).toBe('confirm');
});

it('preserves an interrupted partial extraction and requires a new explicit continuation operation', async () => {
  setup();
  const partial: SourceTextRevision = {
    ...revision,
    issues: [
      ...revision.issues,
      {
        id: 'p2-pending',
        kind: 'coverage',
        status: 'open',
        region: { page: 2 },
        detail: 'Waiting for local extraction',
      },
    ],
  };
  const writes: { operationId: string; expectedRevisionId: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        writes.push(body);
        return Response.json({
          data: {
            ...available({ ...partial, id: 'partial-two' }),
            extractionOperation: {
              operationId: body.operationId,
              status: 'interrupted',
              revisionId: 'partial-two',
              requiresNewOperation: true,
              reasonCode: 'process_interrupted',
            },
          },
        });
      }
      if (String(input).includes('source-preview'))
        return Response.json({ data: { text: 'Fictional original' } });
      return Response.json({ data: available(partial) });
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  await userEvent.click(screen.getByRole('button', { name: 'Extract next pages locally' }));
  await screen.findByText(
    'That extraction step was interrupted. Saved pages are kept; continuing starts a new bounded step.',
  );
  expect(writes).toHaveLength(1);
  expect(screen.getByDisplayValue('Fictional administrative passage')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Extract next pages locally' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].operationId).not.toBe(writes[0].operationId);
  expect(writes[1].expectedRevisionId).toBe('partial-two');
});

it('refreshes a clean source view after background extraction and updates the pinned preview', async () => {
  const { fetcher } = setup();
  const original = fetcher.getMockImplementation()!;
  let latest = revision;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).endsWith('/source-text') && !options?.method)
        return Response.json({ data: available(latest) });
      return original(input, options);
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  latest = {
    ...revision,
    id: 'background-two',
    spans: [{ ...revision.spans[0], text: 'Newly extracted text' }],
  };
  await userEvent.click(screen.getByRole('button', { name: 'Load latest saved revision' }));
  expect(await screen.findByDisplayValue('Newly extracted text')).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Latest saved page 1' })).toBeNull();
  await waitFor(() =>
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes('revisionId=background-two')),
    ).toBe(true),
  );
});

it('compares a refreshed revision without dropping an unsaved source correction', async () => {
  const { fetcher, writes } = setup();
  const original = fetcher.getMockImplementation()!;
  let latest = revision;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).endsWith('/source-text') && !options?.method)
        return Response.json({ data: available(latest) });
      return original(input, options);
    }),
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'My unsaved wording' },
  });
  latest = {
    ...revision,
    id: 'background-two',
    spans: [{ ...revision.spans[0], text: 'Newly extracted wording' }],
  };
  await userEvent.click(screen.getByRole('button', { name: 'Load latest saved revision' }));
  expect(await screen.findByRole('heading', { name: 'Latest saved page 1' })).toBeVisible();
  expect(screen.getByDisplayValue('My unsaved wording')).toBeVisible();
  expect(screen.getByText('Newly extracted wording')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save transcription correction' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Keep latest saved version' }));
  expect(screen.getByDisplayValue('Newly extracted wording')).toBeVisible();
});

async function selectRetainedSource() {
  await userEvent.click(
    await screen.findByRole('button', { name: 'Fictional retained source.pdf' }),
  );
}
function sourceBrowserFetch(parentId: string | null = null, mimeType = 'application/pdf') {
  const { fetcher } = setup();
  const original = fetcher.getMockImplementation()!;
  const source = {
    id: 'fictional-source',
    filename: 'Fictional retained source.pdf',
    mimeType,
    parentSourceFileId: parentId,
  };
  const wrapped = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('rootOnly='))
        return Response.json({ data: [source], meta: { complete: true } });
      if (url.endsWith('/intakes/fictional-source')) return Response.json({ data: source });
      if (url.endsWith('/intakes/fictional-package'))
        return Response.json({
          data: {
            id: 'fictional-package',
            filename: 'Fictional package.zip',
            mimeType: 'application/zip',
            parentSourceFileId: null,
          },
        });
      return original(input, options);
    },
  );
  vi.stubGlobal('fetch', wrapped);
  return wrapped;
}

it('explains retain-only inputs and never queues them for clinical reading', async () => {
  sourceBrowserFetch(null, 'audio/mpeg');
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  expect(screen.getByRole('button', { name: 'Read source for clinical review' })).toBeDisabled();
  expect(screen.getByText(/This format is kept as an original only/)).toBeVisible();
  expect(onRead).not.toHaveBeenCalled();
});

it('starts an explicit clinical reading for a retained upload with no proposal or extraction', async () => {
  const fetcher = sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  expect(onRead).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  await screen.findByText(/Clinical reading queued for Fictional retained source.pdf/);
  expect(onRead).toHaveBeenCalledExactlyOnceWith('fictional-source');
  expect(
    fetcher.mock.calls.every(
      ([url, options]) => !String(url).includes('/source-text') && !options?.method,
    ),
  ).toBe(true);
});

it('keeps the clinical handoff disabled for an unsaved correction and queues the package root after saving', async () => {
  sourceBrowserFetch('fictional-package');
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Corrected source wording' },
  });
  expect(screen.getByRole('button', { name: 'Read source for clinical review' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Save transcription correction' }));
  await screen.findByText(/Correction saved/);
  expect(onRead).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  await screen.findByText(/Clinical reading queued for Fictional package.zip/);
  expect(onRead).toHaveBeenCalledExactlyOnceWith('fictional-package');
});

it('blocks concurrent reading and exposes a failed handoff without losing retained text', async () => {
  sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  let reject!: (error: Error) => void;
  const onRead = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Starting clinical reading…' })).toBeDisabled();
  const { act } = await import('@testing-library/react');
  await act(async () => reject(new Error('Provider unavailable; saved source retained')));
  expect(await screen.findByText('Provider unavailable; saved source retained')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Fictional retained source.pdf' })).toBeVisible();
});

it('blocks fresh clinical reading while an earlier request needs confirmation', async () => {
  sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(
    <ImportSourceTextBrowser
      onChanged={() => {}}
      onRead={onRead}
      readingBlocked="Retry the earlier reading request first."
    />,
  );
  await selectRetainedSource();
  expect(screen.getByRole('button', { name: 'Read source for clinical review' })).toBeDisabled();
  expect(screen.getByText('Retry the earlier reading request first.')).toBeVisible();
  expect(onRead).not.toHaveBeenCalled();
});

it('refuses malformed package ancestry rather than queuing a child or a duplicate job', async () => {
  const fetcher = sourceBrowserFetch('fictional-source');
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  expect(await screen.findByText(/source package ancestry could not be resolved/)).toBeVisible();
  expect(onRead).not.toHaveBeenCalled();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith('/intakes/fictional-source')),
  ).toHaveLength(1);
});

it('retains an unknown clinical handoff request and retries its exact batch operation', async () => {
  const sourceFetch = sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const { useIntakeBatch } = await import('../../app/features/intake/useIntakeBatch');
  const writes: { operationId: string; intakeIds: string[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).endsWith('/intake-batches')) {
        if (options?.method === 'POST') {
          const body = JSON.parse(String(options.body));
          writes.push(body);
          if (writes.length === 1) throw new Error('Reading response lost');
          return Response.json({
            data: {
              id: 'fictional-batch',
              operationId: body.operationId,
              status: 'completed',
              items: [],
            },
          });
        }
        return Response.json({ data: [] });
      }
      return sourceFetch(input, options);
    }),
  );
  function Harness() {
    const batch = useIntakeBatch('fictional');
    return (
      <>
        {batch.pendingCreate && (
          <button onClick={() => void batch.retryCreate().catch(() => {})}>Retry reading</button>
        )}
        <ImportSourceTextBrowser
          onChanged={() => {}}
          readingBlocked={
            batch.pendingCreate
              ? 'Confirm the earlier reading request first.'
              : batch.busy || batch.loading
                ? 'Reading request busy.'
                : undefined
          }
          onRead={async (id) => {
            if (!(await batch.create([id]))) throw new Error('Reading did not start.');
          }}
        />
      </>
    );
  }
  render(<Harness />);
  await selectRetainedSource();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  expect(await screen.findByText('Reading response lost')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Read source for clinical review' })).toBeDisabled();
  expect(localStorage.getItem('circus:intake-batch-create:fictional')).toContain(
    'fictional-source',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Retry reading' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry reading' })).toBeNull());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].intakeIds).toEqual(['fictional-source']);
  expect(localStorage.getItem('circus:intake-batch-create:fictional')).toBeNull();
});

it('does not dispatch clinical reading after switching profiles during source lookup', async () => {
  const sourceFetch = sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  let finish!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    if (String(input).endsWith('/intakes/fictional-source')) return delayed;
    return sourceFetch(input, options);
  });
  vi.stubGlobal('fetch', fetcher);
  const onRead = vi.fn(async () => {});
  render(<ImportSourceTextBrowser onChanged={() => {}} onRead={onRead} />);
  await selectRetainedSource();
  await userEvent.click(screen.getByRole('button', { name: 'Read source for clinical review' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith('/intakes/fictional-source')),
    ).toBe(true),
  );
  const { act } = await import('@testing-library/react');
  await act(async () => {
    selectProfile({
      id: 'fictional-two',
      name: 'Another fictional reviewer',
      placebo: true,
      locked: false,
    });
    finish(
      Response.json({
        data: {
          id: 'fictional-source',
          filename: 'Old profile source.pdf',
          parentSourceFileId: null,
        },
      }),
    );
  });
  expect(onRead).not.toHaveBeenCalled();
  expect(screen.queryByText(/Clinical reading queued/)).toBeNull();
});

it('fits the original to its measured column after resize and rotation without moving source highlights', async () => {
  setup();
  let resize!: (width: number) => void;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resize = (width: number) =>
          this.callback(
            [{ target, contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        resize(300);
      }
      disconnect() {}
      unobserve() {}
    },
  );
  render(<SourceTextReview intakeId="fictional-source" />);
  await open();
  const image = await screen.findByRole('img', { name: 'Original page 1' });
  expect(screen.getByRole('combobox', { name: 'Source zoom' })).toHaveValue('fit');
  await waitFor(() =>
    expect(image.parentElement?.parentElement).toHaveStyle({ width: '300px', height: '450px' }),
  );
  const highlight = screen.getByTitle('Check the faint margin');
  expect(highlight).toHaveStyle({ left: '60%', top: '70%' });
  await userEvent.click(screen.getByRole('button', { name: 'Rotate source clockwise' }));
  expect(image.parentElement?.parentElement).toHaveStyle({ width: '300px', height: '200px' });
  const { act } = await import('@testing-library/react');
  act(() => resize(450));
  expect(image.parentElement?.parentElement).toHaveStyle({ width: '450px', height: '300px' });
  expect(highlight).toHaveStyle({ left: '60%', top: '70%' });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Source zoom' }), '1');
  expect(image.parentElement?.parentElement).toHaveStyle({ width: '900px', height: '600px' });
});

it('opens an embedded issue on its exact page without a second source-browser control', async () => {
  const { fetcher, writes } = setup();
  const pageTwoRevision: SourceTextRevision = {
    ...revision,
    issues: [
      {
        id: 'cookie-page-two',
        kind: 'unreadable',
        status: 'open',
        detail: 'Cookie Doe handwritten unit cannot be read',
        region: { page: 2, box: [0.2, 0.3, 0.2, 0.1] },
      },
    ],
  };
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input, options) =>
    String(input).endsWith('/source-text') && !options?.method
      ? Response.json({ data: available(pageTwoRevision) })
      : original(input, options),
  );
  render(
    <SourceTextReview
      intakeId="fictional-source"
      embedded
      initialPage={2}
      initialIssueId="cookie-page-two"
    />,
  );
  expect(screen.queryByRole('button', { name: 'Review source text' })).toBeNull();
  expect(await screen.findByRole('heading', { name: 'Page 2 transcription' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Disposition applies to' })).toHaveValue(
    'cookie-page-two',
  );
  expect(screen.getByRole('textbox', { name: 'Passage 1 · native' })).toHaveValue(
    'A fictional continuation',
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason or source context' }), {
    target: { value: 'Cookie Doe will check the handwritten unit later.' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Review later' }));
  expect(writes).toHaveLength(1);
  expect(writes[0].scope).toEqual({ page: 2, box: [0.2, 0.3, 0.2, 0.1] });
  expect(writes[0].action).toBe('later');
});

it('does not silently widen a stale issue selection to the whole page', async () => {
  setup();
  render(
    <SourceTextReview
      intakeId="fictional-source"
      embedded
      initialPage={2}
      initialIssueId="cookie-removed-issue"
    />,
  );
  expect(
    await screen.findByText(/selected issue changed in the saved source revision/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Review later' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Review current page instead' }));
  expect(await screen.findByRole('heading', { name: 'Page 2 transcription' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Disposition applies to' })).toHaveValue('');
});

it('keeps an 800-page original visible with bounded issue pagination and no transcript download until review', async () => {
  const { fetcher } = setup();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const paths: string[] = [];
  fetcher.mockImplementation(async (input) => {
    const url = String(input);
    paths.push(url);
    if (url.includes('rootOnly='))
      return Response.json({
        data: [
          {
            id: 'fictional-source',
            filename: 'Cookie Doe 800 pages.pdf',
            mimeType: 'application/pdf',
          },
        ],
        meta: { complete: true },
      });
    if (url.includes('/source-issues?')) {
      const offset = Number(new URL(url, 'https://fictional.test').searchParams.get('offset'));
      return Response.json({
        data: {
          status: 'available',
          revisionId: 'cookie-revision',
          sourceHash: revision.sourceHash,
          adapter: revision.adapter,
          summary: {
            pages: 800,
            specificIssues: 799,
            coverageIssues: 1,
            exceptions: 1,
            inspectedPages: 0,
            totalIssues: 800,
          },
          issues: Array.from({ length: 50 }, (_, i) => ({
            id: `cookie-issue-${offset + i}`,
            kind: offset + i === 0 ? 'coverage' : 'unreadable',
            detail: `Cookie Doe area ${offset + i + 1}`,
            status: offset + i === 1 ? 'later' : 'open',
            region: { page: offset + i + 1 },
            category: offset + i === 0 ? 'not-inspected' : 'detected',
            precision: 'page',
          })),
          offset,
          nextOffset: offset + 50 < 800 ? offset + 50 : null,
        },
      });
    }
    throw new Error(`Unexpected source transcript download: ${url}`);
  });
  render(<ImportSourceTextBrowser onChanged={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'Cookie Doe 800 pages.pdf' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Browse imported source text' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Cookie Doe 800 pages.pdf' }));
  expect(await screen.findByText('Cookie Doe area 50')).toBeVisible();
  expect(screen.getByText('Cookie Doe area 1')).not.toBeVisible();
  expect(screen.getByText('Review later', { selector: 'strong' })).toBeVisible();
  expect(screen.getByText('Not fully inspected (1 on this page)')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'More source issues' }));
  expect(await screen.findByText('Cookie Doe area 100')).toBeVisible();
  expect(paths.some((path) => path.includes('offset=50&limit=50&revisionId=cookie-revision'))).toBe(
    true,
  );
  expect(paths.some((path) => path.endsWith('/source-text'))).toBe(false);
  expect(screen.queryByText(/100%|all reports reviewed/i)).toBeNull();
});

it('embeds one source under its report without a duplicate heading or inventory controls', async () => {
  const fetcher = sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  render(<ImportSourceTextBrowser intakeId="fictional-source" onChanged={() => {}} />);
  await screen.findByRole('button', { name: 'Fictional retained source.pdf' });
  expect(screen.queryByRole('heading', { name: 'Originals and source review' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Fictional retained source.pdf' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'More source files' })).toBeNull();
  expect(fetcher.mock.calls.some(([path]) => String(path).includes('rootOnly='))).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Fictional retained source.pdf' }));
  await open();
  expect(screen.getByRole('heading', { name: 'Page 1 transcription' })).toBeVisible();
});

it('retains a dirty source across parent updates and clears its guard on unmount', async () => {
  sourceBrowserFetch();
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const pending = vi.fn();
  const { rerender, unmount } = render(
    <ImportSourceTextBrowser onChanged={() => {}} onPendingChange={pending} />,
  );
  await selectRetainedSource();
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Cookie Doe unsaved wording' },
  });
  expect(pending).toHaveBeenLastCalledWith(true);
  rerender(<ImportSourceTextBrowser onChanged={() => {}} onPendingChange={pending} />);
  expect(screen.getByDisplayValue('Cookie Doe unsaved wording')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh imported files' })).toBeDisabled();
  unmount();
  expect(pending).toHaveBeenLastCalledWith(false);
});

it('keeps the aggregate source guard active when another source is selected', async () => {
  const fetcher = sourceBrowserFetch();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input, options) =>
    String(input).includes('rootOnly=')
      ? Response.json({
          data: [
            {
              id: 'fictional-source',
              filename: 'Fictional retained source.pdf',
              mimeType: 'application/pdf',
            },
            {
              id: 'cookie-second',
              filename: 'Cookie Doe second source.pdf',
              mimeType: 'application/pdf',
            },
          ],
          meta: { complete: true },
        })
      : original(input, options),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  const pending = vi.fn();
  const view = () => <ImportSourceTextBrowser onChanged={() => {}} onPendingChange={pending} />;
  const { rerender } = render(view());
  await selectRetainedSource();
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Passage 1 · native' }), {
    target: { value: 'Cookie Doe unsaved protected draft' },
  });
  expect(pending).toHaveBeenLastCalledWith(true);
  rerender(view());
  expect(await screen.findByRole('button', { name: 'Cookie Doe second source.pdf' })).toBeVisible();
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Refresh imported files' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Cookie Doe second source.pdf' }));
  expect(screen.getByDisplayValue('Cookie Doe unsaved protected draft')).toBeVisible();
  expect(screen.getByText(/before opening another file/)).toBeVisible();
  rerender(view());
  expect(screen.getByRole('button', { name: 'Cookie Doe second source.pdf' })).toBeVisible();
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Refresh imported files' })).toBeDisabled();
});

it('shows file-level extraction failures without inventing a page or claiming no issues', async () => {
  const fetcher = sourceBrowserFetch();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (input, options) =>
    String(input).includes('/source-issues?')
      ? Response.json({
          data: {
            status: 'unavailable',
            revisionId: null,
            sourceHash: revision.sourceHash,
            adapter: null,
            summary: null,
            issues: [],
            offset: 0,
            nextOffset: null,
            extractionFailure: { scope: 'file', reasonCode: 'SOURCE_INVENTORY_FAILED' },
          },
        })
      : original(input, options),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  render(<ImportSourceTextBrowser onChanged={() => {}} />);
  expect(await screen.findByText('Source processing needs attention · Review')).toBeVisible();
  await selectRetainedSource();
  expect(screen.getByText(/Source processing stopped/)).toBeVisible();
  expect(screen.queryByText(/No specific issues flagged/)).toBeNull();
  expect(screen.queryByText(/^Page 1/)).toBeNull();
});

it('groups repeated page flags without presenting them as missing clinical records', async () => {
  const sourceFetch = sourceBrowserFetch();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input).includes('/source-issues?'))
        return Response.json({
          data: {
            status: 'available',
            revisionId: 'fictional-revision',
            offset: 0,
            nextOffset: null,
            summary: { specificIssues: 3, coverageIssues: 0, inspectedPages: 0, exceptions: 0 },
            issues: [1, 2, 3].map((n) => ({
              id: `flag-${n}`,
              kind: 'low-confidence',
              detail: `Fictional mark ${n}`,
              status: 'open',
              region: { page: 1 },
              category: 'detected',
              precision: 'page',
            })),
          },
        });
      return sourceFetch(input, options);
    }),
  );
  const { ImportSourceTextBrowser } =
    await import('../../app/features/import/ImportSourceTextBrowser');
  render(<ImportSourceTextBrowser onChanged={() => {}} />);
  await selectRetainedSource();
  const summary = screen.getByText('Page 1 · 3 reading flags in this batch');
  expect(screen.getByText('Fictional mark 1')).not.toBeVisible();
  await userEvent.click(summary);
  expect(screen.getByRole('button', { name: 'Review page 1 together' })).toBeVisible();
  expect(screen.getByText(/Flags are extraction signals, not a count/)).toBeVisible();
  expect(sourceFetch.mock.calls.some(([url]) => String(url).endsWith('/source-text'))).toBe(false);
});

it('approves selected OCR sections with chained revision pins and leaves unreadable sections alone', async () => {
  const { SourceAttentionReview } = await import('../../app/features/import/SourceAttentionReview');
  let current: SourceTextRevision = {
    ...revision,
    pages: [...revision.pages, { page: 3, disposition: 'unreadable', inspected: false }],
    issues: [
      revision.issues[0],
      { ...revision.issues[0], id: 'page-two', region: { page: 2 } },
      { ...revision.issues[0], id: 'unreadable', kind: 'unreadable', region: { page: 3 } },
    ],
  };
  const { fetcher, writes } = setup();
  fetcher.mockImplementation(async (_input, options) => {
    if (options?.method === 'POST') {
      const request = JSON.parse(String(options.body)) as SourceTextReviewRequest;
      writes.push(request);
      expect(request.expectedRevisionId).toBe(current.id);
      current = {
        ...current,
        id: `revision-${writes.length}`,
        issues: current.issues.map((i) =>
          i.region.page === request.scope.page ? { ...i, status: 'confirmed' } : i,
        ),
      };
    }
    return Response.json({ data: available(current) });
  });
  render(
    <SourceAttentionReview
      intake={
        { id: 'fictional-source', filename: 'cookie.pdf' } as import('../../shared/intake').Intake
      }
      onChanged={() => {}}
    />,
  );
  expect(await screen.findByText('3 sections not reviewed')).toBeVisible();
  expect(screen.getByLabelText('Select page 3')).toBeDisabled();
  await userEvent.click(screen.getByLabelText('Select all approvable sections'));
  await userEvent.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
  expect(await screen.findByText('1 section not reviewed')).toBeVisible();
  expect(writes.map((w) => [w.action, w.scope.page])).toEqual([
    ['confirm', 1],
    ['confirm', 2],
  ]);
  expect(screen.queryByText('Page 1 · Source text')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('intake-batches'))).toBe(false);
});

it('shares one selection bar across records and source files, with distinct approval actions and tab scope', async () => {
  const { fetcher, writes } = setup();
  const revisions = new Map(
    ['cookie-one', 'cookie-two'].map((id) => [id, { ...revision, intakeId: id }]),
  );
  fetcher.mockImplementation(async (input, options) => {
    const id = String(input).includes('cookie-one') ? 'cookie-one' : 'cookie-two';
    let current = revisions.get(id)!;
    if (options?.method === 'POST') {
      const request = JSON.parse(String(options.body)) as SourceTextReviewRequest;
      expect(request.expectedRevisionId).toBe(current.id);
      writes.push(request);
      current = { ...current, id: id + '-confirmed', issues: [] };
      revisions.set(id, current);
    }
    return Response.json({ data: available(current) });
  });
  const value: ImportReviewModel = {
    reports: [
      {
        id: 'report',
        source: 'Fictional Laboratory',
        sourceConfirmed: true,
        reportType: 'Laboratory report',
        date: '2026-09-01',
        subject: { label: 'Cookie Doe', confirmed: true, evidence: 'named' },
      },
    ],
    records: [
      {
        id: 'test',
        reportId: 'report',
        kind: 'Test results',
        label: 'Potassium',
        originalLabel: 'Potassium',
        value: '4.1',
        unit: 'mmol/L',
        status: 'review',
        eligible: true,
      },
    ],
  };
  function Sources({ onCount }: { onCount: (count: number) => void }) {
    useEffect(() => onCount(2), [onCount]);
    return (
      <>
        {[...revisions.keys()].map((id) => (
          <SourceAttentionReview
            key={id}
            intake={{ id, filename: id + '.pdf' } as import('../../shared/intake').Intake}
            onChanged={() => {}}
          />
        ))}
      </>
    );
  }
  const saveRecords = vi.fn().mockResolvedValue(true);
  render(
    <ImportReviewPresentation
      model={value}
      actions={{ onSave: saveRecords }}
      renderSourceAttention={(onCount) => <Sources onCount={onCount} />}
    />,
  );
  await waitFor(() => expect(screen.getAllByLabelText('Select page 1')).toHaveLength(2));
  expect(screen.getAllByRole('checkbox', { name: 'Select all shown' })).toHaveLength(1);
  expect(screen.queryByLabelText('Select all approvable sections')).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: /^Test results/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  expect(screen.getByRole('checkbox', { name: '1 selected' })).toBeChecked();
  expect(screen.queryByRole('button', { name: /^Approve.*text/ })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: /^Needs attention/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  expect(screen.getByRole('checkbox', { name: '2 selected' })).toBeChecked();
  expect(screen.queryByRole('button', { name: /Save 1 records/ })).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: /^All/ }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  expect(screen.getByRole('checkbox', { name: '3 selected' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Approve 2 text sections' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '1 selected' })).toBeChecked());
  expect(saveRecords).not.toHaveBeenCalled();
  expect(writes.every((request) => request.action === 'confirm')).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Save 1 records' }));
  expect(saveRecords).toHaveBeenCalledWith(['test']);
});

it('a bulk OCR conflict retains earlier successes and does not approve remaining sections', async () => {
  const { SourceAttentionReview } = await import('../../app/features/import/SourceAttentionReview');
  let current = {
    ...revision,
    issues: [revision.issues[0], { ...revision.issues[0], id: 'page-two', region: { page: 2 } }],
  };
  const { fetcher, writes } = setup();
  fetcher.mockImplementation(async (_input, options) => {
    if (options?.method === 'POST') {
      const request = JSON.parse(String(options.body)) as SourceTextReviewRequest;
      writes.push(request);
      if (writes.length === 2)
        return Response.json(
          { error: { code: 'SOURCE_TEXT_CONFLICT', message: 'Source changed in another tab.' } },
          { status: 409 },
        );
      current = {
        ...current,
        id: 'approved-one',
        issues: current.issues.filter((i) => i.region.page !== 1),
      };
    }
    return Response.json({ data: available(current) });
  });
  render(
    <SourceAttentionReview
      intake={
        { id: 'fictional-source', filename: 'cookie.pdf' } as import('../../shared/intake').Intake
      }
      onChanged={() => {}}
    />,
  );
  await screen.findByText('2 sections not reviewed');
  await userEvent.click(screen.getByLabelText('Select all approvable sections'));
  await userEvent.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '1 sections saved. Source changed in another tab. Remaining sections were not approved.',
  );
  expect(screen.getByText('Page 2 · Source text')).toBeVisible();
  expect(screen.queryByText('Page 1 · Source text')).toBeNull();
});

it('inline source correction requires a reason, preserves the draft, and remains separate from approval', async () => {
  const { SourceAttentionReview } = await import('../../app/features/import/SourceAttentionReview');
  const { writes } = setup();
  render(
    <SourceAttentionReview
      intake={
        {
          id: 'fictional-source',
          filename: 'cookie.txt',
          mimeType: 'text/plain',
          contentUrl: '/api/source',
          bytes: 120,
        } as import('../../shared/intake').Intake
      }
      onChanged={() => {}}
    />,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
  const input = screen.getByRole('textbox', { name: 'Extracted text on page 1' });
  fireEvent.change(input, { target: { value: 'Cookie Doe corrected source wording' } });
  expect(screen.getByRole('button', { name: 'Approve section' })).toBeDisabled();
  const reason = screen.getByRole('textbox', { name: 'Correction reason' });
  fireEvent.change(reason, { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  fireEvent.change(reason, { target: { value: 'Corrected OCR transcription' } });
  await userEvent.click(screen.getByRole('button', { name: 'Update' }));
  expect(
    await screen.findByText('Text updated. Approve the section when it looks correct.'),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    action: 'correct',
    scope: { page: 1 },
    reason: 'Corrected OCR transcription',
    spans: [{ text: 'Cookie Doe corrected source wording', provenance: 'human' }],
  });
  expect(screen.getByRole('button', { name: 'Approve section' })).toBeEnabled();
});
