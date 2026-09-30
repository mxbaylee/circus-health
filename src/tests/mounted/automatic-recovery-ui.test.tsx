import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { Shell } from '../../app/components/Shell';
import { ThemeProvider } from '../../app/components/ThemeProvider';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

afterEach(() => vi.useRealTimers());

it('shows provider sign-in on other pages, opens connection settings, and clears after recovery and profile switch', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const profile = { id: 'fictional-recovery', name: 'Fictional family', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  let waiting = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      const data = url.endsWith('/intake-batches')
        ? [
            {
              status: 'running',
              items: [
                {
                  reason:
                    waiting && url.includes('/fictional-recovery/')
                      ? 'provider_authentication'
                      : 'continuing',
                },
              ],
            },
          ]
        : [];
      return new Response(JSON.stringify({ data }));
    }),
  );
  const router = createMemoryRouter(
    [
      {
        element: (
          <ThemeProvider>
            <Shell />
          </ThemeProvider>
        ),
        children: [
          { path: '/people', element: <h1>Family people</h1> },
          { path: '/notes', element: <h1>Family notes</h1> },
        ],
      },
    ],
    { initialEntries: ['/people'] },
  );
  render(<RouterProvider router={router} />);
  expect(await screen.findByRole('status', { name: 'Model sign-in required' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Family people' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Open model connection' }));
  expect(await screen.findByRole('dialog', { name: 'Moxie connection' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await act(async () => {
    await router.navigate('/notes');
  });
  expect(screen.getByRole('status', { name: 'Model sign-in required' })).toBeVisible();
  waiting = false;
  await act(async () => {
    vi.advanceTimersByTime(15000);
  });
  expect(screen.queryByRole('status', { name: 'Model sign-in required' })).not.toBeInTheDocument();
  waiting = true;
  await act(async () => {
    vi.advanceTimersByTime(15000);
  });
  expect(screen.getByRole('status', { name: 'Model sign-in required' })).toBeVisible();
  await act(async () =>
    selectProfile({ id: 'fictional-other', name: 'Other family', placebo: true }),
  );
  expect(screen.queryByRole('status', { name: 'Model sign-in required' })).not.toBeInTheDocument();
});
