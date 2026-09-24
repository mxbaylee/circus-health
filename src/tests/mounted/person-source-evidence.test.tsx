import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { PersonSourceEvidence } from '../../app/features/notes/PersonSourceEvidence';
import { NoteLinks } from '../../app/features/notes/NoteLinks';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { NoteLink, PersonSourceEvidence as SourceEvidence } from '../../shared/api';

const profile = { id: 'fictional-evidence', name: 'Fictional Rowan', placebo: true };
const source = (
  sourceRecordId: string,
  overrides: Partial<SourceEvidence> = {},
): SourceEvidence => ({
  sourceRecordId,
  sourceTitle: `Fictional source ${sourceRecordId}`,
  sourceArchived: false,
  sourceMissing: false,
  entries: [],
  ...overrides,
});
const response = (data: SourceEvidence[], total = data.length, status = 200) =>
  new Response(
    JSON.stringify(
      status === 200
        ? { data, meta: { total, limit: 20, offset: 0, revision: 1 } }
        : { error: { code: 'FICTIONAL_FAILURE', message: 'Fictional source load failed' } },
    ),
    { status, headers: { 'Content-Type': 'application/json' } },
  );

it('renders grouped exact-source navigation and plain-language retained states', async () => {
  selectProfile(profile);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response([
        source('source:grouped', {
          sourceTitle: 'Fictional appointment summary',
          sourceArchived: true,
          entries: [
            {
              entityId: 'result:one',
              kind: 'observation',
              title: 'Fictional iron result',
              appUrl: '/tests?result=result%3Aone&detail=1',
              archived: false,
              missing: false,
            },
            {
              entityId: 'document:two',
              kind: 'document',
              title: 'Fictional inactive prescription',
              appUrl: '/tests?view=vision&document=document%3Atwo&visibility=all',
              archived: true,
              missing: false,
            },
          ],
        }),
        source('source:only', { sourceTitle: 'Fictional source-only evidence' }),
        source('source:missing', {
          sourceTitle: 'Fictional unavailable source',
          sourceMissing: true,
          entries: [
            {
              entityId: 'medication:missing',
              kind: 'medication',
              title: 'Unavailable linked record',
              archived: false,
              missing: true,
            },
          ],
        }),
      ]),
    ),
  );
  render(
    <MemoryRouter>
      <PersonSourceEvidence noteId="note:fictional" noteVersion={7} />
    </MemoryRouter>,
  );
  const section = await screen.findByRole('region', { name: 'Imported source evidence' });
  expect(section).toHaveTextContent('does not establish a clinician, care-team or other role');
  expect(within(section).getByRole('link', { name: 'Fictional iron result' })).toHaveAttribute(
    'href',
    '/tests?result=result%3Aone&detail=1',
  );
  expect(
    within(section).getByRole('link', { name: 'Fictional inactive prescription' }),
  ).toHaveAttribute('href', '/tests?view=vision&document=document%3Atwo&visibility=all');
  expect(section).toHaveTextContent('Inactive source');
  expect(section).toHaveTextContent('No saved health entry cites this exact source.');
  expect(section).toHaveTextContent('Original source unavailable');
  expect(section).toHaveTextContent('Previously saved entry unavailable');
  expect(within(section).getAllByRole('link', { name: 'View original source' })[0]).toHaveAttribute(
    'href',
    '/sources?record=source%3Agrouped',
  );
});

it('keeps load errors visible, bounds paging, retries, and refreshes for note versions', async () => {
  selectProfile(profile);
  const requests: string[] = [];
  let pageAttempt = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('noteVersion=8')) return response([source('source:version-eight')]);
      if (url.includes('offset=20')) {
        pageAttempt += 1;
        return pageAttempt === 1 ? response([], 21, 500) : response([source('source:last')], 21);
      }
      return response(
        Array.from({ length: 20 }, (_, index) => source(`source:${index}`)),
        21,
      );
    }),
  );
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter>
      <PersonSourceEvidence noteId="note:fictional" noteVersion={7} />
    </MemoryRouter>,
  );
  await screen.findByText('Fictional source source:0');
  await user.click(screen.getByRole('button', { name: 'Next sources' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Source evidence could not be loaded');
  expect(screen.getByRole('button', { name: 'Next sources' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previous sources' })).toBeEnabled();
  expect(screen.queryByText('No saved source evidence')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Fictional source source:last')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next sources' })).toBeDisabled();

  view.rerender(
    <MemoryRouter>
      <PersonSourceEvidence noteId="note:fictional" noteVersion={8} />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Fictional source source:version-eight')).toBeVisible();
  expect(requests.some((url) => url.includes('offset=0') && url.includes('noteVersion=8'))).toBe(
    true,
  );
});

it('resets selection for a profile switch and never shows a late prior-profile response', async () => {
  const first = { id: 'fictional-first', name: 'Fictional First', placebo: true };
  const second = { id: 'fictional-second', name: 'Fictional Second', placebo: true };
  replaceProfiles([first, second]);
  selectProfile(first);
  let releaseFirst: ((value: Response) => void) | undefined;
  const firstResponse = new Promise<Response>((resolveFirst) => {
    releaseFirst = resolveFirst;
  });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/fictional-first/')) return firstResponse;
      return response([source('source:second-profile')]);
    }),
  );
  render(
    <MemoryRouter>
      <PersonSourceEvidence noteId="note:same" noteVersion={3} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(requests.some((url) => url.includes('/fictional-first/'))).toBe(true));
  act(() => selectProfile(second));
  expect(await screen.findByText('Fictional source source:second-profile')).toBeVisible();
  act(() => releaseFirst?.(response([source('source:late-first-profile')])));
  await waitFor(() =>
    expect(
      screen.queryByText('Fictional source source:late-first-profile'),
    ).not.toBeInTheDocument(),
  );
  expect(
    requests.some((url) => url.includes('/fictional-second/') && url.includes('offset=0')),
  ).toBe(true);
});

it('labels Person note links as manual without changing non-Person wording', () => {
  selectProfile(profile);
  const manualLink: NoteLink = {
    id: 'link:fictional-manual',
    targetType: 'note',
    targetId: 'note:fictional-related',
    title: 'Fictional related note',
    archived: false,
    missing: false,
    current: true,
    relation: 'references',
  };
  const view = render(
    <MemoryRouter>
      <NoteLinks links={[]} onChange={() => {}} personContext />
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Manually linked entries' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add manual link' })).toBeVisible();
  expect(
    screen.getByText(
      'No manually linked entries. Manual links are separate from imported source evidence.',
    ),
  ).toBeVisible();
  expect(screen.queryByText(/appears separately below/)).not.toBeInTheDocument();
  view.rerender(
    <MemoryRouter>
      <NoteLinks links={[manualLink]} onChange={() => {}} personContext />
    </MemoryRouter>,
  );
  expect(
    screen.getByText(
      'These are links you added. Imported source evidence is separate and read-only when available.',
    ),
  ).toBeVisible();
  view.rerender(
    <MemoryRouter>
      <NoteLinks links={[]} onChange={() => {}} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Linked entries' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add link' })).toBeVisible();
  expect(screen.getByText('No linked entries.')).toBeVisible();
});
