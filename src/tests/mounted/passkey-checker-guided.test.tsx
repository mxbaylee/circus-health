import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import GuidedApp from '../../app/passkey-checker/GuidedApp';
import { createCheckerController } from '../../app/passkey-checker/controller';
import { guidedCore, guidedRun } from '../passkey-checker-guided-fixture';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function fixture() {
  const native = guidedCore();
  let run = 0;
  const controller = await createCheckerController({
    build: guidedRun().build,
    environment: guidedRun().environment,
    newRun: () => ({ ...guidedRun(), id: `fictional-run-${++run}` }),
    core: native.core,
    openStore: async () => {
      throw Error('Controlled unavailable storage');
    },
  });
  controller.continueInMemory();
  render(
    <GuidedApp
      controller={controller}
      support={{ supported: true, reason: 'Controlled fixture' }}
    />,
  );
  return { controller, native };
}
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name, exact: true }));
  });
}
test('failed B recovery follows B, continuing reaches C, and final rechecks stay at the bottom', async () => {
  const { controller, native } = await fixture();
  for (const name of ['Create A', 'Verify A']) {
    await click(name);
    await waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
  }
  native.refuseCreate.add('B');
  await click('Create B — same username as A');
  await waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
  const recovery = screen.getByRole('button', {
    name: 'Check A still works after this creation problem',
  });
  const b = screen.getByRole('region', { name: 'Create B — same username as A' });
  expect(b.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await click('Check A still works after this creation problem');
  await waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
  await click('Continue without this check');
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create C — changed username', exact: true }),
    ).toBeTruthy(),
  );
  expect(screen.getByText('Unavailable — no credential was returned for this slot.')).toBeTruthy();
  expect(native.creations.length).toBe(2);
  controller.close();
});
test('download failure never enables clear; a saved report acknowledgment is required', async () => {
  const { controller } = await fixture();
  await click('Create A');
  await waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw Error('Controlled download failure');
  });
  await click('Download this report');
  expect(screen.queryByRole('button', { name: 'Clear this run' })).toBeNull();
  expect(controller.exportModel().attempts).toHaveLength(1);
  await click('Download this report');
  expect(
    (screen.getByRole('button', { name: 'Clear this run' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText('I have saved this report'));
  await click('Clear this run');
  await waitFor(() => expect(controller.exportModel().attempts).toHaveLength(0));
  controller.close();
});
test('new evidence invalidates a downloaded-report acknowledgment', async () => {
  const { controller } = await fixture();
  await click('Download this report');
  fireEvent.click(screen.getByLabelText('I have saved this report'));
  await click('Create A');
  await waitFor(() => expect(controller.getSnapshot().busy).toBe(false));
  expect(screen.queryByRole('button', { name: 'Clear this run' })).toBeNull();
  expect(controller.exportModel().attempts).toHaveLength(1);
  controller.close();
});
