import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import GuidedApp from '../../app/passkey-checker/GuidedApp';
import type { CheckerController } from '../../app/passkey-checker/controller';
import { guidedFixture } from '../passkey-checker-guided-fixture';

const controllers: CheckerController[] = [];
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:fictional-report'),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const controller of controllers.splice(0)) controller.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(failB = false) {
  const result = await guidedFixture({ failCreate: new Set(failB ? ['B'] : []) });
  const { controller } = result;
  controllers.push(controller);
  const onMode = vi.fn();
  render(
    <GuidedApp
      controller={controller}
      mode="eval"
      onMode={onMode}
      supportCheck={() => ({ supported: true, reason: null })}
    />,
  );
  return { ...result, onMode };
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
  // The event handler intentionally does not return its WebCrypto promise.
  // Wait for the real operation and save to finish before the next UI action.
  await waitFor(() => {
    for (const controller of controllers) {
      expect(controller.getSnapshot().busy).toBe(false);
      expect(controller.getSnapshot().storage).not.toBe('saving');
    }
  });
}
const clearButton = () =>
  screen.getByRole('button', { name: 'Clear this run' }) as HTMLButtonElement;
async function acknowledge() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("I've checked that this report was saved"));
  });
}
async function skip() {
  await click("Can't test this step?");
  const button = screen.getByRole('button', {
    name: 'Skip this test without verifying',
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByLabelText('I understand this skips the test without verifying it'));
  });
  await click('Skip this test without verifying');
}

test('failed B recovery appears below the failure and continuing reaches C without a false B pass', async () => {
  const { controller, calls } = await fixture(true);
  for (const name of ['Create A', 'Verify A', 'Create B']) await click(name);
  const recovery = screen.getByRole('button', { name: 'Recheck A' });
  const b = screen.getByRole('region', { name: 'Create B · same username as A' });
  expect(b.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(recovery));
  await click('Recheck A');
  await skip();
  expect(screen.getByRole('button', { name: 'Create C' })).toBeTruthy();
  expect(screen.getAllByText('not applicable · credential not created').length).toBeGreaterThan(0);
  expect(calls).toHaveLength(2);
  expect(controller.exportModel().credentials.some((row) => row.alias === 'B')).toBe(false);
});

test('download failure preserves evidence and clearing requires a successful download plus acknowledgment', async () => {
  const { controller } = await fixture();
  await click('Create A');
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw Error('Fictional download failure');
  });
  await click('Download this report');
  expect(clearButton().disabled).toBe(true);
  expect(controller.exportModel().attempts).toHaveLength(1);
  await click('Download this report');
  expect(clearButton().disabled).toBe(true);
  await acknowledge();
  expect(clearButton().disabled).toBe(false);
  await click('Clear this run');
  expect(controller.exportModel().attempts).toHaveLength(0);
});

test('new native evidence invalidates the downloaded report acknowledgment', async () => {
  const { controller } = await fixture();
  await click('Download this report');
  await acknowledge();
  expect(clearButton().disabled).toBe(false);
  await click('Create A');
  expect(clearButton().disabled).toBe(true);
  expect(
    (screen.getByLabelText("I've checked that this report was saved") as HTMLInputElement).checked,
  ).toBe(false);
  expect(controller.exportModel().attempts).toHaveLength(1);
});

test('an unsaved observation blocks mode switching, download and clear until explicitly saved', async () => {
  const { controller, onMode } = await fixture();
  await click('Download this report');
  await acknowledge();
  await act(async () => {
    fireEvent.click(screen.getByText('Optional observation'));
    fireEvent.change(screen.getByLabelText('What did you see?'), {
      target: { value: 'Fictional note.' },
    });
  });
  const mode = screen.getByLabelText('Creation request') as HTMLSelectElement;
  expect(mode.disabled).toBe(true);
  expect(clearButton().disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Download this report' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(onMode).not.toHaveBeenCalled();
  await click('Save note');
  expect(controller.exportModel().observations.at(-1)?.note).toBe('Fictional note.');
  expect(mode.disabled).toBe(false);
  expect(clearButton().disabled).toBe(true);
});

test('skip is acknowledged separately and the existing credential can be verified later', async () => {
  const { controller, calls, gets } = await fixture();
  await click('Create A');
  const created = controller.exportModel().credentials[0];
  await click("Can't test this step?");
  expect(gets).toHaveLength(0);
  expect(controller.exportModel().attempts).toHaveLength(1);
  await click('Cancel skip');
  await skip();
  const skipped = controller.exportModel().attempts[1];
  expect(skipped.status).toBe('skipped');
  expect(gets).toHaveLength(0);
  expect(screen.getByText(/^Verification not attempted/)).toBeTruthy();
  await click('Verify existing A');
  expect(calls).toHaveLength(1);
  expect(gets).toHaveLength(1);
  const state = controller.exportModel();
  expect(state.credentials[0].id).toBe(created.id);
  expect(state.credentials[0].salt).toBe(created.salt);
  expect(state.credentials[0].cipher).toBeTruthy();
  expect(state.attempts[1]).toEqual(skipped);
  expect(state.attempts.at(-1)?.status).toBe('verified');
  expect(screen.queryByRole('button', { name: 'Verify existing A' })).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create B' })),
  );
  await click("Can't test this step?");
  expect(
    (screen.getByRole('button', { name: 'Skip this test without verifying' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
