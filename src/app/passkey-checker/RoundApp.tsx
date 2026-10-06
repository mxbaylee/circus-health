import { useEffect, useState, useSyncExternalStore } from 'react';
import GuidedApp, { downloadReport } from './GuidedApp';
import { BUILD_INFO } from './build';
import { createCheckerController } from './controller';
import type { CheckerController } from './controller';
import { createRun } from './environment';
import { reportMarkdown } from './report';
import { deleteCheckerStore, openCheckerStore } from './store';
import { guidedDatabase, GUIDED_ROUND, LEGACY_DATABASE, roundDatabase } from './round';
import type { RegistrationMode } from './round';

function CurrentRound({
  controller,
  mode,
  onMode,
}: {
  controller: CheckerController;
  mode: RegistrationMode;
  onMode: (mode: RegistrationMode) => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [previousDatabase, setPreviousDatabase] = useState(LEGACY_DATABASE);
  const disabled = snapshot.busy || snapshot.storage === 'saving' || exporting;
  async function exportPrevious() {
    setExporting(true);
    setNotice('');
    let previous: Awaited<ReturnType<typeof openCheckerStore>> | undefined;
    try {
      previous = await openCheckerStore(globalThis.indexedDB, previousDatabase);
      const retained = await previous.load();
      if (!retained) setNotice('No previous-round results are saved in this browser.');
      else {
        downloadReport(reportMarkdown(retained.state), 'passkey-checker-previous-round.md');
        setNotice('Previous-round download requested. Those results were not changed or cleared.');
      }
    } catch {
      setNotice(
        'Previous-round results could not be read or downloaded. They were not deleted or replaced.',
      );
    } finally {
      previous?.close();
      setExporting(false);
    }
  }
  return (
    <GuidedApp
      controller={controller}
      settings={
        <details>
          <summary>Advanced: creation PRF mode</summary>
          <label>
            Registration request
            <select
              value={mode}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === 'eval' || event.target.value === 'enable-only')
                  onMode(event.target.value);
              }}
            >
              <option value="eval">Existing request (default)</option>
              <option value="enable-only">Experiment: enable PRF, evaluate at confirmation</option>
            </select>
          </label>
          <p>
            Default requests creation-time PRF evaluation, as the app does. The alternative omits
            only that evaluation. Each mode resumes its own separate A/B/C run; never combine modes
            into one pass. Select the same mode again after reloading to resume it.
          </p>
        </details>
      }
      previous={
        <details>
          <summary>Previous results</summary>
          <p>These downloads are historical A/B rounds, not the current A/B/C report above.</p>
          <label>
            Previous testing round
            <select
              value={previousDatabase}
              disabled={disabled}
              onChange={(event) => setPreviousDatabase(event.target.value)}
            >
              <option value={LEGACY_DATABASE}>Original A/B round</option>
              <option value={roundDatabase('eval')}>2026-10-05 A/B — default request</option>
              <option value={roundDatabase('enable-only')}>
                2026-10-05 A/B — enable-only experiment
              </option>
            </select>
          </label>
          <button type="button" disabled={disabled} onClick={() => void exportPrevious()}>
            Export previous-round report
          </button>
          {notice && <p role="status">{notice}</p>}
        </details>
      }
    />
  );
}
export default function RoundApp() {
  const [mode, setMode] = useState<RegistrationMode>('eval');
  const [opened, setOpened] = useState<{ mode: RegistrationMode; controller: CheckerController }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    let owned: CheckerController | undefined;
    setFailed(false);
    void createCheckerController({
      build: BUILD_INFO,
      newRun: (build, environment) => ({
        ...createRun(build, environment),
        flow: GUIDED_ROUND,
        registrationMode: mode,
      }),
      openStore: () => openCheckerStore(globalThis.indexedDB, guidedDatabase(mode)),
      deleteStore: (onBlocked) =>
        deleteCheckerStore(globalThis.indexedDB, guidedDatabase(mode), onBlocked),
    })
      .then((controller) => {
        if (!current) controller.close();
        else {
          owned = controller;
          setOpened({ mode, controller });
        }
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
      owned?.close();
    };
  }, [mode]);
  if (failed)
    return (
      <main className="checker">
        <h1>Check your passkeys</h1>
        <p role="alert">The checker could not start. No passkey operation was started.</p>
        <p>Saved results have not been deliberately cleared.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload checker
        </button>
      </main>
    );
  if (!opened || opened.mode !== mode)
    return (
      <main className="checker">
        <h1>Check your passkeys</h1>
        <p role="status">Opening browser-local progress…</p>
      </main>
    );
  return <CurrentRound key={mode} controller={opened.controller} mode={mode} onMode={setMode} />;
}
