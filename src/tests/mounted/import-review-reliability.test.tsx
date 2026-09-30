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
import { SavedRecordDestinationLink } from '../../app/features/import/SavedRecordDestinations';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { IntakeAcceptedRecord } from '../../shared/intake';

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
