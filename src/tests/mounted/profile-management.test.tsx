import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProfileProvider } from '../../app/components/ProfileProvider';
import { ProfileManagement } from '../../app/components/ProfileManagement';
import {
  clearProfile,
  recordProfile,
  replaceProfiles,
  selectProfile,
} from '../../app/data/profile';
import {
  enrollProfilePasskey,
  PasskeyEnrollmentError,
} from '../../app/components/passkey-enrollment';
import { notifySuccess } from '../../app/components/Toasts';
import type { Note } from '../../shared/api';

vi.mock('../../app/components/passkey-enrollment', () => ({
  enrollProfilePasskey: vi.fn(),
  PasskeyEnrollmentError: class extends Error {},
}));
vi.mock('../../app/components/Toasts', () => ({ notifySuccess: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));
vi.mock('../../app/components/ProfileStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/components/ProfileStorage')>()),
  ArchiveStorageSummary: () => null,
}));

const profile = {
  id: 'p-one',
  name: 'Robin',
  icon: 'person',
  placebo: false,
  nameVersion: 1,
  version: 1,
  locked: true,
  storageBytes: 1_200_000,
};
const kit = {
  format: 'circus-health-recovery-v1' as const,
  profileId: 'p-one',
  phrase: 'correct phrase',
};
const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const recoveryFile = () =>
  new File([JSON.stringify(kit)], 'recovery.json', { type: 'application/json' });
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const selfNote = (
  onboarding: Note['person']['onboarding'] = {
    completedSteps: [],
    skippedSteps: [],
    finished: false,
  },
): Note => ({
  id: 'person-note:self',
  kind: 'person',
  isSelf: true,
  status: 'editable',
  title: 'Robin',
  content: '',
  typeLabel: null,
  eventDate: null,
  topics: '',
  rawThoughts: '',
  personId: 'patient',
  person: { name: 'Robin', onboarding },
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
});

beforeEach(() => {
  vi.mocked(enrollProfilePasskey)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  clearProfile();
  replaceProfiles([]);
  replaceProfiles([profile]);
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles' && !init?.method) return envelope([profile]);
    if (url === '/api/profile-setups')
      return envelope({ setupId: 's1', profileId: 'p-one', recoveryKit: kit });
    if (url === '/api/profile-setups/resume')
      return envelope({ setupId: 's1', profileId: 'p-one', name: 'Resumed Robin', active: false });
    if (url === '/api/profile-setups/s1/verify')
      return JSON.parse(String(init!.body)).recovery === kit.phrase
        ? envelope({ ...profile, locked: false })
        : envelope({ message: 'Wrong recovery' }, 400);
    if (url === '/api/profiles/p-one/unlock')
      return JSON.parse(String(init!.body)).recovery === kit.phrase
        ? envelope({ ...profile, locked: false })
        : envelope({ message: 'Wrong recovery' }, 400);
    if (url === '/api/profiles/p-one/notes/patient' && !init?.method) return envelope(selfNote());
    if (url === '/api/profiles/p-one/lock') return envelope({ ...profile, locked: true });
    if (url === '/api/profiles/p-one' && init?.method === 'DELETE') return envelope({});
    return envelope({ message: `Unexpected request: ${url}` }, 400);
  });
  vi.stubGlobal('fetch', fetchMock);
});

it('requires saved-key acknowledgement, then opens a separate empty login form', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/profile-setups',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(screen.getByRole('button', { name: 'Verify recovery key' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Open profile' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add passkey' })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
  expect(screen.getByLabelText('Username')).toHaveValue('Robin');
  expect(screen.getByLabelText('Recovery key')).toBeRequired();
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profile-setups/s1/verify')).toBe(false);
  await user.type(screen.getByLabelText('Recovery key'), 'wrong');
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong recovery');
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/profile-setups/s1/verify',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('does not select a locked profile and surfaces a wrong recovery error', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
  expect(screen.getByLabelText('Recovery key')).toBeRequired();
  await user.type(screen.getByLabelText('Recovery key'), 'wrong');
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Wrong recovery');
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
});

it('shows the cartwheel while opening a profile with its recovery key', async () => {
  let finishUnlock!: (response: Response) => void;
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/profiles/p-one/unlock')
      return new Promise<Response>((resolve) => {
        finishUnlock = resolve;
      });
    return envelope({ message: `Unexpected request: ${url}` }, 400);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
  await user.type(screen.getByLabelText('Recovery key'), kit.phrase);
  await user.click(screen.getByRole('button', { name: 'Open profile' }));

  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Opening profile…');
  expect(status.querySelector('.moxie-jester-alternative')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('button', { name: 'Open profile' })).toBeDisabled();

  await act(async () => finishUnlock(envelope({ ...profile, locked: false })));
});

it('resumes an incomplete setup at recovery acknowledgement, without bypassing verification', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.upload(screen.getByLabelText('Resume with recovery file'), recoveryFile());
  expect(await screen.findByRole('button', { name: 'Verify recovery key' })).toBeDisabled();
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
  expect(screen.getByLabelText('Username')).toHaveValue('Resumed Robin');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/profile-setups/resume',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('rejects a recovery verification file for another profile before activation', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  await user.upload(screen.getByLabelText('Verify with recovery file'), recoveryFile());
  expect(screen.getByLabelText('Recovery key')).toHaveValue(kit.phrase);
  await user.upload(
    screen.getByLabelText('Verify with recovery file'),
    new File([JSON.stringify({ ...kit, profileId: 'p-other' })], 'other.json', {
      type: 'application/json',
    }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('different profile');
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profile-setups/s1/verify')).toBe(false);
});

it('offers a passkey after ordinary recovery unlock without re-verifying setup', async () => {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profile-setups/resume')
      return envelope({ setupId: 's1', profileId: 'p-one', active: true });
    if (url === '/api/profiles/p-one/unlock') return envelope({ ...profile, locked: false });
    if (url === '/api/profiles' && !init?.method) return envelope([{ ...profile, locked: false }]);
    return envelope({ message: 'Unexpected request' }, 400);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.upload(screen.getByLabelText('Resume with recovery file'), recoveryFile());
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profiles/p-one/unlock',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  expect(await screen.findByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profile-setups/s1/verify')).toBe(false);
});

it('keeps the new-profile passkey choice through selection and continues to onboarding when skipped', async () => {
  const unlocked = { ...profile, locked: false };
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profile-setups')
      return envelope({ setupId: 's1', profileId: 'p-one', recoveryKit: kit });
    if (url === '/api/profile-setups/s1/verify') return envelope(unlocked);
    if (url === '/api/profiles' && !init?.method) return envelope([unlocked]);
    if (url === '/api/profiles/p-one/notes/patient') return envelope(selfNote());
    if (url === '/api/profiles/p-one/notes/person-note%3Aself' && init?.method === 'PUT')
      return envelope(selfNote());
    return envelope({ message: 'Unexpected request' }, 400);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  await user.type(screen.getByLabelText('Recovery key'), kit.phrase);
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(await screen.findByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
  expect(enrollProfilePasskey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  expect(await screen.findByRole('heading', { name: 'A little about you' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  expect(await screen.findByRole('heading', { name: 'Primary care provider' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  expect(await screen.findByRole('heading', { name: 'Emergency contact' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Robin' }));
  await user.click(screen.getByRole('button', { name: 'Add passkey' }));
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('reports server rejection and malformed recovery files without opening setup', async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url === '/api/profile-setups/resume'
      ? envelope({ message: 'Recovery unavailable' }, 400)
      : envelope([profile]),
  );
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.upload(screen.getByLabelText('Resume with recovery file'), recoveryFile());
  expect(await screen.findByRole('alert')).toHaveTextContent(/recovery file/i);
  await user.upload(
    screen.getByLabelText('Resume with recovery file'),
    new File(['not json'], 'broken.json', { type: 'application/json' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(/recovery file/i);
});

it('copies and deletes only after the profile name is confirmed', async () => {
  const unlocked = { ...profile, locked: false };
  replaceProfiles([unlocked]);
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles' && !init?.method) return envelope([unlocked]);
    if (url === '/api/profile-setups')
      return envelope({ setupId: 's2', profileId: 'p-two', recoveryKit: kit });
    if (url === '/api/profiles/p-one' && init?.method === 'DELETE') return envelope({});
    return envelope({ message: 'Unexpected request' }, 400);
  });
  const user = userEvent.setup();
  const first = render(<ProfileManagement initialOpen />);
  expect(
    screen.getByText('Danger Zone', { selector: 'summary' }).parentElement,
  ).not.toHaveAttribute('open');
  await user.click(screen.getByText('Danger Zone', { selector: 'summary' }));
  expect(screen.getByRole('button', { name: 'Copy profile' })).not.toHaveClass(
    'profile-action-delete',
  );
  expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveClass(
    'profile-action-delete',
  );
  expect(screen.getByRole('button', { name: 'Delete profile' }).parentElement).toBe(
    screen.getByRole('button', { name: 'Copy profile' }).parentElement,
  );
  await user.click(screen.getByRole('button', { name: 'Copy profile' }));
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  const copyRequest = fetchMock.mock.calls.find(([url]) => url === '/api/profile-setups');
  expect(JSON.parse(String(copyRequest?.[1]?.body))).toMatchObject({
    copyFrom: 'p-one',
    name: 'Robin copy',
  });
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  expect(screen.getByLabelText('Username')).toHaveValue('Robin copy');
  first.unmount();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByText('Danger Zone', { selector: 'summary' }));
  await user.click(screen.getByRole('button', { name: 'Delete profile' }));
  expect(screen.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
  await user.type(screen.getByLabelText('Profile name'), 'Robin');
  await user.click(screen.getByRole('button', { name: 'Delete profile' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profiles/p-one',
      expect.objectContaining({ method: 'DELETE' }),
    ),
  );
});

it('saves About you fields as a versioned Self note and records progress', async () => {
  const unlocked = { ...profile, locked: false };
  const current = selfNote();
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles/p-one/notes/patient' && !init?.method) return envelope(current);
    if (url === '/api/profiles/p-one/notes/person-note%3Aself' && init?.method === 'PUT')
      return envelope({
        ...current,
        version: 2,
        person: JSON.parse(String(init!.body)).person,
        title: JSON.parse(String(init!.body)).title,
      });
    return envelope([unlocked]);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  await user.clear(await screen.findByLabelText('Display name'));
  await user.type(screen.getByLabelText('Display name'), 'Robin Example');
  await user.type(screen.getByLabelText('Pronouns'), 'they/them');
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profiles/p-one/notes/person-note%3Aself',
      expect.objectContaining({ method: 'PUT' }),
    ),
  );
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('person-note%3Aself') && init?.method === 'PUT',
  );
  expect(JSON.parse(String(put?.[1]?.body)).person).toMatchObject({
    name: 'Robin Example',
    pronouns: 'they/them',
    onboarding: { completedSteps: ['about-you'], skippedSteps: [] },
  });
  expect(screen.getByRole('heading', { name: 'Primary care provider' })).toBeVisible();
});

it('resumes at unfinished care after a skipped Self step without touching medications', async () => {
  const unlocked = { ...profile, locked: false };
  const current = selfNote({ completedSteps: [], skippedSteps: ['about-you'], finished: false });
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles/p-one/notes/patient' && !init?.method) return envelope(current);
    return envelope([unlocked]);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  expect(await screen.findByRole('heading', { name: 'Primary care provider' })).toBeVisible();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/medications'))).toBe(false);
});

it('persists care contact ids before creating normal People notes', async () => {
  const unlocked = { ...profile, locked: false };
  const current = selfNote({ completedSteps: ['about-you'], skippedSteps: [], finished: false });
  let version = 1;
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles/p-one/notes/patient' && !init?.method) return envelope(current);
    if (url === '/api/profiles/p-one/notes/person-note%3Aself' && init?.method === 'PUT')
      return envelope({
        ...current,
        version: ++version,
        person: JSON.parse(String(init!.body)).person,
      });
    if (url === '/api/profiles/p-one/notes' && init?.method === 'POST')
      return envelope({ ...selfNote(), ...JSON.parse(String(init!.body)), isSelf: false });
    if (url.includes('/notes/') && !init?.method)
      return envelope({ message: 'Not found', code: 'NOT_FOUND' }, 404);
    return envelope([unlocked]);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  await user.type(await screen.findByLabelText('Primary care provider'), 'Dr. Rivera');
  expect(screen.queryByLabelText('Scheduling URL')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await user.type(await screen.findByLabelText('Emergency contact'), 'Avery Example');
  await user.click(screen.getByRole('button', { name: 'Finish setup' }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/profiles/p-one/notes' && init?.method === 'POST',
      ),
    ).toHaveLength(2),
  );
  const selfWrites = fetchMock.mock.calls.filter(
    ([url, init]) => url.endsWith('person-note%3Aself') && init?.method === 'PUT',
  );
  expect(JSON.parse(String(selfWrites[0][1]?.body)).person.onboarding.careTeam).toMatchObject({
    primaryCareId: expect.any(String),
  });
});

it('opens three-step onboarding after recovery activation remounts the real ProfileProvider tree', async () => {
  let activated = false;
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles' && !init?.method)
      return envelope([{ ...profile, locked: !activated }]);
    if (url === '/api/profile-setups/s1/verify') {
      activated = true;
      return envelope({ ...profile, locked: false });
    }
    if (url === '/api/profiles/p-one/notes/patient') return envelope(selfNote());
    return original(url, init);
  });
  const user = userEvent.setup();
  render(
    <ProfileProvider>
      <ProfileManagement />
    </ProfileProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Choose profile' }));
  await user.click(await screen.findByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  await user.type(screen.getByLabelText('Recovery key'), kit.phrase);
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  await user.click(await screen.findByRole('button', { name: 'Skip' }));
  expect(await screen.findByRole('heading', { name: 'About you' })).toBeVisible();
  expect(screen.getByLabelText('Display name')).toHaveValue('Robin');
  expect(document.querySelector('.profile-root')).not.toBeNull();
});

it('resumes another profile through the real keyed tree without inheriting contact fields', async () => {
  const other = { ...profile, id: 'p-two', name: 'Another profile', locked: false };
  const one = { ...profile, locked: false };
  selectProfile(one);
  replaceProfiles([one, other]);
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/profiles') return envelope([one, other]);
    if (url === '/api/profiles/p-one/notes/patient') return envelope(selfNote());
    if (url === '/api/profiles/p-two/notes/patient')
      return envelope({
        ...selfNote({ completedSteps: ['about-you'], skippedSteps: [], finished: false }),
        title: 'Another profile',
        person: {
          name: 'Another profile',
          onboarding: { completedSteps: ['about-you'], skippedSteps: [], finished: false },
        },
      });
    throw Error('Unexpected ' + url);
  });
  const user = userEvent.setup();
  render(
    <ProfileProvider>
      <ProfileManagement initialOpen />
    </ProfileProvider>,
  );
  await user.click(screen.getByRole('button', { name: /^Another profile\s*Private profile/ }));
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  expect(await screen.findByRole('heading', { name: 'Primary care provider' })).toBeVisible();
  expect(screen.getByLabelText('Primary care provider')).toHaveValue('');
  expect(screen.queryByLabelText('Emergency contact')).not.toBeInTheDocument();
});

function careBackend({
  conflict = false,
  uncertain = false,
}: { conflict?: boolean; uncertain?: boolean } = {}) {
  const unlocked = { ...profile, locked: false };
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  let current = selfNote({
    completedSteps: ['about-you'],
    skippedSteps: [],
    finished: false,
    careTeam: {
      primaryCareId: 'care-primary',
      emergencyContactId: 'note:22222222-2222-4222-8222-222222222222',
    },
  });
  let primary: Note = {
    ...selfNote(),
    id: 'care-primary',
    isSelf: false,
    personId: 'primary-person',
    title: 'Dr. Rivera',
    content: 'Keep this clinical note',
    topics: 'Keep topics',
    rawThoughts: 'Keep private thoughts',
    pinned: true,
    version: 7,
    person: {
      name: 'Dr. Rivera',
      phone: '555-0101',
      tags: ['Specialist'],
      schedulingUrl: 'https://old.example.test',
      custom: { retained: true },
    },
    links: [
      { targetType: 'note', targetId: 'other-note', relation: 'references' },
    ] as Note['links'],
  };
  let emergency: Note | null = null,
    fail = true;
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles') return envelope([unlocked]);
    if (url.endsWith('/notes/patient')) return envelope(current);
    if (url.endsWith('/notes/person-note%3Aself') && init?.method === 'PUT') {
      const input = JSON.parse(String(init!.body));
      if (input.version !== current.version)
        return envelope({ message: 'Stale Self', code: 'VERSION_CONFLICT' }, 409);
      current = { ...current, ...input, version: current.version + 1 };
      return envelope(current);
    }
    if (url.endsWith('/notes/care-primary')) {
      if (init?.method === 'PUT') {
        const input = JSON.parse(String(init!.body));
        if (conflict)
          return envelope(
            { message: 'Contact changed; resume setup to reload', code: 'VERSION_CONFLICT' },
            409,
          );
        expect(input.version).toBe(7);
        primary = { ...primary, ...input, version: 8 };
      }
      return envelope(primary);
    }
    if (url.endsWith('/notes/note%3A22222222-2222-4222-8222-222222222222'))
      return emergency
        ? envelope(emergency)
        : envelope({ message: 'Not found', code: 'NOT_FOUND' }, 404);
    if (url === '/api/profiles/p-one/notes' && init?.method === 'POST') {
      if (fail) {
        fail = false;
        if (uncertain) {
          const input = JSON.parse(String(init!.body));
          emergency = {
            ...selfNote(),
            ...input,
            isSelf: false,
            content: 'Saved contact notes',
            person: { ...input.person, phone: '555-0199' },
          };
        }
        return envelope({ message: 'Temporary save failure', code: 'SAVE_FAILED' }, 503);
      }
      emergency = { ...selfNote(), ...JSON.parse(String(init!.body)), isSelf: false };
      return envelope(emergency);
    }
    throw Error('Unexpected ' + url);
  });
  return {
    get primary() {
      return primary;
    },
    get current() {
      return current;
    },
    get emergency() {
      return emergency;
    },
  };
}
it.each([false, true])(
  'hydrates contacts and retries without duplicates or lost metadata (uncertain create: %s)',
  async (uncertain) => {
    const state = careBackend({ uncertain });
    const user = userEvent.setup();
    render(<ProfileManagement initialOpen />);
    await user.click(
      within(await screen.findByRole('group', { name: 'Actions for Robin' })).getByRole('button', {
        name: 'Resume setup',
      }),
    );
    expect(await screen.findByLabelText('Primary care provider')).toHaveValue('Dr. Rivera');
    expect(screen.getByLabelText('Primary care provider phone')).toHaveValue('555-0101');
    expect(screen.queryByLabelText('Scheduling URL')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await user.type(await screen.findByLabelText('Emergency contact'), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary save failure');
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/notes/note%3A22222222-2222-4222-8222-222222222222') &&
          init?.method === 'PUT',
      ),
    ).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.primary).toMatchObject({
      content: 'Keep this clinical note',
      topics: 'Keep topics',
      rawThoughts: 'Keep private thoughts',
      pinned: true,
      person: {
        phone: '555-0101',
        custom: { retained: true },
        schedulingUrl: 'https://old.example.test',
        tags: ['Primary Care Provider', 'specialist'],
      },
    });
    expect(state.primary.links).toEqual([
      { targetType: 'note', targetId: 'other-note', relation: 'references' },
    ]);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/notes/care-primary') && init?.method === 'PUT',
      ),
    ).toHaveLength(1);
    const posts = fetchMock.mock.calls.filter(
      ([url, init]) => url === '/api/profiles/p-one/notes' && init?.method === 'POST',
    );
    expect(posts).toHaveLength(uncertain ? 1 : 2);
    expect(
      posts.every(
        ([, init]) =>
          JSON.parse(String(init!.body)).id === 'note:22222222-2222-4222-8222-222222222222',
      ),
    ).toBe(true);
    if (uncertain)
      expect(state.emergency).toMatchObject({
        content: 'Saved contact notes',
        person: { phone: '555-0199' },
      });
    expect(state.current.person.onboarding?.completedSteps).toEqual(
      expect.arrayContaining(['primary-care', 'emergency-contact']),
    );
  },
);
it('saves a care phone edit on its existing contact and requires a name for a phone-only contact', async () => {
  const state = careBackend();
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  const primaryPhone = await screen.findByLabelText('Primary care provider phone');
  await user.clear(primaryPhone);
  await user.type(primaryPhone, '555-0142');
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await user.type(await screen.findByLabelText('Emergency contact phone'), '555-0186');
  await user.click(screen.getByRole('button', { name: 'Finish setup' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter the emergency contact’s name');
  expect(state.primary.version).toBe(8);
  expect(state.emergency).toBeNull();
  await user.clear(screen.getByLabelText('Emergency contact phone'));
  await user.click(screen.getByRole('button', { name: 'Finish setup' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(state.primary.person.phone).toBe('555-0142');
  expect(state.primary.personId).toBe('primary-person');
  expect(state.primary.content).toBe('Keep this clinical note');
  expect(state.emergency).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('surfaces stale contact revisions without retrying against a newer version', async () => {
  const state = careBackend({ conflict: true });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  await user.type(await screen.findByLabelText('Primary care provider'), ' Updated');
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Contact changed');
  expect(state.primary.version).toBe(7);
  expect(state.primary.content).toBe('Keep this clinical note');
  expect(state.current.person.onboarding?.completedSteps).not.toContain('primary-care');
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/notes/care-primary') && init?.method === 'PUT',
    ),
  ).toHaveLength(1);
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/notes/care-primary') && !init?.method,
    ),
  ).toHaveLength(1);
});

it('saves provider progress separately, resumes at emergency and returns Back without duplicating contacts', async () => {
  const state = careBackend();
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  expect(screen.queryByLabelText('Emergency contact')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  expect(await screen.findByRole('heading', { name: 'Emergency contact' })).toBeVisible();
  expect(state.current.person.onboarding?.completedSteps).toContain('primary-care');
  expect(state.current.person.onboarding?.finished).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  await user.click(screen.getByRole('button', { name: 'Robin' }));
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  expect(await screen.findByRole('heading', { name: 'Emergency contact' })).toBeVisible();
  expect(screen.queryByLabelText('Primary care provider')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Back to primary care provider' }));
  expect(await screen.findByLabelText('Primary care provider')).toHaveValue('Dr. Rivera');
  expect(screen.getByRole('button', { name: 'Back to about you' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Save and continue' }));
  await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(state.current.person.onboarding?.skippedSteps).toContain('emergency-contact');
  expect(state.current.person.onboarding?.finished).toBe(true);
  expect(state.emergency).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it.each(['completed', 'skipped'])(
  'keeps legacy %s combined care setup complete without writing a migration',
  async (careStatus) => {
    const unlocked = { ...profile, locked: false };
    selectProfile(unlocked);
    replaceProfiles([unlocked]);
    const saved = selfNote({
      completedSteps: ['about-you', ...(careStatus === 'completed' ? ['care-team'] : [])],
      skippedSteps: careStatus === 'skipped' ? ['care-team'] : [],
      finished: false,
    });
    fetchMock.mockImplementation(async (url: string) =>
      envelope(url.endsWith('/notes/patient') ? saved : [unlocked]),
    );
    render(<ProfileManagement initialOpen />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Resume setup' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  },
);

it('hides the action menu until the source profile is unlocked', () => {
  render(<ProfileManagement initialOpen />);
  expect(
    screen.queryByText('More profile options', { selector: 'summary' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy profile' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Delete profile' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add passkey' })).not.toBeInTheDocument();
});

it('keeps Storage intent across a profile switch and fetches only the chosen profile', async () => {
  const unlocked = { ...profile, locked: false },
    other = { ...unlocked, id: 'p-two', name: 'Another profile' };
  replaceProfiles([unlocked, other]);
  selectProfile(unlocked);
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/profiles') return envelope([unlocked, other]);
    if (url === '/api/profiles/p-two/storage')
      return envelope({ storedBytes: 2_000_000, runtimeBytes: 1000, breakdown: [], notes: [] });
    throw Error('Unexpected ' + url);
  });
  const user = userEvent.setup();
  render(
    <ProfileProvider>
      <ProfileManagement initialOpen />
    </ProfileProvider>,
  );
  const otherActions = await screen.findByRole('group', { name: 'Actions for Another profile' });
  await user.click(within(otherActions).getByText('Danger Zone', { selector: 'summary' }));
  await user.click(within(otherActions).getByRole('button', { name: 'View storage' }));
  expect(await screen.findByRole('heading', { name: 'Profile storage' })).toBeVisible();
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/profiles/p-two/storage')).toBe(true),
  );
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profiles/p-one/storage')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  const actions = screen.getByRole('group', { name: 'Actions for Another profile' });
  expect(
    within(actions).getByText('Danger Zone', { selector: 'summary' }).parentElement,
  ).not.toHaveAttribute('open');
  expect(within(actions).getByRole('button', { name: 'Lock profile' })).toBeVisible();
  await user.click(within(actions).getByText('Danger Zone', { selector: 'summary' }));
  expect(within(actions).getByRole('button', { name: 'View storage' })).toBeVisible();
  expect(within(actions).getByRole('button', { name: 'Copy profile' })).toBeVisible();
});

function pendingEnrollment() {
  let resolve!: () => void, reject!: (error: Error) => void;
  vi.mocked(enrollProfilePasskey).mockImplementationOnce(
    () =>
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  return { resolve: () => resolve(), reject: () => reject(new Error('Authenticator unavailable')) };
}
async function openLaterPasskey(strict = false) {
  const unlocked = { ...profile, locked: false };
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url: string, init: RequestInit = {}) =>
    url === '/api/profiles'
      ? Promise.resolve(envelope([{ ...profile, locked: false, hasPasskey: true }]))
      : original(url, init),
  );
  const user = userEvent.setup();
  const view = render(
    strict ? (
      <StrictMode>
        <ProfileManagement initialOpen />
      </StrictMode>
    ) : (
      <ProfileManagement initialOpen />
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Add passkey' }));
  await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalledTimes(1));
  return { user, ...view };
}

it('automatically enrolls once under StrictMode and closes on success without another click', async () => {
  const pending = pendingEnrollment();
  const { rerender } = await openLaterPasskey(true);
  expect(enrollProfilePasskey).toHaveBeenCalledWith(
    'p-one',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.queryByRole('button', { name: 'Add passkey' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Skip' })).toHaveFocus();
  rerender(
    <StrictMode>
      <ProfileManagement initialOpen />
    </StrictMode>,
  );
  expect(enrollProfilePasskey).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve());
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(notifySuccess).toHaveBeenCalledWith('Passkey added.');
  expect(screen.getByRole('button', { name: 'Robin' })).toHaveFocus();
});

it.each(['creating', 'confirming'] as const)(
  'Skip aborts %s and ignores late success',
  async (phase) => {
    const pending = pendingEnrollment();
    const { user } = await openLaterPasskey();
    const options = vi.mocked(enrollProfilePasskey).mock.calls[0][1];
    act(() => options.onPhase?.(phase));
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(options.signal.aborted).toBe(true);
    await act(async () => pending.resolve());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(notifySuccess).not.toHaveBeenCalled();
  },
);

it('ignores late rejection after Skip and starts fresh only when explicitly reopened', async () => {
  const pending = pendingEnrollment();
  const { user } = await openLaterPasskey();
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await user.click(screen.getByRole('button', { name: 'Robin' }));
  await user.click(screen.getByRole('button', { name: 'Add passkey' }));
  await act(async () => pending.reject());
  expect(enrollProfilePasskey).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Creating passkey');
});

it('holds Skip and dismissal only while the durable save is in flight', async () => {
  const pending = pendingEnrollment();
  const { user } = await openLaterPasskey();
  const options = vi.mocked(enrollProfilePasskey).mock.calls[0][1];
  act(() => options.onPhase?.('saving'));
  expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Saving passkey');
  await user.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(options.signal.aborted).toBe(false);
  expect(screen.getByRole('dialog')).toBeVisible();
  await act(async () => pending.resolve());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('shows a concise failure with Skip and does not automatically retry', async () => {
  const pending = pendingEnrollment();
  const { user, rerender } = await openLaterPasskey();
  await act(async () => pending.reject());
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Passkey setup did not finish. Your recovery key still works.',
  );
  rerender(<ProfileManagement initialOpen />);
  expect(enrollProfilePasskey).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Add passkey' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('preserves the actionable PRF explanation supplied by enrollment', async () => {
  const message =
    'This passkey can’t unlock your encrypted profile in this browser. Skip to use your recovery key.';
  vi.mocked(enrollProfilePasskey).mockRejectedValueOnce(new PasskeyEnrollmentError(message));
  await openLaterPasskey();
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
});

it('aborts a pending attempt when the real keyed tree switches profiles', async () => {
  const unlocked = { ...profile, locked: false },
    other = { ...profile, id: 'p-two', name: 'Other', locked: false };
  selectProfile(unlocked);
  replaceProfiles([unlocked, other]);
  fetchMock.mockImplementation(async (url: string) =>
    envelope(url.endsWith('/passkeys') ? [] : [unlocked, other]),
  );
  const pending = pendingEnrollment();
  const user = userEvent.setup();
  render(
    <ProfileProvider>
      <ProfileManagement initialOpen />
    </ProfileProvider>,
  );
  await user.click(
    within(await screen.findByRole('group', { name: 'Actions for Robin' })).getByRole('button', {
      name: 'Add passkey',
    }),
  );
  await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalledTimes(1));
  const options = vi.mocked(enrollProfilePasskey).mock.calls[0][1];
  act(() => selectProfile(other));
  expect(options.signal.aborted).toBe(true);
  await act(async () => pending.resolve());
  expect(notifySuccess).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Add passkey for Robin' })).not.toBeInTheDocument();
});

it('aborts on unmount and prevents late completion from advancing or notifying', async () => {
  const pending = pendingEnrollment();
  const { unmount } = await openLaterPasskey();
  const options = vi.mocked(enrollProfilePasskey).mock.calls[0][1];
  unmount();
  expect(options.signal.aborted).toBe(true);
  await act(async () => pending.resolve());
  expect(notifySuccess).not.toHaveBeenCalled();
});

it.each(['success', 'skip'] as const)(
  'waits for explicit passkey consent after the real setup handoff and advances on %s',
  async (outcome) => {
    const pending = pendingEnrollment();
    let activated = false;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/profiles' && !init?.method)
        return envelope([{ ...profile, locked: !activated }]);
      if (url === '/api/profile-setups/s1/verify') {
        activated = true;
        return envelope({ ...profile, locked: false });
      }
      if (url === '/api/profiles/p-one/notes/patient') return envelope(selfNote());
      return original(url, init);
    });
    const user = userEvent.setup();
    render(
      <StrictMode>
        <ProfileProvider>
          <ProfileManagement />
        </ProfileProvider>
      </StrictMode>,
    );
    await user.click(await screen.findByRole('button', { name: 'Choose profile' }));
    await user.click(await screen.findByRole('button', { name: 'Create profile' }));
    await user.type(screen.getByLabelText('Display name'), 'Robin');
    await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
    await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
    await user.click(screen.getByLabelText(/I have saved/));
    await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
    expect(enrollProfilePasskey).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Recovery key'), kit.phrase);
    await user.click(screen.getByRole('button', { name: 'Open profile' }));
    expect(await screen.findByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
    expect(enrollProfilePasskey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add passkey' }));
    await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalledTimes(1));
    if (outcome === 'success') await act(async () => pending.resolve());
    else await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('heading', { name: 'About you' })).toBeVisible();
    expect(screen.getByLabelText('Display name')).toHaveValue('Robin');
    if (outcome === 'skip') {
      expect(vi.mocked(enrollProfilePasskey).mock.calls[0][1].signal.aborted).toBe(true);
      await act(async () => pending.resolve());
      expect(notifySuccess).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'About you' })).toBeVisible();
    }
  },
);

it.each(['setup', 'unlock'] as const)(
  'submits silent password-manager autofill with Enter for %s',
  async (flow) => {
    const user = userEvent.setup();
    render(<ProfileManagement initialOpen />);
    if (flow === 'setup') {
      await user.click(screen.getByRole('button', { name: 'Create profile' }));
      await user.type(screen.getByLabelText('Display name'), 'Bee');
      await user.type(screen.getByLabelText('Full name on health records'), 'Bee Example');
      fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
      await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
      await user.click(screen.getByLabelText(/I have saved/));
      await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
    } else await user.click(screen.getByRole('button', { name: /RobinLocked/ }));
    const password = screen.getByLabelText('Recovery key') as HTMLInputElement;
    const username = screen.getByLabelText('Username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('name', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(username).toHaveAttribute('name', 'username');
    expect(username).toHaveValue(flow === 'setup' ? 'Bee' : 'Robin');
    expect(username).not.toBeVisible();
    expect(password.form).toHaveAttribute('method', 'post');
    expect(password.form).toHaveAttribute('action', '/');
    password.value = kit.phrase;
    await user.click(password);
    await user.keyboard('{Enter}');
    const endpoint =
      flow === 'setup' ? '/api/profile-setups/s1/verify' : '/api/profiles/p-one/unlock';
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        endpoint,
        expect.objectContaining({ method: 'POST', body: expect.stringContaining(kit.phrase) }),
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
    if (flow === 'setup') expect(enrollProfilePasskey).not.toHaveBeenCalled();
  },
);

it('keeps selected card sizes after Self updates and hides all actions for locked profiles', async () => {
  const unlocked = { ...profile, locked: false };
  replaceProfiles([
    unlocked,
    { ...profile, id: 'p-locked', name: 'Locked Example', storageBytes: 12_000 },
  ]);
  selectProfile(unlocked);
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  const selected = screen.getByRole('button', { name: /RobinPrivate profile/ });
  expect(selected).toHaveAttribute('aria-current', 'true');
  expect(selected).not.toHaveTextContent('✓');
  expect(selected).toHaveTextContent('1.2 MB');
  act(() =>
    recordProfile(profile.id, {
      id: profile.id,
      name: 'Robin Updated',
      placebo: false,
      nameVersion: 2,
    }),
  );
  expect(screen.getByRole('button', { name: /Robin UpdatedPrivate profile/ })).toHaveTextContent(
    '1.2 MB',
  );
  expect(
    screen.queryByRole('group', { name: 'Actions for Locked Example' }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole('group', { name: /Actions for/ })).toHaveLength(1);
  const actions = screen.getByRole('group', { name: 'Actions for Robin Updated' });
  await user.click(within(actions).getByText('Danger Zone', { selector: 'summary' }));
  expect(within(actions).getByRole('button', { name: 'Copy profile' })).toBeVisible();
  expect(within(actions).getByRole('button', { name: 'Delete profile' })).toBeVisible();
  await user.click(within(actions).getByRole('button', { name: 'Copy profile' }));
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  expect(screen.getByRole('group', { name: 'Actions for Robin Updated' })).toBeVisible();
  expect(
    screen.getByText('Danger Zone', { selector: 'summary' }).parentElement,
  ).not.toHaveAttribute('open');
  await user.click(screen.getByText('Danger Zone', { selector: 'summary' }));
  expect(screen.getByRole('button', { name: 'View storage' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Lock profile' })).toHaveClass('primary');
  expect(screen.getByRole('button', { name: 'Copy profile' })).toBeVisible();
});

it('Back reuses pending setup and returns verification to its acknowledgement gate', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  await user.click(screen.getByRole('button', { name: 'Back to profile details' }));
  expect(screen.getByLabelText('Display name')).toHaveValue('Robin');
  expect(screen.getByLabelText('Display name')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/profile-setups')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Verify recovery key' })).toBeDisabled();
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  await user.type(screen.getByLabelText('Recovery key'), 'unfinished input');
  await user.click(screen.getByRole('button', { name: 'Back to recovery key' }));
  await user.click(screen.getByLabelText(/I have saved/));
  expect(screen.getByRole('button', { name: 'Verify recovery key' })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profile-setups/s1/verify')).toBe(false);
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue('');
});

it('Back from a resumed recovery key returns to profiles and keeps the pending setup', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.upload(screen.getByLabelText('Resume with recovery file'), recoveryFile());
  await user.click(await screen.findByRole('button', { name: 'Back to profiles' }));
  await user.click(screen.getByRole('button', { name: 'Continue profile setup' }));
  expect(screen.getByLabelText('Recovery key')).toHaveValue(kit.phrase);
  expect(screen.getByRole('button', { name: 'Verify recovery key' })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/profile-setups')).toBe(false);
});

it('Back cancels passkey enrollment and returns to its list without accepting late completion', async () => {
  const pending = pendingEnrollment();
  const unlocked = { ...profile, locked: false };
  replaceProfiles([unlocked]);
  selectProfile(unlocked);
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Add passkey' }));
  await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalledOnce());
  const signal = vi.mocked(enrollProfilePasskey).mock.calls[0][1].signal;
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  await act(async () => pending.resolve());
  expect(notifySuccess).not.toHaveBeenCalled();
  expect(enrollProfilePasskey).toHaveBeenCalledOnce();
});

it('a lock clears private setup fields and the Back path to them', async () => {
  const unlocked = { ...profile, locked: false };
  replaceProfiles([unlocked]);
  selectProfile(unlocked);
  fetchMock.mockImplementation(async () => envelope(selfNote()));
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  expect(await screen.findByLabelText('Display name')).toBeVisible();
  act(() => replaceProfiles([profile]));
  expect(screen.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument();
});

it('Back after activation returns through recovery options and onboarding without another setup or proof request', async () => {
  const unlocked = { ...profile, locked: false };
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profile-setups')
      return envelope({ setupId: 's1', profileId: 'p-one', recoveryKit: kit });
    if (url === '/api/profile-setups/s1/verify') return envelope(unlocked);
    if (url === '/api/profiles') return envelope([unlocked]);
    if (url === '/api/profiles/p-one/notes/patient') return envelope(selfNote());
    if (url === '/api/profiles/p-one/notes/person-note%3Aself')
      return envelope({ ...selfNote(), person: JSON.parse(String(init!.body)).person });
    return envelope({ message: 'Unexpected request' }, 400);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Robin');
  await user.type(screen.getByLabelText('Full name on health records'), 'Robin Example');
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  await user.click(screen.getByRole('button', { name: 'Continue to recovery key' }));
  await user.click(screen.getByLabelText(/I have saved/));
  await user.click(screen.getByRole('button', { name: 'Verify recovery key' }));
  await user.type(screen.getByLabelText('Recovery key'), kit.phrase);
  await user.click(screen.getByRole('button', { name: 'Open profile' }));
  expect(await screen.findByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
  expect(enrollProfilePasskey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Add passkey' }));
  await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalledOnce());
  const signal = vi.mocked(enrollProfilePasskey).mock.calls[0][1].signal;
  await user.click(screen.getByRole('button', { name: 'Back to recovery options' }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  expect(await screen.findByRole('heading', { name: 'About you' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back to recovery options' }));
  expect(screen.getByRole('heading', { name: 'Recovery unlocked' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await user.click(await screen.findByRole('button', { name: 'Save and continue' }));
  expect(await screen.findByRole('heading', { name: 'Primary care provider' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back to about you' }));
  expect(screen.getByRole('heading', { name: 'About you' })).toBeVisible();
  expect(enrollProfilePasskey).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/profile-setups')).toHaveLength(1);
  expect(
    fetchMock.mock.calls.filter(([url]) => url === '/api/profile-setups/s1/verify'),
  ).toHaveLength(1);
});

it('the list Back closes its dialog before returning to mobile navigation', async () => {
  const user = userEvent.setup(),
    onBack = vi.fn();
  render(<ProfileManagement initialOpen onBack={onBack} backLabel="Back to navigation" />);
  await user.click(screen.getByRole('button', { name: 'Back to navigation' }));
  expect(onBack).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each([
  { onboardingIncomplete: true, workingPasskey: false },
  { onboardingIncomplete: true, workingPasskey: true },
  { onboardingIncomplete: false, workingPasskey: false },
  { onboardingIncomplete: false, workingPasskey: true },
])(
  'groups profile actions when onboarding incomplete is $onboardingIncomplete and a working passkey is $workingPasskey',
  async ({ onboardingIncomplete, workingPasskey }) => {
    const unlocked = { ...profile, locked: false, hasPasskey: workingPasskey };
    selectProfile(unlocked);
    replaceProfiles([unlocked]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/notes/patient'))
        return envelope(
          selfNote(
            onboardingIncomplete
              ? { completedSteps: [], skippedSteps: [], finished: false }
              : {
                  completedSteps: ['about-you', 'primary-care', 'emergency-contact'],
                  skippedSteps: [],
                  finished: true,
                },
          ),
        );
      if (url.endsWith('/passkeys'))
        return envelope(
          workingPasskey
            ? [
                {
                  id: 'fictional-registered-key',
                  rpID: 'localhost',
                  createdAt: '2026-09-01T12:00:00Z',
                  lastUsedAt: null,
                },
              ]
            : [],
        );
      return envelope([unlocked]);
    });

    const user = userEvent.setup();
    render(<ProfileManagement initialOpen />);

    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'Resume setup' })).toHaveLength(
        onboardingIncomplete ? 1 : 0,
      ),
    );
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'Manage passkeys' })).toHaveLength(
        workingPasskey ? 1 : 0,
      ),
    );
    expect(screen.queryAllByRole('button', { name: 'Add passkey' })).toHaveLength(
      workingPasskey ? 0 : 1,
    );
    expect(screen.queryAllByRole('heading', { name: 'Setup incomplete' })).toHaveLength(
      onboardingIncomplete || !workingPasskey ? 1 : 0,
    );
    if (!workingPasskey)
      expect(screen.getByText(/passkey for primary access/i)).toHaveTextContent(/fallback/i);
    expect(screen.getByRole('button', { name: 'Lock profile' })).toBeVisible();
    const actions = screen.getByRole('group', { name: 'Actions for Robin' }),
      topActionGrid = actions.querySelector('.profile-action-top');
    expect(topActionGrid).not.toBeNull();
    const topActions = within(topActionGrid as HTMLElement).getAllByRole('button');
    expect(topActions.map((button) => button.textContent)).toEqual([
      ...(onboardingIncomplete ? ['Resume setup'] : []),
      ...(!workingPasskey ? ['Add passkey'] : []),
      'Lock profile',
      ...(workingPasskey ? ['Manage passkeys'] : []),
    ]);
    for (const name of [
      ...(onboardingIncomplete ? ['Resume setup'] : []),
      ...(!workingPasskey ? ['Add passkey'] : []),
      'Lock profile',
    ])
      expect(screen.getByRole('button', { name })).toHaveClass('primary');
    if (workingPasskey)
      expect(screen.getByRole('button', { name: 'Manage passkeys' })).toHaveClass('secondary');
    expect(
      screen.getByText('Danger Zone', { selector: 'summary' }).parentElement,
    ).not.toHaveAttribute('open');
    await user.click(screen.getByText('Danger Zone', { selector: 'summary' }));
    expect(screen.getByRole('button', { name: 'View storage' })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: 'Copy profile' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toHaveClass(
      'profile-action-delete',
    );
    expect(screen.getByText('Danger Zone', { selector: 'summary' })).toBeVisible();
  },
);

it('keeps setup incomplete for registered keys that cannot unlock at this address', async () => {
  const unlocked = { ...profile, locked: false, hasPasskey: false };
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  let keys = [
    {
      id: 'fictional-first',
      rpID: 'other.example.test',
      createdAt: '2026-09-01T12:00:00Z',
      lastUsedAt: null,
    },
    {
      id: 'fictional-second',
      label: '1Password 2',
      rpID: 'other.example.test',
      createdAt: '2026-09-01T12:00:00Z',
      lastUsedAt: '2026-09-03T12:00:00Z',
    },
  ];
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/profiles') return envelope([unlocked]);
    if (url.endsWith('/notes/patient'))
      return envelope(selfNote({ completedSteps: [], skippedSteps: [], finished: false }));
    if (url.endsWith('/passkeys')) return envelope(keys);
    if (url.endsWith('/passkeys/remove')) {
      keys = keys.filter((key) => key.id !== JSON.parse(String(init!.body)).credentialId);
      return envelope({ removed: true });
    }
    throw Error('Unexpected ' + url);
  });
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Manage passkeys' })).toBeVisible(),
  );
  expect(screen.getByRole('button', { name: 'Resume setup' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add passkey' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Setup incomplete' })).toBeVisible();
  const managePasskeys = screen.getByRole('button', { name: 'Manage passkeys' });
  expect(managePasskeys).toHaveClass('secondary');
  expect(managePasskeys.parentElement).toHaveClass('profile-action-top');
  expect(managePasskeys.parentElement).toHaveClass('profile-action-count-3');
  expect(
    within(managePasskeys.parentElement as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Resume setup', 'Add passkey', 'Lock profile', 'Manage passkeys']);
  expect(
    screen.getByText('Danger Zone', { selector: 'summary' }).parentElement,
  ).not.toHaveAttribute('open');
  await user.click(managePasskeys);
  expect(await screen.findByText('No recorded use')).toBeVisible();
  expect(screen.getByText(/Last used/)).toBeVisible();
  await user.click(screen.getAllByRole('button', { name: 'Remove passkey' })[0]);
  expect(screen.getByText('Passkey', { selector: 'strong' })).toBeVisible();
  expect(screen.getByText(/entry in your password manager is not deleted/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back to passkeys' }));
  expect(keys).toHaveLength(2);
  await user.click((await screen.findAllByRole('button', { name: 'Remove passkey' }))[0]);
  await user.click(screen.getByRole('button', { name: 'Remove passkey' }));
  expect(await screen.findByRole('dialog', { name: 'Manage passkeys' })).toBeVisible();
  expect(keys.map((key) => key.id)).toEqual(['fictional-second']);
  expect(screen.getByText('1Password 2', { selector: 'strong' })).toBeVisible();
  await user.click(await screen.findByRole('button', { name: 'Add another passkey' }));
  await waitFor(() => expect(enrollProfilePasskey).toHaveBeenCalled());
  await user.click(screen.getByRole('button', { name: 'Back to passkeys' }));
  expect(await screen.findByRole('dialog', { name: 'Manage passkeys' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Back to profiles' }));
  expect(screen.getByRole('button', { name: 'Manage passkeys' })).toBeVisible();
});

it('clears private passkey metadata and late list responses after profile identity changes', async () => {
  const unlocked = { ...profile, locked: false, hasPasskey: true };
  selectProfile(unlocked);
  replaceProfiles([unlocked]);
  let resolveKeys!: (response: Response) => void;
  fetchMock.mockImplementation((url: string) =>
    url.endsWith('/passkeys')
      ? new Promise<Response>((resolve) => {
          resolveKeys = resolve;
        })
      : Promise.resolve(envelope(selfNote())),
  );
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Manage passkeys' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading passkeys');
  act(() => {
    selectProfile({ ...unlocked, id: 'p-other', name: 'Other' });
  });
  await act(async () =>
    resolveKeys(
      envelope([
        {
          id: 'private-key',
          rpID: 'private-host.example',
          createdAt: '2026-09-01T12:00:00Z',
          lastUsedAt: null,
        },
      ]),
    ),
  );
  expect(screen.queryByText('private-host.example')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Manage passkeys' })).not.toBeInTheDocument();
});

it('requires actual name and complete DOB separately from the new profile display label', async () => {
  const user = userEvent.setup();
  render(<ProfileManagement initialOpen />);
  await user.click(screen.getByRole('button', { name: 'Create profile' }));
  await user.type(screen.getByLabelText('Display name'), 'Friendly label');
  const next = screen.getByRole('button', { name: 'Continue to recovery key' });
  expect(next).toBeDisabled();
  await user.type(screen.getByLabelText('Full name on health records'), 'Fictional Iris Meadow');
  expect(next).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1982-04-17' } });
  expect(next).toBeEnabled();
  await user.click(next);
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/profile-setups')!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    name: 'Friendly label',
    fullName: 'Fictional Iris Meadow',
    birthDate: '1982-04-17',
  });
});
