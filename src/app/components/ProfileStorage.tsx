import { useResource } from '../data/api';
import { ResourceState } from './ResourceState';
import { ContextHelp } from './ContextHelp';
import { useEffect, useState } from 'react';
import { formatStorageBytes as bytes } from '../data/storage';
type Totals = {
  storedBytes: number;
  runtimeBytes: number;
  breakdown: { id: string; label: string; bytes: number; files: number }[];
  notes: string[];
};
export function ProfileStorage() {
  const resource = useResource<Totals>('/storage');
  return (
    <section aria-label="Profile storage">
      <ResourceState resource={resource}>
        {(value) => (
          <>
            <p>
              <strong>{bytes(value.storedBytes)}</strong> stored for this profile
            </p>
            <dl className="source-fields">
              {value.breakdown
                .filter((row) => row.bytes > 0)
                .map((row) => (
                  <div key={row.id}>
                    <dt>{row.label}</dt>
                    <dd>{bytes(row.bytes)}</dd>
                  </div>
                ))}
            </dl>
            <p>Temporary working files: {bytes(value.runtimeBytes)}</p>
            <ContextHelp label="What uses storage?">
              <p>
                The encrypted archive keeps originals and accepted history. Corrections add
                versions, so hiding a record does not free that space. Temporary working files
                support the unlocked profile and are separate from the archive.
              </p>
              {value.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </ContextHelp>
          </>
        )}
      </ResourceState>
    </section>
  );
}

type ArchiveTotals = {
  status: 'measured' | 'partial';
  storedBytes: number;
  otherArchiveBytes: number;
  runtimeBytes: number;
  runtimeStatus: 'measured' | 'partial';
  notes: string[];
};
export function ArchiveStorageSummary() {
  const [value, setValue] = useState<ArchiveTotals | null>(null),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setValue(null);
    fetch('/api/storage/archive', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Storage unavailable');
        const result = await response.json();
        if (
          !result.data ||
          !Number.isFinite(result.data.storedBytes) ||
          !Number.isFinite(result.data.otherArchiveBytes) ||
          !Array.isArray(result.data.notes)
        )
          throw Error('Storage unavailable');
        if (!controller.signal.aborted) setValue(result.data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <details className="helper-text">
      <summary>
        Backups and other archive files:{' '}
        {value
          ? `${value.status === 'partial' ? 'at least ' : ''}${bytes(value.otherArchiveBytes)}`
          : error
            ? 'Unknown'
            : 'Measuring…'}
      </summary>
      {error ? (
        <p>
          Storage could not be measured.{' '}
          <button className="text-link" type="button" onClick={() => setRevision((n) => n + 1)}>
            Retry measurement
          </button>
        </p>
      ) : (
        value && (
          <>
            <p>
              Total archive: {value.status === 'partial' ? 'at least ' : ''}
              {bytes(value.storedBytes)}. Temporary runtime:{' '}
              {value.runtimeStatus === 'partial' ? 'at least ' : ''}
              {bytes(value.runtimeBytes)}.
            </p>
            {value.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </>
        )
      )}
    </details>
  );
}

type ImportEstimate = {
  originalStorageEstimateBytes: number;
  runtimePlanningBytes: number;
  archive: { reportedAvailableBytes: number | null };
  runtime: { reportedAvailableBytes: number | null };
  notes: string[];
};
export function ImportStorageEstimate({ bytes: originalBytes }: { bytes: number }) {
  const resource = useResource<ImportEstimate>(
    originalBytes > 0 ? `/storage/import-estimate?bytes=${originalBytes}` : null,
  );
  if (!originalBytes) return null;
  const value = resource.data;
  return (
    <details className="helper-text">
      <summary>
        Import space estimate
        {value
          ? `: ${bytes(value.originalStorageEstimateBytes)} originals · ${bytes(value.runtimePlanningBytes)} temporary`
          : resource.error
            ? ': unavailable'
            : ': measuring…'}
      </summary>
      {resource.error ? (
        <p>
          Capacity is unknown.{' '}
          <button className="text-link" type="button" onClick={resource.reload}>
            Retry estimate
          </button>
        </p>
      ) : (
        value && (
          <>
            <p>
              Filesystem-reported available space: archive{' '}
              {bytes(value.archive.reportedAvailableBytes)}; runtime{' '}
              {bytes(value.runtime.reportedAvailableBytes)}. Quota: unknown.
            </p>
            {value.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </>
        )
      )}
    </details>
  );
}
