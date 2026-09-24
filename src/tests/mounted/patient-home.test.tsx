import { useState } from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { PersonIconPicker } from '../../app/components/PersonIcon';
import { Patient } from '../../app/pages/Patient';
import { Shell } from '../../app/components/Shell';
import { ThemeProvider } from '../../app/components/ThemeProvider';
import { NotesPage } from '../../app/features/notes/NotesPage';
import { recordProfile, replaceProfiles, selectProfile } from '../../app/data/profile';
import type { Note } from '../../shared/api';
vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));
const profile = {
  id: 'cookie-dough',
  name: 'Cookie Dough',
  placebo: true,
  nameVersion: 1,
  icon: '🃏',
};
const self: Note = {
  id: 'person-note:self',
  kind: 'person',
  isSelf: true,
  status: 'editable',
  title: profile.name,
  content: '',
  typeLabel: null,
  eventDate: null,
  topics: '',
  rawThoughts: '',
  personId: 'patient',
  person: { name: profile.name, icon: '🃏' },
  pinned: false,
  archived: false,
  createdAt: '2026-09-01',
  updatedAt: '2026-09-01',
  finishedAt: null,
  version: 1,
  sourceRecordId: null,
  links: [],
  backlinks: [],
  attachments: [],
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: { total: 0 } }), {
    headers: { 'Content-Type': 'application/json' },
  });
function Icons() {
  const [icon, setIcon] = useState('moon');
  return (
    <>
      <PersonIconPicker value={icon} onChange={setIcon} />
      <output aria-label="Selected icon">{icon}</output>
    </>
  );
}
it('searches Lucide metadata and selects a pack icon only on confirmation', async () => {
  const user = userEvent.setup();
  render(<Icons />);
  await user.click(screen.getByRole('button', { name: 'Choose person icon: Moon' }));
  expect(screen.getByLabelText('Search icons')).toHaveFocus();
  await user.type(screen.getByLabelText('Search icons'), 'lotus');
  expect(screen.getByRole('button', { name: 'Flower 2 icon' })).toBeInTheDocument();
  expect(screen.getByLabelText('Selected icon')).toHaveTextContent('moon');
  await user.click(screen.getByRole('button', { name: 'Flower 2 icon' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Selected icon')).toHaveTextContent('lucide:flower-2');
  expect(screen.getByRole('button', { name: 'Choose person icon: Flower 2' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Choose person icon: Flower 2' }));
  await user.paste('🦄');
  await user.keyboard('{Enter}');
  expect(screen.getByText(/No icons match/)).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.getByLabelText('Selected icon')).toHaveTextContent('lucide:flower-2');
});
it('supports fuzzy search, categories, arrow navigation and Escape without saving', async () => {
  const user = userEvent.setup();
  render(<Icons />);
  await user.click(screen.getByRole('button', { name: 'Choose person icon: Moon' }));
  await user.selectOptions(screen.getByLabelText('Icon category'), 'nature');
  const search = screen.getByLabelText('Search icons');
  await user.type(search, 'flowre');
  expect(screen.getByRole('button', { name: 'Flower icon' })).toBeInTheDocument();
  const buttons = within(screen.getByRole('group', { name: 'Icon results' })).getAllByRole(
    'button',
  );
  await user.keyboard('{ArrowDown}');
  expect(buttons[0]).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(buttons[1]).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Selected icon')).toHaveTextContent('moon');
});
it('home opens the canonical Self, uses its sidebar icon and refreshes saved identity without changing profile', async () => {
  replaceProfiles([profile]);
  selectProfile(profile);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) =>
      response(String(input).includes('/notes/person-note%3Aself') ? self : []),
    ),
  );
  const router = createMemoryRouter(
    [
      {
        element: (
          <ThemeProvider>
            <Shell />
          </ThemeProvider>
        ),
        children: [{ path: '/', element: <Patient /> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
  expect(await screen.findByLabelText('Display name')).toHaveValue('Cookie Dough');
  const heading = screen.getByRole('heading', { level: 2, name: 'Cookie Dough' });
  expect(heading.closest('.note-identity-heading')).toHaveTextContent('Cookie DoughSelf');
  const nav = screen.getByRole('navigation', { name: 'Main navigation' }),
    home = within(nav).getByRole('link', { name: 'Cookie Dough Self' });
  expect(home).toHaveAttribute('href', '/');
  expect(home).toHaveAttribute('aria-current', 'page');
  expect(home.querySelector('.person-emoji')).toHaveTextContent('🃏');
  expect(within(nav).queryByText('Overview')).not.toBeInTheDocument();
  recordProfile(profile.id, { ...profile, name: 'Moon Cookie', icon: '🌙', nameVersion: 2 });
  await waitFor(() =>
    expect(
      within(nav).getByRole('link', { name: 'Moon Cookie Self' }).querySelector('.person-emoji'),
    ).toHaveTextContent('🌙'),
  );
  await waitFor(() => expect(document.title).toBe('Circus Health · Moon Cookie'));
});
it('People has no note collection tabs and Notes offers only living and historical notes', async () => {
  selectProfile(profile);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  const people = createMemoryRouter([{ path: '*', element: <NotesPage initialKind="person" /> }], {
    initialEntries: ['/people'],
  });
  const view = render(<RouterProvider router={people} />);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('People');
  expect(screen.queryByRole('navigation', { name: 'Note collections' })).not.toBeInTheDocument();
  view.unmount();
  const notes = createMemoryRouter([{ path: '*', element: <NotesPage /> }], {
    initialEntries: ['/notes'],
  });
  render(<RouterProvider router={notes} />);
  const tabs = screen.getByRole('navigation', { name: 'Note collections' });
  expect(within(tabs).getAllByRole('link')).toHaveLength(2);
  expect(within(tabs).queryByText('People')).not.toBeInTheDocument();
});
