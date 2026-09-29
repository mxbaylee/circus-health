import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { UsersRound } from 'lucide-react';
import { useProfile } from '../data/profile';
import { queryString, useResource } from '../data/api';
import { personScopeRoute } from '../../shared/person-scope';
import { LoadingIndicator } from './LoadingIndicator';
import './person-scope.css';

type Scope = {
  personId: string;
  name: string;
  scoped: boolean;
  filterable: boolean;
  pending: boolean;
  error: string | null;
  reload: () => void;
  personHref: string | null;
};
const Context = createContext<Scope | null>(null);
export const usePersonScope = () => useContext(Context);
export function PersonScopeProvider({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const location = useLocation();
  const [params, setParams] = useSearchParams();

  const route = personScopeRoute(location.pathname, params);
  const owner = useResource<{ personId: string | null }>(
    route.target ? `/record-owner?${queryString(route.target)}` : null,
  );
  const requested = location.pathname === '/' ? 'patient' : params.get('personId') || 'patient';
  const personId = owner.data?.personId || requested;
  const person = useResource<{ name: string; noteId: string | null }>(
    route.scoped && personId !== 'patient' && (!route.target || owner.data)
      ? `/clinical-person/${encodeURIComponent(personId)}`
      : null,
  );
  const pending =
    route.scoped && ((!!route.target && !owner.data && !owner.error) || person.loading);
  const error = route.scoped ? owner.error?.message || person.error?.message || null : null;
  // Deep links resolve ownership before showing clinical content. Never show an old list
  // beside a newly resolved owner's detail while the URL is being corrected.
  const canonicalizing =
    route.filterable &&
    !pending &&
    !error &&
    ((params.get('personId') || 'patient') !== personId ||
      (location.pathname === '/sources' &&
        params.has('document') &&
        params.get('view') !== 'documents'));
  useEffect(() => {
    if (!route.scoped || pending || error) return;

    if (canonicalizing) {
      const next = new URLSearchParams(params);
      next.set('personId', personId);
      if (location.pathname === '/sources' && params.has('document')) next.set('view', 'documents');
      next.delete('offset');
      next.delete('compare');
      setParams(next, { replace: true });
    }
  }, [route.scoped, pending, error, personId, profile?.id, canonicalizing, params, setParams]);
  const value: Scope = {
    personId,
    name: personId === 'patient' ? 'Self' : person.data?.name || 'another person',
    scoped: route.scoped,
    filterable: route.filterable,
    pending: pending || canonicalizing,
    error,
    reload: () => {
      owner.reload();
      person.reload();
    },
    personHref:
      person.data?.noteId && location.pathname !== '/people'
        ? `/people?id=${encodeURIComponent(person.data.noteId)}`
        : null,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function PersonScopeIndicator() {
  const scope = usePersonScope();
  if (!scope?.scoped || (!scope.pending && !scope.error && scope.personId === 'patient'))
    return null;
  return (
    <div className="person-context-indicator" role="status">
      <UsersRound size={20} aria-hidden="true" />
      <span className="person-context-copy">
        {scope.error ? (
          'Person unavailable'
        ) : scope.pending ? (
          'Checking record owner…'
        ) : (
          <>
            Viewing <strong className="person-context-name">{scope.name}</strong>’s records
          </>
        )}
      </span>
      {!scope.pending && !scope.error && (
        <span className="person-context-actions">
          Not Self{scope.personHref && <Link to={scope.personHref}>View person</Link>}
        </span>
      )}
    </div>
  );
}
export function PersonScopeContent({ children }: { children: ReactNode }) {
  const scope = usePersonScope();
  return (
    <>
      {scope?.error && (
        <div className="page" role="alert">
          <p>{scope.error}</p>
          <button className="button secondary" onClick={scope.reload}>
            Retry
          </button>
        </div>
      )}
      {scope?.pending && <LoadingIndicator label="Opening person’s records…" layout="centered" />}
      <div hidden={!!scope?.pending || !!scope?.error}>{children}</div>
    </>
  );
}
