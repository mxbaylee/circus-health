import type {
  AcceptedMeasurement,
  MeasurementSemanticApplyRequest,
  MeasurementSemanticApplyResult,
  MeasurementSemanticPreview,
  MeasurementSemanticRequest,
} from '../../../shared/measurement-semantics';
import { api, useResource } from '../../data/api';
import { LoadingIndicator } from '../../components/LoadingIndicator';
import { MeasurementComparison } from './MeasurementComparison';
import { MeasurementSettingsAction } from './MeasurementSettingsAction';
import './measurement-review-panel.css';

const statusLabels: Record<AcceptedMeasurement['semanticStatus'], string> = {
  none: 'Meaning not reviewed',
  current: 'Reviewed',
  stale: 'Review out of date',
  revoked: 'Review withdrawn',
};

const isAcceptedMeasurement = (value: unknown): value is AcceptedMeasurement => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AcceptedMeasurement>;
  return (
    !!candidate.reference &&
    !!candidate.source &&
    typeof candidate.source.valueText === 'string' &&
    ['none', 'current', 'stale', 'revoked'].includes(String(candidate.semanticStatus))
  );
};

export function MeasurementReviewPanel({
  kind,
  recordId,
  title,
  referenceText,
  onApplied,
}: {
  kind: 'observation' | 'procedure';
  recordId: string;
  title: string;
  referenceText?: string | null;
  onApplied: (result: MeasurementSemanticApplyResult) => void | Promise<void>;
}) {
  const resource = useResource<AcceptedMeasurement>(
    `/clinical-review/measurement?kind=${encodeURIComponent(kind)}&recordId=${encodeURIComponent(recordId)}`,
  );
  const preview = (request: MeasurementSemanticRequest) =>
    api<MeasurementSemanticPreview>('/clinical-review/measurement-preview', {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);
  const apply = (request: MeasurementSemanticApplyRequest) =>
    api<MeasurementSemanticApplyResult>('/clinical-review/measurement-apply', {
      method: 'POST',
      body: JSON.stringify(request),
    }).then(({ data }) => data);
  const measurement = isAcceptedMeasurement(resource.data) ? resource.data : null;

  return (
    <section className="measurement-review-panel" aria-label="Reviewed measurement display">
      <div className="section-heading">
        <div>
          <h3>Measurement display</h3>
          <p className="helper-text">
            Conversions require settings you explicitly review. The recorded value and reference
            range remain unchanged.
          </p>
        </div>
        {measurement && (
          <span className="soft-badge">{statusLabels[measurement.semanticStatus]}</span>
        )}
      </div>
      {resource.loading ? (
        <LoadingIndicator label="Loading measurement settings…" layout="panel" />
      ) : resource.error || (resource.data !== null && !measurement) ? (
        <div className="measurement-review-unavailable" role="status">
          <p>
            Reviewed measurement display is unavailable for this record. Its original value and
            source evidence remain available in the record details.
          </p>
          {(!resource.error || resource.error.status === 0 || resource.error.status >= 500) && (
            <button type="button" className="text-link" onClick={resource.reload}>
              Retry
            </button>
          )}
        </div>
      ) : measurement ? (
        <>
          <MeasurementComparison left={{ title, measurement, referenceText }} />
          <div className="measurement-review-controls">
            <MeasurementSettingsAction
              target={{ title, measurement, referenceText }}
              preview={preview}
              apply={apply}
              onApplied={(result) => {
                resource.reload();
                void onApplied(result);
              }}
            />
            <p className="helper-text">
              These settings affect derived display and comparisons only. They do not rewrite the
              accepted clinical record.
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
