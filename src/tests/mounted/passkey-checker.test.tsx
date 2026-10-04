/** Controlled UI logic only; these tests supply no physical passkey evidence. */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../../app/passkey-checker/App';
import type { CheckerController } from '../../app/passkey-checker/controller';
import type { Attempt, CheckerState, Observation } from '../../app/passkey-checker/types';

const support = vi.hoisted(() => ({ supported: true, reason: null as string | null }));
vi.mock('../../app/passkey-checker/environment', () => ({
  checkSupport: () => support,
}));
const build = { version: 'test-version', revision: 'fictional-revision', worktree: 'clean' };
const environment: CheckerState['run']['environment'] = {
  browser: { value: 'Fictional browser', source: 'operator' },
  browserVersion: { value: '', source: 'unknown' },
  os: { value: '', source: 'unknown' },
  osVersion: { value: '', source: 'unknown' },
  provider: { value: '', source: 'unknown' },
  providerVersion: { value: '', source: 'unknown' },
};
function attempt(step: Attempt['step'], status: Attempt['status'], id: string): Attempt {
  return {
    id,
    alias: 'A',
    step,
    status,
    startedAt: '2026-10-03T00:00:00.000Z',
    build,
    environment,
    ...(status === 'failed' ? { error: 'missing-prf' as const } : {}),
  };
}
const confirmedA: CheckerState['credentials'][number] = {
  alias: 'A',
  id: 'fictional-credential-a',
  salt: 'fictional-salt-a',
  cipher: { iv: 'fictional-iv', data: 'fictional-ciphertext' },
};
const createdB: CheckerState['credentials'][number] = {
  alias: 'B',
  id: 'fictional-credential-b',
  salt: 'fictional-salt-b',
};
function bCreation(): Attempt {
  return {
    ...attempt('create', 'created', 'created-b'),
    alias: 'B',
    finishedAt: '2026-10-03T00:00:01.000Z',
  };
}
function fixture(attempts: Attempt[] = [], credentials: CheckerState['credentials'] = []) {
  let snapshot: ReturnType<CheckerController['getSnapshot']> = {
    state: {
      run: {
        schemaVersion: 1,
        id: 'fictional-run',
        origin: 'https://checker.example',
        rpId: 'checker.example',
        secureContext: true,
        userId: 'fictional-local-user',
        createdAt: '2026-10-03T00:00:00.000Z',
        build,
        environment,
      },
      credentials,
      attempts,
      observations: [],
    },
    currentBuild: build,
    busy: false,
    storage: 'saved',
    canRun: true,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canRunStep: vi.fn(() => true),
    runStep: vi.fn(async () => {}),
    updateEnvironment: vi.fn(async () => {}),
    addObservation: vi.fn(
      async (input: Pick<Observation, 'alias' | 'step' | 'outcome' | 'note'>) => {
        publish({
          state: {
            ...snapshot.state,
            observations: [
              ...snapshot.state.observations,
              {
                ...input,
                id: 'observation',
                createdAt: '2026-10-03T00:00:00.000Z',
                build,
                environment,
              },
            ],
          },
        });
      },
    ),
    exportModel: () => structuredClone(snapshot.state),
    reset: vi.fn(async () => {
      publish({
        state: {
          ...snapshot.state,
          run: { ...snapshot.state.run, id: 'reset-run' },
          attempts: [],
          observations: [],
        },
      });
    }),
    continueInMemory: vi.fn(() => publish({ storage: 'ephemeral', canRun: true })),
    close: vi.fn(),
  } as unknown as CheckerController;
  return { controller, publish };
}

describe('standalone checker guidance (controlled tests)', () => {
  it('explains native labels, same-profile B and another available authenticator', () => {
    const f = fixture();
    render(<App controller={f.controller} />);
    expect(screen.getByText(/A and B belong to the same fictional profile/)).toHaveTextContent(
      'Providers may group or ignore these labels',
    );
    const card = screen.getByRole('article', { name: /Passkey B/ });
    expect(within(card).getByText(/choose another available authenticator/)).toHaveTextContent(
      'A synced copy of A is not a distinct authenticator',
    );
    expect(
      within(card).getByText(/Review the provider labels above before switching/),
    ).toBeVisible();
    expect(screen.getByText(/A retained after B creation: Not tested/)).toBeVisible();
    expect(
      within(card).queryByRole('option', { name: 'Use A after B is created' }),
    ).not.toBeInTheDocument();
  });

  it('keeps return to A available after B creation even when B confirmation failed', async () => {
    const f = fixture(
      [
        attempt('confirm', 'verified', 'a-confirmed'),
        attempt('use-1', 'verified', 'a-use-1'),
        attempt('use-2', 'verified', 'a-use-2'),
        attempt('use-3', 'verified', 'a-use-3'),
        bCreation(),
        { ...attempt('confirm', 'failed', 'b-confirmation-failed'), alias: 'B' },
      ],
      [confirmedA, createdB],
    );
    render(<App controller={f.controller} />);
    const card = screen.getByRole('article', { name: 'Passkey A' });
    expect(
      within(card).getByText(
        'Automatic result: Initial confirmation and all three fresh uses verified',
      ),
    ).toBeVisible();
    expect(within(card).getByText(/A retained after B creation: Not yet verified/)).toBeVisible();
    expect(within(card).getByText(/even if B confirmation failed or is unfinished/)).toBeVisible();
    expect(
      within(card).getByText(/Before opening the prompt, review the provider labels/),
    ).toHaveTextContent("above for A; they may still describe B's provider.");
    await userEvent.click(
      within(card).getByRole('button', { name: 'Start use a after b is created for A' }),
    );
    expect(f.controller.runStep).toHaveBeenCalledWith('A', 'use-after-b');
  });

  it('offers a fresh A check after failed B creation and keeps failures distinct from enrollment', async () => {
    const failure: Attempt = {
      ...bCreation(),
      id: 'b-failed',
      status: 'failed',
      error: 'invalid-state',
    };
    const f = fixture(
      [
        attempt('confirm', 'verified', 'a-confirmed'),
        attempt('use-1', 'verified', 'a-use-1'),
        attempt('use-2', 'verified', 'a-use-2'),
        attempt('use-3', 'verified', 'a-use-3'),
        failure,
      ],
      [confirmedA],
    );
    f.controller.canRunStep = vi.fn(
      (alias, step) => alias === 'A' && step === 'use-after-b-failed',
    );
    render(<App controller={f.controller} />);
    const card = screen.getByRole('article', { name: 'Passkey A' });
    expect(within(card).getByText(/Automatic result: Initial confirmation/)).toBeVisible();
    expect(
      within(card).getByText(/A retained after failed B creation: Not yet verified/),
    ).toBeVisible();
    const button = within(card).getByRole('button', {
      name: 'Start use a after b creation fails for A',
    });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(f.controller.runStep).toHaveBeenCalledWith('A', 'use-after-b-failed');
    const recovery: Attempt = {
      ...attempt('use-after-b-failed', 'failed', 'a-recovery'),
      startedAt: '2026-10-03T00:00:02.000Z',
      afterAttemptId: failure.id,
      error: 'decrypt-failed',
    };
    act(() =>
      f.publish({
        state: {
          ...f.controller.exportModel(),
          attempts: [...f.controller.exportModel().attempts, recovery],
        },
      }),
    );
    expect(within(card).getByText(/A retained after failed B creation: Failed/)).toBeVisible();
    expect(
      within(card).getByRole('button', { name: 'Retry use a after b creation fails for A' }),
    ).toBeEnabled();
    act(() =>
      f.publish({
        state: {
          ...f.controller.exportModel(),
          attempts: [
            ...f.controller.exportModel().attempts,
            { ...recovery, id: 'a-recovered', status: 'verified', error: undefined },
          ],
        },
      }),
    );
    expect(within(card).getByText(/A retained after failed B creation: Verified/)).toBeVisible();
    expect(
      within(card).getByText(/It does not prove B works or complete two-credential enrollment/),
    ).toBeVisible();
    expect(within(card).getByText(/A retained after B creation: Not tested/)).toBeVisible();
    const bCard = screen.getByRole('article', { name: /Passkey B/ });
    expect(
      within(bCard).queryByRole('option', { name: 'Use A after B creation fails' }),
    ).not.toBeInTheDocument();
    expect(within(bCard).getByText(/Automatic result: Incomplete/)).toBeVisible();
    act(() =>
      f.publish({
        state: {
          ...f.controller.exportModel(),
          attempts: [
            ...f.controller.exportModel().attempts,
            { ...failure, id: 'b-later-failure', finishedAt: '2026-10-03T00:00:03.000Z' },
          ],
        },
      }),
    );
    expect(
      within(card).getByText(/A retained after failed B creation: Not yet verified/),
    ).toBeVisible();
    expect(
      within(card).queryByRole('button', { name: /Completed: use a after b creation fails/ }),
    ).not.toBeInTheDocument();
  });

  it('shows verified, failed and inconsistent retained-A evidence separately from initial uses', async () => {
    const returned = {
      ...attempt('use-after-b', 'verified', 'a-return'),
      startedAt: '2026-10-03T00:00:02.000Z',
    };
    const f = fixture([bCreation(), returned], [confirmedA, createdB]);
    render(<App controller={f.controller} />);
    expect(screen.getByText(/A retained after B creation: Verified/)).toBeVisible();
    act(() =>
      f.publish({
        state: {
          ...f.controller.getSnapshot().state,
          attempts: [bCreation(), returned, attempt('use-after-b', 'failed', 'failed-return')],
        },
      }),
    );
    expect(screen.getByText(/A retained after B creation: Failed/)).toBeVisible();
    act(() =>
      f.publish({
        state: {
          ...f.controller.getSnapshot().state,
          attempts: [{ ...bCreation(), finishedAt: '2026-10-03T00:00:03.000Z' }, returned],
        },
      }),
    );
    expect(
      screen.getByText(/A retained after B creation: Not verified — saved evidence/),
    ).toBeVisible();
    expect(
      screen.queryByText(/Automatic evidence: Fresh PRF decrypted and matched/),
    ).not.toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'Passkey A' });
    await userEvent.click(within(card).getByText('Attempt history (1)'));
    const history = within(within(card).getByText('Attempt history (1)').parentElement!);
    expect(
      history.getByText(/Unfinished evidence — saved evidence does not establish/),
    ).toBeVisible();
    expect(history.queryByText(/: verified$/)).not.toBeInTheDocument();
    expect(f.controller.getSnapshot().state.attempts[1]).toEqual(returned);
  });

  it.each(['invalid-state', 'unknown-error'] as const)(
    'offers a safe next action for B creation %s without claiming a cause',
    async (error) => {
      const f = fixture([{ ...attempt('create', 'failed', 'b-failed'), alias: 'B', error }]);
      render(<App controller={f.controller} />);
      const card = screen.getByRole('article', { name: /Passkey B/ });
      expect(
        within(card).getByText(
          error === 'invalid-state'
            ? /That is a possible explanation, not a confirmed cause/
            : /The cause of this second-creation failure is unknown/,
        ),
      ).toBeVisible();
      await userEvent.click(within(card).getByRole('button', { name: 'Save observation for B' }));
      expect(within(card).getByText("Couldn't test", { selector: 'strong' })).toBeVisible();
      expect(
        within(card).getByText('Automatic result: Incomplete — inspect each step below'),
      ).toBeVisible();
      expect(f.controller.runStep).not.toHaveBeenCalled();
    },
  );

  it.each(['wrong-credential', 'prf-absent', 'prf-invalid'] as const)(
    'gives an actionable explanation for %s and keeps the automatic failure',
    (error) => {
      const f = fixture([{ ...attempt('confirm', 'failed', 'failed-confirm'), error }]);
      render(<App controller={f.controller} />);
      const card = screen.getByRole('article', { name: 'Passkey A' });
      expect(
        within(card).getByText(
          error === 'wrong-credential'
            ? /Retry and choose the saved test passkey A/
            : error === 'prf-absent'
              ? /This attempt returned no encryption result/
              : /An encryption result was present but could not be used/,
        ),
      ).toBeVisible();
      expect(
        within(card).getByText('Automatic result: Incomplete — inspect each step below'),
      ).toBeVisible();
      expect(f.controller.runStep).not.toHaveBeenCalled();
    },
  );

  it('uses exact metadata labels and exposes provenance as a description', () => {
    const f = fixture();
    render(<App controller={f.controller} />);
    for (const name of [
      'Browser',
      'Browser version',
      'Operating system',
      'Operating-system version',
      'Passkey provider',
      'Provider version',
    ]) {
      expect(screen.getByRole('textbox', { name })).toBeVisible();
    }
    expect(screen.getByRole('textbox', { name: 'Browser' })).toHaveAccessibleDescription(
      'Manually observed',
    );
    expect(screen.getByRole('textbox', { name: 'Provider version' })).toHaveAccessibleDescription(
      'Unknown',
    );
  });
  it('cannot hide or cancel a confirmed reset while storage deletion is pending', async () => {
    const f = fixture([attempt('confirm', 'failed', 'saved')]);
    let finishReset!: () => void;
    vi.mocked(f.controller.reset).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishReset = resolve;
        }),
    );
    render(<App controller={f.controller} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset local progress' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep progress' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Resetting local progress. This cannot be cancelled',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('passkey request');
    await userEvent.click(screen.getByRole('button', { name: 'Keep progress' }));
    expect(screen.getByText("Clear this browser's checker progress?")).toBeVisible();
    expect(f.controller.reset).toHaveBeenCalledOnce();
    await act(async () => finishReset());
    expect(screen.queryByRole('button', { name: 'Keep progress' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reset could not complete');
  });
  it('keeps a draft note when an observation is refused without adding history', async () => {
    const f = fixture();
    vi.mocked(f.controller.addObservation).mockResolvedValue(undefined);
    render(<App controller={f.controller} />);
    const note = screen.getByRole('textbox', { name: 'Optional notes for passkey A' });
    await userEvent.type(note, 'Fictional prompt observation');
    await userEvent.click(screen.getByRole('button', { name: 'Save observation for A' }));
    expect(note).toHaveValue('Fictional prompt observation');
  });
  it('distinguishes the running tool revision from a restored older run', () => {
    const f = fixture();
    f.publish({
      currentBuild: { version: 'new-version', revision: 'new-revision', worktree: 'clean' },
    });
    render(<App controller={f.controller} />);
    expect(screen.getByText(/Current tool new-version · revision new-revision/)).toBeVisible();
    expect(
      screen.getByText(/Run started with tool test-version · revision fictional-revision/),
    ).toBeVisible();
  });
  it('allows manual observations and metadata when native passkeys are unavailable', async () => {
    support.supported = false;
    support.reason = 'Native credential API unavailable.';
    const f = fixture();
    try {
      render(<App controller={f.controller} />);
      expect(
        screen.getByRole('button', { name: 'Start create a test passkey for A' }),
      ).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Download Markdown report' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Save observation for A' })).toBeEnabled();
      await userEvent.type(screen.getByRole('textbox', { name: 'Provider version' }), '1');
      expect(f.controller.updateEnvironment).toHaveBeenCalledWith({ providerVersion: '1' });
    } finally {
      support.supported = true;
      support.reason = null;
    }
  });
  it('keeps manual Worked separate from failed automatic proof and retained retries', async () => {
    const f = fixture([
      attempt('create', 'created', 'create'),
      attempt('confirm', 'failed', 'failed'),
      attempt('confirm', 'verified', 'retried'),
      attempt('use-1', 'failed', 'fresh-failed'),
    ]);
    render(<App controller={f.controller} />);
    const card = screen.getByRole('article', { name: 'Passkey A' });
    expect(
      within(card).getByText('Automatic result: Incomplete — inspect each step below'),
    ).toBeVisible();
    expect(
      within(card).getByText('Credential created; PRF compatibility is not yet verified.', {
        exact: false,
      }),
    ).toBeVisible();
    await userEvent.selectOptions(
      within(card).getByLabelText('Observed outcome for passkey A'),
      'worked',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Save observation for A' }));
    expect(within(card).getByText('Worked', { selector: 'strong' })).toBeVisible();
    expect(
      within(card).getByText('Automatic result: Incomplete — inspect each step below'),
    ).toBeVisible();
    await userEvent.click(within(card).getByText('Attempt history (2)'));
    expect(
      within(within(card).getByText('Attempt history (2)').parentElement!).getByText(
        /failed — No valid 32-byte PRF/,
      ),
    ).toBeVisible();
    await userEvent.click(
      within(card).getByRole('button', { name: 'Retry use it again: 1 of 3 for A' }),
    );
    expect(f.controller.runStep).toHaveBeenCalledWith('A', 'use-1');
  });

  it('shows restored history and requires a deliberate reset confirmation', async () => {
    const f = fixture([attempt('confirm', 'failed', 'saved-failure')]);
    render(<App controller={f.controller} />);
    expect(screen.getByText('Progress saved in this browser')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reset local progress' }));
    expect(f.controller.reset).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm reset' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Keep progress' }));
    expect(f.controller.reset).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reset local progress' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Reset local progress' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    expect(f.controller.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Reset local progress' })).toHaveFocus();
    expect(
      screen.getByText('Local progress reset. Provider passkeys were not removed.'),
    ).toBeVisible();
    expect(screen.getAllByText('Automatic evidence: Not attempted.')).toHaveLength(12);
  });

  it('keeps reports available during storage trouble and makes unsaved fallback explicit', async () => {
    const f = fixture([attempt('confirm', 'failed', 'partial')]);
    f.publish({
      storage: 'unavailable',
      canRun: false,
      warning: 'Browser-local storage could not be opened.',
    });
    render(<App controller={f.controller} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Browser-local storage could not be opened.',
    );
    expect(
      screen.getByRole('button', { name: 'Start create a test passkey for A' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download Markdown report' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue without saving' }));
    expect(screen.getByText('Progress is not saved — export before leaving')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start create a test passkey for A' })).toBeEnabled();
    act(() =>
      f.publish({
        storage: 'conflict',
        canRun: false,
        warning: 'Another tab changed saved progress.',
      }),
    );
    expect(screen.getByRole('button', { name: 'Download Markdown report' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset local progress' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload saved progress' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Continue without saving' }),
    ).not.toBeInTheDocument();
  });

  it('does not claim compatibility after an earlier pass is followed by failure', () => {
    const f = fixture([
      attempt('confirm', 'verified', 'confirm'),
      attempt('use-1', 'verified', '1'),
      attempt('use-2', 'verified', '2'),
      attempt('use-3', 'verified', '3'),
      attempt('use-3', 'failed', 'retry'),
    ]);
    render(<App controller={f.controller} />);
    expect(
      screen.queryByText(
        'Automatic result: Initial confirmation and all three fresh uses verified',
      ),
    ).not.toBeInTheDocument();
    expect(f.controller.runStep).not.toHaveBeenCalled();
  });
});
