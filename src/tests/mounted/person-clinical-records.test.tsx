import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Note } from '../../shared/api';
import { PersonClinicalRecords } from '../../app/features/notes/PersonClinicalRecords';
import { selectProfile } from '../../app/data/profile';
import { api } from '../../app/data/api';

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

it('matches each badge to its destination response across filtering, accepted additions, and a profile switch', async () => {
  const collections = [
    ['Test results', '/tests', ''],
    ['Prescriptions', '/medications', '&status=all'],
    ['Procedures', '/procedures', '&category=all'],
    ['Notes', '/notes', '&kind=note'],
    ['Historical notes', '/historical-notes', ''],
    ['Documents', '/documents', ''],
  ] as const;
  let accepted = 0;
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = new URL(String(input), 'http://fictional.test');
      requests.push(url);
      if (init?.method === 'POST') {
        expect(url.pathname).toMatch(/\/intake-acceptances$/);
        accepted++;
        return new Response(JSON.stringify({ data: { acceptedCount: 1 } }));
      }
      const index = collections.findIndex(([, path]) => url.pathname.endsWith(path));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(url.searchParams.get('personId')).toBe('rowan-person');
      const otherProfile = url.pathname.includes('/fictional-second/');
      const total = index + 2 + accepted + (otherProfile ? 9 : 0);
      // Different path totals catch count requests accidentally sharing one result.
      // The summary's current-medication subset is deliberately smaller than All.
      const size = url.searchParams.get('status') === 'current' ? 1 : total;
      const all = Array.from({ length: size }, (_, i) => ({
        id: `${index}-${i}`,
        label: `Fictional collection ${index} record ${i}`,
        title: `Fictional collection ${index} record ${i}`,
        date: '2026-01-01',
      }));
      const filtered = url.searchParams.has('q') ? all.slice(0, 1) : all;
      const data = filtered.slice(0, Number(url.searchParams.get('limit')) || filtered.length);
      return new Response(JSON.stringify({ data, meta: { total: filtered.length } }));
    }),
  );
  const view = (key: number) => (
    <MemoryRouter>
      <PersonClinicalRecords key={key} person={person} />
    </MemoryRouter>
  );
  const mounted = render(view(0));
  const verifyDestinations = async (extra: number) => {
    for (const [index, [label, endpoint, filters]] of collections.entries()) {
      const count = index + 2 + extra;
      const link = await screen.findByRole('link', { name: `${label} · ${count}` });
      const href = new URL(link.getAttribute('href')!, 'http://fictional.test');
      expect(href.searchParams.get('personId')).toBe('rowan-person');
      if (endpoint === '/medications') expect(href.searchParams.get('status')).toBe('all');
      if (endpoint === '/procedures') expect(href.searchParams.get('category')).toBe('all');
      if (endpoint === '/notes') expect(href.searchParams.get('kind')).toBe('note');
      if (endpoint === '/documents') expect(href.searchParams.get('view')).toBe('documents');
      if (endpoint === '/historical-notes')
        expect(href.searchParams.get('kind')).toBe('historical');
      const destination = await api<unknown[]>(`${endpoint}?personId=rowan-person${filters}`);
      expect(destination.data).toHaveLength(count);
      expect(destination.meta?.total).toBe(count);
      const filtered = await api<unknown[]>(
        `${endpoint}?personId=rowan-person${filters}&q=fictional`,
      );
      expect(filtered.data).toHaveLength(1);
      expect(filtered.meta?.total).toBe(1);
      // Filtering a destination does not silently change the badge's full scope.
      expect(link).toHaveTextContent(`${label} · ${count}`);
    }
  };
  await verifyDestinations(0);
  await act(async () => {
    await api('/intake-acceptances', {
      method: 'POST',
      body: JSON.stringify({ operationId: 'fictional-accepted' }),
    });
    mounted.rerender(view(1));
  });
  await verifyDestinations(1);
  await act(async () =>
    selectProfile({ id: 'fictional-second', name: 'Other family', placebo: true }),
  );
  await verifyDestinations(10);
  expect(requests.filter((url) => url.searchParams.get('limit') === '1')).toHaveLength(18);
});
