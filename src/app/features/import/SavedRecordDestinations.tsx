import { useResource, queryString } from '../../data/api';
import { clinicalPersonQuery } from '../../../shared/person-scope';
import { Check, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Intake, IntakeAcceptedRecord } from '../../../shared/intake';

export type SavedPersonDestination = {
  proposalId: string;
  noteId: string;
  personId: string;
  resultUrl: string;
  title: string;
};

export function appendSavedPersonDestination(
  current: SavedPersonDestination[],
  saved: SavedPersonDestination,
) {
  return [
    ...current.filter(
      (item) => item.proposalId !== saved.proposalId && item.noteId !== saved.noteId,
    ),
    saved,
  ];
}

export type AcceptedRecordScope = {
  groupId: string;
  proposalId: string | null;
  recordIds: Iterable<string>;
};

function destinationForOwner(record: IntakeAcceptedRecord, currentPersonId?: string | null) {
  const id = encodeURIComponent(record.entityId);
  const owner = clinicalPersonQuery(
    currentPersonId ?? record.identityAttribution?.assignedPerson?.personId,
  );
  if (record.kind === 'document' && record.optical)
    return {
      label: 'Vision prescription',
      to: `/tests?view=vision&document=${id}&visibility=all${owner}`,
    };
  if (record.kind === 'observation')
    return { label: 'Test result', to: `/tests?result=${id}&visibility=all${owner}` };
  if (record.kind === 'medication')
    return { label: 'Prescription', to: `/medications?id=${id}&status=all${owner}` };
  if (record.kind === 'procedure')
    return { label: 'Procedure', to: `/procedures?id=${id}&category=all&visibility=all${owner}` };
  return { label: 'Provider document', to: `/sources?document=${id}${owner}` };
}

export const acceptedRecordDestination = (record: IntakeAcceptedRecord) =>
  destinationForOwner(record);

/**
 * Resolve destinations only from durable import receipts for the exact proposal
 * and record IDs currently displayed. Candidate IDs and feed row IDs are never
 * treated as saved clinical entity IDs.
 */
export function acceptedRecordsForScope(intake: Intake, scope: AcceptedRecordScope) {
  const recordIds = new Set(scope.recordIds);
  const receipts = [
    ...(intake.acceptedProposalId === scope.proposalId && intake.imported?.clinical?.records
      ? [intake.imported.clinical.records]
      : []),
    ...(intake.importHistory || [])
      .filter((entry) => entry.acceptedProposalId === scope.proposalId)
      .reverse()
      .flatMap((entry) => (entry.clinical?.records ? [entry.clinical.records] : [])),
  ];
  const accepted: IntakeAcceptedRecord[] = [];
  const seen = new Set<string>();
  for (const records of receipts)
    for (const record of records) {
      if (!recordIds.has(record.recordId)) continue;
      const attributedGroup = record.identityAttribution?.groupId;
      if (attributedGroup && attributedGroup !== scope.groupId) continue;
      const key = `${record.recordId}:${record.entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accepted.push(record);
    }
  return accepted;
}

function displayTitle(record: IntakeAcceptedRecord, fallback: string) {
  return record.title && !/^[a-f\d]{40,}(?::.*)?$/i.test(record.title) ? record.title : fallback;
}

export function SavedRecordDestinationLink({ record }: { record: IntakeAcceptedRecord }) {
  const owner = useResource<{ personId: string | null }>(
    '/record-owner?' + queryString({ type: record.kind, id: record.entityId }),
  );
  const destination = destinationForOwner(record, owner.data?.personId ?? 'patient');
  // Receipt entity IDs remain exact. Current ownership is resolved independently
  // because a later coupled ownership correction never rewrites old receipts.
  return (
    <Link
      className="import-detail-record-link"
      to={destination.to}
      data-saved-record-id={record.recordId}
    >
      <span>
        <strong>{displayTitle(record, destination.label)}</strong>
        <small>
          {destination.label} ·{' '}
          {record.outcome === 'matched'
            ? 'Existing record linked'
            : record.outcome === 'updated'
              ? 'New version saved'
              : 'Added to profile'}
        </small>
      </span>
      <ExternalLink size={16} aria-hidden="true" />
    </Link>
  );
}

export function SavedPersonDestinationLink({
  destination,
}: {
  destination: SavedPersonDestination;
}) {
  return (
    <a
      className="import-detail-record-link"
      href={destination.resultUrl}
      data-saved-person-id={destination.personId}
    >
      <span>
        <strong>{destination.title}</strong>
        <small>Person · Saved in People</small>
      </span>
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

export function SavedPersonDestinations({
  destinations,
  label = 'Just saved People',
}: {
  destinations: SavedPersonDestination[];
  label?: string;
}) {
  if (!destinations.length) return null;
  return (
    <section className="import-saved-destinations" aria-label={label}>
      <h3>
        <Check size={18} aria-hidden="true" /> {label}
      </h3>
      <p>Open the exact People entries confirmed by these saves.</p>
      <div className="import-detail-records">
        {destinations.map((destination) => (
          <SavedPersonDestinationLink
            destination={destination}
            key={`${destination.proposalId}:${destination.noteId}`}
          />
        ))}
      </div>
    </section>
  );
}

export function SavedRecordDestinations({
  records,
  label = 'Saved destinations',
  error,
  onRetry,
}: {
  records: IntakeAcceptedRecord[];
  label?: string;
  error?: string;
  onRetry?: () => void;
}) {
  if (!records.length && !error) return null;
  const activationAvailable = records.some(
    (record) => record.kind === 'medication' && record.outcome === 'added',
  );
  return (
    <section className="import-saved-destinations" aria-label={label}>
      <h3>
        <Check size={18} aria-hidden="true" /> {label}
      </h3>
      {error && (
        <p role="alert">
          {error}{' '}
          {onRetry && (
            <button className="button secondary" onClick={onRetry}>
              Retry saved links
            </button>
          )}
        </p>
      )}
      <p>Open the exact profile records created or linked by this reviewed save.</p>
      <div className="import-detail-records">
        {records.map((record) => (
          <SavedRecordDestinationLink
            record={record}
            key={`${record.recordId}:${record.entityId}`}
          />
        ))}
      </div>
      {activationAvailable && (
        <div className="import-saved-activation">
          <span>New prescriptions start Inactive until you choose the ones you still take.</span>
          <Link className="button secondary" to="/medications?status=inactive&activation=1">
            Activate prescriptions
          </Link>
        </div>
      )}
    </section>
  );
}
