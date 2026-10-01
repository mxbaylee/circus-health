import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { DetailHeader, EntryActions } from '../../app/components/DetailHeader';
import { ArchiveControl } from '../../app/components/ArchiveControl';
import { ClinicalRecordDetail } from '../../app/pages/ClinicalRecords';
import { selectProfile } from '../../app/data/profile';
import type { Medication, Procedure } from '../../shared/api';
// PDF asset loading is covered separately from layout and state-control interactions.
vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => selectProfile({ id: 'cookie-dough', name: 'Synthetic profile', placebo: true }));
const procedure = (
  eventKind: string | undefined,
  overrides: Partial<Procedure> = {},
): Procedure => ({
  id: 'synthetic-procedure',
  label: 'Synthetic procedure',
  category: 'surgery',
  date: '2026-04-03',
  status: null,
  provider: 'Fictional clinic',
  sourceRecordId: 'synthetic-source',
  extra: {
    import: {
      acceptedMapping: eventKind === undefined ? {} : { eventKind },
    },
  },
  ...overrides,
});
const renderProcedure = (record: Procedure) =>
  render(
    <MemoryRouter>
      <ClinicalRecordDetail record={record} onStatusSaved={() => {}} />
    </MemoryRouter>,
  );
it('discloses ordinary controls with Tab, Escape, outside-click dismissal and focus restoration', async () => {
  const user = userEvent.setup();
  render(
    <>
      <DetailHeader
        eyebrow="NOTE"
        title="Synthetic entry"
        badges={<span>Draft</span>}
        actions={
          <>
            <button>Print</button>
            <EntryActions>
              <button>History</button>
              <button>Convert</button>
            </EntryActions>
          </>
        }
      />
      <button>Outside</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'More entry actions' });
  expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole('button', { name: 'History' })).toHaveFocus();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Convert' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  await user.tab();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  await user.click(screen.getByRole('heading', { name: 'Synthetic entry' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
it('provider actions expose genuine archive events and retain keyboard focus through the dialog', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        archived: true,
        protected: false,
        version: 1,
        history: [
          {
            id: 'event',
            archived: true,
            version: 1,
            createdAt: '2026-09-10T12:00:00Z',
            actor: 'Synthetic reviewer',
          },
        ],
      }),
    ),
  );
  const user = userEvent.setup();
  render(
    <EntryActions>
      <ArchiveControl showHistory targetType="procedure" targetId="synthetic" />
    </EntryActions>,
  );
  await user.click(screen.getByRole('button', { name: 'More entry actions' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Active' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Archive history' }));
  const dialog = screen.getByRole('dialog', { name: 'Archive history' });
  expect(within(dialog).getByText(/By: Synthetic reviewer/)).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: /Restore selected/ }),
  ).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Archive history' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'More entry actions' })).toHaveFocus();
});
it('Rx keeps Active and retained history in the shared disclosure, with status beside the title', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  const record: Medication = {
    id: 'synthetic-rx',
    label: 'Synthetic prescription',
    kind: 'order',
    status: 'active',
    currentStatus: 'unknown',
    currentStatusVersion: 0,
    visibilityVersion: 0,
    currentStatusUpdatedAt: null,
    currentStatusAssertion: null,
    sourceRecordedDate: null,
    doseText: null,
    route: null,
    frequency: null,
    startAt: null,
    endAt: null,
    provider: null,
    sourceRecordId: 'raw',
    extra: {},
  };
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ClinicalRecordDetail record={record} onStatusSaved={() => {}} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('switch', { name: 'Active' })).not.toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Synthetic prescription' }).closest('header'),
  ).toHaveTextContent('Inactive');
  await user.click(screen.getByRole('button', { name: 'More entry actions' }));
  expect(screen.getAllByRole('button', { name: 'Change person' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Correct saved record' })).toBeVisible();
  expect(screen.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Current use history and details' }));
  expect(screen.getByRole('dialog', { name: 'Current use history' })).toHaveTextContent(
    'No personal current-use assertion has been saved.',
  );
  await user.keyboard('{Escape}');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('switch', { name: 'Active' })).not.toBeInTheDocument();
});

it.each([
  ['order', 'Order'],
  ['performed', 'Performed event'],
  ['historical_mention', 'Historical mention'],
  ['unknown', 'Event type unknown'],
])('shows the reviewed procedure event kind %s as %s', (eventKind, label) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ archived: false, protected: false, version: 0 })),
  );
  renderProcedure(procedure(eventKind));

  expect(
    screen.getByRole('heading', { name: 'Synthetic procedure' }).closest('header'),
  ).toHaveTextContent(label);
  expect(screen.getByText('Record kind').closest('div')).toHaveTextContent(label);
  expect(screen.getByText('Procedure status').closest('div')).toHaveTextContent('Not recorded');
});

it.each([undefined, 'future_event_kind'])(
  'falls back to an unknown event kind for %s without inferring from category or date',
  (eventKind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ archived: false, protected: false, version: 0 })),
    );
    renderProcedure(procedure(eventKind));

    expect(screen.getByText('Record kind').closest('div')).toHaveTextContent('Event type unknown');
    expect(screen.getByText('Recorded date').closest('div')).toHaveTextContent('Apr 3, 2026');
  },
);

it('keeps source status separate from the reviewed procedure event kind', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ archived: false, protected: false, version: 0 })),
  );
  renderProcedure(procedure('order', { status: 'scheduled by source' }));

  expect(screen.getByText('Record kind').closest('div')).toHaveTextContent('Order');
  expect(screen.getByText('Procedure status').closest('div')).toHaveTextContent(
    'scheduled by source',
  );
});

it('procedure actions expose one person change beside saved-record correction', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  renderProcedure(procedure('performed'));
  await userEvent.setup().click(screen.getByRole('button', { name: 'More entry actions' }));
  expect(screen.getAllByRole('button', { name: 'Change person' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Correct saved record' })).toBeVisible();
});

it('provider notes keep one explicit ownership action and refresh after its successful completion', async () => {
  const { ProviderNoteDetail } = await import('../../app/features/notes/ProviderNoteDetail');
  const note: import('../../shared/api').ProviderHistoricalNote = {
    id: 'fictional-provider-note',
    personId: 'patient',
    origin: 'provider',
    status: 'provider',
    readOnly: true,
    title: 'Fictional visit summary',
    typeLabel: 'Visit summary',
    date: null,
    eventDate: null,
    recordDate: null,
    dateBasis: 'source',
    sourceId: 'fictional-clinic',
    sourceLabel: 'Fictional Clinic',
    sourceStatus: 'final',
    sourceType: 'Visit summary',
    sourceRecordId: 'fictional-source',
    content: 'Independently fictional note.',
    authors: [],
    classificationBasis: null,
    presentationNote: null,
    evidence: [],
    attachments: [],
    extra: {},
  };
  const person = {
    noteId: 'fictional-person-note',
    personId: 'fictional-person',
    version: 1,
    fullName: 'Robin Lane',
    birthDate: null,
  };
  const selection = { type: 'records', records: [{ kind: 'document', recordId: note.id }] };
  const preview = {
    request: { selection, destination: { noteId: person.noteId, expectedVersion: 1 } },
    scopeToken: 'fictional-scope',
    version: 1,
    records: [],
    blockers: [],
    names: [],
    relationships: [],
    reportHolds: [],
    pending: [],
    commitGroups: [],
    destination: person,
  };
  const fetcher = vi.fn(async (input: string, options?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/record-ownership/people')) return response([person]);
    if (path.endsWith('/record-ownership/preview')) {
      expect(JSON.parse(String(options?.body)).selection).toEqual(selection);
      return response(preview);
    }
    if (path.endsWith('/record-ownership') && options?.method === 'POST')
      return response({ operationId: 'fictional-operation', moved: 1, pending: 0, outcomes: [] });
    return response([]);
  });
  vi.stubGlobal('fetch', fetcher);
  const changed = vi.fn();
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ProviderNoteDetail note={note} onChanged={changed} />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'More entry actions' }));
  expect(screen.getAllByRole('button', { name: 'Change person' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Correct saved record' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Change person' }));
  const next = await screen.findByRole('button', { name: 'Preview correction' });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  await user.click(await screen.findByRole('button', { name: 'Confirm person correction' }));
  await user.click(await screen.findByRole('button', { name: 'Done' }));
  expect(changed).toHaveBeenCalledOnce();
});
