import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CheckerController } from './controller';
import { checkSupport } from './environment';
import { isVerifiedReturnToA, reportMarkdown } from './report';
import { isVerifiedAAfterFailedB } from './progress';
import { ERROR_MESSAGES, ENVIRONMENT_FIELDS, stepsForAlias } from './types';
import type { CredentialAlias, EnvironmentField, ErrorCode, Observation, Step } from './types';

const stepNames: Record<Step, string> = {
  create: 'Create a test passkey',
  confirm: 'Confirm the test passkey',
  'use-1': 'Use it again: 1 of 3',
  'use-2': 'Use it again: 2 of 3',
  'use-3': 'Use it again: 3 of 3',
  'use-after-b': 'Use A after B is created',
  'use-after-b-failed': 'Use A after B creation fails',
  recheck: 'Final fresh verification',
  recover: 'Check retained access',
};
const fieldNames: Record<EnvironmentField, string> = {
  browser: 'Browser',
  browserVersion: 'Browser version',
  os: 'Operating system',
  osVersion: 'Operating-system version',
  provider: 'Passkey provider',
  providerVersion: 'Provider version',
};
const provenance = {
  'browser-reported': 'Browser reported',
  operator: 'Manually observed',
  unknown: 'Unknown',
};
const outcomeNames = { worked: 'Worked', failed: 'Failed', 'could-not-test': "Couldn't test" };

function nextAction(alias: CredentialAlias, step: Step, error: ErrorCode): string | undefined {
  if (error === 'wrong-credential')
    return `Retry and choose the saved test passkey ${alias} in the native prompt. The returned passkey was not accepted. Labels can help selection, but do not prove that a provider will return the requested passkey.`;
  if (error === 'prf-absent')
    return 'This attempt returned no encryption result. Check the browser and provider labels, retain the failed report, and try again only when you can select the intended passkey. This result alone does not establish that every version of this provider is unsupported.';
  if (error === 'prf-invalid')
    return 'An encryption result was present but could not be used. Keep this failed report for diagnosis; do not treat a successful prompt as confirmation. Record any visible format message in your notes without including secrets.';
  if (error === 'missing-prf')
    return 'This older result did not distinguish an absent encryption result from an unusable one. Retain it and record a fresh attempt for clearer evidence.';
  if (alias === 'B' && step === 'create' && error === 'invalid-state')
    return "A provider already holding A may refuse this second creation because the checker asks it to avoid registering A again. That is a possible explanation, not a confirmed cause. Keep A, check A again with the separate failed-creation step, and try another available authenticator after reviewing the provider labels, or record Couldn't test.";
  if (alias === 'B' && step === 'create' && error === 'unknown-error')
    return "The cause of this second-creation failure is unknown. Check which authenticator you selected and retain the report. Keep A and check it again with the separate failed-creation step. Try another available authenticator after reviewing the provider labels, or record Couldn't test; this result does not establish an exclusion refusal.";
  return undefined;
}

function ObservationForm({
  alias,
  controller,
  disabled,
}: {
  alias: CredentialAlias;
  controller: CheckerController;
  disabled: boolean;
}) {
  const [step, setStep] = useState<Observation['step']>('general');
  const [outcome, setOutcome] = useState<Observation['outcome']>('could-not-test');
  const [note, setNote] = useState('');
  return (
    <form
      className="checker-observation"
      onSubmit={(event) => {
        event.preventDefault();
        const previousCount = controller.getSnapshot().state.observations.length;
        void controller.addObservation({ alias, step, outcome, note }).then(() => {
          if (controller.getSnapshot().state.observations.length > previousCount) setNote('');
        });
      }}
    >
      <h3>Your observation</h3>
      <p>Record what you saw. This never changes the automatic result.</p>
      <div className="checker-fields">
        <label>
          Step for passkey {alias}
          <select
            value={step}
            disabled={disabled}
            onChange={(event) => setStep(event.target.value as Observation['step'])}
          >
            <option value="general">General / unavailable passkey</option>
            {stepsForAlias(alias).map((item) => (
              <option key={item} value={item}>
                {stepNames[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Observed outcome for passkey {alias}
          <select
            value={outcome}
            disabled={disabled}
            onChange={(event) => setOutcome(event.target.value as Observation['outcome'])}
          >
            {Object.entries(outcomeNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Optional notes for passkey {alias}
        <textarea
          value={note}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Keep secrets and real health information out of notes."
        />
      </label>
      <button type="submit" disabled={disabled}>
        Save observation for {alias}
      </button>
    </form>
  );
}

export default function App({ controller }: { controller: CheckerController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { state, currentBuild, busy, storage, warning, canRun } = snapshot;
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const returnResetFocus = useRef(false);
  const [notice, setNotice] = useState('');
  const support = checkSupport();
  useEffect(() => {
    if (confirmReset) confirmButton.current?.focus();
  }, [confirmReset]);
  useEffect(() => {
    if (returnResetFocus.current && !confirmReset && !busy && !resetPending) {
      resetButton.current?.focus();
      returnResetFocus.current = false;
    }
  }, [confirmReset, busy, resetPending]);
  const exportReport = () => {
    const url = URL.createObjectURL(
      new Blob([reportMarkdown(controller.exportModel())], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'passkey-checker-report.md';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Report download requested. It includes partial and failed steps.');
  };
  const blocked = busy || !canRun;
  const bCreated = state.credentials.some((credential) => credential.alias === 'B');
  const aConfirmed = state.credentials.some(
    (credential) => credential.alias === 'A' && credential.cipher,
  );
  const bFailure = state.attempts
    .filter(
      (attempt) =>
        attempt.alias === 'B' && attempt.step === 'create' && attempt.status === 'failed',
    )
    .at(-1);
  const aRecovery = state.attempts
    .filter(
      (attempt) => attempt.step === 'use-after-b-failed' && attempt.afterAttemptId === bFailure?.id,
    )
    .at(-1);
  return (
    <main className="checker">
      <header className="checker-intro">
        <p className="checker-eyebrow">Circus Health · compatibility tool</p>
        <h1>Check your passkeys</h1>
        <p>
          Try a passkey with fictional test material, then download a clear report of what worked.
          Each button opens your browser's real passkey prompt.
        </p>
        <p>
          Passkeys here are scoped to <strong>{state.run.rpId}</strong>. Testing this page does not
          establish access to your household installation. No health records or recovery phrase are
          needed.
        </p>
      </header>
      <section className="checker-panel" aria-labelledby="environment-title">
        <h2 id="environment-title">1. Check this browser and provider</h2>
        <p className="checker-capability">
          Native secure-context check:{' '}
          <strong>{support.supported ? 'Available' : 'Unavailable'}</strong>
          {support.reason && ` — ${support.reason}`} This is a starting check, not proof of PRF
          compatibility.
        </p>
        <p>
          Correct any labels you know; leave the rest empty for Unknown. Provider names and versions
          are manually observed, not detected proof.
        </p>
        <div className="checker-fields">
          {ENVIRONMENT_FIELDS.map((key) => (
            <div key={key}>
              <label htmlFor={`environment-${key}`}>{fieldNames[key]}</label>
              <input
                id={`environment-${key}`}
                aria-describedby={`environment-${key}-source`}
                value={
                  state.run.environment[key].source === 'unknown'
                    ? ''
                    : state.run.environment[key].value
                }
                placeholder="Unknown"
                maxLength={200}
                disabled={blocked}
                onChange={(event) => {
                  void controller.updateEnvironment({ [key]: event.target.value });
                }}
              />
              <span className="checker-source" id={`environment-${key}-source`}>
                {provenance[state.run.environment[key].source]}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="checker-storage" aria-label="Local progress">
        <p>
          <strong>
            {storage === 'saved'
              ? 'Progress saved in this browser'
              : storage === 'saving'
                ? 'Saving local progress…'
                : storage === 'ephemeral'
                  ? 'Progress is not saved — export before leaving'
                  : 'Local progress needs attention'}
          </strong>
        </p>
        {warning && <p role="alert">{warning}</p>}
        {storage === 'conflict' && (
          <p>
            Download the available report before reloading to use the other tab's saved progress.{' '}
            <button type="button" onClick={() => window.location.reload()}>
              Reload saved progress
            </button>
          </p>
        )}
        {(storage === 'unavailable' || storage === 'incompatible') && (
          <button type="button" onClick={() => controller.continueInMemory()}>
            Continue without saving
          </button>
        )}
        <p>
          Progress stays here and is never sent to a server or shared across browsers or devices.
          Clearing browser data, storage eviction or ending a private session can lose it. A missing
          history cannot tell us why it was lost.
        </p>
      </section>
      <div role="status" aria-live="polite" className="checker-live">
        {resetPending
          ? 'Resetting local progress. This cannot be cancelled; keep this page open until it finishes.'
          : busy
            ? 'A passkey request is in progress. Follow your browser prompt.'
            : notice || 'Ready for your next step.'}
      </div>
      <section aria-labelledby="test-title">
        <h2 id="test-title">2. Try each passkey</h2>
        <p>
          Start with A. Confirm it, then make three fresh uses. Creation alone does not prove PRF
          compatibility: confirmation establishes encrypted fictional material, and each later use
          must decrypt and match it.
        </p>
        <p>
          A and B belong to the same fictional profile. New native prompts use “Fictional
          compatibility test — passkey A” or “Fictional compatibility test — passkey B” to help
          selection. Providers may group or ignore these labels, and older saved passkeys may have
          identical labels. These labels are selection aids, not a proven fix for provider selection
          failures.
        </p>
        {(['A', 'B'] as const).map((alias) => {
          const attempts = state.attempts.filter((attempt) => attempt.alias === alias);
          const observations = state.observations.filter(
            (observation) => observation.alias === alias,
          );
          const complete = stepsForAlias(alias)
            .slice(1)
            .filter((step) => step !== 'use-after-b' && step !== 'use-after-b-failed')
            .every(
              (step) =>
                attempts.filter((attempt) => attempt.step === step).at(-1)?.status === 'verified',
            );
          const returnToA = attempts.filter((attempt) => attempt.step === 'use-after-b').at(-1);
          return (
            <article className="checker-panel" key={alias} aria-labelledby={`passkey-${alias}`}>
              <h3 id={`passkey-${alias}`}>
                Passkey {alias}
                {alias === 'B' ? ' · optional second credential' : ''}
              </h3>
              {alias === 'B' && (
                <p>
                  To create B for this same fictional profile, choose another available
                  authenticator that does not already hold A. A synced copy of A is not a distinct
                  authenticator. Review the provider labels above before switching; each attempt
                  retains the labels used at that moment. Keep A in place. If another authenticator
                  is unavailable, record Couldn't test below. A distinct returned credential does
                  not by itself prove another physical device or provider.
                </p>
              )}
              <p>
                <strong>
                  Automatic result:{' '}
                  {complete
                    ? 'Initial confirmation and all three fresh uses verified'
                    : 'Incomplete — inspect each step below'}
                </strong>
              </p>
              {alias === 'A' && (
                <p>
                  <strong>
                    A retained after B creation:{' '}
                    {!bCreated
                      ? 'Not tested — B has not been created.'
                      : returnToA && isVerifiedReturnToA(state, returnToA)
                        ? 'Verified — A decrypted its retained fictional value after B was created.'
                        : returnToA?.status === 'verified'
                          ? 'Not verified — saved evidence does not establish a return to A after B creation.'
                          : returnToA?.status === 'failed'
                            ? 'Failed — inspect the return-to-A step below.'
                            : returnToA?.status === 'interrupted'
                              ? 'Interrupted — not verified.'
                              : returnToA?.status === 'pending'
                                ? 'Waiting for the browser prompt.'
                                : 'Not yet verified — use A after B is created.'}
                  </strong>
                  {bCreated && (
                    <>
                      {' '}
                      {aConfirmed
                        ? 'You can check A now even if B confirmation failed or is unfinished.'
                        : 'Confirm A first, then check it again. B does not need to be confirmed for this check.'}
                    </>
                  )}
                </p>
              )}
              {alias === 'A' && bFailure && (
                <p>
                  <strong>
                    A retained after failed B creation:{' '}
                    {aRecovery && isVerifiedAAfterFailedB(state, aRecovery)
                      ? 'Verified — A decrypted its original fictional value after this B creation failed.'
                      : aRecovery?.status === 'failed'
                        ? 'Failed — inspect the recovery check below.'
                        : aRecovery?.status === 'interrupted'
                          ? 'Interrupted — not verified.'
                          : aRecovery?.status === 'pending'
                            ? 'Waiting for the browser prompt.'
                            : 'Not yet verified — check A with a fresh prompt.'}
                  </strong>{' '}
                  This refers to B's failed creation at {bFailure.finishedAt ?? bFailure.startedAt}.
                  It does not prove B works or complete two-credential enrollment.
                </p>
              )}
              <ol className="checker-steps">
                {stepsForAlias(alias).map((step) => {
                  const history = attempts.filter((attempt) => attempt.step === step);
                  const latest =
                    step === 'use-after-b-failed'
                      ? history.filter((attempt) => attempt.afterAttemptId === bFailure?.id).at(-1)
                      : history.at(-1);
                  const verified =
                    latest?.status === 'verified' &&
                    (step !== 'use-after-b' || isVerifiedReturnToA(state, latest)) &&
                    (step !== 'use-after-b-failed' || isVerifiedAAfterFailedB(state, latest));
                  return (
                    <li key={step}>
                      <div className="checker-step-heading">
                        <strong>{stepNames[step]}</strong>
                        <button
                          type="button"
                          disabled={
                            blocked || !support.supported || !controller.canRunStep(alias, step)
                          }
                          onClick={() => {
                            setNotice('');
                            void controller.runStep(alias, step);
                          }}
                        >
                          {verified || latest?.status === 'created'
                            ? 'Completed:'
                            : history.length
                              ? 'Retry'
                              : 'Start'}{' '}
                          {stepNames[step].toLowerCase()} for {alias}
                        </button>
                      </div>
                      {step === 'use-after-b' && (
                        <p>
                          Once B is created and A is confirmed, select A again to check that it
                          still decrypts its retained fictional value. A's earlier three uses do not
                          pass this check. Before opening the prompt, review the provider labels
                          above for A; they may still describe B's provider.
                        </p>
                      )}
                      {step === 'use-after-b-failed' && (
                        <p>
                          After B creation fails, select confirmed A again to check its original
                          fictional value without resetting this run. Each new B creation failure
                          needs its own fresh A check; earlier successes do not pass a later check.
                          Keep A and review its provider labels before opening the prompt.
                        </p>
                      )}
                      <p>
                        Automatic evidence:{' '}
                        {latest
                          ? verified
                            ? step === 'confirm'
                              ? 'Valid PRF returned; fictional encryption established.'
                              : 'Fresh PRF decrypted and matched the fictional value.'
                            : latest.status === 'verified'
                              ? step === 'use-after-b-failed'
                                ? 'Saved evidence does not establish an A check after the linked B creation failure.'
                                : 'Saved evidence does not establish a return to A after B creation.'
                              : latest.status === 'created'
                                ? 'Credential created; PRF compatibility is not yet verified.'
                                : latest.status === 'failed'
                                  ? 'Failed.'
                                  : latest.status === 'interrupted'
                                    ? 'Interrupted; not verified.'
                                    : 'Waiting for the browser prompt.'
                          : 'Not attempted.'}
                      </p>
                      {step === 'use-after-b-failed' && latest?.afterAttemptId && (
                        <p>
                          Linked B creation failure:{' '}
                          {state.attempts.find((item) => item.id === latest.afterAttemptId)
                            ?.finishedAt ?? 'Unavailable'}
                          . This check does not verify B.
                        </p>
                      )}
                      {latest?.error && (
                        <>
                          <p className="checker-error">{ERROR_MESSAGES[latest.error]}</p>
                          {nextAction(alias, step, latest.error) && (
                            <p>{nextAction(alias, step, latest.error)}</p>
                          )}
                        </>
                      )}
                      {history.length > 0 && (
                        <details>
                          <summary>Attempt history ({history.length})</summary>
                          <ul>
                            {history.map((attempt) => (
                              <li key={attempt.id}>
                                {attempt.startedAt}:{' '}
                                {attempt.step === 'use-after-b' &&
                                attempt.status === 'verified' &&
                                !isVerifiedReturnToA(state, attempt)
                                  ? 'Unfinished evidence — saved evidence does not establish a return to A after B creation.'
                                  : attempt.step === 'use-after-b-failed' &&
                                      attempt.status === 'verified' &&
                                      !isVerifiedAAfterFailedB(state, attempt)
                                    ? 'Unfinished evidence — saved evidence does not establish an A check after the linked B creation failure.'
                                    : attempt.status}
                                {attempt.error ? ` — ${ERROR_MESSAGES[attempt.error]}` : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ol>
              <ObservationForm alias={alias} controller={controller} disabled={blocked} />
              {observations.length > 0 && (
                <details open>
                  <summary>Human observations ({observations.length})</summary>
                  <ul>
                    {observations.map((observation) => (
                      <li key={observation.id}>
                        <strong>{outcomeNames[observation.outcome]}</strong> ·{' '}
                        {observation.step === 'general' ? 'General' : stepNames[observation.step]}
                        {observation.note && <p>{observation.note}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </section>
      <section className="checker-panel" aria-labelledby="report-title">
        <h2 id="report-title">3. Keep your report</h2>
        <p>
          Download at any time, including after a failed or unfinished test. The readable report
          separates automatic evidence from your observations and lists remaining installation
          checks.
        </p>
        <div className="checker-actions">
          <button type="button" onClick={exportReport}>
            Download Markdown report
          </button>
          <button
            type="button"
            ref={resetButton}
            disabled={busy || storage === 'conflict'}
            onClick={() => setConfirmReset(true)}
          >
            Reset local progress
          </button>
        </div>
        {confirmReset && (
          <fieldset className="checker-reset">
            <legend>Clear this browser's checker progress?</legend>
            <p>
              Download your report first if you want to keep it. Reset removes this run's results.
              In unsaved mode, it clears only this tab's memory and leaves any unreadable saved
              progress in place. It does not remove passkeys from your provider. Remove those
              separately in your provider if desired.
            </p>
            <div className="checker-actions">
              <button
                ref={confirmButton}
                type="button"
                disabled={busy || resetPending}
                onClick={async () => {
                  setResetPending(true);
                  const previousRun = controller.getSnapshot().state.run.id;
                  try {
                    await controller.reset();
                    returnResetFocus.current = true;
                    setConfirmReset(false);
                    setNotice(
                      controller.getSnapshot().state.run.id !== previousRun
                        ? 'Local progress reset. Provider passkeys were not removed.'
                        : 'Reset could not complete. Available progress has been retained.',
                    );
                  } catch {
                    setNotice(
                      'Reset could not complete. Review local progress before trying again.',
                    );
                  } finally {
                    setResetPending(false);
                  }
                }}
              >
                Confirm reset
              </button>
              <button
                type="button"
                disabled={busy || resetPending}
                onClick={() => {
                  returnResetFocus.current = true;
                  setConfirmReset(false);
                }}
              >
                Keep progress
              </button>
            </div>
          </fieldset>
        )}
      </section>
      <footer>
        <h2>Still needed on your installation</h2>
        <p>
          This hosted test cannot verify production backend signatures or sessions, profile
          recovery, locked private/original-access refusal, or retained access after Docker Compose
          recreation. Test those on your actual localhost release build. Successful hosted tests do
          not close CRS-163 or qualify CRS-088's later flow and salt migration.
        </p>
        <p>
          <a href="https://github.com/mxbaylee/circus-health/blob/main/docs/security/profile-encryption.md#physical-passkey-qualification">
            Full localhost physical qualification procedure
          </a>
        </p>
        <p className="checker-source">
          Current tool {currentBuild.version} · revision {currentBuild.revision} ·{' '}
          {currentBuild.worktree}
          <br />
          Run started with tool {state.run.build.version} · revision {state.run.build.revision}
          <br />
          Origin: {state.run.origin} · run started {state.run.createdAt}
        </p>
      </footer>
    </main>
  );
}
