import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { useIntakeBatch } from '../../app/features/intake/useIntakeBatch';

const profile = {
  id: 'fictional-background-profile',
  name: 'Fictional Reader',
  placebo: true,
  nameVersion: 1,
  version: 1,
};

const json = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const batch = (status: 'running' | 'complete') => ({
  id: 'fictional-background-batch',
  operationId: 'fictional-background-operation',
  status,
  reason: null,
  currentIndex: status === 'running' ? 0 : 1,
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: status === 'running' ? '2026-09-01T12:00:01Z' : '2026-09-01T12:00:05Z',
  items: [],
});

beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('leaves server reading alone on navigation and discovers its result on return', async () => {
  let historyReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input);
    if (path.endsWith('/intake-batches') && !init.method) {
      historyReads++;
      return json([batch(historyReads === 1 ? 'running' : 'complete')]);
    }
    throw new Error(`Unmocked request: ${init.method || 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const firstVisit = renderHook(() => useIntakeBatch(profile.id));
  await waitFor(() => expect(firstVisit.result.current.batch?.status).toBe('running'));

  firstVisit.unmount();
  expect(fetchMock.mock.calls).toHaveLength(1);
  expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(
    true,
  );

  const returnVisit = renderHook(() => useIntakeBatch(profile.id));
  await waitFor(() => expect(returnVisit.result.current.batch?.status).toBe('complete'));

  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(
    fetchMock.mock.calls.some(
      ([input, init]) =>
        /(stop|cancel)$/.test(String(input)) ||
        (init as RequestInit | undefined)?.method === 'POST',
    ),
  ).toBe(false);
});
