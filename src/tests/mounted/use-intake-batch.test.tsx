import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useIntakeBatch } from '../../app/features/intake/useIntakeBatch';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

const alpha = {
  id: 'batch-profile-alpha',
  name: 'Cookie Dough',
  placebo: true,
  nameVersion: 1,
  version: 1,
};
const beta = {
  id: 'batch-profile-beta',
  name: 'Stardust',
  placebo: true,
  nameVersion: 1,
  version: 1,
};
const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const intakeBatch = (patch: Record<string, unknown> = {}) => ({
  id: 'active-batch',
  operationId: 'active-operation',
  status: 'running',
  reason: null,
  currentIndex: 0,
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  items: [],
  ...patch,
});

beforeEach(() => {
  replaceProfiles([alpha, beta]);
  selectProfile(alpha);
});

it('does not expose a completed mutation from the previous profile or discard its retry marker', async () => {
  let finishCreate!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finishCreate = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (path.endsWith('/intake-batches') && init.method === 'POST') return delayed;
      if (path.endsWith('/intake-batches')) return json([]);
      throw new Error(`Unmocked request: ${init.method || 'GET'} ${path}`);
    }),
  );
  const view = renderHook(({ profileId }) => useIntakeBatch(profileId), {
    initialProps: { profileId: alpha.id },
  });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  let createPromise!: ReturnType<typeof view.result.current.create>;
  act(() => {
    createPromise = view.result.current.create(['alpha-intake']);
  });
  await waitFor(() => expect(view.result.current.busy).toBe(true));

  selectProfile(beta);
  view.rerender({ profileId: beta.id });
  await waitFor(() => expect(view.result.current.busy).toBe(false));
  finishCreate(
    json({
      id: 'alpha-batch',
      operationId: 'server-operation',
      status: 'running',
      reason: null,
      currentIndex: 0,
      createdAt: '2026-09-01T12:00:00Z',
      updatedAt: '2026-09-01T12:00:00Z',
      items: [],
    }),
  );
  await expect(createPromise).rejects.toThrow('Profile changed');

  expect(view.result.current.batch).toBeNull();
  expect(view.result.current.error).toBe('');
  expect(view.result.current.pendingCreate).toBeNull();
  expect(localStorage.getItem(`circus:intake-batch-create:${alpha.id}`)).toContain('alpha-intake');
  expect(localStorage.getItem(`circus:intake-batch-create:${beta.id}`)).toBeNull();
});

it('keeps a rejected create beside the active batch and does not overwrite its intake selection', async () => {
  const active = {
    id: 'active-batch',
    operationId: 'active-operation',
    status: 'running',
    reason: null,
    currentIndex: 0,
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-01T12:00:00Z',
    items: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST')
        return new Response(
          JSON.stringify({
            error: { code: 'INTAKE_BATCH_BUSY', message: 'A reading batch is already running' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      return json([active]);
    }),
  );
  const view = renderHook(() => useIntakeBatch(alpha.id));
  await waitFor(() => expect(view.result.current.batch?.id).toBe(active.id));

  await expect(view.result.current.create(['new-intake'])).rejects.toThrow(
    'A reading batch is already running',
  );
  await waitFor(() => expect(view.result.current.pendingCreate?.intakeIds).toEqual(['new-intake']));
  expect(view.result.current.batch?.id).toBe(active.id);

  await expect(view.result.current.create(['different-intake'])).rejects.toThrow(
    'Retry the earlier reading request',
  );
  expect(view.result.current.pendingCreate?.intakeIds).toEqual(['new-intake']);
  expect(localStorage.getItem(`circus:intake-batch-create:${alpha.id}`)).toContain('new-intake');
  expect(localStorage.getItem(`circus:intake-batch-create:${alpha.id}`)).not.toContain(
    'different-intake',
  );
});

it('does not let an older history response overwrite a newly created batch', async () => {
  let finishHistory!: (response: Response) => void;
  const history = new Promise<Response>((resolve) => {
    finishHistory = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST')
        return json({
          id: 'new-batch',
          operationId: JSON.parse(String(init.body)).operationId,
          status: 'running',
          reason: null,
          currentIndex: 0,
          createdAt: '2026-09-01T12:00:00Z',
          updatedAt: '2026-09-01T12:00:00Z',
          items: [],
        });
      return history;
    }),
  );
  const view = renderHook(() => useIntakeBatch(alpha.id));
  await act(async () => {
    await view.result.current.create(['new-intake']);
  });
  expect(view.result.current.batch?.id).toBe('new-batch');

  finishHistory(json([]));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.result.current.batch?.id).toBe('new-batch');
});

it('does not let an older history rejection clear a newly created batch', async () => {
  let rejectHistory!: (cause: Error) => void;
  const history = new Promise<Response>((_resolve, reject) => {
    rejectHistory = reject;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST')
        return json(
          intakeBatch({
            id: 'new-batch',
            operationId: JSON.parse(String(init.body)).operationId,
          }),
        );
      return history;
    }),
  );
  const view = renderHook(() => useIntakeBatch(alpha.id));
  await act(async () => {
    await view.result.current.create(['new-intake']);
  });
  expect(view.result.current.batch?.id).toBe('new-batch');

  rejectHistory(new Error('Old history failed'));
  await act(async () => {
    await Promise.resolve();
  });

  expect(view.result.current.batch?.id).toBe('new-batch');
  expect(view.result.current.stop).toBeTypeOf('function');
});

it('uses held history to expose the active batch after a create conflict', async () => {
  let finishHistory!: () => void;
  const history = new Promise<void>((resolve) => {
    finishHistory = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'POST')
        return new Response(
          JSON.stringify({
            error: { code: 'INTAKE_BATCH_BUSY', message: 'A reading batch is already running' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      await history;
      return json([intakeBatch()]);
    }),
  );
  const view = renderHook(() => useIntakeBatch(alpha.id));

  await expect(view.result.current.create(['new-intake'])).rejects.toThrow(
    'A reading batch is already running',
  );
  finishHistory();
  await waitFor(() => expect(view.result.current.batch?.id).toBe('active-batch'));

  expect(view.result.current.error).toBe('A reading batch is already running');
  expect(view.result.current.pendingCreate?.intakeIds).toEqual(['new-intake']);
});

it('does not let a stale poll rejection overwrite a successful resume', async () => {
  vi.useFakeTimers();
  let rejectPoll!: (cause: Error) => void;
  const poll = new Promise<Response>((_resolve, reject) => {
    rejectPoll = reject;
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    if (path.endsWith('/active-batch/resume') && init.method === 'POST') return json(intakeBatch());
    if (path.endsWith('/active-batch')) return poll;
    if (path.endsWith('/intake-batches')) return json([intakeBatch()]);
    throw new Error(`Unmocked request: ${init.method || 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => useIntakeBatch(alpha.id));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.result.current.batch?.id).toBe('active-batch');
  await act(async () => {
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
  });
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/active-batch'))).toBe(true);

  await act(async () => {
    await view.result.current.resume();
    rejectPoll(new Error('Old poll failed'));
    await Promise.resolve();
  });

  expect(view.result.current.batch?.status).toBe('running');
  expect(view.result.current.error).toBe('');
  vi.useRealTimers();
});

it('rejects a captured create callback after the hook has changed profiles', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json([])),
  );
  const view = renderHook(({ profileId }) => useIntakeBatch(profileId), {
    initialProps: { profileId: alpha.id },
  });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  const staleCreate = view.result.current.create;

  selectProfile(beta);
  view.rerender({ profileId: beta.id });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  await expect(staleCreate(['alpha-intake'])).rejects.toThrow(
    'Profile changed before this request started',
  );

  expect(view.result.current.batch).toBeNull();
  expect(view.result.current.pendingCreate).toBeNull();
  expect(view.result.current.error).toBe('');
  expect(localStorage.getItem(`circus:intake-batch-create:${alpha.id}`)).toBeNull();
  expect(localStorage.getItem(`circus:intake-batch-create:${beta.id}`)).toBeNull();
});
