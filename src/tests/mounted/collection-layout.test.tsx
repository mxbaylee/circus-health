import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { NotesPage } from '../../app/features/notes/NotesPage';
import { selectProfile } from '../../app/data/profile';

// PDF asset loading is covered separately from layout and state-control interactions.
vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: { total: 0 } }), {
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      response(
        String(input).includes('filter-options')
          ? {}
          : String(input).includes('historical-note-options')
            ? { sources: [], acquisitionSources: [], types: [] }
            : [],
      ),
    ),
  );
});

it('Notes places collection links then full-width filters before the list and preserves route state', async () => {
  const user = userEvent.setup();
  const router = createMemoryRouter([{ path: '*', element: <NotesPage /> }], {
    initialEntries: ['/notes?q=fictional&visibility=archived&offset=40'],
  });
  render(<RouterProvider router={router} />);
  const tabs = screen.getByRole('navigation', { name: 'Note collections' });
  const search = screen.getByRole('textbox', { name: 'Search notes' });
  const toolbar = search.closest('.collection-toolbar')!;
  const list = screen.getByRole('complementary', { name: 'Notes list' });
  expect(toolbar).not.toBeNull();
  expect(list).not.toContainElement(search);
  expect(tabs.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(tabs).getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByText('Inactive')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Edit Inactive' }));
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  await waitFor(() => expect(router.state.location.search).toBe('?q=fictional&visibility=visible'));
  expect(search).toHaveValue('fictional');
  await act(() => router.navigate(-1));
  expect(screen.getByText('Inactive')).toBeVisible();
  expect(search).toHaveValue('fictional');
  const historical = within(tabs).getByRole('link', { name: 'Historical notes' });
  historical.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(historical).toHaveAttribute('aria-current', 'page'));
  expect(router.state.location.search).toBe('?visibility=archived&kind=historical');
  expect(screen.getByRole('textbox', { name: 'Search historical notes' })).toHaveValue('');
});

it('People keeps search, its single filter editor and saved pills outside the list without extra tabs', async () => {
  const user = userEvent.setup();
  const router = createMemoryRouter([{ path: '*', element: <NotesPage initialKind="person" /> }], {
    initialEntries: ['/people?q=Cookie&visibility=all'],
  });
  render(<RouterProvider router={router} />);
  const list = screen.getByRole('complementary', { name: 'People list' });
  const search = screen.getByRole('textbox', { name: 'Search people' });
  const toolbar = search.closest('.collection-toolbar')!;
  expect(list).not.toContainElement(search);
  expect(screen.queryByRole('combobox', { name: 'Visibility' })).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Note collections' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Filters' }));
  expect(toolbar).toContainElement(screen.getByRole('region', { name: 'Filter conditions' }));
  await user.click(screen.getByRole('button', { name: 'Add filter' }));
  const field = screen.getByRole('combobox', { name: 'Filter field' });
  expect(field).toHaveValue('tags');
  await user.selectOptions(field, 'text');
  await user.type(screen.getByRole('textbox', { name: 'Filter text' }), 'Fictional');
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(screen.getByRole('region', { name: 'Filter conditions' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add filter' })).toBeEnabled();
  const pill = screen.getByText('Text contains Fictional');
  expect(toolbar).toContainElement(pill);
  expect(list).not.toContainElement(pill);
  expect(new URLSearchParams(router.state.location.search).get('visibility')).toBe('all');
  expect(search).toHaveValue('Cookie');
});
