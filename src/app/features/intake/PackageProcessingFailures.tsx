import { useState } from 'react';
import type { IntakePackageFailure } from '../../../shared/intake';

export function PackageProcessingFailures({
  failures,
  busy,
  onRetry,
}: {
  failures: Record<string, IntakePackageFailure> | undefined;
  busy: boolean;
  onRetry: (failure: IntakePackageFailure) => void;
}) {
  const [offset, setOffset] = useState(0);
  const entries = Object.entries(failures || {});
  if (!entries.length) return null;
  const start = Math.min(offset, Math.floor((entries.length - 1) / 50) * 50);
  return (
    <section aria-label="Unfinished package processing">
      <h4>Processing must wait</h4>
      <p>
        {entries.length} unfinished operations. The original remains available; this scope is
        incomplete and has not accepted clinical records.
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
      {entries.length > 50 && (
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
