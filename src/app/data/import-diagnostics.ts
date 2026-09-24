export { diagnosticRoute } from '../../shared/import-diagnostic-route.ts';

export interface BrowserImportDiagnostic {
  at: string;
  event: 'api.started' | 'api.completed' | 'api.failed' | 'api.cancelled';
  requestId: string;
  serverRequestId?: string;
  route: string;
  method: string;
  status?: number;
  durationMs?: number;
  code?: string;
  cancellation?: 'caller' | 'profile_changed' | 'transport';
}

const events: BrowserImportDiagnostic[] = [];
export function recordBrowserImportDiagnostic(event: BrowserImportDiagnostic): void {
  // A bounded metadata-only buffer makes an interrupted request diagnosable even
  // when console logging was off. It is never written to persistent storage.
  events.push(event);
  if (events.length > 500) events.splice(0, events.length - 500);
  try {
    if (sessionStorage.getItem('circus:import-debug') === '1')
      console.debug('[Circus import]', JSON.stringify(event));
  } catch {
    /* Session storage may be unavailable; diagnostics must not break requests. */
  }
}

export function browserImportDiagnostics(): readonly BrowserImportDiagnostic[] {
  return events.map((event) => ({ ...event }));
}

export function clearBrowserImportDiagnostics(): void {
  events.length = 0;
}
