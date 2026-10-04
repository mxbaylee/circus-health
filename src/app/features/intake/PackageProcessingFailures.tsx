import { useState } from 'react';
import type { IntakePackageFailure } from '../../../shared/intake';
import type { IntakePackageFailurePage } from '../../../shared/intake-summary';

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
  onRetry: (failure: IntakePackageFailure) => void;
}) {
  const [offset, setOffset] = useState(0);
  const entries: [string, IntakePackageFailure][] = page
    ? page.entries.map(({ key, failure }) => [key, failure])
    : Object.entries(failures || {});
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
        {entries.slice(start, start + 50).map(([key, failure]) => (
          <li key={key}>
            <strong>{failure.filename || failure.originalFilename}</strong>
            {failure.locator && <p>{failure.locator}</p>}
            <p>{failure.detail}</p>
            <a className="text-link" href={failure.contentUrl} target="_blank" rel="noreferrer">
              Open original: {failure.originalFilename}
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
