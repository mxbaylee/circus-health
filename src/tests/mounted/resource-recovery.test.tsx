import { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { ResourceState } from '../../app/components/ResourceState';
import { ConnectionNotices } from '../../app/components/ConnectionStatus';
import { startConnectionMonitor } from '../../app/data/connection';
import { useResource } from '../../app/data/api';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { Note } from '../../shared/api';

vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../../app/features/notes/NoteText', () => ({
  NoteText: ({ label, value, onChange }: any) => (
    <label>
      {label}
      <textarea value={value} onChange={(event) => onChange(event.target.value, 'markdown-v1')} />
    </label>
  ),
}));
const original: Note = {
  id: 'note:fictional-reconnect',
  kind: 'note',
  status: 'editable',
  title: 'Fictional note',
  content: 'Accepted text',
  textFormats: { content: 'markdown-v1' },
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
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status });
let remote: Note, readUnavailable: boolean, writeStatus: number, writes: any[];
beforeEach(() => {
  const profile = {
    id: 'fictional-reconnect',
    name: 'Fictional Robin',
    placebo: true,
    locked: false,
  };
  replaceProfiles([profile]);
  selectProfile(profile);
  remote = structuredClone(original);
  readUnavailable = false;
  writeStatus = 409;
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      if (url === '/api/runtime')
        return new Response(
          JSON.stringify({ encrypted: true, buildId: 'fictional-new-editor-build' }),
        );
      if (options.method === 'PUT') {
        writes.push(JSON.parse(String(options.body)));
        return reply(
          {
            code: writeStatus === 409 ? 'VERSION_CONFLICT' : 'UNAVAILABLE',
            message: 'Fictional save failure; review your changes.',
          },
          writeStatus,
        );
      }
      if (url.endsWith('/notes/note%3Afictional-reconnect'))
        return readUnavailable
          ? reply({ code: 'UNAVAILABLE', message: 'Fictional read unavailable' }, 503)
          : reply(remote);
      return reply([]);
    }),
  );
});
function mount(refresh?: () => void) {
  function Harness() {
    const resource = useResource<Note>('/notes/note%3Afictional-reconnect');
    useEffect(() => (refresh ? startConnectionMonitor() : undefined), []);
    return (
      <>
        <button onClick={resource.reload}>Reload read</button>
        <ResourceState resource={resource}>
          {(note) => (
            <NoteEditor
              key={note.id}
              initial={note}
              initialKind="note"
              types={[]}
              creationId={note.id}
              prelinkId={null}
              prelinkType={null}
              onSaved={() => {}}
              onRefresh={resource.reload}
            />
          )}
        </ResourceState>
        {refresh && (
          <ConnectionNotices clientBuildId="fictional-old-editor-build" refresh={refresh} />
        )}
      </>
    );
  }
  return render(
    <RouterProvider router={createMemoryRouter([{ path: '*', element: <Harness /> }])} />,
  );
}

it('keeps the same editor mounted and adopts a newer read only when the editor is clean', async () => {
  mount();
  const content = await screen.findByLabelText('Content');
  expect(content).toHaveValue('Accepted text');
  remote = { ...remote, version: 2, content: 'New accepted server text' };
  fireEvent.click(screen.getByRole('button', { name: 'Reload read' }));
  await waitFor(() => expect(content).toHaveValue('New accepted server text'));
  expect(screen.getByLabelText('Content')).toBe(content);
  expect(writes).toEqual([]);
});

it('retains dirty text through a read failure and newer read, then uses its original revision for an explicit save', async () => {
  mount();
  const content = await screen.findByLabelText('Content');
  fireEvent.change(content, { target: { value: 'Unsent fictional draft' } });
  readUnavailable = true;
  fireEvent.click(screen.getByRole('button', { name: 'Reload read' }));
  await screen.findByText(/Showing the last loaded records/);
  expect(screen.getByLabelText('Content')).toBe(content);
  expect(content).toHaveValue('Unsent fictional draft');
  readUnavailable = false;
  remote = { ...remote, version: 2, content: 'New server text that must not replace the draft' };
  fireEvent.click(screen.getByRole('button', { name: 'Reload read' }));
  await waitFor(() =>
    expect(screen.queryByText(/Showing the last loaded records/)).not.toBeInTheDocument(),
  );
  expect(content).toHaveValue('Unsent fictional draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
  await screen.findByRole('alert');
  expect(writes).toHaveLength(1);
  expect(writes[0].version).toBe(1);
  expect(content).toHaveValue('Unsent fictional draft');
});

it('still guards refresh after an unconfirmed save is reverted, and only explicit discard suppresses unload protection', async () => {
  writeStatus = 503;
  let unloadPrevented: boolean | undefined;
  const refresh = vi.fn(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    unloadPrevented = event.defaultPrevented;
  });
  mount(refresh);
  const user = userEvent.setup();
  const content = await screen.findByLabelText('Content');
  fireEvent.change(content, { target: { value: 'Fictional uncertain write' } });
  await user.click(screen.getByRole('button', { name: 'Save now' }));
  await screen.findByRole('alert');
  fireEvent.change(content, { target: { value: 'Accepted text' } });
  await user.click(await screen.findByRole('button', { name: 'Refresh' }));
  expect(screen.getByRole('dialog', { name: 'Save changes before continuing?' })).toBeVisible();
  expect(refresh).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(refresh).not.toHaveBeenCalled();
  expect(content).toHaveValue('Accepted text');
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await user.click(screen.getByRole('button', { name: 'Discard and continue' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(unloadPrevented).toBe(false);
  expect(writes).toHaveLength(1);
});
