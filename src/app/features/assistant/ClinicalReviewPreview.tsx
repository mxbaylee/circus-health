import type {
  AssistantProposal,
  ClinicalReviewEvidence,
  FutureClassificationPreview,
} from './types';
import { apiUrl } from '../../data/api';
const value = (item: unknown) =>
  item === null || item === undefined || item === ''
    ? 'Not supplied'
    : typeof item === 'string'
      ? item
      : JSON.stringify(item);
const label = (key: string) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase());
function Evidence({ items }: { items: ClinicalReviewEvidence[] }) {
  return (
    <div>
      {items.map((item, index) => (
        <p key={index}>
          {item.acquiringSource || item.label || 'Original source'}: {value(item.locator)}
          {item.contentUrl && (
            <>
              {' '}
              ·{' '}
              <a href={apiUrl(item.contentUrl)} target="_blank" rel="noreferrer">
                Open original
              </a>
            </>
          )}
        </p>
      ))}
    </div>
  );
}
export function ClinicalReviewPreview({
  proposal,
}: {
  proposal: Extract<
    AssistantProposal,
    {
      kind: 'clinical_correction' | 'duplicate_decision' | 'intake_draft_repair' | 'mapping';
    }
  >;
}) {
  if (!proposal.preview) return null;
  if (proposal.kind === 'intake_draft_repair') {
    const preview = proposal.preview;
    return (
      <section aria-label="Selected import draft correction preview">
        {preview.rows.map((row, index) => (
          <section key={`${row.recordId}:${row.field}:${index}`}>
            <p>
              <strong>{row.title}</strong> · {label(row.field)}: {value(row.before)} →{' '}
              {value(row.after)}
            </p>
            <Evidence items={row.evidence} />
          </section>
        ))}
        {preview.unresolvedNotes.map((note, index) => (
          <p key={index}>Still unresolved: {note}</p>
        ))}
        <p className="helper-text">
          Apply changes only these selected draft fields. The retained original and acceptance state
          stay unchanged. Source citations show where to review; they do not verify the proposed
          interpretation.
        </p>
      </section>
    );
  }
  if (proposal.kind === 'mapping') {
    const preview = proposal.preview as FutureClassificationPreview;
    if (preview.scope !== 'future_imports')
      return (
        <details>
          <summary>Proposed changes</summary>
          <pre>{JSON.stringify(proposal.changes, null, 2)}</pre>
        </details>
      );
    return (
      <section aria-label="Future classification rule preview">
        <p>
          <strong>Future imports only</strong>. Existing accepted records changed: {preview.count}.
        </p>
        <p>
          Acquiring source: {preview.match.providerName || preview.match.providerId}. Original
          source system: {preview.match.sourceSystem}. Exact original kind and label:{' '}
          {preview.match.kind} · {preview.match.label}.
        </p>
        <p>
          Proposed classification:{' '}
          {Object.entries(preview.set)
            .map(([key, item]) => `${label(key)}: ${item}`)
            .join(' · ')}
          .
        </p>
        <p>
          {preview.matchingExistingCount} existing records match this scope;{' '}
          {preview.exceptionCount} have individual exceptions that take precedence.
        </p>
        {preview.examples.map((item) => (
          <section key={item.id}>
            <p>
              {value(
                item.before.testLabel || item.before.procedureLabel || item.before.documentTitle,
              )}
              : {value(item.before.kind)} → {value(item.after.kind)}
              {item.individualException ? ' · Individual exception retained' : ''}
            </p>
            {item.problem && <p>Needs import review: {item.problem}</p>}
          </section>
        ))}
        {!preview.complete && <p>Showing the first 30 matching examples.</p>}
        <p className="helper-text">
          Each future candidate still requires import review. Values, dates, doses and event
          identity are never copied by this rule. Missing evidence remains a question. The
          individual correction is a separate proposal.
        </p>
      </section>
    );
  }
  if (proposal.kind === 'clinical_correction') {
    const preview = proposal.preview;
    return (
      <section aria-label="Individual correction preview">
        {preview.reclassification && (
          <p>
            <strong>Reclassify this accepted record</strong>. The earlier classification remains in
            searchable history and existing references still resolve.
          </p>
        )}
        {Object.keys(preview.after)
          .filter(
            (key) => JSON.stringify(preview.before[key]) !== JSON.stringify(preview.after[key]),
          )
          .map((key) => (
            <p key={key}>
              <strong>{label(key)}</strong>: {value(preview.before[key])} →{' '}
              {value(preview.after[key])}
            </p>
          ))}
        <Evidence items={preview.evidence} />
        <p className="helper-text">
          Only this record changes. No future-import rule is created. Original evidence and personal
          medication-use selections stay retained. Later source rules preserve this individual
          exception.
        </p>
      </section>
    );
  }
  const preview = proposal.preview;
  return (
    <section aria-label="Paired evidence preview">
      <p>
        <strong>{label(preview.outcome.replaceAll('_', ' '))}</strong>: {preview.reason}
      </p>
      <div className="assistant-evidence-pair">
        {[preview.left, preview.right].map((side, index) => (
          <section key={index}>
            <h5>{index ? 'Second record' : 'First record'}</h5>
            <strong>{side.title}</strong>
            <p>{side.date || 'Unknown date'}</p>
            <dl>
              {Object.entries(side.mapping)
                .filter(
                  ([key, item]) =>
                    [
                      'valueText',
                      'unit',
                      'doseText',
                      'status',
                      'eventKind',
                      'procedureCategory',
                      'visitSpecialty',
                    ].includes(key) && item,
                )
                .map(([key, item]) => (
                  <div key={key}>
                    <dt>{label(key)}</dt>
                    <dd>{value(item)}</dd>
                  </div>
                ))}
            </dl>
            <Evidence items={side.evidence} />
          </section>
        ))}
      </div>
      <p className="helper-text">
        Every assertion, original and existing link is retained. Grouping does not choose between
        conflicting clinical values.
      </p>
    </section>
  );
}
