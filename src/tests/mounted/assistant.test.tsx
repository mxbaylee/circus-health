import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link, useLocation } from 'react-router-dom';
import {
  AssistantPageProvider,
  useAssistantSelection,
} from '../../app/features/assistant/pageContext';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLauncher } from '../../app/features/assistant/AssistantLauncher';
import { AssistantText } from '../../app/features/assistant/AssistantText';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { AssistantChat } from '../../app/features/assistant/types';

const first = { id: 'fictional-alpha', name: 'Cookie Dough', placebo: true };
const second = { id: 'fictional-beta', name: 'Stardust', placebo: true };
const prefix = `/api/profiles/${first.id}/assistant`;
const stamp = '2026-09-01T12:00:00Z';
const chat = (overrides: Partial<AssistantChat> = {}): AssistantChat => ({
  id: 'chat-1',
  title: 'Fictional archive question',
  updatedAt: stamp,
  status: 'idle',
  messages: [
    { id: 'u-1', role: 'user', content: 'An earlier question', createdAt: stamp },
    {
      id: 'a-1',
      role: 'assistant',
      content: 'A fictional saved answer',
      createdAt: stamp,
      status: 'complete',
    },
  ],
  ...overrides,
});
const json = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
type Override = (path: string, init: RequestInit) => Promise<Response> | Response | undefined;
function backend(initial?: AssistantChat, override?: Override) {
  let current = initial;
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    const custom = override?.(path, init);
    if (custom) return custom;
    if (path.endsWith('/status')) return json({ available: true });
    if (path.endsWith('/chats') && !init?.method) return json(current ? [current] : []);
    if (path.endsWith('/chats') && init?.method === 'POST') {
      current = chat({
        status: 'running',
        messages: [
          {
            id: 'u-1',
            role: 'user',
            content: JSON.parse(String(init!.body)).message,
            createdAt: stamp,
          },
        ],
      });
      return json(current);
    }
    if (path.endsWith('/cancel')) {
      current = { ...current!, status: 'cancelled' };
      return json(current);
    }
    if (path.endsWith('/retry')) {
      current = { ...current!, status: 'running' };
      return json(current);
    }
    if (current && path.endsWith(`/chats/${current.id}`)) return json(current);
    throw new Error(`Unmocked assistant request: ${init?.method || 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', mock);
  return {
    mock,
    setChat: (next: AssistantChat) => {
      current = next;
    },
    writes: () => mock.mock.calls.filter(([, init]) => init?.method === 'POST'),
  };
}
function mount() {
  return render(
    <MemoryRouter initialEntries={['/sources?file=fictional-source']}>
      <AssistantLauncher />
    </MemoryRouter>,
  );
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open assistant' }));
  await screen.findByRole('dialog', { name: 'Moxie the Assistant' });
  await waitFor(() =>
    expect(screen.queryByText('Checking assistant availability…')).not.toBeInTheDocument(),
  );
}
beforeEach(() => {
  replaceProfiles([first, second]);
  selectProfile(first);
});

describe('Archive assistant mounted behavior', () => {
  it('only opens and prefills an intake request until Send is chosen', async () => {
    const server = backend();
    const user = userEvent.setup();
    mount();
    expect(server.mock).not.toHaveBeenCalled();
    act(() =>
      window.dispatchEvent(
        new CustomEvent('health:ask', {
          detail: {
            message: 'Review this fictional upload',
            context: { route: '/import?intake=sample', intakeId: 'sample' },
          },
        }),
      ),
    );
    const message = await screen.findByRole('textbox', { name: 'Message' });
    expect(message).toHaveValue('Review this fictional upload');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(server.writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(server.writes()).toHaveLength(1);
    expect(server.writes()[0][0]).toBe(`${prefix}/chats`);
    expect(JSON.parse(String(server.writes()[0][1]!.body))).toEqual({
      message: 'Review this fictional upload',
      context: { route: '/import?intake=sample', intakeId: 'sample' },
    });
  });

  it('keeps an exact selected-draft repair scope on the one focused assistant request', async () => {
    const server = backend();
    const user = userEvent.setup();
    mount();
    const intakeRepair = {
      format: 'intake-draft-repair-selection-v1',
      intakeId: 'fictional-intake',
      groupId: 'fictional-report',
      rows: [
        {
          proposalId: null,
          recordId: 'fictional-row',
          candidateVersionId: 'fictional-version',
          fields: ['date'],
        },
      ],
    };
    act(() =>
      window.dispatchEvent(
        new CustomEvent('health:ask', {
          detail: {
            message: 'Check this selected fictional date.',
            context: { route: '/import?group=fictional-report', intakeRepair },
          },
        }),
      ),
    );
    expect(await screen.findByText('Next message context · Selected import drafts')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(JSON.parse(String(server.writes()[0][1]!.body))).toEqual({
      message: 'Check this selected fictional date.',
      context: { route: '/import?group=fictional-report', intakeRepair },
    });
  });

  it('sends, cancels, and retries the same turn without duplicating the user message', async () => {
    const server = backend();
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'Find my fictional annual note',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getAllByRole('article', { name: 'You message' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    await screen.findByText(/This run was cancelled/);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry last turn' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(server.writes().map(([url]) => url)).toEqual([
      `${prefix}/chats`,
      `${prefix}/chats/chat-1/cancel`,
      `${prefix}/chats/chat-1/retry`,
    ]);
    expect(screen.getAllByRole('article', { name: 'You message' })).toHaveLength(1);
  });

  it('loads saved history and preserves drafts when the dialog is closed', async () => {
    const server = backend(chat());
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Unsent preparation');
    await user.click(screen.getByRole('button', { name: 'Close assistant' }));
    await open(user);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent preparation');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), 'chat-1');
    await screen.findByText('A fictional saved answer');
    expect(server.writes()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Unsent preparation');
  });

  it('clears an external prefill and its captured context when switching chats', async () => {
    const saved = chat({
      messages: [
        {
          id: 'u-saved',
          role: 'user',
          content: 'A saved source question',
          createdAt: stamp,
          context: {
            route: '/sources?file=historical',
            selection: { collection: 'sources', id: 'historical' },
          },
        },
      ],
    });
    const server = backend(saved);
    const user = userEvent.setup();
    mount();
    act(() =>
      window.dispatchEvent(
        new CustomEvent('health:ask', {
          detail: {
            message: 'Review this temporary fictional upload',
            context: { route: '/import?intake=temporary', intakeId: 'temporary' },
          },
        }),
      ),
    );
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue(
      'Review this temporary fictional upload',
    );
    expect(screen.getByText('Next message context · Selected source import')).toHaveAttribute(
      'title',
      '/import?intake=temporary',
    );

    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), 'chat-1');
    expect(await screen.findByText('A saved source question')).toBeVisible();
    expect(screen.getByText('From Sources')).toHaveAttribute('title', '/sources?file=historical');
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(screen.getByText('Next message context · Sources')).toHaveAttribute(
      'title',
      '/sources?file=fictional-source',
    );
    act(() =>
      window.dispatchEvent(
        new CustomEvent('health:ask', {
          detail: {
            message: 'Another temporary prefill',
            context: { route: '/import?intake=another', intakeId: 'another' },
          },
        }),
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Another temporary prefill',
    );
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(screen.getByText('Next message context · Sources')).toHaveAttribute(
      'title',
      '/sources?file=fictional-source',
    );
    expect(server.writes()).toHaveLength(0);
  });

  it('aborts and hides the old profile even when its pending send resolves late', async () => {
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const server = backend(undefined, (path, init) => {
      if (path === `${prefix}/chats` && init?.method === 'POST') {
        oldSignal = init.signal!;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
    });
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Old profile private draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    act(() => selectProfile(second));
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open(user);
    expect(screen.getByText('Stardust’s profile · Fictional placebo records')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    await act(async () =>
      resolveOld(
        json(
          chat({
            title: 'Old private chat',
            messages: [
              { id: 'a-old', role: 'assistant', content: 'Old private response', createdAt: stamp },
            ],
          }),
        ),
      ),
    );
    expect(screen.queryByText('Old private response')).not.toBeInTheDocument();
    expect(screen.queryByText('Old private chat')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(server.writes()).toHaveLength(1);
    expect(
      server.mock.mock.calls.some(([url]) => url === `/api/profiles/${second.id}/assistant/status`),
    ).toBe(true);
  });

  it('shows sign-in/unavailable information and retains the unsent message', async () => {
    const server = backend(undefined, (path) =>
      path.endsWith('/status')
        ? json({
            available: false,
            message: 'Sign in to the local assistant connection to continue.',
          })
        : undefined,
    );
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this question');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sign in to the local assistant connection',
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(server.writes()).toHaveLength(0);
  });

  it('polls a running chat and displays the completed reply without another send', async () => {
    const server = backend(
      chat({
        status: 'running',
        messages: [
          { id: 'u-1', role: 'user', content: 'A fictional running question', createdAt: stamp },
        ],
      }),
    );
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), 'chat-1');
    await screen.findByRole('button', { name: 'Cancel run' });
    server.setChat(
      chat({
        messages: [
          {
            id: 'a-1',
            role: 'assistant',
            content: 'A completed fictional response',
            createdAt: stamp,
          },
        ],
      }),
    );
    await screen.findByText('A completed fictional response', {}, { timeout: 2000 });
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    expect(server.writes()).toHaveLength(0);
  });

  it('retains an unsent draft after a server error and allows an explicit retry', async () => {
    let fail = true;
    const server = backend(undefined, (path, init) => {
      if (fail && path.endsWith('/chats') && init?.method === 'POST')
        return new Response(
          JSON.stringify({
            error: {
              code: 'CONNECTION_LOST',
              message: 'The local assistant connection was interrupted.',
            },
          }),
          { status: 503 },
        );
    });
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Preserve this draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('The local assistant connection was interrupted.');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Preserve this draft');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(server.writes()).toHaveLength(1);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(server.writes()).toHaveLength(2);
  });

  it('shows proposed changes and only applies a note after the explicit save action', async () => {
    const proposed = chat({
      proposals: [
        {
          id: 'proposal-1',
          kind: 'note',
          title: 'Annual preparation',
          summary: 'A draft note for review.',
          status: 'pending',
          changes: { title: 'Annual preparation', body: 'Discuss fictional questions.' },
        },
      ],
    });
    const server = backend(proposed, (path, _init) => {
      if (path.endsWith('/apply')) {
        const updated = {
          ...proposed,
          proposals: [
            {
              ...proposed.proposals![0],
              status: 'applied' as const,
              resultUrl: '/notes?id=fictional-note',
            },
          ],
        };
        server.setChat(updated);
        return json(updated);
      }
    });
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), 'chat-1');
    const card = await screen.findByRole('region', { name: 'Annual preparation' });
    expect(server.writes()).toHaveLength(0);
    await user.click(within(card).getByText('Proposed changes'));
    expect(within(card).getByText(/Discuss fictional questions/)).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'Save note' }));
    const link = await screen.findByRole('link', { name: 'Open saved item' });
    expect(link).toHaveAttribute('href', '/notes?id=fictional-note');
    expect(server.writes()[0][0]).toBe(`${prefix}/chats/chat-1/apply`);
    expect(JSON.parse(String(server.writes()[0][1]!.body))).toEqual({ proposalId: 'proposal-1' });
    expect(screen.queryByRole('button', { name: 'Save note' })).not.toBeInTheDocument();
  });

  it('shows measured attempt usage and labels protocol gaps as unavailable', async () => {
    backend(
      chat({
        runs: [
          {
            id: 'run-1',
            startedAt: stamp,
            endedAt: stamp,
            status: 'idle',
            model: 'synthetic-model',
            usage: {
              totalTokens: 150,
              inputTokens: 100,
              cachedInputTokens: 25,
              cacheWriteInputTokens: 0,
              outputTokens: 35,
              reasoningOutputTokens: 15,
              modelContextWindow: 200000,
              measuredAt: stamp,
              source: 'thread/tokenUsage/updated',
            },
          },
          { id: 'run-2', startedAt: stamp, endedAt: stamp, status: 'failed', usage: null },
        ],
      }),
    );
    const user = userEvent.setup();
    mount();
    await open(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), 'chat-1');
    await user.click(await screen.findByText('Measured usage · 2 attempts'));
    expect(
      screen.getByText(
        /Attempt 1 · 150 total · 100 input · 25 cached input · 35 output · 15 reasoning · synthetic-model/,
      ),
    ).toBeVisible();
    expect(screen.getByText('Attempt 2 · measured usage unavailable')).toBeVisible();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('renders response text safely and only makes supported links clickable', () => {
    render(
      <MemoryRouter>
        <AssistantText
          content={
            '<script>unsafe()</script>\n\n[note](/notes?id=fictional) [web](https://example.org/info) [bad](javascript:alert) [file](file:///tmp/x) [api](/api/profiles/other/notes)'
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/<script>unsafe/)).toBeInTheDocument();
    expect(document.querySelector('script')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'note' })).toHaveAttribute(
      'href',
      '/notes?id=fictional',
    );
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('assistant Markdown and current selection', () => {
  it('keeps exact Import citations navigable without allowing API routes', () => {
    render(
      <MemoryRouter>
        <AssistantText
          content={
            '[Review report](#/import?intake=fictional%3Aone&group=group-one&proposal=original&record=row-one) [Blocked API](/api/profiles/other/intakes)'
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Review report' })).toHaveAttribute(
      'href',
      '/import?intake=fictional%3Aone&group=group-one&proposal=original&record=row-one',
    );
    expect(screen.queryByRole('link', { name: 'Blocked API' })).not.toBeInTheDocument();
  });

  it('names the dedicated Import page as the next message context', async () => {
    backend();
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/import']}>
        <AssistantPageProvider>
          <AssistantLauncher />
        </AssistantPageProvider>
      </MemoryRouter>,
    );
    await open(user);
    expect(screen.getByText('Next message context · Import')).toHaveAttribute('title', '/import');
  });

  it('renders formatting, tables and streamed partial Markdown with navigable app citations', () => {
    const navigate = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <AssistantText
          content={
            '## Your result\n\nIt is **recorded** and *source linked*.\n\n- First source\n- Second source\n\n| Field | Value |\n| --- | --- |\n| BMI | 24.1 |\n\n[Open source](#/sources?record=synthetic%3A1)\n\n```text\nliteral **characters**\n```'
          }
          onNavigate={navigate}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Your result', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('recorded').tagName).toBe('STRONG');
    expect(screen.getByText('source linked').tagName).toBe('EM');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('table')).toHaveTextContent('BMI24.1');
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute(
      'href',
      '/sources?record=synthetic%3A1',
    );
    expect(screen.getByText('literal **characters**').tagName).toBe('CODE');
    rerender(
      <MemoryRouter>
        <AssistantText content={'Still **streaming'} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Still **streaming')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <AssistantText content={'Still **streaming**'} />
      </MemoryRouter>,
    );
    expect(screen.getByText('streaming').tagName).toBe('STRONG');
  });

  it('keeps external images inert and rejects unsafe navigation targets', () => {
    render(
      <MemoryRouter>
        <AssistantText
          content={
            '![Private scan](https://example.org/tracker)\n\n[bad](javascript:alert) [local](file:///tmp/data) [api](/api/profiles/other/notes) [valid](#/notes?id=synthetic)'
          }
        />
      </MemoryRouter>,
    );
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('[Image: Private scan]')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('sends the actual automatic selection and follows the page on the next message', async () => {
    const server = backend(undefined, (path, init) =>
      path.endsWith('/messages') && init?.method === 'POST' ? json(chat()) : undefined,
    );
    function SelectedPage() {
      const location = useLocation();
      const people = location.pathname === '/people';
      useAssistantSelection(
        {
          collection: people ? 'people' : 'sources',
          id: people ? 'synthetic-person' : 'automatic-file',
        },
        people ? 'Synthetic person' : 'Automatic file',
      );
      return <Link to="/people">View person</Link>;
    }
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/sources']}>
        <AssistantPageProvider>
          <SelectedPage />
          <AssistantLauncher />
        </AssistantPageProvider>
      </MemoryRouter>,
    );
    await open(user);
    expect(screen.getByText('Next message context · Automatic file')).toHaveAttribute(
      'title',
      '/sources',
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'What is this?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(JSON.parse(String(server.writes()[0][1]!.body)).context).toEqual({
      route: '/sources',
      selection: { collection: 'sources', id: 'automatic-file' },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    await screen.findByText(/This run was cancelled/);
    await user.click(screen.getByRole('button', { name: 'Close assistant' }));
    await user.click(screen.getByRole('link', { name: 'View person' }));
    await open(user);
    expect(screen.getByText('Next message context · Synthetic person')).toHaveAttribute(
      'title',
      '/people',
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'And this?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(server.writes()).toHaveLength(3));
    expect(JSON.parse(String(server.writes()[2][1]!.body)).context).toEqual({
      route: '/people',
      selection: { collection: 'people', id: 'synthetic-person' },
    });
  });
});

it('enables automatic setup on send and keeps manual connection checks fictional', async () => {
  replaceProfiles([first, second]);
  selectProfile(first);
  let tested = false;
  const f = backend(undefined, (path, init) => {
    if (path.endsWith('/status'))
      return json({
        available: tested,
        backend: 'litellm',
        model: 'fictional-model',
        readiness: tested ? 'tested' : 'untested',
        capabilities: { tools: true, images: false },
      });
    if (path.endsWith('/test-connection')) {
      expect(JSON.parse(String(init!.body))).toEqual({ image: false });
      tested = true;
      return json({ available: true });
    }
  });
  const user = userEvent.setup();
  mount();
  await open(user);
  const connectionTrigger = screen.getByRole('button', { name: 'Connection: not tested' });
  await user.click(connectionTrigger);
  const diagnostics = await screen.findByRole('dialog', { name: 'Moxie connection' });
  expect(diagnostics).toHaveTextContent('LiteLLM');
  expect(diagnostics).toHaveTextContent('fictional-model');
  expect(diagnostics).toHaveTextContent('Not yet tested');
  expect(screen.queryByText('Connect your agent')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test with a fictional image' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Back to chat' }));
  expect(connectionTrigger).toHaveFocus();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'My private draft');
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  await user.click(connectionTrigger);
  await user.click(screen.getByRole('button', { name: 'Test tools with fictional content' }));
  await screen.findByText('Tested and ready');
  await user.click(screen.getByRole('button', { name: 'Back to chat' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  expect(f.writes().length).toBe(1);
  expect(String(f.writes()[0][1]!.body)).not.toContain('private draft');
});

it('groups exact substantive tool-continuation text into one response and coalesces explicit progress', async () => {
  const current = chat({
    status: 'running',
    messages: [
      { id: 'u', role: 'user', content: 'Compare the fictional sources', createdAt: stamp },
      {
        id: 'a',
        role: 'assistant',
        runId: 'run',
        content: 'The first source lists 12. [First source](#/sources?file=fictional-a)',
        createdAt: stamp,
        status: 'streaming',
      },
      {
        id: 'b',
        role: 'assistant',
        runId: 'run',
        content: 'The second source lists 13. The discrepancy remains unresolved.',
        createdAt: stamp,
        status: 'streaming',
      },
    ],
    runs: [
      {
        id: 'run',
        startedAt: stamp,
        status: 'running',
        usage: null,
        progress: {
          text: 'Checking the remaining sources. <strong>Still working</strong>',
          at: stamp,
        },
      },
    ],
  });
  backend(current);
  const user = userEvent.setup();
  mount();
  await open(user);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), current.id);
  const response = await screen.findByRole('article', { name: 'Moxie message' });
  expect(screen.getAllByRole('article', { name: 'Moxie message' })).toHaveLength(1);
  expect(within(response).getByRole('link', { name: 'First source' })).toHaveAttribute(
    'href',
    '/sources?file=fictional-a',
  );
  expect(
    within(response).getByText('The second source lists 13. The discrepancy remains unresolved.'),
  ).toBeInTheDocument();
  const progress = screen.getByText(
    'Checking the remaining sources. <strong>Still working</strong>',
  );
  expect(progress.closest('[role="status"]')).not.toBeNull();
  expect(progress.querySelector('strong')).toBeNull();
  expect(response).not.toContainElement(progress);
});

it('keeps interrupted attempts and legacy messages distinct when reopening saved responses', async () => {
  const current = chat({
    messages: [
      { id: 'legacy-a', role: 'assistant', content: 'An older saved message.', createdAt: stamp },
      {
        id: 'legacy-b',
        role: 'assistant',
        content: 'Another older saved message.',
        createdAt: stamp,
      },
      {
        id: 'a',
        role: 'assistant',
        runId: 'interrupted',
        content: 'A retained finding.',
        createdAt: stamp,
        status: 'interrupted',
      },
      {
        id: 'b',
        role: 'assistant',
        runId: 'interrupted',
        content: 'An incomplete comparison.',
        createdAt: stamp,
        status: 'interrupted',
      },
      {
        id: 'c',
        role: 'assistant',
        runId: 'retry',
        content: 'A separately verified retry answer.',
        createdAt: stamp,
        status: 'complete',
      },
    ],
    runs: [
      {
        id: 'retry',
        startedAt: stamp,
        status: 'idle',
        usage: null,
        progress: { text: 'Old transient progress.', at: stamp },
      },
    ],
  });
  backend(current);
  const user = userEvent.setup();
  mount();
  await open(user);
  await user.selectOptions(screen.getByRole('combobox', { name: 'Saved chats' }), current.id);
  await screen.findByText('A separately verified retry answer.');
  expect(screen.getAllByRole('article', { name: 'Moxie message' })).toHaveLength(4);
  expect(screen.getAllByText('Previous attempt · interrupted')).toHaveLength(1);
  expect(screen.queryByText('Old transient progress.')).not.toBeInTheDocument();
  expect(screen.getByText('A retained finding.').closest('article')).toContainElement(
    screen.getByText('An incomplete comparison.'),
  );
});
