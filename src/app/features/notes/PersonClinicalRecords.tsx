import { Link } from 'react-router-dom';
import type { Note, Medication, Procedure } from '../../../shared/api';
import { queryString, useResource } from '../../data/api';
import { formatDate } from '../../data/format';

function RecordLink({ path, label }: { path: string; label: string }) {
  const count = useResource<unknown[]>(`${path}&limit=1`);
  return (
    <Link
      className="text-link"
      to={
        path.startsWith('/documents?')
          ? path.replace('/documents?', '/sources?view=documents&')
          : path.startsWith('/historical-notes?')
            ? path.replace('/historical-notes?', '/notes?kind=historical&')
            : path
      }
    >
      <strong>{label}</strong>
      {typeof count.meta?.total === 'number'
        ? ` · ${count.meta.total}`
        : count.error
          ? ' · Count unavailable'
          : ''}
    </Link>
  );
}
/** A compact index of actual owned records; shared source evidence is separate. */
export function PersonClinicalRecords({ person }: { person: Note }) {
  const id = person.personId;
  const scope = queryString({ personId: id });
  const medications = useResource<Medication[]>(
    id ? `/medications?${scope}&status=current&limit=3` : null,
  );
  const procedures = useResource<Procedure[]>(
    id ? `/procedures?${scope}&category=all&limit=3` : null,
  );
  if (!id) return <p role="status">Save this person to open their health records.</p>;
  const links = [
    ['/tests', 'Test results', ''],
    ['/medications', 'Prescriptions', '&status=all'],
    ['/procedures', 'Procedures', '&category=all'],
    ['/notes', 'Notes', '&kind=note'],
    ['/historical-notes', 'Historical notes', ''],
    ['/documents', 'Documents', ''],
  ] as const;
  return (
    <section className="person-health-records" aria-label="Health records">
      <h2>Health records</h2>
      <nav aria-label="This person’s health records">
        {links.map(([path, label, extra]) => (
          <RecordLink key={path} path={`${path}?${scope}${extra}`} label={label} />
        ))}
      </nav>
      <Link className="text-link" to={`/tests?${scope}&view=vision`}>
        Vision prescriptions
      </Link>
      {!!medications.data?.length && (
        <div>
          <h3>Active prescriptions</h3>
          <ul>
            {medications.data.map((row) => (
              <li key={row.id}>
                <Link to={`/medications?${scope}&id=${encodeURIComponent(row.id)}`}>
                  {row.label}
                </Link>
                {row.doseText && ` · ${row.doseText}`}
              </li>
            ))}
          </ul>
          <Link className="text-link" to={`/medications?${scope}`}>
            View all prescriptions
          </Link>
        </div>
      )}
      {!!procedures.data?.length && (
        <div>
          <h3>Recent procedures</h3>
          <ul>
            {procedures.data.map((row) => (
              <li key={row.id}>
                <Link to={`/procedures?${scope}&category=all&id=${encodeURIComponent(row.id)}`}>
                  {row.label}
                </Link>
                {row.date && ` · ${formatDate(row.date)}`}
              </li>
            ))}
          </ul>
          <Link className="text-link" to={`/procedures?${scope}&category=all`}>
            View all procedures
          </Link>
        </div>
      )}
      {(medications.error || procedures.error) && (
        <p role="status">Some summaries could not load. Open the collection to retry.</p>
      )}
    </section>
  );
}
