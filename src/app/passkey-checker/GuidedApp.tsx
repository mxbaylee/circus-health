import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CheckerController } from './controller';
import { checkSupport } from './environment';
import { reportMarkdown } from './report';
import { ENVIRONMENT_FIELDS, ERROR_MESSAGES } from './types';
import type { Attempt, EnvironmentField } from './types';
import {
  actionKey,
  allGuidedCredentialsVerified,
  guidedRows,
  guidedStepUnavailable,
  isGuidedVerification,
  latestFor,
  nextGuidedAction,
} from './guided';
import type { GuidedAction } from './guided';

const fieldNames: Record<EnvironmentField, string> = {
  browser: 'Browser',
  browserVersion: 'Browser version',
  os: 'Operating system',
  osVersion: 'Operating-system version',
  provider: 'Passkey provider',
  providerVersion: 'Provider version',
};
function title(action: GuidedAction): string {
  if (action.step === 'create')
    return `Create ${action.alias}${action.alias === 'B' ? ' — same username as A' : action.alias === 'C' ? ' — changed username' : ''}`;
  if (action.step === 'confirm') return `Verify ${action.alias}`;
  if (action.step === 'recover')
    return `Check ${action.alias} still works after this creation problem`;
  return `Recheck ${action.alias} — final verification`;
}
function outcome(attempt: Attempt | undefined): string {
  if (!attempt) return 'Not attempted';
  if (attempt.status === 'created') return 'Created — verify it next.';
  if (attempt.status === 'verified') return 'Verified PRF and original fictional decryption.';
  if (attempt.status === 'skipped') return 'Skipped by you — no automatic pass.';
  if (attempt.status === 'interrupted')
    return 'Interrupted — the native outcome is unknown. A provider passkey may still have been created.';
  if (attempt.status === 'pending') return 'Follow your browser’s passkey prompt…';
  return `Failed — ${attempt.error ? ERROR_MESSAGES[attempt.error] : 'Keep the report for investigation.'}`;
}
export function downloadReport(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
export default function GuidedApp({
  controller,
  settings,
  previous,
  support: suppliedSupport,
}: {
  controller: CheckerController;
  settings?: ReactNode;
  previous?: ReactNode;
  /** Controlled UI fixtures only; the published app always uses the real secure-context check. */
  support?: ReturnType<typeof checkSupport>;
}) {
  const { state, currentBuild, busy, storage, warning, canRun } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const next = nextGuidedAction(state);
  const nextKey = next ? actionKey(next) : 'download';
  const rows = guidedRows(state);
  const activeIndex = rows.findIndex((row) => actionKey(row) === nextKey);
  const visibleRows = next
    ? rows.filter((row, index) => index <= activeIndex || latestFor(state, row))
    : rows;
  const active = useRef<HTMLElement>(null);
  const initial = useRef(true);
  const wasBusy = useRef(false);
  const lastKey = useRef(nextKey);
  const [notice, setNotice] = useState('');
  const [receipt, setReceipt] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [note, setNote] = useState('');
  const report = useMemo(() => reportMarkdown(state), [state]);
  const unchangedExport = receipt !== undefined && receipt === report;
  const disabled = busy || storage === 'saving' || clearing;
  const support = suppliedSupport ?? checkSupport();
  useEffect(() => {
    // Do not steal focus while entering environment labels or on the initial page load.
    if (!initial.current && !disabled && (lastKey.current !== nextKey || wasBusy.current))
      active.current?.focus();
    if (!disabled) lastKey.current = nextKey;
    wasBusy.current = busy;
    initial.current = false;
  }, [nextKey, busy, disabled]);
  useEffect(() => {
    if (!unchangedExport) setSaved(false);
  }, [unchangedExport]);
  function exportCurrent() {
    setNotice('');
    setSaved(false);
    setReceipt(undefined);
    try {
      downloadReport(report, 'passkey-checker-report.md');
      setReceipt(report);
      setNotice('Download requested. Check that the file was saved before clearing this run.');
    } catch {
      setNotice('The download could not be started. Your results have not been cleared.');
    }
  }
  return (
    <main className="checker">
      <header>
        <p className="checker-eyebrow">Circus Health · fictional compatibility checker</p>
        <h1>Check three passkeys, step by step</h1>
        <p>
          A → verify A → B with the same username → verify B → C with a changed username → verify C
          → recheck A/B/C.
        </p>
        <p className="checker-source">
          Build {currentBuild.version} · {currentBuild.revision} · {currentBuild.worktree}
        </p>
        <p>
          All three belong to one fictional account on <strong>{state.run.rpId}</strong>. No health
          records or recovery phrase are needed.
        </p>
      </header>
      <section className="checker-panel" aria-labelledby="guided-environment">
        <h2 id="guided-environment">Before you start</h2>
        <p>
          Use the same browser and provider throughout this run. Leave unknown versions blank.
          Labels lock after the first step; a different provider needs its own run.
        </p>
        <div className="checker-fields">
          {ENVIRONMENT_FIELDS.map((key) => (
            <label key={key}>
              {fieldNames[key]}
              <input
                value={state.run.environment[key].value}
                placeholder="Unknown"
                maxLength={200}
                disabled={
                  busy ||
                  clearing ||
                  !['saved', 'saving', 'ephemeral'].includes(storage) ||
                  state.attempts.length > 0
                }
                onChange={(event) =>
                  void controller.updateEnvironment({ [key]: event.target.value })
                }
              />
              <span className="checker-source">{state.run.environment[key].source}</span>
            </label>
          ))}
        </div>
        {settings}
        <p>
          A/B have identical usernames. C changes only the username; the display name and underlying
          account ID stay the same. Existing credentials stay excluded. No step changes providers or
          removes duplicate protection for you.
        </p>
        {!support.supported && <p role="alert">{support.reason}</p>}
      </section>
      <section className="checker-storage" aria-label="Local progress">
        <p>
          {storage === 'saved'
            ? 'Progress saved in this browser.'
            : storage === 'saving'
              ? 'Saving local progress…'
              : storage === 'ephemeral'
                ? 'Unsaved testing — download before leaving.'
                : 'Local progress needs attention.'}
        </p>
        {warning && <p role="alert">{warning}</p>}
        {storage === 'conflict' && (
          <button type="button" onClick={() => window.location.reload()}>
            Reload saved progress
          </button>
        )}
        {['unavailable', 'incompatible'].includes(storage) && (
          <button type="button" disabled={disabled} onClick={() => controller.continueInMemory()}>
            Continue without saving
          </button>
        )}
      </section>
      <div role="status" aria-live="polite" className="checker-live">
        {clearing
          ? 'Clearing this run. Other rounds and provider passkeys are not removed.'
          : busy
            ? 'Follow the native prompt. There are no automatic retries.'
            : notice ||
              (next ? `Next: ${title(next)}` : 'Walkthrough finished. Review and download below.')}
      </div>
      <section aria-labelledby="guided-steps">
        <h2 id="guided-steps">Follow the next button down the page</h2>
        <p>
          Verification checks encryption, not just a successful prompt. After a failure, retry or
          explicitly continue without a pass. Recovery checks stay directly below the failed
          creation.
        </p>
        {visibleRows.map((action) => {
          const key = actionKey(action);
          const isActive = key === nextKey;
          const latest = latestFor(state, action);
          const unavailable = guidedStepUnavailable(state, action.alias, action.step);
          const attempts = state.attempts.filter(
            (row) =>
              row.alias === action.alias &&
              row.step === action.step &&
              row.afterAttemptId === action.afterAttemptId,
          );
          const linked = state.attempts.find((row) => row.id === action.afterAttemptId);
          const valid = latest?.status !== 'verified' || isGuidedVerification(state, latest);
          return (
            <section
              key={key}
              className="checker-panel"
              aria-label={title(action)}
              tabIndex={-1}
              ref={isActive ? active : undefined}
              aria-current={isActive ? 'step' : undefined}
            >
              <h3>{title(action)}</h3>
              {linked && (
                <p>
                  After {linked.alias} creation, operation {linked.sequence}. Check the original
                  saved passkey; do not create it again.
                </p>
              )}
              <p className={latest?.status === 'failed' ? 'checker-error' : undefined}>
                {!valid
                  ? 'Saved result is not a qualifying final or recovery check.'
                  : latest
                    ? outcome(latest)
                    : unavailable || 'Not attempted yet.'}
              </p>
              {isActive && (
                <>
                  {action.step === 'create' && (
                    <p>
                      {action.alias === 'B'
                        ? 'Choose the same account username as A.'
                        : action.alias === 'C'
                          ? 'This request changes the username, not the account ID.'
                          : 'Create the first fictional test credential.'}
                    </p>
                  )}
                  {action.step === 'confirm' && (
                    <p>
                      Use the passkey just created. A retry confirms that same credential; it does
                      not enroll another one.
                    </p>
                  )}
                  {action.step === 'recheck' && (
                    <p>
                      Use the original {action.alias}. This must decrypt its retained original value
                      after all registration attempts.
                    </p>
                  )}
                  <div className="checker-actions">
                    <button
                      type="button"
                      disabled={disabled || !canRun || !support.supported}
                      onClick={() => {
                        setNotice('');
                        void controller.runStep(action.alias, action.step);
                      }}
                    >
                      {latest && ['failed', 'interrupted'].includes(latest.status)
                        ? `Retry: ${title(action)}`
                        : title(action)}
                    </button>
                    <button
                      type="button"
                      disabled={disabled || !canRun}
                      onClick={() => {
                        setNotice('');
                        void controller.skipStep?.(action.alias, action.step);
                      }}
                    >
                      Continue without this check
                    </button>
                  </div>
                </>
              )}
              {attempts.length > 0 && (
                <details>
                  <summary>Attempt history ({attempts.length})</summary>
                  <ol>
                    {attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {outcome(attempt)}{' '}
                        <span className="checker-source">
                          Operation {attempt.sequence}; {attempt.finishedAt ?? attempt.startedAt}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </section>
          );
        })}
      </section>
      <section
        className="checker-panel"
        aria-labelledby="guided-download"
        tabIndex={-1}
        ref={!next ? active : undefined}
      >
        <h2 id="guided-download">Download and finish</h2>
        <p>
          {allGuidedCredentialsVerified(state)
            ? 'All three original credentials passed their final checks.'
            : 'Partial or failed coverage is useful. Missing, skipped and failed steps are not passes.'}
        </p>
        <p>
          This is a sequential username experiment, not proof that a name caused any result. It does
          not qualify production authentication, recovery or localhost access.
        </p>
        <label>
          Optional note — no secrets or health information
          <textarea
            value={note}
            maxLength={2000}
            disabled={disabled || !canRun}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={disabled || !canRun || !note.trim()}
          onClick={() => {
            void controller
              .addObservation({ alias: 'A', step: 'general', outcome: 'could-not-test', note })
              .then(() => setNote(''));
          }}
        >
          Save note
        </button>
        <p>
          Download is available even when the walkthrough or storage fails. A note changes the
          report; download again before clearing.
        </p>
        <button type="button" disabled={disabled || Boolean(note.trim())} onClick={exportCurrent}>
          Download this report
        </button>
        {note.trim() && <p>Save or remove the unfinished note before downloading or clearing.</p>}
        {unchangedExport && (
          <fieldset className="checker-reset">
            <legend>Clear only after saving</legend>
            <label>
              <input
                type="checkbox"
                checked={saved}
                disabled={disabled}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have saved this report
            </label>
            <p>
              Clear removes this run’s local results only. It does not delete any passkeys from your
              provider or any previous-round results.
            </p>
            <button
              type="button"
              disabled={!saved || disabled || Boolean(note.trim()) || storage === 'conflict'}
              onClick={() => {
                if (!saved || !unchangedExport || disabled || note.trim()) return;
                setClearing(true);
                const oldId = state.run.id;
                void controller
                  .reset()
                  .then(() => {
                    const after = controller.getSnapshot();
                    setReceipt(undefined);
                    setSaved(false);
                    setNotice(
                      after.state.run.id !== oldId
                        ? 'This run was cleared. Provider passkeys and previous rounds remain.'
                        : 'The run could not be cleared. Results have not been reported as cleared.',
                    );
                  })
                  .catch(() =>
                    setNotice('Clear failed. Keep the downloaded report and visible results.'),
                  )
                  .finally(() => setClearing(false));
              }}
            >
              Clear this run
            </button>
          </fieldset>
        )}
        {previous}
      </section>
    </main>
  );
}
