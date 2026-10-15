import { useEffect, useState } from 'react';
import {
  recordCorrections,
  recordCorrectionStages,
  hasReferencedImportCorrections,
} from '../data/record-corrections';
import { formatDate } from '../data/format';
import { useResource } from '../data/api';
import { useProfile } from '../data/profile';
import type { CorrectableClinicalKind } from '../../shared/record-correction';
import type { ClinicalImportCorrectionHistoryPage } from '../../shared/clinical-import-corrections';
import { ReviewDraftHistory } from '../features/intake/ReviewDraftHistory';

export function RecordCorrectionBadges({ extra }: { extra: unknown }) {
  const stages = recordCorrectionStages(extra);
  if (stages.imported && stages.later)
    return (
      <span
        className="soft-badge correction-pill"
        title="Modified during import and corrected afterward"
      >
        Corrections
      </span>
    );
  return (
    <>
      {stages.imported && (
        <span className="soft-badge correction-pill">Modified during import</span>
      )}
      {stages.later && <span className="soft-badge correction-pill">Corrected after import</span>}
    </>
  );
}

const fieldLabels: Record<string, string> = {
  testLabel: 'Test name',
  valueText: 'Result',
  unit: 'Unit',
  date: 'Date',
  kind: 'Record type',
  status: 'Status',
  referenceRange: 'Reference range',
  observationCategory: 'Test classification',
  specimen: 'Specimen',
  method: 'Method',
  subject: 'Subject',
  personId: 'Person',
  sourceSystem: 'Source',
  eventKind: 'Event type',
  code: 'Code',
  codeSystem: 'Code system',
  documentTitle: 'Title',
  text: 'Text',
};
function valueText(value: unknown) {
  if (value === '' || value === null || value === undefined) return 'Not recorded';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function RecordCorrectionHistory({
  extra,
  open = false,
  kind,
  recordId,
}: {
  extra: unknown;
  open?: boolean;
  kind?: CorrectableClinicalKind;
  recordId?: string;
}) {
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open, kind, recordId]);
  const entries = recordCorrections(extra);
  const referenced = hasReferencedImportCorrections(extra);
  if (!entries.length && !referenced) return null;
  return (
    <details
      className="record-correction-history"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {referenced ? 'Correction history' : `Correction history (${entries.length})`}
      </summary>
      {referenced && (
        <p>
          Import corrections are retained with each accepted source contribution. Open their history
          below; the inline entries alone are not the complete import history.
        </p>
      )}
      {referenced &&
        expanded &&
        (kind && recordId ? (
          <AcceptedImportCorrections key={`${kind}:${recordId}`} kind={kind} recordId={recordId} />
        ) : (
          <p role="status">Open this record to load its complete import correction history.</p>
        ))}
      <ol>
        {entries.map((entry, index) => (
          <li key={index}>
            <strong>{entry.stage === 'import' ? 'During import' : 'After import'}</strong>
            {entry.at && <span className="helper-text"> · {formatDate(entry.at)}</span>}
            <p>
              {entry.stage === 'import' ? 'Import correction' : 'Saved-record correction'}:{' '}
              {entry.reason || 'No reason retained'}
            </p>
            <dl>
              {entry.changes.map((change) => (
                <div key={change.field}>
                  <dt>{fieldLabels[change.field] || change.field}</dt>
                  <dd>
                    <span>{valueText(change.before)}</span>
                    <span aria-label="changed to"> → </span>
                    <strong>{valueText(change.after)}</strong>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </details>
  );
}

function AcceptedImportCorrections({
  kind,
  recordId,
}: {
  kind: CorrectableClinicalKind;
  recordId: string;
}) {
  const profile = useProfile();
  const [after, setAfter] = useState<string>();
  const query = new URLSearchParams({ kind, recordId, limit: '20' });
  if (after) query.set('after', after);
  const resource = useResource<ClinicalImportCorrectionHistoryPage>(
    `/record-import-corrections?${query}`,
  );
  useEffect(() => setAfter(undefined), [profile?.id, kind, recordId]);
  const page = resource.data;
  const valid =
    page &&
    page.format === 'health-clinical-import-corrections-v1' &&
    page.kind === kind &&
    page.recordId === recordId &&
    page.entries.length <= 20 &&
    (page.complete
      ? page.nextCursor === null
      : !!page.nextCursor && page.nextCursor !== after && page.entries.length > 0) &&
    page.entries.every(
      (entry) =>
        entry.intakeId === entry.history.intakeId &&
        [
          'health-intake-review-draft-history-v1',
          'health-intake-review-draft-legacy-history-v1',
        ].includes(entry.history.format) &&
        entry.history.corrections > 0,
    );
  const refresh = () => {
    setAfter(undefined);
    resource.reload();
  };
  if (resource.error || (page && !valid))
    return (
      <p role="alert">
        {resource.error?.message ||
          'This correction page changed. Reload the saved record history.'}
        <button className="button secondary" type="button" onClick={refresh}>
          Reload import correction history
        </button>
      </p>
    );
  if (!page) return <p role="status">Loading complete import correction history…</p>;
  return (
    <section aria-label="Accepted source correction histories">
      <p>
        {page.entries.length} accepted source {page.entries.length === 1 ? 'history' : 'histories'}{' '}
        on this page.{!page.complete ? ' More accepted source histories are available.' : ''}
      </p>
      {page.entries.map((entry) => (
        <article key={entry.id}>
          <h4>During import · {formatDate(entry.at)}</h4>
          <ReviewDraftHistory history={entry.history} initialSection="corrections" />
        </article>
      ))}
      {page.nextCursor && (
        <button
          className="button secondary"
          type="button"
          disabled={resource.loading || resource.refreshing}
          onClick={() => setAfter(page.nextCursor!)}
        >
          Next accepted source histories
        </button>
      )}
      {after && (
        <button className="button secondary" type="button" onClick={() => setAfter(undefined)}>
          First accepted source histories
        </button>
      )}
    </section>
  );
}
