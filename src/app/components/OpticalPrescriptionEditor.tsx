import type { OpticalEye, OpticalPrescription, OpticalValue } from '../../shared/vision';

type ValueKey = 'sph' | 'cyl' | 'axis' | 'add' | 'prism' | 'pd' | 'baseCurve' | 'diameter';
const fields: [ValueKey, string][] = [
  ['sph', 'SPH'],
  ['cyl', 'CYL'],
  ['axis', 'Axis'],
  ['add', 'ADD'],
  ['prism', 'Prism'],
  ['pd', 'PD'],
  ['baseCurve', 'Base curve'],
  ['diameter', 'Diameter'],
];

function LiteralInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="text"
        maxLength={10000}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ValueEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: OpticalValue;
  onChange: (value: OpticalValue | undefined) => void;
}) {
  return (
    <div className="detail-grid">
      <LiteralInput
        label={`${label} value, as written`}
        value={value?.valueText}
        onChange={(valueText) => onChange({ ...value, valueText })}
      />
      <LiteralInput
        label={`${label} unit, if stated`}
        value={value?.unit}
        onChange={(unit) => {
          const next: OpticalValue = { ...value, valueText: value?.valueText ?? '' };
          if (unit === '') delete next.unit;
          else next.unit = unit;
          onChange(next);
        }}
      />
      {value !== undefined && (
        <button type="button" onClick={() => onChange(undefined)}>
          Remove {label}
        </button>
      )}
    </div>
  );
}

/** A literal draft editor: no numeric coercion, date parsing, or inferred units. */
export function OpticalPrescriptionEditor({
  prescription,
  onChange,
  disabled = false,
}: {
  prescription: OpticalPrescription;
  onChange: (next: OpticalPrescription | null) => void;
  disabled?: boolean;
}) {
  const change = (next: OpticalPrescription | null) => {
    if (!disabled) onChange(next);
  };
  const changeEye = (index: number, next: OpticalEye) =>
    change({
      ...prescription,
      eyes: prescription.eyes.map((eye, i) => (i === index ? next : eye)),
    });
  const changeOptionalLiteral = (key: 'typeText' | 'statusText', value: string) => {
    const next = { ...prescription };
    if (value === '') delete next[key];
    else next[key] = value;
    change(next);
  };
  return (
    <fieldset disabled={disabled}>
      <legend>Optical prescription corrections</legend>
      <p>Copy values and dates exactly as written. Leave units blank when unstated.</p>
      <label>
        Prescription type
        <select
          value={prescription.type}
          onChange={(event) =>
            change({
              ...prescription,
              type: event.target.value as OpticalPrescription['type'],
            })
          }
        >
          <option value="unknown">Unknown</option>
          <option value="spectacle">Spectacle</option>
          <option value="contact_lens">Contact lens</option>
        </select>
      </label>
      <LiteralInput
        label="Prescription type, as written"
        value={prescription.typeText}
        onChange={(typeText) => changeOptionalLiteral('typeText', typeText)}
      />
      <LiteralInput
        label="Prescription status, as written"
        value={prescription.statusText}
        onChange={(statusText) => changeOptionalLiteral('statusText', statusText)}
      />
      <LiteralInput
        label="Prescribed date, as written"
        value={prescription.prescribedDateText}
        onChange={(prescribedDateText) => change({ ...prescription, prescribedDateText })}
      />
      <LiteralInput
        label="Expiration date, as written"
        value={prescription.expiresDateText}
        onChange={(expiresDateText) => change({ ...prescription, expiresDateText })}
      />
      {prescription.eyes.map((eye, index) => {
        const editValue = (key: ValueKey, value: OpticalValue | undefined) => {
          const next = { ...eye };
          if (value === undefined) delete next[key];
          else next[key] = value;
          changeEye(index, next);
        };
        return (
          <fieldset key={index}>
            <legend>Eye entry {index + 1}</legend>
            <label>
              Side
              <select
                value={eye.side}
                onChange={(event) =>
                  changeEye(index, {
                    ...eye,
                    side: event.target.value as OpticalEye['side'],
                  })
                }
              >
                <option value="unknown">Unknown</option>
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="both">Both</option>
              </select>
            </label>
            <LiteralInput
              label="Side label, as written"
              value={eye.sideText}
              onChange={(sideText) => changeEye(index, { ...eye, sideText })}
            />
            {fields
              .filter(([key]) => eye[key] !== undefined)
              .map(([key, label]) => (
                <ValueEditor
                  key={key}
                  label={label}
                  value={eye[key]}
                  onChange={(value) => editValue(key, value)}
                />
              ))}
            {fields.some(([key]) => eye[key] === undefined) && (
              <details>
                <summary>Add other optical values</summary>
                {fields
                  .filter(([key]) => eye[key] === undefined)
                  .map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => editValue(key, { valueText: '' })}
                    >
                      Add {label}
                    </button>
                  ))}
              </details>
            )}
            <LiteralInput
              label="Eye notes, as written"
              value={eye.notes}
              onChange={(notes) => changeEye(index, { ...eye, notes })}
            />
            <button
              type="button"
              onClick={() =>
                change({ ...prescription, eyes: prescription.eyes.filter((_, i) => i !== index) })
              }
            >
              Remove eye entry {index + 1}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={prescription.eyes.length >= 20}
        onClick={() => {
          if (prescription.eyes.length < 20)
            change({ ...prescription, eyes: [...prescription.eyes, { side: 'unknown' }] });
        }}
      >
        Add eye entry
      </button>
      {prescription.pd !== undefined ? (
        <ValueEditor
          label="PD (not side specific)"
          value={prescription.pd}
          onChange={(pd) => {
            const next = { ...prescription };
            if (pd === undefined) delete next.pd;
            else next.pd = pd;
            change(next);
          }}
        />
      ) : (
        <button type="button" onClick={() => change({ ...prescription, pd: { valueText: '' } })}>
          Add PD (not side specific)
        </button>
      )}
      <LiteralInput
        label="Prescription notes, as written"
        value={prescription.notes}
        onChange={(notes) => change({ ...prescription, notes })}
      />
      <button type="button" onClick={() => change(null)}>
        Remove optical mapping
      </button>
    </fieldset>
  );
}
