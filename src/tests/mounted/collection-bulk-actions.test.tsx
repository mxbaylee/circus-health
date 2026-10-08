import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  CollectionImportReview,
  CollectionPeople,
} from '../../app/features/import/CollectionImportReview';
import type { CollectionImportFeed } from '../../shared/intake-clinical-pages';
import { useCollectionBulkActions } from '../../app/features/import/useCollectionBulkActions';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { CollectionPersonProposal } from '../../shared/intake-clinical-pages';
import type { IntakePersonApplyRequest } from '../../shared/intake-people';
vi.mock('../../app/features/import/ImportSourceTextBrowser', () => ({
  ImportSourceTextBrowser: () => null,
}));
const profile = { id: 'fictional-bulk-review', name: 'Fictional Reader', placebo: true };
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
beforeEach(() => {
  sessionStorage.clear();
  replaceProfiles([profile]);
  selectProfile(profile);
});
for (const failure of ['uncertain', 'definite'] as const)
  it(`retains prior successful People destinations and retries only the unresolved shown selection after ${failure} failure`, async () => {
    const first = person('Fictional Ellis'),
      second = person('Fictional Rowan');
    const writes: IntakePersonApplyRequest[] = [];
    const done = vi.fn(),
      saved = vi.fn(),
      changed = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = new URL(String(input), 'https://fictional.invalid');
        if (url.pathname.includes('/people/')) {
          const selected = url.searchParams.get('personId') === first.id ? first : second;
          expect(url.searchParams.get('limit')).toBe('1');
          expect(url.searchParams.get('view')).toBe('all');
          return json({
            format: 'health-intake-people-page-v2',
            intakeId: 'fictional-intake',
            groupId: 'fictional-group',
            selectedPersonId: selected.id,
            totalPeople: 2,
            people: [{ kind: 'person', person: selected }],
            counts: { pending: 0, later: 2, excluded: 0, saved: 0 },
            nextCursor: null,
          });
        }
        if (url.pathname.endsWith('/people-apply')) {
          const body = JSON.parse(String(init?.body));
          writes.push(body);
          if (writes.length === 2) {
            if (failure === 'uncertain') throw new TypeError('Fictional response lost');
            return json({ code: 'VERSION_CONFLICT', message: 'Fictional Person changed.' }, 409);
          }
          return json({
            proposalId: body.proposalId,
            status: 'saved',
            action: 'add',
            noteId: `note-${body.proposalId}`,
            personId: `person-${body.proposalId}`,
            resultUrl: `/#/people?id=${encodeURIComponent(body.proposalId)}`,
          });
        }
        throw new Error(`Unexpected ${url}`);
      }),
    );
    const { result } = renderHook(() =>
      useCollectionBulkActions({
        scope: 'fictional-current-page',
        onClinicalDone: vi.fn(),
        onPersonDone: done,
        onPersonSaved: saved,
        onRefresh: changed,
      }),
    );
    await act(() => result.current.addPeople([first, second], 'fictional-group'));
    expect(writes).toHaveLength(2);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(saved.mock.calls[0]![0].proposalId).toBe(first.id);
    expect(done.mock.calls).toEqual([[first.id]]);
    expect(result.current.pending).toBe(failure === 'uncertain');
    if (failure === 'uncertain') {
      await act(() => result.current.addPeople([second], 'fictional-group'));
      expect(writes).toHaveLength(2);
      await act(() => result.current.retry());
      expect(writes[2]).toEqual(writes[1]);
    } else {
      await act(() => result.current.addPeople([second], 'fictional-group'));
      expect(writes[2]!.operationId).not.toBe(writes[1]!.operationId);
    }
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(saved).toHaveBeenCalledTimes(2);
    expect(writes.map((request) => request.proposalId)).toEqual([first.id, second.id, second.id]);
    expect(done.mock.calls).toEqual([[first.id], [second.id]]);
  });

it('keeps the exact uncertain Person command mounted when refreshed active discovery removes the committed report', async () => {
  const selected = person('Fictional Ellis');
  const feed: CollectionImportFeed = {
    format: 'health-intake-import-feed-v2',
    view: 'active',
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
      person: 1,
      unsupported: 0,
    },
    groups: [],
    people: {
      groups: [
        {
          format: 'health-intake-report-group-reference-v2',
          binding: 'fictional-group-v1',
          intakeId: selected.intakeId,
          groupId: selected.groupId,
          ordinal: 0,
          bytes: 80,
        },
      ],
      totalGroups: 1,
      counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
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
  };
  let committed = false;
  const writes: IntakePersonApplyRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.endsWith('/import-feed'))
        return json(
          committed
            ? {
                ...feed,
                people: {
                  ...feed.people,
                  groups: [],
                  totalGroups: 0,
                  counts: { pending: 0, later: 0, excluded: 0, saved: 1 },
                },
              }
            : feed,
        );
      if (url.pathname.includes('/people/'))
        return json({
          format: 'health-intake-people-page-v2',
          intakeId: selected.intakeId,
          groupId: selected.groupId,
          selectedPersonId: url.searchParams.has('personId') ? selected.id : null,
          totalPeople: 1,
          people: [{ kind: 'person', person: { ...selected, state: 'pending' } }],
          counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
          nextCursor: null,
        });
      if (url.pathname.endsWith('/people-apply')) {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        committed = true;
        if (writes.length === 1) throw new TypeError('Fictional acknowledgement lost');
        return json({
          proposalId: body.proposalId,
          status: 'saved',
          action: 'add',
          noteId: 'fictional-note',
          personId: 'fictional-person',
          resultUrl: '/#/people?id=fictional-note',
        });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <MemoryRouter>
      <CollectionImportReview
        initial={feed}
        path="/intakes/import-feed?view=active"
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
  await act(async () => {});
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 person' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('checkbox', { name: 'Select Fictional Ellis' }),
    ).not.toBeInTheDocument(),
  );
  const retry = await screen.findByRole('button', { name: 'Retry exact selected action' });
  expect(screen.getByRole('combobox', { name: 'Review status' })).toBeDisabled();
  fireEvent.click(retry);
  await screen.findByRole('region', { name: 'Just saved People' });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(screen.getByRole('link', { name: /Fictional Ellis/ })).toHaveAttribute(
    'href',
    '/#/people?id=fictional-note',
  );
});

it('waits for fresh People evidence after receipt recovery before enabling Add', async () => {
  const selected = person('Fictional Ellis');
  const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  sessionStorage.setItem(`circus-health:report-acceptance:${profile.id}`, operationId);
  const feed: CollectionImportFeed = {
    format: 'health-intake-import-feed-v2',
    view: 'active',
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
      person: 1,
      unsupported: 0,
    },
    groups: [],
    people: {
      groups: [
        {
          format: 'health-intake-report-group-reference-v2',
          binding: 'fictional-group-v1',
          intakeId: selected.intakeId,
          groupId: selected.groupId,
          ordinal: 0,
          bytes: 80,
        },
      ],
      totalGroups: 1,
      counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
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
  };
  let receiptReads = 0;
  let peopleListReads = 0;
  let releasePeopleReload!: (response: Response) => void;
  const peopleReload = new Promise<Response>((resolve) => {
    releasePeopleReload = resolve;
  });
  const writes: IntakePersonApplyRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'https://fictional.invalid');
      if (url.pathname.includes('/report-acceptance/')) {
        receiptReads++;
        if (receiptReads === 1)
          return json({ code: 'FICTIONAL_RECEIPT_UNAVAILABLE', message: 'Try again.' }, 503);
        return json({
          replayed: true,
          receipt: {
            operationId,
            acceptedCount: 0,
            atomic: true,
            receipts: [],
            items: [],
          },
        });
      }
      if (url.pathname.endsWith('/import-feed')) return json(feed);
      if (url.pathname.includes('/people/')) {
        const page = {
          format: 'health-intake-people-page-v2',
          intakeId: selected.intakeId,
          groupId: selected.groupId,
          selectedPersonId: url.searchParams.get('personId'),
          totalPeople: 1,
          people: [{ kind: 'person', person: { ...selected, state: 'pending' } }],
          counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
          nextCursor: null,
        };
        if (url.searchParams.has('personId')) return json(page);
        peopleListReads++;
        return peopleListReads === 2 ? peopleReload : json(page);
      }
      if (url.pathname.endsWith('/people-apply')) {
        const body = JSON.parse(String(init?.body)) as IntakePersonApplyRequest;
        writes.push(body);
        return json({
          proposalId: body.proposalId,
          status: 'saved',
          action: 'add',
          noteId: 'fictional-note',
          personId: 'fictional-person',
          resultUrl: '/#/people?id=fictional-note',
        });
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
  render(
    <MemoryRouter>
      <CollectionImportReview
        initial={feed}
        path="/intakes/import-feed?view=active"
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
  await screen.findByRole('button', { name: 'Check save status' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check save status' }));
  await waitFor(() => expect(peopleListReads).toBe(2));
  const add = screen.getByRole('button', { name: 'Add 1 person' });
  const rowSave = screen.getByRole('button', { name: 'Confirm & save' });
  expect(add).toBeDisabled();
  expect(rowSave).toBeDisabled();
  expect(writes).toHaveLength(0);
  await act(async () =>
    releasePeopleReload(
      json({
        format: 'health-intake-people-page-v2',
        intakeId: selected.intakeId,
        groupId: selected.groupId,
        selectedPersonId: null,
        totalPeople: 1,
        people: [{ kind: 'person', person: { ...selected, state: 'pending' } }],
        counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
        nextCursor: null,
      }),
    ),
  );
  await waitFor(() => expect(add).toBeEnabled());
  expect(rowSave).toBeEnabled();
  fireEvent.click(add);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.proposalId).toBe(selected.id);
});
it('retains a report Person exact retry and pending guard after its displayed proposal disappears', async () => {
  const selected = { ...person('Fictional Tamsin'), state: 'pending' as const };
  const writes: unknown[] = [];
  const pending = vi.fn(),
    refresh = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      writes.push(JSON.parse(String(init?.body)));
      if (writes.length === 1) throw new TypeError('Fictional person reply lost');
      return json({
        proposalId: selected.id,
        status: 'saved',
        action: 'add',
        noteId: 'fictional-note',
        personId: 'fictional-person',
        resultUrl: '/#/people?id=fictional-note',
      });
    }),
  );
  const page = {
    format: 'health-intake-people-page-v2' as const,
    intakeId: selected.intakeId,
    groupId: selected.groupId,
    selectedPersonId: selected.id,
    people: [{ kind: 'person' as const, person: selected }],
    totalPeople: 1,
    counts: { pending: 1, later: 0, excluded: 0, saved: 0 },
    nextCursor: null,
  };
  const mounted = render(
    <CollectionPeople
      page={page}
      groupId={selected.groupId}
      preferredPersonId={selected.id}
      onRefresh={refresh}
      onNext={vi.fn()}
      onPending={pending}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add as new person' }));
  await screen.findByText('Fictional person reply lost');
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Add as new person' })).toBeDisabled();
  mounted.rerender(
    <CollectionPeople
      page={{ ...page, people: [], totalPeople: 0 }}
      groupId={selected.groupId}
      preferredPersonId={selected.id}
      onRefresh={refresh}
      onNext={vi.fn()}
      onPending={pending}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact Person choice' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(pending).toHaveBeenLastCalledWith(false);
});
