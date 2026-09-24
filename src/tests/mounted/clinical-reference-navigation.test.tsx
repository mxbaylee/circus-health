import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { Procedures } from '../../app/pages/ClinicalRecords';
import { TestResults } from '../../app/pages/TestResults';
import { Sources } from '../../app/pages/Sources';
import { NotesPage } from '../../app/features/notes/NotesPage';
import { NoteLinks } from '../../app/features/notes/NoteLinks';
import { formFor, inputFor } from '../../app/features/notes/note-form';
import { selectProfile } from '../../app/data/profile';
import type { NoteLink, Observation, Procedure } from '../../shared/api';
vi.mock('../../app/components/MeasurementCharts', () => ({
  MeasurementCharts: () => null,
  ComparePicker: () => null,
}));
vi.mock('../../app/components/SourceDialog', () => ({
  SourceDialog: () => null,
  SourcePreview: () => null,
  SourceRecordView: () => null,
}));
vi.mock('../../app/features/notes/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
const id = 'import:procedure:fictional-creatinine',
  encoded = encodeURIComponent(id);
const lab: Observation = {
  id,
  testTypeId: 'fictional-test',
  label: 'Creatinine result',
  date: '2025-01',
  datePrecision: 'month',
  valueText: '1.20',
  value: 1.2,
  unit: 'mg/dL',
  comparator: null,
  reference: null,
  status: 'final',
  providerId: 'fictional',
  provider: 'Fictional clinic',
  sourceRecordId: 'fictional-original',
  reportId: null,
  extra: {},
};
const procedure: Procedure = {
  id,
  label: 'Creatinine order',
  category: 'laboratory',
  date: '2025-01',
  status: 'ordered',
  provider: 'Fictional clinic',
  sourceRecordId: 'fictional-original',
  extra: {},
};
let requests: string[];
beforeEach(() => {
  selectProfile({ id: 'fictional-reference', name: 'Fictional reference', placebo: true });
  requests = [];
});
function mount(bookmark: string, current: 'observation' | 'procedure') {
  const appUrl =
    current === 'observation' ? `/tests?result=${encoded}&detail=1` : `/procedures?id=${encoded}`;
  const apiUrl = current === 'observation' ? `/api/tests/${encoded}` : `/api/procedures/${encoded}`;
  const redirect = { id, reclassifiedTo: { kind: current, recordId: id, appUrl, apiUrl } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const url = new URL(path, 'http://health.test'),
        endpoint = url.pathname.replace('/api/profiles/fictional-reference', '');
      requests.push(endpoint);
      let data: unknown = [];
      if (endpoint === `/procedures/${encoded}`)
        data = current === 'procedure' ? procedure : redirect;
      else if (endpoint === `/tests/${encoded}`) data = current === 'observation' ? lab : redirect;
      else if (endpoint === `/documents/${encoded}` || endpoint === `/historical-notes/${encoded}`)
        data = redirect;
      else if (endpoint === '/related-notes')
        data = [
          {
            id: 'finished-note',
            title: 'Fictional completed visit',
            content: 'Retained discussion',
            status: 'finished',
            updatedAt: '2025-01-01',
            archived: false,
            attachmentCount: 0,
          },
        ];
      else if (endpoint.startsWith('/visibility/'))
        data = { archived: false, protected: false, version: 0, history: [] };
      else if (endpoint === '/historical-note-options')
        data = { sources: [], acquisitionSources: [], types: [] };
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
      else if (endpoint === '/clinical-review/measurement')
        return new Response(
          JSON.stringify({
            error: { code: 'MEASUREMENT_SOURCE', message: 'Not a scalar fixture.' },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      return new Response(JSON.stringify({ data, meta: { revision: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter(
    [
      { path: '/procedures', element: <Procedures /> },
      { path: '/tests', element: <TestResults /> },
      { path: '/sources', element: <Sources /> },
      { path: '/notes', element: <NotesPage /> },
    ],
    { initialEntries: [bookmark] },
  );
  render(<RouterProvider router={router} />);
  return { router, appUrl };
}
for (const bookmark of [
  `/procedures?id=${encoded}`,
  `/sources?document=${encoded}`,
  `/notes?kind=historical&id=${encoded}`,
])
  it(`opens canonical lab detail from retained bookmark ${bookmark.split('?')[0]}`, async () => {
    const { router, appUrl } = mount(bookmark, 'observation');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Creatinine result' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(appUrl),
    );
    expect(screen.queryByText('Procedure status')).not.toBeInTheDocument();
    expect(
      await screen.findAllByRole('link', { name: 'Fictional completed visit' }),
    ).not.toHaveLength(0);
    expect(requests).toContain(`/tests/${encoded}`);
  });
it('opens canonical procedure detail from an earlier observation bookmark without rendering lab fields', async () => {
  const { router, appUrl } = mount(`/tests?result=${encoded}&detail=1`, 'procedure');
  expect(await screen.findByRole('heading', { level: 2, name: 'Creatinine order' })).toBeVisible();
  await waitFor(() =>
    expect(router.state.location.pathname + router.state.location.search).toBe(appUrl),
  );
  expect(screen.getByText('Procedure status')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Chart this' })).not.toBeInTheDocument();
});
it('does not render an empty structured reference as a clinical range or raw JSON', async () => {
  const reference = lab.reference;
  lab.reference = { text: '' };
  try {
    mount(`/tests?result=${encoded}&detail=1`, 'observation');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Creatinine result' }),
    ).toBeVisible();
    expect(screen.queryByText('Reference range')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('"text"');
  } finally {
    lab.reference = reference;
  }
});
it('finished note links navigate to current classification while draft input preserves original tuple', () => {
  const link: NoteLink = {
    id: 'retained-link',
    targetType: 'procedure',
    targetId: id,
    relation: 'references',
    resolvedTargetType: 'observation',
    appUrl: `/tests?result=${encoded}&detail=1`,
    title: 'Creatinine result',
    archived: false,
    missing: false,
    current: true,
  };
  render(
    <MemoryRouter>
      <NoteLinks links={[link]} onChange={() => {}} readOnly />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Creatinine result' })).toHaveAttribute(
    'href',
    link.appUrl,
  );
  expect(screen.getByText(/Individual results/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Remove link/ })).not.toBeInTheDocument();
  const draft = formFor(null);
  draft.links = [link];
  const input = inputFor(draft, 'note', 2);
  expect(input.links).toEqual([{ targetType: 'procedure', targetId: id, relation: 'references' }]);
});
