import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ClinicalRelationshipApplyInput,
  ClinicalRelationshipApplyResult,
  ClinicalRelationshipPreview,
  ClinicalRelationshipRequest,
  ClinicalRelationshipSide,
} from '../../../shared/clinical-relationships';
import { NoteDialog } from '../notes/NoteDialog';
import './clinical-relationship-dialog.css';

type RelationshipAction = ClinicalRelationshipRequest['action'];
type AmendmentMode = Extract<ClinicalRelationshipRequest, { action: 'provider_amendment' }>['mode'];
type DisplayMode = Extract<ClinicalRelationshipRequest, { action: 'display_preference' }>['mode'];
type Direction = Extract<
  ClinicalRelationshipRequest,
  { action: 'provider_amendment' }
>['direction'];

const valueText = (value: unknown) => {
  if (value === undefined || value === null || value === '') return 'Not recorded';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

function RelationshipSideReview({
  heading,
  side,
}: {
  heading: string;
  side: ClinicalRelationshipSide;
}) {
  const entries = Object.entries(side.mapping).sort(([left], [right]) => left.localeCompare(right));
  return (
    <section className="clinical-relationship-side">
      <h3>{heading}</h3>
      <p>
        <strong>{side.title}</strong>
        {side.date ? ` · ${side.date}` : ''}
      </p>
      <dl>
        {entries.map(([field, value]) => (
          <div key={field}>
            <dt>{field.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
            <dd>{valueText(value)}</dd>
          </div>
        ))}
      </dl>
      <h4>Retained originals</h4>
      {side.evidence.length ? (
        <ul>
          {side.evidence.map((item) => (
            <li key={`${item.sourceRecordId}-${item.sourceFileId}-${item.locator}`}>
              {item.label || 'Original'} · {item.locator || 'Location not recorded'} ·{' '}
              <a href={item.contentUrl} target="_blank" rel="noreferrer">
                Open original
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>No retained original is available.</p>
      )}
    </section>
  );
}

function effectText(preview: ClinicalRelationshipPreview) {
  if (preview.request.action === 'provider_amendment') {
    if (preview.request.mode === 'withdraw')
      return 'The saved provider-amendment decision will be withdrawn. The separate display choice, records, and originals remain unchanged.';
    const from =
      preview.effect.supersedes?.fromRecordId === preview.left.record.recordId
        ? preview.left.title
        : preview.right.title;
    const to =
      preview.effect.supersedes?.toRecordId === preview.left.record.recordId
        ? preview.left.title
        : preview.right.title;
    return `The review will record that ${to} is the provider’s amendment to ${from}. This does not choose how the two records are displayed.`;
  }
  if (preview.request.mode === 'prefer_left' || preview.request.mode === 'prefer_right') {
    const preferred =
      preview.effect.preferredRecordId === preview.left.record.recordId
        ? preview.left.title
        : preview.right.title;
    return `${preferred} will appear by default. Both records and originals remain available and count as one reviewed event.`;
  }
  if (preview.request.mode === 'show_both')
    return 'Both records will appear and count as one reviewed event. Both originals remain available.';
  if (preview.request.mode === 'undecided')
    return 'The relationship will remain marked as needing review. Both records remain visible and count separately.';
  return 'The saved display choice will be withdrawn. Both records remain visible and count separately.';
}

export function ClinicalRelationshipDialog({
  open,
  onOpenChange,
  left,
  right,
  previewRelationship,
  applyRelationship,
  onApplied,
  initialAction = 'display_preference',
  returnLabel = 'Close',
  onBack,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  left: ClinicalRelationshipSide;
  right: ClinicalRelationshipSide;
  previewRelationship: (
    request: ClinicalRelationshipRequest,
  ) => Promise<ClinicalRelationshipPreview>;
  applyRelationship: (
    request: ClinicalRelationshipApplyInput,
  ) => Promise<ClinicalRelationshipApplyResult>;
  onApplied: (result: ClinicalRelationshipApplyResult) => void | Promise<void>;
  initialAction?: RelationshipAction;
  returnLabel?: string;
  onBack?: () => void;
}) {
  const [action, setAction] = useState<RelationshipAction>(initialAction);
  const [amendmentMode, setAmendmentMode] = useState<AmendmentMode>('confirm');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('show_both');
  const [direction, setDirection] = useState<Direction>('left_to_right');
  const [evidenceKey, setEvidenceKey] = useState('');
  const [quote, setQuote] = useState('');
  const [reason, setReason] = useState('');
  const [attested, setAttested] = useState(false);
  const [preview, setPreview] = useState<ClinicalRelationshipPreview | null>(null);
  const [result, setResult] = useState<ClinicalRelationshipApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operationId = useRef('');

  useEffect(() => {
    if (!open) return;
    setAction(initialAction);
    setAmendmentMode('confirm');
    setDisplayMode('show_both');
    setDirection('left_to_right');
    setEvidenceKey('');
    setQuote('');
    setReason('');
    setAttested(false);
    setPreview(null);
    setResult(null);
    setBusy(false);
    setError('');
    operationId.current = '';
  }, [initialAction, left.record.recordId, open, right.record.recordId]);

  const amendedSide = direction === 'left_to_right' ? right : left;
  const evidenceChoices = amendedSide.evidence;
  const selectedEvidence = evidenceChoices.find(
    (item) => `${item.sourceFileId}\u0000${item.locator}` === evidenceKey,
  );
  const needsAttestation =
    (action === 'provider_amendment' && amendmentMode === 'confirm') ||
    (action === 'display_preference' &&
      ['prefer_left', 'prefer_right', 'show_both'].includes(displayMode));
  const ready =
    reason.trim() &&
    (!needsAttestation || attested) &&
    (action !== 'provider_amendment' ||
      amendmentMode !== 'confirm' ||
      (selectedEvidence && quote.trim()));

  const buildRequest = (): ClinicalRelationshipRequest => {
    const pair = { left: left.record, right: right.record, reason: reason.trim() };
    if (action === 'provider_amendment') {
      return {
        ...pair,
        action,
        mode: amendmentMode,
        direction,
        ...(amendmentMode === 'confirm'
          ? {
              attestation: 'reviewed_provider_amendment' as const,
              evidence: {
                sourceFileId: selectedEvidence!.sourceFileId,
                locator: selectedEvidence!.locator,
                quote: quote.trim(),
              },
            }
          : {}),
      };
    }
    return {
      ...pair,
      action,
      mode: displayMode,
      ...(['prefer_left', 'prefer_right', 'show_both'].includes(displayMode)
        ? { attestation: 'same_recorded_event' as const }
        : {}),
    };
  };

  const requestPreview = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await previewRelationship(buildRequest());
      setPreview(next);
      operationId.current = crypto.randomUUID();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The relationship preview could not load.');
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
      const applied = await applyRelationship({
        request: preview.request,
        scope: preview.scope,
        version: preview.version,
        previewToken: preview.previewToken,
        operationId: operationId.current,
      });
      setResult(applied);
      try {
        await onApplied(applied);
      } catch {
        setError(
          'The relationship was saved, but this view could not refresh. Reopen it to review the current records.',
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The relationship could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <NoteDialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={
        result
          ? 'Relationship saved'
          : preview
            ? 'Review relationship decision'
            : 'Review record relationship'
      }
      description={
        result
          ? 'The reviewed relationship and exact originals were added to history.'
          : preview
            ? 'Review both records, retained originals, and the resulting behavior before applying.'
            : 'Choose whether the provider amended one record or how two records of one event should be displayed.'
      }
      className="clinical-relationship-dialog"
      onBack={result ? undefined : preview ? () => setPreview(null) : onBack}
      backLabel={preview ? 'Back' : 'Back to records'}
      backDisabled={busy}
    >
      {error && <p role="alert">{error}</p>}
      {result ? (
        <section aria-label="Saved relationship">
          <p>
            The decision is saved in review history. Both saved records and their retained originals
            remain available.
          </p>
          {result.durability.pending && (
            <p role="status">The decision is saved and durable publication is still finishing.</p>
          )}
          <div className="clinical-relationship-links">
            <Link to={preview!.left.navigation.appUrl}>Open {preview!.left.title}</Link>
            <Link to={preview!.right.navigation.appUrl}>Open {preview!.right.title}</Link>
          </div>
          <div className="note-dialog-actions">
            <button type="button" className="button primary" onClick={() => onOpenChange(false)}>
              {returnLabel}
            </button>
          </div>
        </section>
      ) : preview ? (
        <>
          <section className="clinical-relationship-effect" aria-label="Relationship effect">
            <h3>What will change</h3>
            <p>{effectText(preview)}</p>
            <p>
              <strong>Review reason:</strong> {preview.request.reason}
            </p>
            {preview.request.action === 'provider_amendment' && preview.request.evidence && (
              <blockquote>
                “{preview.request.evidence.quote}” · {preview.request.evidence.locator}
              </blockquote>
            )}
          </section>
          <div
            className="clinical-relationship-pair"
            role="region"
            aria-label="Reviewed record pair"
          >
            <RelationshipSideReview heading="Record A" side={preview.left} />
            <RelationshipSideReview heading="Record B" side={preview.right} />
          </div>
          <p className="helper-text">
            The preview is scoped to these exact record versions and originals. A later record or
            evidence change requires a fresh review.
          </p>
          <div className="note-dialog-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => void apply()}
              disabled={busy}
            >
              {busy ? 'Applying decision…' : error ? 'Retry decision' : 'Apply reviewed decision'}
            </button>
          </div>
        </>
      ) : (
        <form
          className="clinical-relationship-form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestPreview();
          }}
        >
          <div
            className="clinical-relationship-pair"
            role="region"
            aria-label="Records being reviewed"
          >
            <RelationshipSideReview heading="Record A" side={left} />
            <RelationshipSideReview heading="Record B" side={right} />
          </div>
          <fieldset className="clinical-relationship-action">
            <legend>What did you establish from the originals?</legend>
            <label>
              <input
                type="radio"
                name="relationship-action"
                checked={action === 'display_preference'}
                onChange={() => {
                  setAction('display_preference');
                  setAttested(false);
                }}
              />
              <span>
                <strong>Same recorded event display</strong>
                <small>
                  Choose how two records of one event appear without changing either record.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="relationship-action"
                checked={action === 'provider_amendment'}
                onChange={() => {
                  setAction('provider_amendment');
                  setAttested(false);
                }}
              />
              <span>
                <strong>Provider issued an amendment</strong>
                <small>
                  Use only when the retained original explicitly identifies the amendment.
                </small>
              </span>
            </label>
          </fieldset>

          {action === 'display_preference' ? (
            <label>
              Display decision
              <select
                value={displayMode}
                disabled={busy}
                onChange={(event) => {
                  setDisplayMode(event.target.value as DisplayMode);
                  setAttested(false);
                }}
              >
                <option value="show_both">Show both records for one reviewed event</option>
                <option value="prefer_left">Show {left.title} by default</option>
                <option value="prefer_right">Show {right.title} by default</option>
                <option value="undecided">Mark as needing review</option>
                <option value="withdraw">Remove the saved display choice</option>
              </select>
            </label>
          ) : (
            <>
              <label>
                Amendment decision
                <select
                  value={amendmentMode}
                  disabled={busy}
                  onChange={(event) => {
                    setAmendmentMode(event.target.value as AmendmentMode);
                    setAttested(false);
                  }}
                >
                  <option value="confirm">Confirm a provider amendment</option>
                  <option value="withdraw">Withdraw the saved amendment decision</option>
                </select>
              </label>
              <label>
                Provider’s sequence
                <select
                  value={direction}
                  disabled={busy}
                  onChange={(event) => {
                    setDirection(event.target.value as Direction);
                    setEvidenceKey('');
                    setQuote('');
                    setAttested(false);
                  }}
                >
                  <option value="left_to_right">
                    {left.title} followed by amendment {right.title}
                  </option>
                  <option value="right_to_left">
                    {right.title} followed by amendment {left.title}
                  </option>
                </select>
              </label>
              {amendmentMode === 'confirm' && (
                <>
                  <label>
                    Original containing the provider amendment
                    <select
                      value={evidenceKey}
                      disabled={busy}
                      onChange={(event) => setEvidenceKey(event.target.value)}
                    >
                      <option value="">Choose an exact original and location</option>
                      {evidenceChoices.map((item) => (
                        <option
                          key={`${item.sourceRecordId}-${item.sourceFileId}-${item.locator}`}
                          value={`${item.sourceFileId}\u0000${item.locator}`}
                        >
                          {item.label || 'Original'} · {item.locator || 'Location not recorded'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedEvidence && (
                    <p>
                      <a href={selectedEvidence.contentUrl} target="_blank" rel="noreferrer">
                        Open the selected original
                      </a>
                    </p>
                  )}
                  <label>
                    Exact excerpt showing the amendment
                    <textarea
                      rows={3}
                      value={quote}
                      disabled={busy}
                      onChange={(event) => setQuote(event.target.value)}
                    />
                  </label>
                </>
              )}
            </>
          )}

          <label>
            Review reason
            <textarea
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="What do the retained originals establish?"
            />
          </label>

          {needsAttestation && (
            <label className="clinical-relationship-attestation">
              <input
                type="checkbox"
                checked={attested}
                disabled={busy}
                onChange={(event) => setAttested(event.target.checked)}
              />
              <span>
                {action === 'provider_amendment'
                  ? `I reviewed the retained original for ${amendedSide.title} and confirm that it explicitly presents a provider amendment.`
                  : 'I reviewed both retained originals and confirm that these records describe the same recorded event.'}
              </span>
            </label>
          )}

          <p className="helper-text">
            Provider amendment and display are separate decisions. Both records and originals stay
            in history.
          </p>
          <div className="note-dialog-actions">
            <button type="submit" className="button primary" disabled={busy || !ready}>
              {busy ? 'Preparing preview…' : 'Review decision'}
            </button>
          </div>
        </form>
      )}
    </NoteDialog>
  );
}
