import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Patient } from './pages/Patient';
import { TestResults } from './pages/TestResults';
import { ProfileProvider } from './components/ProfileProvider';
import { Medications, Procedures } from './pages/ClinicalRecords';
import { Sources } from './pages/Sources';
import { NotesPage } from './features/notes/NotesPage';
import { ConnectionBoundary } from './components/ConnectionStatus';
import { ImportPage } from './features/import/ImportPage';

export function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname !== '/')
      document.title = `Circus Health · ${({ '/': 'Patient', '/tests': 'Test results', '/medications': 'Prescriptions', '/procedures': 'Procedures', '/notes': 'Notes', '/people': 'People', '/sources': 'Sources', '/import': 'Import' } as Record<string, string>)[pathname] || 'Page not found'}`;
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <ConnectionBoundary>
      <ProfileProvider>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Patient />} />
            <Route path="tests" element={<TestResults />} />
            <Route path="medications" element={<Medications />} />
            <Route path="procedures" element={<Procedures />} />
            <Route path="notes" element={<CollectionPage />} />
            <Route path="people" element={<CollectionPage people />} />
            <Route path="sources" element={<Sources />} />
            <Route path="import" element={<ImportPage />} />
            <Route
              path="*"
              element={
                <div className="page empty-state">
                  <h1>Page not found</h1>
                  <Link className="button primary" to="/">
                    Back to your profile
                  </Link>
                </div>
              }
            />
          </Route>
        </Routes>
      </ProfileProvider>
    </ConnectionBoundary>
  );
}

function CollectionPage({ people = false }: { people?: boolean }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind');
  if (!people && kind === 'person') return <Navigate replace to={`/people${location.search}`} />;
  if (people && kind && kind !== 'person')
    return <Navigate replace to={`/notes${location.search}`} />;
  if (people && ['patient', 'person-note:self'].includes(params.get('id') || ''))
    return <Navigate replace to="/" />;
  return <NotesPage initialKind={people ? 'person' : 'note'} />;
}
