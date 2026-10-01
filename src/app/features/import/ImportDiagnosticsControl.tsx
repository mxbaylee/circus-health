import { CLIENT_BUILD_IDENTITY } from '../../data/build';
import { browserImportPerformance } from '../../data/import-performance';
import { useId, useState } from 'react';
import type { ImportDiagnosticEventWindow } from '../../../shared/import-performance';
import { api, useResource } from '../../data/api';
import {
  reviewEditorDiagnostics,
  browserImportDiagnostics,
  identityReviewDiagnostics,
} from '../../data/import-diagnostics';

export function ImportDiagnosticsControl() {
  const enabled = useResource<{ enabled: boolean }>('/import-diagnostics/status');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const coverageId = useId();
  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const browser = browserImportDiagnostics();
      const reviewEditors = reviewEditorDiagnostics();
      const response = await api<{
        enabled: boolean;
        droppedEvents: number;
        events: unknown[];
        eventWindow?: ImportDiagnosticEventWindow;
      }>('/import-diagnostics');
      const data = {
        format: 'circus-import-diagnostics-v1',
        exportedAt: new Date().toISOString(),
        coverage:
          'Bounded metadata only, not an established full-run history. Detailed server events are memory-only and reset after profile lock, clear or process restart; earlier missing history is unknown. No medical text, filenames, profile identity, credentials or raw model payloads. Source reading is not clinical completeness.',
        clientBuild: CLIENT_BUILD_IDENTITY,
        browser,
        reviewEditors,
        identityReviews: identityReviewDiagnostics(),
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
          ? 'Performance summaries downloaded. Detailed server events are off; enable CRS_IMPORT_DIAGNOSTICS=true for a more detailed reproduction.'
          : response.data.droppedEvents
            ? `Diagnostics downloaded. ${response.data.droppedEvents} server events exceeded the current memory window. Earlier history may also be unavailable.`
            : 'Diagnostics downloaded. Detailed events cover only the current memory window; earlier history may be unavailable. Review sensitive activity metadata before sharing.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Could not download diagnostics. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (
    enabled.loading ||
    enabled.refreshing ||
    enabled.error ||
    typeof enabled.data?.enabled !== 'boolean'
  )
    return null;
  return (
    <div className="import-diagnostics-control">
      <button
        className="button subtle"
        type="button"
        disabled={busy}
        aria-describedby={coverageId}
        onClick={() => void download()}
      >
        {busy ? 'Preparing diagnostics…' : 'Download performance diagnostics'}
      </button>
      <p id={coverageId} className="helper-text">
        {enabled.data.enabled
          ? 'Bounded recent diagnostics. Detailed event history resets after locking the profile or restarting the app.'
          : 'Detailed events are off. Download limited summaries, or enable detailed diagnostics before reproducing a problem.'}
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
