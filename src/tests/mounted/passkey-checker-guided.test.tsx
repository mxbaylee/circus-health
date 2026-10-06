import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    fireEvent.click(screen.getByRole('button', { name, exact: true }));
  });
}
const clearButton = () =>
  screen.getByRole('button', { name: 'Clear this run' }) as HTMLButtonElement;
async function acknowledge() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("I've checked that this report was saved"));
  });
}

test('failed B recovery appears below the failure and continuing reaches C without a false B pass', async () => {
  const { controller, calls } = await fixture(true);
  for (const name of ['Create A', 'Verify A', 'Create B']) await click(name);
  const recovery = screen.getByRole('button', { name: 'Recheck A', exact: true });
  const b = screen.getByRole('region', { name: 'Create B · same username as A' });
  expect(b.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.activeElement).toBe(recovery);
  await click('Recheck A');
  await click("Couldn't test — continue");
  expect(screen.getByRole('button', { name: 'Create C', exact: true })).toBeTruthy();
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
