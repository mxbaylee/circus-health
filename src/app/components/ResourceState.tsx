import type { ReactNode } from 'react';
import type { Resource } from '../data/api';
import { LoadingIndicator } from './LoadingIndicator';

export function ResourceState<T>({
  resource,
  children,
  empty = 'No records found.',
}: {
  resource: Resource<T>;
  children: (data: T) => ReactNode;
  empty?: string;
}) {
  if (resource.loading && resource.data === null)
    return <LoadingIndicator className="resource-state" label="Loading records…" layout="panel" />;
  if (resource.error && resource.data === null)
    return (
      <div className="resource-state error-state" role="alert">
        <p>{resource.error.message}</p>
        <button className="button secondary" onClick={resource.reload}>
          Try again
        </button>
      </div>
    );
  if (resource.data === null) return <div className="resource-state">{empty}</div>;
  return (
    <>
      {resource.error && (
        <p className="resource-state" role="status">
          Showing the last loaded records.{' '}
          <button className="text-link" onClick={resource.reload}>
            Try again
          </button>
        </p>
      )}
      {Array.isArray(resource.data) && !resource.data.length ? (
        <div className="resource-state">{empty}</div>
      ) : (
        children(resource.data)
      )}
    </>
  );
}

export function Pagination({
  offset,
  limit,
  total,
  count,
  onChange,
}: {
  offset: number;
  limit: number;
  total?: number;
  count: number;
  onChange: (offset: number) => void;
}) {
  return (
    <nav className="pagination" aria-label="Pages">
      <button
        className="button secondary"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <span>
        {count ? `${offset + 1}–${offset + count}` : '0'}
        {typeof total === 'number' ? ` of ${total}` : ''}
      </span>
      <button
        className="button secondary"
        disabled={typeof total === 'number' ? offset + count >= total : count < limit}
        onClick={() => onChange(offset + limit)}
      >
        Next
      </button>
    </nav>
  );
}

export function DataTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: (Record<string, unknown> | unknown[])[];
}) {
  if (!rows.length) return <p className="resource-state">The query returned no rows.</p>;
  return (
    <div className="data-table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={`${column}-${index}`} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column, columnIndex) => {
                const value = Array.isArray(row) ? row[columnIndex] : row[column];
                return (
                  <td key={`${column}-${columnIndex}`}>
                    {value === null || value === undefined ? (
                      <span className="muted">NULL</span>
                    ) : typeof value === 'object' ? (
                      JSON.stringify(value)
                    ) : (
                      String(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
