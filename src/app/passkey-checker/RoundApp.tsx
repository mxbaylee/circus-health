import { useEffect, useState, useSyncExternalStore } from 'react';
import App from './App';
import { BUILD_INFO } from './build';
import { createCheckerController } from './controller';
import type { CheckerController } from './controller';
import * as core from './core';
import { reportMarkdown } from './report';
import { deleteCheckerStore, openCheckerStore } from './store';
import { LEGACY_DATABASE, roundDatabase, TEST_ROUND } from './round';
import type { RegistrationMode } from './round';

function downloadReport(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Leave the object alive long enough for the browser's download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

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
  const disabled = snapshot.busy || snapshot.storage === 'saving' || exporting;
  async function exportPrevious() {
    setExporting(true);
    setNotice('');
    let previous: Awaited<ReturnType<typeof openCheckerStore>> | undefined;
    try {
      previous = await openCheckerStore(globalThis.indexedDB, LEGACY_DATABASE);
      const retained = await previous.load();
      if (!retained) setNotice('No previous-round results are saved in this browser.');
      else {
        downloadReport(reportMarkdown(retained.state), 'passkey-checker-previous-round.md');
        setNotice(
          'Previous-round report prepared. Its results were not changed or copied into this round.',
        );
      }
    } catch {
      setNotice('Previous-round results could not be read. They were not deleted or replaced.');
    } finally {
      previous?.close();
      setExporting(false);
    }
  }
  return (
    <>
      <section className="checker" aria-label="Diagnostic testing round">
        <h2>New diagnostic round: {TEST_ROUND}</h2>
        <p>
          Active results start fresh for this round. Previous-round browser storage and all
          provider passkeys are left intact. Results in each request mode resume independently
          after reload. Export each mode separately; this is not a combined compatibility pass.
        </p>
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
          The experiment omits only the optional PRF evaluation during creation. Confirmation,
          exact credential matching, required user verification, exclusions, salts and fresh
          decryption checks remain mandatory. It is not an established provider fix. Each mode
          has a separate fictional profile; switching modes does not create a second passkey for
          the same profile. Test A and B together within one mode.
        </p>
        <p>
          After a confirmation failure, retry confirmation of the existing test passkey; do not
          create it again. After a failed B creation, use the separate fresh A recovery check.
          Download reports even when a step fails. For a visible format message, record which
          screen or field, expected format and actual format, without secrets or credential IDs.
        </p>
        <button type="button" disabled={disabled} onClick={() => void exportPrevious()}>
          Export previous-round report
        </button>
        {notice && <p role="status">{notice}</p>}
      </section>
      <App controller={controller} />
    </>
  );
}

/** Mode selection changes only the native creation request, never the credential API. */
export default function RoundApp() {
  const [mode, setMode] = useState<RegistrationMode>('eval');
  const [opened, setOpened] = useState<{
    mode: RegistrationMode;
    controller: CheckerController;
  }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    let owned: CheckerController | undefined;
    setFailed(false);
    void createCheckerController({
      build: BUILD_INFO,
      openStore: () => openCheckerStore(globalThis.indexedDB, roundDatabase(mode)),
      deleteStore: (onBlocked) =>
        deleteCheckerStore(globalThis.indexedDB, roundDatabase(mode), onBlocked),
      core: {
        ...core,
        createCredential: (run, alias, existing, port, observer) =>
          core.createCredential(run, alias, existing, port, observer, mode),
      },
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
