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
function fixture(attempts: Attempt[] = []) {
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
      credentials: [],
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
    expect(screen.getAllByText('Automatic evidence: Not attempted.')).toHaveLength(10);
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
      screen.queryByText('Automatic result: Confirmation and all three fresh uses verified'),
    ).not.toBeInTheDocument();
    expect(f.controller.runStep).not.toHaveBeenCalled();
  });
});
