import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import type { PersonSourceEvidence as SourceEvidence } from '../../../shared/api';
import { useResource } from '../../data/api';
import { useProfile } from '../../data/profile';
import { LoadingIndicator } from '../../components/LoadingIndicator';

/** Read-only evidence navigation, separate from user-authored note links. */
export function PersonSourceEvidence({
  noteId,
  noteVersion,
}: {
  noteId: string;
  noteVersion: number;
}) {
  const profile = useProfile();
  const scope = `${profile?.id || ''}:${noteId}:${noteVersion}`;
  const [page, setPage] = useState({ scope, offset: 0 });
  const offset = page.scope === scope ? page.offset : 0;
  useEffect(() => {
    setPage((current) => (current.scope === scope ? current : { scope, offset: 0 }));
  }, [scope]);
  const resource = useResource<SourceEvidence[]>(
    `/notes/${encodeURIComponent(noteId)}/source-evidence?limit=20&offset=${offset}&noteVersion=${noteVersion}`,
  );
  const total = typeof resource.meta?.total === 'number' ? resource.meta.total : null;
  if (!resource.loading && !resource.error && !resource.data?.length && offset === 0) return null;
  return (
    <section className="note-section" aria-label="Imported source evidence">
      <h3>
        <FileText size={17} /> Imported source evidence
      </h3>
      <p className="helper-text">
        These are the imported sources retained for this person. A saved entry appears only when it
        cites the same exact source. Shared source evidence does not establish a clinician,
        care-team or other role.
      </p>
      {resource.loading && <LoadingIndicator label="Loading source evidence…" size="small" />}
      {resource.error && (
        <p role="alert">
          Source evidence could not be loaded.{' '}
          <button type="button" className="text-link" onClick={resource.reload}>
            Retry
          </button>
        </p>
      )}
      {resource.data && (
        <ul className="note-linked-list">
          {resource.data.map((item) => (
            <li className="note-linked-item" key={item.sourceRecordId}>
              <div>
                <strong>{item.sourceTitle}</strong>
                <p>
                  {item.sourceMissing ? (
                    'Original source unavailable; its evidence reference is retained.'
                  ) : (
                    <>
                      <Link to={`/sources?record=${encodeURIComponent(item.sourceRecordId)}`}>
                        View original source
                      </Link>
                      {item.sourceArchived && <span> · Inactive source</span>}
                    </>
                  )}
                </p>
                {item.entries.length ? (
                  <ul>
                    {item.entries.map((entry) => (
                      <li key={`${entry.kind}:${entry.entityId}`}>
                        {entry.missing || !entry.appUrl ? (
                          'Previously saved entry unavailable; source evidence retained.'
                        ) : (
                          <>
                            <span>Saved entry from this exact source: </span>
                            <Link to={entry.appUrl}>{entry.title}</Link>
                            {entry.archived && <span> · Inactive</span>}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No saved health entry cites this exact source.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {(offset > 0 || (total !== null && offset + (resource.data?.length || 0) < total)) && (
        <div className="note-actions" aria-label="Source evidence pages">
          <button
            type="button"
            className="button secondary"
            disabled={!offset || resource.loading}
            onClick={() => setPage({ scope, offset: Math.max(0, offset - 20) })}
          >
            Previous sources
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={
              resource.loading ||
              Boolean(resource.error) ||
              total === null ||
              offset + (resource.data?.length || 0) >= total
            }
            onClick={() => setPage({ scope, offset: offset + 20 })}
          >
            Next sources
          </button>
        </div>
      )}
    </section>
  );
}
