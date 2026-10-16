import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi, afterEach } from 'vitest';
import { RecordOwnershipAction } from '../../app/features/clinical-review/RecordOwnershipAction';
const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../app/data/api', () => ({ api: calls.api, ApiError: class extends Error {} }));
vi.mock('../../app/data/profile', () => ({ useProfile: () => ({ id: 'fictional-profile' }) }));
vi.mock('../../app/features/import/ImportPersonChoice', () => ({
  ImportPersonChoice: () => <div>Choose person</div>,
}));
vi.mock('../../app/features/notes/NoteDialog', () => ({
  NoteDialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
}));
afterEach(cleanup);
it.each([false, true])(
  'preserves retained split values and choices when acknowledging both records (edited=%s)',
  async (edit) => {
    const user = userEvent.setup();
    sessionStorage.clear();
    const person = {
      noteId: 'destination-note',
      personId: 'destination',
      version: 1,
      fullName: 'Fictional Destination',
      birthDate: null,
    };
    const selection = {
      type: 'report',
      intakeId: 'fictional-intake',
      groupId: 'fictional-report',
      groupVersionId: '1',
    };
    const original = { testLabel: 'Fictional value', valueText: '87', unit: 'mg' };
    const edited = { ...original, valueText: '99' };
    const url = '/native-report';
    const header = {
      request: { selection, destination: { noteId: person.noteId, expectedVersion: 1 } },
      scopeToken: 'scope',
      version: 2,
      destination: person,
      blockers: [],
      namesIncluded: false,
      nameEvidence: {
        token: 'names',
        digest: 'names',
        decisionDigest: 'names',
        complete: true,
        total: 0,
        supportTotal: 0,
        targetTotal: 0,
        url: '/names',
      },
      recordsIncluded: false,
      pendingIncluded: false,
      relationshipsIncluded: false,
      reportHoldsIncluded: false,
      reportEvidence: {
        token: 'owned',
        digest: 'report',
        complete: true,
        recordTotal: 1,
        pendingTotal: 0,
        relationshipTotal: 0,
        recordBlockerTotal: 0,
        reportHoldTotal: 0,
        url,
      },
      commitGroups: [],
    };
    let submitted: any;
    calls.api.mockImplementation(async (path: string, options?: any) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview')) return { data: header };
      if (path.startsWith('/names'))
        return { data: { items: [], total: 0, complete: true, after: null } };
      if (path === url && options?.method === 'POST') {
        submitted = JSON.parse(options.body);
        return { data: header };
      }
      if (path.startsWith(url))
        return {
          data: {
            items: [
              {
                kind: 'observation',
                recordId: 'fictional-result',
                version: '1',
                title: 'Fictional result',
                owner: { ...person, fullName: 'Former Fictional Person' },
                action: 'split',
                mapping: original,
                remainingMapping: original,
                splitReviewRequired: true,
                reviewedDecision: {
                  recordId: 'fictional-result',
                  action: 'keep_both',
                  splitMapping: edited,
                  remainingMapping: edited,
                  reviewedSplit: false,
                },
                contributions: [],
                blockers: [],
                medicationActivity: null,
                matches: [],
              },
            ],
            total: 1,
            complete: true,
            after: null,
          },
        };
      throw Error(path);
    });
    render(
      <MemoryRouter>
        <RecordOwnershipAction selection={selection as any} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    await screen.findByText('Fictional result');
    expect(screen.getAllByDisplayValue('99')).toHaveLength(2);
    const splitMapping = edit ? { ...edited, valueText: '101' } : edited;
    if (edit)
      fireEvent.change(
        within(
          screen.getByRole('group', { name: 'Transferred clinical contents' }),
        ).getByDisplayValue('99'),
        { target: { value: '101' } },
      );
    await user.click(screen.getByRole('checkbox', { name: /I reviewed both records/ }));
    expect(screen.getAllByDisplayValue('99')).toHaveLength(edit ? 1 : 2);
    await user.click(screen.getByRole('button', { name: 'Update preview' }));
    expect(submitted.decision).toMatchObject({
      reviewedSplit: true,
      action: 'keep_both',
      splitMapping,
      remainingMapping: edited,
    });
  },
);
