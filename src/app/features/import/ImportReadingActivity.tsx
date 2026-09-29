import { useEffect, useState } from 'react';
import { Square, Play } from 'lucide-react';
import { JesterCartwheel } from '../assistant/MoxieActivityAlternative';
import type { ImportReviewModel } from './ImportReviewPresentation';

function duration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60),
    remaining = minutes % 60;
  return (
    `${hours} ${hours === 1 ? 'hour' : 'hours'}` +
    (remaining ? ` ${remaining} ${remaining === 1 ? 'minute' : 'minutes'}` : '')
  );
}

/** A deliberately broad live heuristic, not a measured completion guarantee. */
function remainingEstimate(
  progress: NonNullable<NonNullable<ImportReviewModel['activity']>['progress']>,
  now: number,
  elapsedMs: number | null,
  activeFiles: number,
) {
  const slice = progress.sliceStartedAt ? Date.parse(progress.sliceStartedAt) : NaN;
  const activeMs =
    Math.max(0, progress.activeMs) + (Number.isFinite(slice) ? Math.max(0, now - slice) : 0);
  // A batch wall clock is usable only for a single file without an active clock.
  // Never multiply the current file's pace by unrelated queued files.
  const spent = activeMs || (activeFiles === 1 ? elapsedMs : null);
  if (spent === null || spent < 15_000 || progress.total <= 0) return null;
  if (progress.accounted >= progress.total) return 'Finishing up…';
  // Reading is only part of the work: leave half the weight for extraction and
  // coverage reconciliation. Repeated reads cannot increase this proxy past total.
  const completed = Math.max(
    progress.accounted,
    Math.min(progress.total, progress.readWindows) / 2,
  );
  const perUnit = Math.max(15_000, spent / Math.max(1, completed));
  const remaining = Math.max(30_000, (progress.total - completed) * perUnit);
  const low = Math.max(1, Math.ceil(remaining / 60_000));
  const high = Math.max(low + 1, Math.ceil((remaining * 3) / 60_000));
  return `${activeFiles > 1 ? 'Current file: ' : ''}Rough estimate: ${low}–${high} minutes remaining`;
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
  const started = progress?.elapsedStartedAt ? Date.parse(progress.elapsedStartedAt) : NaN;
  const ended = progress?.elapsedEndedAt ? Date.parse(progress.elapsedEndedAt) : now;
  const elapsedMs =
    Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
  const estimate =
    progress && !activity?.detailIsImportant
      ? remainingEstimate(progress, now, elapsedMs, activity?.activeFiles || 0)
      : null;
  return (
    <div className="import-reading">
      <JesterCartwheel className={`import-reading-jester${active ? '' : ' is-idle'}`} />
      <div className="import-reading-copy">
        <strong aria-live="polite">{activity?.label || 'Moxie is ready'}</strong>
        {(!progress || !active || activity?.detailIsImportant) && (
          <small>{activity?.detail || 'Drop a report here when you are ready.'}</small>
        )}
        {progress && (
          <div className="import-reading-progress">
            <small>
              Discovered {progress.readyRecords}{' '}
              {progress.readyRecords === 1 ? 'record' : 'records'}
              {elapsedMs !== null ? ` in ${duration(elapsedMs)}` : ''}.
            </small>
            {active && !activity?.detailIsImportant && (
              <small>
                {estimate || (
                  <>
                    {progress.total > 0 ? 'Calculating remaining time' : 'Preparing source'}
                    <span className="import-reading-dots" aria-hidden="true">
                      .<span>.</span>
                      <span>.</span>
                    </span>
                  </>
                )}
              </small>
            )}
          </div>
        )}
        {!!activity?.activeFiles && !activity?.uploading && (
          <small>You can leave this page while Moxie reads.</small>
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
