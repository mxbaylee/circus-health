import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { PersonFilter } from '../../app/components/PersonFilter';
import { PersonScopeProvider } from '../../app/components/PersonScope';
import { selectProfile } from '../../app/data/profile';
const people = [
  {
    personId: 'cookie-cat',
    noteId: 'cat-note',
    name: 'Cookie Doe',
    birthDate: '1986-02-14',
    icon: 'cat',
  },
  {
    personId: 'cookie-star',
    noteId: 'star-note',
    name: ' cookie   DOE ',
    birthDate: '1986-02-14',
    icon: 'lucide:star',
  },
];
const response = (data: unknown) => new Response(JSON.stringify({ data }));
beforeEach(() => {
  selectProfile({ id: 'fictional-picker', name: 'Fictional Self', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) =>
      String(path).endsWith('/clinical-people')
        ? response(people)
        : response({ name: 'Cookie Doe', noteId: 'cat-note' }),
    ),
  );
});
function mount() {
  const router = createMemoryRouter(
    [
      {
        path: '/notes',
        element: (
          <PersonScopeProvider>
            <ul>
              <PersonFilter />
            </ul>
          </PersonScopeProvider>
        ),
      },
    ],
    { initialEntries: ['/notes?personId=patient&q=lab&offset=40&compare=old'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
it('uses explicit dropdown apply/cancel and distinguishes equal names and DOBs by icon', async () => {
  const router = mount(),
    user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Edit person: Self' }));
  const select = await screen.findByRole('combobox', { name: 'Show records for' });
  await waitFor(() => expect(select).toBeEnabled());
  expect(screen.getByRole('option', { name: /cat icon/ })).toHaveValue('cookie-cat');
  expect(screen.getByRole('option', { name: /star icon/ })).toHaveValue('cookie-star');
  expect(screen.queryByRole('searchbox')).toBeNull();
  await user.selectOptions(select, 'cookie-cat');
  expect(router.state.location.search).toContain('personId=patient');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Edit person: Self' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Edit person: Self' }));
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
  await user.selectOptions(screen.getByRole('combobox'), 'cookie-cat');
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  expect(router.state.location.search).toContain('personId=cookie-cat');
  expect(router.state.location.search).toContain('q=lab');
  expect(router.state.location.search).not.toMatch(/offset|compare/);
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('discards a pending choice when another person is selected by navigation', async () => {
  const router = mount(),
    user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Edit person: Self' }));
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
  await user.selectOptions(screen.getByRole('combobox'), 'cookie-cat');
  await act(async () => {
    await router.navigate('/notes?personId=cookie-star');
  });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(router.state.location.search).toContain('personId=cookie-star');
});
it('does not enable a person change when options cannot be loaded', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Fictional unavailable' } }),
          { status: 503 },
        ),
    ),
  );
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Edit person: Self' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional unavailable');
  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('combobox')).toBeNull();
});
