import { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { PersonContacts } from '../../app/features/notes/PersonContacts';
import { PersonNames } from '../../app/features/notes/PersonNames';
import { PeopleTags } from '../../app/features/notes/PeopleTags';
import { NoteEditor } from '../../app/features/notes/NoteEditor';
import { NotesPage } from '../../app/features/notes/NotesPage';
import { ProfileManagement } from '../../app/components/ProfileManagement';
import { publishNoteUpdate } from '../../app/data/note-updates';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
import type { Note, PersonProfile } from '../../shared/api';

// PDF rendering is independent of care-role presentation and has its own checks.
vi.mock('../../app/components/PdfPreview', () => ({ PdfPreview: () => null }));

const original = {
  tags: ['Professional'],
  schedulingUrl: 'https://example.com/book',
  phone: '555-0100',
  email: 'person@example.com',
};
const self: Note = {
  id: 'person-note:self',
  kind: 'person',
  isSelf: true,
  status: 'editable',
  title: 'Cookie Dough With A Longer Display Name',
  content: 'Personal profile notes',
  typeLabel: null,
  eventDate: null,
  topics: '',
  rawThoughts: '',
  personId: 'patient',
  person: { name: 'Cookie Dough With A Longer Display Name', relationship: 'Self', ...original },
  pinned: false,
  archived: false,
  createdAt: '2026-09-01T12:00:00Z',
  updatedAt: '2026-09-01T12:00:00Z',
  finishedAt: null,
  version: 1,
  sourceRecordId: null,
  links: [],
  backlinks: [],
  attachments: [],
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, meta: { total: 1, complete: true } }), {
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => {
  selectProfile({ id: 'cookie-dough', name: 'Cookie Dough', placebo: true });
});

function ContactsHarness() {
  const [person, setPerson] = useState<PersonProfile>(original);
  return (
    <>
      <PeopleTags tags={person.tags} onChange={(tags) => setPerson({ ...person, tags })} />
      <PersonContacts
        person={person}
        onChange={(field, value) => setPerson({ ...person, [field]: value })}
      />
    </>
  );
}
it('hides scheduling when the last qualifying role is removed, retaining it when a role is added again', async () => {
  const user = userEvent.setup();
  render(<ContactsHarness />);
  expect(screen.getByLabelText('Scheduling URL')).toHaveValue(original.schedulingUrl);
  await user.click(screen.getByRole('button', { name: 'Remove tag Professional' }));
  expect(screen.queryByLabelText('Scheduling URL')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Open scheduling/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Phone')).toHaveValue(original.phone);
  await user.click(screen.getByLabelText('Add a tag'));
  await user.click(screen.getByRole('option', { name: 'Family' }));
  expect(screen.queryByLabelText('Scheduling URL')).not.toBeInTheDocument();
  await user.click(screen.getByLabelText('Add a tag'));
  await user.click(screen.getByRole('option', { name: 'Primary Care Provider' }));
  expect(screen.getByLabelText('Scheduling URL')).toHaveValue(original.schedulingUrl);
  expect(screen.getByRole('link', { name: /Open scheduling/ })).toHaveAttribute(
    'href',
    original.schedulingUrl,
  );
});
it('commits a custom People tag explicitly and removes its shared chip by keyboard', async () => {
  const user = userEvent.setup();
  render(<ContactsHarness />);
  const input = screen.getByLabelText('Add a tag');
  await user.type(input, 'Care team');
  expect(screen.queryByText('care team', { selector: '.selection-chip-label' })).toBeNull();
  await user.keyboard('{Enter}');
  expect(screen.getByText('care team', { selector: '.selection-chip-label' })).toBeVisible();
  const remove = screen.getByRole('button', { name: 'Remove tag care team' });
  remove.focus();
  await user.keyboard('{Enter}');
  expect(screen.queryByText('care team', { selector: '.selection-chip-label' })).toBeNull();
});
it('reuses aggregated relationship choices without saving partial text', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  const contact = {
    ...self,
    id: 'person-note:fictional-contact',
    personId: 'person:fictional-contact',
    isSelf: false,
    title: 'Fictional Contact',
    person: { ...self.person, name: 'Fictional Contact', relationship: 'Friend', tags: [] },
  };
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <NoteEditor
          initial={contact}
          initialKind="person"
          types={[]}
          personOptions={{
            relationship: [{ value: 'Care coordinator', label: 'Care coordinator' }],
          }}
          onSaved={vi.fn()}
          onRefresh={vi.fn()}
          creationId="unused"
          prelinkId={null}
          prelinkType={null}
        />
      ),
    },
  ]);
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  await user.click(screen.getByRole('button', { name: 'Edit relationship Friend' }));
  const input = screen.getByRole('combobox', { name: 'Relationship / context' });
  await user.clear(input);
  await user.type(input, 'care coordinator');
  expect(screen.queryByRole('option', { name: /Add .* as a new relationship/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled();
  await user.keyboard('{Enter}');
  expect(screen.getByText('Care coordinator', { selector: '.selection-chip-label' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save now' })).toBeEnabled();
});
it('Self editor hides legacy tags and scheduling but retains ordinary contact controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <NoteEditor
          initial={self}
          initialKind="person"
          types={[]}
          onSaved={vi.fn()}
          onRefresh={vi.fn()}
          creationId="unused"
          prelinkId={null}
          prelinkType={null}
        />
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  expect(screen.queryByRole('group', { name: 'Tags' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Add a tag')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Scheduling URL')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Open scheduling/ })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Phone')).toHaveValue(original.phone);
  expect(screen.getByLabelText('Email')).toHaveValue(original.email);
});
it('People requests canonical Self exclusion and does not render Self returned by a stale response', async () => {
  const fetch = vi.fn(async (input) => response(String(input).includes('/notes?') ? [self] : []));
  vi.stubGlobal('fetch', fetch);
  const router = createMemoryRouter([{ path: '*', element: <NotesPage initialKind="person" /> }], {
    initialEntries: ['/people'],
  });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(fetch.mock.calls.some(([input]) => String(input).includes('excludeSelf=1'))).toBe(true);
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  expect(screen.queryByText(self.title)).not.toBeInTheDocument();
  expect(screen.queryByText('Self', { selector: '.self-tag' })).not.toBeInTheDocument();
});
it('People tags are inline identity-style badges alongside the name', async () => {
  const person = {
    ...self,
    id: 'note:contact',
    personId: 'person:contact',
    isSelf: false,
    title: 'Mochi',
    person: { name: 'Mochi', tags: ['Family', 'Emergency Contact'] },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => response(String(input).includes('/notes?') ? [person] : [])),
  );
  const router = createMemoryRouter([{ path: '*', element: <NotesPage initialKind="person" /> }], {
    initialEntries: ['/people'],
  });
  render(<RouterProvider router={router} />);
  const heading = (await screen.findByText('Mochi')).closest('.notes-row-heading');
  for (const tag of ['Family', 'Emergency Contact']) {
    const badge = screen.getByText(tag, { selector: '.person-list-tag' });
    expect(heading).toContainElement(badge);
    expect(badge).toHaveClass('self-tag');
  }
});

it('adopts care-contact onboarding saves behind the modal and immediately saves Self with the latest revision', async () => {
  const profile = { id: 'cookie-dough', name: 'Cookie Dough', placebo: true, locked: false };
  replaceProfiles([profile]);
  selectProfile(profile);
  let saved: Note = {
    ...self,
    person: {
      ...self.person,
      onboarding: { completedSteps: [], skippedSteps: [], finished: false },
    },
  };
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, options: RequestInit = {}) => {
      const url = String(input);
      if (url === '/api/profiles') return response([profile]);
      if (url.endsWith('/notes/patient')) return response(saved);
      if (url.endsWith('/notes/person-note%3Aself') && options.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        writes.push(body);
        if (body.version !== saved.version)
          return new Response(
            JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Stale version' } }),
            { status: 409 },
          );
        saved = { ...saved, ...body, version: saved.version + 1 };
        return response(saved);
      }
      return response([]);
    }),
  );
  const initial = structuredClone(saved);
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <>
          <ProfileManagement initialOpen />
          <NoteEditor
            initial={initial}
            initialKind="person"
            types={[]}
            onSaved={vi.fn()}
            onRefresh={vi.fn()}
            creationId="unused"
            prelinkId={null}
            prelinkType={null}
          />
        </>
      ),
    },
  ]);
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  await user.click(await screen.findByRole('button', { name: 'Resume setup' }));
  await screen.findByRole('heading', { name: 'Primary care provider' });
  for (let step = 0; step < 2; step++) {
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(writes).toHaveLength(step + 1));
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.clear(screen.getByLabelText('Display name'));
  await user.type(screen.getByLabelText('Display name'), 'New Self name');
  await user.click(screen.getByRole('button', { name: 'Save now' }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2].version).toBe(3);
  expect(saved.version).toBe(4);
  expect(saved.person.onboarding?.skippedSteps).toEqual(['primary-care', 'emergency-contact']);
  expect(screen.queryByText(/Couldn’t save:/)).not.toBeInTheDocument();
});

it('preserves dirty Self text and its conflict baseline when external or foreign profile saves arrive', async () => {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input, options: RequestInit = {}) => {
      if (options.method === 'PUT') {
        writes.push(JSON.parse(String(options.body)));
        return new Response(
          JSON.stringify({
            error: { code: 'VERSION_CONFLICT', message: 'A newer external save exists' },
          }),
          { status: 409 },
        );
      }
      return response([]);
    }),
  );
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <NoteEditor
          initial={self}
          initialKind="person"
          types={[]}
          onSaved={vi.fn()}
          onRefresh={vi.fn()}
          creationId="unused"
          prelinkId={null}
          prelinkType={null}
        />
      ),
    },
  ]);
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  act(() =>
    publishNoteUpdate('foreign-profile', {
      ...self,
      version: 20,
      person: { ...self.person, name: 'Foreign' },
      title: 'Foreign',
    }),
  );
  expect(screen.getByLabelText('Display name')).toHaveValue(self.title);
  await user.clear(screen.getByLabelText('Display name'));
  await user.type(screen.getByLabelText('Display name'), 'Unsaved personal draft');
  act(() =>
    publishNoteUpdate('cookie-dough', {
      ...self,
      version: 2,
      title: 'External name',
      person: { ...self.person, name: 'External name' },
    }),
  );
  expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved personal draft');
  await user.click(screen.getByRole('button', { name: 'Save now' }));
  await screen.findByText(/A newer external save exists/);
  expect(writes[0].version).toBe(1);
  expect(writes[0].title).toBe('Unsaved personal draft');
  expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved personal draft');
});

it('Self commits known names explicitly and preserves them in the human save payload', async () => {
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      return response({ ...self, ...body, version: 2 });
    }
    return response([]);
  });
  vi.stubGlobal('fetch', fetch);
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <NoteEditor
          initial={self}
          initialKind="person"
          types={[]}
          onSaved={vi.fn()}
          onRefresh={vi.fn()}
          creationId="unused"
          prelinkId={null}
          prelinkType={null}
        />
      ),
    },
  ]);
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  await user.type(screen.getByRole('combobox', { name: 'Names' }), 'Fictional Former Meadow');
  expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled();
  await user.keyboard('{Enter}');
  await user.click(screen.getByRole('button', { name: 'Save now' }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
  );
  const saved = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!;
  expect(JSON.parse(String(saved.body)).person.knownNames).toEqual(['Fictional Former Meadow']);
});

it('uses one Names list for a person and retains report-backed spellings without delete controls', async () => {
  const onChange = vi.fn();
  const person: PersonProfile = {
    name: 'Cookie',
    fullName: 'Cookie Doe',
    knownNames: ['Cookie Crumb', 'Doe, Cookie'],
    sourceKnownNames: [
      {
        name: 'Doe, Cookie',
        operationId: 'fictional-confirmation',
        intakeId: 'fictional-intake',
        sourceHash: 'fictional-hash',
        groupId: 'fictional-report',
        subjectText: 'Patient: Doe, Cookie',
      },
    ],
  };
  render(
    <RouterProvider
      router={createMemoryRouter([
        {
          path: '*',
          element: <PersonNames person={person} disabled={false} onChange={onChange} />,
        },
      ])}
    />,
  );
  expect(screen.getByRole('combobox', { name: 'Names' })).toBeVisible();
  expect(screen.queryByLabelText('Full name')).toBeNull();
  expect(screen.getByText('Doe, Cookie')).toBeVisible();
  expect(screen.getByText('Cookie Crumb').closest('.selection-chip')).not.toBeNull();
  expect(screen.getByText('Doe, Cookie').closest('.selection-chip')).not.toBeNull();
  expect(
    screen.getByRole('list', { name: 'Names retained from confirmed reports' }),
  ).toHaveAccessibleDescription(
    'Confirmed report names cannot be removed here. Select a confirmed name to view its report.',
  );
  expect(screen.queryByRole('button', { name: 'Remove name Doe, Cookie' })).toBeNull();
  expect(screen.getByRole('link', { name: 'View report confirming Doe, Cookie' })).toHaveAttribute(
    'href',
    '/import?intake=fictional-intake&group=fictional-report',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Remove name Cookie Crumb' }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Cookie',
      fullName: 'Cookie Doe',
      knownNames: ['Doe, Cookie'],
      sourceKnownNames: person.sourceKnownNames,
    }),
  );
});
