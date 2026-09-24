import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { IntakePairScopeV2 } from '../../shared/clinical-review';
import type { IntakeReview, IntakeReviewDecision, IntakeReviewRecord } from '../../shared/intake';
import {
  refreshPairScopesAfterOwnDraft,
  type ReviewDraftPairCommit,
} from '../../app/features/intake/review-draft-pair-scope';
import { useReviewDrafts } from '../../app/features/intake/useReviewDrafts';
import { replaceProfiles, selectProfile } from '../../app/data/profile';

function fixture() {
  const before: IntakePairScopeV2 = {
    format: 'intake-pair-scope-v2',
    profileId: 'fictional-profile',
    requestRevision: 10,
    intakeVersion: 7,
    contextHash: 'fictional-context',
    activeAttachment: null,
    token: 'fictional-before-token',
    incoming: {
      kind: 'observation',
      sourceRecordId: 'fictional-incoming',
      identity: 'incoming-identity',
      version: 'incoming-version',
      stateHash: 'incoming-state',
      evidenceHash: 'incoming-evidence',
    },
    saved: {
      kind: 'observation',
      recordId: 'fictional-saved',
      sourceRecordId: 'saved-source',
      identity: 'saved-identity',
      version: 'saved-version',
      stateHash: 'saved-state',
      evidenceHash: 'saved-evidence',
    },
  };
  const fresh: IntakePairScopeV2 = {
    ...structuredClone(before),
    requestRevision: 11,
    intakeVersion: 8,
    token: 'fictional-after-token',
  };
  const decision: IntakeReviewDecision = {
    recordId: 'fictional-incoming',
    action: 'accept',
    mapping: { kind: 'observation', valueText: '9.25', unit: 'mg/L' },
    comparisons: [
      {
        otherRecordId: 'fictional-saved',
        scope: before,
        outcome: 'distinct',
        reason: 'Separate fictional source records.',
      },
    ],
  };
  const commit: ReviewDraftPairCommit = {
    profileId: before.profileId,
    intakeId: 'fictional-intake',
    candidateId: 'fictional-candidate',
    version: 8,
    revision: 11,
    request: {
      operationId: 'fictional-draft-operation',
      version: 7,
      proposalId: null,
      recordId: decision.recordId,
      candidateVersionId: 'fictional-candidate-version',
      mapping: structuredClone(decision.mapping),
      disposition: 'pending',
      resolutions: [],
      answers: {},
      decision: structuredClone(decision),
    },
  };
  const record = {
    id: decision.recordId,
    candidateId: commit.candidateId,
    candidateVersionId: commit.request.candidateVersionId,
    kind: 'observation',
    classification: 'addition',
    title: 'Fictional result',
    date: null,
    provider: 'Fictional provider',
    confidence: 1,
    uncertainties: [],
    evidence: [],
    supportedFields: ['valueText', 'unit'],
    mapping: structuredClone(decision.mapping),
    reviewState: 'pending',
    comparisons: [
      {
        id: 'fictional-saved',
        scope: fresh,
        kind: 'observation',
        title: 'Fictional saved result',
        date: null,
        identity: 'saved-identity',
        version: 'saved-version',
        mapping: structuredClone(decision.mapping),
        evidence: [],
        previousDecision: null,
      },
    ],
    draft: {
      ...structuredClone(commit.request),
      id: commit.request.operationId,
      candidateId: commit.candidateId,
      at: '2026-09-22T00:00:00Z',
    },
  } as IntakeReviewRecord;
  const review = {
    intakeId: commit.intakeId,
    proposalId: null,
    version: 8,
    records: [record],
  } as IntakeReview;
  return { before, fresh, decision, commit, record, review };
}
type Scenario = ReturnType<typeof fixture>;
const refresh = (s: Scenario, commit: ReviewDraftPairCommit | undefined = s.commit) =>
  refreshPairScopesAfterOwnDraft('fictional-profile', s.review, s.record, s.decision, commit);

it('advances only the transport pins of one exact acknowledged own draft write', () => {
  const s = fixture();
  const result = refresh(s);
  expect(result.comparisons?.[0]).toEqual({ ...s.decision.comparisons![0], scope: s.fresh });
  expect(s.decision.comparisons![0].scope).toEqual(s.before);
  expect(result.mapping).toEqual(s.decision.mapping);
});

it.each<[string, (s: Scenario) => void]>([
  [
    'saved version changed',
    (s) => {
      s.fresh.saved.version = 'corrected-version';
    },
  ],
  [
    'saved original changed',
    (s) => {
      s.fresh.saved.evidenceHash = 'changed-original';
    },
  ],
  [
    'incoming original changed',
    (s) => {
      s.fresh.incoming.evidenceHash = 'changed-original';
    },
  ],
  [
    'incoming candidate changed',
    (s) => {
      s.record.candidateId = 'replacement-candidate';
    },
  ],
  [
    'incoming candidate version changed',
    (s) => {
      s.record.candidateVersionId = 'replacement-version';
    },
  ],
  [
    'incoming mapping changed',
    (s) => {
      s.record.mapping.valueText = '99';
    },
  ],
  [
    'local mapping changed',
    (s) => {
      s.decision.mapping.valueText = '99';
    },
  ],
  [
    'local human choice changed',
    (s) => {
      s.decision.comparisons![0].outcome = 'same_event';
    },
  ],
  [
    'local reason changed',
    (s) => {
      s.decision.comparisons![0].reason = 'A different decision.';
    },
  ],
  [
    'identity or report context changed',
    (s) => {
      s.fresh.contextHash = 'different-authority';
    },
  ],
  [
    'active evidence attachment changed',
    (s) => {
      s.fresh.activeAttachment = {
        transitionId: 'other',
        evidenceId: 'other',
        targetKind: 'observation',
        targetRecordId: 'fictional-saved',
      };
    },
  ],
  [
    'unrelated revision after own write',
    (s) => {
      s.fresh.requestRevision += 1;
    },
  ],
  [
    'unrelated revision inside write response',
    (s) => {
      s.commit.revision += 1;
      s.fresh.requestRevision += 1;
    },
  ],
  [
    'replayed write returns a newer intake',
    (s) => {
      s.commit.version += 1;
      s.review.version += 1;
      s.fresh.intakeVersion += 1;
    },
  ],
  [
    'different persisted draft operation',
    (s) => {
      s.record.draft!.id = 'someone-elses-draft';
    },
  ],
  [
    'persisted decision changed',
    (s) => {
      s.record.draft!.decision!.comparisons![0].reason = 'Changed elsewhere.';
    },
  ],
  [
    'different profile',
    (s) => {
      s.commit.profileId = 'another-profile';
    },
  ],
  [
    'different intake',
    (s) => {
      s.review.intakeId = 'another-intake';
    },
  ],
  [
    'different proposal',
    (s) => {
      s.review.proposalId = 'another-proposal';
    },
  ],
  [
    'missing scope',
    (s) => {
      delete s.decision.comparisons![0].scope;
      s.commit.request.decision = structuredClone(s.decision);
      s.record.draft!.decision = structuredClone(s.decision);
    },
  ],
  [
    'legacy scope',
    (s) => {
      const legacy = {
        format: 'intake-pair-scope-v1' as const,
        profileId: s.before.profileId,
        incoming: s.before.incoming,
        saved: s.before.saved,
        token: 'legacy',
      };
      s.decision.comparisons![0].scope = legacy;
      s.commit.request.decision = structuredClone(s.decision);
      s.record.draft!.decision = structuredClone(s.decision);
    },
  ],
  [
    'unrecognized scope field',
    (s) => {
      Object.assign(s.fresh, { futureAuthority: 'unreviewed' });
    },
  ],
])('does not rebind a choice when %s', (_name, mutate) => {
  const s = fixture();
  mutate(s);
  expect(refresh(s)).toBe(s.decision);
});

it('cannot rebind without an own receipt, while an already exact-current decision stays unchanged', () => {
  const s = fixture();
  expect(refreshPairScopesAfterOwnDraft('fictional-profile', s.review, s.record, s.decision)).toBe(
    s.decision,
  );
  s.decision.comparisons![0].scope = s.fresh;
  expect(refreshPairScopesAfterOwnDraft('fictional-profile', s.review, s.record, s.decision)).toBe(
    s.decision,
  );
});

it('does not partially refresh two choices when one saved record changed', () => {
  const s = fixture();
  const otherBefore = structuredClone(s.before);
  otherBefore.saved.recordId = 'fictional-second-saved';
  const otherFresh = {
    ...structuredClone(otherBefore),
    requestRevision: 11,
    intakeVersion: 8,
    token: 'fictional-second-after',
  };
  otherFresh.saved.evidenceHash = 'changed-second-original';
  s.decision.comparisons!.push({
    ...s.decision.comparisons![0],
    otherRecordId: otherBefore.saved.recordId,
    scope: otherBefore,
  });
  s.record.comparisons!.push({
    ...s.record.comparisons![0],
    id: otherBefore.saved.recordId,
    scope: otherFresh,
  });
  s.commit.request.decision = structuredClone(s.decision);
  s.record.draft!.decision = structuredClone(s.decision);
  expect(refresh(s)).toBe(s.decision);
  expect(s.decision.comparisons![0].scope).toEqual(s.before);
});

it.each(['unchanged', 'assets', 'sourceSystem', 'mappingOrigins', 'unknownField'])(
  'restores sparse draft metadata only when the full mapping remains identical: %s',
  (changed) => {
    const s = fixture();
    const mapping = {
      ...s.decision.mapping,
      assets: ['fictional-original'],
      sourceSystem: 'Fictional issuer',
      mappingOrigins: { kind: 'clinical' },
      unknownField: 'unchanged fictional baseline',
    };
    s.decision.mapping = structuredClone(mapping);
    s.commit.request.mapping = structuredClone(mapping);
    s.commit.request.decision = structuredClone(s.decision);
    s.record.mapping = structuredClone(mapping);
    // The real draft endpoint persists editable fields only. It does not copy
    // this read-only envelope metadata into either sparse mapping object.
    if (changed !== 'unchanged')
      Object.assign(s.record.mapping, { [changed]: 'changed fictional metadata' });
    const result = refresh(s);
    if (changed === 'unchanged') expect(result.comparisons![0].scope).toEqual(s.fresh);
    else expect(result).toBe(s.decision);
  },
);

function mountedFixture() {
  const s = fixture();
  const profile = { id: 'fictional-profile', name: 'Fictional Person', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  const originalRecord = {
    ...s.record,
    draft: undefined,
    comparisons: [{ ...s.record.comparisons![0], scope: s.before }],
  };
  const original = { ...s.review, version: 7, records: [originalRecord] };
  let sent: ReviewDraftPairCommit['request'] | undefined;
  const saved = vi.fn();
  const success = () => {
    const draft = {
      ...structuredClone(sent!),
      id: sent!.operationId,
      candidateId: s.commit.candidateId,
      at: '2026-09-22T00:00:00Z',
    };
    s.record.draft = draft as NonNullable<IntakeReviewRecord['draft']>;
    return new Response(
      JSON.stringify({
        data: { id: s.commit.intakeId, version: 8, workflow: { reviewDrafts: [draft] } },
        meta: { revision: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const view = renderHook(({ profileId }) => useReviewDrafts(profileId, saved), {
    initialProps: { profileId: profile.id },
  });
  act(() => view.result.current.hydrate(original));
  const edit = () =>
    act(() => view.result.current.update(original, originalRecord, { decision: s.decision }));
  return {
    s,
    view,
    edit,
    success,
    saved,
    capture: (body: unknown) => {
      sent = JSON.parse(String(body));
    },
  };
}

it('keeps a human pair choice current after its successful timed autosave and fresh hydration', async () => {
  const f = mountedFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      f.capture(init?.body);
      return f.success();
    }),
  );
  f.edit();
  await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
  act(() => f.view.result.current.hydrate(f.s.review));
  expect(
    f.view.result.current.current(f.s.review, f.s.record).decision.comparisons![0].scope,
  ).toEqual(f.s.fresh);
  expect(f.view.result.current.pending()).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  'failed write',
  'context changes while writing',
  'context changes after writing',
  'profile changes while writing',
])('retains old scopes after %s', async (caseName) => {
  const f = mountedFixture();
  let finish!: () => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      f.capture(init?.body);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return caseName === 'failed write'
        ? new Response(
            JSON.stringify({
              error: { code: 'VERSION_CONFLICT', message: 'Fictional concurrent change.' },
            }),
            { status: 409 },
          )
        : f.success();
    }),
  );
  f.edit();
  const flushing = f.view.result.current.flush();
  await waitFor(() => expect(finish).toBeDefined());
  if (caseName === 'context changes while writing') f.view.result.current.clearPairCommits();
  if (caseName === 'profile changes while writing') {
    act(() => {
      const other = {
        id: 'fictional-other-profile',
        name: 'Fictional Other Person',
        placebo: true,
      };
      replaceProfiles([other]);
      selectProfile(other);
      f.view.rerender({ profileId: other.id });
    });
  }
  await act(async () => {
    finish();
    await flushing;
  });
  if (caseName === 'context changes after writing') f.view.result.current.clearPairCommits();
  act(() => f.view.result.current.hydrate(f.s.review));
  expect(
    f.view.result.current.afterOwnSave(f.s.review, f.s.record).decision.comparisons![0].scope,
  ).toEqual(f.s.before);
});
