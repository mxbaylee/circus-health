import { CLIENT_BUILD_IDENTITY } from '../../data/build';
import { browserImportPerformance } from '../../data/import-performance';
import { useEffect, useId, useRef, useState } from 'react';
import { currentProfile, subscribeProfileIdentity } from '../../data/profile';
import {
  isImportRecordingCheck,
  sameDiagnosticOrigin,
  type ImportRecordingCheck,
} from '../../../shared/import-recording-check';
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
  const [busy, setBusy] = useState<'download' | 'check' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [check, setCheck] = useState<ImportRecordingCheck | null>(null);
  const latestCheck = useRef<ImportRecordingCheck | null>(null);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const coverageId = useId();
  useEffect(() => {
    const clear = () => {
      epoch.current++;
      controller.current?.abort();
      latestCheck.current = null;
      setCheck(null);
      setMessage(null);
      setBusy(null);
    };
    const unsubscribe = subscribeProfileIdentity(clear);
    return () => {
      unsubscribe();
      epoch.current++;
      controller.current?.abort();
      latestCheck.current = null;
    };
  }, []);
  function start(action: 'check' | 'download') {
    const generation = ++epoch.current;
    const profileId = currentProfile()?.id;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(action);
    setMessage(null);
    return {
      request,
      current: () =>
        epoch.current === generation &&
        currentProfile()?.id === profileId &&
        !request.signal.aborted,
    };
  }
  async function checkRecording() {
    const { request, current } = start('check');
    latestCheck.current = null;
    setCheck(null);
    try {
      const response = await api<unknown>('/import-diagnostics/check', {
        method: 'POST',
        signal: request.signal,
      });
      if (!current()) return;
      if (!isImportRecordingCheck(response.data))
        throw new Error('Diagnostic recording could not be verified. Try checking again.');
      latestCheck.current = response.data;
      setCheck(response.data);
    } catch (error) {
      if (current())
        setMessage(
          error instanceof Error
            ? error.message
            : 'Could not check diagnostic recording. Try again.',
        );
    } finally {
      if (current()) setBusy(null);
    }
  }
  async function download() {
    const { request, current } = start('download');
    try {
      const browser = browserImportDiagnostics();
      const reviewEditors = reviewEditorDiagnostics();
      const response = await api<{
        enabled: boolean;
        droppedEvents: number;
        events: unknown[];
        eventWindow?: ImportDiagnosticEventWindow;
        eventArchive?: ImportDiagnosticArchive;
      }>('/import-diagnostics', { signal: request.signal });
      if (!current()) return;
      const savedCheck = latestCheck.current;
      const currentOrigin = response.data.eventArchive?.currentAttachment?.origin;
      const data = {
        format: 'circus-import-diagnostics-v1',
        exportedAt: new Date().toISOString(),
        coverage:
          'Bounded metadata only, not an established full-run history. The live event window resets after profile lock, clear, process restart or archive reattachment. A separate encrypted archive may retain earlier events; its coverage, failures and limits are explicit. Recording attachment dates describe archive attachment, not a complete import history. Pre-attachment observations are separate from saved archive evidence. Earlier omissions and an abrupt-shutdown tail remain unknown. Deduplicate live and archived observations by windowId and sequence. No medical text, filenames, profile identity, credentials or raw model payloads. Source reading is not clinical completeness.',
        clientBuild: CLIENT_BUILD_IDENTITY,
        recordingCheck: savedCheck
          ? {
              observation: savedCheck,
              attachmentComparison:
                !response.data.eventArchive ||
                (!currentOrigin && response.data.eventArchive.status !== 'not_attached')
                  ? 'unavailable'
                  : savedCheck.currentAttachment &&
                      currentOrigin &&
                      sameDiagnosticOrigin(savedCheck.currentAttachment.origin, currentOrigin)
                    ? 'same_attachment'
                    : !savedCheck.currentAttachment &&
                        response.data.eventArchive.status === 'not_attached'
                      ? 'same_attachment'
                      : 'superseded',
            }
          : null,
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
      if (current())
        setMessage(
          error instanceof Error ? error.message : 'Could not download diagnostics. Try again.',
        );
    } finally {
      if (current()) setBusy(null);
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
        disabled={busy !== null}
        aria-describedby={coverageId}
        onClick={() => void download()}
      >
        {busy === 'download' ? 'Preparing diagnostics…' : 'Download performance diagnostics'}
      </button>
      <button
        className="button subtle"
        type="button"
        disabled={busy !== null}
        aria-describedby={coverageId}
        onClick={() => void checkRecording()}
      >
        {busy === 'check' ? 'Checking diagnostic recording…' : 'Check diagnostic recording'}
      </button>
      <p id={coverageId} className="helper-text">
        {enabled.data.enabled
          ? 'Bounded diagnostics include retained events and recording attachment details when available. Attachment dates do not prove that a whole import was recorded. Earlier history and an abrupt-shutdown tail may be missing.'
          : 'Detailed events are off. Download summaries and any previously retained events. To record a future reproduction, set CRS_IMPORT_DIAGNOSTICS=true in the Compose environment and restart with npm start before uploading.'}
      </p>
      {busy === 'check' && <p role="status">Checking saved diagnostic attachment evidence…</p>}
      {check && (
        <p role="status">
          Checked at{' '}
          <time dateTime={check.checkedAt}>{new Date(check.checkedAt).toLocaleString()}</time>.{' '}
          {check.status === 'recording_disabled'
            ? 'Detailed recording is off. Older saved events do not show that new events are being recorded. To record a future reproduction, set CRS_IMPORT_DIAGNOSTICS=true in the Compose environment and restart with npm start before uploading.'
            : check.status === 'not_attached'
              ? 'No encrypted diagnostic attachment is available for this profile.'
              : check.status === 'inspection_unavailable'
                ? 'Saved diagnostic evidence could not be inspected. Check again before reproducing the problem.'
                : check.status === 'current_origin_readable'
                  ? 'Detailed recording is on, and the current saved attachment record was readable.'
                  : 'Detailed recording is on, but the current saved attachment record could not be verified.'}
          {check.currentAttachment?.publication === 'unconfirmed' && check.currentOriginReadable
            ? ' The save was not acknowledged, but its attachment record was readable.'
            : ''}
          {check.currentAttachment?.publication === 'confirmed' && !check.currentOriginReadable
            ? ' A save acknowledgement alone does not show that the attachment record can be read.'
            : ''}
          {check.currentAttachment?.origin.observedBeforeAttachment
            ? ` ${check.currentAttachment.origin.observedBeforeAttachment} observations occurred before encrypted attachment; this is not proof they were saved.`
            : ''}
          {check.archive.coverageWarnings
            ? ' Some retained history is missing or could not be inspected; current attachment evidence is separate.'
            : ''}{' '}
          This checks the attachment at that time. It does not guarantee that a whole import was
          recorded or that future events will be retained.
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
