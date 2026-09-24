import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { PasskeyNameEditor } from '../../app/components/PasskeyNameEditor';
import { NoteDialog } from '../../app/features/notes/NoteDialog';
import { selectProfile } from '../../app/data/profile';
const passkey = {
  id: 'fictional-key',
  rpID: 'localhost',
  createdAt: '2026-09-12T00:00:00Z',
  lastUsedAt: null,
};
const profile = { id: 'p-fictional', name: 'Fictional profile', placebo: true };
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => selectProfile(profile));

it('unnamed and unchanged names cannot save; Enter sends a trimmed name to the explicit profile', async () => {
  const onSaved = vi.fn(),
    onBusyChange = vi.fn();
  const fetch = vi.fn(async () => response({ renamed: true, label: '1Password' }));
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(
    <PasskeyNameEditor
      profileId={profile.id}
      passkey={passkey}
      onSaved={onSaved}
      onCancel={() => {}}
      onBusyChange={onBusyChange}
    />,
  );
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  await user.type(screen.getByLabelText('Passkey name'), '  1Password  {Enter}');
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('1Password'));
  expect(fetch).toHaveBeenCalledWith(
    '/api/profiles/p-fictional/passkeys/rename',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ credentialId: passkey.id, label: '1Password' }),
    }),
  );
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  expect(onBusyChange.mock.invocationCallOrder[1]).toBeLessThan(
    onSaved.mock.invocationCallOrder[0],
  );
});
it('unchanged/empty drafts stay disabled and Cancel/Escape never save or dismiss the parent modal', async () => {
  const onCancel = vi.fn(),
    onOpenChange = vi.fn(),
    onSaved = vi.fn(),
    fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(
    <NoteDialog
      open
      onOpenChange={onOpenChange}
      title="Manage passkeys"
      description="Fictional profile"
    >
      <PasskeyNameEditor
        profileId={profile.id}
        passkey={{ ...passkey, label: 'Hardware key' }}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </NoteDialog>,
  );
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  await user.clear(screen.getByLabelText('Passkey name'));
  await user.type(screen.getByLabelText('Passkey name'), '   ');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onOpenChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});
it('pending save blocks duplicate submission and cancellation; errors retain the draft for retry', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const onCancel = vi.fn(),
    onSaved = vi.fn(),
    onBusyChange = vi.fn(),
    user = userEvent.setup();
  render(
    <PasskeyNameEditor
      profileId={profile.id}
      passkey={passkey}
      onSaved={onSaved}
      onCancel={onCancel}
      onBusyChange={onBusyChange}
    />,
  );
  await user.type(screen.getByLabelText('Passkey name'), 'Hardware key{Enter}');
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('form', { name: 'Name passkey' }));
  fireEvent.keyDown(screen.getByRole('form', { name: 'Name passkey' }), { key: 'Escape' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  await act(async () => resolve(response({ message: 'Fictional save failed' }, 500)));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional save failed');
  expect(screen.getByLabelText('Passkey name')).toHaveValue('Hardware key');
  expect(screen.getByRole('button', { name: 'Save name' })).toBeEnabled();
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  expect(onSaved).not.toHaveBeenCalled();
});
it.each(['unmount', 'profile switch'] as const)(
  'ignores late rename callbacks after %s',
  async (boundary) => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const onSaved = vi.fn(),
      onBusyChange = vi.fn(),
      user = userEvent.setup();
    const mounted = render(
      <PasskeyNameEditor
        profileId={profile.id}
        passkey={passkey}
        onSaved={onSaved}
        onCancel={() => {}}
        onBusyChange={onBusyChange}
      />,
    );
    await user.type(screen.getByLabelText('Passkey name'), '1Password{Enter}');
    if (boundary === 'unmount') mounted.unmount();
    else
      act(() =>
        selectProfile({ id: 'p-other-fictional', name: 'Other fictional profile', placebo: true }),
      );
    await act(async () => resolve(response({ renamed: true, label: '1Password' })));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onBusyChange.mock.calls).toEqual([[true]]);
  },
);
