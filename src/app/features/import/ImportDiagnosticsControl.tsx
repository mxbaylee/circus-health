import { CLIENT_BUILD_IDENTITY } from '../../data/build';
import { browserImportPerformance } from '../../data/import-performance';
import { useId, useState } from 'react';
import type {
  ImportDiagnosticEventWindow,
  ImportDiagnosticArchive,
} from '../../../shared/import-performance';
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
        eventArchive?: ImportDiagnosticArchive;
      }>('/import-diagnostics');
      const data = {
        format: 'circus-import-diagnostics-v1',
        exportedAt: new Date().toISOString(),
        coverage:
          'Bounded metadata only, not an established full-run history. The live event window resets after profile lock, clear or process restart. A separate encrypted archive may retain earlier events; its coverage, failures and limits are explicit. Earlier omissions and an abrupt-shutdown tail remain unknown. Deduplicate live and archived observations by windowId and sequence. No medical text, filenames, profile identity, credentials or raw model payloads. Source reading is not clinical completeness.',
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
      const archive = response.data.eventArchive;
      const knownOmissions =
        archive?.windowCoverage?.reduce(
          (total, window) => total + BigInt(window.knownPersistedNotExportedEvents),
          0n,
        ) || 0n;
      const coverage =
        !archive || archive.status === 'not_attached' || archive.status === 'unavailable'
          ? 'Retained event history is unavailable.'
          : archive.status === 'partial'
            ? 'Some retained event history could not be included; inspect the coverage and failure counts.'
            : 'The retained portion shows no known missing events; earlier history and an abrupt-shutdown tail may still be missing.';
      setMessage(
        `Diagnostics downloaded. ${coverage} ${knownOmissions ? `At least ${knownOmissions} previously saved diagnostic events are missing from this download. The cause is unknown. ` : ''}${
          !response.data.enabled
            ? 'Detailed server events are off; enable CRS_IMPORT_DIAGNOSTICS=true before a future reproduction.'
            : response.data.droppedEvents
              ? `${response.data.droppedEvents} server events exceeded the current memory window; the archive is separate.`
              : 'Review sensitive activity metadata before sharing.'
        }`,
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
          ? 'Bounded diagnostics include retained events when available. Earlier history and an abrupt-shutdown tail may be missing.'
          : 'Detailed events are off. Download summaries and any previously retained events, or enable detailed diagnostics before reproducing a problem.'}
      </p>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
