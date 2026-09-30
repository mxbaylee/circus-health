import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useReviewDrafts } from '../../app/features/intake/useReviewDrafts';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { Intake, IntakeReview, IntakeReviewRecord } from '../../shared/intake';

const profile = { id: 'fictional-draft-scope', name: 'Fictional Person', placebo: true };
const intake = {
  id: 'fictional-draft-intake',
  version: 7,
  filename: 'fictional.txt',
  mimeType: 'text/plain',
  providerId: 'fictional-provider',
  provider: 'Fictional Clinic',
  sha256: 'fictional-sha',
  bytes: 100,
  contentUrl: '/api/sources/fictional-draft-intake/content',
} as Intake;
const record = {
  id: 'fictional-record',
  candidateId: 'fictional-candidate',
  candidateVersionId: 'fictional-candidate-v1',
  title: 'Fictional marker',
  date: null,
  provider: 'Fictional Clinic',
  kind: 'observation',
  classification: 'addition',
  reviewState: 'pending',
  confidence: 0.9,
  uncertainties: [],
  mapping: { kind: 'observation', testLabel: 'Fictional marker', valueText: '42' },
  evidence: [],
  issues: [],
  questions: [],
  supportedFields: ['testLabel', 'valueText'],
} as IntakeReviewRecord;
const review = (version: number, valueText: string): IntakeReview => ({
  intakeId: intake.id,
  proposalId: 'fictional-proposal',
  version,
  reviewToken: `fictional-token-${version}`,
  summary: { additions: 1, duplicates: 0, unsupported: 0, uncertain: 0 },
  records: [{ ...record, mapping: { ...record.mapping, valueText } }],
  sourceContext: [],
  coverageGaps: [],
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('requires another comparison when the saved draft changes before a conflict choice', async () => {
  let reads = 0;
  let writes = 0;
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/review-draft')) {
        writes += 1;
        bodies.push(JSON.parse(String(init?.body)));
        if (writes === 1)
          return json({ code: 'VERSION_CONFLICT', message: 'Review changed.' }, 409);
        return json({ ...intake, version: 10 });
      }
      if (url.includes('/review?proposalId=')) {
        reads += 1;
        return json(reads === 1 ? review(8, '44') : review(9, '45'));
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const saved = vi.fn();
  const view = renderHook(() => useReviewDrafts(profile.id, saved));
  act(() => view.result.current.hydrate(review(7, '42')));
  const initialRecord = review(7, '42').records[0];
  act(() => {
    const current = view.result.current.current(review(7, '42'), initialRecord);
    view.result.current.update(review(7, '42'), initialRecord, {
      decision: {
        ...current.decision,
        mapping: { ...current.decision.mapping, valueText: '43' },
      },
    });
  });
  await act(() => view.result.current.flush());
  await waitFor(() => expect(view.result.current.conflict).toBe(true));
  await act(() => view.result.current.inspectConflict());
  expect(view.result.current.comparison?.record.mapping.valueText).toBe('44');

  await act(() => view.result.current.reapply());
  expect(writes).toBe(1);
  expect(view.result.current.comparison?.record.mapping.valueText).toBe('45');
  expect(view.result.current.error).toMatch(/changed again/i);

  await act(() => view.result.current.reapply());
  expect(writes).toBe(2);
  expect(bodies[1]).toMatchObject({ version: 9, mapping: { valueText: '43' } });
  expect(saved).toHaveBeenCalledWith({ ...intake, version: 10 });
});

it('does not install a stale saved draft when choosing the current fields', async () => {
  let reads = 0;
  let writes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/review-draft')) {
        writes += 1;
        return json({ code: 'VERSION_CONFLICT', message: 'Review changed.' }, 409);
      }
      if (url.includes('/review?proposalId=')) {
        reads += 1;
        return json(reads === 1 ? review(8, '44') : review(9, '45'));
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const view = renderHook(() => useReviewDrafts(profile.id, vi.fn()));
  const loaded = review(7, '42');
  const loadedRecord = loaded.records[0];
  act(() => view.result.current.hydrate(loaded));
  act(() => {
    const current = view.result.current.current(loaded, loadedRecord);
    view.result.current.update(loaded, loadedRecord, {
      decision: {
        ...current.decision,
        mapping: { ...current.decision.mapping, valueText: '43' },
      },
    });
  });
  await act(() => view.result.current.flush());
  await act(() => view.result.current.inspectConflict());

  await act(() => view.result.current.useCurrent());
  expect(view.result.current.comparison?.record.mapping.valueText).toBe('45');
  expect(view.result.current.error).toMatch(/changed again/i);

  await act(() => view.result.current.useCurrent());
  const newest = review(9, '45');
  expect(view.result.current.comparison).toBeNull();
  expect(view.result.current.current(newest, newest.records[0]).decision.mapping.valueText).toBe(
    '45',
  );
  expect(writes).toBe(1);
});

it('binds a coalesced correction reason to its exact patch, retries unchanged, then clears it before unrelated edits', async () => {
  const requests: Record<string, unknown>[] = [];
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, options) => {
      requests.push(JSON.parse(String(options?.body)));
      if (fail) {
        fail = false;
        throw new TypeError('Lost fictional response');
      }
      return json({ ...intake, version: requests.length + 7 });
    }),
  );
  const view = renderHook(() => useReviewDrafts(profile.id, () => {}));
  const initial = review(7, '42'),
    row = initial.records[0]!;
  act(() => view.result.current.hydrate(initial));
  act(() => {
    const local = view.result.current.current(initial, row);
    view.result.current.update(initial, row, {
      decision: { ...local.decision, mapping: { ...local.decision.mapping, valueText: '43' } },
      correctionReason: 'Read the original digit',
    });
    view.result.current.update(initial, row, { disposition: 'review_later' });
  });
  await act(() => view.result.current.flush());
  expect(requests[0].correctionReason).toBe('Read the original digit');
  expect(requests[0].correctionPatch).toEqual({ valueText: '43' });
  await act(() => view.result.current.retry());
  expect(requests[1]).toEqual(requests[0]);
  expect(view.result.current.current(initial, row).correctionReason).toBeUndefined();
  act(() => view.result.current.update(initial, row, { disposition: 'pending' }));
  await act(() => view.result.current.flush());
  expect(requests[2].correctionReason).toBeUndefined();
  act(() => {
    const local = view.result.current.current(initial, row);
    view.result.current.update(initial, row, {
      decision: { ...local.decision, mapping: { ...local.decision.mapping, unit: 'mg' } },
    });
  });
  await act(() => view.result.current.flush());
  expect(requests[3].correctionReason).toBeUndefined();
});

it('keeps an unsent correction reason visible after another field is edited', () => {
  const view = renderHook(() => useReviewDrafts(profile.id, vi.fn()));
  const initial = review(7, '42');
  const row = initial.records[0]!;
  act(() => {
    view.result.current.hydrate(initial);
    view.result.current.update(initial, row, {
      correctionReason: 'Read the fictional source digit',
    });
    const local = view.result.current.current(initial, row);
    view.result.current.update(initial, row, {
      decision: { ...local.decision, mapping: { ...local.decision.mapping, unit: 'mg' } },
    });
  });
  expect(view.result.current.current(initial, row).correctionReason).toBe(
    'Read the fictional source digit',
  );
});
