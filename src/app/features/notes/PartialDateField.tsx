import { useEffect, useId, useRef, useState } from 'react';
import {
  changeDatePrecision,
  compatibleDateDetail,
  datePrecision,
  pickerValue,
  type DatePrecision,
} from './date-precision';
import { validPartialDate } from './person-fields';

export function PartialDateField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [precision, setPrecision] = useState<DatePrecision>(() => datePrecision(value));
  const [remembered, setRemembered] = useState('');
  const emittedValue = useRef<string | null>(null);
  useEffect(() => {
    // A locally chosen Exact mode may still hold only a recorded month. Keep
    // that selection rather than inventing a day or reverting the dropdown.
    if (emittedValue.current !== value && value && validPartialDate(value))
      setPrecision(datePrecision(value));
    emittedValue.current = null;
    setRemembered((previous) => compatibleDateDetail(previous, value));
  }, [value]);
  const displayedValue = pickerValue(value, precision);
  const awaitingPrecision = Boolean(value && !displayedValue);
  function choosePrecision(next: DatePrecision) {
    setPrecision(next);
    const changed = changeDatePrecision(value, next, remembered);
    setRemembered(changed.remembered);
    if (changed.value !== value) {
      emittedValue.current = changed.value;
      onChange(changed.value);
    }
  }
  return (
    <fieldset className="note-field partial-date-field" disabled={disabled}>
      <legend>{label}</legend>
      <div className="partial-date-controls">
        <select
          aria-label={`${label} precision`}
          value={precision}
          onChange={(event) => choosePrecision(event.target.value as DatePrecision)}
        >
          <option value="unknown">Unknown</option>
          <option value="year">Year only</option>
          <option value="month">Month and year</option>
          <option value="day">Exact date</option>
        </select>
        <input
          id={id}
          aria-label={label}
          aria-describedby={`${id}-help`}
          aria-invalid={!validPartialDate(value)}
          type={precision === 'year' ? 'text' : precision === 'month' ? 'month' : 'date'}
          inputMode={precision === 'year' ? 'numeric' : undefined}
          maxLength={precision === 'year' ? 4 : undefined}
          placeholder={precision === 'year' ? 'YYYY' : undefined}
          value={displayedValue}
          onChange={(event) => {
            if (event.currentTarget.validity.badInput) return;
            const next = event.currentTarget.value;
            if (precision === 'unknown' && next) setPrecision('day');
            // Once a user changes or clears the date prefix, old month/day parts
            // must not reappear even if they later type the original prefix again.
            setRemembered((previous) => compatibleDateDetail(previous, next));
            emittedValue.current = next;
            onChange(next);
          }}
        />
      </div>
      <small id={`${id}-help`}>
        {remembered && remembered !== value
          ? `More detail kept for this edit: ${remembered}. Choose ${datePrecision(remembered) === 'day' ? 'Exact date' : 'Month and year'} to restore it. `
          : ''}
        {!validPartialDate(value)
          ? 'Enter a valid year or date to resume saving.'
          : awaitingPrecision
            ? `Recorded: ${value}. Kept until you choose a more precise date.`
            : 'Use only the precision you know. Leave blank or choose Unknown when not known.'}
      </small>
    </fieldset>
  );
}

export function DeathDateField({
  lifeStatus,
  ...props
}: { lifeStatus: string } & Parameters<typeof PartialDateField>[0]) {
  // Visibility never changes the stored value; toggling back restores its exact precision.
  return lifeStatus === 'deceased' ? <PartialDateField {...props} /> : null;
}
