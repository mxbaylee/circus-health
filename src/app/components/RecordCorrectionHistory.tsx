import { recordCorrections, recordCorrectionStages } from '../data/record-corrections';
import { formatDate } from '../data/format';

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
}: {
  extra: unknown;
  open?: boolean;
}) {
  const entries = recordCorrections(extra);
  if (!entries.length) return null;
  return (
    <details className="record-correction-history" open={open}>
      <summary>Correction history ({entries.length})</summary>
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
