import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { NoteExportDialog } from '../../app/features/notes/NoteExportDialog';
import { selectProfile } from '../../app/data/profile';
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const options = {
  noteTitle: 'Fictional note',
  noteVersion: 2,
  choices: [
    {
      key: 'note:private',
      type: 'note',
      id: 'private',
      title: 'Private family history',
      date: null,
      linked: true,
      topic: 'note',
      source: 'personal',
    },
  ],
  assets: [],
};
beforeEach(() => {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
it('a failed latest-save blocks options and cannot produce a stale preview', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(
    <NoteExportDialog
      type="note"
      id="fictional"
      prepare={async () => {
        throw new Error('Save conflict: latest text retained');
      }}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save conflict');
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Preview note only/ })).not.toBeInTheDocument();
});
it('new unsaved note is created with the latest body before options, and note-only stays the default', async () => {
  const events: string[] = [],
    writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/notes') && init?.method === 'POST') {
        events.push('save');
        const body = JSON.parse(init.body);
        writes.push(body);
        return response({
          ...body,
          version: 1,
          status: 'editable',
          kind: 'note',
          person: {},
          personId: null,
          pinned: false,
          archived: false,
          createdAt: '2026-09-11',
          updatedAt: '2026-09-11',
          finishedAt: null,
          sourceRecordId: null,
          links: [],
          backlinks: [],
          attachments: [],
        });
      }
      if (url.endsWith('/note-exports/options')) {
        events.push('options');
        return response(options);
      }
      if (url.endsWith('/note-exports/preview')) {
        events.push('preview');
        const body = JSON.parse(init.body);
        expect(body.selected).toEqual([]);
        expect(body.assets).toEqual([]);
        return response({
          token: 'frozen',
          html: '<h1>Latest unsaved body</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      }
      if (url.includes('/attachments?')) return response([]);
      return response([]);
    }),
  );
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <NoteEditor
            initial={null}
            initialKind="note"
            prelinkId={null}
            prelinkType={null}
            types={[]}
            creationId="note:11111111-1111-4111-8111-111111111111"
            onSaved={() => {}}
            onRefresh={() => {}}
          />
        ),
      },
    ],
    { initialEntries: ['/notes?new=1'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New fictional note' } });
  const content = screen.getByRole('region', { name: 'Content' });
  await userEvent.click(within(content).getByRole('tab', { name: 'Markdown' }));
  fireEvent.change(within(content).getByRole('textbox'), {
    target: { value: '# Latest unsaved body' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Print' }));
  await screen.findByRole('button', { name: 'Preview note only' });
  expect(events.slice(0, 2)).toEqual(['save', 'options']);
  expect(writes[0].content).toBe('# Latest unsaved body');
  await userEvent.click(screen.getByRole('button', { name: 'Preview note only' }));
  await screen.findByTitle('Exact export preview');
  expect(writes).toHaveLength(1);
});
it('supporting categories are explicit, and changed profile cannot export an old preview', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response({
          token: 'frozen',
          html: '<h1>Fictional note</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      }
      throw new Error('An old profile must never reach output');
    }),
  );
  render(<NoteExportDialog type="note" id="fictional" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview note only' });
  await userEvent.click(screen.getByRole('checkbox', { name: /Linked entries/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Preview visit brief' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0].includeLinked).toBe(true);
  expect(requests[0].includeAttachments).toBe(false);
  selectProfile({ id: 'cedar', name: 'Other profile', placebo: false });
  await userEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('profile changed'));
});

it('Self starts a provider packet with optional notes and no brief-only switches', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options'))
        return response({
          ...options,
          choices: [
            ...options.choices,
            {
              key: 'note:person',
              id: 'person',
              type: 'note',
              kind: 'person',
              title: 'A private person',
              date: null,
            },
          ],
        });
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response({
          token: 'frozen',
          html: '<h1>Patient packet</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      }
      return response([]);
    }),
  );
  render(<NoteExportDialog type="person" id="patient" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview provider packet' });
  expect(screen.queryByRole('combobox', { name: 'Format' })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: 'Current prescriptions' })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox', { name: /A private person/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox', { name: /Private family history/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0]).toMatchObject({
    type: 'person',
    id: 'patient',
    mode: 'provider',
    noteIds: ['private'],
  });
});
it('a note becomes the introduction when switching to provider packet', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview')) {
        requests.push(JSON.parse(init.body));
        return response({
          token: 'frozen',
          html: '<h1>Packet</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      }
      return response([]);
    }),
  );
  render(<NoteExportDialog type="note" id="fictional" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('combobox', { name: 'Format' });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'provider');
  expect(screen.getByText(/starts as your introduction/)).toHaveTextContent('Fictional note');
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  expect(requests[0]).toMatchObject({ mode: 'provider', noteIds: ['fictional'] });
});
it('provider evidence downloads save and validate the current packet before retrieving JSON', async () => {
  const events: string[] = [];
  const createObjectURL = vi.fn(() => 'blob:fictional-evidence');
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/options')) return response(options);
      if (url.endsWith('/preview'))
        return response({
          token: 'frozen',
          html: '<h1>Packet</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      if (url.endsWith('/frozen/validate')) {
        events.push('validate');
        return response({ valid: true });
      }
      if (url.endsWith('/frozen/evidence')) {
        events.push('evidence');
        expect(init.method).toBe('POST');
        return new Response(JSON.stringify({ sources: ['fictional source'] }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  render(
    <NoteExportDialog
      type="person"
      id="patient"
      prepare={async () => {
        events.push('save');
      }}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  events.length = 0;
  await userEvent.click(screen.getByRole('button', { name: 'Download evidence JSON' }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(events).toEqual(['save', 'validate', 'evidence']);
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(
    'health-packet-provider-evidence.json',
  );
});
it('an outdated provider packet cannot download evidence and briefs have no evidence action', async () => {
  let evidenceRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/options')) return response(options);
      if (url.endsWith('/preview'))
        return response({
          token: 'frozen',
          html: '<h1>Packet</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      if (url.endsWith('/validate'))
        return response({ message: 'The packet changed. Refresh the preview.' }, 409);
      if (url.endsWith('/evidence')) evidenceRequests++;
      return response({});
    }),
  );
  render(<NoteExportDialog type="note" id="fictional" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Preview note only' }));
  await screen.findByTitle('Exact export preview');
  expect(screen.queryByRole('button', { name: 'Download evidence JSON' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Edit options' }));
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'provider');
  await userEvent.click(screen.getByRole('button', { name: 'Preview provider packet' }));
  await screen.findByTitle('Exact export preview');
  await userEvent.click(screen.getByRole('button', { name: 'Download evidence JSON' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('packet changed');
  expect(evidenceRequests).toBe(0);
});

it('preview Back retains export selections and does not close the dialog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview'))
        return response({
          token: 'fictional-preview',
          html: '<h1>Fictional note</h1>',
          generatedAt: '2026-09-11',
          assets: [],
        });
      throw new Error(`Unexpected request ${input}`);
    }),
  );
  const user = userEvent.setup();
  render(<NoteExportDialog type="note" id="fictional" />);
  await user.click(screen.getByRole('button', { name: 'Print / Export' }));
  await screen.findByRole('button', { name: 'Preview note only' });
  expect(screen.queryByRole('button', { name: 'Back to export options' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Linked entries/ }));
  await user.click(screen.getByRole('button', { name: 'Preview visit brief' }));
  await screen.findByTitle('Exact export preview');
  await user.click(screen.getByRole('button', { name: 'Back to export options' }));
  expect(screen.getByRole('dialog', { name: 'Print / Export' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Linked entries/ })).toBeChecked();
  expect(screen.queryByTitle('Exact export preview')).not.toBeInTheDocument();
});

it('export options cannot change while a saved preview is being prepared', async () => {
  let finishPreview: (value: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      if (String(input).endsWith('/options')) return response(options);
      if (String(input).endsWith('/preview'))
        return new Promise<Response>((resolve) => {
          finishPreview = resolve;
        });
      throw new Error(`Unexpected request ${input}`);
    }),
  );
  render(<NoteExportDialog type="note" id="fictional" />);
  await userEvent.click(screen.getByRole('button', { name: 'Print / Export' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Preview note only' }));
  expect(screen.getByRole('combobox', { name: 'Format' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Linked entries/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Attachments/ })).toBeDisabled();
  finishPreview(
    response({
      token: 'frozen',
      html: '<h1>Saved note</h1>',
      generatedAt: '2026-09-11',
      assets: [],
    }),
  );
  await screen.findByTitle('Exact export preview');
});
