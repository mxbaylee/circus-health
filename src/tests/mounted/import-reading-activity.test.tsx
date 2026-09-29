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
  expect(screen.getByText(/Current file: Rough estimate:/)).toBeVisible();
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
  expect(screen.queryByText('Calculating remaining time')).toBeNull();
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
  expect(screen.getByText('Calculating remaining time')).toBeVisible();
  act(() => vi.advanceTimersByTime(15_000));
  expect(screen.getByText('Rough estimate: 1–2 minutes remaining')).toBeVisible();
  reading.progress!.readWindows = 2;
  reading.progress!.readyRecords = 8;
  act(() => vi.advanceTimersByTime(105_000));
  view.rerender(<ImportReadingActivity activity={reading} />);
  expect(screen.getByText('Rough estimate: 2–6 minutes remaining')).toBeVisible();
  expect(screen.queryByText('Calculating remaining time')).toBeNull();
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
  expect(screen.getByText('Rough estimate: 1–2 minutes remaining')).toBeVisible();
});
