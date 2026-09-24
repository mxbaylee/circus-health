import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { MeasurementCharts } from '../../app/components/MeasurementCharts';
import { ApiError } from '../../app/data/api';
import type { Trend } from '../../shared/api';
import { deriveMeasurement, type MeasurementInput } from '../../shared/measurement';
import { MEASUREMENT_RULE_VERSION } from '../../shared/measurement-units';

const state = vi.hoisted(() => ({
  data: [] as Trend[],
  error: false,
  reload: vi.fn(),
  paths: [] as string[],
}));
vi.mock('../../app/data/api', async (original) => ({
  ...(await original<typeof import('../../app/data/api')>()),
  useResource: (path: string) => {
    state.paths.push(path);
    return {
      data: state.error && path.includes('unit=') ? null : state.data,
      loading: false,
      error:
        state.error && path.includes('unit=')
          ? new ApiError('Choose at most 256 results for conversion')
          : null,
      reload: state.reload,
    };
  },
}));
vi.mock('../../app/components/TrendChart', () => ({
  TrendChart: () => <div aria-label="Chart drawing" />,
}));
function Location() {
  return <output aria-label="Current URL">{useLocation().search}</output>;
}
function fixture(): Trend[] {
  const reference = {
    profileId: 'fictional',
    kind: 'observation' as const,
    recordId: 'first',
    sourceRecordId: 'source:first',
    identity: 'identity',
    version: 'v1',
    stateHash: 'state',
    evidenceHash: 'evidence',
  };
  const input: MeasurementInput = {
    reference,
    source: { valueText: '12.00', unit: 'mg', comparator: null },
    binding: {
      decisionId: 'decision',
      reference,
      rulesVersion: MEASUREMENT_RULE_VERSION,
      subject: 'self',
      precision: null,
      semantics: {
        quantity: 'mass',
        dimension: 'mass',
        region: 'not_applicable',
        specimen: 'fictional_sample',
        method: 'gravimetry',
        meaning: 'sample_mass',
      },
    },
  };
  return [
    {
      test: {
        id: 'mass',
        label: 'Fictional sample mass',
        category: 'Fictional',
        unit: 'mg',
        aliases: [],
        codes: [],
        context: null,
        count: 1,
        numericCount: 1,
        firstDate: '2026-02-10',
        lastDate: '2026-02-10',
      },
      points: [
        {
          id: 'first',
          testTypeId: 'mass',
          label: 'Fictional sample mass',
          date: '2026-02-10',
          datePrecision: 'day',
          valueText: '12.00',
          value: 12,
          comparator: null,
          unit: 'mg',
          reference: { text: 'Fictional range: 10–20 mg' },
          status: 'final',
          providerId: 'fictional-provider',
          provider: 'Fictional provider',
          sourceRecordId: 'source:first',
          reportId: null,
          extra: {},
          measurement: deriveMeasurement(input, 'g'),
        },
      ],
      complete: true,
      unplottableCount: 0,
    },
  ];
}
beforeEach(() => {
  state.data = fixture();
  state.error = false;
  state.reload.mockReset();
  state.paths = [];
});
function View({ revision = 1 }: { revision?: number }) {
  return (
    <MemoryRouter initialEntries={['/tests?compareUnit=g&q=mass&from=2026-01-01']}>
      <MeasurementCharts ids={['mass']} from="2026-01-01" revision={revision} />
      <Location />
    </MemoryRouter>
  );
}
it('shows the chosen conversion alongside unchanged original values and explicitly original ranges', () => {
  const before = structuredClone(state.data);
  render(<View />);
  expect(screen.getByRole('combobox', { name: 'Chart display units' })).toHaveValue('g');
  fireEvent.click(screen.getByText('Recorded values (1)'));
  expect(screen.getByText('12.00 mg')).toBeInTheDocument();
  expect(screen.getByText('0.012 g')).toBeInTheDocument();
  expect(screen.getByText(/Reference range \(original, not converted\)/)).toHaveTextContent(
    '10–20 mg',
  );
  expect(state.data).toEqual(before);
  fireEvent.change(screen.getByRole('combobox', { name: 'Chart display units' }), {
    target: { value: '' },
  });
  expect(screen.getByLabelText('Current URL')).toHaveTextContent('?q=mass&from=2026-01-01');
  expect(screen.queryByText('0.012 g')).not.toBeInTheDocument();
});
it('does not expose an empty structured reference as raw JSON', () => {
  state.data[0]!.points[0]!.reference = { text: '' };
  render(<View />);
  fireEvent.click(screen.getByText('Recorded values (1)'));
  expect(screen.queryByText(/Reference range \(original, not converted\)/)).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('"text"');
});
it('keeps Original units reachable after a bounded conversion error', async () => {
  state.error = true;
  render(<View />);
  expect(screen.getByText('Choose at most 256 results for conversion')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Chart display units' }), {
    target: { value: '' },
  });
  await waitFor(() => expect(screen.getByLabelText('Chart drawing')).toBeInTheDocument());
  expect(state.paths.at(-1)).not.toContain('unit=');
});
it('refetches after a reviewed mutation without resetting the chosen units or search', () => {
  const view = render(<View />);
  expect(state.reload).not.toHaveBeenCalled();
  view.rerender(<View revision={2} />);
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Current URL')).toHaveTextContent('compareUnit=g&q=mass');
});
