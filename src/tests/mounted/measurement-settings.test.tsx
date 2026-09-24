import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  MeasurementSettingsAction,
  type MeasurementSettingsTarget,
} from '../../app/features/clinical-review/MeasurementSettingsAction';
import { MeasurementComparison } from '../../app/features/clinical-review/MeasurementComparison';
import type {
  MeasurementSemanticApplyRequest,
  MeasurementSemanticApplyResult,
  MeasurementSemanticPreview,
  MeasurementSemanticRequest,
} from '../../shared/measurement-semantics';
import { MEASUREMENT_RULE_VERSION } from '../../shared/measurement-units';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
const profile = { id: 'fictional-measurement', name: 'Fictional Person', placebo: true };
beforeEach(() => {
  replaceProfiles([profile]);
  selectProfile(profile);
});
const semantics = {
  quantity: 'Fictional body mass',
  dimension: 'mass' as const,
  region: 'whole_body',
  specimen: 'not_applicable',
  method: 'Fictional scale',
  meaning: 'measured_mass',
};
function target(id = 'fictional-first', reviewed = true): MeasurementSettingsTarget {
  const reference = {
    profileId: profile.id,
    recordId: id,
    kind: 'observation' as const,
    sourceRecordId: 'source:' + id,
    identity: 'identity:' + id,
    version: 'v1',
    stateHash: 'state:' + id,
    evidenceHash: 'evidence:' + id,
  };
  return {
    title: 'Fictional measurement ' + id,
    referenceText: '0–200 kg; depends on fictional specimen',
    evidence: [
      {
        contentUrl: '/api/sources/' + id + '/content',
        label: 'Fictional original',
        locator: 'page 1',
      },
    ],
    measurement: {
      reference,
      source: { valueText: '100.00', unit: 'kg', date: '2026-02-10' },
      semanticStatus: reviewed ? 'current' : 'none',
      lastDecision: null,
      binding: reviewed
        ? {
            decisionId: 'accepted:' + id,
            reference,
            rulesVersion: MEASUREMENT_RULE_VERSION,
            subject: 'self',
            semantics,
            precision: null,
          }
        : null,
    },
  };
}
function previewFor(
  value: MeasurementSettingsTarget,
  request: MeasurementSemanticRequest,
): MeasurementSemanticPreview {
  return {
    request,
    reference: value.measurement.reference,
    source: value.measurement.source,
    subject: 'self',
    evidence: value.evidence!.map((e) => ({ ...e, locator: e.locator || '' })),
    rulesVersion: MEASUREMENT_RULE_VERSION,
    previousDecisionId: value.measurement.binding?.decisionId || null,
    version: 7,
    previewToken: 'a'.repeat(64),
  };
}
function resultFor(request: MeasurementSemanticApplyRequest): MeasurementSemanticApplyResult {
  return {
    replayed: false,
    decision: {
      id: 'measurement-semantics:' + request.operationId,
      operationId: request.operationId,
      reference: request.reference,
      source: { valueText: '100.00', unit: 'kg' },
      subject: 'self',
      rulesVersion: MEASUREMENT_RULE_VERSION,
      semantics: request.semantics,
      precision: request.precision,
      reason: request.reason,
      previousDecisionId: null,
      at: '2026-02-10T12:00:00Z',
      sequence: 8,
    },
  };
}
function callbacks(value: MeasurementSettingsTarget) {
  return {
    preview: vi.fn(async (request: MeasurementSemanticRequest) => previewFor(value, request)),
    apply: vi.fn(async (request: MeasurementSemanticApplyRequest) => resultFor(request)),
    onApplied: vi.fn(),
  };
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Comparison settings' }));
async function prepare() {
  change('Reason for this review', 'Reviewed the fictional original meaning.');
  fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }));
  await screen.findByRole('button', { name: 'Apply reviewed settings' });
}

it('requires complete explicitly entered meanings and reason, previews before applying, and restores focus', async () => {
  const value = target('empty', false),
    api = callbacks(value);
  render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  expect(screen.getByLabelText('Quantity being measured')).toHaveValue('');
  expect(screen.getByLabelText('Unit family')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Preview settings' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Apply reviewed settings' })).not.toBeInTheDocument();
  expect(screen.getByText(value.referenceText!)).toBeVisible();
  change('Unit family', 'mass');
  change('Quantity being measured', semantics.quantity);
  change('Body region', semantics.region);
  change('Measurement method', semantics.method);
  change('Result meaning', semantics.meaning);
  fireEvent.click(screen.getByRole('button', { name: 'Not applicable: specimen' }));
  await prepare();
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.preview.mock.calls[0]![0].semantics).toEqual(semantics);
  expect(screen.getAllByRole('link', { name: 'Open original' })[0]).toHaveAttribute(
    'href',
    '/api/profiles/fictional-measurement/sources/empty/content',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed settings' }));
  await waitFor(() => expect(api.onApplied).toHaveBeenCalledTimes(1));
  expect(api.apply.mock.calls[0]![0]).toMatchObject({
    reference: value.measurement.reference,
    version: 7,
    previewToken: 'a'.repeat(64),
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Comparison settings' })).toHaveFocus(),
  );
});

it('editing invalidates a preview; unknown precision stays null until explicitly reviewed', async () => {
  const value = target(),
    api = callbacks(value);
  render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  await prepare();
  expect(api.preview.mock.calls[0]![0].precision).toBeNull();
  change('Measurement method', 'Fictional revised method');
  expect(screen.queryByRole('button', { name: 'Apply reviewed settings' })).not.toBeInTheDocument();
  change('Known rounding precision', 'source_statement');
  change('Rounding increment in the source unit', '0.01');
  change(
    'Evidence for this rounding increment',
    'The fictional source explicitly states hundredths.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }));
  await screen.findByRole('button', { name: 'Apply reviewed settings' });
  expect(api.preview.mock.calls[1]![0].precision).toEqual({
    increment: '0.01',
    basis: 'source_statement',
    evidence: 'The fictional source explicitly states hundredths.',
  });
  expect(api.apply).not.toHaveBeenCalled();
});

it('uncertain reply locks edits and reuses the exact operation across closing, reopening and retry', async () => {
  const value = target(),
    api = callbacks(value);
  api.apply.mockRejectedValueOnce(new Error('Fictional lost reply'));
  render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed settings' }));
  await screen.findByRole('button', { name: 'Retry Apply' });
  expect(screen.getByLabelText('Measurement method')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Retry Apply' }));
  await waitFor(() => expect(api.onApplied).toHaveBeenCalledTimes(1));
  expect(api.apply.mock.calls[1]![0]).toEqual(api.apply.mock.calls[0]![0]);
});

it('known stale scope rejection discards Apply while publication retry keeps the accepted operation', async () => {
  const value = target(),
    api = callbacks(value);
  api.apply.mockRejectedValueOnce(
    Object.assign(new Error('Review the changed measurement again.'), {
      status: 409,
      code: 'MEASUREMENT_SCOPE_CHANGED',
    }),
  );
  render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed settings' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Apply reviewed settings' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Measurement method')).not.toBeDisabled();
  api.apply.mockImplementationOnce(async (request) => ({
    ...resultFor(request),
    durability: { pending: true, error: 'Fictional publish retry' },
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }));
  await screen.findByRole('button', { name: 'Apply reviewed settings' });
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed settings' }));
  await screen.findByText('The review is saved. Retry publishing its recovery copy.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry Apply' }));
  await waitFor(() => expect(api.onApplied).toHaveBeenCalledTimes(1));
  expect(api.apply.mock.calls[2]![0]).toEqual(api.apply.mock.calls[1]![0]);
});

it('late previews from changed target scope cannot reveal Apply for another measurement', async () => {
  const value = target(),
    api = callbacks(value);
  let resolve!: (value: MeasurementSemanticPreview) => void;
  api.preview.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  change('Reason for this review', 'Reviewed fictional meaning.');
  fireEvent.click(screen.getByRole('button', { name: 'Preview settings' }));
  const request = api.preview.mock.calls[0]![0];
  view.rerender(<MeasurementSettingsAction target={target('different')} {...api} />);
  await act(async () => resolve(previewFor(value, request)));
  open();
  expect(screen.queryByRole('button', { name: 'Apply reviewed settings' })).not.toBeInTheDocument();
  expect(api.apply).not.toHaveBeenCalled();
});

it('withdrawal is separately previewed and never restores an inferred default mapping', async () => {
  const value = target(),
    api = callbacks(value);
  render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  change('Action', 'revoke');
  await prepare();
  expect(api.preview.mock.calls[0]![0]).toMatchObject({ semantics: null, precision: null });
  expect(screen.getByRole('heading', { name: 'Withdraw these comparison settings' })).toBeVisible();
  expect(api.apply).not.toHaveBeenCalled();
});

it('converted display retains both same-day source assertions and unconverted ambiguous reference ranges', () => {
  const left = target('first'),
    right = target('second');
  left.measurement.source = { valueText: '100.00 kg', unit: 'kg', date: '2026-02-10' };
  right.measurement.source = { valueText: '100000.0 g', unit: 'g', date: '2026-02-10' };
  right.referenceText = 'Use age-specific range; see source';
  render(<MeasurementComparison left={left} right={right} initialUnit="g" />);
  expect(screen.getByText('100.00 kg')).toBeVisible();
  expect(screen.getByText('100000.0 g')).toBeVisible();
  expect(screen.getByText(left.referenceText!)).toBeVisible();
  expect(screen.getByText(right.referenceText)).toBeVisible();
  expect(screen.getAllByText('Reference range (original, not converted):')).toHaveLength(2);
  expect(screen.getByText('Reported values are exactly equal after conversion.')).toBeVisible();
  expect(screen.getAllByRole('link', { name: 'Open original' })).toHaveLength(2);
});

it('bounds display exact thresholds instead of rounded point values, and unknown units stay visible', () => {
  const value = target('bound');
  value.measurement.source = { valueText: '<0.0001', comparator: '<', unit: 'kg' };
  const view = render(<MeasurementComparison left={value} initialUnit="g" decimalPlaces={0} />);
  const region = screen.getByRole('region', { name: value.title });
  expect(within(region).getByText('< 0.1 g')).toBeVisible();
  expect(within(region).getByText('This is a bound, not an observed point value.')).toBeVisible();
  expect(screen.getByText('<0.0001 kg')).toBeVisible();
  expect(screen.queryByText('< <0.0001 kg')).not.toBeInTheDocument();
  const ambiguous = target('unknown', false);
  ambiguous.measurement.source = { valueText: '12.0', unit: 'lb' };
  view.rerender(<MeasurementComparison left={ambiguous} />);
  expect(screen.getByText('12.0 lb')).toBeVisible();
  expect(
    screen.getByText('The unit is ambiguous; choose its meaning in a separate review.'),
  ).toBeVisible();
});

it('late Apply from an old target cannot refresh or acknowledge a different measurement', async () => {
  const value = target(),
    api = callbacks(value);
  let resolve!: (value: MeasurementSemanticApplyResult) => void;
  api.apply.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<MeasurementSettingsAction target={value} {...api} />);
  open();
  await prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed settings' }));
  const submitted = api.apply.mock.calls[0]![0];
  view.rerender(<MeasurementSettingsAction target={target('new-target')} {...api} />);
  await act(async () => resolve(resultFor(submitted)));
  expect(api.onApplied).not.toHaveBeenCalled();
});

it('conflicting written and stored qualifiers remain visible and cannot convert', () => {
  const value = target('conflict');
  value.measurement.source = { valueText: '<1.0', comparator: '>', unit: 'kg' };
  render(<MeasurementComparison left={value} initialUnit="g" />);
  expect(screen.getByText('<1.0 kg')).toBeVisible();
  expect(screen.getByText('Stored qualifier: >')).toBeVisible();
  expect(screen.getByText('This source value is not a supported decimal.')).toBeVisible();
});
