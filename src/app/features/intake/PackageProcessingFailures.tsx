import { useEffect, useState } from 'react';
import type { IntakePackageFailure } from '../../../shared/intake';
import type {
  IntakePackageFailureField,
  IntakePackageFailureFieldFragment,
  IntakePackageFailureFieldReference,
  IntakePackageFailurePage,
} from '../../../shared/intake-summary';
import { api } from '../../data/api';

type FailureDisplay = IntakePackageFailurePage['entries'][number]['failure'];
type FailureReferences = IntakePackageFailurePage['entries'][number]['fieldReferences'];

function FailureLocation({
  label,
  reference,
}: {
  label: string;
  reference: IntakePackageFailureFieldReference;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [page, setPage] = useState<IntakePackageFailureFieldFragment | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setCursor(undefined);
    setPage(null);
  }, [reference.key, reference.field, reference.pins.logicalRoot]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(null);
    void api<IntakePackageFailureFieldFragment>(
      `/intakes/${encodeURIComponent(reference.intakeId)}/package-failure-fragment`,
      {
        method: 'POST',
        body: JSON.stringify({ reference, cursor, limit: 32768 }),
      },
    )
      .then((result) => {
        if (cancelled) return;
        if (JSON.stringify(result.data.reference) !== JSON.stringify(reference))
          throw Error('The unfinished operation changed. Refresh this file.');
        setPage(result.data);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'The location could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cursor, reference]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {loading && <p role="status">Loading location…</p>}
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <pre className="intake-member-literal">{page.text}</pre>
          <button type="button" disabled={!cursor} onClick={() => setCursor(undefined)}>
            First
          </button>
          <button
            type="button"
            disabled={!page.nextCursor}
            onClick={() => setCursor(page.nextCursor ?? undefined)}
          >
            Next
          </button>
        </>
      )}
    </details>
  );
}

export function PackageProcessingFailures({
  failures,
  busy,
  onRetry,
  page,
  onNext,
  onFirst,
}: {
  failures?: Record<string, IntakePackageFailure>;
  page?: IntakePackageFailurePage;
  onNext?: () => void;
  onFirst?: () => void;
  busy: boolean;
  onRetry: (failure: Pick<IntakePackageFailure, 'memberId' | 'retryAction'>) => void;
}) {
  const [offset, setOffset] = useState(0);
  const entries: [string, FailureDisplay, FailureReferences?][] = page
    ? page.entries.map(({ key, failure, fieldReferences }) => [key, failure, fieldReferences])
    : Object.entries(failures || {}).map(([key, failure]) => [key, failure]);
  const total = page?.total ?? entries.length;
  if (!entries.length) return null;
  const start = Math.min(offset, Math.floor((entries.length - 1) / 50) * 50);
  return (
    <section aria-label="Unfinished package processing">
      <h4>Processing must wait</h4>
      <p>
        {total} unfinished operations. The original remains available; this scope is incomplete and
        has not accepted clinical records.
      </p>
      <ul>
        {entries.slice(start, start + 50).map(([key, failure, references]) => (
          <li key={key}>
            <strong>
              {failure.filename ||
                (references?.filename ? 'Retained member filename' : failure.originalFilename) ||
                'Retained original'}
            </strong>
            {(
              Object.entries(references || {}) as [
                IntakePackageFailureField,
                IntakePackageFailureFieldReference,
              ][]
            ).map(([field, reference]) => (
              <FailureLocation
                key={field}
                label={
                  field === 'originalFilename'
                    ? 'Full original filename'
                    : field === 'filename'
                      ? 'Full member filename'
                      : 'Full member location'
                }
                reference={reference}
              />
            ))}
            {failure.locator && <p>{failure.locator}</p>}
            <p>{failure.detail}</p>
            <a className="text-link" href={failure.contentUrl} target="_blank" rel="noreferrer">
              Open original{failure.originalFilename ? `: ${failure.originalFilename}` : ''}
            </a>{' '}
            <button className="text-link" disabled={busy} onClick={() => onRetry(failure)}>
              {failure.retryAction === 'inventory'
                ? 'Retry inventory'
                : failure.retryAction === 'read_structure'
                  ? 'Retry structure'
                  : 'Retry member'}
            </button>
          </li>
        ))}
      </ul>
      {page && (onFirst || !page.complete) && (
        <div className="intake-actions">
          <button disabled={busy || !onFirst} onClick={onFirst}>
            First unfinished operations
          </button>
          <span>
            Showing {entries.length} of {total}
          </span>
          <button disabled={busy || page.complete} onClick={onNext}>
            Next unfinished operations
          </button>
        </div>
      )}
      {!page && entries.length > 50 && (
        <div className="intake-actions">
          <button disabled={busy || !start} onClick={() => setOffset(start - 50)}>
            Previous unfinished operations
          </button>
          <span>
            {start + 1}–{Math.min(start + 50, entries.length)} of {entries.length}
          </span>
          <button
            disabled={busy || start + 50 >= entries.length}
            onClick={() => setOffset(start + 50)}
          >
            Next unfinished operations
          </button>
        </div>
      )}
    </section>
  );
}
