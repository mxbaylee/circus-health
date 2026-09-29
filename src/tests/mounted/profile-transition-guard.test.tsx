import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { ProfileManagement } from '../../app/components/ProfileManagement';
import {
  clearProfile,
  currentProfile,
  replaceProfiles,
  selectProfile,
  useProfile,
} from '../../app/data/profile';
import { unlockProfilePasskey } from '../../app/components/passkey-unlock';
import type { Note } from '../../shared/api';

vi.mock('../../app/components/ProfileStorage', () => ({
  ArchiveStorageSummary: () => null,
  ProfileStorage: () => null,
}));
vi.mock('../../app/components/passkey-unlock', () => ({
  unlockProfilePasskey: vi.fn(),
  PasskeyUnlockError: class extends Error {},
}));
vi.mock('../../app/features/notes/NoteText', () => ({
  NoteText: ({ label, value, onChange }: any) => (
    <label>
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value, 'markdown-v1')} />
    </label>
  ),
}));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({
  AttachmentPanel: ({ onBusyChange }: any) => (
    <button onClick={() => onBusyChange(true)}>Fictional pending attachment</button>
  ),
}));
const first = { id: 'fictional-first', name: 'Robin', placebo: true, locked: false };
const second = {
  id: 'fictional-second',
  name: 'Casey',
  placebo: true,
  locked: true,
  hasPasskey: false,
};
const original: Note = {
  id: 'note:fictional-first',
  kind: 'note',
  status: 'editable',
  title: 'Fictional note',
  content: 'Accepted text',
  topics: '',
  rawThoughts: '',
  typeLabel: null,
  eventDate: null,
  person: {},
  personId: null,
  pinned: false,
  archived: false,
  createdAt: '',
  updatedAt: '',
  finishedAt: null,
  version: 1,
  sourceRecordId: null,
  links: [],
  backlinks: [],
  attachments: [],
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const guard = () => screen.getByRole('dialog', { name: 'Save changes before continuing?' });
let requests: string[],
  failSave: boolean,
  failUnlock: boolean,
  notes: Map<string, Note>,
  cards: (typeof first | typeof second)[],
  fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  clearProfile();
  cards = [first, second];
  replaceProfiles(cards);
  selectProfile(first);
  notes = new Map([
    [original.id, original],
    [
      'note:fictional-linked',
      { ...original, id: 'note:fictional-linked', title: 'Fictional linked note' },
    ],
  ]);
  requests = [];
  failSave = true;
  failUnlock = false;
  vi.mocked(unlockProfilePasskey)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    requests.push(`${init.method || 'GET'} ${url}`);
    if (url === '/api/profiles') return response(cards);
    if (url.endsWith('/lock')) {
      cards = cards.map((card) => (card.id === first.id ? { ...card, locked: true } : card));
      return response({ ...first, locked: true });
    }
    if (url.endsWith('/unlock')) {
      if (failUnlock) return response({ message: 'Fictional wrong recovery' }, 400);
      cards = [
        { ...first, locked: true },
        { ...second, locked: false },
      ];
      return response({ ...second, locked: false });
    }
    if (url === '/api/profile-setups')
      return response({
        setupId: 'fictional-setup',
        profileId: second.id,
        recoveryKit: {
          format: 'circus-health-recovery-v1',
          profileId: second.id,
          phrase: 'fictional recovery',
        },
      });
    if (url === '/api/profile-setups/resume')
      return response({ active: true, profileId: second.id });
    if (url.endsWith('/verify')) {
      cards = [
        { ...first, locked: true },
        { ...second, locked: false },
      ];
      return response({ ...second, locked: false });
    }
    if (url.includes('/notes/note')) {
      const id = decodeURIComponent(url.split('/').at(-1)!);
      if (init.method === 'PUT') {
        if (failSave)
          return response({ message: 'Fictional save unavailable', code: 'BACKUP_FAILED' }, 503);
        const note = {
          ...notes.get(id)!,
          ...JSON.parse(String(init.body)),
          version: notes.get(id)!.version + 1,
        };
        notes.set(id, note);
        return response(note);
      }
      return response(notes.get(id));
    }
    if (url.includes('/visibility/'))
      return response({ archived: false, version: 0, protected: false });
    return response([]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
function mount(two = false) {
  function Page() {
    const profile = useProfile();
    return (
      <div key={profile?.id || 'locked'}>
        <ProfileManagement />
        {profile?.id === first.id && (
          <>
            <NoteEditor
              initial={original}
              initialKind="note"
              types={[]}
              creationId={original.id}
              onSaved={() => {}}
              onRefresh={() => {}}
              prelinkType={null}
              prelinkId={null}
            />
            {two && (
              <NoteEditor
                initial={notes.get('note:fictional-linked')!}
                initialKind="note"
                types={[]}
                creationId="note:fictional-linked"
                onSaved={() => {}}
                onRefresh={() => {}}
                prelinkType={null}
                prelinkId={null}
              />
            )}
          </>
        )}
      </div>
    );
  }
  const router = createMemoryRouter([{ path: '*', element: <Page /> }], {
    initialEntries: ['/notes?id=fictional'],
  });
  return render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
async function dirtyAndOpen(two = false) {
  mount(two);
  const fields = screen.getAllByLabelText('Content');
  fields.forEach((field, index) =>
    fireEvent.change(field, { target: { value: `Unsaved fictional edit ${index}` } }),
  );
  // Force the failure now, instead of depending on the autosave timer.
  for (const button of screen.getAllByRole('button', { name: 'Save now' })) fireEvent.click(button);
  await waitFor(() => expect(screen.getAllByText(/Couldn’t save:/)).toHaveLength(two ? 2 : 1));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: first.name }));
  return { user, fields };
}
async function chooseLock(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Lock profile' }));
  expect(guard()).toBeVisible();
}
it('Back preserves the original editor and action screen; a failed save never calls lock', async () => {
  const { user, fields } = await dirtyAndOpen();
  await chooseLock(user);
  expect(requests.some((request) => request.endsWith('/lock'))).toBe(false);
  await user.click(within(guard()).getByRole('button', { name: 'Save and continue' }));
  expect(await within(guard()).findByRole('alert')).toHaveTextContent('Fictional save unavailable');
  expect(currentProfile()?.id).toBe(first.id);
  expect(requests.some((request) => request.endsWith('/lock'))).toBe(false);
  await user.click(within(guard()).getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('button', { name: 'Lock profile' })).toBeVisible();
  expect(fields[0].isConnected).toBe(true);
  expect(fields[0]).toHaveValue('Unsaved fictional edit 0');
});
it('saves every mounted editor before a single lock, including the linked column', async () => {
  const { user } = await dirtyAndOpen(true);
  await chooseLock(user);
  failSave = false;
  const save = within(guard()).getByRole('button', { name: 'Save and continue' });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(currentProfile()).toBeNull());
  expect([...notes.values()].map((note) => note.content)).toEqual([
    'Unsaved fictional edit 0',
    'Unsaved fictional edit 1',
  ]);
  expect(requests.filter((request) => request.endsWith('/lock'))).toHaveLength(1);
  const lockIndex = requests.findIndex((request) => request.endsWith('/lock'));
  expect(requests.slice(lockIndex + 1).some((request) => request.startsWith('PUT'))).toBe(false);
});
it('explicit discard locks without retrying unsaved text or changing accepted versions', async () => {
  const { user } = await dirtyAndOpen();
  await chooseLock(user);
  const puts = requests.filter((request) => request.startsWith('PUT')).length;
  await user.click(within(guard()).getByRole('button', { name: 'Discard and continue' }));
  await waitFor(() => expect(currentProfile()).toBeNull());
  expect(requests.filter((request) => request.startsWith('PUT'))).toHaveLength(puts);
  expect(notes.get(original.id)).toEqual(original);
});
it('a failed recovery action after discard retains the same draft and can retry its writer', async () => {
  const { user, fields } = await dirtyAndOpen();
  failUnlock = true;
  await user.click(screen.getByRole('button', { name: /CaseyLocked/ }));
  await user.type(screen.getByLabelText('Recovery key'), 'wrong fictional key');
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  await user.click(within(guard()).getByRole('button', { name: 'Discard and continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional wrong recovery');
  expect(currentProfile()?.id).toBe(first.id);
  expect(fields[0].isConnected).toBe(true);
  expect(fields[0]).toHaveValue('Unsaved fictional edit 0');
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  failSave = false;
  await user.click(screen.getByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(notes.get(original.id)?.content).toBe('Unsaved fictional edit 0'));
});
it('blocks transition on pending attachment associations, even with no text changes', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Fictional pending attachment' }));
  await user.click(screen.getByRole('button', { name: first.name }));
  await chooseLock(user);
  await user.click(within(guard()).getByRole('button', { name: 'Save and continue' }));
  expect(await within(guard()).findByRole('alert')).toHaveTextContent(
    'Finish or remove pending attachment links',
  );
  expect(requests.some((request) => request.endsWith('/lock'))).toBe(false);
});
it('waits for an existing save before locking and does not send the accepted request twice', async () => {
  mount();
  const user = userEvent.setup();
  failSave = false;
  let finish!: () => void;
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === 'PUT')
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return originalFetch(input, init);
  });
  fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Fictional in flight' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
  await waitFor(() => expect(finish).toBeDefined());
  await user.click(screen.getByRole('button', { name: first.name }));
  await chooseLock(user);
  await user.click(within(guard()).getByRole('button', { name: 'Save and continue' }));
  expect(requests.some((request) => request.endsWith('/lock'))).toBe(false);
  await act(async () => finish());
  await waitFor(() => expect(currentProfile()).toBeNull());
  expect(requests.filter((request) => request.startsWith('PUT'))).toHaveLength(1);
});
it('defers the automatic passkey attempt until consent; Back does not start it again', async () => {
  cards = [first, { ...second, hasPasskey: true }];
  replaceProfiles(cards);
  const { user, fields } = await dirtyAndOpen();
  await user.click(screen.getByRole('button', { name: /CaseyLocked/ }));
  expect(guard()).toBeVisible();
  expect(unlockProfilePasskey).not.toHaveBeenCalled();
  await user.click(within(guard()).getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('heading', { name: 'Open Casey' })).toBeVisible();
  expect(fields[0].isConnected).toBe(true);
  expect(unlockProfilePasskey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Use passkey' }));
  await user.click(within(guard()).getByRole('button', { name: 'Discard and continue' }));
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Use recovery key' }));
  expect(vi.mocked(unlockProfilePasskey).mock.calls[0][1].signal.aborted).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Use passkey instead' }));
  expect(guard()).toBeVisible();
  expect(unlockProfilePasskey).toHaveBeenCalledOnce();
});
it.each(['new', 'copy', 'resume', 'unlocked'])(
  'guards %s activation before its lifecycle request or selection',
  async (kind) => {
    if (kind === 'unlocked') {
      cards = [first, { ...second, locked: false }];
      replaceProfiles(cards);
    }
    const { user } = await dirtyAndOpen();
    let lifecycle = '/verify';
    if (kind === 'resume') {
      lifecycle = '/unlock';
      await user.upload(
        screen.getByLabelText('Resume with recovery file'),
        new File(
          [
            JSON.stringify({
              format: 'circus-health-recovery-v1',
              profileId: second.id,
              phrase: 'fictional recovery',
            }),
          ],
          'fictional.json',
          { type: 'application/json' },
        ),
      );
    } else if (kind === 'unlocked') {
      await user.click(screen.getByRole('button', { name: /CaseyPlacebo account/ }));
    } else {
      if (kind === 'copy') {
        await user.click(screen.getByText('Danger Zone', { selector: 'summary' }));
        await user.click(screen.getByRole('button', { name: 'Copy profile' }));
      } else {
        await user.click(screen.getByRole('button', { name: 'Create profile' }));
        await user.type(screen.getByLabelText('Display name'), 'Fictional new profile');
        await user.type(screen.getByLabelText('Your name'), 'Fictional Casey Example');
        fireEvent.change(screen.getByLabelText('Date of birth'), {
          target: { value: '1982-04-17' },
        });
      }
      await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
      await user.click(screen.getByLabelText('I have saved my recovery key'));
      await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
      await user.type(screen.getByLabelText('Recovery key'), 'fictional recovery');
      await user.click(screen.getByRole('button', { name: 'Open profile' }));
    }
    expect(guard()).toBeVisible();
    expect(currentProfile()?.id).toBe(first.id);
    expect(requests.some((request) => request.endsWith(lifecycle))).toBe(false);
    await user.click(within(guard()).getByRole('button', { name: 'Save and continue' }));
    expect(await within(guard()).findByRole('alert')).toHaveTextContent(
      'Fictional save unavailable',
    );
    expect(currentProfile()?.id).toBe(first.id);
    expect(requests.some((request) => request.endsWith(lifecycle))).toBe(false);
  },
);
it('a forced profile clear removes the confirmation and suppresses an in-flight save result', async () => {
  const { user } = await dirtyAndOpen();
  await chooseLock(user);
  let finish!: () => void;
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === 'PUT')
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return originalFetch(input, init);
  });
  failSave = false;
  await user.click(within(guard()).getByRole('button', { name: 'Save and continue' }));
  await waitFor(() => expect(finish).toBeDefined());
  act(() => clearProfile());
  expect(
    screen.queryByRole('dialog', { name: 'Save changes before continuing?' }),
  ).not.toBeInTheDocument();
  await act(async () => finish());
  expect(currentProfile()).toBeNull();
  expect(requests.some((request) => request.endsWith('/lock'))).toBe(false);
});

it.each(['invalid', 'unfinished'])(
  'does not request transition consent for a %s recovery file',
  async (kind) => {
    const { user, fields } = await dirtyAndOpen();
    if (kind === 'unfinished') {
      const originalFetch = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) =>
        String(input) === '/api/profile-setups/resume'
          ? response({
              active: false,
              profileId: second.id,
              setupId: 'fictional-setup',
              name: 'Fictional resumed setup',
            })
          : originalFetch(input, init),
      );
    }
    const contents =
      kind === 'invalid'
        ? 'not a recovery file'
        : JSON.stringify({
            format: 'circus-health-recovery-v1',
            profileId: second.id,
            phrase: 'fictional recovery',
          });
    await user.upload(
      screen.getByLabelText('Resume with recovery file'),
      new File([contents], 'fictional.json', { type: 'application/json' }),
    );
    if (kind === 'invalid')
      expect(await screen.findByRole('alert')).toHaveTextContent('could not resume setup');
    else
      expect(await screen.findByRole('heading', { name: 'Save your recovery key' })).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: 'Save changes before continuing?' }),
    ).not.toBeInTheDocument();
    expect(currentProfile()?.id).toBe(first.id);
    expect(fields[0].isConnected).toBe(true);
    expect(fields[0]).toHaveValue('Unsaved fictional edit 0');
    expect(requests.some((request) => request.endsWith('/unlock'))).toBe(false);
  },
);

it('ignores resume metadata delivered after its originating profile is cleared', async () => {
  const { user } = await dirtyAndOpen();
  let finish!: (value: Response) => void;
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) =>
    String(input) === '/api/profile-setups/resume'
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : originalFetch(input, init),
  );
  await user.upload(
    screen.getByLabelText('Resume with recovery file'),
    new File(
      [
        JSON.stringify({
          format: 'circus-health-recovery-v1',
          profileId: second.id,
          phrase: 'fictional recovery',
        }),
      ],
      'fictional.json',
      { type: 'application/json' },
    ),
  );
  await waitFor(() => expect(finish).toBeDefined());
  act(() => clearProfile());
  await act(async () => finish(response({ active: true, profileId: second.id })));
  expect(currentProfile()).toBeNull();
  expect(requests.some((request) => request.endsWith('/unlock'))).toBe(false);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
