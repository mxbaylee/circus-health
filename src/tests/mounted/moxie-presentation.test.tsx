import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { AssistantLauncher } from '../../app/features/assistant/AssistantLauncher';
import { starterPromptPool } from '../../app/features/assistant/starterPrompts';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { AssistantChat } from '../../app/features/assistant/types';

const state = vi.hoisted(() => ({ chat: null as AssistantChat | null }));
vi.mock('../../app/features/assistant/useAssistantChat', () => ({
  useAssistantChat: () => ({ chat: state.chat, reload: vi.fn(), accept: vi.fn() }),
}));
const view = () => (
  <MemoryRouter>
    <AssistantLauncher />
  </MemoryRouter>
);

beforeEach(() => {
  const profile = { id: 'moxie-fictional', name: 'Moonbeam', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  state.chat = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (!path.endsWith('/status') && !path.endsWith('/chats'))
        throw new Error(`Unexpected request: ${path}`);
      return new Response(
        JSON.stringify({ data: path.endsWith('/status') ? { available: true } : [], meta: {} }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
});

it('fills editable starters without sending and preserves an existing draft', async () => {
  const user = userEvent.setup();
  render(view());
  await user.click(screen.getByRole('button', { name: 'Open assistant' }));
  expect(await screen.findByRole('dialog', { name: 'Moxie the Assistant' })).toBeVisible();
  expect(
    screen.getByText(/Sending shares your question and relevant profile details/),
  ).toHaveTextContent('Hosted models receive that content outside this device');
  const input = screen.getByRole('textbox', { name: 'Message' });
  const starterGroup = screen.getByRole('group', { name: 'Conversation starters' });
  const initialLabels = within(starterGroup)
    .getAllByRole('button')
    .map((button) => button.textContent);
  expect(initialLabels).toHaveLength(4);

  await user.type(input, 'My own question');
  expect(
    within(starterGroup)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(initialLabels);

  const selected = starterPromptPool.find((prompt) => prompt.label === initialLabels[0])!;
  await user.click(within(starterGroup).getByRole('button', { name: selected.label }));
  expect(input).toHaveFocus();
  expect(input).toHaveValue(`My own question\n\n${selected.message}`);
  expect(
    vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('refreshes the four suggestions locally without sending a request', async () => {
  const user = userEvent.setup();
  render(view());
  await user.click(screen.getByRole('button', { name: 'Open assistant' }));
  const starterGroup = await screen.findByRole('group', { name: 'Conversation starters' });
  const before = within(starterGroup)
    .getAllByRole('button')
    .map((button) => button.textContent);

  await user.click(screen.getByRole('button', { name: 'Refresh suggestions' }));

  const after = within(starterGroup)
    .getAllByRole('button')
    .map((button) => button.textContent);
  expect(after).toHaveLength(4);
  expect(after.every((label) => !before.includes(label))).toBe(true);
  expect(
    vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('names Moxie messages and mounts the decorative cartwheel only during running work', async () => {
  const user = userEvent.setup();
  const stamp = '2026-09-01T12:00:00Z';
  state.chat = {
    id: 'fictional-chat',
    title: 'Fictional chat',
    updatedAt: stamp,
    status: 'running',
    messages: [{ id: 'm1', role: 'assistant', content: 'A fictional response', createdAt: stamp }],
  };
  const mounted = render(view());
  await user.click(screen.getByRole('button', { name: 'Open assistant' }));
  expect(await screen.findByRole('article', { name: 'Moxie message' })).toBeVisible();
  const status = screen.getByText('Moxie is responding…').closest('[role="status"]')!;
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(within(status as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
  const sprite = status.querySelector('svg')!;
  expect(sprite).toHaveAttribute('aria-hidden', 'true');
  expect(sprite.querySelectorAll('[data-pose]')).toHaveLength(9);
  for (const next of ['idle', 'failed', 'cancelled'] as const) {
    state.chat = { ...state.chat!, status: next };
    mounted.rerender(view());
    expect(screen.queryByText('Moxie is responding…')).not.toBeInTheDocument();
    expect(document.querySelector('.moxie-jester-alternative')).toBeNull();
  }
});
