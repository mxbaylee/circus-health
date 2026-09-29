import type { VisionPrescriptionRecord } from '../../shared/vision';
import { Link } from 'react-router-dom';
import { OpticalPrescriptionPreview } from './OpticalPrescriptionPreview';
import { Pagination, ResourceState } from './ResourceState';
import { SourceDialog } from './SourceDialog';
import { queryString, useResource } from '../data/api';

export function VisionHistory({
  filters,
  onOffset,
}: {
  filters: {
    documentId?: string;
    personId?: string;
    q: string;
    providerId: string;
    from: string;
    to: string;
    visibility: string;
    limit: number;
    offset: number;
    sort: string;
  };
  onOffset: (offset: number) => void;
}) {
  const history = useResource<VisionPrescriptionRecord[]>(
    `/vision-prescriptions?${queryString(filters)}`,
  );
  return (
    <section
      id="results-panel"
      role="tabpanel"
      aria-labelledby="vision-tab"
      className="panel vision-history"
    >
      <h2>Vision prescription history</h2>
      {filters.documentId && (
        <Link
          className="button secondary"
          to={`/tests?${queryString({ view: 'vision', personId: filters.personId })}`}
        >
          All vision prescriptions
        </Link>
      )}
      <p className="helper-text">
        Compare prescribed values as written in each original. Signs, notation and units are
        unchanged; matching values do not establish equivalent prescriptions. Examination findings
        remain in result history.
      </p>
      <ResourceState
        resource={history}
        empty="No reviewed optical prescriptions match these filters."
      >
        {(rows) => (
          <>
            <div className="vision-history-grid">
              {rows.map((row) => (
                <article
                  key={row.occurrenceId}
                  className="panel vision-history-card"
                  aria-label={row.title}
                >
                  <h3>{row.title}</h3>
                  <p>
                    {row.date || 'Unknown date'} · {row.provider || 'Provider not stated'}
                  </p>
                  <OpticalPrescriptionPreview prescription={row.opticalPrescription} />
                  <SourceDialog sourceRecordId={row.sourceRecordId} />
                </article>
              ))}
            </div>
            <Pagination
              offset={filters.offset}
              limit={filters.limit}
              count={rows.length}
              total={typeof history.meta?.total === 'number' ? history.meta.total : undefined}
              onChange={onOffset}
            />
          </>
        )}
      </ResourceState>
    </section>
  );
}
