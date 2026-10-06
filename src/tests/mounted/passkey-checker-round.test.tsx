import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CheckerController, CheckerSnapshot } from '../../app/passkey-checker/controller';
import type { CheckerState } from '../../app/passkey-checker/types';
import type { ReactNode } from 'react';

const dependencies = vi.hoisted(() => ({
  createController: vi.fn(),
  openStore: vi.fn(),
  deleteStore: vi.fn(),
}));
vi.mock('../../app/passkey-checker/controller', () => ({
  createCheckerController: dependencies.createController,
}));
vi.mock('../../app/passkey-checker/store', () => ({
  openCheckerStore: dependencies.openStore,
  deleteCheckerStore: dependencies.deleteStore,
}));
vi.mock('../../app/passkey-checker/build', () => ({
  BUILD_INFO: { version: '3', revision: 'fictional', worktree: 'clean' },
}));
vi.mock('../../app/passkey-checker/GuidedApp', () => ({
  default: ({ settings, previous }: { settings: ReactNode; previous: ReactNode }) => (
    <>
      {settings}
      <div>Fictional checker body</div>
      {previous}
    </>
  ),
  downloadReport: vi.fn(),
}));
import RoundApp from '../../app/passkey-checker/RoundApp';
import { LEGACY_DATABASE, guidedDatabase } from '../../app/passkey-checker/round';

function controller() {
  let snapshot = {
    state: {} as CheckerState,
    currentBuild: { version: '3', revision: 'fictional', worktree: 'clean' },
    busy: false,
    storage: 'saved',
    canRun: true,
  } as CheckerSnapshot;
  const listeners = new Set<() => void>();
  const value = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: vi.fn(),
  } as unknown as CheckerController;
  return {
    value,
    change(patch: Partial<CheckerSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((listener) => listener());
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

test('round modes cannot switch during prompts or saves', async () => {
  const first = controller();
  const second = controller();
  dependencies.createController
    .mockResolvedValueOnce(first.value)
    .mockResolvedValueOnce(second.value);
  render(<RoundApp />);
  fireEvent.click(await screen.findByText('Advanced: creation PRF mode'));
  const select = await screen.findByLabelText('Registration request');
  expect((select as HTMLSelectElement).value).toBe('eval');
  const baseline = dependencies.createController.mock.calls[0][0];
  await baseline.openStore();
  expect(dependencies.openStore).toHaveBeenLastCalledWith(
    globalThis.indexedDB,
    guidedDatabase('eval'),
  );
  act(() => first.change({ busy: true }));
  expect((select as HTMLSelectElement).disabled).toBe(true);
  act(() => first.change({ busy: false, storage: 'saving' }));
  expect((select as HTMLSelectElement).disabled).toBe(true);
  act(() => first.change({ storage: 'saved' }));
  fireEvent.change(select, { target: { value: 'enable-only' } });
  await waitFor(() => expect(dependencies.createController).toHaveBeenCalledTimes(2));
  expect(first.value.close).toHaveBeenCalledOnce();
  const experimental = dependencies.createController.mock.calls[1][0];
  await experimental.openStore();
  expect(dependencies.openStore).toHaveBeenLastCalledWith(
    globalThis.indexedDB,
    guidedDatabase('enable-only'),
  );
  const onBlocked = () => {};
  await experimental.deleteStore(onBlocked);
  expect(dependencies.deleteStore).toHaveBeenCalledWith(
    globalThis.indexedDB,
    guidedDatabase('enable-only'),
    onBlocked,
  );
  expect(dependencies.deleteStore).not.toHaveBeenCalledWith(
    globalThis.indexedDB,
    LEGACY_DATABASE,
    expect.anything(),
  );
});

test('missing previous results are not deleted or replaced', async () => {
  const current = controller();
  dependencies.createController.mockResolvedValue(current.value);
  const old = { load: vi.fn().mockResolvedValue(null), close: vi.fn() };
  dependencies.openStore.mockResolvedValue(old);
  render(<RoundApp />);
  fireEvent.click(await screen.findByText('Previous results'));
  fireEvent.click(await screen.findByRole('button', { name: 'Export previous-round report' }));
  await screen.findByText('No previous-round results are saved in this browser.');
  expect(dependencies.openStore).toHaveBeenCalledWith(globalThis.indexedDB, LEGACY_DATABASE);
  expect(old.close).toHaveBeenCalledOnce();
  expect(dependencies.deleteStore).not.toHaveBeenCalled();
});

test('late opening closes its controller after unmount', async () => {
  const late = controller();
  let resolve!: (value: CheckerController) => void;
  dependencies.createController.mockReturnValue(
    new Promise<CheckerController>((r) => (resolve = r)),
  );
  const view = render(<RoundApp />);
  view.unmount();
  await act(async () => resolve(late.value));
  expect(late.value.close).toHaveBeenCalledOnce();
});
