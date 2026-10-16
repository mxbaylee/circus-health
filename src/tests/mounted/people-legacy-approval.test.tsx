import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ImportPage } from '../../app/features/import/ImportPage';
import { CollectionImportReview } from '../../app/features/import/CollectionImportReview';
import { importPerson } from '../fixtures/import-person';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import { peopleReviewApproval } from '../../app/features/import/people-review-approval';
import type {
  ImportReviewActions,
  ImportReviewModel,
} from '../../app/features/import/ImportReviewPresentation';
import type { IntakePersonProposal } from '../../shared/intake-people';
import type { IntakeImportFeed, IntakeReportQueueGroup } from '../../shared/intake';

const rendered = vi.hoisted(() => ({
  current: undefined as { model: ImportReviewModel; actions: ImportReviewActions } | undefined,
}));
vi.mock('../../app/features/import/ImportReviewPresentation', () => ({
  ImportReviewPresentation: (props: { model: ImportReviewModel; actions: ImportReviewActions }) => {
    rendered.current = props;
    return <p>People view: {props.model.records.map((row) => row.label).join(', ')}</p>;
  },
}));
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: () => null,
}));
const counts = {
  pending: 0,
  deferred: 0,
  blocked: 0,
  accepted: 0,
  keptOriginal: 0,
  superseded: 0,
  questions: 0,
};
const group: IntakeReportQueueGroup = {
  groupId: 'fictional-group',
  groupVersionId: 'v1',
  intakeId: 'fictional-intake',
  intakeVersion: 7,
  discoveryOrder: 0,
  title: 'Fictional family record',
  source: null,
  date: null,
  basis: 'report_anchor',
  member: null,
  anchor: null,
  counts,
  original: { filename: 'fictional.jsonl', contentUrl: '/fictional', parentSourceFileId: null },
};
const feed: IntakeImportFeed = {
  view: 'active',
  groups: [],
  totalGroups: 0,
  totalRecords: 0,
  nextCursor: null,
  counts,
  blocks: [],
  kindCounts: {
    test: 0,
    prescription: 0,
    vision: 0,
    procedure: 0,
    history: 0,
    unsupported: 0,
    person: 1,
  },
  people: {
    groups: [group],
    totalGroups: 1,
    nextCursor: null,
    counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
  },
  activity: {
    runningFiles: 0,
    queuedFiles: 0,
    pausedFiles: 0,
    filesAwaitingConversion: 0,
    remainingUnits: 0,
    extractionUnknownFiles: 0,
    extractionComplete: true,
    allCurrentReportsReviewed: false,
  },
};
const response = (data: unknown) => Response.json({ data });
beforeEach(() => {
  rendered.current = undefined;
  const profile = { id: 'fictional-legacy-people', name: 'Fictional Self', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
});
function legacyTransport(people: IntakePersonProposal[]) {
  const state = {
    people,
    reads: 0,
    writes: [] as string[],
    failWrite: 0,
    hold: undefined as (() => Promise<void>) | undefined,
    readsAtWrite: [] as number[],
    holdWrite: undefined as (() => Promise<void>) | undefined,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('/import-feed?')) return response(feed);
      if (url.endsWith('/intakes/limits'))
        return response({ uploadBytes: 1024, extractionBytes: 1024 });
      if (url.endsWith('/intake-batches')) return response([]);
      if (url.includes('/intakes/people/')) {
        state.reads++;
        const retained = structuredClone(state.people);
        const hold = state.hold;
        state.hold = undefined;
        if (hold) await hold();
        return response({
          groupId: group.groupId,
          people: retained,
          totalPeople: retained.length,
          peopleNextCursor: null,
        });
      }
      if (init?.method === 'POST' && /people-(apply|disposition)$/.test(url)) {
        state.writes.push(String(init.body));
        state.readsAtWrite.push(state.reads);
        const holdWrite = state.holdWrite;
        state.holdWrite = undefined;
        if (holdWrite) await holdWrite();
        if (state.writes.length === state.failWrite)
          throw new TypeError('Fictional lost acknowledgement');
        const body = JSON.parse(String(init.body));
        return response({
          proposalId: body.proposalId,
          status: 'saved',
          action: 'add',
          noteId: 'fictional-note',
          personId: 'fictional-person',
          resultUrl: '/people?id=fictional-person',
        });
      }
      throw new Error(`Unexpected fictional request ${url}`);
    }),
  );
  return state;
}
async function openLegacy() {
  const router = createMemoryRouter([{ path: '/import', element: <ImportPage /> }], {
    initialEntries: ['/import'],
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(rendered.current?.model.records.length).toBeGreaterThan(0));
  return router;
}

for (const action of ['add', 'later', 'excluded', 'pending'] as const)
  it(`legacy ${action} binds the selected approval and uses one preflight before its POST`, async () => {
    const person = importPerson();
    const transport = legacyTransport([person]);
    await openLegacy();
    const before = transport.reads;
    // Unrelated transport revisions do not replace the approved Person version.
    transport.people = [{ ...person, intakeVersion: 99, groupVersionId: 'transport-99' }];
    const pins = [peopleReviewApproval(person)];
    await act(async () => {
      if (action === 'add')
        await rendered.current!.actions.onSave!(['person:' + person.id], [], pins);
      else
        await (
          action === 'later'
            ? rendered.current!.actions.onLater
            : action === 'excluded'
              ? rendered.current!.actions.onExclude
              : rendered.current!.actions.onResume
        )!(['person:' + person.id], pins);
    });
    expect(transport.writes).toHaveLength(1);
    expect(transport.readsAtWrite[0]! - before).toBe(1);
    expect(JSON.parse(transport.writes[0]!)).toMatchObject({
      proposalVersion: person.version,
      intakeId: person.intakeId,
      proposalId: person.id,
    });
    if (action !== 'add') expect(JSON.parse(transport.writes[0]!).intakeVersion).toBe(99);
  });
for (const change of ['name', 'relationship', 'tags', 'version', 'same-version-details'] as const)
  for (const action of ['add', 'later'] as const)
    it(`legacy ${action} refuses changed ${change} with zero writes`, async () => {
      const person = importPerson();
      const transport = legacyTransport([person]);
      await openLegacy();
      const fresh = structuredClone(person);
      if (change === 'name') fresh.person.fullName = 'Fictional Rowan';
      if (change === 'relationship') fresh.person.relationship = 'sibling';
      if (change === 'tags') fresh.person.tags.push('Professional');
      if (change === 'version') fresh.version = 'v2';
      if (change === 'same-version-details') fresh.person.email = 'fictional@example.invalid';
      transport.people = [fresh];
      const pins = [peopleReviewApproval(person)];
      let outcome: unknown;
      await act(async () => {
        outcome =
          action === 'add'
            ? await rendered.current!.actions.onSave!(['person:' + person.id], [], pins)
            : await rendered.current!.actions.onLater!(['person:' + person.id], pins);
      });
      expect(transport.writes).toHaveLength(0);
      expect(outcome).toMatchObject({ rejectedIds: ['person:' + person.id] });
      expect(screen.getByText(/changed while you were reviewing/)).toBeVisible();
    });
it('legacy refuses every requested Person when one snapshot is missing before any preflight or write', async () => {
  const first = importPerson(),
    second = importPerson('fictional-second');
  const transport = legacyTransport([first, second]);
  await openLegacy();
  const reads = transport.reads;
  let outcome: unknown;
  await act(async () => {
    outcome = await rendered.current!.actions.onSave!(
      ['person:' + first.id, 'person:' + second.id],
      [],
      [peopleReviewApproval(first)],
    );
  });
  expect(transport.reads).toBe(reads);
  expect(transport.writes).toHaveLength(0);
  expect(outcome).toMatchObject({ rejectedIds: ['person:' + first.id, 'person:' + second.id] });
});
it('legacy keeps unknown retries exact after selection revocation and refuses its changed unsent successor', async () => {
  const people = [
    importPerson('fictional-first'),
    importPerson('fictional-unknown'),
    importPerson('fictional-unsent'),
  ];
  const transport = legacyTransport(people);
  transport.failWrite = 2;
  await openLegacy();
  await act(async () => {
    await rendered.current!.actions.onSave!(
      people.map((person) => 'person:' + person.id),
      [],
      people.map(peopleReviewApproval),
    );
  });
  expect(transport.writes).toHaveLength(2);
  transport.people = structuredClone(people);
  transport.people[1]!.person.fullName = 'Changed unknown';
  transport.people[2]!.version = 'changed-unsent';
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  act(() => window.dispatchEvent(event));
  await waitFor(() =>
    expect(rendered.current!.model.records.some((row) => row.label === 'Changed unknown')).toBe(
      true,
    ),
  );
  const before = transport.reads;
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact People action' })),
  );
  expect(transport.writes).toHaveLength(3);
  expect(transport.writes[2]).toBe(transport.writes[1]);
  expect(transport.readsAtWrite[2]).toBe(before);
  expect(screen.queryByRole('button', { name: 'Retry exact People action' })).toBeNull();
  expect(screen.getByText(/changed while you were reviewing/)).toBeVisible();
});

it('native bulk refuses a missing snapshot for any requested ID without a partial write', async () => {
  const first = importPerson(),
    second = importPerson('fictional-second');
  const transport = legacyTransport([first, second]);
  const initial = {
    ...feed,
    format: 'health-intake-import-feed-v2',
    records: [],
    groups: [],
    people: {
      ...feed.people,
      groups: [
        {
          format: 'health-intake-report-group-reference-v2',
          binding: 'group-v1',
          intakeId: first.intakeId,
          groupId: first.groupId,
          ordinal: 0,
          bytes: 80,
        },
      ],
    },
    activity: {
      ...feed.activity,
      format: 'activity',
      binding: 'fixture',
      remainingUnits: { state: 'exact', value: 0 },
      readingAccounting: { state: 'referenced', scope: 'all', binding: 'fixture' },
    },
  } as unknown as import('../../shared/intake-clinical-pages').CollectionImportFeed;
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            path: '/import',
            element: (
              <CollectionImportReview
                initial={initial}
                path="/intakes/import-feed?view=active"
                onChanged={() => {}}
                sourceProps={{ onChanged: () => {} }}
                onUpload={async () => {}}
                busy={false}
                status=""
                error=""
              />
            ),
          },
        ],
        { initialEntries: ['/import'] },
      )}
    />,
  );
  await waitFor(() => expect(rendered.current?.actions.onSave).toBeDefined());
  const before = transport.reads;
  await act(async () => {
    const result = await rendered.current!.actions.onSave!(
      ['person:' + first.id, 'person:' + second.id],
      [],
      [peopleReviewApproval(first)],
    );
    expect(result).toMatchObject({ rejectedIds: ['person:' + first.id, 'person:' + second.id] });
  });
  expect(transport.reads).toBe(before);
  expect(transport.writes).toHaveLength(0);
});

for (const action of ['add', 'later'] as const)
  it(`legacy ${action} keeps unknown recovery explicit through committed query A to B to A`, async () => {
    const original = importPerson();
    const transport = legacyTransport([original]);
    transport.failWrite = 1;
    const router = await openLegacy();
    const pins = [peopleReviewApproval(original)];
    await act(async () => {
      if (action === 'add')
        await rendered.current!.actions.onSave!(['person:' + original.id], [], pins);
      else await rendered.current!.actions.onLater!(['person:' + original.id], pins);
    });
    expect(transport.writes).toHaveLength(1);
    const changed = structuredClone(original);
    changed.version = 'changed-v2';
    changed.person.relationship = 'sibling';
    transport.people = [changed];
    await act(() => router.navigate('/import?fixture-scope=b'));
    await act(() => router.navigate('/import'));
    const before = transport.reads;
    await act(async () => {
      if (action === 'add')
        await rendered.current!.actions.onSave!(
          ['person:' + original.id],
          [],
          [peopleReviewApproval(changed)],
        );
      else
        await rendered.current!.actions.onLater!(
          ['person:' + original.id],
          [peopleReviewApproval(changed)],
        );
    });
    expect(transport.writes).toHaveLength(1);
    expect(transport.reads).toBe(before);
    expect(screen.getByRole('button', { name: 'Retry exact People action' })).toBeVisible();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry exact People action' })),
    );
    expect(transport.writes).toHaveLength(2);
    expect(transport.writes[1]).toBe(transport.writes[0]);
    expect(transport.readsAtWrite[1]).toBe(before);
    expect(screen.queryByRole('button', { name: 'Retry exact People action' })).toBeNull();
  });

it('legacy late scope acknowledgement cannot mark a new owner saved or send the old successor', async () => {
  const people = [importPerson('fictional-first'), importPerson('fictional-unsent')];
  const transport = legacyTransport(people);
  const router = await openLegacy();
  let release!: () => void;
  transport.holdWrite = () =>
    new Promise<void>((done) => {
      release = done;
    });
  let run!: Promise<unknown>;
  act(() => {
    run = Promise.resolve(
      rendered.current!.actions.onSave!(
        people.map((person) => 'person:' + person.id),
        [],
        people.map(peopleReviewApproval),
      ),
    );
  });
  await waitFor(() => expect(transport.writes).toHaveLength(1));
  await act(() => router.navigate('/import?fixture-scope=b'));
  await act(() => router.navigate('/import'));
  await act(async () => {
    release();
    await run;
  });
  expect(transport.writes).toHaveLength(1);
  expect(rendered.current!.model.rejectedApprovalIds).toEqual([]);
  expect(screen.queryByText(/people were saved|person was saved/)).toBeNull();
});

it('legacy late old-profile acknowledgement does not clear a new profile unknown command with the same Person ID', async () => {
  const person = importPerson();
  const transport = legacyTransport([person]);
  await openLegacy();
  let release!: () => void;
  transport.holdWrite = () =>
    new Promise<void>((done) => {
      release = done;
    });
  let old!: Promise<unknown>;
  act(() => {
    old = Promise.resolve(
      rendered.current!.actions.onSave!(
        ['person:' + person.id],
        [],
        [peopleReviewApproval(person)],
      ),
    );
  });
  await waitFor(() => expect(transport.writes).toHaveLength(1));
  act(() =>
    selectProfile({ id: 'fictional-new-profile', name: 'Other fictional Self', placebo: true }),
  );
  await waitFor(() => expect(rendered.current!.actions.busy).toBe(false));
  await waitFor(() =>
    expect(rendered.current!.model.contextKey).toContain('fictional-new-profile'),
  );
  await waitFor(() => expect(rendered.current!.model.records.length).toBe(1));
  transport.failWrite = 2;
  await act(async () => {
    await rendered.current!.actions.onSave!(
      ['person:' + person.id],
      [],
      [peopleReviewApproval(person)],
    );
  });
  expect(transport.writes).toHaveLength(2);
  await act(async () => {
    release();
    await old;
  });
  expect(screen.getByRole('button', { name: 'Retry exact People action' })).toBeVisible();
  const before = transport.reads;
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact People action' })),
  );
  expect(transport.writes).toHaveLength(3);
  expect(transport.writes[2]).toBe(transport.writes[1]);
  expect(transport.writes[2]).not.toBe(transport.writes[0]);
  expect(transport.readsAtWrite[2]).toBe(before);
});

for (const state of ['later', 'excluded', 'pending'] as const)
  it(`legacy late ${state} acknowledgement cannot label a new scope or send a successor`, async () => {
    const people = [importPerson('fictional-first'), importPerson('fictional-unsent')];
    const transport = legacyTransport(people);
    const router = await openLegacy();
    let release!: () => void;
    transport.holdWrite = () =>
      new Promise<void>((done) => {
        release = done;
      });
    const action =
      state === 'later'
        ? rendered.current!.actions.onLater
        : state === 'excluded'
          ? rendered.current!.actions.onExclude
          : rendered.current!.actions.onResume;
    let run!: Promise<unknown>;
    act(() => {
      run = Promise.resolve(
        action!(
          people.map((person) => 'person:' + person.id),
          people.map(peopleReviewApproval),
        ),
      );
    });
    await waitFor(() => expect(transport.writes).toHaveLength(1));
    await act(() => router.navigate('/import?fixture-scope=b'));
    await act(() => router.navigate('/import'));
    await act(async () => {
      release();
      await run;
    });
    expect(transport.writes).toHaveLength(1);
    expect(screen.queryByText(/items? (?:was|were) (?:moved|excluded|returned)/)).toBeNull();
    expect(rendered.current!.model.rejectedApprovalIds).toEqual([]);
  });

it('legacy old profile A acknowledgement cannot clear a new A run after committed A to B to A', async () => {
  const person = importPerson();
  const transport = legacyTransport([person]);
  await openLegacy();
  let releaseOld!: () => void;
  transport.holdWrite = () =>
    new Promise<void>((done) => {
      releaseOld = done;
    });
  let old!: Promise<unknown>;
  act(() => {
    old = Promise.resolve(
      rendered.current!.actions.onSave!(
        ['person:' + person.id],
        [],
        [peopleReviewApproval(person)],
      ),
    );
  });
  await waitFor(() => expect(transport.writes).toHaveLength(1));
  act(() => selectProfile({ id: 'fictional-profile-b', name: 'Fictional B', placebo: true }));
  await waitFor(() => expect(rendered.current!.model.contextKey).toContain('fictional-profile-b'));
  act(() =>
    selectProfile({ id: 'fictional-legacy-people', name: 'Fictional Self', placebo: true }),
  );
  await waitFor(() =>
    expect(rendered.current!.model.contextKey).toContain('fictional-legacy-people'),
  );
  await waitFor(() => expect(rendered.current!.model.records).toHaveLength(1));
  let releaseNew!: () => void;
  transport.holdWrite = () =>
    new Promise<void>((done) => {
      releaseNew = done;
    });
  let current!: Promise<unknown>;
  act(() => {
    current = Promise.resolve(
      rendered.current!.actions.onSave!(
        ['person:' + person.id],
        [],
        [peopleReviewApproval(person)],
      ),
    );
  });
  await waitFor(() => expect(transport.writes).toHaveLength(2));
  await act(async () => {
    releaseOld();
    await old;
  });
  expect(rendered.current!.actions.busy).toBe(true);
  await act(async () => {
    releaseNew();
    await current;
  });
  expect(rendered.current!.actions.busy).toBe(false);
  expect(JSON.parse(transport.writes[0]!).operationId).not.toBe(
    JSON.parse(transport.writes[1]!).operationId,
  );
});

for (const status of [408, 429])
  it(`legacy ${status} acknowledgement remains an exact explicit retry`, async () => {
    const person = importPerson();
    const transport = legacyTransport([person]);
    await openLegacy();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let failed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof fetch>) => {
        if (!failed && args[1]?.method === 'POST' && String(args[0]).endsWith('/people-apply')) {
          failed = true;
          transport.writes.push(String(args[1].body));
          return Response.json(
            { error: { code: 'FICTIONAL_TRANSPORT', message: 'Fictional uncertain response' } },
            { status },
          );
        }
        return original(...args);
      }),
    );
    await act(async () => {
      await rendered.current!.actions.onSave!(
        ['person:' + person.id],
        [],
        [peopleReviewApproval(person)],
      );
    });
    const before = transport.reads;
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry exact People action' })),
    );
    expect(transport.writes).toHaveLength(2);
    expect(transport.writes[1]).toBe(transport.writes[0]);
    expect(transport.readsAtWrite[0]).toBe(before);
  });

for (const changed of [false, true])
  it(`legacy later-page approval keeps existing two-read preflight and ${changed ? 'refuses changed evidence' : 'posts once when unchanged'}`, async () => {
    const first = importPerson('fictional-first'),
      target = importPerson('fictional-last');
    const transport = legacyTransport([first]);
    const original = vi.mocked(fetch).getMockImplementation()!;
    let currentTarget = target;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (...args: Parameters<typeof fetch>) => {
        const url = new URL(String(args[0]), 'https://fictional.invalid');
        if (url.pathname.includes('/intakes/people/')) {
          transport.reads++;
          const cursor = url.searchParams.get('cursor');
          if (cursor) expect(cursor).toBe(first.id);
          return response({
            groupId: group.groupId,
            people: cursor ? [currentTarget] : [first],
            totalPeople: 2,
            peopleNextCursor: cursor ? null : first.id,
          });
        }
        return original(...args);
      }),
    );
    await openLegacy();
    expect(rendered.current!.model.records).toHaveLength(1);
    await act(async () => {
      await rendered.current!.actions.onLoadMore!();
    });
    await waitFor(() => expect(rendered.current!.model.records).toHaveLength(2));
    const approval = rendered.current!.model.records.find(
      (row) => row.id === 'person:' + target.id,
    )!.personApproval!;
    currentTarget = structuredClone(target);
    if (changed) {
      currentTarget.version = 'changed-later-page';
      currentTarget.person.relationship = 'sibling';
    }
    const before = transport.reads;
    let outcome: unknown;
    await act(async () => {
      outcome = await rendered.current!.actions.onSave!(['person:' + target.id], [], [approval]);
    });
    expect(transport.writes).toHaveLength(changed ? 0 : 1);
    if (changed) {
      expect(transport.reads - before).toBe(2);
      expect(outcome).toMatchObject({ rejectedIds: ['person:' + target.id] });
    } else expect(transport.readsAtWrite[0]! - before).toBe(2);
  });
