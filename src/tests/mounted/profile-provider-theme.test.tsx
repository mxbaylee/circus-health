import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProfileProvider } from '../../app/components/ProfileProvider';
import { ThemeToggle } from '../../app/components/ThemeToggle';
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
