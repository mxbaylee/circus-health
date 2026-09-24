import { afterEach, expect, it, vi } from 'vitest';
import {
  browserImportDiagnostics,
  clearBrowserImportDiagnostics,
  diagnosticRoute,
  recordBrowserImportDiagnostic,
} from '../../app/data/import-diagnostics';

afterEach(() => {
  clearBrowserImportDiagnostics();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it('removes profile, filename, record and query content from browser diagnostic routes', () => {
  expect(
    diagnosticRoute(
      '/api/profiles/Fictional%20Person/intakes/private-report.pdf/report-source?name=Private',
    ),
  ).toBe('/profiles/:profile/intakes/:item/report-source');
  expect(diagnosticRoute('/notes/person-note:self?q=fictional')).toBe(
    '/profiles/:profile/notes/:item',
  );
  expect(diagnosticRoute('/unexpected-private-resource/secret')).toBe(
    '/profiles/:profile/:resource/:item',
  );
});

it('bounds metadata-only request history in memory and leaves console output opt-in', () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  for (let i = 0; i < 510; i++)
    recordBrowserImportDiagnostic({
      at: '2026-01-01T00:00:00Z',
      event: 'api.started',
      requestId: `fictional-${i}`,
      route: '/profiles/:profile/intakes',
      method: 'GET',
    });
  expect(browserImportDiagnostics()).toHaveLength(500);
  expect(debug).not.toHaveBeenCalled();
  const snapshot = browserImportDiagnostics();
  snapshot[0]!.method = 'CHANGED';
  expect(browserImportDiagnostics()[0]!.method).toBe('GET');
});
