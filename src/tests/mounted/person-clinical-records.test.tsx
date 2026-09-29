import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Note } from '../../shared/api';
import { PersonClinicalRecords } from '../../app/features/notes/PersonClinicalRecords';
import { selectProfile } from '../../app/data/profile';

const person = { id: 'rowan-note', title: 'Rowan Example', personId: 'rowan-person' } as Note;
beforeEach(() => {
  selectProfile({ id: 'fictional-family', name: 'Fictional family', placebo: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'rowan-report', title: 'Fictional report', date: '2026-01-01' }],
            meta: { total: 1 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
});
it('makes each clinical collection and generic documents reachable from the person', async () => {
  render(
    <MemoryRouter>
      <PersonClinicalRecords person={person} />
    </MemoryRouter>,
  );
  for (const label of [
    'Test results',
    'Vision prescriptions',
    'Prescriptions',
    'Procedures',
    'Historical notes',
  ]) {
    const link = screen.getByRole('link', { name: label });
    expect(
      new URL(link.getAttribute('href')!, 'http://fictional.test').searchParams.get('personId'),
    ).toBe('rowan-person');
  }
  expect(screen.getByRole('link', { name: 'Prescriptions' })).toHaveAttribute(
    'href',
    '/medications?personId=rowan-person&status=all',
  );
  expect(await screen.findByRole('link', { name: 'Documents · 1' })).toHaveAttribute(
    'href',
    '/sources?view=documents&personId=rowan-person',
  );
  expect(screen.queryByRole('link', { name: 'Fictional report' })).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('personId=rowan-person');
});
it('never falls back to Self when a Person lacks a saved owner ID', () => {
  render(
    <MemoryRouter>
      <PersonClinicalRecords person={{ ...person, personId: null }} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Save this person');
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Test results' })).not.toBeInTheDocument();
});
