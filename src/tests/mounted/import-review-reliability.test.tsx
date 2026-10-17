import { useSourceAttentionRevision } from '../../app/features/import/useSourceAttentionRevision';
import type { IntakeSourceText } from '../../shared/intake-source-text';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  ImportPersonChoice,
  personSelectionReady,
} from '../../app/features/import/ImportPersonChoice';
import {
  SavedRecordDestinationLink,
  SavedRecordPeople,
} from '../../app/features/import/SavedRecordDestinations';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeAcceptedRecord } from '../../shared/intake';
import {
  ImportAcceptanceOutcomes,
  acceptanceSummary,
} from '../../app/features/import/ImportAcceptanceOutcomes';
import type { IntakePartialAcceptanceReceipt } from '../../shared/intake';

it('preserves keyboard focus and the exact Person choice through refreshed choices', async () => {
  const person = {
    noteId: 'fictional-note',
    personId: 'fictional-person',
    fullName: 'Cookie Meadow',
    version: 2,
    birthDate: '1980-01-01',
    relationship: 'sister',
  };
  const selection = { noteId: person.noteId, expectedVersion: 2 };
  const onChange = vi.fn();
  const view = render(
    <ImportPersonChoice people={[person]} selection={selection} onChange={onChange} />,
  );
  const picker = screen.getByRole('combobox', { name: 'Person for this report' });
  await userEvent.tab();
  expect(picker).toHaveFocus();
  view.rerender(
    <ImportPersonChoice
      people={[{ ...person, version: 3 }]}
      selection={selection}
      onChange={onChange}
    />,
  );
  expect(picker).toHaveFocus();
  expect(picker).toHaveValue(person.noteId);
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<ImportPersonChoice people={[]} selection={selection} onChange={onChange} />);
  expect(picker).toHaveFocus();
  expect(picker).toHaveValue(person.noteId);
});
it('shares canonical second-Self checks and associates the error with the name control', () => {
  const selection = { newPerson: { fullName: '  COOKIE MEADOW ' } };
  expect(personSelectionReady(selection, ['Cookie Meadow'])).toBe(false);
  render(
    <ImportPersonChoice selfNames={['Cookie Meadow']} selection={selection} onChange={() => {}} />,
  );
  expect(screen.getByLabelText('New person name')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('New person name')).toHaveAccessibleDescription(
    'This name belongs to Self. Choose Me (Self).',
  );
});
it('resolves a saved destination current owner independently of its historical receipt', async () => {
  const profile = { id: 'fictional-owner-profile', name: 'Fictional Self', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: { personId: 'fictional-current-owner' } })),
  );
  const record: IntakeAcceptedRecord = {
    recordId: 'exact-source-occurrence',
    entityId: 'exact-medication',
    kind: 'medication',
    title: 'Fictional prescription',
    optical: false,
    outcome: 'added',
  };
  render(
    <MemoryRouter>
      <SavedRecordDestinationLink record={record} />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/medications?id=exact-medication&status=all&personId=fictional-current-owner',
    ),
  );
  expect(screen.getByRole('link')).toHaveAttribute(
    'data-saved-record-id',
    'exact-source-occurrence',
  );
});

it('ignores stale source reads and old-profile save responses', () => {
  const data = (id: string, parentRevisionId: string | null, createdAt: string) =>
    ({
      status: 'available',
      revision: { id, parentRevisionId, createdAt },
      summary: {},
    }) as IntakeSourceText;
  const first = data('one', null, '2026-09-01'),
    next = data('two', 'one', '2026-09-02');
  const view = renderHook(
    ({ scope, remote, sequence }) => useSourceAttentionRevision(scope, remote, sequence),
    { initialProps: { scope: 'profile-one:intake', remote: first, sequence: 1 } },
  );
  act(() => {
    expect(view.result.current.accept(next, 2, 'profile-one:intake')).toBe(true);
  });
  view.rerender({ scope: 'profile-one:intake', remote: first, sequence: 1 });
  expect(view.result.current.data?.revision?.id).toBe('two');
  view.rerender({ scope: 'profile-two:intake', remote: first, sequence: 1 });
  act(() => {
    expect(view.result.current.accept(next, 3, 'profile-one:intake')).toBe(false);
  });
  expect(view.result.current.data?.revision?.id).toBe('one');
});

it('names same-name owners distinctly in failed outcomes and falls back without raw IDs', async () => {
  const profile = { id: 'fictional-outcome-profile', name: 'Fictional Self', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  let peopleAttempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (++peopleAttempts === 1)
        return Response.json({ error: { message: 'Fictional lookup failure' } }, { status: 400 });
      return Response.json({
        data: [
          {
            noteId: 'one-note',
            personId: 'one',
            version: 1,
            fullName: 'Rowan Meadow',
            birthDate: '1980-01-01',
            relationship: 'Sibling',
          },
          {
            noteId: 'two-note',
            personId: 'two',
            version: 1,
            fullName: 'Rowan Meadow',
            birthDate: '1950-01-01',
            relationship: 'Parent',
          },
        ],
      });
    }),
  );
  const receipt: IntakePartialAcceptanceReceipt = {
    version: 1,
    operationId: 'fictional-operation',
    status: 'completed',
    atomic: false,
    at: '2026-09-01',
    selectedCount: 2,
    acceptedCount: 0,
    receipts: [],
    items: ['one', 'two'].map((personId, index) => ({
      selectionReviewToken: 'fictional-token',
      reviewedSelectionHash: 'fictional-hash',
      intakeId: 'fictional-intake',
      proposalId: null,
      recordId: `opaque-record-${index}`,
      candidateId: `fictional-candidate-${index}`,
      candidateVersionId: 'fictional-version',
      operationId: `fictional-child-${index}`,
      status: 'needs_review' as const,
      label: `Fictional result ${index}`,
      kind: 'observation' as const,
      personId,
      message: 'Review the current version.',
    })),
  };
  const view = render(
    <MemoryRouter>
      <ImportAcceptanceOutcomes receipt={receipt} />
    </MemoryRouter>,
  );
  expect(acceptanceSummary(receipt)).toBe('0 saved, 2 need review');
  await userEvent.click(await screen.findByRole('button', { name: 'Retry person details' }));
  await waitFor(() =>
    expect(
      screen.getByRole('link', { name: /Fictional result 0.*Rowan Meadow.*1980-01-01.*Sibling/ }),
    ).toBeVisible(),
  );
  expect(
    screen.getByRole('link', { name: /Fictional result 1.*Rowan Meadow.*1950-01-01.*Parent/ }),
  ).toBeVisible();
  expect(peopleAttempts).toBe(2);
  view.rerender(
    <MemoryRouter>
      <ImportAcceptanceOutcomes
        receipt={{
          ...receipt,
          items: [
            {
              ...receipt.items[0]!,
              label: undefined,
              personId: undefined,
              reportName: 'Fictional report',
            },
          ],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /Record in Fictional report/ })).not.toHaveTextContent(
    'opaque-record-0',
  );
  expect(screen.getByRole('link', { name: /Record in Fictional report/ })).toHaveTextContent(
    'Person not confirmed',
  );
});

it('shows current person corrections and exact alike-name identities with one People read for many saved links', async () => {
  const profile = { id: 'fictional-many-saved', name: 'Fictional Self', placebo: true };
  replaceProfiles([profile]);
  selectProfile(profile);
  const people = [
    {
      noteId: 'fictional-younger-note',
      personId: 'fictional-younger',
      version: 1,
      fullName: 'Rowan Meadow',
      birthDate: '1980-01-01',
      relationship: 'Sibling',
    },
    {
      noteId: 'fictional-older-note',
      personId: 'fictional-older',
      version: 1,
      fullName: 'Rowan Meadow',
      birthDate: '1980-01-01',
      relationship: 'Sibling',
    },
  ];
  let resolveOwner!: (response: Response) => void;
  const unresolved = new Promise<Response>((resolve) => {
    resolveOwner = resolve;
  });
  const fetcher = vi.fn(async (input) => {
    const url = String(input);
    if (url.endsWith('/record-ownership/people')) return Response.json({ data: people });
    if (url.includes('id=fictional-destination-0')) return unresolved;
    if (url.includes('/record-owner?'))
      return Response.json({ data: { personId: 'fictional-older' } });
    throw Error('Unexpected route: ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const records = Array.from({ length: 20 }, (_, index): IntakeAcceptedRecord => ({
    recordId: `fictional-source-${index}`,
    entityId: `fictional-destination-${index}`,
    kind: 'observation',
    title: `Fictional marker ${index}`,
    optical: false,
    outcome: 'added',
    identityAttribution: {
      assignedPerson: { personId: 'patient' },
    } as IntakeAcceptedRecord['identityAttribution'],
  }));
  const { SavedRecordDestinations } =
    await import('../../app/features/import/SavedRecordDestinations');
  render(
    <MemoryRouter>
      <SavedRecordDestinations records={records} />
    </MemoryRouter>,
  );
  expect(
    screen.getByText('Fictional marker 0').closest('[data-saved-record-id]'),
  ).toHaveTextContent('Checking person');
  expect(screen.queryByRole('link', { name: /Fictional marker 0/ })).toBeNull();
  expect(
    screen.getByText('Fictional marker 0').closest('[data-saved-record-id]'),
  ).not.toHaveTextContent('Self');
  await act(async () => {
    resolveOwner(Response.json({ data: { personId: 'fictional-younger' } }));
  });
  await waitFor(() =>
    expect(
      screen.getByRole('link', {
        name: /Fictional marker 0.*Rowan Meadow.*DOB 1980-01-01.*Sibling.*fictional-younger/,
      }),
    ).toHaveAttribute(
      'href',
      '/tests?result=fictional-destination-0&visibility=all&personId=fictional-younger',
    ),
  );
  expect(
    screen.getByRole('link', { name: /Fictional marker 1Rowan.*fictional-older/ }),
  ).toHaveAttribute(
    'href',
    '/tests?result=fictional-destination-1&visibility=all&personId=fictional-older',
  );
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith('/record-ownership/people')),
  ).toHaveLength(1);
});

it.each(['shared list', 'standalone'] as const)(
  'retries failed person details without changing exact saved destinations (%s)',
  async (mode) => {
    const profile = { id: 'fictional-people-retry', name: 'Fictional Self', placebo: true };
    replaceProfiles([profile]);
    selectProfile(profile);
    let peopleRequests = 0;
    const people = ['younger', 'older'].map((suffix, index) => ({
      noteId: `fictional-${suffix}-note`,
      personId: `fictional-${suffix}`,
      version: 1,
      fullName: 'Rowan Meadow',
      birthDate: index ? '1950-01-01' : '1980-01-01',
      relationship: index ? 'Parent' : 'Sibling',
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith('/record-ownership/people')) {
          peopleRequests++;
          return peopleRequests === 1
            ? Response.json(
                { error: { message: 'Fictional unavailable details' } },
                { status: 400 },
              )
            : Response.json({ data: people });
        }
        if (url.includes('/record-owner?'))
          return Response.json({
            data: { personId: url.includes('id=older') ? 'fictional-older' : 'fictional-younger' },
          });
        throw Error('Unexpected route: ' + url);
      }),
    );
    const record = (entityId: string): IntakeAcceptedRecord => ({
      recordId: `fictional-source-${entityId}`,
      entityId,
      kind: 'observation',
      title: `Fictional ${entityId} result`,
      optical: false,
      outcome: 'added',
    });
    render(
      <MemoryRouter>
        {mode === 'shared list' ? (
          <SavedRecordPeople>
            <SavedRecordDestinationLink record={record('younger')} />
            <SavedRecordDestinationLink record={record('older')} />
          </SavedRecordPeople>
        ) : (
          <SavedRecordDestinationLink record={record('younger')} />
        )}
      </MemoryRouter>,
    );
    const retry = await screen.findByRole('button', { name: 'Retry person details' });
    const link = await screen.findByRole('link', {
      name: /Fictional younger result.*Person details unavailable/,
    });
    expect(link).toHaveAttribute(
      'href',
      '/tests?result=younger&visibility=all&personId=fictional-younger',
    );
    expect(retry.closest('a')).toBeNull();
    expect(peopleRequests).toBe(1);
    await userEvent.click(retry);
    await waitFor(() =>
      expect(
        screen.getByRole('link', {
          name: /Fictional younger result.*Rowan Meadow.*1980-01-01.*Sibling/,
        }),
      ).toHaveAttribute('href', link.getAttribute('href')),
    );
    if (mode === 'shared list')
      expect(
        screen.getByRole('link', {
          name: /Fictional older result.*Rowan Meadow.*1950-01-01.*Parent/,
        }),
      ).toHaveAttribute('href', '/tests?result=older&visibility=all&personId=fictional-older');
    expect(screen.queryByRole('button', { name: 'Retry person details' })).toBeNull();
    expect(peopleRequests).toBe(2);
  },
);
