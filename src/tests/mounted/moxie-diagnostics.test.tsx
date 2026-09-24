import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  MoxieDiagnostics,
  MoxieDiagnosticsTrigger,
} from '../../app/features/assistant/MoxieDiagnostics';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

const first = { id: 'fictional-alpha', name: 'Cookie Dough', placebo: true };
const second = { id: 'fictional-beta', name: 'Stardust', placebo: true };
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data, meta: {} } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  replaceProfiles([first, second]);
  selectProfile(first);
});

it('opens from an import-style trigger, runs only clicked fictional checks, and restores focus', async () => {
  let tested = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    if (path.endsWith('/status'))
      return response({
        available: tested,
        backend: 'litellm',
        model: 'fictional-model-route',
        readiness: tested ? 'tested' : 'untested',
        capabilities: { tools: tested ? true : null, images: false },
        message: tested ? 'Connection ready.' : 'The connection has not been tested.',
      });
    if (path.endsWith('/test-connection') && init.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ image: false });
      tested = true;
      return response({ available: true });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(
    <MoxieDiagnosticsTrigger
      profileId={first.id}
      returnLabel="Back to import"
      label="Fix connection"
    />,
  );

  const trigger = screen.getByRole('button', { name: 'Fix connection' });
  expect(fetch).not.toHaveBeenCalled();
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Moxie connection' });
  expect(dialog).toHaveTextContent('LiteLLM');
  expect(dialog).toHaveTextContent('fictional-model-route');
  expect(dialog).toHaveTextContent('Not yet verified');
  expect(screen.getByRole('button', { name: 'Test with a fictional image' })).toBeDisabled();

  await user.click(screen.getByRole('button', { name: 'Test tools with fictional content' }));
  await waitFor(() => expect(dialog).toHaveTextContent('Tested and ready'));
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Back to import' }));
  expect(screen.queryByRole('dialog', { name: 'Moxie connection' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('reports a failed test, clears it on reopen, and disables tests while caller work is busy', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/status')
        ? response({
            available: false,
            backend: 'litellm',
            readiness: 'unavailable',
            capabilities: { tools: null, images: null },
          })
        : response({ code: 'MODEL_UNAVAILABLE', message: 'Fictional route did not respond.' }, 503),
    ),
  );
  const user = userEvent.setup();
  const view = render(
    <MoxieDiagnosticsTrigger profileId={first.id} returnLabel="Back to import" />,
  );
  await user.click(screen.getByRole('button', { name: 'Connection details' }));
  await screen.findByText('Unavailable');
  await user.click(screen.getByRole('button', { name: 'Test tools with fictional content' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional route did not respond.');
  expect(screen.getByRole('button', { name: 'Test tools with fictional content' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Close diagnostics' }));
  await user.click(screen.getByRole('button', { name: 'Connection details' }));
  expect(screen.queryByText('Fictional route did not respond.')).not.toBeInTheDocument();

  view.unmount();
  render(
    <MoxieDiagnostics
      profileId={first.id}
      open
      onOpenChange={() => {}}
      returnLabel="Back to chat"
      busy
    />,
  );
  await screen.findByText('Unavailable');
  expect(screen.getByRole('button', { name: 'Test tools with fictional content' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Test with a fictional image' })).toBeDisabled();
});

it('does not show status returned for a previously selected profile', async () => {
  let finishFirst: ((value: Response) => void) | undefined;
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes(first.id))
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    return Promise.resolve(
      response({
        available: true,
        backend: 'litellm',
        model: 'second-fictional-route',
        readiness: 'tested',
        capabilities: { tools: true, images: null },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(<MoxieDiagnostics profileId={first.id} open onOpenChange={() => {}} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  act(() => selectProfile(second));
  view.rerender(<MoxieDiagnostics profileId={second.id} open onOpenChange={() => {}} />);
  await screen.findByText('second-fictional-route');
  await act(async () => {
    finishFirst?.(
      response({
        available: true,
        model: 'stale-first-route',
        readiness: 'tested',
      }),
    );
  });
  expect(screen.queryByText('stale-first-route')).not.toBeInTheDocument();
  expect(screen.getByText('second-fictional-route')).toBeInTheDocument();
});

it('tests PDF support with fictional evidence and displays the verified result', async () => {
  let tested = false;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input).endsWith('/test-connection')) {
      expect(JSON.parse(String(init.body))).toEqual({ image: false, pdf: true });
      tested = true;
      return response({ available: true });
    }
    return response({
      available: tested,
      readiness: tested ? 'tested' : 'untested',
      capabilities: { tools: tested ? true : null, images: false, pdf: tested ? true : null },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  render(<MoxieDiagnostics profileId={first.id} open onOpenChange={() => {}} />);
  await screen.findByText('PDF reading');
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Test with a fictional PDF' }));
  await waitFor(() =>
    expect(screen.getByText('PDF reading').parentElement).toHaveTextContent('Verified'),
  );
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
