import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ImportSaveStatus } from '../../app/features/import/ImportSaveStatus';

const props = () => ({
  pendingOperation: true,
  saving: false,
  checking: false,
  canRetry: true,
  onCheck: vi.fn(),
  onRetry: vi.fn(),
});

it('shows an ordinary in-flight save without alarming recovery or retry actions', () => {
  const actions = props();
  const view = render(<ImportSaveStatus {...actions} saving />);
  expect(screen.getByRole('status')).toHaveTextContent('Saving your selected results…');
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText(/not been confirmed|previous save/)).toBeNull();

  view.rerender(<ImportSaveStatus {...actions} pendingOperation={false} />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(actions.onCheck).not.toHaveBeenCalled();
  expect(actions.onRetry).not.toHaveBeenCalled();
});

it('waits for the current status check before exposing deliberate recovery choices', async () => {
  const actions = props();
  const view = render(<ImportSaveStatus {...actions} checking />);
  expect(screen.getByRole('status')).toHaveTextContent('Checking whether your results were saved…');
  expect(screen.queryByRole('button')).toBeNull();

  view.rerender(<ImportSaveStatus {...actions} />);
  expect(screen.getByRole('status')).toHaveTextContent('A save has not been confirmed yet.');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Check save status' }));
  expect(actions.onCheck).toHaveBeenCalledTimes(1);
  expect(actions.onRetry).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Retry this save' }));
  expect(actions.onRetry).toHaveBeenCalledTimes(1);
});

it('does not offer a retry after reload without the original exact selection', () => {
  render(<ImportSaveStatus {...props()} canRetry={false} />);
  expect(screen.getByRole('button', { name: 'Check save status' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Retry this save' })).toBeNull();
});
