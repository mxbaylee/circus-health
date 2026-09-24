import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useReportAcceptance } from '../../app/features/intake/useReportAcceptance';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake';

const profile = { id: 'fictional-acceptance', name: 'Fictional Person', placebo: true, version: 1 };
const request: IntakeReportAcceptanceRequest = {
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  blocks: [
    {
      intakeId: 'fictional-intake',
      proposalId: 'fictional-proposal',
      intakeVersion: 7,
      reviewToken: 'fictional-token',
      selections: [
        {
          recordId: 'fictional-record',
          candidateId: 'fictional-candidate',
          candidateVersionId: 'fictional-version',
          mapping: { kind: 'observation', testLabel: 'Fictional marker', valueText: '12' },
        },
      ],
    },
  ],
};
const result: IntakeReportAcceptanceResult = {
  receipt: {
    operationId: request.operationId,
    status: 'accepted',
    atomic: true,
    at: '2026-09-13T12:00:00Z',
    selectedCount: 1,
    acceptedCount: 1,
    receipts: [
      {
        intakeId: 'fictional-intake',
        proposalId: 'fictional-proposal',
        intakeVersionBefore: 7,
        intakeVersionAfter: 8,
        reviewToken: 'fictional-token',
        records: [
          {
            recordId: 'fictional-record',
            entityId: 'fictional-observation',
            candidateId: 'fictional-candidate',
            candidateVersionId: 'fictional-version',
            kind: 'observation',
            title: 'Fictional marker',
            optical: false,
            outcome: 'added',
          },
        ],
      },
    ],
  },
  replayed: false,
  durability: { pending: false, mutationRevision: 8, persistedRevision: 8, error: null },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  sessionStorage.clear();
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('reconciles a lost save response through its receipt without replaying the mutation', async () => {
  const confirmed = vi.fn();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => useReportAcceptance(profile.id, confirmed));

  await act(() => view.result.current.submit(request));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toContain(`/report-acceptance/${request.operationId}`);
  expect(confirmed).toHaveBeenCalledWith(result);
  expect(view.result.current.pending).toBeNull();
  expect(view.result.current.error).toBe('');
});

it('requires an explicit retry and reuses the exact request when no receipt can be found', async () => {
  const confirmed = vi.fn();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => useReportAcceptance(profile.id, confirmed));

  await act(() => view.result.current.submit(request));
  await waitFor(() => expect(view.result.current.pending).toEqual(request));
  expect(sessionStorage.getItem(`circus-health:report-acceptance:${profile.id}`)).toBe(
    request.operationId,
  );
  expect(confirmed).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await act(() => view.result.current.retry());

  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(request);
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(request);
  expect(confirmed).toHaveBeenCalledWith(result);
  expect(view.result.current.pending).toBeNull();
  expect(sessionStorage.length).toBe(0);
});

it('does not replace an unresolved exact operation with a new submission', async () => {
  const confirmed = vi.fn();
  const nextRequest = structuredClone(request);
  nextRequest.operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => useReportAcceptance(profile.id, confirmed));

  await act(() => view.result.current.submit(request));
  await waitFor(() => expect(view.result.current.pending).toEqual(request));
  await act(() => view.result.current.submit(nextRequest));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(view.result.current.pending).toEqual(request);
  expect(view.result.current.recoveryOperationId).toBe(request.operationId);
  await act(() => view.result.current.retry());
});

it('shares an unresolved exact operation across concurrently mounted acceptance controls', async () => {
  const confirmed = vi.fn();
  const nextRequest = structuredClone(request);
  nextRequest.operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => ({
    detail: useReportAcceptance(profile.id, confirmed),
    overview: useReportAcceptance(profile.id, confirmed),
  }));

  await act(() => view.result.current.detail.submit(request));
  await waitFor(() => expect(view.result.current.detail.pending).toEqual(request));
  await act(() => view.result.current.overview.submit(nextRequest));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(view.result.current.overview.pending).toEqual(request);
  expect(view.result.current.overview.recoveryOperationId).toBe(request.operationId);

  await act(() => view.result.current.detail.retry());
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(request);
  expect(confirmed).toHaveBeenCalledWith(result);
});

it('keeps peer receipt checks from clearing an exact save that is still in flight', async () => {
  const confirmed = vi.fn();
  const nextRequest = structuredClone(request);
  nextRequest.operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  let settle!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  const fetchMock = vi.fn().mockImplementationOnce(() => response);
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => ({
    detail: useReportAcceptance(profile.id, confirmed),
    overview: useReportAcceptance(profile.id, confirmed),
  }));

  let saving!: Promise<IntakeReportAcceptanceResult | null>;
  act(() => {
    saving = view.result.current.detail.submit(request);
  });
  await waitFor(() => expect(view.result.current.overview.pending).toEqual(request));
  await act(() => view.result.current.overview.checkReceipt());
  await act(() => view.result.current.overview.retry());
  await act(() => view.result.current.overview.submit(nextRequest));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(view.result.current.overview.recoveryOperationId).toBe(request.operationId);
  await act(async () => {
    settle(json(result));
    await saving;
  });
  expect(confirmed).toHaveBeenCalledWith(result);
});

it('retains the exact mounted-session recovery gate when session storage is unavailable', async () => {
  const confirmed = vi.fn();
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Fictional storage unavailable');
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Fictional storage unavailable');
  });
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('Fictional storage unavailable');
  });
  const nextRequest = structuredClone(request);
  nextRequest.operationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => useReportAcceptance(profile.id, confirmed));

  await act(() => view.result.current.submit(request));
  await waitFor(() => expect(view.result.current.pending).toEqual(request));
  await act(() => view.result.current.submit(nextRequest));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(view.result.current.recoveryOperationId).toBe(request.operationId);
  await act(() => view.result.current.retry());
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(request);
  expect(confirmed).toHaveBeenCalledWith(result);
  getItem.mockRestore();
  setItem.mockRestore();
  removeItem.mockRestore();
});

it('retains the exact in-memory retry after an uncertain control unmounts', async () => {
  const confirmed = vi.fn();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockRejectedValueOnce(new TypeError('Fictional receipt check still unavailable'))
    .mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);
  const first = renderHook(() => useReportAcceptance(profile.id, confirmed));

  await act(() => first.result.current.submit(request));
  await waitFor(() => expect(first.result.current.pending).toEqual(request));
  first.unmount();

  const restored = renderHook(() => useReportAcceptance(profile.id, confirmed));
  await waitFor(() => expect(restored.result.current.recovering).toBe(false));
  expect(restored.result.current.pending).toEqual(request);
  await act(() => restored.result.current.retry());

  expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual(request);
  expect(confirmed).toHaveBeenCalledWith(result);
});

it('discards the clinical retry payload when its profile is switched away', async () => {
  const next = { ...profile, id: 'fictional-payload-eviction' };
  replaceProfiles([profile, next]);
  const confirmed = vi.fn();
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Fictional connection loss'))
    .mockResolvedValueOnce(json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404))
    .mockRejectedValueOnce(new TypeError('Fictional receipt check unavailable'));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(({ id }) => useReportAcceptance(id, confirmed), {
    initialProps: { id: profile.id },
  });

  await act(() => view.result.current.submit(request));
  await waitFor(() => expect(view.result.current.pending).toEqual(request));
  act(() => selectProfile(next));
  view.rerender({ id: next.id });
  act(() => selectProfile(profile));
  view.rerender({ id: profile.id });

  await waitFor(() => expect(view.result.current.recovering).toBe(false));
  expect(view.result.current.recoveryOperationId).toBe(request.operationId);
  expect(view.result.current.pending).toBeNull();
  await act(() => view.result.current.retry());
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each(['switch', 'lock'] as const)(
  'does not let a stale profile callback restore clinical retry state after a %s',
  async (transition) => {
    const next = { ...profile, id: `fictional-stale-${transition}` };
    replaceProfiles([profile, next]);
    selectProfile(profile);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const view = renderHook(({ id }) => useReportAcceptance(id, vi.fn()), {
      initialProps: { id: profile.id },
    });
    const staleSubmit = view.result.current.submit;

    act(() => {
      if (transition === 'switch') selectProfile(next);
      else replaceProfiles([{ ...profile, locked: true }, next]);
    });
    view.rerender({ id: transition === 'switch' ? next.id : '' });
    await act(() => staleSubmit(request));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(`circus-health:report-acceptance:${profile.id}`)).toBeNull();

    act(() => {
      if (transition === 'lock') replaceProfiles([profile, next]);
      selectProfile(profile);
    });
    view.rerender({ id: profile.id });
    await waitFor(() => {
      expect(view.result.current.pending).toBeNull();
      expect(view.result.current.recoveryOperationId).toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('does not let a delayed old receipt miss clear a newer uncertain operation', async () => {
  const confirmed = vi.fn();
  const nextRequest = structuredClone(request);
  nextRequest.operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const nextResult = structuredClone(result);
  nextResult.receipt.operationId = nextRequest.operationId;
  let settleOldReceipt!: (response: Response) => void;
  let oldReceiptReads = 0;
  const postCounts = new Map<string, number>();
  const fetchMock = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/report-acceptance/${request.operationId}`)) {
      oldReceiptReads += 1;
      if (oldReceiptReads === 1)
        return json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404);
      return new Promise<Response>((resolve) => {
        settleOldReceipt = resolve;
      });
    }
    if (url.endsWith(`/report-acceptance/${nextRequest.operationId}`))
      return json({ code: 'NOT_FOUND', message: 'No saved receipt.' }, 404);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as IntakeReportAcceptanceRequest;
      const count = (postCounts.get(body.operationId) || 0) + 1;
      postCounts.set(body.operationId, count);
      if (count === 1) throw new TypeError('Fictional connection loss');
      return json(body.operationId === request.operationId ? result : nextResult);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(() => ({
    first: useReportAcceptance(profile.id, confirmed),
    second: useReportAcceptance(profile.id, confirmed),
  }));
  await act(() => view.result.current.first.submit(request));
  await waitFor(() => expect(view.result.current.first.pending).toEqual(request));
  let staleCheck!: Promise<IntakeReportAcceptanceResult | null>;
  act(() => {
    staleCheck = view.result.current.second.checkReceipt();
  });
  await waitFor(() => expect(oldReceiptReads).toBe(2));

  await act(() => view.result.current.first.retry());
  await act(() => view.result.current.first.submit(nextRequest));
  await waitFor(() => expect(view.result.current.first.pending).toEqual(nextRequest));

  await act(async () => {
    settleOldReceipt(json({ code: 'NOT_FOUND' }, 404));
    await staleCheck;
  });
  expect(view.result.current.first.recoveryOperationId).toBe(nextRequest.operationId);
  expect(view.result.current.first.pending).toEqual(nextRequest);
  await act(() => view.result.current.first.retry());
  expect(confirmed).toHaveBeenCalledWith(nextResult);
});

it('checks a profile-scoped operation receipt after reload before allowing another save', async () => {
  sessionStorage.setItem(`circus-health:report-acceptance:${profile.id}`, request.operationId);
  const confirmed = vi.fn();
  const fetchMock = vi.fn().mockResolvedValueOnce(json(result));
  vi.stubGlobal('fetch', fetchMock);

  const view = renderHook(() => useReportAcceptance(profile.id, confirmed));

  expect(view.result.current.recoveryOperationId).toBe(request.operationId);
  await waitFor(() => expect(confirmed).toHaveBeenCalledWith(result));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  expect(String(fetchMock.mock.calls[0][0])).toContain(`/report-acceptance/${request.operationId}`);
  expect(view.result.current.recoveryOperationId).toBeNull();
  expect(sessionStorage.length).toBe(0);
});

it('ignores a manual receipt lookup that settles after switching profiles', async () => {
  sessionStorage.setItem(`circus-health:report-acceptance:${profile.id}`, request.operationId);
  const next = { ...profile, id: 'fictional-next-profile' };
  replaceProfiles([profile, next]);
  const confirmed = vi.fn();
  let settle!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Fictional offline'))
      .mockImplementationOnce(() => response),
  );
  const view = renderHook(({ id }) => useReportAcceptance(id, confirmed), {
    initialProps: { id: profile.id },
  });
  await waitFor(() => expect(view.result.current.error).not.toBe(''));
  let checking!: Promise<IntakeReportAcceptanceResult | null>;
  act(() => {
    checking = view.result.current.checkReceipt();
  });
  act(() => {
    selectProfile(next);
  });
  view.rerender({ id: next.id });
  await act(async () => {
    settle(json(result));
    await checking;
  });
  expect(confirmed).not.toHaveBeenCalled();
  expect(view.result.current.error).toBe('');
  expect(view.result.current.recoveryOperationId).toBeNull();
  expect(sessionStorage.getItem(`circus-health:report-acceptance:${profile.id}`)).toBe(
    request.operationId,
  );
});
