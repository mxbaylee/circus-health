import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NoteDialog } from '../notes/NoteDialog';
import {
  sameMeasurementReference,
  validMeasurementPrecision,
  validMeasurementSemantics,
  type MeasurementSemantics,
} from '../../../shared/measurement';
import type {
  AcceptedMeasurement,
  MeasurementSemanticApplyRequest,
  MeasurementSemanticApplyResult,
  MeasurementSemanticPreview,
  MeasurementSemanticRequest,
} from '../../../shared/measurement-semantics';
import { MeasurementOriginal, type MeasurementDisplayTarget } from './MeasurementComparison';
import './measurement.css';
export interface MeasurementSettingsTarget extends MeasurementDisplayTarget {
  measurement: AcceptedMeasurement;
}
export interface MeasurementSettingsCallbacks {
  preview: (request: MeasurementSemanticRequest) => Promise<MeasurementSemanticPreview>;
  apply: (request: MeasurementSemanticApplyRequest) => Promise<MeasurementSemanticApplyResult>;
  onApplied: (result: MeasurementSemanticApplyResult) => void;
}
const fields = ['quantity', 'region', 'specimen', 'method', 'meaning'] as const;
const names = {
  quantity: 'Quantity being measured',
  region: 'Body region',
  specimen: 'Specimen',
  method: 'Measurement method',
  meaning: 'Result meaning',
};
const empty = { quantity: '', dimension: '', region: '', specimen: '', method: '', meaning: '' };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The measurement review could not be saved.';
function SettingsDialog({
  target,
  open,
  onOpenChange,
  returnFocusTo,
  preview,
  apply,
  onApplied,
}: MeasurementSettingsCallbacks & {
  target: MeasurementSettingsTarget;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  returnFocusTo: () => HTMLElement | null;
}) {
  const initial = target.measurement.binding;
  const [values, setValues] = useState({ ...empty, ...initial?.semantics });
  const [precisionMode, setPrecisionMode] = useState(initial?.precision?.basis || 'unknown');
  const [increment, setIncrement] = useState(initial?.precision?.increment || '');
  const [precisionEvidence, setPrecisionEvidence] = useState(initial?.precision?.evidence || '');
  const [reason, setReason] = useState(''),
    [revoke, setRevoke] = useState(false);
  const [review, setReview] = useState<{
    preview: MeasurementSemanticPreview;
    operationId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [retryPending, setRetryPending] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  const edit = (change: () => void) => {
    change();
    generation.current++;
    setReview(null);
    setError('');
    setSaved(false);
  };
  const proposedPrecision =
    precisionMode === 'unknown'
      ? null
      : {
          increment,
          basis: precisionMode as 'source_statement' | 'explicit_review',
          evidence: precisionEvidence,
        };
  const canPreview =
    !!reason.trim() &&
    (revoke ||
      (validMeasurementSemantics(values) &&
        (!proposedPrecision || validMeasurementPrecision(proposedPrecision))));
  const locked = busy || retryPending;
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!canPreview || locked) return;
    const request: MeasurementSemanticRequest = {
      kind: target.measurement.reference.kind as 'observation' | 'procedure',
      recordId: target.measurement.reference.recordId,
      semantics: revoke ? null : (values as MeasurementSemantics),
      precision: revoke ? null : proposedPrecision,
      reason,
    };
    const requestGeneration = ++generation.current;
    setBusy(true);
    setError('');
    setReview(null);
    try {
      const next = await preview(request);
      if (!alive.current || generation.current !== requestGeneration) return;
      if (!sameMeasurementReference(next.reference, target.measurement.reference))
        throw new Error('This measurement changed. Reload its details before reviewing again.');
      setReview({ preview: next, operationId: crypto.randomUUID() });
    } catch (error) {
      if (alive.current && generation.current === requestGeneration) setError(errorMessage(error));
    } finally {
      if (alive.current && generation.current === requestGeneration) setBusy(false);
    }
  }
  async function confirm() {
    if (!review || busy) return;
    const current = review;
    setBusy(true);
    setError('');
    const request: MeasurementSemanticApplyRequest = {
      ...current.preview.request,
      reference: current.preview.reference,
      rulesVersion: current.preview.rulesVersion,
      version: current.preview.version,
      previewToken: current.preview.previewToken,
      operationId: current.operationId,
    };
    try {
      const result = await apply(request);
      if (!alive.current) return;
      if (result.durability?.pending) {
        setRetryPending(true);
        setSaved(true);
        setError('The review is saved. Retry publishing its recovery copy.');
      } else {
        setRetryPending(false);
        setReview(null);
        onApplied(result);
        onOpenChange(false);
      }
    } catch (error) {
      if (!alive.current) return;
      const known =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500;
      if (known) {
        setReview(null);
        setRetryPending(false);
      } else setRetryPending(true);
      setError(errorMessage(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <NoteDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      returnFocusTo={returnFocusTo}
      title="Measurement comparison settings"
      description="Review what this one measurement means before converting or comparing it. Original values and clinical relationships remain unchanged."
      className="measurement-settings-dialog"
    >
      <form className="measurement-settings" onSubmit={prepare}>
        <h3>{target.title}</h3>
        <MeasurementOriginal target={target} />
        {target.measurement.semanticStatus === 'stale' && (
          <p role="status">
            The measurement changed. Its previous comparison settings need a new review.
          </p>
        )}
        <fieldset disabled={locked}>
          <legend>Reviewed meaning</legend>
          <label>
            Action
            <select
              value={revoke ? 'revoke' : 'review'}
              onChange={(e) => edit(() => setRevoke(e.target.value === 'revoke'))}
            >
              <option value="review">Review comparison settings</option>
              <option value="revoke">Withdraw comparison settings</option>
            </select>
          </label>
          {!revoke && (
            <>
              <p className="measurement-notice">
                Use known source meanings. Unknown fields keep measurements unconverted. Choose Not
                applicable only after reviewing that it applies.
              </p>
              <div className="measurement-fields">
                <label>
                  Unit family
                  <select
                    value={values.dimension}
                    onChange={(e) =>
                      edit(() => setValues({ ...values, dimension: e.target.value }))
                    }
                  >
                    <option value="">Choose a reviewed unit family</option>
                    <option value="mass">Mass</option>
                    <option value="length">Length</option>
                    <option value="volume">Volume</option>
                    <option value="mass_concentration">Mass concentration</option>
                    <option value="amount_concentration">Amount concentration</option>
                  </select>
                </label>
                {fields.map((field) => (
                  <div key={field}>
                    <label>
                      {names[field]}
                      <input
                        value={values[field]}
                        maxLength={200}
                        onChange={(e) =>
                          edit(() => setValues({ ...values, [field]: e.target.value }))
                        }
                      />
                    </label>
                    {['region', 'specimen', 'method'].includes(field) && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() =>
                          edit(() => setValues({ ...values, [field]: 'not_applicable' }))
                        }
                      >
                        Not applicable: {names[field].toLowerCase()}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <label>
                Known rounding precision
                <select
                  value={precisionMode}
                  onChange={(e) => edit(() => setPrecisionMode(e.target.value))}
                >
                  <option value="unknown">Unknown — keep source digits only</option>
                  <option value="source_statement">Explicit statement in the source</option>
                  <option value="explicit_review">Explicitly reviewed rounding increment</option>
                </select>
              </label>
              {precisionMode !== 'unknown' && (
                <div className="measurement-fields">
                  <label>
                    Rounding increment in the source unit
                    <input
                      value={increment}
                      onChange={(e) => edit(() => setIncrement(e.target.value))}
                      maxLength={256}
                    />
                  </label>
                  <label>
                    Evidence for this rounding increment
                    <textarea
                      value={precisionEvidence}
                      onChange={(e) => edit(() => setPrecisionEvidence(e.target.value))}
                      maxLength={2000}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <label>
            Reason for this review
            <textarea
              value={reason}
              onChange={(e) => edit(() => setReason(e.target.value))}
              maxLength={4000}
            />
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {retryPending && !saved && (
          <p role="status">
            The last reply was uncertain. Retry the same reviewed operation before making further
            changes.
          </p>
        )}
        {review && (
          <section className="measurement-review" aria-label="Measurement settings preview">
            <h4>
              {review.preview.request.semantics
                ? 'Review these comparison settings'
                : 'Withdraw these comparison settings'}
            </h4>
            <MeasurementOriginal
              target={{
                ...target,
                measurement: { ...target.measurement, source: review.preview.source },
                evidence: review.preview.evidence,
              }}
            />
            {review.preview.request.semantics && (
              <dl>
                {(['dimension', ...fields] as const).map((field) => (
                  <div key={field}>
                    <dt>{field === 'dimension' ? 'Unit family' : names[field]}</dt>
                    <dd>{review.preview.request.semantics![field]}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p>
              Rounding:{' '}
              {review.preview.request.precision
                ? `${review.preview.request.precision.increment} ${review.preview.source.unit || ''} · ${review.preview.request.precision.evidence}`
                : 'Unknown; source digits alone do not establish uncertainty.'}
            </p>
            <p>Reason: {review.preview.request.reason}</p>
            <p>
              Only this exact accepted measurement is affected. No source assertion is merged or
              hidden.
            </p>
          </section>
        )}
        <div className="measurement-actions">
          <button className="button secondary" type="submit" disabled={!canPreview || locked}>
            {busy && !review ? 'Preparing…' : 'Preview settings'}
          </button>
          {review && (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Saving…' : retryPending ? 'Retry Apply' : 'Apply reviewed settings'}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </NoteDialog>
  );
}
export function MeasurementSettingsAction({
  target,
  preview,
  apply,
  onApplied,
}: MeasurementSettingsCallbacks & { target: MeasurementSettingsTarget }) {
  const [open, setOpen] = useState(false),
    button = useRef<HTMLButtonElement>(null);
  const scope = JSON.stringify([target.measurement.reference, target.measurement.lastDecision?.id]);
  useEffect(() => {
    setOpen(false);
  }, [scope]);
  return (
    <>
      <button ref={button} type="button" className="button secondary" onClick={() => setOpen(true)}>
        Comparison settings
      </button>
      <SettingsDialog
        key={scope}
        target={target}
        open={open}
        onOpenChange={setOpen}
        returnFocusTo={() => button.current}
        preview={preview}
        apply={apply}
        onApplied={onApplied}
      />
    </>
  );
}
