import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  isIntakeSummary,
  type IntakeRead,
  type IntakeUnitDetail,
} from '../../../shared/intake-summary';
import type { SourceReaderCoverage, SourceTextIssueList } from '../../../shared/intake-source-text';
import { useResource } from '../../data/api';
export type ReaderObservation = SourceReaderCoverage['entries'][number];

/** Processing notes are distinct from detector findings and explicit human inspection. */
export function SourceReaderObservations({
  intakeId,
  initial,
  blocked,
  onReview,
  renderReview,
  onPageChange,
}: {
  intakeId: string;
  initial?: SourceReaderCoverage;
  blocked: boolean;
  onReview: (entry: ReaderObservation) => void;
  renderReview: (entry: ReaderObservation) => ReactNode;
  onPageChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState<number | null>(null);
  const resource = useResource<SourceTextIssueList>(
    open
      ? `/intakes/${encodeURIComponent(intakeId)}/source-issues?limit=1&readerOffset=${offset}&readerLimit=20${offset && version !== null ? `&readerVersion=${version}` : ''}`
      : null,
  );
  const cached = resource.data?.readerCoverage;
  const initialIsNewer = !!initial && (!cached || initial.intakeVersion > cached.intakeVersion);
  const latest = initialIsNewer ? initial : cached || initial;
  const displayed = useRef(latest);
  // Updating a page of notes must not remove an editor with an unsaved transcription/draft.
  if (!blocked || !displayed.current) displayed.current = latest;
  const coverage = displayed.current;
  const outdated = !!coverage && !!latest && latest.intakeVersion > coverage.intakeVersion;
  const loadedInitialVersion = useRef(initial?.intakeVersion);
  useEffect(() => {
    if (blocked || !initial || initial.intakeVersion === loadedInitialVersion.current) return;
    loadedInitialVersion.current = initial.intakeVersion;
    setOffset(0);
    setVersion(null);
    resource.reload();
  }, [blocked, initial?.intakeVersion, resource.reload]);
  if (!coverage?.summary.units) return null;
  return (
    <details
      className="import-source-reader-observations"
      onToggle={(event) => {
        if (!event.currentTarget.open && blocked) {
          event.currentTarget.open = true;
          return;
        }
        if (event.currentTarget.open) setOpen(true);
      }}
    >
      <summary>
        Reader observations · {coverage.summary.pending + coverage.summary.partial} unfinished
        sections
      </summary>
      <p>
        These are retained processing notes, not verified transcription or human inspection.
        Context-only conclusions do not prove that nothing useful was omitted.
      </p>
      {outdated && (
        <p role="status">
          The source or processing record changed. These displayed observations are from an earlier
          version. Save or discard the open draft to refresh them.
        </p>
      )}
      {!!coverage.summary.stale && (
        <p>
          {coverage.summary.stale} retained observations predate source text changes. Read the
          corrected source again before relying on them.
        </p>
      )}
      {resource.error && (
        <p role="alert">
          {resource.error.message}{' '}
          <button
            className="text-link"
            type="button"
            disabled={blocked}
            onClick={() => {
              onPageChange();
              setOffset(0);
              setVersion(null);
              resource.reload();
            }}
          >
            Refresh reader observations
          </button>
        </p>
      )}
      <ul className="import-source-issue-list">
        {coverage.entries.map((entry) => (
          <li key={`${entry.planId}:${entry.unitId}`}>
            <button
              type="button"
              className="import-source-issue-row"
              disabled={blocked || !!resource.error}
              onClick={() => onReview(entry)}
            >
              <span>
                <strong>
                  {entry.coverageKind === 'unreadable'
                    ? 'Reader could not read this section'
                    : entry.coverageKind === 'context'
                      ? 'Reader marked contextual material'
                      : entry.status === 'pending'
                        ? 'Not yet assessed by the reader'
                        : entry.status === 'partial'
                          ? 'Reader assessment remains partial'
                          : 'Reader observation'}
                </strong>
                <span>
                  {entry.notes || 'No completed assessment is recorded for this section.'}
                  {entry.notesTruncated ? '…' : ''}
                </span>
                {entry.stale && <strong>Earlier source text — read again</strong>}
                <small>
                  {entry.locator}
                  {entry.pages?.length
                    ? ` · Pages ${entry.pages.join(', ')}${entry.pagesTruncated ? '…' : ''}`
                    : ' · No precise page established; opens original context'}
                </small>
              </span>
              <span className="text-link">Review</span>
            </button>
            {entry.notesTruncated && (
              <FullReaderNote intakeId={intakeId} version={coverage.intakeVersion} entry={entry} />
            )}
            {renderReview(entry)}
          </li>
        ))}
      </ul>
      {(offset > 0 || coverage.nextOffset !== null) && (
        <div className="source-review-toolbar">
          <button
            type="button"
            className="button secondary"
            disabled={blocked || resource.loading || !!resource.error || offset === 0}
            onClick={() => {
              onPageChange();
              setOffset(Math.max(0, offset - 20));
            }}
          >
            Previous reader observations
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={
              blocked || resource.loading || !!resource.error || coverage.nextOffset === null
            }
            onClick={() => {
              if (coverage.nextOffset === null) return;
              onPageChange();
              setVersion(coverage.intakeVersion);
              setOffset(coverage.nextOffset);
            }}
          >
            More reader observations
          </button>
        </div>
      )}
    </details>
  );
}
function FullReaderNote({
  intakeId,
  version,
  entry,
}: {
  intakeId: string;
  version: number;
  entry: ReaderObservation;
}) {
  const [open, setOpen] = useState(false);
  const resource = useResource<IntakeRead>(
    open ? `/intakes/${encodeURIComponent(intakeId)}` : null,
  );
  const selectedUnit = useResource<IntakeUnitDetail>(
    open && resource.data && isIntakeSummary(resource.data)
      ? `/intakes/${encodeURIComponent(intakeId)}/plan-unit?planId=${encodeURIComponent(entry.planId)}&unitId=${encodeURIComponent(entry.unitId)}&version=${version}`
      : null,
  );
  const unit =
    resource.data?.version === version
      ? isIntakeSummary(resource.data)
        ? selectedUnit.data?.version === version &&
          selectedUnit.data.planId === entry.planId &&
          selectedUnit.data.unit.id === entry.unitId
          ? selectedUnit.data.unit
          : undefined
        : resource.data.workflow?.plans
            .find((plan) => plan.id === entry.planId)
            ?.units.find((unit) => unit.id === entry.unitId)
      : undefined;
  return (
    <details
      className="import-source-reader-note"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpen(true);
      }}
    >
      <summary>Full retained reader note</summary>
      {(resource.loading || selectedUnit.loading) && <p role="status">Loading retained note…</p>}
      {resource.error && <p role="alert">{resource.error.message}</p>}
      {selectedUnit.error && (
        <p role="alert">
          {selectedUnit.error.message}{' '}
          <button className="text-link" type="button" onClick={selectedUnit.reload}>
            Retry full reader note
          </button>
        </p>
      )}
      {resource.data && !selectedUnit.loading && !selectedUnit.error && !unit && (
        <p role="alert">
          The processing record changed. Refresh reader observations before opening its current
          note.
        </p>
      )}
      {unit && (
        <>
          <p>{unit.coverage?.notes || 'No additional note.'}</p>
          {unit.pages && <p>Pages {unit.pages.join(', ')}</p>}
        </>
      )}
    </details>
  );
}
