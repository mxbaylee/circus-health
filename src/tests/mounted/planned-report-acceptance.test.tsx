import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { usePlannedReportAcceptance } from '../../app/features/import/usePlannedReportAcceptance';
import { ImportAcceptanceOutcomes } from '../../app/features/import/ImportAcceptanceOutcomes';
import { replaceProfiles, selectProfile, useProfile } from '../../app/data/profile';
import type {
  IntakeReportAcceptanceBlock,
  IntakeReportAcceptanceRequest,
  IntakeReportAcceptanceResult,
} from '../../shared/intake';

const profile = { id: 'fictional-planned-save', name: 'Fictional Reader', placebo: true };
const block = (index: number): IntakeReportAcceptanceBlock => ({
  intakeId: 'fictional-intake',
  proposalId: `fictional-proposal-${index}`,
  intakeVersion: 1,
  reviewToken: 'fictional-review',
  selections: [
    {
      recordId: `record-${index}`,
      candidateId: `candidate-${index}`,
      candidateVersionId: `version-${index}`,
      selectionReviewToken: `token-${index}`,
      mapping: { kind: 'observation', testLabel: `Fictional result ${index}` },
    },
  ],
});
const chunks = [block(0), block(1), block(2)].map((item) => [item]);
const json = (data: unknown, status = 200) =>
  Response.json(status < 400 ? { data } : { error: data }, { status });
function result(request: IntakeReportAcceptanceRequest): IntakeReportAcceptanceResult {
  return {
    replayed: false,
    durability: { pending: false, mutationRevision: 1, persistedRevision: 1, error: null },
    receipt: {
      version: 1,
      operationId: request.operationId,
      status: 'completed',
      atomic: false,
      at: '2026-10-16',
      selectedCount: 1,
      acceptedCount: 0,
      receipts: [],
      items: request.blocks.flatMap((part) =>
        part.selections.map((selection) => ({
          ...selection,
          selectionReviewToken: selection.selectionReviewToken!,
          intakeId: part.intakeId,
          proposalId: part.proposalId,
          operationId: request.operationId + '-item',
          reviewedSelectionHash: 'fictional-hash',
          status: 'needs_review' as const,
          personId: 'patient',
          message: 'Review again.',
        })),
      ),
    },
  };
}
beforeEach(() => {
  sessionStorage.clear();
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('stops after an unknown second child, counts every selected item, and reconciles only its original ID', async () => {
  const posts: IntakeReportAcceptanceRequest[] = [];
  let recovered = false;
  const fetcher = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/report-acceptance-plan'))
      return json({ planId: 'fictional-plan', chunks, unsent: [] });
    if (url.endsWith('/report-acceptance') && init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as IntakeReportAcceptanceRequest;
      posts.push(request);
      if (posts.length === 2) throw new TypeError('Fictional lost reply');
      const response = result(request);
      if (!response.receipt.atomic) {
        response.receipt.items[0]!.status = 'saved';
        response.receipt.acceptedCount = 1;
      }
      return json(response);
    }
    if (url.includes('/report-acceptance/'))
      return recovered ? json(result(posts[1]!)) : json({ message: 'No receipt.' }, 404);
    if (url.endsWith('/record-ownership/people')) return json([]);
    throw Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() => usePlannedReportAcceptance(profile.id, vi.fn()));
  await act(() => view.result.current.save(chunks.flat()));
  expect(posts).toHaveLength(2);
  expect(posts.map((request) => request.plan)).toEqual([
    { id: 'fictional-plan', chunk: 0 },
    { id: 'fictional-plan', chunk: 1 },
  ]);
  expect(view.result.current.receipt?.acceptedCount).toBe(1);
  expect(view.result.current.unknown).toHaveLength(1);
  expect(view.result.current.unsent).toHaveLength(1);
  const focus = document.createElement('button');
  focus.textContent = 'Fictional retained focus';
  document.body.append(focus);
  focus.focus();
  const outcomes = render(
    <MemoryRouter>
      <ImportAcceptanceOutcomes
        receipt={view.result.current.receipt}
        unknown={view.result.current.unknown}
        unsent={view.result.current.unsent}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    '1 saved, 1 checking save status, 1 not sent',
  );
  expect(focus).toHaveFocus();
  await act(() => view.result.current.save(chunks.flat()));
  expect(posts).toHaveLength(2);
  recovered = true;
  await act(() => view.result.current.checkReceipt());
  expect(view.result.current.unknown).toHaveLength(0);
  expect(view.result.current.receipt?.selectedCount).toBe(2);
  expect(view.result.current.unsent).toHaveLength(1);
  expect(posts).toHaveLength(2);
  expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(posts[1]!.operationId);
  outcomes.unmount();
  focus.remove();
});

it.each(['switch', 'lock'] as const)(
  'isolates a late child acknowledgement after profile %s and recovers the original UUID on return',
  async (transition) => {
    const next = { ...profile, id: 'fictional-other-profile' };
    replaceProfiles([profile, next]);
    let release!: (response: Response) => void;
    let issued!: IntakeReportAcceptanceRequest;
    let recover = false;
    const confirmed = vi.fn();
    const fetcher = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/report-acceptance-plan'))
        return json({ planId: 'fictional-plan', chunks, unsent: [] });
      if (init?.method === 'POST') {
        issued = JSON.parse(String(init.body));
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      if (url.includes('/report-acceptance/'))
        return recover ? json(result(issued)) : json({ message: 'No receipt.' }, 404);
      if (url.endsWith('/record-ownership/people')) return json([]);
      throw Error('Unexpected request: ' + url);
    });
    vi.stubGlobal('fetch', fetcher);
    let saving!: Promise<IntakeReportAcceptanceResult[]>;
    function Harness() {
      const selected = useProfile();
      const acceptance = usePlannedReportAcceptance(selected?.id || '', confirmed);
      return (
        <>
          <p>{selected ? selected.id : 'Profile locked'}</p>
          <button
            type="button"
            disabled={!selected || !!acceptance.recoveryOperationId}
            onClick={() => {
              saving = acceptance.save(chunks.flat());
            }}
          >
            Save fictional selection
          </button>
          <ImportAcceptanceOutcomes
            receipt={acceptance.receipt}
            unknown={acceptance.unknown}
            unsent={acceptance.unsent}
          />
        </>
      );
    }
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save fictional selection' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => {
      if (transition === 'switch') selectProfile(next);
      else replaceProfiles([{ ...profile, locked: true }, next]);
    });
    await act(async () => {
      release(json(result(issued)));
      await saving;
    });
    expect(confirmed).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Save outcomes' })).toBeNull();
    expect(screen.getByText(transition === 'switch' ? next.id : 'Profile locked')).toBeVisible();
    expect(sessionStorage.getItem('circus-health:report-acceptance:' + profile.id)).toBe(
      issued.operationId,
    );
    recover = true;
    act(() => {
      replaceProfiles([profile, next]);
      selectProfile(profile);
    });
    await waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2); // One plan and one issued child.
  },
);

it('reconciles an issued child after the view changes without decorating the new view or sending its successors', async () => {
  const posts: IntakeReportAcceptanceRequest[] = [];
  let release!: (response: Response) => void;
  let scope = 'fictional-original-view';
  const confirmed = vi.fn();
  const progress = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/report-acceptance-plan')) {
        const requested = JSON.parse(String(init?.body)) as {
          blocks: IntakeReportAcceptanceBlock[];
        };
        return json({
          planId: 'fictional-plan',
          chunks: requested.blocks.map((item) => [item]),
          unsent: [],
        });
      }
      if (url.endsWith('/report-acceptance') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as IntakeReportAcceptanceRequest;
        posts.push(request);
        if (posts.length === 2)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return json(result(request));
      }
      throw Error('Unexpected request: ' + url);
    }),
  );
  const view = renderHook(() => usePlannedReportAcceptance(profile.id, confirmed));
  let saving!: Promise<IntakeReportAcceptanceResult[]>;
  act(() => {
    const originalScope = scope;
    saving = view.result.current.save(chunks.flat(), {
      current: () => scope === originalScope,
      onProgress: progress,
    });
  });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  expect(confirmed).toHaveBeenCalledOnce();
  expect(view.result.current.receipt?.selectedCount).toBe(1);
  scope = 'fictional-filtered-view';
  view.rerender();
  let settled!: IntakeReportAcceptanceResult[];
  await act(async () => {
    release(json(result(posts[1]!)));
    settled = await saving;
  });
  expect(confirmed).toHaveBeenCalledOnce();
  expect(posts).toHaveLength(2);
  expect(progress.mock.calls).toEqual([[1, 3]]);
  // Outcomes belong to the original operation, independently of the feed window.
  expect(view.result.current.receipt?.selectedCount).toBe(2);
  expect(view.result.current.unsent).toHaveLength(1);
  expect(view.result.current.unsent[0]?.reason).toContain('review view changed');
  expect(settled.map((item) => item.receipt.operationId)).toEqual(
    posts.map((item) => item.operationId),
  );
  expect(view.result.current.recoveryOperationId).toBeNull();
  expect(sessionStorage.getItem('circus-health:report-acceptance:' + profile.id)).toBeNull();
  expect(view.result.current.unknown).toEqual([]);
  await act(() => view.result.current.save([block(3)]));
  expect(posts).toHaveLength(3);
  expect(confirmed).toHaveBeenCalledTimes(2);
  expect(view.result.current.receipt?.selectedCount).toBe(1);
});

it('retains the original unknown child across a view change and recovers its UUID on remount', async () => {
  const posts: IntakeReportAcceptanceRequest[] = [];
  let release!: (response: Response) => void;
  let current = true;
  let recovered = false;
  const confirmed = vi.fn();
  const fetcher = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/report-acceptance-plan'))
      return json({ planId: 'fictional-plan', chunks, unsent: [] });
    if (url.endsWith('/report-acceptance') && init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as IntakeReportAcceptanceRequest;
      posts.push(request);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    if (url.includes('/report-acceptance/'))
      return recovered ? json(result(posts[0]!)) : json({ message: 'No receipt.' }, 404);
    throw Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() => usePlannedReportAcceptance(profile.id, confirmed));
  let saving!: Promise<IntakeReportAcceptanceResult[]>;
  act(() => {
    saving = view.result.current.save(chunks.flat(), { current: () => current });
  });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  current = false;
  view.rerender();
  await act(async () => {
    release(json({ message: 'Fictional unavailable outcome.' }, 503));
    await saving;
  });
  expect(confirmed).not.toHaveBeenCalled();
  expect(posts).toHaveLength(1);
  expect(view.result.current.unknown.map((item) => item.operationId)).toEqual([
    posts[0]!.operationId,
  ]);
  expect(view.result.current.unsent).toHaveLength(2);
  expect(view.result.current.recoveryOperationId).toBe(posts[0]!.operationId);
  expect(sessionStorage.getItem('circus-health:report-acceptance:' + profile.id)).toBe(
    posts[0]!.operationId,
  );
  await act(() => view.result.current.save(chunks.flat()));
  expect(posts).toHaveLength(1);
  view.unmount();
  recovered = true;
  const returned = renderHook(() => usePlannedReportAcceptance(profile.id, confirmed));
  await waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
  expect(returned.result.current.receipt?.operationId).toBe(posts[0]!.operationId);
  expect(returned.result.current.recoveryOperationId).toBeNull();
  expect(posts).toHaveLength(1);
  expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(posts[0]!.operationId);
});

it('keeps confirmed results when a later plan is refused and leaves every unissued selection unsent', async () => {
  const posts: IntakeReportAcceptanceRequest[] = [];
  let plans = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/report-acceptance-plan')) {
        plans++;
        return json({ planId: 'fictional-plan', chunks, unsent: [] });
      }
      if (url.endsWith('/report-acceptance') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as IntakeReportAcceptanceRequest;
        posts.push(request);
        return posts.length === 1
          ? json(result(request))
          : json(
              {
                code: 'ACCEPTANCE_PLAN_CHANGED',
                message: 'Review the changed relationship before saving again.',
              },
              409,
            );
      }
      if (url.includes('/report-acceptance/')) return json({ message: 'No receipt.' }, 404);
      throw Error('Unexpected request: ' + url);
    }),
  );
  const view = renderHook(() => usePlannedReportAcceptance(profile.id, vi.fn()));
  await act(() => view.result.current.save(chunks.flat()));
  expect(plans).toBe(1);
  expect(posts).toHaveLength(2);
  expect(view.result.current.receipt?.selectedCount).toBe(1);
  expect(view.result.current.unsent).toHaveLength(2);
  expect(view.result.current.unknown).toEqual([]);
  expect(view.result.current.recoveryOperationId).toBeNull();
  expect(view.result.current.error).toContain('Review the changed relationship');
});

it('abandons a delayed plan after leaving and returning to the same profile without issuing a child', async () => {
  const next = { ...profile, id: 'fictional-plan-transition' };
  replaceProfiles([profile, next]);
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(({ id }) => usePlannedReportAcceptance(id, vi.fn()), {
    initialProps: { id: profile.id },
  });
  let saving!: Promise<IntakeReportAcceptanceResult[]>;
  const staleSave = view.result.current.save;
  act(() => {
    saving = staleSave(chunks.flat());
  });
  act(() => selectProfile(next));
  view.rerender({ id: next.id });
  await act(() => staleSave(chunks.flat()));
  expect(fetcher).toHaveBeenCalledOnce();
  act(() => selectProfile(profile));
  view.rerender({ id: profile.id });
  await act(async () => {
    release(json({ planId: 'fictional-old-plan', chunks, unsent: [] }));
    await saving;
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(view.result.current.receipt).toBeNull();
  expect(view.result.current.recoveryOperationId).toBeNull();
});
