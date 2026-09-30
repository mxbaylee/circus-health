import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { IntakeReportSourceReview } from '../../../shared/intake';
import type { ImportReviewReport } from './ImportReviewPresentation';

export function ImportSourceSheetControls({
  report,
  active,
  reviewSource,
  changeSource,
  close,
  sourceBusy,
  setSourceBusy,
}: {
  report: ImportReviewReport;
  active: boolean;
  reviewSource?: (reportId: string) => Promise<IntakeReportSourceReview>;
  changeSource: (
    reportId: string,
    source: string,
    review?: IntakeReportSourceReview,
  ) => Promise<string | null>;
  close: () => void;
  sourceBusy: boolean;
  setSourceBusy: (busy: boolean) => void;
}) {
  const [source, setSource] = useState(report?.sourceNeedsLabel ? '' : report?.source || '');
  const [sourceError, setSourceError] = useState('');
  const [sourceReviewError, setSourceReviewError] = useState('');
  const [sourceReview, setSourceReview] = useState<IntakeReportSourceReview | null>(null);
  const [sourceReviewLoading, setSourceReviewLoading] = useState(false);
  const sourceReviewGeneration = useRef(0);
  const sourceSheetGeneration = useRef(0);
  const reviewSourceAction = useRef(reviewSource);
  reviewSourceAction.current = reviewSource;
  const loadSourceReview = async (preserveActionError = false) => {
    const action = reviewSourceAction.current;
    if (!active || !action) return;
    const generation = ++sourceReviewGeneration.current;
    setSourceReview(null);
    if (!preserveActionError) setSourceError('');
    setSourceReviewError('');
    setSourceReviewLoading(true);
    try {
      const review = await action(report.id);
      if (generation === sourceReviewGeneration.current) setSourceReview(review);
    } catch (cause) {
      if (generation === sourceReviewGeneration.current)
        setSourceReviewError(
          cause instanceof Error ? cause.message : 'The affected source records could not load.',
        );
    } finally {
      if (generation === sourceReviewGeneration.current) setSourceReviewLoading(false);
    }
  };
  useEffect(() => {
    void loadSourceReview();
    return () => {
      sourceReviewGeneration.current += 1;
      sourceSheetGeneration.current += 1;
    };
  }, [report.id, active]);
  return (
    <div hidden={!active}>
      <Dialog.Description>
        Use this label for the report and eligible results you save. Original issuer and upload
        history stay unchanged.
      </Dialog.Description>
      {report.sourceEvidence?.contentUrl && (
        <a
          className="button secondary import-open-original"
          href={report.sourceEvidence.contentUrl}
          target="_blank"
          rel="noreferrer"
        >
          Review {report.sourceEvidence.label} <ArrowUpRight size={12} />
        </a>
      )}
      <label>
        Source
        <input
          value={source}
          placeholder="Clinic, lab, or archive name"
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <p className="import-sheet-note">
        This source is used when you save records. Change it here if needed.
      </p>
      {report.sourceCoverage && (
        <p className="import-sheet-note">
          Current {report.sourceCoverage.current.covered}/{report.sourceCoverage.current.total}{' '}
          source-labeled · Saved {report.sourceCoverage.saved.covered}/
          {report.sourceCoverage.saved.total}
        </p>
      )}
      {sourceReviewLoading && <p className="import-sheet-note">Loading affected records…</p>}
      {sourceReview && (
        <div className="import-sheet-card import-context-card">
          <strong>
            {sourceReview.targets.length} {sourceReview.targets.length === 1 ? 'record' : 'records'}{' '}
            will use “{source.trim() || 'this source'}”
          </strong>
          <span>
            {sourceReview.coverage.covered} already have a reviewed source;{' '}
            {sourceReview.coverage.uncovered} do not.
          </span>
          {!!sourceReview.sourceEvidence.length && (
            <span>Retained source evidence: {sourceReview.sourceEvidence.join(', ')}.</span>
          )}
          {sourceReview.warning && <span role="alert">{sourceReview.warning}</span>}
          {source.trim() &&
            sourceReview.sourceEvidence.some((value) => value !== source.trim()) && (
              <span role="alert">
                “{source.trim()}” differs from retained source evidence. Check the original before
                confirming this one label.
              </span>
            )}
          <ul>
            {sourceReview.targets.map((target) => (
              <li key={target.id}>
                {target.title}
                {target.date ? ` · ${target.date}` : ''} · {target.occurrence.locator}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sourceError && <p role="alert">{sourceError}</p>}
      {sourceReviewError && <p role="alert">{sourceReviewError}</p>}
      <div className="import-sheet-actions">
        <button className="button secondary" type="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          type="button"
          disabled={
            sourceBusy ||
            sourceReviewLoading ||
            (!sourceReview && !!reviewSource ? !(sourceError || sourceReviewError) : !source.trim())
          }
          onClick={() => {
            if (!sourceReview && reviewSource && (sourceError || sourceReviewError)) {
              void loadSourceReview(true);
              return;
            }
            const submittedGeneration = sourceSheetGeneration.current;
            setSourceBusy(true);
            setSourceError('');
            setSourceReviewError('');
            void changeSource(report.id, source.trim(), sourceReview || undefined)
              .then(async (message) => {
                if (submittedGeneration !== sourceSheetGeneration.current) return;
                if (!message) {
                  close();
                  return;
                }
                setSourceError(message);
                await loadSourceReview(true);
              })
              .catch(async (cause) => {
                if (submittedGeneration !== sourceSheetGeneration.current) return;
                setSourceError(
                  cause instanceof Error ? cause.message : 'The source label could not be applied.',
                );
                await loadSourceReview(true);
              })
              .finally(() => {
                if (submittedGeneration === sourceSheetGeneration.current) setSourceBusy(false);
              });
          }}
        >
          {sourceBusy
            ? 'Using source…'
            : !sourceReview && reviewSource && (sourceError || sourceReviewError)
              ? 'Retry affected records'
              : sourceReview
                ? `Use ${source.trim()} for ${sourceReview.targets.length} ${
                    sourceReview.targets.length === 1 ? 'record' : 'records'
                  }`
                : 'Use source'}
        </button>
      </div>
    </div>
  );
}
