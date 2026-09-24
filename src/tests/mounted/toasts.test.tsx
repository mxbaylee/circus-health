import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearToasts, notifySuccess, ToastViewport } from '../../app/components/Toasts';
import { replaceProfiles, selectProfile } from '../../app/data/profile';
afterEach(clearToasts);
it('shows a dismissible success without modifying the page header', () => {
  render(
    <>
      <h1>Prescription</h1>
      <ToastViewport />
    </>,
  );
  act(() => notifySuccess('Prescription saved: Archived.'));
  expect(screen.getByRole('status')).toHaveTextContent('Prescription saved: Archived.');
  expect(screen.getByRole('heading')).toHaveTextContent('Prescription');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Prescription saved: Archived.' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('pauses expiry while the notification has attention', () => {
  vi.useFakeTimers();
  render(<ToastViewport />);
  act(() => notifySuccess('Entry archived.'));
  act(() => vi.advanceTimersByTime(3000));
  fireEvent.mouseEnter(screen.getByRole('status'));
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByRole('status')).toBeInTheDocument();
  fireEvent.mouseLeave(screen.getByRole('status'));
  act(() => vi.advanceTimersByTime(3001));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('clears prior-profile notifications immediately on a profile switch', () => {
  const a = { id: 'toast-a', name: 'One', placebo: true },
    b = { id: 'toast-b', name: 'Two', placebo: true };
  replaceProfiles([a, b]);
  selectProfile(a);
  render(<ToastViewport />);
  act(() => notifySuccess('One saved.'));
  act(() => selectProfile(b));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('keeps a keyboard-focused toast visible after the pointer leaves', () => {
  vi.useFakeTimers();
  render(<ToastViewport />);
  act(() => notifySuccess('Entry restored.'));
  const toast = screen.getByRole('status');
  fireEvent.mouseEnter(toast);
  fireEvent.focus(screen.getByRole('button'));
  fireEvent.mouseLeave(toast);
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByRole('status')).toBeInTheDocument();
  fireEvent.blur(screen.getByRole('button'));
  act(() => vi.advanceTimersByTime(6001));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
