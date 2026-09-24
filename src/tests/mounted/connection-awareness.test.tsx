import { useEffect } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ConnectionNotices, ConnectionStatus } from '../../app/components/ConnectionStatus';
import { clearToasts, ToastViewport } from '../../app/components/Toasts';
import {
  checkConnection,
  connectionSnapshot,
  startConnectionMonitor,
} from '../../app/data/connection';
import { api } from '../../app/data/api';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { registerProfileTransitionEditor } from '../../app/data/profile-transition';

const profile = {
  id: 'fictional-connection',
  name: 'Fictional Robin',
  placebo: true,
  locked: false,
};
let stop: (() => void) | undefined;
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
  clearToasts();
});
afterEach(() => {
  stop?.();
  stop = undefined;
});
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function mount(clientBuildId: string | null = 'fictional-client', refresh = vi.fn()) {
  function Content() {
    useEffect(startConnectionMonitor, []);
    return (
      <>
        <ConnectionStatus />
        <ConnectionNotices clientBuildId={clientBuildId} refresh={refresh} />
        <ToastViewport />
      </>
    );
  }
  return {
    ...render(
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <Content /> }])} />,
    ),
    refresh,
  };
}

it('probes independently, distinguishes network failure from HTTP503 and notifies once per outage', async () => {
  let mode = 'ready';
  const fetch = vi.fn(async (_url: string) => {
    if (mode === 'network') throw new TypeError('Fictional network failure');
    return reply({ encrypted: true, buildId: 'fictional-client' }, mode === 'http' ? 503 : 200);
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Server connection: Connected' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('The local server is responding');
  mode = 'network';
  await act(checkConnection);
  expect(screen.getByRole('button', { name: 'Server connection: Reconnecting' })).toBeVisible();
  await act(checkConnection);
  expect(screen.getAllByText(/Connection interrupted/)).toHaveLength(1);
  mode = 'http';
  await act(checkConnection);
  await user.click(screen.getByRole('button', { name: 'Server connection: Server unavailable' }));
  expect(screen.getByRole('tooltip')).toHaveTextContent('HTTP 503');
  expect(screen.getAllByText(/Connection interrupted/)).toHaveLength(1);
  // Browser internet availability must not prevent a localhost probe.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  mode = 'ready';
  await act(async () => {
    window.dispatchEvent(new Event('offline'));
  });
  await screen.findByRole('button', { name: 'Server connection: Connected' });
  expect(screen.getAllByText(/Connection restored/)).toHaveLength(1);
  expect(fetch.mock.calls.every(([url]) => url === '/api/runtime')).toBe(true);
});

it('times out a hung probe, backs off and coalesces focus checks while one probe is running', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch);
  stop = startConnectionMonitor();
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(connectionSnapshot().status).toBe('reconnecting');
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps an update notice until dismissed for that build pair and never refreshes automatically', async () => {
  let serverBuild = 'fictional-server-b';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ encrypted: true, buildId: serverBuild })),
  );
  const { refresh } = mount('fictional-client-notice');
  const user = userEvent.setup();
  await screen.findByRole('complementary', { name: 'Application update' });
  expect(refresh).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
  await act(checkConnection);
  expect(
    screen.queryByRole('complementary', { name: 'Application update' }),
  ).not.toBeInTheDocument();
  serverBuild = 'fictional-server-c';
  await act(checkConnection);
  expect(screen.getByRole('complementary', { name: 'Application update' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it('uses Save/Discard confirmation for refresh and stays on failed saves or pending attachments', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ encrypted: true, buildId: 'fictional-new' })),
  );
  let attachment = true,
    failed = true;
  const save = vi.fn(async () => {
    if (failed) throw new Error('Fictional unconfirmed save');
  });
  const pause = vi.fn(() => vi.fn());
  const unregister = registerProfileTransitionEditor({
    profileId: profile.id,
    pending: () => true,
    checkReady: () => {
      if (attachment) throw new Error('Fictional attachment pending');
    },
    save,
    pause,
  });
  try {
    const { refresh } = mount('fictional-guard');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fictional attachment pending');
    attachment = false;
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Fictional unconfirmed save');
    expect(refresh).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    failed = false;
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    unregister();
  }
});

it('coalesces safe reads, cancels one subscriber and recovers once without replaying a mutation', async () => {
  let available = false,
    readCalls = 0,
    writeCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      if (url === '/api/runtime')
        return reply({ encrypted: true, buildId: null }, available ? 200 : 503);
      if (options.method === 'PUT') {
        writeCalls++;
        throw new TypeError('Fictional lost write response');
      }
      readCalls++;
      if (!available) throw new TypeError('Fictional unavailable read');
      return reply({ data: { title: 'Fictional recovered data' } });
    }),
  );
  stop = startConnectionMonitor();
  const controller = new AbortController();
  const first = api('/notes', { signal: controller.signal }).catch((error) => error);
  const second = api<{ title: string }>('/notes');
  await waitFor(() => expect(readCalls).toBe(1));
  controller.abort();
  expect((await first).name).toBe('AbortError');
  await expect(api('/notes/example', { method: 'PUT', body: '{}' })).rejects.toThrow(
    'Fictional lost write response',
  );
  available = true;
  await checkConnection();
  expect((await second).data.title).toBe('Fictional recovered data');
  expect(readCalls).toBe(2);
  expect(writeCalls).toBe(1);
});

it('cancels reads waiting for recovery when the profile changes and never replays them in another profile', async () => {
  let available = false,
    reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/runtime') return reply({ encrypted: true }, available ? 200 : 503);
      reads++;
      throw new TypeError('Fictional offline');
    }),
  );
  stop = startConnectionMonitor();
  const pending = api('/notes').catch((error) => error);
  await waitFor(() => expect(reads).toBe(1));
  selectProfile({ ...profile, id: 'fictional-other' });
  expect((await pending).name).toBe('AbortError');
  available = true;
  await checkConnection();
  expect(reads).toBe(1);
});

it('includes a response-body transport failure in the one safe read retry', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/runtime') return reply({ encrypted: true, buildId: null });
      reads++;
      if (reads === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('Fictional partial body'));
            },
          }),
        );
      return reply({ data: 'Recovered fictional body' });
    }),
  );
  stop = startConnectionMonitor();
  expect((await api('/notes')).data).toBe('Recovered fictional body');
  expect(reads).toBe(2);
});
