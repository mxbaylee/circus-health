import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IntakeClinicalMapping } from '../../../shared/intake';
import type {
  CorrectableClinicalKind,
  CorrectionSupportingReference,
  RecordCorrectionApplyRequest,
  RecordCorrectionApplyResult,
  RecordCorrectionPreview,
  RecordCorrectionRequest,
} from '../../../shared/record-correction';
import { NoteDialog } from '../notes/NoteDialog';

type CorrectionField = {
  key: keyof IntakeClinicalMapping;
  label: string;
  multiline?: boolean;
};

const commonFields: CorrectionField[] = [
  { key: 'date', label: 'Date' },
  { key: 'status', label: 'Status' },
  { key: 'eventKind', label: 'Event type' },
];
export const fieldsByKind: Record<CorrectableClinicalKind, CorrectionField[]> = {
  observation: [
    ...commonFields,
    { key: 'testLabel', label: 'Measurement' },
    { key: 'observationCategory', label: 'Category' },
    { key: 'valueText', label: 'Result' },
    { key: 'unit', label: 'Unit' },
    { key: 'referenceText', label: 'Reference range' },
    { key: 'code', label: 'Code' },
    { key: 'codeSystem', label: 'Code system' },
    { key: 'specimen', label: 'Specimen' },
    { key: 'method', label: 'Method' },
  ],
  medication: [
    ...commonFields,
    { key: 'medicationName', label: 'Medication' },
    { key: 'doseText', label: 'Dose' },
    { key: 'route', label: 'Route' },
    { key: 'frequency', label: 'Frequency' },
    { key: 'medicationKind', label: 'Medication event' },
    { key: 'dateRole', label: 'Date meaning' },
    { key: 'startDate', label: 'Start date' },
    { key: 'endDate', label: 'End date' },
  ],
  procedure: [
    ...commonFields,
    { key: 'procedureLabel', label: 'Procedure' },
    { key: 'procedureCategory', label: 'Procedure category' },
  ],
  document: [
    ...commonFields,
    { key: 'documentTitle', label: 'Document title' },
    { key: 'documentDate', label: 'Document date' },
    { key: 'documentCategory', label: 'Document category' },
    { key: 'visitSpecialty', label: 'Visit specialty' },
    { key: 'text', label: 'Document text', multiline: true },
  ],
};

export interface RecordCorrectionTarget {
  kind: CorrectableClinicalKind;
  recordId: string;
  title: string;
  mapping: IntakeClinicalMapping;
}

export interface CorrectionSupportingChoice {
  reference: CorrectionSupportingReference;
  label: string;
  locator: string;
  contentUrl?: string;
}

const shown = (value: unknown) => {
  if (value === undefined || value === null || value === '') return 'Not recorded';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

export function RecordCorrectionDialog({
  open,
  onOpenChange,
  target,
  supporting,
  previewCorrection,
  applyCorrection,
  onApplied,
  returnLabel = 'Close',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: RecordCorrectionTarget;
  supporting?: CorrectionSupportingChoice;
  previewCorrection: (request: RecordCorrectionRequest) => Promise<RecordCorrectionPreview>;
  applyCorrection: (request: RecordCorrectionApplyRequest) => Promise<RecordCorrectionApplyResult>;
  onApplied: (result: RecordCorrectionApplyResult) => void | Promise<void>;
  returnLabel?: string;
}) {
  const [kind, setKind] = useState(target.kind);
  const [edited, setEdited] = useState<IntakeClinicalMapping>(target.mapping);
  const [reason, setReason] = useState('');
  const [includeSupporting, setIncludeSupporting] = useState(false);
  const [preview, setPreview] = useState<RecordCorrectionPreview | null>(null);
  const [result, setResult] = useState<RecordCorrectionApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operationId = useRef('');

  useEffect(() => {
    if (!open) return;
    setKind(target.kind);
    setEdited(target.mapping);
    setReason('');
    setIncludeSupporting(false);
    setPreview(null);
    setResult(null);
    setBusy(false);
    setError('');
    operationId.current = '';
  }, [open, target.kind, target.recordId]);

  const set = (): Partial<IntakeClinicalMapping> => {
    const changes: Partial<IntakeClinicalMapping> = {};
    if (kind !== target.kind) changes.kind = kind;
    for (const { key } of fieldsByKind[kind]) {
      const value = edited[key];
      if (JSON.stringify(value) !== JSON.stringify(target.mapping[key]))
        (changes as Record<string, unknown>)[key] = value;
    }
    return changes;
  };

  const requestPreview = async () => {
    const changes = set();
    if (!Object.keys(changes).length || !reason.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await previewCorrection({
        kind: target.kind,
        recordId: target.recordId,
        set: changes,
        reason: reason.trim(),
        ...(supporting && includeSupporting ? { supportingEvidence: [supporting.reference] } : {}),
      });
      setPreview(next);
      operationId.current = crypto.randomUUID();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The correction preview could not load.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview || busy) return;
    if (!operationId.current) operationId.current = crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      // Apply the server-normalized request exactly as previewed. Keep the operation
      // ID stable so a lost response can be retried without applying twice.
      const applied = await applyCorrection({
        ...preview.request,
        operationId: operationId.current,
        version: preview.version,
        previewToken: preview.previewToken,
      });
      setResult(applied);
      try {
        await onApplied(applied);
      } catch {
        setError(
          'The correction was saved, but this comparison could not refresh. Reopen it to review the current versions.',
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The correction could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const changedFields = preview
    ? preview.editableFields.filter(
        (field) => JSON.stringify(preview.before[field]) !== JSON.stringify(preview.after[field]),
      )
    : [];

  return (
    <NoteDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={result ? 'Correction saved' : preview ? 'Review correction' : 'Correct saved record'}
      description={
        result
          ? 'The reviewed correction and its evidence were added to record history.'
          : preview
            ? 'Compare the current saved fields with the proposed correction before applying it.'
            : 'Correct the app’s saved interpretation while keeping the original source unchanged.'
      }
      className="record-correction-dialog"
      onBack={preview && !result ? () => setPreview(null) : undefined}
      backDisabled={busy}
    >
      {error && <p role="alert">{error}</p>}
      {result ? (
        <section className="record-correction-complete" aria-label="Saved correction">
          <p>
            The original source is unchanged. The before/after correction, reason, and reviewed
            supporting originals are retained in history.
          </p>
          {result.durability?.pending && (
            <p role="status">The correction is saved and durable publication is still finishing.</p>
          )}
          <div className="note-dialog-actions">
            <button type="button" className="button primary" onClick={() => onOpenChange(false)}>
              {returnLabel}
            </button>
          </div>
        </section>
      ) : preview ? (
        <>
          <section aria-label="Correction before and after">
            <h3>{target.title}</h3>
            <div className="record-correction-diff">
              <section>
                <h4>Currently saved</h4>
                <dl>
                  {changedFields.map((field) => (
                    <div key={field}>
                      <dt>
                        {fieldsByKind[kind].find((item) => item.key === field)?.label || field}
                      </dt>
                      <dd>{shown(preview.before[field])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h4>After correction</h4>
                <dl>
                  {changedFields.map((field) => (
                    <div key={field}>
                      <dt>
                        {fieldsByKind[kind].find((item) => item.key === field)?.label || field}
                      </dt>
                      <dd>{shown(preview.after[field])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          </section>
          <section className="record-correction-evidence" aria-label="Correction evidence">
            <h3>Reason and originals</h3>
            <p>{preview.request.reason}</p>
            <h4>Original evidence for the saved record</h4>
            {preview.evidence.map((item, index) => (
              <p key={`${item.sourceFileId}-${index}`}>
                {item.acquiringSource || 'Saved original'} ·{' '}
                <a href={item.contentUrl} target="_blank" rel="noreferrer">
                  Open original
                </a>
              </p>
            ))}
            {!!preview.supportingEvidence.length && (
              <>
                <h4>Incoming original supporting this correction</h4>
                {preview.supportingEvidence.map((item) => (
                  <p key={`${item.originalSourceFileId}-${item.memberId || ''}`}>
                    {item.filename} · {item.locator} ·{' '}
                    <a href={item.contentUrl} target="_blank" rel="noreferrer">
                      Open original
                    </a>
                  </p>
                ))}
              </>
            )}
            <p>
              <Link to={preview.destination.appUrl}>View current record and history</Link>
            </p>
          </section>
          <div className="note-dialog-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => void apply()}
              disabled={busy}
            >
              {busy
                ? 'Applying correction…'
                : error
                  ? 'Retry correction'
                  : 'Apply reviewed correction'}
            </button>
          </div>
        </>
      ) : (
        <form
          className="record-correction-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPreview();
          }}
        >
          <p>
            <strong>{target.title}</strong>
          </p>
          <label>
            Saved record type
            <select
              value={kind}
              disabled={busy}
              onChange={(event) => setKind(event.target.value as CorrectableClinicalKind)}
            >
              {(target.kind === 'medication'
                ? (['medication'] as CorrectableClinicalKind[])
                : (['observation', 'procedure', 'document'] as CorrectableClinicalKind[])
              ).map((value) => (
                <option key={value} value={value}>
                  {value === 'observation'
                    ? 'Measurement'
                    : value === 'procedure'
                      ? 'Procedure'
                      : value === 'document'
                        ? 'Provider document'
                        : 'Medication'}
                </option>
              ))}
            </select>
          </label>
          <div className="record-correction-fields">
            {fieldsByKind[kind].map((field) => (
              <label key={field.key}>
                {field.label}
                {field.multiline ? (
                  <textarea
                    rows={5}
                    value={String(edited[field.key] || '')}
                    disabled={busy}
                    onChange={(event) =>
                      setEdited((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                ) : (
                  <input
                    value={String(edited[field.key] || '')}
                    disabled={busy}
                    onChange={(event) =>
                      setEdited((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <label>
            Why this saved interpretation is being corrected
            <textarea
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What does the original evidence establish?"
            />
          </label>
          {supporting && (
            <label className="record-correction-support">
              <input
                type="checkbox"
                checked={includeSupporting}
                disabled={busy}
                onChange={(event) => setIncludeSupporting(event.target.checked)}
              />
              <span>
                Use the incoming original as supporting evidence: {supporting.label} ·{' '}
                {supporting.locator}
                {supporting.contentUrl && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={supporting.contentUrl} target="_blank" rel="noreferrer">
                      Open original
                    </a>
                  </>
                )}
              </span>
            </label>
          )}
          <p className="helper-text">
            The correction adds reviewed history. It does not change the original file or accept the
            incoming draft.
          </p>
          <div className="note-dialog-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !reason.trim() || !Object.keys(set()).length}
            >
              {busy ? 'Preparing preview…' : 'Review before and after'}
            </button>
          </div>
        </form>
      )}
    </NoteDialog>
  );
}
