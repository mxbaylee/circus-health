import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { selectProfile, replaceProfiles } from '../../app/data/profile';
import { beforeEach, expect, it, vi } from 'vitest';
import { importPerson } from '../fixtures/import-person';
import { useCollectionBulkActions } from '../../app/features/import/useCollectionBulkActions';
import { collectionDisplayPerson } from '../../app/features/import/collection-display-model';
import {
  ImportReviewPresentation,
  type ImportReviewModel,
} from '../../app/features/import/ImportReviewPresentation';
import {
  peopleReviewApproval,
  requirePeopleApprovals,
} from '../../app/features/import/people-review-approval';
import { useReviewApprovalSelection } from '../../app/features/import/useReviewApprovalSelection';
import type { CollectionPersonProposal } from '../../shared/intake-clinical-pages';

beforeEach(() => {
  const profile = { id: 'fictional-people-approval', name: 'Fictional Self', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
});
const response = (data: unknown) => Response.json({ data });
const page = (person: CollectionPersonProposal) => ({
  intakeId: person.intakeId,
  groupId: person.groupId,
  selectedPersonId: person.id,
  people: [{ kind: 'person', person }],
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function model(person = importPerson(), contextKey = 'fictional-profile'): ImportReviewModel {
  return {
    contextKey,
    selectionWindowKey: contextKey,
    reports: [
      {
        id: person.groupId,
        source: 'Fictional clinic',
        sourceConfirmed: true,
        reportType: 'Fictional family record',
        date: '2026-10-16',
        subject: { label: 'Self', evidence: 'named', confirmed: true },
      },
    ],
    records: [collectionDisplayPerson(person)],
  };
}
const callbacks = () => ({
  onClinicalDone: vi.fn(),
  onPersonDone: vi.fn(),
  onPersonSaved: vi.fn(),
  onRefresh: vi.fn(),
});

it('detaches ticked details from mutable rows and keeps equivalent unrelated refreshes selected', () => {
  const person = importPerson();
  const row = collectionDisplayPerson(person);
  const view = renderHook(() => useReviewApprovalSelection());
  act(() => view.result.current.toggle(row.id, [row]));
  person.person.tags.push('Professional');
  row.personApproval!.person.relationship = 'sibling';
  expect(view.result.current.peopleApprovals([row.id])[0]!.person).toEqual({
    fullName: 'Fictional Alex',
    relationship: 'child',
    tags: ['Family'],
  });
  const unrelated = { ...importPerson(), intakeVersion: 99, groupVersionId: 'transport-v99' };
  act(() => {
    view.result.current.revokeChanged([collectionDisplayPerson(unrelated)]);
  });
  expect(view.result.current.selected.has(row.id)).toBe(true);
  act(() => {
    view.result.current.revokeChanged([row]);
  });
  expect(view.result.current.selected.has(row.id)).toBe(false);
});

it('requires a snapshot for every requested Person without silently filtering a missing one', () => {
  const first = peopleReviewApproval(importPerson());
  expect(() =>
    requirePeopleApprovals(['person:' + first.id, 'person:fictional-missing'], [first]),
  ).toThrow(/approve them again/);
});

for (const change of [
  'version',
  'name',
  'relationship',
  'tags',
  'phone',
  'email',
  'schedulingUrl',
  'medicalHistory',
  'intake',
  'group',
  'selfMatch',
  'matchesTruncated',
  'saved',
] as const)
  for (const action of ['add', 'later'] as const)
    it(`refuses ${action} when fresh People ${change} differs from the clicked approval`, async () => {
      const shown = importPerson();
      const fresh = structuredClone(shown);
      if (change === 'version') fresh.version = 'v2';
      if (change === 'name') fresh.person.fullName = 'Fictional Rowan';
      if (change === 'relationship') fresh.person.relationship = 'sibling';
      if (change === 'tags') fresh.person.tags.push('Professional');
      if (change === 'phone') fresh.person.phone = '555-0100';
      if (change === 'email') fresh.person.email = 'fictional@example.invalid';
      if (change === 'schedulingUrl') fresh.person.schedulingUrl = 'https://fictional.invalid';
      if (change === 'medicalHistory') fresh.person.medicalHistory = 'Fictional history';
      if (change === 'intake') fresh.intakeId = 'another-intake';
      if (change === 'group') fresh.groupId = 'another-group';
      if (change === 'selfMatch') fresh.selfMatch = { reason: 'Fictional Self match' };
      if (change === 'matchesTruncated') fresh.matchesTruncated = true;
      if (change === 'saved') fresh.state = 'saved';
      const writes: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input, init) => {
          if (init?.method === 'POST') {
            writes.push(String(init.body));
            return response({});
          }
          return response(page(fresh));
        }),
      );
      const { result } = renderHook(() =>
        useCollectionBulkActions({ scope: 'fictional-a', people: [shown], ...callbacks() }),
      );
      await act(() =>
        action === 'add'
          ? result.current.addPeople([peopleReviewApproval(shown)], shown.groupId)
          : result.current.disposition([], [peopleReviewApproval(shown)], shown.groupId, 'later'),
      );
      // A match blocks adding, not the independent act of setting a review disposition.
      const matchDisposition =
        action === 'later' && ['selfMatch', 'matchesTruncated'].includes(change);
      expect(writes).toHaveLength(matchDisposition ? 1 : 0);
      if (!matchDisposition) expect(result.current.error).toMatch(/changed|match decision/);
    });

for (const action of ['add', 'later', 'excluded', 'pending'] as const)
  it(`keeps an unchanged ${action} action at one preflight plus one exact POST`, async () => {
    const shown = importPerson();
    let reads = 0;
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init) => {
        if (init?.method === 'POST') {
          writes.push(JSON.parse(String(init.body)));
          return response({});
        }
        reads++;
        return response(page({ ...shown, intakeVersion: 99, groupVersionId: 'v99' }));
      }),
    );
    const { result } = renderHook(() =>
      useCollectionBulkActions({ scope: 'fictional-a', people: [shown], ...callbacks() }),
    );
    await act(() =>
      action === 'add'
        ? result.current.addPeople([peopleReviewApproval(shown)], shown.groupId)
        : result.current.disposition([], [peopleReviewApproval(shown)], shown.groupId, action),
    );
    expect(reads).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      proposalVersion: shown.version,
      intakeId: shown.intakeId,
      proposalId: shown.id,
    });
    if (action !== 'add') expect(writes[0]!.intakeVersion).toBe(99);
  });

it('refuses changed displayed details while the preflight is held even when the server returns the old row', async () => {
  const shown = importPerson();
  const held = deferred();
  const writes = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, init) => {
      if (init?.method === 'POST') {
        writes();
        return response({});
      }
      await held.promise;
      return response(page(shown));
    }),
  );
  const { result, rerender } = renderHook(
    ({ people }) => useCollectionBulkActions({ scope: 'fictional-a', people, ...callbacks() }),
    { initialProps: { people: [shown] } },
  );
  let run!: Promise<unknown>;
  act(() => {
    run = result.current.addPeople([peopleReviewApproval(shown)], shown.groupId);
  });
  const changed = structuredClone(shown);
  changed.person.relationship = 'sibling';
  rerender({ people: [changed] });
  await act(async () => {
    held.resolve();
    await run;
  });
  expect(writes).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/approve them again/);
});

it('replays an already-issued unknown command exactly but refuses a changed unsent successor', async () => {
  const people = [
    importPerson('fictional-first'),
    importPerson('fictional-unknown'),
    importPerson('fictional-unsent'),
  ];
  const writes: string[] = [];
  const reads: string[] = [];
  const saved = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      if (init?.method === 'POST') {
        writes.push(String(init.body));
        if (writes.length === 2) throw new TypeError('Fictional lost acknowledgement');
        return response({});
      }
      const id = new URL(String(input), 'https://fictional.invalid').searchParams.get('personId')!;
      reads.push(id);
      return response(page(people.find((person) => person.id === id)!));
    }),
  );
  const { result, rerender } = renderHook(
    ({ shown }) =>
      useCollectionBulkActions({
        scope: 'fictional-a',
        people: shown,
        ...callbacks(),
        onPersonSaved: saved,
      }),
    { initialProps: { shown: structuredClone(people) } },
  );
  await act(() => result.current.addPeople(people.map(peopleReviewApproval), people[0]!.groupId));
  expect(saved).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(true);
  const changed = structuredClone(people);
  changed[1]!.person.fullName = 'Changed unknown';
  changed[2]!.version = 'changed-unsent';
  rerender({ shown: changed });
  await act(() => result.current.retry());
  expect(writes).toHaveLength(3);
  expect(writes[2]).toBe(writes[1]);
  expect(reads).toEqual([people[0]!.id, people[1]!.id]);
  expect(saved).toHaveBeenCalledTimes(2);
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toMatch(/approve them again/);
});

for (const action of ['bulk-add', 'bulk-later', 'row-add', 'row-later'] as const)
  it(`pins ${action} before awaiting confirmation and refuses changed rows with a notice`, async () => {
    const shown = model();
    const held = deferred();
    const save = vi.fn(),
      later = vi.fn();
    const props = {
      actions: { onSave: save, onLater: later },
      beforeReviewChange: () => held.promise.then(() => true),
    };
    const view = render(<ImportReviewPresentation model={shown} {...props} />, {
      wrapper: MemoryRouter,
    });
    if (action.startsWith('bulk'))
      fireEvent.click(screen.getByRole('checkbox', { name: /Select Fictional Alex/ }));
    fireEvent.click(
      screen.getByRole('button', {
        name:
          action === 'bulk-add'
            ? 'Add 1 person'
            : action === 'bulk-later'
              ? 'Later 1'
              : action === 'row-add'
                ? 'Confirm & save'
                : 'Later',
      }),
    );
    const changed = structuredClone(shown);
    changed.records[0]!.personApproval!.person.relationship = 'sibling';
    view.rerender(<ImportReviewPresentation model={changed} {...props} />);
    await act(async () => held.resolve());
    expect(save).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    expect(screen.getByText(/changed while you were reviewing; review and approve/)).toBeVisible();
  });

it('invalidates a held confirmation after committed scope A to B to A', async () => {
  const original = model();
  const held = deferred();
  const save = vi.fn();
  const props = {
    actions: { onSave: save },
    beforeReviewChange: () => held.promise.then(() => true),
  };
  const view = render(<ImportReviewPresentation model={original} {...props} />, {
    wrapper: MemoryRouter,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
  view.rerender(
    <ImportReviewPresentation
      model={{ ...original, contextKey: 'fictional-b', selectionWindowKey: 'fictional-b' }}
      {...props}
    />,
  );
  view.rerender(<ImportReviewPresentation model={original} {...props} />);
  await act(async () => held.resolve());
  expect(save).not.toHaveBeenCalled();
});

it('allows an unticked direct-row action with its clicked approval', async () => {
  const shown = model();
  const save = vi.fn().mockResolvedValue({ savedIds: [] });
  render(<ImportReviewPresentation model={shown} actions={{ onSave: save }} />, {
    wrapper: MemoryRouter,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm & save' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      [shown.records[0]!.id],
      [],
      [shown.records[0]!.personApproval],
    ),
  );
});

it('counts two changed People, clears both ticks, and sends no action on background refresh', () => {
  const original = model();
  const other = importPerson('fictional-second');
  other.person.fullName = 'Fictional Rowan';
  original.records.push(collectionDisplayPerson(other));
  const save = vi.fn(),
    later = vi.fn();
  const actions = { onSave: save, onLater: later };
  const view = render(<ImportReviewPresentation model={original} actions={actions} />, {
    wrapper: MemoryRouter,
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /Select all shown/ }));
  const changed = structuredClone(original);
  changed.records[0]!.personApproval!.person.relationship = 'sibling';
  changed.records[1]!.personApproval!.version = 'new-v2';
  view.rerender(<ImportReviewPresentation model={changed} actions={actions} />);
  expect(screen.getByRole('checkbox', { name: 'Select Fictional Alex' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select Fictional Rowan' })).not.toBeChecked();
  expect(
    screen.getByText('2 selected items changed while you were reviewing; approve them again.'),
  ).toBeVisible();
  expect(save).not.toHaveBeenCalled();
  expect(later).not.toHaveBeenCalled();
});

it('a retry rejection event revokes once and permits an explicit new tick after review', () => {
  const original = model();
  const actions = { onSave: vi.fn() };
  const view = render(<ImportReviewPresentation model={original} actions={actions} />, {
    wrapper: MemoryRouter,
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional Alex' }));
  const rejected = { ...original, rejectedApprovalIds: [original.records[0]!.id] };
  view.rerender(<ImportReviewPresentation model={rejected} actions={actions} />);
  expect(screen.getByRole('checkbox', { name: 'Select Fictional Alex' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Fictional Alex' }));
  view.rerender(<ImportReviewPresentation model={{ ...rejected }} actions={actions} />);
  expect(screen.getByRole('checkbox', { name: 'Select Fictional Alex' })).toBeChecked();
});
