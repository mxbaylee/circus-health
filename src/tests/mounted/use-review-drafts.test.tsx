import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useReviewDrafts } from '../../app/features/intake/useReviewDrafts';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type {
  Intake,
  IntakePairDecision,
  IntakeReview,
  IntakeReviewRecord,
} from '../../shared/intake';

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
      if (url.includes('/review-record?')) {
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
      if (url.includes('/review-record?')) {
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

it.each(['answers', 'resolutions', 'disposition'] as const)(
  'keeps an unsent explanation visible without attaching it to an unrelated %s save',
  async (field) => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, options) => {
        requests.push(JSON.parse(String(options?.body)));
        return json({ ...intake, version: 8 });
      }),
    );
    const view = renderHook(() => useReviewDrafts(profile.id, vi.fn()));
    const initial = review(7, '42');
    const row = initial.records[0]!;
    act(() => {
      view.result.current.hydrate(initial);
      view.result.current.update(initial, row, {
        correctionReason: 'Fictional explanation awaiting its correction',
      });
      if (field === 'answers')
        view.result.current.update(initial, row, {
          answers: { fictional: 'Reviewed the original' },
        });
      if (field === 'resolutions')
        view.result.current.update(initial, row, {
          resolutions: [{ issueId: 'fictional-issue', outcome: 'acknowledged' }],
        });
      if (field === 'disposition')
        view.result.current.update(initial, row, { disposition: 'review_later' });
    });
    await act(() => view.result.current.flush());
    expect(requests).toHaveLength(1);
    expect(requests[0].correctionReason).toBeUndefined();
    expect(view.result.current.current(initial, row).correctionReason).toBe(
      'Fictional explanation awaiting its correction',
    );
  },
);

it('retains referenced resolution history while coalescing only changed decisions and retrying exact sparse writes', async () => {
  const initial = review(7, '42'),
    row = initial.records[0]!;
  row.draft = {
    id: 'fictional-large-draft',
    format: 'health-intake-review-draft-v2',
    proposalId: initial.proposalId,
    recordId: row.id,
    candidateId: row.candidateId!,
    candidateVersionId: row.candidateVersionId!,
    mapping: {},
    resolutions: [],
    resolutionsReference: { format: 'health-intake-review-draft-resolutions-v1', count: 4000 },
    history: {
      format: 'health-intake-review-draft-history-v1',
      intakeId: intake.id,
      sourceHash: 'fictional-source',
      snapshotId: 'retained-history',
      resolutions: 9000,
      corrections: 4,
    },
    answers: { old: 'Retained earlier answer' },
    disposition: 'pending',
    at: '2026-10-04T00:00:00Z',
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, options) => {
      requests.push(JSON.parse(String(options?.body)));
      if (requests.length === 2) throw new TypeError('Fictional uncertain sparse save');
      return json({ ...intake, version: 7 + requests.length });
    }),
  );
  const view = renderHook(() => useReviewDrafts(profile.id, vi.fn()));
  act(() => {
    view.result.current.hydrate(initial);
    view.result.current.update(initial, row, {
      resolutions: [{ issueId: 'first-new-question', outcome: 'acknowledged' }],
    });
    const first = view.result.current.current(initial, row);
    view.result.current.update(initial, row, {
      resolutions: [...first.resolutions, { issueId: 'second-new-question', outcome: 'confirmed' }],
      answers: { ...first.answers, new: 'New fictional reading' },
    });
  });
  await act(() => view.result.current.flush());
  expect(requests[0]!.resolutions).toEqual([
    { issueId: 'first-new-question', outcome: 'acknowledged' },
    { issueId: 'second-new-question', outcome: 'confirmed' },
  ]);
  expect(requests[0]!.answers).toEqual({ new: 'New fictional reading' });
  expect(requests[0]).not.toHaveProperty('history');
  expect(requests[0]).not.toHaveProperty('resolutionsReference');
  act(() => {
    const current = view.result.current.current(initial, row);
    view.result.current.update(initial, row, {
      resolutions: [...current.resolutions, { issueId: 'third-new-question', outcome: 'unknown' }],
    });
  });
  await act(() => view.result.current.flush());
  expect(requests[1]!.resolutions).toEqual([{ issueId: 'third-new-question', outcome: 'unknown' }]);
  expect(requests[1]!.answers).toEqual({});
  await act(() => view.result.current.retry());
  expect(requests[2]).toEqual(requests[1]);
  expect(view.result.current.current(initial, row).history).toEqual(row.draft.history);
  expect(view.result.current.current(initial, row).resolutionsReference?.count).toBe(4000);
});

it.each([false, true])(
  'reapplies only unsent referenced decisions after conflict (newer queued edit: %s)',
  async (newerEdit) => {
    const initial = review(7, '42');
    const row = initial.records[0]!;
    row.draft = {
      id: 'fictional-referenced-draft',
      format: 'health-intake-review-draft-v2',
      proposalId: initial.proposalId,
      recordId: row.id,
      candidateId: row.candidateId!,
      candidateVersionId: row.candidateVersionId!,
      mapping: {},
      resolutions: [],
      resolutionsReference: { format: 'health-intake-review-draft-resolutions-v1', count: 4000 },
      answers: { old: 'Previously saved answer' },
      disposition: 'pending',
      at: '2026-10-04T00:00:00Z',
    };
    const latest = {
      ...initial,
      version: 10,
      reviewToken: 'fictional-fresh-token',
      records: [
        {
          ...row,
          draft: {
            ...row.draft,
            resolutionsReference: {
              format: 'health-intake-review-draft-resolutions-v1' as const,
              count: 4001,
            },
            answers: { old: 'Newer retained answer' },
          },
        },
      ],
    };
    const requests: Record<string, any>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, options) => {
        if (String(input).includes('/review-record?')) return json(latest);
        requests.push(JSON.parse(String(options?.body)));
        if (requests.length === 2)
          return json({ code: 'VERSION_CONFLICT', message: 'Review changed.' }, 409);
        if (requests.length === 3) throw new TypeError('Fictional lost reapply response');
        return json({ ...intake, version: 7 + requests.length });
      }),
    );
    const view = renderHook(() => useReviewDrafts(profile.id, vi.fn()));
    const saved = { issueId: 'saved-choice', outcome: 'confirmed' as const };
    const unsent = { issueId: 'unsent-choice', outcome: 'acknowledged' as const };
    act(() => {
      view.result.current.hydrate(initial);
      view.result.current.update(initial, row, { resolutions: [saved] });
    });
    await act(() => view.result.current.flush());
    act(() => {
      view.result.current.update(initial, row, {
        resolutions: [saved, unsent],
        answers: { old: 'Previously saved answer', new: 'Unsent fictional answer' },
      });
    });
    await act(() => view.result.current.flush());
    expect(view.result.current.conflict).toBe(true);
    const reapplied = newerEdit ? { ...unsent, outcome: 'unknown' as const } : unsent;
    const answer = newerEdit ? 'Newer unsent answer' : 'Unsent fictional answer';
    if (newerEdit)
      act(() => {
        view.result.current.update(initial, row, {
          resolutions: [saved, reapplied],
          answers: { old: 'Previously saved answer', new: answer },
        });
      });
    await act(() => view.result.current.inspectConflict());
    await act(() => view.result.current.reapply());
    expect(requests[2]).toMatchObject({
      version: 10,
      resolutions: [reapplied],
      answers: { new: answer },
    });
    expect(requests[2]!.resolutions).toEqual([reapplied]);
    expect(requests[2]!.answers).toEqual({ new: answer });
    expect(requests[2]!.operationId).not.toBe(requests[1]!.operationId);
    await act(() => view.result.current.retry());
    expect(requests[3]).toEqual(requests[2]);
  },
);

it('preserves independently saved native pair choices through resolutions, mapping edits and exact uncertain retries', async () => {
  const initial = review(7, '42');
  const requests: Record<string, any>[] = [];
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, options) => {
      requests.push(JSON.parse(String(options?.body)));
      if (fail) {
        fail = false;
        throw new TypeError('Fictional uncertain native draft save');
      }
      return json({ ...intake, version: 9 });
    }),
  );
  const view = renderHook(() =>
    useReviewDrafts(profile.id, vi.fn(), { retainedComparisons: true }),
  );
  act(() => view.result.current.hydrate(initial));
  const exactScope = {
    kind: 'observation' as const,
    sourceRecordId: 'fictional-original',
    identity: 'fictional-person',
    version: 'fictional-version',
    stateHash: 'fictional-state-hash',
    evidenceHash: 'fictional-original-bytes-hash',
  };
  const pair: IntakePairDecision = {
    otherRecordId: 'fictional-saved-target',
    outcome: 'distinct',
    reason: 'Separate fictional source identifiers; retain literal values.',
    scope: {
      format: 'intake-pair-scope-v1',
      profileId: profile.id,
      incoming: exactScope,
      saved: { ...exactScope, recordId: 'fictional-saved-target' },
      token: 'fictional-exact-saved-pair-scope',
    },
  };
  const paired = review(8, '42');
  const pairedRecord = paired.records[0]!;
  pairedRecord.draft = {
    id: 'native-independent-pair-write',
    proposalId: paired.proposalId,
    recordId: record.id,
    candidateId: record.candidateId!,
    candidateVersionId: record.candidateVersionId!,
    mapping: {},
    disposition: 'pending',
    at: '2026-10-04T00:00:00Z',
    resolutions: [],
    decision: { recordId: record.id, action: 'accept', mapping: {}, comparisons: [pair] },
  };
  act(() => {
    view.result.current.hydrateRecords(paired, [pairedRecord]);
    view.result.current.update(paired, pairedRecord, {
      resolutions: [{ issueId: 'fictional-required-question', outcome: 'acknowledged' }],
    });
    const current = view.result.current.current(paired, pairedRecord);
    view.result.current.update(paired, pairedRecord, {
      decision: { ...current.decision, mapping: { ...current.decision.mapping, valueText: '43' } },
    });
  });
  await act(() => view.result.current.flush());
  expect(requests).toHaveLength(1);
  expect(requests[0]!.decision.comparisons).toEqual([pair]);
  expect(requests[0]!.mapping.valueText).toBe('43');
  expect(requests[0]!.resolutions).toEqual([
    { issueId: 'fictional-required-question', outcome: 'acknowledged' },
  ]);
  // A newer resource cannot silently substitute another scope in an exact retry.
  const foreign = structuredClone(pairedRecord);
  foreign.draft!.decision!.comparisons![0]!.scope!.token = 'foreign-saved-evidence-token';
  act(() => view.result.current.hydrateRecords({ ...paired, version: 9 }, [foreign]));
  await act(() => view.result.current.retry());
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

it.each(['unchanged', 'newer edit', 'scope clearing', 'unmount'] as const)(
  'keeps retained relationships and invalidates changed explicit acceptance preparation (%s)',
  async (change) => {
    const paired = review(7, '42');
    const exact = paired.records[0]!;
    const pair: IntakePairDecision = {
      otherRecordId: 'fictional-independent-record',
      outcome: 'distinct',
      reason: 'Independent fictional source occurrence.',
    };
    exact.draft = {
      id: 'fictional-initial-skip',
      proposalId: paired.proposalId,
      recordId: exact.id,
      candidateId: exact.candidateId!,
      candidateVersionId: exact.candidateVersionId!,
      mapping: exact.mapping,
      disposition: 'pending',
      at: '2026-10-04T00:00:00Z',
      resolutions: [{ issueId: 'fictional-reviewed-question', outcome: 'acknowledged' }],
      answers: { 'fictional-reviewed-question': 'Retain the original wording.' },
      decision: { recordId: exact.id, action: 'skip', mapping: exact.mapping, comparisons: [pair] },
    };
    const requests: Record<string, any>[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        const command = JSON.parse(String(init?.body));
        requests.push(command);
        const ordinal = requests.length;
        if (ordinal === 1) await gate;
        return new Response(
          JSON.stringify({
            data: {
              ...intake,
              version: 7 + ordinal,
              reviewDraftTransition: {
                format: 'health-intake-own-draft-transition-v1',
                profileId: profile.id,
                intakeId: intake.id,
                proposalId: paired.proposalId,
                recordId: exact.id,
                candidateId: exact.candidateId,
                candidateVersionId: exact.candidateVersionId,
                operationId: command.operationId,
                fromVersion: 6 + ordinal,
                toVersion: 7 + ordinal,
                fromRevision: 40 + ordinal,
                toRevision: 41 + ordinal,
              },
            },
            meta: { revision: 41 + ordinal },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const view = renderHook(() =>
      useReviewDrafts(profile.id, vi.fn(), { retainedComparisons: true }),
    );
    act(() => view.result.current.hydrate(paired));
    let pending!: ReturnType<typeof view.result.current.prepareAcceptance>;
    act(() => {
      pending = view.result.current.prepareAcceptance(paired, exact);
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].decision).toEqual({ ...exact.draft.decision, action: 'accept' });
    expect(requests[0].resolutions).toEqual(exact.draft.resolutions);
    expect(requests[0].answers).toEqual(exact.draft.answers);
    expect(requests[0].decision.comparisons).toEqual([pair]);
    if (change === 'newer edit')
      act(() => {
        const current = view.result.current.current(paired, exact);
        view.result.current.update(paired, exact, {
          decision: {
            ...current.decision,
            mapping: { ...current.decision.mapping, valueText: '99' },
          },
        });
      });
    let result: Awaited<typeof pending>;
    await act(async () => {
      release();
      result = await pending;
    });
    if (change === 'newer edit') {
      expect(result!).toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[1].mapping.valueText).toBe('99');
      expect(requests[1].decision.comparisons).toEqual([pair]);
    } else {
      expect(result!.commit.request).toEqual(requests[0]);
      expect(result!.isCurrent()).toBe(true);
      if (change === 'scope clearing') {
        act(() => view.result.current.clearPairCommits());
      } else if (change === 'unmount') {
        view.unmount();
      } else
        act(() => {
          const current = view.result.current.current(paired, exact);
          view.result.current.update(paired, exact, {
            decision: {
              ...current.decision,
              mapping: { ...current.decision.mapping, valueText: '43' },
            },
          });
        });
      expect(result!.isCurrent()).toBe(false);
    }
    view.unmount();
  },
);
