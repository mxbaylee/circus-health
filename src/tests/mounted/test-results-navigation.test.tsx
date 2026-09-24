import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestResults } from '../../app/pages/TestResults';
import { selectProfile } from '../../app/data/profile';
import type { Observation, TestType } from '../../shared/api';

// Exercise the real filters, route state, ComparePicker and trend requests;
// PDF/media and canvas drawing are independently tested components.
vi.mock('../../app/components/TrendChart', () => ({
  TrendChart: () => <div aria-label="Chart canvas" />,
}));
vi.mock('../../app/components/SourceDialog', () => ({ SourceDialog: () => null }));
vi.mock('../../app/components/RelatedNotes', () => ({ RelatedNotes: () => null }));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
const measurement = (id: string, label: string, unit = 'mg/dL'): TestType => ({
  id,
  label,
  unit,
  category: 'Fictional measurements',
  aliases: [],
  codes: [],
  context: null,
  count: 2,
  numericCount: 2,
  firstDate: '2025-01-01',
  lastDate: '2026-01-01',
});
const types = [
  measurement('total', 'Total Cholesterol'),
  measurement('hdl', 'HDL Cholesterol'),
  measurement('weight', 'Body Weight', 'kg'),
];
const result = (type: TestType, suffix: string, date: string): Observation => ({
  id: `${type.id}-${suffix}`,
  testTypeId: type.id,
  label: type.label,
  date,
  datePrecision: 'day',
  valueText: '100',
  value: 100,
  comparator: null,
  unit: type.unit,
  reference: null,
  status: 'final',
  providerId: 'fictional',
  provider: 'Fictional clinic',
  sourceRecordId: 'fictional-source',
  reportId: null,
  extra: {},
});
const results = types.flatMap((type) => [
  result(type, 'new', '2026-01-01'),
  result(type, 'old', '2025-01-01'),
]);
let requests: URL[];
beforeEach(() => {
  selectProfile({ id: 'fictional-results', name: 'Cookie Dough', placebo: true });
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const url = new URL(path, 'http://health.test');
      requests.push(url);
      const endpoint = url.pathname.replace('/api/profiles/fictional-results', '');
      const q = (url.searchParams.get('q') || '').toLowerCase();
      let data: unknown;
      if (endpoint === '/providers') data = [];
      else if (endpoint === '/test-types')
        data = types.filter((type) => type.label.toLowerCase().includes(q));
      else if (endpoint === '/tests')
        data = results
          .filter(
            (row) =>
              row.label.toLowerCase().includes(q) &&
              (!url.searchParams.get('testTypeId') ||
                row.testTypeId === url.searchParams.get('testTypeId')),
          )
          .slice(0, Number(url.searchParams.get('limit')) || 40);
      else if (endpoint.startsWith('/tests/'))
        data = results.find((row) => row.id === endpoint.slice('/tests/'.length));
      else if (endpoint === '/clinical-relationships')
        data = {
          record: {
            kind: url.searchParams.get('kind'),
            recordId: url.searchParams.get('recordId'),
          },
          relationships: [],
          legacyPairs: [],
          display: {
            visibleByDefault: true,
            preferredRecordId: null,
            countGroupId: `record:${url.searchParams.get('recordId')}`,
            oneReviewedEvent: false,
            requiresReview: false,
          },
          truncated: false,
        };
      else if (endpoint === '/clinical-review/measurement') {
        const row = results.find((item) => item.id === url.searchParams.get('recordId'))!;
        data = {
          reference: {
            profileId: 'fictional-results',
            kind: 'observation',
            recordId: row.id,
            sourceRecordId: row.sourceRecordId,
            identity: row.id,
            version: '1',
            stateHash: `state:${row.id}`,
            evidenceHash: `evidence:${row.id}`,
          },
          source: {
            valueText: row.valueText,
            comparator: row.comparator,
            unit: row.unit,
            date: row.date,
          },
          semanticStatus: 'none',
          binding: null,
          lastDecision: null,
        };
      } else if (endpoint === '/trends')
        data = url.searchParams
          .get('ids')!
          .split(',')
          .map((id) => ({
            test: types.find((type) => type.id === id),
            points: results.filter((row) => row.testTypeId === id),
            complete: true,
            unplottableCount: 0,
          }));
      else throw new Error(`Unmocked request ${url}`);
      return new Response(JSON.stringify({ data, meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});
function mount(url: string) {
  const router = createMemoryRouter([{ path: '/tests', element: <TestResults /> }], {
    initialEntries: [url],
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Test Results comparison navigation', () => {
  it('offers correction for an individual saved result', async () => {
    const user = userEvent.setup();
    mount('/tests?result=total-new&detail=1');
    await screen.findByRole('heading', { level: 2, name: 'Total Cholesterol' });
    expect(await screen.findByRole('region', { name: 'Record relationships' })).toBeVisible();
    expect(
      requests.some(
        (url) =>
          url.pathname.endsWith('/clinical-relationships') &&
          url.searchParams.get('kind') === 'observation' &&
          url.searchParams.get('recordId') === 'total-new',
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'More entry actions' }));
    expect(screen.getByRole('button', { name: 'Correct saved record' })).toBeVisible();
  });

  it('clears comparison choices when selecting another primary measurement', async () => {
    const user = userEvent.setup();
    const router = mount('/tests?view=by-test');
    await user.type(screen.getByRole('textbox', { name: 'Search results' }), 'Chol');
    const list = await screen.findByRole('region', { name: 'Test types' });
    await user.click(await within(list).findByRole('button', { name: /^Total Cholesterol/ }));
    await user.click(await screen.findByRole('button', { name: 'Compare' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Search measurement names and aliases' }),
      'Weight',
    );
    await user.click(await screen.findByRole('button', { name: /^Body Weight/ }));
    await screen.findByRole('button', { name: 'Remove Body Weight comparison' });
    expect(router.state.location.search).toContain('compare=weight');
    await user.click(within(list).getByRole('button', { name: /^HDL Cholesterol/ }));
    await screen.findByRole('heading', { level: 2, name: 'HDL Cholesterol' });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove Body Weight comparison' }),
      ).not.toBeInTheDocument(),
    );
    expect(router.state.location.search).not.toContain('compare=');
    expect(
      requests
        .filter((url) => url.pathname.endsWith('/trends'))
        .some((url) => url.searchParams.get('ids') === 'hdl,weight'),
    ).toBe(false);
    // Browser Back changes the primary too; it must not revive the older comparison.
    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByRole('heading', { level: 2, name: 'Total Cholesterol' });
    await waitFor(() => expect(router.state.location.search).not.toContain('compare='));
  });

  it('keeps comparisons while selecting another result of the same measurement', async () => {
    const user = userEvent.setup();
    const router = mount('/tests?result=total-new&compare=weight');
    await screen.findByRole('button', { name: 'Remove Body Weight comparison' });
    const history = screen.getByRole('region', { name: 'Result history' });
    const totalRows = within(history).getAllByRole('button', { name: /^Total Cholesterol/ });
    await user.click(totalRows[1]);
    await waitFor(() => expect(totalRows[1]).toHaveAttribute('aria-pressed', 'true'));
    await screen.findByRole('button', { name: 'Remove Body Weight comparison' });
    expect(router.state.location.search).toContain('result=total-old');
    expect(router.state.location.search).toContain('compare=weight');
  });
});

it('separates icon tabs from full-width filters and keeps keyboard tab navigation and URL filters', async () => {
  const user = userEvent.setup();
  const router = mount('/tests?q=Chol&visibility=archived&offset=40');
  const tabs = screen.getByRole('tablist', { name: 'Browse test results' });
  const search = screen.getByRole('textbox', { name: 'Search results' });
  expect(tabs).not.toContainElement(search);
  expect(search.closest('.collection-toolbar')).toContainElement(
    screen.getByText('Inactive', { selector: '.people-filter-pill > span' }),
  );
  const history = within(tabs).getByRole('tab', { name: 'History' });
  history.focus();
  await user.keyboard('{ArrowRight}');
  expect(within(tabs).getByRole('tab', { name: 'By test' })).toHaveFocus();
  expect(router.state.location.search).toContain('view=by-test');
  expect(router.state.location.search).toContain('q=Chol');
  expect(router.state.location.search).toContain('visibility=archived');
  expect(router.state.location.search).not.toContain('offset=');
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'types-tab');
});

it('points an empty structured history toward optical prescriptions', async () => {
  mount('/tests?q=no-such-fictional-result');
  expect(
    await screen.findByText(
      'No structured test results match these filters. Optical prescriptions are listed on the Vision tab.',
    ),
  ).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Vision' })).toBeVisible();
});
