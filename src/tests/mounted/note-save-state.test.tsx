import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { selectProfile } from '../../app/data/profile';
import type { Note, NoteKind } from '../../shared/api';

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
  id: 'note:fictional-save',
  kind: 'note',
  status: 'editable',
  title: 'Fictional planning',
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
const response = (data: unknown) => new Response(JSON.stringify({ data }));
let saved: Note, writes: { method: string; url: string; body: any }[];

beforeEach(() => {
  vi.useFakeTimers();
  selectProfile({ id: 'fictional-save', name: 'Fictional Robin', placebo: true });
  saved = structuredClone(original);
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init: RequestInit = {}) => {
      const url = String(input);
      if (init.method === 'PUT' || init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ method: init.method, url, body });
        saved = { ...saved, ...body, version: saved.version + 1 };
        return response(saved);
      }
      if (url.endsWith('/notes/note%3Afictional-save')) return response(saved);
      if (url.includes('/visibility/')) return response({ archived: false, version: 0 });
      return response([]);
    }),
  );
});

function editor(
  initial: Note | null = original,
  kind: NoteKind = initial?.kind || 'note',
  types: string[] = [],
) {
  return (
    <NoteEditor
      initial={initial}
      initialKind={kind}
      types={types}
      onSaved={() => {}}
      onRefresh={() => {}}
      creationId="note:fictional-new"
      prelinkType={null}
      prelinkId={null}
    />
  );
}
function mount(content = editor()) {
  const router = createMemoryRouter([{ path: '*', element: content }]);
  render(<RouterProvider router={router} />);
}
async function settle() {
  await act(async () => {});
}

it.each(['note', 'historical', 'person'] as const)(
  'disables unchanged %s saves and direct form submission',
  async (kind) => {
    mount(editor({ ...original, kind }));
    const save = screen.getByRole('button', {
      name: kind === 'historical' ? 'Save draft' : 'Save now',
    });
    expect(save).toBeDisabled();
    fireEvent.submit(document.querySelector('form')!);
    await settle();
    expect(writes).toEqual([]);
    if (kind === 'historical')
      expect(screen.getByRole('button', { name: 'Finish note' })).toBeEnabled();
  },
);

it('disables untouched or reverted new notes without creating an empty autosave', async () => {
  mount(editor(null));
  const save = screen.getByRole('button', { name: 'Save now' });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fictional draft' } });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
  expect(save).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  expect(writes).toEqual([]);
});

it('enables a changed form, disables a reversion, and returns to disabled after autosave', async () => {
  mount();
  const save = screen.getByRole('button', { name: 'Save now' });
  const field = screen.getByLabelText('Content');
  fireEvent.change(field, { target: { value: 'Unsaved fictional text' } });
  expect(save).toBeEnabled();
  fireEvent.change(field, { target: { value: original.content } });
  expect(save).toBeDisabled();
  fireEvent.change(field, { target: { value: 'Autosaved fictional text' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  expect(writes).toHaveLength(1);
  expect(saved.content).toBe('Autosaved fictional text');
  expect(save).toBeDisabled();
});

it('does not autosave a partial note type before an existing choice or explicit Add is committed', async () => {
  mount(editor({ ...original, kind: 'historical' }, 'historical', ['Therapy']));
  const save = screen.getByRole('button', { name: 'Save draft' });
  const input = screen.getByRole('combobox', { name: 'Type' });
  fireEvent.change(input, { target: { value: 'Care planning' } });
  expect(screen.getByRole('option', { name: /Add “Care planning” as a new type/ })).toBeVisible();
  expect(save).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  expect(writes).toEqual([]);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(save).toBeEnabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700);
  });
  expect(writes).toHaveLength(1);
  expect(writes[0].body.typeLabel).toBe('Care planning');
});

it('disables Save during a pending write and drains later typing without a second click', async () => {
  const fetchOriginal = vi.mocked(fetch).getMockImplementation()!;
  let finish!: () => void;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'PUT' && !finish)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return fetchOriginal(input, init);
  });
  mount();
  const save = screen.getByRole('button', { name: 'Save now' });
  const field = screen.getByLabelText('Content');
  fireEvent.change(field, { target: { value: 'First fictional edit' } });
  fireEvent.click(save);
  await settle();
  expect(save).toBeDisabled();
  fireEvent.change(field, { target: { value: 'Later fictional edit' } });
  expect(save).toBeDisabled();
  await act(async () => finish());
  expect(writes).toHaveLength(2);
  expect(saved.content).toBe('Later fictional edit');
  expect(save).toBeDisabled();
});

it('keeps retry available after a lost response even when the form matches the old baseline', async () => {
  const fetchOriginal = vi.mocked(fetch).getMockImplementation()!;
  let loseResponse = true;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const result = await fetchOriginal(input, init);
    if (init?.method === 'PUT' && loseResponse) {
      loseResponse = false;
      throw new Error('Fictional lost response after acceptance');
    }
    return result;
  });
  mount();
  const save = screen.getByRole('button', { name: 'Save now' });
  fireEvent.change(screen.getByLabelText('Content'), {
    target: { value: 'Accepted before response loss' },
  });
  fireEvent.click(save);
  await settle();
  expect(screen.getByRole('button', { name: 'Retry save' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Content'), { target: { value: original.content } });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await settle();
  expect(writes).toHaveLength(2);
  expect(writes[1].body.version).toBe(2);
  expect(saved.content).toBe(original.content);
  expect(save).toBeDisabled();
});

it('submits the matching editor when a linked note is open beside the primary note', async () => {
  mount(
    <>
      {editor()}
      {editor({ ...original, id: 'note:fictional-linked', title: 'Fictional linked note' })}
    </>,
  );
  const articles = screen.getAllByRole('article');
  fireEvent.change(within(articles[1]).getByLabelText('Content'), {
    target: { value: 'Linked edit only' },
  });
  expect(within(articles[0]).getByRole('button', { name: 'Save now' })).toBeDisabled();
  fireEvent.click(within(articles[1]).getByRole('button', { name: 'Save now' }));
  await settle();
  expect(writes).toHaveLength(1);
  expect(writes[0].url).toMatch(/note%3Afictional-linked$/);
  expect(writes[0].body.content).toBe('Linked edit only');
});
