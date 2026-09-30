import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordOwnershipAction } from '../../app/features/clinical-review/RecordOwnershipAction';
import { OwnershipSelectionControl } from '../../app/features/clinical-review/OwnershipSelectionControl';
import { ApiError } from '../../app/data/api';

const calls = vi.hoisted(() => ({ api: vi.fn(), profileId: 'fictional-profile' }));
vi.mock('../../app/data/api', () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public code: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock('../../app/data/profile', () => ({ useProfile: () => ({ id: calls.profileId }) }));
vi.mock('../../app/features/import/ImportPersonChoice', () => ({
  ImportPersonChoice: () => <div>Choose person</div>,
}));
vi.mock('../../app/features/notes/NoteDialog', () => ({
  NoteDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

const person = {
  noteId: 'fictional-person-note',
  personId: 'fictional-person',
  version: 1,
  fullName: 'Robin Lane',
  birthDate: null,
};
const preview = {
  request: {
    selection: {
      type: 'records',
      records: [{ kind: 'observation', recordId: 'fictional-result' }],
    },
    destination: { noteId: person.noteId, expectedVersion: 1 },
  },
  scopeToken: 'fictional-scope',
  version: 2,
  records: [],
  blockers: [],
  names: [],
  relationships: [],
  reportHolds: [],
  pending: [],
  commitGroups: [],
  destination: person,
};

describe('record ownership dialog', () => {
  beforeEach(() => {
    sessionStorage.clear();
    calls.profileId = 'fictional-profile';
  });
  it.each([403, 409])(
    'shows a definite %i reason and requires a fresh preview before another commit',
    async (status) => {
      const user = userEvent.setup();
      calls.api
        .mockReset()
        .mockImplementation(async (path: string, options?: { method?: string }) => {
          if (path.endsWith('/people')) return { data: [person] };
          if (path.endsWith('/preview')) return { data: preview };
          if (options?.method === 'POST') {
            throw new ApiError(
              'The accepted record changed; update the correction preview.',
              'OWNERSHIP_CHANGED',
              status,
            );
          }
          throw new Error('Unexpected ownership request');
        });
      render(
        <MemoryRouter>
          <RecordOwnershipAction
            selection={{
              type: 'records',
              records: [{ kind: 'observation', recordId: 'fictional-result' }],
            }}
          />
        </MemoryRouter>,
      );
      await user.click(screen.getByRole('button', { name: 'Change person' }));
      await screen.findByText('Choose person');
      await user.click(screen.getByRole('button', { name: 'Preview correction' }));
      await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The accepted record changed');
      expect(screen.getByRole('button', { name: 'Confirm person correction' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Update preview' })).toBeEnabled();
      expect(calls.api).toHaveBeenCalledTimes(3);
    },
  );

  it('keeps split-content review separate from an explicit destination match choice', async () => {
    const user = userEvent.setup();
    const mapping = {
      kind: 'observation',
      testLabel: 'Fictional result',
      valueText: '12',
      unit: 'mg',
    };
    calls.api.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview'))
        return {
          data: {
            ...preview,
            records: [
              {
                kind: 'observation',
                recordId: 'fictional-result',
                title: 'Fictional result',
                version: '1',
                owner: { ...person, personId: 'patient', fullName: 'Self' },
                action: 'split',
                mapping,
                remainingMapping: mapping,
                splitReviewRequired: true,
                contributions: [],
                blockers: [],
                medicationActivity: null,
                matches: [
                  {
                    recordId: 'other-result',
                    version: '1',
                    title: 'Other fictional result',
                    mapping,
                    evidence: [],
                  },
                ],
              },
            ],
          },
        };
      throw new Error('Unexpected ownership request');
    });
    render(
      <MemoryRouter>
        <RecordOwnershipAction
          selection={{
            type: 'report',
            intakeId: 'fictional-intake',
            groupId: 'fictional-group',
            groupVersionId: '1',
          }}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    await user.click(await screen.findByRole('checkbox', { name: /I reviewed both records/ }));
    expect(screen.getByLabelText('Destination match')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Update preview' }));
    const request = JSON.parse(calls.api.mock.calls.at(-1)![1].body);
    expect(request.decisions).toEqual([
      {
        recordId: 'fictional-result',
        reviewedSplit: true,
        splitMapping: mapping,
        remainingMapping: mapping,
      },
    ]);
    await user.selectOptions(screen.getByLabelText('Destination match'), 'keep_both');
    await user.click(screen.getByRole('button', { name: 'Update preview' }));
    const reviewed = JSON.parse(calls.api.mock.calls.at(-1)![1].body);
    expect(reviewed.decisions[0]).toMatchObject({ reviewedSplit: true, action: 'keep_both' });
  });

  it('reconciles an unknown operation without allowing another dialog to adopt it', async () => {
    const user = userEvent.setup();
    let recovered = false;
    let operationId = '';
    let lookups = 0;
    calls.api
      .mockReset()
      .mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
        if (path.endsWith('/people')) return { data: [person] };
        if (path.endsWith('/preview')) return { data: preview };
        if (options?.method === 'POST') {
          operationId = JSON.parse(options.body!).operationId;
          throw new TypeError('Network disconnected after submission');
        }
        lookups++;
        expect(path.endsWith('/' + operationId)).toBe(true);
        if (!recovered) throw new TypeError('Still disconnected');
        return {
          data: {
            operationId,
            moved: 1,
            pending: 0,
            outcomes: [
              {
                recordId: 'fictional-result',
                destinationRecordId: 'fictional-result',
                kind: 'observation',
                action: 'move',
              },
            ],
          },
        };
      });
    render(
      <MemoryRouter>
        <RecordOwnershipAction
          label="First correction"
          selection={{
            type: 'records',
            records: [{ kind: 'observation', recordId: 'fictional-result' }],
          }}
        />
        <RecordOwnershipAction
          label="Second correction"
          selection={{
            type: 'records',
            records: [{ kind: 'observation', recordId: 'second-result' }],
          }}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'First correction' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
    await screen.findByText(
      'The save outcome is unknown. Check it before starting another correction.',
    );
    expect(lookups).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Second correction' }));
    const dialogs = screen.getAllByRole('dialog');
    await within(dialogs[1]!).findByText('Choose person');
    expect(within(dialogs[1]!).queryByText(/save outcome is unknown/)).toBeNull();
    expect(lookups).toBe(1);
    recovered = true;
    await user.click(within(dialogs[0]!).getByRole('button', { name: 'Check save outcome' }));
    await within(dialogs[0]!).findByRole('link', {
      name: 'View corrected observation and its history',
    });
    expect(lookups).toBe(2);
    expect(sessionStorage.length).toBe(0);
    expect(within(dialogs[1]!).getByRole('button', { name: 'Preview correction' })).toBeEnabled();
  });

  it('ignores a preview arriving after the active profile changes', async () => {
    const user = userEvent.setup();
    let resolvePreview!: (value: { data: typeof preview }) => void;
    const pending = new Promise<{ data: typeof preview }>((resolve) => {
      resolvePreview = resolve;
    });
    calls.api.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview')) return pending;
      throw new Error('Unexpected ownership request');
    });
    const view = () => (
      <MemoryRouter>
        <RecordOwnershipAction
          selection={{
            type: 'records',
            records: [{ kind: 'observation', recordId: 'fictional-result' }],
          }}
        />
      </MemoryRouter>
    );
    const rendered = render(view());
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    calls.profileId = 'second-fictional-profile';
    rendered.rerender(view());
    await act(async () => {
      resolvePreview({ data: preview });
      await pending;
    });
    expect(screen.queryByRole('button', { name: 'Confirm person correction' })).toBeNull();
    expect(screen.queryByText('2 saved records')).toBeNull();
  });

  it('reviews undo with the current reverse destination and no old match approval', async () => {
    const user = userEvent.setup();
    const former = {
      ...person,
      noteId: 'person-note:self',
      personId: 'patient',
      fullName: 'Self',
      version: 7,
    };
    const mapping = {
      kind: 'observation',
      testLabel: 'Fictional result',
      valueText: '12',
      unit: 'mg',
    };
    let commits = 0;
    calls.api
      .mockReset()
      .mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
        if (path.endsWith('/people')) return { data: [person, former] };
        if (path.endsWith('/preview'))
          return {
            data: {
              ...preview,
              request: JSON.parse(options!.body!),
              records: [
                {
                  kind: 'observation',
                  recordId: 'fictional-result',
                  title: 'Fictional result',
                  version: '1',
                  owner: former,
                  action: 'move',
                  mapping,
                  contributions: [],
                  blockers: [],
                  splitReviewRequired: false,
                  medicationActivity: null,
                  matches: [
                    {
                      recordId: 'other-result',
                      version: '1',
                      title: 'Other fictional result',
                      mapping,
                      evidence: [],
                    },
                  ],
                },
              ],
            },
          };
        if (options?.method === 'POST') {
          commits++;
          return {
            data: {
              operationId: JSON.parse(options.body!).operationId,
              moved: 1,
              pending: 0,
              outcomes: [
                {
                  recordId: 'fictional-result',
                  destinationRecordId: 'fictional-result',
                  kind: 'observation',
                  action: 'move',
                },
              ],
            },
          };
        }
        throw new Error('Unexpected request');
      });
    render(
      <MemoryRouter>
        <RecordOwnershipAction
          selection={{
            type: 'records',
            records: [{ kind: 'observation', recordId: 'fictional-result' }],
          }}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    await user.selectOptions(await screen.findByLabelText('Destination match'), 'keep_both');
    await user.click(screen.getByRole('button', { name: 'Update preview' }));
    await user.click(screen.getByRole('button', { name: 'Confirm person correction' }));
    await user.click(await screen.findByRole('button', { name: 'Review undo' }));
    await screen.findByRole('button', { name: 'Confirm person correction' });
    const reverse = JSON.parse(calls.api.mock.calls.at(-1)![1].body);
    expect(reverse.destination).toEqual({ noteId: former.noteId, expectedVersion: 7 });
    expect(reverse.decisions).toEqual([]);
    expect(reverse.reason).toBe('Review reversal of earlier person correction');
    expect(commits).toBe(1);
  });

  it('recovers the same dialog operation after unmount and remount without resubmitting it', async () => {
    const user = userEvent.setup();
    let available = false;
    let operationId = '';
    let commits = 0;
    calls.api
      .mockReset()
      .mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
        if (path.endsWith('/people')) return { data: [person] };
        if (path.endsWith('/preview')) return { data: preview };
        if (options?.method === 'POST') {
          commits++;
          operationId = JSON.parse(options.body!).operationId;
          throw new TypeError('Lost reply');
        }
        expect(path.endsWith('/' + operationId)).toBe(true);
        if (!available) throw new TypeError('Offline');
        return {
          data: {
            operationId,
            moved: 1,
            pending: 0,
            outcomes: [
              {
                recordId: 'fictional-result',
                destinationRecordId: 'fictional-result',
                kind: 'observation',
                action: 'move',
              },
            ],
          },
        };
      });
    const view = () => (
      <MemoryRouter>
        <RecordOwnershipAction
          selection={{
            type: 'records',
            records: [{ kind: 'observation', recordId: 'fictional-result' }],
          }}
        />
      </MemoryRouter>
    );
    const mounted = render(view());
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByText('Choose person');
    await user.click(screen.getByRole('button', { name: 'Preview correction' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
    await screen.findByText(
      'The save outcome is unknown. Check it before starting another correction.',
    );
    expect(sessionStorage.length).toBe(1);
    mounted.unmount();
    available = true;
    render(view());
    await user.click(screen.getByRole('button', { name: 'Change person' }));
    await screen.findByRole('link', { name: 'View corrected observation and its history' });
    expect(commits).toBe(1);
    expect(sessionStorage.length).toBe(0);
  });
});

it('restores the exact selected records after remount so a pending operation remains reachable', async () => {
  sessionStorage.clear();
  calls.profileId = 'fictional-profile';
  const user = userEvent.setup();
  const view = () => (
    <MemoryRouter initialEntries={['/tests']}>
      <OwnershipSelectionControl
        records={[{ kind: 'observation', recordId: 'fictional-result', title: 'Fictional result' }]}
        onApplied={() => {}}
      />
    </MemoryRouter>
  );
  const mounted = render(view());
  await user.click(screen.getByRole('button', { name: 'Select records to change person' }));
  await user.click(screen.getByRole('checkbox', { name: 'Fictional result' }));
  expect(screen.getByRole('button', { name: 'Move selected records' })).toBeEnabled();
  mounted.unmount();
  render(view());
  await user.click(screen.getByRole('button', { name: 'Select records to change person' }));
  expect(screen.getByRole('checkbox', { name: 'Fictional result' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Move selected records' })).toBeEnabled();
});
