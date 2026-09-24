import { browserImportPerformance } from '../../data/import-performance';
import { useState } from 'react';
import { api } from '../../data/api';
import { browserImportDiagnostics } from '../../data/import-diagnostics';

export function ImportDiagnosticsControl() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const browser = browserImportDiagnostics();
      const response = await api<{ enabled: boolean; droppedEvents: number; events: unknown[] }>(
        '/import-diagnostics',
      );
      const data = {
        format: 'circus-import-diagnostics-v1',
        exportedAt: new Date().toISOString(),
        coverage:
          'Bounded metadata only. No medical text, filenames, profile identity, credentials or raw model payloads. Source reading is not clinical completeness.',
        browser,
        browserOperations: browserImportPerformance(),
        server: response.data,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `circus-import-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        !response.data.enabled
          ? 'Performance summaries downloaded. Detailed server events are off; enable HEALTH_IMPORT_DIAGNOSTICS=true for a more detailed reproduction.'
          : response.data.droppedEvents
            ? `Diagnostics downloaded. ${response.data.droppedEvents} older server events exceeded the buffer and are not included.`
            : 'Diagnostics downloaded. It contains timings, request references, resource samples and progress—not medical content.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not download diagnostics. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="import-diagnostics-control">
      <button
        className="button subtle"
        type="button"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? 'Preparing diagnostics…' : 'Download performance diagnostics'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
