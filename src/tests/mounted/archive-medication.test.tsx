import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ArchiveControl } from '../../app/components/ArchiveControl';
import { MedicationStatusEditor } from '../../app/pages/ClinicalRecords';
import { selectProfile } from '../../app/data/profile';
import type { Medication } from '../../shared/api';
// PDF asset loading is covered separately from layout and state-control interactions.
vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true }));
it('Active off and on append archive and restore versions without a delete control', async () => {
  let state = { archived: false, version: 0, protected: false };
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body);
        writes.push(body);
        state = { ...state, ...body, version: state.version + 1 };
      }
      return response(state);
    }),
  );
  const user = userEvent.setup(),
    changed = vi.fn();
  render(<ArchiveControl targetType="note" targetId="finished" onChanged={changed} />);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeEnabled());
  expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked());
  expect(screen.getByText('Inactive')).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  expect(await screen.findByRole('switch', { name: 'Active' })).toBeEnabled();
  expect(writes).toEqual([
    { archived: true, version: 0 },
    { archived: false, version: 1 },
  ]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked();
  expect(screen.queryByRole('button', { name: /delete|trash|purge/i })).not.toBeInTheDocument();
});
it('compact current use exposes accessible timestamp, actor and preserved history on demand; optional note carries stable medication link', async () => {
  const record: Medication = {
    id: 'med',
    label: 'Example',
    kind: 'order',
    status: 'active',
    currentStatus: 'current',
    currentStatusVersion: 2,
    visibilityVersion: 2,
    archiveHistory: [
      {
        id: 'older-restore',
        archived: false,
        version: 2,
        createdAt: '2026-09-09T12:00:00Z',
        actor: 'Archive reviewer',
      },
    ],
    currentStatusUpdatedAt: '2026-09-11T12:00:00Z',
    currentStatusAssertion: {
      actor: 'Profile owner',
      previousStatus: 'unknown',
      previousUpdatedAt: '2026-09-10T12:00:00Z',
      previousAssertion: { source: 'older assertion' },
    },
    sourceRecordedDate: null,
    doseText: null,
    route: null,
    frequency: null,
    startAt: null,
    endAt: null,
    provider: null,
    sourceRecordId: 'raw',
    extra: {},
  };
  const user = userEvent.setup(),
    saved = vi.fn(),
    writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      writes.push(JSON.parse(init.body));
      return response({
        ...record,
        currentStatus: 'not_current',
        currentStatusVersion: 3,
        archived: true,
        visibilityVersion: 3,
      });
    }),
  );
  render(
    <MemoryRouter>
      <MedicationStatusEditor record={record} onSaved={saved} />
    </MemoryRouter>,
  );
  expect(screen.queryByText('Profile owner')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Current use history and details' }));
  const dialog = screen.getByRole('dialog', { name: 'Current use history' });
  expect(within(dialog).getByText(/By: Profile owner/)).toBeInTheDocument();
  expect(within(dialog).getByText(/By: Not recorded/)).toBeInTheDocument();
  expect(within(dialog).getByRole('region', { name: 'Archive history' })).toHaveTextContent(
    'Restored',
  );
  expect(within(dialog).getByText(/By: Archive reviewer/)).toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: /Add a linked note/ })).toHaveAttribute(
    'href',
    expect.stringContaining('targetType=medication&targetId=med'),
  );
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(writes).toEqual([{ status: 'not_current', version: 2, visibilityVersion: 2 }]);
});
it('switching targets ignores a delayed archive response and uses the new target visibility version', async () => {
  const user = userEvent.setup(),
    changed = vi.fn();
  let finishFirst: (value: Response) => void = () => {};
  const patches: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(init.body) });
        if (url.endsWith('/first'))
          return new Promise<Response>((resolve) => {
            finishFirst = resolve;
          });
        return response({ archived: false, version: 8, protected: false });
      }
      return response(
        url.endsWith('/first')
          ? { archived: false, version: 0, protected: false }
          : { archived: true, version: 7, protected: false },
      );
    }),
  );
  const mounted = render(<ArchiveControl targetType="note" targetId="first" onChanged={changed} />);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeEnabled());
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  mounted.rerender(<ArchiveControl targetType="note" targetId="second" onChanged={changed} />);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeEnabled());
  expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  finishFirst(response({ archived: true, version: 1, protected: false }));
  await user.click(screen.getByRole('switch', { name: 'Active' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(patches[1]).toEqual({
    url: expect.stringContaining('/note/second'),
    body: { archived: false, version: 7 },
  });
});
it('Self remains protected from visibility changes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ archived: false, version: 0, protected: true })),
  );
  const mounted = render(<ArchiveControl targetType="person" targetId="patient" />);
  await waitFor(() => expect(mounted.container).toBeEmptyDOMElement());
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});
