import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteHistoryPanel } from '../../app/features/notes/NoteHistoryPanel';
import { selectProfile } from '../../app/data/profile';
import type { Note, NoteHistory } from '../../shared/api';

const note: Note = {
  id: 'person-note:fictional-friend',
  kind: 'person',
  status: 'editable',
  title: 'Friend',
  content: 'Unrelated current text',
  typeLabel: null,
  eventDate: null,
  topics: '',
  rawThoughts: '',
  personId: 'person:fictional-friend',
  person: {
    name: 'Friend',
    birthDate: '1988',
    pronouns: 'she/they',
    futureField: { retain: true },
  },
  pinned: false,
  archived: false,
  createdAt: '2026-09-10T10:00:00Z',
  updatedAt: '2026-09-11T10:00:00Z',
  finishedAt: null,
  version: 3,
  sourceRecordId: null,
  links: [],
  backlinks: [],
  attachments: [],
};
const generationId = '000000000001-0a595ff9-bd70-4cfb-9996-39781b14e43f.json';
function history(version = 3, finished = false): NoteHistory {
  return {
    noteId: note.id,
    currentVersion: version,
    finished,
    nextCursor: null,
    complete: true,
    baselineReached: true,
    coverage: 'Only verified published saved states are shown.',
    entries: [
      {
        generationId,
        savedAt: '2026-09-10T10:00:00Z',
        revision: 1,
        noteVersion: 1,
        status: 'editable',
        publication: 'baseline',
        links: 2,
        attachments: 1,
        fields: [
          {
            path: 'person.birthDate',
            label: 'Date of birth',
            previous: { present: true, value: '1988-04-07' },
            current: { present: true, value: '1988' },
            changed: true,
            restorable: !finished,
          },
          {
            path: 'person.pronouns',
            label: 'Pronouns',
            previous: { present: false },
            current: { present: true, value: 'she/they' },
            changed: true,
            restorable: !finished,
          },
        ],
      },
    ],
  };
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const restored = { ...note, version: 4, person: { ...note.person, birthDate: '1988-04-07' } };
const outcome = {
  note: restored,
  operation: { fields: ['person.birthDate'] },
  replayed: false,
  recovery: { published: true, historyAvailable: true, generationId: 'new-save.json' },
};
async function openHistory() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Review saved history' }));
  await screen.findByRole('checkbox', { name: 'Date of birth' });
  return user;
}

beforeEach(() => selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true }));

describe('review and restore selected fields', () => {
  it('shows the exact prior values and sends only the selected field with the compared version', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)));
        return response(outcome);
      }
      return response(history());
    });
    vi.stubGlobal('fetch', fetcher);
    const saved = vi.fn(),
      busy = vi.fn();
    render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={saved} onBusyChange={busy} />,
    );
    const user = await openHistory();
    expect(screen.getByText('1988-04-07')).toBeVisible();
    expect(screen.getByText('Not recorded (field absent)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore selected fields' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Restore 1 field' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(restored));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      operationId: expect.any(String),
      generationId,
      fields: ['person.birthDate'],
      version: 3,
    });
    expect(
      fetcher.mock.calls.every(([path]) => String(path).startsWith('/api/profiles/cookie-dough/')),
    ).toBe(true);
    expect(busy).toHaveBeenCalledWith(true);
    expect(busy).toHaveBeenLastCalledWith(false);
    await screen.findByText('Selected fields restored as a new saved version.');
  });

  it('refreshes a conflicting comparison and requires a new selection before another restoration', async () => {
    const requests: Record<string, unknown>[] = [];
    let currentVersion = 3;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          requests.push(JSON.parse(String(init.body)));
          if (requests.length === 1) {
            currentVersion = 8;
            return response(
              {
                error: {
                  code: 'VERSION_CONFLICT',
                  message: 'This entry changed. Refresh the comparison.',
                },
              },
              409,
            );
          }
          return response({ ...outcome, note: { ...restored, version: 9 } });
        }
        return response(history(currentVersion));
      }),
    );
    render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={vi.fn()} onBusyChange={vi.fn()} />,
    );
    const user = await openHistory();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Restore 1 field' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This entry changed');
    await user.click(screen.getByRole('button', { name: 'Refresh comparison' }));
    await screen.findByRole('checkbox', { name: 'Date of birth' });
    expect(requests).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Restore selected fields' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Restore 1 field' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].version).toBe(8);
    expect(requests[1].operationId).not.toBe(requests[0].operationId);
  });

  it('retries an uncertain response using the identical operation ID and field selection', async () => {
    const requests: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          requests.push(JSON.parse(String(init.body)));
          if (requests.length === 1) throw new TypeError('Connection lost after save');
          return response({ ...outcome, replayed: true });
        }
        return response(history());
      }),
    );
    render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={vi.fn()} onBusyChange={vi.fn()} />,
    );
    const user = await openHistory();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Restore 1 field' }));
    await screen.findByText('Connection lost after save');
    expect(screen.getByRole('checkbox', { name: 'Pronouns' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Saved state' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry same restoration' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toEqual(requests[0]);
    await screen.findByText('Selected fields restored as a new saved version.');
  });

  it('allows inspecting finished history without offering mutation', async () => {
    const fetcher = vi.fn(async () => response(history(3, true)));
    vi.stubGlobal('fetch', fetcher);
    render(
      <NoteHistoryPanel
        note={{ ...note, status: 'finished' }}
        disabled={false}
        onRestored={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    await openHistory();
    expect(screen.getByRole('checkbox', { name: 'Date of birth' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Restore/ })).not.toBeInTheDocument();
    expect(screen.getByText(/create a linked correction note/)).toBeVisible();
  });

  it('blocks closing while saving and ignores a late response after switching profiles', async () => {
    let resolveSave!: (value: Response) => void;
    let saveSignal: AbortSignal | null | undefined;
    const saved = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          saveSignal = init.signal;
          return new Promise<Response>((resolve) => {
            resolveSave = resolve;
          });
        }
        return response(history());
      }),
    );
    const view = render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={saved} onBusyChange={vi.fn()} />,
    );
    const user = await openHistory();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Restore 1 field' }));
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    act(() => selectProfile({ id: 'orchid', name: 'Other fixture', placebo: false }));
    expect(saveSignal?.aborted).toBe(true);
    view.unmount();
    await act(async () => resolveSave(response(outcome)));
    expect(saved).not.toHaveBeenCalled();
  });

  it('keeps history unavailable while edits or attachment uploads are pending', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<NoteHistoryPanel note={note} disabled onRestored={vi.fn()} onBusyChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Review saved history' })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('indexed sessions and restoration previews', () => {
  function indexed(): NoteHistory {
    const value = history();
    const association = {
      id: 'attachment:fictional',
      kind: 'attachment' as const,
      label: 'fictional.pdf',
      previous: {
        present: true,
        value: { assetId: 'asset:fictional', caption: 'Original caption' },
      },
      current: { present: false },
      changed: true,
      restorable: true,
      reason: null,
    };
    const older = { ...value.entries[0], generationId: 'older-record-version', noteVersion: 1 };
    value.entries[0] = {
      ...value.entries[0],
      noteVersion: 2,
      associations: { links: [], attachments: [association] },
      recordedChanges: [
        {
          path: 'person.birthDate',
          label: 'Date of birth',
          before: { present: true, value: '1988-04-07' },
          after: { present: true, value: '1988' },
        },
      ],
    };
    return {
      ...value,
      format: 'record-versions',
      currentRevision: 12,
      entries: [value.entries[0], older],
      groups: [
        {
          id: 'session-group',
          sessionId: 'fictional-session',
          label: 'Editing session',
          savedAt: value.entries[0].savedAt,
          entries: [generationId, older.generationId],
        },
      ],
    };
  }
  it('expands individual saves and requires an exact preview before restoring selected fields and a removed attachment', async () => {
    const current = indexed(),
      requests: { path: string; body: Record<string, unknown> }[] = [],
      saved = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          requests.push({ path: String(input), body });
          if (String(input).endsWith('/restore-preview'))
            return response({
              ...body,
              noteId: note.id,
              expectedRevision: 12,
              previewToken: 'exact-preview',
              changes: [
                {
                  path: 'person.birthDate',
                  label: 'Date of birth',
                  before: { present: true, value: '1988' },
                  after: { present: true, value: '1988-04-07' },
                },
              ],
              associationChanges: current.entries[0].associations!.attachments,
            });
          return response(outcome);
        }
        return response(current);
      }),
    );
    render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={saved} onBusyChange={vi.fn()} />,
    );
    const user = await openHistory();
    await user.click(screen.getByText(/Editing session · 2 saves/));
    expect(screen.getByRole('button', { name: /Inspect version 1/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Inspect version 2/ })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('checkbox', { name: 'Restore attachment: fictional.pdf' }));
    expect(
      screen.queryByRole('button', { name: 'Restore selected changes' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview restoration' }));
    expect(await screen.findByRole('region', { name: 'Restoration preview' })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(saved).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Restore selected changes' }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(restored));
    expect(requests[1].body).toMatchObject({
      fields: ['person.birthDate'],
      associations: { links: [], attachments: ['attachment:fictional'] },
      expectedRevision: 12,
      previewToken: 'exact-preview',
      operationId: expect.any(String),
    });
  });
  it('invalidates the preview when selections change and refreshes after a concurrent edit', async () => {
    const current = indexed();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          if (String(input).endsWith('/restore-preview'))
            return response({
              ...body,
              noteId: note.id,
              expectedRevision: 12,
              previewToken: 'exact-preview',
              changes: [],
              associationChanges: [],
            });
          return response(
            {
              error: {
                code: 'VERSION_CONFLICT',
                message: 'This profile changed. Refresh the comparison.',
              },
            },
            409,
          );
        }
        return response(current);
      }),
    );
    render(
      <NoteHistoryPanel note={note} disabled={false} onRestored={vi.fn()} onBusyChange={vi.fn()} />,
    );
    const user = await openHistory();
    await user.click(screen.getByRole('checkbox', { name: 'Date of birth' }));
    await user.click(screen.getByRole('button', { name: 'Preview restoration' }));
    await screen.findByRole('button', { name: 'Restore selected changes' });
    await user.click(screen.getByRole('checkbox', { name: 'Pronouns' }));
    expect(
      screen.queryByRole('button', { name: 'Restore selected changes' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview restoration' }));
    await user.click(await screen.findByRole('button', { name: 'Restore selected changes' }));
    await user.click(await screen.findByRole('button', { name: 'Refresh comparison' }));
    expect(await screen.findByRole('button', { name: 'Preview restoration' })).toBeDisabled();
  });
});
