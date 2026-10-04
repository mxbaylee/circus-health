import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordOwnershipAction } from '../../app/features/clinical-review/RecordOwnershipAction';
import { OwnershipSelectionControl } from '../../app/features/clinical-review/OwnershipSelectionControl';
import { OwnershipContributions } from '../../app/features/clinical-review/OwnershipContributions';
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

it('shows a high-degree record one source page and one detail fragment at a time', async () => {
  const user = userEvent.setup(),
    url = '/report-evidence/owned?contribution=selected';
  calls.api.mockReset().mockImplementation(async (path: string) => {
    if (path.includes('ordinal=2')) {
      const later = path.includes('offset=32768');
      return {
        data: {
          data: btoa(later ? 'last evidence fragment' : 'first evidence fragment'),
          complete: later,
          nextOffset: later ? 32790 : 32768,
        },
      };
    }
    if (path.includes('after=1'))
      return {
        data: {
          items: [{ type: 'contribution-fragment', ordinal: 2, bytes: 100000, url }],
          total: 10001,
          complete: true,
          after: null,
        },
      };
    return {
      data: {
        items: [
          {
            sourceRecordId: 'fictional-source',
            contentUrl: '/original',
            selected: true,
            locator: 'First fictional source',
            reportScopes: { total: 1, url: '/scope' },
          },
        ],
        total: 10001,
        complete: false,
        after: '1',
      },
    };
  });
  render(
    <OwnershipContributions
      reference={{
        format: 'ownership-contributions-v1',
        key: 'selected',
        total: 10001,
        selectedTotal: 1,
        digest: 'complete',
        url,
      }}
      ownerName="Former Person"
      disabled={false}
    />,
  );
  await screen.findByText(/First fictional source/);
  await user.click(screen.getByRole('button', { name: 'Next sources page' }));
  await screen.findByText('first evidence fragment');
  expect(screen.queryByText(/First fictional source/)).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next source fragment' }));
  await screen.findByText('last evidence fragment');
  expect(screen.queryByText('first evidence fragment')).toBeNull();
  expect(
    calls.api.mock.calls.every(
      ([path]) =>
        String(path).includes('bytes=32768') || String(path).includes('limit=16&bytes=65536'),
    ),
  ).toBe(true);
});

it('pages native supporting targets and commits the approval returned by a bounded name choice', async () => {
  sessionStorage.clear();
  calls.profileId = 'fictional-profile';
  const user = userEvent.setup();
  const { names, ...header } = preview;
  void names;
  const url = '/api/profiles/fictional-profile/record-ownership/name-evidence/opaque';
  const reference = {
    token: 'opaque',
    digest: 'complete-evidence',
    decisionDigest: 'initial-choices',
    total: 1,
    supportTotal: 1,
    targetTotal: 96,
    complete: true,
    url,
  };
  const native = { ...header, namesIncluded: false, nameEvidence: reference };
  let choice = 'unresolved';
  calls.api
    .mockReset()
    .mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview')) return { data: native };
      if (path === url && options?.method === 'POST') {
        expect(JSON.parse(options.body!)).toEqual({ key: 'name-key', outcome: 'old' });
        choice = 'old';
        return {
          data: {
            ...native,
            scopeToken: 'chosen-scope',
            nameEvidence: { ...reference, decisionDigest: 'reviewed-choice' },
          },
        };
      }
      if (path.startsWith(url)) {
        const query = new URL(path, 'http://fictional.invalid').searchParams;
        if (query.has('support'))
          return {
            data: {
              items: [
                {
                  ordinal: query.get('after') === '0' ? 95 : 0,
                  recordId: query.get('after') === '0' ? 'last-target' : 'first-target',
                },
              ],
              total: 96,
              complete: query.get('after') === '0',
              after: query.get('after') === '0' ? null : '0',
            },
          };
        if (query.has('effect'))
          return {
            data: {
              items: [
                {
                  ordinal: 1,
                  operationId: 'confirmation',
                  intakeId: 'intake',
                  groupId: 'group',
                  version: 'complete-receipt',
                  affected: true,
                  moves: false,
                  targetTotal: 96,
                },
              ],
              total: 1,
              complete: true,
              after: null,
            },
          };
        return {
          data: {
            items: [
              {
                key: 'name-key',
                noteId: 'old-note',
                personId: 'patient',
                name: 'Fictional Learned',
                decision: choice,
                proposed: 'unresolved',
                independentSupport: true,
                unknownSupport: false,
                supportTotal: 1,
                affectedSourceTotal: 1,
              },
            ],
            total: 1,
            complete: true,
            after: null,
          },
        };
      }
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body!);
        expect(command.scopeToken).toBe('chosen-scope');
        expect(command.request.nameDecisions).toBeUndefined();
        return { data: { operationId: command.operationId, moved: 1, pending: 0, outcomes: [] } };
      }
      throw Error('Unexpected evidence request');
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
  await user.click(await screen.findByRole('button', { name: 'View 1 supporting confirmations' }));
  await user.click(await screen.findByRole('button', { name: 'View assigned targets' }));
  await screen.findByText('first-target');
  await user.click(screen.getByRole('button', { name: 'Next targets' }));
  await screen.findByText('last-target');
  expect(screen.queryByText('first-target')).toBeNull();
  await user.selectOptions(screen.getByLabelText(/Fictional Learned/), 'old');
  await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
  expect(calls.api.mock.calls.some(([path]) => String(path).includes('support=1&after=0'))).toBe(
    true,
  );
});

it('keeps report evidence paged and sends one clinical decision while earlier choices remain in the owned plan', async () => {
  sessionStorage.clear();
  calls.profileId = 'fictional-profile';
  calls.api.mockReset();
  const user = userEvent.setup(),
    url = '/api/profiles/fictional-profile/record-ownership/report-evidence/owned';
  const selection = {
    type: 'report' as const,
    intakeId: 'original',
    groupId: 'group',
    groupVersionId: 'version',
  };
  const { records, pending, names, relationships, ...header } = preview;
  void records;
  void pending;
  void names;
  void relationships;
  let chosen = 0;
  const report = () => ({
    ...header,
    request: {
      selection,
      destination: { noteId: person.noteId, expectedVersion: 1 },
      decisions: [],
      relationshipDecisions: [],
    },
    scopeToken: 'scope-' + chosen,
    namesIncluded: false,
    nameEvidence: {
      token: 'names',
      digest: 'names',
      decisionDigest: 'names',
      complete: true,
      total: 0,
      supportTotal: 0,
      targetTotal: 0,
      url: '/name-pages',
    },
    recordsIncluded: false,
    pendingIncluded: false,
    relationshipsIncluded: false,
    reportEvidence: {
      token: 'owned',
      digest: 'digest-' + chosen,
      complete: true,
      recordTotal: 2,
      pendingTotal: 0,
      relationshipTotal: 0,
      recordBlockerTotal: 0,
      url,
    },
    commitGroups: [{ id: 'one', atomic: true, recordTotal: 2, pendingCount: 0, url }],
  });
  const record = (id: string) => ({
    kind: 'observation',
    recordId: id,
    version: 'record-v',
    title: 'Saved ' + id,
    owner: { ...person, noteId: 'former-note', fullName: 'Former Person' },
    action: 'move',
    mapping: { testLabel: 'Fictional value' },
    contributions: [],
    splitReviewRequired: false,
    matches: [
      {
        recordId: 'match-' + id,
        version: 'target-v',
        title: 'Matching result',
        mapping: {},
        evidence: [],
      },
    ],
    blockers: [],
    medicationActivity: null,
  });
  calls.api.mockImplementation(
    async (path: string, options?: { method?: string; body?: string }) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview')) return { data: report() };
      if (path === '/name-pages')
        return { data: { items: [], total: 0, complete: true, after: null } };
      if (path === url && options?.method === 'POST') {
        expect(JSON.parse(options.body!)).toEqual({
          recordId: chosen === 0 ? 'first' : 'second',
          decision: { recordId: chosen === 0 ? 'first' : 'second', action: 'keep_both' },
        });
        chosen++;
        return { data: report() };
      }
      if (path.startsWith(url)) {
        const second = new URL(path, 'http://fictional.invalid').searchParams.get('after') === '0';
        return {
          data: {
            items: [record(second ? 'second' : 'first')],
            total: 2,
            complete: second,
            after: second ? null : '0',
          },
        };
      }
      if (path.includes('/outcomes/'))
        return { data: { items: [], total: 2, complete: true, after: null } };
      if (options?.method === 'POST') {
        const command = JSON.parse(options.body!);
        expect(command.scopeToken).toBe('scope-2');
        expect(command.request.decisions).toEqual([]);
        return {
          data: {
            operationId: command.operationId,
            moved: 2,
            pending: 0,
            outcomesIncluded: false,
            outcomeTotal: 2,
            outcomeDigest: 'a'.repeat(64),
            outcomesUrl: '/outcomes/accepted',
          },
        };
      }
      throw Error('Unexpected request ' + path);
    },
  );
  render(
    <MemoryRouter>
      <RecordOwnershipAction selection={selection} />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Change person' }));
  await screen.findByText('Choose person');
  await user.click(screen.getByRole('button', { name: 'Preview correction' }));
  await screen.findByText('Saved first');
  await user.selectOptions(screen.getByLabelText('Destination match'), 'keep_both');
  expect(screen.getByRole('button', { name: 'Next report page' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Update preview' }));
  await user.click(await screen.findByRole('button', { name: 'Next report page' }));
  await screen.findByText('Saved second');
  expect(screen.queryByText('Saved first')).toBeNull();
  await user.selectOptions(screen.getByLabelText('Destination match'), 'keep_both');
  await user.click(screen.getByRole('button', { name: 'Update preview' }));
  await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
  await screen.findByText('2 accepted record outcomes remain in history.');
  expect(chosen).toBe(2);
});

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

it.each(['report', 'records'] as const)(
  'keeps native %s correction approval blocked by complete referenced requirements before evidence is opened',
  async (mode) => {
    sessionStorage.clear();
    calls.profileId = 'fictional-profile';
    const user = userEvent.setup(),
      url = '/record-ownership/report-evidence/blocked';
    const report = {
      ...preview,
      namesIncluded: false,
      nameEvidence: {
        token: 'names',
        digest: 'names',
        decisionDigest: 'names',
        complete: true,
        total: 0,
        supportTotal: 0,
        targetTotal: 0,
        url: '/name-pages',
      },
      recordsIncluded: false,
      pendingIncluded: false,
      relationshipsIncluded: false,
      reportEvidence: {
        token: 'blocked',
        digest: 'complete',
        complete: true,
        recordTotal: 0,
        pendingTotal: 0,
        relationshipTotal: 0,
        recordBlockerTotal: 0,
        url,
      },
      blockers: {
        format: 'ownership-blockers-v1',
        key: 'requirements',
        count: 5000,
        digest: 'all-requirements',
        url: url + '?contribution=requirements',
      },
    };
    const native =
      mode === 'report'
        ? report
        : {
            ...preview,
            namesIncluded: false,
            nameEvidence: report.nameEvidence,
            blockers: report.blockers,
          };
    calls.api.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith('/people')) return { data: [person] };
      if (path.endsWith('/preview')) return { data: native };
      if (path === '/name-pages')
        return { data: { items: [], total: 0, complete: true, after: null } };
      if (path.includes('section=records'))
        return { data: { items: [], total: 0, complete: true, after: null } };
      throw new Error('Unexpected ' + path);
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
    expect(
      await screen.findByText(/5,000 person assignment requirements must be resolved/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm person correction' })).toBeDisabled();
    expect(
      calls.api.mock.calls.some(([path]) => String(path).includes('contribution=requirements')),
    ).toBe(false);
  },
);
