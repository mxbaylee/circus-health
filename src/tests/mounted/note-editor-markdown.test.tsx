import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { selectProfile } from '../../app/data/profile';
import type { Note } from '../../shared/api';
const original: Note = {
  id: 'note:11111111-1111-4111-8111-111111111111',
  kind: 'historical',
  status: 'draft',
  title: 'Fictional appointment',
  content: 'Initial body',
  textFormats: { content: 'markdown-v1' },
  topics: '',
  rawThoughts: '',
  typeLabel: 'Primary care',
  eventDate: null,
  person: {},
  personId: null,
  pinned: false,
  archived: false,
  createdAt: '2026-09-11',
  updatedAt: '2026-09-11',
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
beforeEach(() => {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
function mount(initial = original) {
  const saved = vi.fn();
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <NoteEditor
            initial={initial}
            initialKind="historical"
            types={[]}
            creationId={original.id}
            onSaved={saved}
            onRefresh={() => {}}
            prelinkType={null}
            prelinkId={null}
          />
        ),
      },
    ],
    { initialEntries: [`/notes?id=${encodeURIComponent(original.id)}`] },
  );
  render(<RouterProvider router={router} />);
  return saved;
}
it('autosaves Markdown and Finish captures a newer source edit immediately, with its marker', async () => {
  const user = userEvent.setup(),
    writes: Record<string, unknown>[] = [],
    finished: Record<string, unknown>[] = [];
  let current = original;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/visibility/'))
        return response({ archived: false, version: 0, protected: false });
      if (url.includes('/attachments?')) return response([]);
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body);
        writes.push(body);
        current = { ...current, ...body, version: current.version + 1 };
        return response(current);
      }
      if (url.endsWith('/finish')) {
        const body = JSON.parse(init.body);
        finished.push(body);
        current = {
          ...current,
          ...body,
          status: 'finished',
          version: current.version + 1,
          finishedAt: '2026-09-11',
        };
        return response(current);
      }
      if (url.includes('/backlinks?')) return response([]);
      throw new Error(`Unexpected fixture request ${url}`);
    }),
  );
  mount();
  const content = screen.getByRole('region', { name: 'Content' });
  await user.click(within(content).getByRole('tab', { name: 'Markdown' }));
  fireEvent.change(within(content).getByRole('textbox'), { target: { value: '# Autosaved 🌙' } });
  await waitFor(() => expect(writes).toHaveLength(1), { timeout: 2000 });
  expect(writes[0].textFormats).toMatchObject({ content: 'markdown-v1' });
  fireEvent.change(within(content).getByRole('textbox'), {
    target: { value: '# Latest before Finish\n\n**Keep this**' },
  });
  await user.click(screen.getByRole('button', { name: 'Finish note' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Finish note' }));
  await waitFor(() => expect(finished).toHaveLength(1));
  expect(finished[0].content).toBe('# Latest before Finish\n\n**Keep this**');
  expect(finished[0].textFormats).toMatchObject({ content: 'markdown-v1' });
  expect(screen.getByRole('heading', { name: 'Latest before Finish' })).toBeInTheDocument();
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});
it('a version conflict retains unsaved Markdown and refuses Finish without rewriting the source', async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (String(input).includes('/visibility/'))
        return response({ archived: false, version: 0, protected: false });
      if (String(input).includes('/attachments?')) return response([]);
      if (init?.method === 'PUT')
        return response({ message: 'Changed in another tab', code: 'VERSION_CONFLICT' }, 409);
      throw new Error(`Unexpected request ${input}`);
    }),
  );
  mount();
  const content = screen.getByRole('region', { name: 'Content' });
  await user.click(within(content).getByRole('tab', { name: 'Markdown' }));
  fireEvent.change(within(content).getByRole('textbox'), {
    target: { value: '## Unsaved meaningful text' },
  });
  await waitFor(
    () => expect(screen.getByRole('alert')).toHaveTextContent('Changed in another tab'),
    { timeout: 2000 },
  );
  await user.click(within(content).getByRole('tab', { name: 'Formatted' }));
  expect(screen.getByRole('heading', { name: 'Unsaved meaningful text' })).toBeInTheDocument();
  await user.click(within(content).getByRole('tab', { name: 'Markdown' }));
  expect(within(content).getByRole('textbox')).toHaveValue('## Unsaved meaningful text');
  expect(screen.getByRole('button', { name: 'Finish note' })).toBeDisabled();
});
it('legacy plain-marked personal notes render Markdown immediately and only acquire a new marker on a real edit', async () => {
  const content = '# Legacy heading\n\n- A question',
    initial = { ...original, content, textFormats: { content: 'plain-v1' as const } },
    writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body);
        writes.push(body);
        return response({ ...initial, ...body, version: 2 });
      }
      return response([]);
    }),
  );
  mount(initial);
  const field = screen.getByRole('region', { name: 'Content' }),
    user = userEvent.setup();
  expect(within(field).getByRole('heading', { name: 'Legacy heading' })).toBeInTheDocument();
  expect(within(field).getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  await user.click(within(field).getByRole('tab', { name: 'Markdown' }));
  expect(within(field).getByRole('textbox')).toHaveValue(content);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(writes).toHaveLength(0);
  fireEvent.change(within(field).getByRole('textbox'), {
    target: { value: content + '\n- Another question' },
  });
  await waitFor(() => expect(writes).toHaveLength(1), { timeout: 2000 });
  expect(writes[0].textFormats).toMatchObject({ content: 'markdown-v1' });
  expect(writes[0].content).toBe(content + '\n- Another question');
});
