import { Link } from 'react-router-dom';
import { useResource } from '../data/api';

export function ClinicalOwner({ personId = 'patient' }: { personId?: string }) {
  const person = useResource<{ name: string; noteId: string | null }>(
    personId !== 'patient' ? `/clinical-person/${encodeURIComponent(personId)}` : null,
  );
  if (personId === 'patient') return null;
  return (
    <p className="helper-text" role="status">
      Records for <strong>{person.data?.name || 'another person'}</strong>. These records are
      separate from Self.
      {person.data?.noteId && (
        <>
          {' '}
          <Link to={`/people?id=${encodeURIComponent(person.data.noteId)}`}>Open person</Link>
        </>
      )}
    </p>
  );
}
