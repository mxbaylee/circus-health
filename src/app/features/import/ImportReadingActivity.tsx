import { useEffect, useState } from 'react';
import { Square, Play } from 'lucide-react';
import { JesterCartwheel } from '../assistant/MoxieActivityAlternative';
import type { ImportReviewModel } from './ImportReviewPresentation';

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ImportReadingActivity({
  activity,
  onStop,
  onResume,
}: {
  activity?: ImportReviewModel['activity'];
  onStop?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
}) {
  const [now, setNow] = useState(Date.now);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  async function runAction(action: () => void | Promise<void>) {
    setActionError(null);
    setActing(true);
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'The reading action failed. Try again.',
      );
    } finally {
      setActing(false);
    }
  }
  const active = !!activity?.activeFiles || !!activity?.uploading;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const progress = activity?.progress;
  return (
    <div className="import-reading">
      <JesterCartwheel className={`import-reading-jester${active ? '' : ' is-idle'}`} />
      <div className="import-reading-copy">
        <strong aria-live="polite">{activity?.label || 'Moxie is ready'}</strong>
        <small>{activity?.detail || 'Drop a report here when you are ready.'}</small>
        {progress && (
          <div className="import-reading-progress">
            {progress.total > 0 && (
              <>
                <small>
                  {progress.accounted} of {progress.total} source sections accounted for
                </small>
              </>
            )}
            <small>
              {progress.readyRecords}{' '}
              {progress.readyRecords === 1 ? 'source entry' : 'source entries'} found ·{' '}
              {progress.readWindows} source {progress.readWindows === 1 ? 'window' : 'windows'} read
            </small>
            {progress.pageTiming && progress.pageTiming.turn > 1 && (
              <small>
                Model context restarted · Pass {progress.pageTiming.turn}. Recent page timing starts
                again for this pass.
              </small>
            )}
            {progress.pageTiming?.recentIntervalMs != null && (
              <small>
                Recent interval between page reads {duration(progress.pageTiming.recentIntervalMs)}{' '}
                on average across {progress.pageTiming.intervalSamples}{' '}
                {progress.pageTiming.intervalSamples === 1 ? 'interval' : 'intervals'} · Includes
                repeat reads, model and tool work; not a completion estimate.
              </small>
            )}
            {progress.pageTiming?.lastReadMs != null && (
              <small>Last page prepared in {duration(progress.pageTiming.lastReadMs)}.</small>
            )}
            {(progress.activeMs > 0 || progress.sliceStartedAt) && (
              <small>
                Active reading{' '}
                {duration(
                  progress.activeMs +
                    (active && progress.sliceStartedAt
                      ? Math.max(0, now - Date.parse(progress.sliceStartedAt))
                      : 0),
                )}
                {active && progress.lastProgressAt
                  ? ` · Last progress ${duration(now - Date.parse(progress.lastProgressAt))} ago`
                  : active
                    ? ' · Waiting for first reading progress'
                    : ''}
              </small>
            )}
          </div>
        )}
      </div>
      <div className="import-reading-controls">
        {onStop && (
          <button
            className="button danger"
            type="button"
            disabled={activity?.controlsBusy || acting}
            onClick={() => void runAction(onStop)}
          >
            <Square size={14} />
            Stop reading
          </button>
        )}
        {onResume && !onStop && (
          <button
            className="button secondary"
            type="button"
            disabled={activity?.controlsBusy || acting}
            onClick={() => void runAction(onResume)}
          >
            <Play size={14} />
            {activity?.resumeLabel || 'Resume reading'}
          </button>
        )}
        {actionError && <p role="alert">{actionError}</p>}
      </div>
    </div>
  );
}
