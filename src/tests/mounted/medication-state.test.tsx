import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { MedicationStatusEditor, Medications } from '../../app/pages/ClinicalRecords';
import { selectProfile } from '../../app/data/profile';
import type { Medication } from '../../shared/api';

vi.mock('../../app/components/RelatedNotes', () => ({ RelatedNotes: () => null }));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
// Source rendering is independent of personal medication state.
vi.mock('../../app/components/SourceDialog', () => ({ SourceDialog: () => null }));

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const medication = (overrides: Partial<Medication> = {}): Medication => ({
  id: 'med',
  label: 'Synthetic medicine',
  kind: 'order',
  status: 'active',
  currentStatus: 'unknown',
  currentStatusVersion: 0,
  visibilityVersion: 0,
  currentStatusUpdatedAt: null,
  currentStatusAssertion: null,
  sourceRecordedDate: null,
  doseText: null,
  route: null,
  frequency: null,
  startAt: null,
  endAt: null,
  provider: null,
  sourceRecordId: 'raw',
  extra: {},
  ...overrides,
});
beforeEach(() => selectProfile({ id: 'cookie-dough', name: 'Synthetic profile', placebo: true }));

it('prescriptions have one Show filter with Active, Inactive and All, and old links open Inactive', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      if (String(input).endsWith('/notes/patient')) return response({ person: {} });
      urls.push(String(input));
      return response([]);
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/medications?visibility=archived']}>
      <Medications />
    </MemoryRouter>,
  );
  expect(screen.getByText('Active')).toBeVisible();
  await waitFor(() => expect(urls.length).toBeGreaterThan(0));
  expect(urls[0]).toContain('status=current');
  expect(urls[0]).not.toContain('visibility=');
  await user.click(screen.getByRole('button', { name: 'Edit Active' }));
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await user.click(screen.getByRole('button', { name: 'Save filter' }));
  await waitFor(() => expect(urls.at(-1)).toContain('status=archived'));
  expect(screen.getByText('Inactive')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Delete Inactive' }));
  await waitFor(() => expect(urls.at(-1)).toContain('status=all'));
  expect(screen.queryByRole('list', { name: 'Saved filters' })).not.toBeInTheDocument();
});

it('activation is repeatable from Prescriptions and Done closes it without changing prescriptions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/medications']}>
      <Medications />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
  expect(
    await screen.findByRole('heading', { name: 'Activate prescriptions you still take' }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(
    screen.queryByRole('heading', { name: 'Activate prescriptions you still take' }),
  ).not.toBeInTheDocument();
});

it('legacy unknown is shown Inactive on failure and one immediate switch saves both state versions', async () => {
  const record = medication(),
    saved = vi.fn(),
    writes: unknown[] = [];
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      writes.push(JSON.parse(init.body));
      if (fail) return response({ message: 'Synthetic save failure' }, 500);
      return response({
        ...record,
        currentStatus: 'current',
        currentStatusVersion: 1,
        archived: false,
      });
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <MedicationStatusEditor record={record} onSaved={saved} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Save personal|Archive|Restore/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic save failure');
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  expect(saved).not.toHaveBeenCalled();
  fail = false;
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
  expect(writes).toEqual([
    { status: 'current', version: 0, visibilityVersion: 0 },
    { status: 'current', version: 0, visibilityVersion: 0 },
  ]);
});

it('a conflict disables the switch until both saved versions reload', async () => {
  const record = medication({
    currentStatus: 'current',
    currentStatusVersion: 3,
    visibilityVersion: 2,
  });
  const latest = medication({
    currentStatus: 'not_current',
    currentStatusVersion: 6,
    visibilityVersion: 4,
    archived: true,
  });
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      if (init?.method !== 'PATCH') return response(latest);
      writes.push(JSON.parse(init.body));
      return writes.length === 1
        ? response({ code: 'VERSION_CONFLICT', message: 'Changed elsewhere' }, 409)
        : response({
            ...latest,
            currentStatus: 'current',
            currentStatusVersion: 7,
            visibilityVersion: 5,
            archived: false,
          });
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <MedicationStatusEditor record={record} onSaved={() => {}} />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'current or archive status changed elsewhere',
  );
  expect(screen.getByRole('switch', { name: 'Active' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Reload saved status' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeEnabled());
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked());
  expect(writes).toEqual([
    { status: 'not_current', version: 3, visibilityVersion: 2 },
    { status: 'current', version: 6, visibilityVersion: 4 },
  ]);
});

it('an old archived/current conflict stays off and a target switch ignores the previous delayed save', async () => {
  const first = medication({
    id: 'first',
    currentStatus: 'current',
    currentStatusVersion: 3,
    visibilityVersion: 2,
    archived: true,
  });
  const second = medication({ id: 'second', currentStatusVersion: 7, visibilityVersion: 4 });
  const saved = vi.fn(),
    writes: { url: string; body: unknown }[] = [];
  let finish: (value: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      writes.push({ url: String(input), body: JSON.parse(init.body) });
      if (String(input).includes('/first/'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return response({ ...second, currentStatus: 'current', currentStatusVersion: 8 });
    }),
  );
  const user = userEvent.setup();
  const mounted = render(
    <MemoryRouter>
      <MedicationStatusEditor record={first} onSaved={saved} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  mounted.rerender(
    <MemoryRouter>
      <MedicationStatusEditor record={second} onSaved={saved} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  await act(async () => {
    finish(response({ ...first, archived: false }));
  });
  expect(saved).not.toHaveBeenCalled();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes[1]).toEqual({
    url: expect.stringContaining('/second/current-status'),
    body: { status: 'current', version: 7, visibilityVersion: 4 },
  });
});

function activationRouter(entry: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      expect(init?.method || 'GET').toBe('GET');
      if (String(input).includes('/clinical-relationships?'))
        return response({ relationships: [], legacyPairs: [], display: { requiresReview: false } });
      return response(String(input).endsWith('/medications/med') ? medication() : []);
    }),
  );
  const router = createMemoryRouter(
    [
      { path: '/medications', element: <Medications /> },
      { path: '/other', element: <p>Another page</p> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

it.each(['Done', 'Skip for now'])(
  '%s restores the complete pre-activation prescription view',
  async (action) => {
    const search = '?status=all&q=synthetic&offset=40&id=med&visibility=all';
    const router = activationRouter('/medications' + search),
      user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
    expect(screen.getByText('Inactive')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search prescriptions' })).toHaveValue('');
    // In-flow search replaces the history entry, but must retain its return state.
    await user.type(screen.getByRole('textbox', { name: 'Search prescriptions' }), 'temporary');
    await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
    await user.click(screen.getByRole('button', { name: action }));
    expect(router.state.location.search).toBe(search);
    expect(screen.queryByRole('list', { name: 'Saved filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search prescriptions' })).toHaveValue('synthetic');
    expect(router.state.location.state).not.toHaveProperty('prescriptionActivationReturn');
  },
);

it('Back/Forward keep activation return state and later deliberate navigation stays authoritative', async () => {
  const search = '?status=archived&q=previous',
    router = activationRouter('/medications' + search),
    user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
  await act(async () => {
    await router.navigate(-1);
  });
  expect(router.state.location.search).toBe(search);
  await act(async () => {
    await router.navigate(1);
  });
  expect(
    screen.getByRole('heading', { name: 'Activate prescriptions you still take' }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(router.state.location.search).toBe(search);
  await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
  await act(async () => {
    await router.navigate('/other');
  });
  await act(async () => {
    await router.navigate('/medications?status=all&q=deliberate');
  });
  expect(router.state.location.search).toBe('?status=all&q=deliberate');
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
  await user.click(screen.getByRole('button', { name: 'Skip for now' }));
  expect(router.state.location.search).toBe('?status=all&q=deliberate');
});

it.each(['Done', 'Skip for now'])(
  'direct/import activation %s returns to Active and retains explicit search and selection',
  async (action) => {
    const router = activationRouter('/medications?status=inactive&activation=1&q=imported&id=med'),
      user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: action }));
    expect(router.state.location.search).toBe('?q=imported&id=med');
    expect(screen.getByText('Active')).toBeVisible();
  },
);

it('a different profile cannot restore the old profile snapshot', async () => {
  const router = activationRouter('/medications?status=all&q=old-profile'),
    user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Activate prescriptions' }));
  const state = router.state.location.state;
  await act(async () => {
    selectProfile({ id: 'other-fictional', name: 'Other fictional profile', placebo: true });
    await router.navigate('/medications?status=inactive&activation=1&q=new-profile', { state });
  });
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(router.state.location.search).toBe('?q=new-profile');
  expect(router.state.location.state).not.toHaveProperty('prescriptionActivationReturn');
});
