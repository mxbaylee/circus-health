import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { Suspense, startTransition, use, useEffect, useLayoutEffect, useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CollectionImportReview } from '../../app/features/import/CollectionImportReview';
import { useCollectionBulkActions } from '../../app/features/import/useCollectionBulkActions';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { useResource } from '../../app/data/api';
import type {
  CollectionFeedRecord,
  CollectionImportFeed,
  CollectionPersonProposal,
} from '../../shared/intake-clinical-pages';
import type { IntakePersonApplyRequest } from '../../shared/intake-people';
import type { IntakeReportAcceptanceResult } from '../../shared/intake';

// Each case drives one client gate to a refusal or failure and requires a
// visible outcome plus an enabled retry, never a silently disabled control.
const sourceGate = vi.hoisted(() => ({
  listener: undefined as ((pending: boolean) => void) | undefined,
  flush: undefined as (() => Promise<boolean>) | undefined,
}));
vi.mock('../../app/features/import/ImportDetailReview', () => ({
  ImportDetailReview: ({
    beforeCloseRef,
  }: {
    beforeCloseRef?: { current: (() => Promise<boolean>) | null };
  }) => {
    useEffect(() => {
      if (!beforeCloseRef) return;
      const flush = () => sourceGate.flush?.() ?? Promise.resolve(true);
      beforeCloseRef.current = flush;
      return () => {
        if (beforeCloseRef.current === flush) beforeCloseRef.current = null;
      };
    }, [beforeCloseRef]);
    return null;
  },
  ImportRecordDetail: () => null,
}));
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: ({
    onPendingChange,
  }: {
    onPendingChange?: (pending: boolean) => void;
  }) => {
    useEffect(() => {
      sourceGate.listener = onPendingChange;
      return () => {
        sourceGate.listener = undefined;
      };
    }, [onPendingChange]);
    return null;
  },
}));

const profile = { id: 'fictional-action-recovery', name: 'Fictional Reader', placebo: true };
const person = (id: string): CollectionPersonProposal => ({
  id,
  version: `version-${id}`,
  state: 'later',
  intakeId: 'fictional-intake',
  intakeVersion: 7,
  proposalId: null,
  envelopeRecordId: `record-${id}`,
  envelopeId: `envelope-${id}`,
  groupId: 'fictional-group',
  groupVersionId: 'group-v1',
  title: id,
  person: { fullName: id, tags: ['Professional'] },
  uncertainties: [],
  evidence: [],
  source: {
    sourceRecordId: id,
    filename: 'fictional.jsonl',
    contentUrl: '/api/sources/fictional/content',
    originalSourceFileId: 'fictional-source',
    originalSha256: 'fictional-hash',
    member: null,
  },
  matches: [],
  matchCount: 0,
  matchesTruncated: false,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status < 400 ? { data } : { error: data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const peoplePage = (people: CollectionPersonProposal[], selectedPersonId: string | null) => ({
  format: 'health-intake-people-page-v2',
  intakeId: 'fictional-intake',
  groupId: 'fictional-group',
  selectedPersonId,
  totalPeople: people.length,
  people: people.map((value) => ({ kind: 'person', person: value })),
  counts: { pending: 0, later: people.length, excluded: 0, saved: 0 },
  nextCursor: null,
});
const applied = (body: IntakePersonApplyRequest) =>
  json({
    proposalId: body.proposalId,
    status: 'saved',
    action: 'add',
    noteId: `note-${body.proposalId}`,
    personId: `person-${body.proposalId}`,
    resultUrl: `/#/people?id=${encodeURIComponent(body.proposalId)}`,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** People preflight reads are held one at a time; apply POSTs are recorded. */
function stubPeopleTransport(
  people: CollectionPersonProposal[],
  apply: (body: IntakePersonApplyRequest) => Response,
) {
  const writes: IntakePersonApplyRequest[] = [];
  const held: Array<ReturnType<typeof deferred<void>>> = [];
  let holdNext = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.includes('/people/')) {
        const id = url.searchParams.get('personId');
        if (holdNext) {
          holdNext = false;
          const gate = deferred<void>();
          held.push(gate);
          await gate.promise;
        }
        return json(
          peoplePage(
            people.filter((value) => value.id === id),
            id,
          ),
        );
      }
      if (url.pathname.endsWith('/people-apply')) {
        const body = JSON.parse(String(init?.body)) as IntakePersonApplyRequest;
        writes.push(body);
        return apply(body);
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  return { writes, held };
}

beforeEach(() => {
  sessionStorage.clear();
  sourceGate.listener = undefined;
  sourceGate.flush = undefined;
  replaceProfiles([profile]);
  selectProfile(profile);
});

it('finishes a People run whose scope was only rendered by a suspended transition, never committed', async () => {
  const people = [person('Fictional Ellis'), person('Fictional Rowan')];
  const transport = stubPeopleTransport(people, applied);
  const never = new Promise<never>(() => {});
  const latest: { current: ReturnType<typeof useCollectionBulkActions> | null } = {
    current: null,
  };
  const control: {
    set?: (value: { scope: string; suspend: boolean }) => void;
  } = {};
  const refresh = vi.fn();
  function Inner({ scope, suspend }: { scope: string; suspend: boolean }) {
    const bulk = useCollectionBulkActions({
      scope,
      onClinicalDone: vi.fn(),
      onPersonDone: vi.fn(),
      onPersonSaved: vi.fn(),
      onRefresh: refresh,
    });
    if (suspend) use(never);
    latest.current = bulk;
    return <output aria-label="Bulk state">{bulk.busy ? 'busy' : 'idle'}</output>;
  }
  function Harness() {
    const [state, setState] = useState({ scope: 'fictional-scope-a', suspend: false });
    control.set = setState;
    return (
      <Suspense fallback={<p>Fictional fallback</p>}>
        <Inner {...state} />
      </Suspense>
    );
  }
  render(<Harness />);
  let run!: Promise<void>;
  act(() => {
    run = latest.current!.addPeople(people, 'fictional-group');
  });
  await waitFor(() => expect(transport.held).toHaveLength(1));
  expect(screen.getByRole('status', { name: 'Bulk state' })).toHaveTextContent('busy');
  // A transition renders another scope but suspends; React keeps the committed scope.
  await act(async () => {
    startTransition(() => control.set!({ scope: 'fictional-scope-b', suspend: true }));
  });
  expect(screen.getByRole('status', { name: 'Bulk state' })).toBeInTheDocument();
  await act(async () => transport.held[0]!.resolve());
  await act(async () => {
    startTransition(() => control.set!({ scope: 'fictional-scope-a', suspend: false }));
  });
  await act(() => run);
  // The committed selection never changed, so its run must finish rather than
  // stop on a render that was never shown and leave the controls disabled.
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Bulk state' })).toHaveTextContent('idle'),
  );
  expect(latest.current!.pending).toBe(false);
  expect(transport.writes.map((body) => body.proposalId)).toEqual(people.map(({ id }) => id));
  expect(latest.current!.notice).toBe('2 selected items updated.');
});

it('abandons a People run after its committed scope changes and returns, without a concurrent write', async () => {
  const people = [person('Fictional Ellis'), person('Fictional Rowan')];
  const transport = stubPeopleTransport(people, applied);
  const { result, rerender } = renderHook(
    ({ scope }: { scope: string }) =>
      useCollectionBulkActions({
        scope,
        onClinicalDone: vi.fn(),
        onPersonDone: vi.fn(),
        onPersonSaved: vi.fn(),
        onRefresh: vi.fn(),
      }),
    { initialProps: { scope: 'fictional-scope-a' } },
  );
  let run!: Promise<void>;
  act(() => {
    run = result.current.addPeople(people, 'fictional-group');
  });
  await waitFor(() => expect(transport.held).toHaveLength(1));
  rerender({ scope: 'fictional-scope-b' });
  rerender({ scope: 'fictional-scope-a' });
  expect(result.current.busy).toBe(false);
  await act(async () => transport.held[0]!.resolve());
  await act(() => run);
  // The returned scope reset its queue: the earlier command must not POST.
  expect(transport.writes).toHaveLength(0);
  expect(result.current.busy).toBe(false);
  expect(result.current.pending).toBe(false);
  // The current selection can start its own run.
  await act(() => result.current.addPeople([people[0]!], 'fictional-group'));
  expect(transport.writes.map((body) => body.proposalId)).toEqual([people[0]!.id]);
});

it('shows a definite People refusal with an empty server message and allows a retry', async () => {
  const people = [person('Fictional Ellis')];
  let refuse = true;
  const transport = stubPeopleTransport(people, (body) => {
    if (!refuse) return applied(body);
    refuse = false;
    return json({ code: 'FICTIONAL_CHANGED', message: '' }, 409);
  });
  const { result } = renderHook(() =>
    useCollectionBulkActions({
      scope: 'fictional-scope',
      onClinicalDone: vi.fn(),
      onPersonDone: vi.fn(),
      onPersonSaved: vi.fn(),
      onRefresh: vi.fn(),
    }),
  );
  let run!: Promise<void>;
  act(() => {
    run = result.current.addPeople(people, 'fictional-group');
  });
  await waitFor(() => expect(transport.held).toHaveLength(1));
  await act(async () => transport.held[0]!.resolve());
  await act(() => run);
  expect(transport.writes).toHaveLength(1);
  expect(result.current.busy).toBe(false);
  expect(result.current.pending).toBe(false);
  expect(result.current.error).not.toBe('');
  await act(() => result.current.addPeople(people, 'fictional-group'));
  expect(transport.writes).toHaveLength(2);
  expect(result.current.error).toBe('');
});

const feedFor = (people: CollectionPersonProposal[]): CollectionImportFeed => ({
  format: 'health-intake-import-feed-v2',
  view: 'deferred',
  records: [],
  totalRecords: 0,
  totalGroups: 0,
  nextCursor: null,
  counts: {
    pending: 0,
    deferred: 0,
    blocked: 0,
    accepted: 0,
    keptOriginal: 0,
    superseded: 0,
    questions: 0,
  },
  kindCounts: {
    test: 0,
    procedure: 0,
    history: 0,
    prescription: 0,
    vision: 0,
    person: people.length,
    unsupported: 0,
  },
  groups: [],
  people: {
    groups: [
      {
        format: 'health-intake-report-group-reference-v2',
        binding: 'fictional-group-v1',
        intakeId: 'fictional-intake',
        groupId: 'fictional-group',
        ordinal: 0,
        bytes: 80,
      },
    ],
    totalGroups: 1,
    counts: { pending: 0, later: people.length, excluded: 0, saved: 0 },
    nextCursor: null,
  },
  activity: {
    format: 'activity',
    binding: 'fictional',
    runningFiles: 0,
    pausedFiles: 0,
    queuedFiles: 0,
    filesAwaitingConversion: 0,
    remainingUnits: { state: 'exact', value: 0 },
    extractionUnknownFiles: 0,
    extractionComplete: true,
    allCurrentReportsReviewed: false,
    readingAccounting: { state: 'referenced', scope: 'all', binding: 'fictional' },
  },
});

for (const first of ['feed', 'people'] as const)
  it(`keeps Add People blocked through receipt reconciliation and both refreshed resources (${first} first)`, async () => {
    const people = [person('Fictional Ellis'), person('Fictional Rowan')],
      feed = feedFor(people),
      operationId = `fictional-recovered-receipt-${first}`,
      receipt = deferred<Response>(),
      feedRefresh = deferred<Response>(),
      peopleRefresh = deferred<Response>(),
      writes: IntakePersonApplyRequest[] = [],
      committedEnabled: boolean[] = [];
    let receiptReads = 0,
      feedReads = 0,
      peopleReads = 0,
      reconciled = false,
      feedFinished = false,
      peopleFinished = false;
    sessionStorage.setItem(`circus-health:report-acceptance:${profile.id}`, operationId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.includes('/report-acceptance/')) {
          if (++receiptReads === 1)
            return json(
              { code: 'FICTIONAL_UNAVAILABLE', message: 'Fictional receipt unavailable.' },
              503,
            );
          const response = await receipt.promise;
          reconciled = true;
          return response;
        }
        if (url.pathname.endsWith('/import-feed')) {
          if (++feedReads === 1) return json(feed);
          return feedRefresh.promise;
        }
        if (url.pathname.includes('/people/')) {
          const id = url.searchParams.get('personId');
          if (id)
            return json(
              peoplePage(
                people.filter((value) => value.id === id),
                id,
              ),
            );
          if (++peopleReads === 1) return json(peoplePage(people, null));
          return peopleRefresh.promise;
        }
        if (url.pathname.endsWith('/people-apply')) {
          const body = JSON.parse(String(init?.body)) as IntakePersonApplyRequest;
          writes.push(body);
          return applied(body);
        }
        return json({ code: 'FICTIONAL_NOT_FOUND', message: 'No fictional detail.' }, 404);
      }),
    );
    function RecoveredCollection() {
      const path = '/intakes/import-feed?view=deferred&state=deferred&limit=40&bytes=65536',
        firstPage = useResource<CollectionImportFeed>(path);
      useLayoutEffect(() => {
        if (!reconciled || (feedFinished && peopleFinished)) return;
        const add = [...document.querySelectorAll('button')].find(
          (button) => button.textContent === 'Add 2 people',
        );
        if (add) committedEnabled.push(!add.disabled);
      });
      return firstPage.data ? (
        <CollectionImportReview
          initial={firstPage.data}
          firstPage={firstPage}
          path={path}
          onChanged={vi.fn()}
          sourceProps={{ onChanged: vi.fn() }}
          onUpload={vi.fn()}
          busy={false}
          status=""
          error=""
        />
      ) : null;
    }
    render(
      <MemoryRouter>
        <RecoveredCollection />
      </MemoryRouter>,
    );
    await screen.findByRole('checkbox', { name: 'Select Fictional Ellis' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
    const add = screen.getByRole('button', { name: 'Add 2 people' });
    expect(add).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Check save status' }));
    await waitFor(() => expect(receiptReads).toBe(2));
    const confirmed: IntakeReportAcceptanceResult = {
      receipt: {
        operationId,
        status: 'accepted',
        atomic: true,
        at: '2026-09-13T12:00:00Z',
        selectedCount: 1,
        acceptedCount: 1,
        receipts: [
          {
            intakeId: 'fictional-clinical-intake',
            proposalId: null,
            intakeVersionBefore: 7,
            intakeVersionAfter: 8,
            reviewToken: 'fictional-clinical-token',
            records: [
              {
                recordId: 'fictional-clinical-record',
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
      replayed: true,
      durability: { pending: false, mutationRevision: 8, persistedRevision: 8, error: null },
    };
    await act(async () => receipt.resolve(json(confirmed)));
    await waitFor(() => expect(feedReads).toBe(2));
    await waitFor(() => expect(peopleReads).toBe(2));
    expect(add).toBeDisabled();
    expect(writes).toHaveLength(0);
    await act(async () => {
      if (first === 'feed') {
        feedFinished = true;
        feedRefresh.resolve(json(feed));
      } else {
        peopleFinished = true;
        peopleRefresh.resolve(json(peoplePage(people, null)));
      }
    });
    expect(add).toBeDisabled();
    expect(writes).toHaveLength(0);
    expect(committedEnabled.length).toBeGreaterThan(0);
    expect(committedEnabled).not.toContain(true);
    await act(async () => {
      feedFinished = true;
      peopleFinished = true;
      feedRefresh.resolve(json(feed));
      peopleRefresh.resolve(json(peoplePage(people, null)));
    });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    await waitFor(() => expect(writes).toHaveLength(2));
  });

it('shows a visible refusal when Add People is dropped by a pending review action, then retries', async () => {
  const people = [person('Fictional Ellis'), person('Fictional Rowan')];
  const feed = feedFor(people);
  const writes: IntakePersonApplyRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) return json(feed);
      if (url.pathname.includes('/people/')) {
        const id = url.searchParams.get('personId');
        return json(
          peoplePage(
            people.filter((value) => !id || value.id === id),
            id,
          ),
        );
      }
      if (url.pathname.endsWith('/people-apply')) {
        const body = JSON.parse(String(init?.body)) as IntakePersonApplyRequest;
        writes.push(body);
        return applied(body);
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <MemoryRouter
      initialEntries={[
        '/intakes/import-feed?view=deferred&intake=fictional-intake&group=fictional-group&record=fictional-record',
      ]}
    >
      <CollectionImportReview
        initial={feed}
        path="/intakes/import-feed?view=deferred"
        onChanged={vi.fn()}
        sourceProps={{ onChanged: vi.fn() }}
        onUpload={vi.fn()}
        busy={false}
        status=""
        error=""
      />
    </MemoryRouter>,
  );
  await screen.findByRole('checkbox', { name: 'Select Fictional Ellis' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  const add = screen.getByRole('button', { name: 'Add 2 people' });
  await waitFor(() => expect(add).toBeEnabled());
  let enteredFlush!: () => void;
  let finishFlush!: (allowed: boolean) => void;
  const entered = new Promise<void>((resolve) => {
    enteredFlush = resolve;
  });
  sourceGate.flush = () => {
    enteredFlush();
    return new Promise<boolean>((resolve) => {
      finishFlush = resolve;
    });
  };
  fireEvent.click(add);
  await entered;
  await act(async () => {
    sourceGate.listener!(true);
    finishFlush(true);
  });
  expect(writes).toHaveLength(0);
  // The dropped click is reported instead of leaving a silent no-op.
  expect(
    await screen.findByText(
      'Another review action is still finishing. Wait for it, then try again.',
    ),
  ).toHaveAttribute('role', 'alert');
  sourceGate.flush = undefined;
  await act(async () => sourceGate.listener!(false));
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() =>
    expect(
      screen.queryByText('Another review action is still finishing. Wait for it, then try again.'),
    ).not.toBeInTheDocument(),
  );
});

const clinicalRecord = (id: string): CollectionFeedRecord => ({
  intakeId: 'fictional-intake',
  groupId: 'visible-group',
  groupOrdinal: 0,
  proposalId: 'fictional-proposal',
  intakeVersion: 7,
  reviewToken: 'ready-token',
  feedKind: 'test',
  feedKey: JSON.stringify(['fictional-intake', id, 'version-' + id]),
  feedOrder: id,
  manuallyEdited: false,
  detail: {
    kind: 'record',
    record: {
      id,
      title: 'Fictional glucose ' + id,
      provider: 'Fictional Clinic',
      date: '2026-08-10',
      kind: 'observation',
      classification: 'addition',
      confidence: 1,
      uncertainties: [],
      evidence: [],
      mapping: {
        kind: 'observation',
        testLabel: 'Fictional glucose ' + id,
        valueText: '87',
        unit: 'mg/dL',
        date: '2026-08-10',
      },
      supportedFields: [],
      candidateId: id,
      candidateVersionId: 'version-' + id,
      selectionReviewToken: 'selected-ready',
      queueState: 'pending',
      selectable: true,
      feedKey: JSON.stringify(['fictional-intake', id, 'version-' + id]),
      feedOrder: id,
      feedKind: 'test',
      manuallyEdited: false,
    },
  },
});

it('releases a clinical save whose displayed page changed before its preflight settled', async () => {
  const row = clinicalRecord('first');
  const feed: CollectionImportFeed = {
    ...feedFor([]),
    view: 'active',
    records: [row],
    totalRecords: 1,
    totalGroups: 1,
    counts: { ...feedFor([]).counts, pending: 1 },
    people: {
      groups: [],
      totalGroups: 0,
      counts: { pending: 0, later: 0, excluded: 0, saved: 0 },
      nextCursor: null,
    },
  };
  const preflight = deferred<Response>();
  let preflights = 0;
  let acceptances = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed')) return json(feed);
      if (url.pathname.includes('/report-queue/')) return json({}, 404);
      if (url.pathname.endsWith('/identity-review'))
        return json({
          status: 'missing_warning',
          blocking: false,
          message: 'The fictional report has no printed identity.',
          scope: null,
          evidencedIdentity: {},
          self: { noteId: 'self', version: 1, fullName: 'Fictional Reader' },
          offeredSelfFields: {},
          conflicts: [],
        });
      if (url.pathname.endsWith('/review-record')) {
        preflights++;
        return preflight.promise;
      }
      if (url.pathname.endsWith('/report-acceptance') && init?.method === 'POST') acceptances++;
      throw new Error(`Unexpected ${url}`);
    }),
  );
  const props = {
    initial: feed,
    onChanged: vi.fn(),
    sourceProps: { onChanged: vi.fn() },
    onUpload: vi.fn(),
    busy: false,
    status: '',
    error: '',
  };
  const mounted = render(
    <MemoryRouter initialEntries={['/import']}>
      <CollectionImportReview {...props} path="/intakes/import-feed?view=active" />
    </MemoryRouter>,
  );
  const save = await screen.findByRole('button', { name: 'Confirm & save' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() => expect(preflights).toBe(1));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeDisabled(),
  );
  // The parent moves to another exact window while the preflight is held.
  mounted.rerender(
    <MemoryRouter initialEntries={['/import']}>
      <CollectionImportReview
        {...props}
        path="/intakes/import-feed?view=active&intakeId=fictional-intake"
      />
    </MemoryRouter>,
  );
  await act(async () =>
    preflight.resolve(json({ code: 'FICTIONAL_GONE', message: 'Fictional record gone.' }, 410)),
  );
  // The abandoned save sent nothing; the new window must not stay disabled with
  // no request in flight and no visible error.
  expect(acceptances).toBe(0);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm & save' })).toBeEnabled());
});
