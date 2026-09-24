import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MeasurementReviewPanel } from '../../app/features/clinical-review/MeasurementReviewPanel';
import { selectProfile } from '../../app/data/profile';
import type { AcceptedMeasurement } from '../../shared/measurement-semantics';

const accepted: AcceptedMeasurement = {
  reference: {
    profileId: 'fictional-measurement',
    kind: 'observation',
    recordId: 'result:bounded',
    sourceRecordId: 'source:fictional',
    identity: 'fictional identity',
    version: '1',
    stateHash: 'state-hash',
    evidenceHash: 'evidence-hash',
  },
  source: { valueText: '≤ 1.20', comparator: '<=', unit: 'mg/dL', date: '2025-04-02' },
  semanticStatus: 'none',
  binding: null,
  lastDecision: null,
};

beforeEach(() => {
  selectProfile({ id: 'fictional-measurement', name: 'Fictional measurement', placebo: true });
});

it('loads one explicit detail measurement and keeps the original qualifier, unit and range visible', async () => {
  const fetch = vi.fn(
    async (_path: string | URL | Request) =>
      new Response(JSON.stringify({ data: accepted, meta: { revision: 4 } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);

  render(
    <MeasurementReviewPanel
      kind="observation"
      recordId="result:bounded"
      title="Fictional marker"
      referenceText={'{"high":"1.50 mg/dL"}'}
      onApplied={vi.fn()}
    />,
  );

  const panel = await screen.findByRole('region', { name: 'Reviewed measurement display' });
  expect(within(panel).getByText('≤ 1.20 mg/dL')).toBeVisible();
  expect(within(panel).getByText('{"high":"1.50 mg/dL"}')).toBeVisible();
  expect(within(panel).getByText('Meaning not reviewed')).toBeVisible();
  expect(within(panel).getByText(/Review the measurement meaning/)).toBeVisible();
  expect(within(panel).getByRole('button', { name: 'Comparison settings' })).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = new URL(String(fetch.mock.calls[0]![0]), 'http://health.test');
  expect(request.pathname).toBe('/api/profiles/fictional-measurement/clinical-review/measurement');
  expect(request.searchParams.get('kind')).toBe('observation');
  expect(request.searchParams.get('recordId')).toBe('result:bounded');
});

it('states when derived display is unavailable without inventing settings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'MEASUREMENT_SOURCE',
              message: 'The record is not an accepted scalar measurement.',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );

  render(
    <MeasurementReviewPanel
      kind="procedure"
      recordId="procedure:visit"
      title="Fictional visit"
      onApplied={vi.fn()}
    />,
  );

  expect(await screen.findByText(/Reviewed measurement display is unavailable/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Comparison settings' })).not.toBeInTheDocument();
});
