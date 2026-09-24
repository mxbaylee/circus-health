import { useId, useState } from 'react';
import { apiUrl } from '../../data/api';
import {
  compareMeasurements,
  deriveMeasurement,
  type DerivedMeasurement,
  type MeasurementInput,
} from '../../../shared/measurement';
import {
  resolveMeasurementUnit,
  supportedMeasurementUnits,
} from '../../../shared/measurement-units';
import { formatMeasurementValue } from '../../../shared/measurement-value';
import './measurement.css';

export interface MeasurementDisplayTarget {
  title: string;
  measurement: MeasurementInput;
  /** Keep the full literal range. No range parsing or conversion occurs here. */
  referenceText?: string | null;
  evidence?: { contentUrl: string; label: string; locator?: string }[];
}
const labels: Record<DerivedMeasurement['status'], string> = {
  converted: 'Converted value',
  invalid_literal: 'This source value is not a supported decimal.',
  missing_unit: 'The source unit is missing.',
  ambiguous_unit: 'The unit is ambiguous; choose its meaning in a separate review.',
  unsupported_unit: 'This unit is not supported for conversion.',
  incompatible_dimension: 'These units or quantities are not compatible.',
  semantic_review_required: 'Review the measurement meaning before converting.',
  stale_semantics: 'The accepted measurement changed. Review its meaning again.',
  invalid_precision: 'The reviewed rounding increment does not match this value.',
};
const compact = (text: string) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export function MeasurementOriginal({ target }: { target: MeasurementDisplayTarget }) {
  const { source } = target.measurement;
  const inline = /^(<=|>=|<|>|≤|≥|=|~|≈)/.exec(source.valueText.trim())?.[1];
  const qualifier = (value: string) =>
    value.replace('≤', '<=').replace('≥', '>=').replace('≈', '~').trim();
  return (
    <div className="measurement-original">
      <p>
        <strong>Original value:</strong>{' '}
        <span className="measurement-literal">
          {source.comparator && !inline ? source.comparator + ' ' : ''}
          {formatMeasurementValue(source.valueText, source.unit)}
        </span>
        {!source.unit && ' · Unit not supplied'}
      </p>
      {source.comparator && inline && qualifier(source.comparator) !== qualifier(inline) && (
        <p>Stored qualifier: {source.comparator}</p>
      )}
      {source.date && <p>Source date: {source.date}</p>}
      {target.referenceText != null && target.referenceText !== '' && (
        <p>
          <strong>Reference range (original, not converted):</strong>{' '}
          <span className="measurement-literal">{target.referenceText}</span>
        </p>
      )}
      {target.evidence?.map((item, index) => (
        <p key={index}>
          {item.label}
          {item.locator ? ' · ' + item.locator : ''} ·{' '}
          <a href={apiUrl(item.contentUrl)} target="_blank" rel="noreferrer">
            Open original
          </a>
        </p>
      ))}
    </div>
  );
}
export function MeasurementValue({
  target,
  targetUnit,
  decimalPlaces = 6,
}: {
  target: MeasurementDisplayTarget;
  targetUnit: string;
  decimalPlaces?: number;
}) {
  const projection = deriveMeasurement(target.measurement, targetUnit, decimalPlaces),
    conversion = projection.conversion;
  const amount =
    conversion &&
    (conversion.valueRole === 'point'
      ? compact(conversion.display.value)
      : (conversion.exactDecimal ??
        `${conversion.value.numerator}/${conversion.value.denominator}`));
  return (
    <section className="measurement-value" aria-label={target.title}>
      <h4>{target.title}</h4>
      <MeasurementOriginal target={target} />
      {conversion ? (
        <>
          <p>
            <strong>In {conversion.to}:</strong>{' '}
            <span>
              {conversion.comparator !== '=' ? conversion.comparator + ' ' : ''}
              {amount} {conversion.to}
            </span>
          </p>
          <p className="measurement-notice">
            Converted from {conversion.from}
            {conversion.usedAlias ? ' using a recognized unit spelling' : ''}.
            {conversion.valueRole === 'point' && conversion.display.applied
              ? ` Rounded for display to ${conversion.display.decimalPlaces} decimal places.`
              : ' Exact unit conversion.'}
          </p>
          {conversion.valueRole === 'bound' && <p>This is a bound, not an observed point value.</p>}
          {conversion.valueRole === 'approximation' && (
            <p>The source is approximate; its uncertainty is not specified.</p>
          )}
          <details>
            <summary>Conversion details</summary>
            <p>
              Exact converted value:{' '}
              {conversion.exactDecimal ??
                `${conversion.value.numerator}/${conversion.value.denominator}`}{' '}
              {conversion.to}
            </p>
            <p>
              Source digits remain unchanged. Display rounding does not describe biological
              uncertainty.
            </p>
          </details>
        </>
      ) : (
        <p role="status">{labels[projection.status]}</p>
      )}
    </section>
  );
}
const outcomeLabels = {
  exact: 'Reported values are exactly equal after conversion.',
  consistent_with_rounding: 'Reported values are consistent with the reviewed rounding increments.',
  different: 'Reported values differ after conversion.',
  bounded: 'A bounded value is not a point measurement.',
  approximate: 'An approximate value has no specified uncertainty interval.',
  unavailable: 'These measurements cannot currently be compared.',
};
/** Display only: no source rows, relationships or chart membership are hidden or mutated. */
export function MeasurementComparison({
  left,
  right,
  initialUnit,
  decimalPlaces = 6,
}: {
  left: MeasurementDisplayTarget;
  right?: MeasurementDisplayTarget;
  initialUnit?: string;
  decimalPlaces?: number;
}) {
  const sourceUnit = resolveMeasurementUnit(left.measurement.source.unit);
  const options = supportedMeasurementUnits().filter(
    (unit) => unit.dimension === left.measurement.binding?.semantics.dimension,
  );
  const fallback =
    sourceUnit.status === 'supported' ? sourceUnit.unit.code : left.measurement.source.unit || '';
  const [chosen, setChosen] = useState(initialUnit || fallback);
  const targetUnit = options.some((option) => option.code === chosen) ? chosen : fallback;
  const id = useId();
  const comparison = right
    ? compareMeasurements(left.measurement, right.measurement, targetUnit, decimalPlaces)
    : null;
  return (
    <section className="measurement-comparison" aria-label="Measurement comparison">
      {!!options.length && (
        <label htmlFor={id}>
          Display unit
          <select id={id} value={targetUnit} onChange={(event) => setChosen(event.target.value)}>
            {!options.some((option) => option.code === targetUnit) && (
              <option value={targetUnit}>{targetUnit || 'Original unit'}</option>
            )}
            {options.map((unit) => (
              <option key={unit.code} value={unit.code}>
                {unit.code}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="measurement-columns">
        <MeasurementValue target={left} targetUnit={targetUnit} decimalPlaces={decimalPlaces} />
        {right && (
          <MeasurementValue target={right} targetUnit={targetUnit} decimalPlaces={decimalPlaces} />
        )}
      </div>
      {comparison && (
        <div role="status">
          <p>{outcomeLabels[comparison.status]}</p>
          <p>{comparison.reason}</p>
          <p>
            Numerical agreement does not establish one clinical event. Both source assertions remain
            available.
          </p>
        </div>
      )}
    </section>
  );
}
