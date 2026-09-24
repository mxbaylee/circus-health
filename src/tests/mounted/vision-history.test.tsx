import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { TestResults } from '../../app/pages/TestResults';
import { selectProfile } from '../../app/data/profile';

vi.mock('../../app/components/SourceDialog', () => ({
  SourceDialog: ({ sourceRecordId }: { sourceRecordId: string }) => (
    <a href={`/source-records/${sourceRecordId}`}>View source</a>
  ),
}));
vi.mock('../../app/components/RelatedNotes', () => ({ RelatedNotes: () => null }));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../../app/components/TrendChart', () => ({ TrendChart: () => null }));

it('Vision tab compares every literal source entry with original links and unknown units/dates', async () => {
  selectProfile({ id: 'fictional-vision', name: 'Fictional person', placebo: true });
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const url = new URL(path, 'http://health.test');
      requests.push(url);
      const data = url.pathname.endsWith('/vision-prescriptions')
        ? ['a', 'b'].map((id) => ({
            id,
            occurrenceId: id,
            title: 'Fictional prescription ' + id,
            date: null,
            provider: 'Fictional clinic',
            sourceRecordId: id,
            opticalPrescription: {
              type: 'spectacle',
              typeText: 'Distance pair',
              statusText: 'Copy released',
              prescribedDateText: '03/04/??',
              eyes: [
                {
                  side: 'right',
                  sideText: 'OD',
                  sph: { valueText: '+01.00' },
                  axis: { valueText: '005' },
                },
                { side: 'left', sideText: 'OS', cyl: { valueText: '-0.50', unit: 'D' } },
              ],
            },
            evidence: [],
          }))
        : [];
      return new Response(JSON.stringify({ data, meta: { total: data.length, revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter([{ path: '/tests', element: <TestResults /> }], {
    initialEntries: ['/tests?view=vision'],
  });
  render(<RouterProvider router={router} />);
  expect(screen.getByRole('tab', { name: 'Vision' })).toHaveAttribute('aria-selected', 'true');
  const first = await screen.findByRole('article', { name: 'Fictional prescription a' });
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(within(first).getByText('+01.00')).toBeVisible();
  expect(within(first).getByText('005')).toBeVisible();
  expect(within(first).getByText('-0.50')).toBeVisible();
  expect(within(first).getByText('03/04/??')).toBeVisible();
  expect(within(first).getByText('Distance pair')).toBeVisible();
  expect(within(first).getByText('Copy released')).toBeVisible();
  expect(within(first).getAllByText('Unit not stated')).toHaveLength(2);
  expect(within(first).getByText(/Unknown date/)).toBeVisible();
  expect(within(first).getByRole('link', { name: 'View source' })).toHaveAttribute(
    'href',
    '/source-records/a',
  );
  expect(requests.some((url) => /\/(tests|trends)$/.test(url.pathname))).toBe(false);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'History' }));
  expect(router.state.location.search).not.toContain('view=vision');
});
