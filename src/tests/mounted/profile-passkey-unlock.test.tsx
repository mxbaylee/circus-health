import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProfileManagement } from '../../app/components/ProfileManagement';
import {
  clearProfile,
  currentProfile,
  replaceProfiles,
  selectProfile,
} from '../../app/data/profile';
import { unlockProfilePasskey } from '../../app/components/passkey-unlock';
vi.mock('../../app/components/passkey-unlock', () => ({
  unlockProfilePasskey: vi.fn(),
  PasskeyUnlockError: class extends Error {},
}));
vi.mock('../../app/components/ProfileStorage', () => ({
  ArchiveStorageSummary: () => null,
  ProfileStorage: () => null,
}));
const profile = {
  id: 'fictional-profile',
  name: 'Robin',
  placebo: false,
  locked: true,
  hasPasskey: true,
};
let resolve: (value: any) => void;
beforeEach(() => {
  clearProfile();
  replaceProfiles([profile]);
  vi.mocked(unlockProfilePasskey)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
});
async function enter() {
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <ProfileManagement initialOpen />
    </StrictMode>,
  );
  await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
  return { user, ...view };
}
it('automatically starts once in StrictMode and cancels for recovery without accepting late success', async () => {
  const { user } = await enter();
  await waitFor(() => expect(unlockProfilePasskey).toHaveBeenCalledOnce());
  expect(screen.getByRole('heading', { name: 'Open Robin' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Approve in your password manager.');
  expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /^(Use passkey|Try passkey again)$/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open profile' })).not.toBeInTheDocument();
  const signal = vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal;
  await user.click(screen.getByRole('button', { name: 'Use recovery key' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByLabelText('Recovery key')).toHaveFocus();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  await act(async () => resolve({ ...profile, locked: false }));
  expect(currentProfile()).toBeNull();
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Use passkey instead' }));
  expect(unlockProfilePasskey).toHaveBeenCalledTimes(2);
});
it.each([false, undefined])('does not auto-start when capability is %s', async (hasPasskey) => {
  replaceProfiles([{ ...profile, hasPasskey }]);
  const { user } = await enter();
  expect(unlockProfilePasskey).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Recovery key')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Use passkey instead' }));
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
});
it('leaves retry available after failure without looping', async () => {
  vi.mocked(unlockProfilePasskey).mockRejectedValue(new Error('sensitive details'));
  const { user } = await enter();
  expect(await screen.findByRole('alert')).toHaveTextContent('Try again or use your recovery key');
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Try passkey again' }));
  expect(unlockProfilePasskey).toHaveBeenCalledTimes(2);
});
it('aborts on unmount and profile navigation', async () => {
  const { unmount } = await enter();
  const signal = vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal;
  act(() => selectProfile({ id: 'fictional-other', name: 'Other', placebo: false }));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ ...profile, locked: false }));
  expect(currentProfile()?.id).toBe('fictional-other');
  unmount();
});
it('blocks recovery and dismissal during the final authentication save', async () => {
  const { user } = await enter();
  act(() => vi.mocked(unlockProfilePasskey).mock.calls[0][1].onPhase?.('saving'));
  expect(screen.getByRole('button', { name: 'Use recovery key' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Back to profiles' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('heading', { name: 'Open Robin' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Opening profile…');
  expect(vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal.aborted).toBe(false);
});
it('suppresses success after unmount', async () => {
  const { unmount } = await enter();
  const signal = vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ ...profile, locked: false }));
  expect(currentProfile()).toBeNull();
});
it('selects the unlocked profile and closes after successful automatic authentication', async () => {
  const unlocked = { ...profile, locked: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: [unlocked] }))),
  );
  await enter();
  await act(async () => resolve(unlocked));
  expect(currentProfile()?.id).toBe(profile.id);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('dismisses a pending attempt and starts one new attempt on reentry', async () => {
  const { user } = await enter();
  const signal = vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal;
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(signal.aborted).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Profiles' }));
  await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
  expect(unlockProfilePasskey).toHaveBeenCalledTimes(2);
});

it('Back cancels the pending unlock and returns to the profile list', async () => {
  const { user } = await enter();
  const signal = vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal;
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  await act(async () => resolve({ ...profile, locked: false }));
  expect(currentProfile()).toBeNull();
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
});

it('keeps the recovery entry in this dialog when switching methods, then clears it on Back', async () => {
  const { user } = await enter();
  await user.click(screen.getByRole('button', { name: 'Use recovery key' }));
  await user.type(screen.getByLabelText('Recovery key'), 'fictional recovery entry');
  await user.click(screen.getByRole('button', { name: 'Use passkey instead' }));
  expect(unlockProfilePasskey).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText('Recovery key')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Use recovery key' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue('fictional recovery entry');
  expect(screen.getByLabelText('Recovery key')).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
  expect(unlockProfilePasskey).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole('button', { name: 'Use recovery key' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
});
