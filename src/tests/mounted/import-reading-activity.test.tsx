import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportReadingActivity } from '../../app/features/import/ImportReadingActivity';
import type { ImportReviewModel } from '../../app/features/import/ImportReviewPresentation';

const start = '2026-09-28T12:00:00.000Z';
function activity(): NonNullable<ImportReviewModel['activity']> {
  return {
    activeFiles: 2,
    label: 'Moxie is reading 2 files',
    detail: 'Results appear here as Moxie reads.',
    progress: {
      elapsedStartedAt: start,
      elapsedEndedAt: null,
      accounted: 4,
      total: 20,
      readyRecords: 37,
      readWindows: 8,
      activeMs: 1,
      sliceStartedAt: '2026-09-28T12:04:00.000Z',
      lastProgressAt: null,
      pageTiming: {
        turn: 2,
        lastCompletedAt: start,
        lastReadMs: 1,
        recentIntervalMs: 10000,
        intervalSamples: 5,
      },
    },
  };
}
afterEach(() => vi.useRealTimers());
it('uses one elapsed batch clock across files and model passes, not local page preparation time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T12:05:00.000Z'));
  render(<ImportReadingActivity activity={activity()} />);
  expect(screen.getByText('Moxie is reading 2 files')).toBeVisible();
  expect(screen.getByText('Discovered 37 records in 5 minutes.')).toBeVisible();
  expect(screen.getByText('Estimating…')).toBeVisible();
  expect(screen.queryByText('Results appear here as Moxie reads.')).toBeNull();
  expect(
    screen.queryByText(/page prepared|source windows|source sections|Model context/),
  ).toBeNull();
  act(() => vi.advanceTimersByTime(60000));
  expect(screen.getByText('Discovered 37 records in 6 minutes.')).toBeVisible();
});
it('freezes calendar elapsed at the recorded pause or completion', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
  const paused = activity();
  paused.activeFiles = 0;
  paused.label = 'Reading paused';
  paused.progress!.elapsedEndedAt = '2026-09-28T14:05:00.000Z';
  render(<ImportReadingActivity activity={paused} />);
  expect(screen.getByText('Discovered 37 records in 2 hours 5 minutes.')).toBeVisible();
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText('Discovered 37 records in 2 hours 5 minutes.')).toBeVisible();
  expect(screen.queryByText('Estimating…')).toBeNull();
});
it('does not substitute a tool duration when the batch timestamp is unavailable', () => {
  const unknown = activity();
  unknown.progress!.elapsedStartedAt = 'invalid';
  render(<ImportReadingActivity activity={unknown} />);
  expect(screen.getByText('Discovered 37 records.')).toBeVisible();
  expect(screen.queryByText(/in 0s/)).toBeNull();
});

it('keeps actionable waiting details and expresses short elapsed time without a misleading zero', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T12:00:12.000Z'));
  const waiting = activity();
  waiting.detail = 'Moxie is waiting to continue. Your progress is saved.';
  waiting.detailIsImportant = true;
  render(<ImportReadingActivity activity={waiting} />);
  expect(screen.getByText(waiting.detail)).toBeVisible();
  expect(screen.getByText('Discovered 37 records in less than a minute.')).toBeVisible();
});

it('starts a rough estimate after fifteen seconds and keeps one for read-but-unaccounted work', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const reading = activity();
  reading.activeFiles = 1;
  Object.assign(reading.progress!, {
    total: 2,
    accounted: 0,
    readWindows: 0,
    readyRecords: 0,
    activeMs: 0,
    sliceStartedAt: start,
  });
  const view = render(<ImportReadingActivity activity={reading} />);
  expect(screen.getByText('Estimating…')).toBeVisible();
  act(() => vi.advanceTimersByTime(15_000));
  expect(
    screen.getByText('Rough estimate, narrows as files are read: about 1–2 minutes remaining'),
  ).toBeVisible();
  reading.progress!.readWindows = 2;
  reading.progress!.readyRecords = 8;
  act(() => vi.advanceTimersByTime(105_000));
  view.rerender(<ImportReadingActivity activity={reading} />);
  expect(
    screen.getByText('Rough estimate, narrows as files are read: about 2–6 minutes remaining'),
  ).toBeVisible();
  expect(screen.queryByText('Estimating…')).toBeNull();
  reading.progress!.accounted = 2;
  view.rerender(<ImportReadingActivity activity={reading} />);
  expect(screen.getByText('Finishing up…')).toBeVisible();
});

it('does not count paused time or page preparation speed toward the estimate', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T15:00:15.000Z'));
  const reading = activity();
  reading.activeFiles = 1;
  Object.assign(reading.progress!, {
    total: 2,
    accounted: 0,
    readWindows: 0,
    activeMs: 15_000,
    sliceStartedAt: null,
  });
  render(<ImportReadingActivity activity={reading} />);
  expect(
    screen.getByText('Rough estimate, narrows as files are read: about 1–2 minutes remaining'),
  ).toBeVisible();
});

it('combines observed file work and known waits in hours but leaves unknown availability uncertain', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const combined = activity();
  combined.progress!.files = [0, 1].map(() => ({
    accounted: 2,
    total: 10,
    readWindows: 2,
    activeMs: 360000,
    sliceStartedAt: null,
    retryAt: '2026-09-28T13:00:00.000Z',
    done: false,
    exceptions: 0,
  }));
  const view = render(<ImportReadingActivity activity={combined} />);
  expect(
    screen.getByText(
      'Rough estimate, narrows as files are read: about 2–4 hours remaining across files',
    ),
  ).toBeVisible();
  combined.progress!.files[1].uncertain = true;
  view.rerender(<ImportReadingActivity activity={combined} />);
  expect(
    screen.getByText(/about 2–3 hours remaining across files; 1 file is not yet included/),
  ).toBeVisible();
  expect(screen.queryByText('Estimating…')).toBeNull();
});

it('keeps done with exceptions distinct and exposes an explicit exception retry', async () => {
  const retry = vi.fn();
  const done = activity();
  done.activeFiles = 0;
  done.label = 'Done, with exceptions';
  done.progress!.elapsedEndedAt = start;
  render(<ImportReadingActivity activity={done} onRetryExceptions={retry} />);
  expect(screen.getByText('Done, with exceptions')).toBeVisible();
  screen.getByRole('button', { name: 'Retry exceptions' }).click();
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByText('Estimating…')).toBeNull();
});

// A backlog's unmeasured files are an explicit gap, not grounds for discarding
// observed work or promising a provider reset; see docs/import/automatic-recovery.md.
it('estimates measured work in a fifteen-file backlog and names the fourteen queued omissions', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const backlog = activity();
  backlog.activeFiles = 15;
  backlog.progress!.files = Array.from({ length: 15 }, (_, index) => ({
    accounted: index === 0 ? 2 : 0,
    total: index === 0 ? 10 : 0,
    readWindows: index === 0 ? 2 : 0,
    activeMs: index === 0 ? 360000 : 0,
    sliceStartedAt: null,
    retryAt: null,
    done: false,
    queued: index > 0,
    exceptions: 0,
  }));
  render(<ImportReadingActivity activity={backlog} />);
  expect(screen.getByText(/Rough estimate.*14 files are not yet included/)).toBeVisible();
  expect(screen.getByText('0 of 15 files done · 14 queued')).toBeVisible();
  expect(screen.queryByText('Estimating…')).not.toBeInTheDocument();
});

it('uses whole days for a long single file, without implying multiple files', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const long = activity();
  long.activeFiles = 1;
  long.progress!.files = [
    {
      accounted: 1,
      total: 10000,
      readWindows: 1,
      activeMs: 600000,
      sliceStartedAt: null,
      retryAt: null,
      done: false,
      exceptions: 0,
    },
  ];
  render(<ImportReadingActivity activity={long} />);
  expect(screen.getByText(/about \d+–\d+ days remaining$/)).toBeVisible();
  expect(screen.queryByText(/across files/)).not.toBeInTheDocument();
  expect(screen.queryByText(/\d\.\d+ hours/)).not.toBeInTheDocument();
});

it('keeps an unknown provider reset uncertain despite a local retry deadline', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const waiting = activity();
  waiting.activeFiles = 1;
  waiting.detail = 'Provider availability is unknown; reading will retry automatically.';
  waiting.detailIsImportant = true;
  waiting.progress!.files = [
    {
      accounted: 2,
      total: 10,
      readWindows: 2,
      activeMs: 360000,
      sliceStartedAt: null,
      retryAt: '2026-09-28T12:01:00.000Z',
      done: false,
      exceptions: 0,
      uncertain: true,
    },
  ];
  render(<ImportReadingActivity activity={waiting} />);
  expect(screen.getByText(waiting.detail)).toBeVisible();
  expect(screen.getByText('Estimating…')).toBeVisible();
  expect(screen.queryByText(/Rough estimate/)).not.toBeInTheDocument();
});
