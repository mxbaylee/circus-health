import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CheckerController } from './controller.ts';
import { checkSupport } from './environment.ts';
import { canResumeConfirmation, guidedPlan, guidedSummary } from './guided.ts';
import SkipStep from './SkipStep.tsx';
import { downloadReport } from './download.ts';
import { reportMarkdown } from './report.ts';
import { openCheckerStore } from './store.ts';
import { LEGACY_DATABASE, roundDatabase } from './round.ts';
import type { RegistrationMode } from './round.ts';
import { ENVIRONMENT_FIELDS, ERROR_MESSAGES } from './types.ts';
import type { CredentialAlias } from './types.ts';

const fieldNames = {
  browser: 'Browser',
  browserVersion: 'Browser version',
  os: 'Operating system',
  osVersion: 'Operating-system version',
  provider: 'Passkey provider',
  providerVersion: 'Provider version',
};
const previousRounds = [
  ['Original A/B round', LEGACY_DATABASE],
  ['October 5 · default request', roundDatabase('eval')],
  ['October 5 · enable-only experiment', roundDatabase('enable-only')],
] as const;

export default function GuidedApp({
  controller,
  mode,
  onMode,
  supportCheck = checkSupport,
}: {
  controller: CheckerController;
  /** Controlled UI fixtures only; the shipped round always uses checkSupport. */
  supportCheck?: typeof checkSupport;
  mode: RegistrationMode;
  onMode(mode: RegistrationMode): void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state, busy, storage, warning, canRun, currentBuild } = snapshot;
  const plan = guidedPlan(state);
  const current = plan.find((row) => row.active);
  const blocked = busy || storage === 'saving' || !canRun;
  const support = supportCheck();
  const [notice, setNotice] = useState('');
  const [downloaded, setDownloaded] = useState<string>();
  const [savedReport, setSavedReport] = useState(false);
  const [note, setNote] = useState('');
  const [noteAlias, setNoteAlias] = useState<CredentialAlias>('A');
  const [previousBusy, setPreviousBusy] = useState(false);
  const [previousRound, setPreviousRound] = useState<string>(LEGACY_DATABASE);
  const activeButton = useRef<HTMLButtonElement>(null);
  const finishHeading = useRef<HTMLHeadingElement>(null);
  const userAdvanced = useRef(false);
  const lastFocused = useRef('');
  const report = reportMarkdown(state);
  const canClear =
    !blocked && !previousBusy && savedReport && downloaded === report && !note.trim();
  useEffect(() => {
    if (downloaded !== report) setSavedReport(false);
  }, [downloaded, report]);
  useEffect(() => {
    const key = `${state.run.id}:${current?.key ?? 'finish'}`;
    if (blocked || !userAdvanced.current || lastFocused.current === key) return;
    const target = current ? activeButton.current : finishHeading.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'center' });
    lastFocused.current = key;
  }, [current?.key, blocked, state.run.id]);

  const act = (skip: boolean) => {
    if (!current || blocked) return;
    userAdvanced.current = true;
    setNotice('');
    // Calling runStep here, before any await, preserves the button's native user gesture.
    const operation = skip
      ? controller.skipStep?.(current.alias, current.step, current.afterAttemptId)
      : controller.runStep(current.alias, current.step, current.afterAttemptId);
    void operation?.catch(() =>
      setNotice('This step could not finish. Keep the available report; no pass is assumed.'),
    );
  };
  const exportCurrent = () => {
    try {
      const text = reportMarkdown(controller.exportModel());
      downloadReport(text, 'passkey-checker-report.md');
      setDownloaded(text);
      setSavedReport(false);
      setNotice('Download requested. Check that the file was saved before clearing this run.');
    } catch {
      setDownloaded(undefined);
      setSavedReport(false);
      setNotice('Download could not be started. Your results are still here; retry the download.');
    }
  };
  const exportPrevious = async () => {
    if (blocked || previousBusy) return;
    setPreviousBusy(true);
    let store: Awaited<ReturnType<typeof openCheckerStore>> | undefined;
    try {
      store = await openCheckerStore(globalThis.indexedDB, previousRound);
      const retained = await store.load();
      if (!retained) {
        setNotice('No saved report exists in that previous round.');
        return;
      }
      downloadReport(reportMarkdown(retained.state), 'passkey-checker-previous-round.md');
      setNotice(
        'Previous-round download requested. The current run and old results are unchanged.',
      );
    } catch {
      setNotice('That previous report could not be read or downloaded. No results were cleared.');
    } finally {
      store?.close();
      setPreviousBusy(false);
    }
  };

  return (
    <main className="checker">
      <header className="checker-intro">
        <p className="checker-eyebrow">Circus Health · fictional compatibility check</p>
        <h1>Check three passkeys</h1>
        <p>
          Create and verify A, try B with the same username, then try C with a changed username.
          Finally check which original passkeys still work.
        </p>
        <p className="checker-source">
          Build {currentBuild.version} · {currentBuild.revision} · {currentBuild.worktree}
        </p>
        <p>
          Only fictional test data is used. These passkeys belong to {state.run.rpId}, not your
          household installation. No provider compatibility or real-app release is assumed.
        </p>
      </header>
      <section className="checker-panel" aria-labelledby="guided-environment">
        <h2 id="guided-environment">Before you start</h2>
        <p>
          Use the same browser and provider throughout this run. Leave unknown versions blank. Names
          are your observations, not detected provider identities.
        </p>
        <div className="checker-fields">
          {ENVIRONMENT_FIELDS.map((key) => (
            <label key={key}>
              {fieldNames[key]}
              <input
                value={state.run.environment[key].value}
                placeholder="Unknown"
                maxLength={200}
                disabled={busy || state.attempts.length > 0 || !canRun}
                onChange={(event) =>
                  void controller.updateEnvironment({ [key]: event.target.value })
                }
              />
              <span className="checker-source">{state.run.environment[key].source}</span>
            </label>
          ))}
        </div>
        <details>
          <summary>Advanced: creation request mode</summary>
          <label>
            Creation request
            <select
              value={mode}
              disabled={blocked || previousBusy || !!note.trim()}
              onChange={(event) => {
                if (event.target.value === 'eval' || event.target.value === 'enable-only')
                  onMode(event.target.value);
              }}
            >
              <option value="eval">App-style creation (default)</option>
              <option value="enable-only">Experiment: enable PRF, evaluate at confirmation</option>
            </select>
          </label>
          <p>
            Modes have separate saved runs. The default requests creation-time PRF evaluation, as
            the app does; the experiment omits only that evaluation. Neither reproduces backend
            verification or the app's multi-credential unlock picker.
          </p>
        </details>
        <p>
          A and B use the same native username. C changes only that username; all three keep the
          same account ID and display name. Existing credentials remain excluded. A later result
          alone cannot prove that naming caused it, because the credential store may have changed.
        </p>
      </section>
      <section className="checker-storage" aria-label="Local progress">
        <p>
          {storage === 'saved'
            ? 'Progress saved in this browser.'
            : storage === 'saving'
              ? 'Saving progress…'
              : storage === 'ephemeral'
                ? 'Not saving progress. Download before leaving.'
                : 'Local progress needs attention.'}
        </p>
        {warning && <p role="alert">{warning}</p>}
        {(storage === 'unavailable' || storage === 'incompatible') && (
          <button type="button" disabled={busy} onClick={() => controller.continueInMemory()}>
            Continue without saving
          </button>
        )}
        {storage === 'conflict' && (
          <p>
            Another tab changed this run. Download this tab's report, then reload. Testing and
            clearing are stopped to protect the other tab's progress.
          </p>
        )}
        {!support.supported && (
          <p role="alert">{support.reason} You can still download available results.</p>
        )}
      </section>
      <div className="checker-live" role="status" aria-live="polite">
        {busy
          ? 'Follow the browser prompt. No other step will start automatically.'
          : 'Continue down the page, one button at a time.'}
      </div>
      <section aria-label="Guided passkey steps">
        {plan.map((row) => {
          const future = row.result.startsWith('waiting');
          const error = row.attempt?.error;
          return (
            <section
              key={row.key}
              className={`checker-panel checker-guided-step${future ? ' checker-guided-future' : ''}`}
              aria-label={row.title}
              aria-current={row.active ? 'step' : undefined}
            >
              <h2>{row.title}</h2>
              <p>
                <strong>
                  {row.result === 'verified'
                    ? 'Verified PRF and fictional decryption'
                    : row.result === 'created'
                      ? 'Created · encryption not verified yet'
                      : row.result === 'skipped'
                        ? 'Skipped · not a pass'
                        : row.result}
                </strong>
              </p>
              {error && <p className="checker-error">{ERROR_MESSAGES[error]}</p>}
              {row.step === 'confirm' &&
                row.attempt?.status === 'skipped' &&
                canResumeConfirmation(state, row.alias) && (
                  <div className="checker-actions">
                    <button
                      type="button"
                      disabled={blocked || !support.supported || previousBusy}
                      onClick={() => {
                        if (blocked || previousBusy) return;
                        userAdvanced.current = true;
                        lastFocused.current = '';
                        setNotice('');
                        // Invoke from this gesture, without awaiting storage or another UI action.
                        void controller
                          .runStep(row.alias, 'confirm', undefined, true)
                          .catch(() =>
                            setNotice('Verification could not finish. Keep this report and retry.'),
                          );
                      }}
                    >
                      {`Verify existing ${row.alias}`}
                    </button>
                    <p>Uses the saved credential and keeps the original skip in your report.</p>
                  </div>
                )}
              {row.active && (
                <>
                  {row.step === 'create' && row.alias !== 'A' && (
                    <p>
                      A provider may refuse another credential because it already holds an excluded
                      one. That does not erase earlier successes or prove the cause of a generic
                      error.
                    </p>
                  )}
                  {row.attempt?.status === 'interrupted' && (
                    <p>
                      The previous prompt was interrupted. A passkey might have been saved by the
                      provider without its reference reaching this page. No success is assumed; a
                      retry is a new attempt.
                    </p>
                  )}
                  {row.step === 'confirm' && (
                    <p>
                      Creation is complete. Choose Verify below to test the saved passkey now. This
                      requests that same credential; it does not create another one.
                    </p>
                  )}
                  {(row.step === 'use-1' || row.step === 'retained') && (
                    <p>
                      This requests the original
                      {` ${row.alias} `}credential and decrypts its retained original ciphertext.
                    </p>
                  )}
                  <div className="checker-actions">
                    <button
                      ref={activeButton}
                      type="button"
                      disabled={blocked || !support.supported || previousBusy}
                      onClick={() => act(false)}
                    >
                      {row.step === 'create'
                        ? `Create ${row.alias}`
                        : row.step === 'confirm'
                          ? `Verify ${row.alias}`
                          : `Recheck ${row.alias}`}
                    </button>
                  </div>
                  <SkipStep
                    key={state.run.id + row.key + (row.attempt?.id ?? '')}
                    title={row.title}
                    disabled={blocked || previousBusy || !controller.skipStep}
                    onSkip={() => act(true)}
                  />
                  <p className="checker-source">
                    Failures and retries remain in the report. Continuing never marks this step
                    successful.
                  </p>
                </>
              )}
            </section>
          );
        })}
      </section>
      <section className="checker-panel" aria-labelledby="guided-finish">
        <h2 id="guided-finish" ref={finishHeading} tabIndex={-1}>
          Download, then clear
        </h2>
        <p role="status" aria-live="polite">
          {notice}
        </p>
        <p role="status">{guidedSummary(state)}</p>
        <p>
          {current
            ? 'You may stop and download a partial report at any time.'
            : 'The guided sequence has ended. Inspect each result; skipped and unavailable steps are not passes.'}
        </p>
        <details>
          <summary>Optional observation</summary>
          <label>
            Passkey for this note
            <select
              value={noteAlias}
              disabled={blocked}
              onChange={(event) => setNoteAlias(event.target.value as CredentialAlias)}
            >
              {(['A', 'B', 'C'] as const).map((alias) => (
                <option key={alias}>{alias}</option>
              ))}
            </select>
          </label>
          <label>
            What did you see?
            <textarea
              value={note}
              maxLength={2000}
              disabled={blocked}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={blocked || !note.trim()}
            onClick={() => {
              const count = state.observations.length;
              void controller
                .addObservation({
                  alias: noteAlias,
                  step: 'general',
                  outcome: 'could-not-test',
                  note,
                })
                .then(() => {
                  if (controller.getSnapshot().state.observations.length > count) setNote('');
                });
            }}
          >
            Save note
          </button>
          <p>
            Keep credential material and real health information out of notes. These are unverified
            observations.
          </p>
        </details>
        {note.trim() && <p>Save the note before downloading so it is included.</p>}
        <button
          type="button"
          disabled={busy || storage === 'saving' || previousBusy || !!note.trim()}
          onClick={exportCurrent}
        >
          Download this report
        </button>
        <div className="checker-reset">
          <label className="checker-confirm-save">
            <input
              type="checkbox"
              checked={savedReport}
              disabled={blocked || downloaded !== report}
              onChange={(event) => setSavedReport(event.target.checked)}
            />
            I've checked that this report was saved
          </label>
          <button
            type="button"
            disabled={!canClear}
            onClick={() => {
              if (!canClear || downloaded !== reportMarkdown(controller.exportModel())) return;
              void controller.reset().then(() => {
                setDownloaded(undefined);
                setSavedReport(false);
                userAdvanced.current = false;
                setNotice(
                  controller.getSnapshot().state.run.id !== state.run.id
                    ? 'Current run cleared. Previous rounds and provider passkeys were not deleted.'
                    : 'The run could not be cleared. Keep your downloaded report and inspect the storage warning.',
                );
              });
            }}
          >
            Clear this run
          </button>
          <p>
            Clears only this mode's current browser-local run, not previous rounds or passkeys saved
            in 1Password, Google, or another provider. A requested download is not proof of a saved
            file.
          </p>
        </div>
        <details>
          <summary>Previous results · not this run</summary>
          <label>
            Previous round
            <select
              value={previousRound}
              disabled={blocked || previousBusy}
              onChange={(event) => setPreviousRound(event.target.value)}
            >
              {previousRounds.map(([label, database]) => (
                <option key={database} value={database}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={blocked || previousBusy}
            onClick={() => void exportPrevious()}
          >
            Download selected previous report
          </button>
        </details>
        <details>
          <summary>Complete attempt history</summary>
          <pre className="checker-report-preview">{report}</pre>
        </details>
      </section>
    </main>
  );
}
