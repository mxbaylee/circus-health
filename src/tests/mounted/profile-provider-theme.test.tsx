import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProfileProvider } from '../../app/components/ProfileProvider';
import { ThemeToggle } from '../../app/components/ThemeToggle';
import {
  checkConnection,
  connectionSnapshot,
  startConnectionMonitor,
} from '../../app/data/connection';
import {
  clearProfile,
  currentProfile,
  replaceProfiles,
  selectProfile,
} from '../../app/data/profile';

vi.mock('../../app/components/ProfileManagement', () => ({
  ProfileManagement: ({
    initialMode,
    triggerLabel,
  }: {
    initialMode?: string;
    triggerLabel?: string;
  }) => <button data-initial-mode={initialMode}>{triggerLabel || 'Profile picker'}</button>,
}));
const profile = { id: 'fictional-robin', name: 'Robin', placebo: false, locked: true };
beforeEach(() => {
  clearProfile();
  replaceProfiles([]);
});
function profilesResponse(data: (typeof profile)[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data }))),
  );
}

it('keeps appearance across startup, unlock, lock, and reload', async () => {
  profilesResponse([profile]);
  localStorage.setItem('circus-health-theme', 'light');
  const view = render(
    <ProfileProvider>
      <ThemeToggle />
      <p>Archive</p>
    </ProfileProvider>,
  );
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(await screen.findByRole('button', { name: 'Choose profile' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Circus Health' })).toBeVisible();
  expect(screen.getByText('Your circus, your monkeys, all under one tent.')).toBeVisible();
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  act(() => {
    replaceProfiles([{ ...profile, locked: false }]);
    selectProfile({ ...profile, locked: false });
  });
  expect(screen.getByText('Archive')).toBeVisible();
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  act(() => {
    replaceProfiles([profile]);
  });
  expect(screen.getByRole('button', { name: 'Choose profile' })).toBeVisible();
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  view.unmount();
  render(
    <ProfileProvider>
      <ThemeToggle />
    </ProfileProvider>,
  );
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  await screen.findByRole('button', { name: 'Choose profile' });
});

it.each(['focus', 'visibilitychange'])(
  'refreshes lock state on %s without opening a different profile',
  async (event) => {
    profilesResponse([{ ...profile, locked: false }]);
    render(
      <ProfileProvider>
        <ThemeToggle />
        <p>Archive</p>
      </ProfileProvider>,
    );
    await screen.findByText('Archive');
    profilesResponse([
      profile,
      { ...profile, id: 'fictional-other', name: 'Other', locked: false },
    ]);
    if (event === 'focus') fireEvent(window, new Event(event));
    else fireEvent(document, new Event(event));
    await waitFor(() => expect(currentProfile()).toBeNull());
    expect(screen.getByRole('button', { name: 'Choose profile' })).toBeVisible();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  },
);

it('ignores a pre-switch connection-recovery registry response but accepts a fresh lock', async () => {
  const first = { ...profile, locked: false },
    other = { ...first, id: 'fictional-other', name: 'Other' };
  let profileReads = 0,
    runtimeReads = 0,
    freshLock = false,
    releaseStale!: (response: Response) => void,
    staleStarted!: () => void;
  const staleReady = new Promise<void>((resolve) => {
    staleStarted = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/runtime') {
        runtimeReads++;
        return new Response(JSON.stringify(runtimeReads === 1 ? {} : { encrypted: true }), {
          status: runtimeReads === 1 ? 503 : 200,
        });
      }
      if (url === '/api/profiles') {
        profileReads++;
        if (profileReads === 2) {
          staleStarted();
          return new Promise<Response>((resolve) => {
            releaseStale = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            data: freshLock ? [first, { ...other, locked: true }] : [first, other],
          }),
        );
      }
      return new Response(null, { status: 404 });
    }),
  );
  render(
    <ProfileProvider>
      <p>Archive</p>
    </ProfileProvider>,
  );
  expect(await screen.findByText('Archive')).toBeVisible();
  const stop = startConnectionMonitor();
  try {
    await waitFor(() => expect(connectionSnapshot().status).toBe('unavailable'));
    const recoveries = connectionSnapshot().recoveries;
    await waitFor(async () => {
      await act(async () => checkConnection());
      expect(connectionSnapshot().recoveries).toBeGreaterThan(recoveries);
    });
    await waitFor(() => expect(profileReads).toBe(2));
    await staleReady;
    act(() => selectProfile(other));
    await act(async () => releaseStale(new Response(JSON.stringify({ data: [first] }))));
    expect(currentProfile()?.id).toBe(other.id);
    expect(screen.getByText('Archive')).toBeVisible();

    freshLock = true;
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(currentProfile()).toBeNull());
  } finally {
    stop();
  }
});

it('offers one direct create action when the archive has no profiles', async () => {
  profilesResponse([]);
  render(
    <ProfileProvider>
      <p>Archive</p>
    </ProfileProvider>,
  );
  const action = await screen.findByRole('button', { name: 'Create profile' });
  expect(action).toHaveAttribute('data-initial-mode', 'create');
  expect(screen.getByText('Create a profile to start your private health archive.')).toBeVisible();
  expect(screen.queryByText('Archive')).not.toBeInTheDocument();
});
