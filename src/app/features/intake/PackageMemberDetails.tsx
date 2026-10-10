import { useEffect, useState } from 'react';
import type {
  IntakeMetadataFragment,
  IntakeMetadataFragmentReference,
} from '../../../shared/intake-package-paging';
import { api } from '../../data/api';

/** Only the selected fragment is retained; a long file name cannot grow browser state. */
export function PackageMemberDetails({
  reference,
}: {
  reference: IntakeMetadataFragmentReference;
}) {
  const [open, setOpen] = useState(false),
    [offset, setOffset] = useState(0);
  const [page, setPage] = useState<IntakeMetadataFragment | null>(null),
    [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setOffset(0);
    setPage(null);
  }, [reference.metadataHash, reference.version]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setPage(null);
    void api<IntakeMetadataFragment>(
      `/intakes/${encodeURIComponent(reference.intakeId)}/package-metadata`,
      {
        method: 'POST',
        body: JSON.stringify({ reference, offset, limit: 32768 }),
      },
    )
      .then((result) => {
        if (cancelled) return;
        if (
          JSON.stringify(result.data.reference) !== JSON.stringify(reference) ||
          result.data.offset !== offset
        )
          throw Error('File details changed. Reload the package inventory.');
        setPage(result.data);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'File details could not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reference, offset]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Full retained file details</summary>
      {loading && <p role="status">Loading file details…</p>}
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          <p>
            {page.complete && page.offset === 0
              ? 'Complete file details'
              : 'Part of the retained file details'}
          </p>
          <pre className="intake-member-literal">{page.text}</pre>
          <div className="intake-actions">
            <button
              className="text-link"
              disabled={loading || offset === 0}
              onClick={() => setOffset(0)}
            >
              First part of file details
            </button>
            <button
              className="text-link"
              disabled={loading || page.complete}
              onClick={() => setOffset(page.nextOffset!)}
            >
              Next part of file details
            </button>
          </div>
        </>
      )}
    </details>
  );
}
