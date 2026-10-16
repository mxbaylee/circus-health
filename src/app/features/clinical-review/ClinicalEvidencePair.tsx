import type { ReactNode } from 'react';
import type {
  IntakeClinicalMapping,
  IntakeEvidenceComparison,
  IntakeReviewRecord,
} from '../../../shared/intake';
import type { SavedDuplicateEvidenceReference } from '../../../shared/saved-duplicate-evidence';
import { SavedDuplicateEvidence } from './SavedDuplicateEvidence';
import { apiUrl } from '../../data/api';
import './clinical-review.css';

function facts(mapping: IntakeClinicalMapping) {
  return [
    mapping.valueText,
    mapping.unit,
    mapping.doseText,
    mapping.eventKind && mapping.eventKind !== 'unknown'
      ? mapping.eventKind.replaceAll('_', ' ')
      : '',
    mapping.status,
  ]
    .filter(Boolean)
    .join(' · ');
}

function EvidenceSide({
  heading,
  label,
  date,
  mapping,
  evidence,
  onCorrect,
  disabled = false,
}: {
  heading: string;
  label: string;
  date: string | null;
  mapping: IntakeClinicalMapping;
  evidence: IntakeReviewRecord['evidence'] | SavedDuplicateEvidenceReference;
  onCorrect?: () => void;
  disabled?: boolean;
}) {
  return (
    <section>
      <h5>{heading}</h5>
      <strong>{label}</strong>
      <p>
        {date || 'Unknown date'}
        {facts(mapping) ? ` · ${facts(mapping)}` : ''}
      </p>
      {!Array.isArray(evidence) ? (
        <SavedDuplicateEvidence reference={evidence} />
      ) : evidence.length ? (
        evidence.map((item, index) => (
          <p key={`${item.locator}-${index}`}>
            {item.label}: {item.locator}
            {item.contentUrl && (
              <>
                {' '}
                ·{' '}
                <a
                  href={
                    item.contentUrl.startsWith('/api/') ? apiUrl(item.contentUrl) : item.contentUrl
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  Open original
                </a>
              </>
            )}
          </p>
        ))
      ) : (
        <p>No original locator was supplied.</p>
      )}
      {onCorrect && (
        <button type="button" className="button secondary" onClick={onCorrect} disabled={disabled}>
          Correct this saved record
        </button>
      )}
    </section>
  );
}

type IncomingEvidence =
  | {
      incoming: Pick<IntakeReviewRecord, 'title' | 'date' | 'mapping' | 'evidence'>;
      incomingContent?: never;
    }
  | { incoming?: never; incomingContent: ReactNode };
type SavedEvidence =
  | {
      saved: IntakeEvidenceComparison;
      savedContent?: never;
      onCorrectSaved?: (record: IntakeEvidenceComparison) => void;
    }
  | { saved?: never; savedContent: ReactNode; onCorrectSaved?: never };

/** Shared presentation only: fragment slots preserve exact evidence without inventing a complete record. */
export function ClinicalEvidencePair({
  incoming,
  incomingContent,
  saved,
  savedContent,
  onCorrectSaved,
  disabled = false,
}: IncomingEvidence & SavedEvidence & { disabled?: boolean }) {
  return (
    <div className="clinical-evidence-pair">
      {incoming ? (
        <EvidenceSide
          heading="Incoming record"
          label={incoming.title}
          date={incoming.date}
          mapping={incoming.mapping}
          evidence={incoming.evidence}
        />
      ) : (
        <section>
          <h5>Incoming record</h5>
          {incomingContent}
        </section>
      )}
      {saved ? (
        <EvidenceSide
          heading="Previously accepted record"
          label={saved.title}
          date={saved.date}
          mapping={saved.mapping}
          evidence={saved.evidence}
          onCorrect={onCorrectSaved ? () => onCorrectSaved(saved) : undefined}
          disabled={disabled}
        />
      ) : (
        <section>
          <h5>Previously accepted record</h5>
          {savedContent}
        </section>
      )}
    </div>
  );
}
