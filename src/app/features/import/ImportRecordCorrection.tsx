import { useEffect, useId, useRef, useState } from 'react';
import type { Intake, IntakeClinicalMapping, IntakeReviewRecord } from '../../../shared/intake';
import { SourcePreview } from '../../components/SourceDialog';
import { intakeEvidencePage, intakeOriginal, reviewRecordTitle } from '../intake/ReviewWorkspace';

import { recordCorrectionFields, type MappingField } from './import-correction-fields';
import { recordReviewEditorDiagnostic } from '../../data/import-diagnostics';
import { clinicalDatePrecision } from '../../../shared/clinical-date';

const dateFields = new Set(['date', 'documentDate', 'startDate', 'endDate']);

export type CorrectionField = MappingField;

/** A field correction is a reviewed draft, never clinical acceptance. */
export function ImportRecordCorrection({
  intake,
  record,
  mapping,
  fields: initialFields,
  disabled,
  onUpdate,
  onClose,
  onDirtyChange,
}: {
  intake: Intake;
  record: IntakeReviewRecord;
  mapping: IntakeClinicalMapping;
  fields: CorrectionField[];
  disabled: boolean;
  onUpdate: (mapping: Partial<IntakeClinicalMapping>, reason?: string) => Promise<boolean>;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const id = useId();
  const [kindOverride, setKindOverride] = useState<IntakeClinicalMapping['kind']>();
  const kind = kindOverride || mapping.kind || record.kind;
  const kindChanged = kind !== (mapping.kind || record.kind);
  const fields = kindOverride ? recordCorrectionFields(kind, record.issues) : initialFields;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(mapping).filter(([, value]) => typeof value === 'string')),
  );
  const [reason, setReason] = useState('Correction of imported data');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editedFields = useRef(new Set<keyof IntakeClinicalMapping>());
  const [validation, setValidation] = useState('');
  const listener = useRef(onDirtyChange);
  listener.current = onDirtyChange;
  useEffect(() => {
    listener.current(dirty || saving);
  }, [dirty, saving]);
  useEffect(() => () => listener.current(false), []);
  const page = intakeEvidencePage(intake, record.evidence);
  const relevant =
    record.issues?.filter(
      (issue) =>
        ['uncertain_reading', 'date'].includes(issue.kind) &&
        issue.status !== 'resolved' &&
        fields.some((field) => field.key === issue.field),
    ) || [];
  // Blank fields are left unresolved. Updating one field must not acknowledge
  // or overwrite another field the person could not verify.
  const supplied = fields.filter(({ key }) => values[key]?.trim() && editedFields.current.has(key));
  const changed =
    kindChanged || supplied.some(({ key }) => values[key].trim() !== String(mapping[key] ?? ''));
  const valid =
    (!changed || (!!reason.trim() && reason.length <= 10000)) &&
    (supplied.length > 0 || kindChanged) &&
    supplied.every(({ key }) => {
      const value = values[key].trim();
      return (
        value.length <= 20000 &&
        (dateFields.has(key)
          ? clinicalDatePrecision(value) !== null
          : key !== 'valueText' || !/^[-+]?\d+\.$/.test(value))
      );
    });
  useEffect(() => {
    recordReviewEditorDiagnostic(
      record,
      mapping,
      fields.map((field) => field.key),
    );
  }, [record, mapping, fields, kind]);
  async function update() {
    if (disabled || saving || !valid) return;
    setSaving(true);
    setValidation('');
    try {
      const patch = {
        ...Object.fromEntries(supplied.map(({ key }) => [key, values[key].trim()])),
        ...(kindChanged ? { kind } : {}),
      };
      const saved = await (changed ? onUpdate(patch, reason.trim()) : onUpdate(patch));
      if (saved) {
        setDirty(false);
        listener.current(false);
        onClose();
      }
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : 'The correction could not be saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="import-field-correction"
      aria-label={`Correct ${reviewRecordTitle(record, mapping)}`}
    >
      <div className="import-correction-evidence">
        <SourcePreview file={intakeOriginal(intake)} initialPage={page} compact />
        {!page && intake.mimeType === 'application/pdf' && (
          <p className="helper-text">
            No unambiguous page was recorded. Use the page controls to find this result.
          </p>
        )}
      </div>
      <form
        className="import-correction-form"
        onSubmit={(event) => {
          event.preventDefault();
          void update();
        }}
      >
        <h3>{reviewRecordTitle(record, mapping)}</h3>
        <label>
          Record type
          <select
            aria-label="Record type"
            value={kind}
            disabled={disabled || saving}
            onChange={(event) => {
              setKindOverride(event.target.value as IntakeClinicalMapping['kind']);
              setDirty(true);
            }}
          >
            {!['observation', 'medication', 'procedure', 'document'].includes(kind) && (
              <option value={kind}>Not classified</option>
            )}
            <option value="observation">Test result</option>
            <option value="medication">Prescription</option>
            <option value="procedure">Procedure</option>
            <option value="document">Document</option>
          </select>
        </label>
        {(mapping.kind || record.kind) !== 'observation' && (
          <p className="helper-text">
            If this item is a test result, select Test result to enter its name, result and unit.
            Changing only its date does not change its record type.
          </p>
        )}
        {relevant.length > 0 && (
          <p className="helper-text">
            Update what you can verify. Leave unknown fields blank; they still need review before
            this record can be approved.
          </p>
        )}
        {fields.map((field) => {
          const value = values[field.key] || '';
          const issue = relevant.find((issue) => issue.field === field.key);
          const missing =
            kind === 'observation' &&
            ['testLabel', 'valueText'].includes(field.key) &&
            !value.trim();
          const malformed =
            !!value.trim() &&
            (dateFields.has(field.key)
              ? clinicalDatePrecision(value.trim()) === null
              : field.key === 'valueText' && /^[-+]?\d+\.$/.test(value.trim()));
          const edited = editedFields.current.has(field.key);
          const verified = edited && !!value.trim() && !malformed;
          const needsReview = missing || malformed || (!!issue && !verified);
          const hint = malformed
            ? dateFields.has(field.key)
              ? 'Enter a valid date.'
              : 'Enter a complete result.'
            : missing
              ? 'Required before confirming this record.'
              : issue && !verified
                ? issue.blocking
                  ? 'Check this reading against the original.'
                  : 'Optional: verify the date in the original, or leave it unknown.'
                : issue && edited && value.trim()
                  ? 'This field will be marked reviewed when you update.'
                  : '';
          const originalDate = String(mapping[field.key] || '');
          const datePrecision = clinicalDatePrecision(originalDate);
          // Do not truncate an existing month/year/timestamp into an invented day.
          const inputType = !dateFields.has(field.key)
            ? 'text'
            : !originalDate || datePrecision === 'day'
              ? 'date'
              : datePrecision === 'month'
                ? 'month'
                : 'text';
          return (
            <label key={field.key} className={needsReview ? 'needs-review' : undefined}>
              {field.label}
              {field.key === 'valueText' && mapping.unit ? ` (${mapping.unit})` : ''}
              {field.multiline ? (
                <textarea
                  aria-label={field.label}
                  value={values[field.key] || ''}
                  disabled={disabled || saving}
                  maxLength={20000}
                  onChange={(event) => {
                    editedFields.current.add(field.key);
                    setValues({ ...values, [field.key]: event.target.value });
                    setDirty(true);
                  }}
                />
              ) : (
                <input
                  type={inputType}
                  aria-invalid={malformed || missing}
                  aria-describedby={hint ? `${id}-${field.key}` : undefined}
                  aria-label={field.label}
                  value={values[field.key] || ''}
                  disabled={disabled || saving}
                  maxLength={20000}
                  onChange={(event) => {
                    editedFields.current.add(field.key);
                    setValues({ ...values, [field.key]: event.target.value });
                    setDirty(true);
                  }}
                />
              )}
              {hint && <small id={`${id}-${field.key}`}>{hint}</small>}
              {issue && !edited && !!value.trim() && !malformed && (
                <button
                  type="button"
                  className="text-link"
                  disabled={disabled || saving}
                  onClick={() => {
                    editedFields.current.add(field.key);
                    setDirty(true);
                    setValues({ ...values });
                  }}
                >
                  Verify {field.label.toLowerCase()}
                </button>
              )}
            </label>
          );
        })}
        {changed && (
          <label>
            Correction reason
            <input
              aria-label="Correction reason"
              value={reason}
              required
              maxLength={10000}
              disabled={disabled || saving}
              onChange={(event) => {
                setReason(event.target.value);
                setDirty(true);
              }}
            />
          </label>
        )}
        {validation && <p role="alert">{validation}</p>}
        <div className="intake-actions">
          <button className="button primary" type="submit" disabled={disabled || saving || !valid}>
            {saving ? 'Updating…' : 'Update'}
          </button>
          <button
            className="text-link"
            type="button"
            disabled={saving}
            onClick={() => {
              listener.current(false);
              onClose();
            }}
          >
            Close review
          </button>
        </div>
      </form>
    </section>
  );
}
