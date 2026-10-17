import { api, useResource, queryString } from '../../data/api';
import { clinicalPersonQuery } from '../../../shared/person-scope';
import { Check, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Intake, IntakeAcceptedRecord } from '../../../shared/intake';
import type { IntakeIdentityPerson } from '../../../shared/intake-identity';
import { importPersonLabel } from './import-person-label';
import { createContext, useContext, type ReactNode } from 'react';
import {
  isIntakeSummary,
  type IntakePublicRead,
  type IntakeAcceptedDestinations,
} from '../../../shared/intake-summary';

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

const SavedPeopleContext = createContext<IntakeIdentityPerson[] | null>(null);
/** One current People read serves all exact destination links in a rendered list. */
export function SavedRecordPeople({
  children,
  people: supplied,
  error: suppliedError,
  onRetry,
}: {
  children: ReactNode;
  people?: IntakeIdentityPerson[];
  error?: boolean;
  onRetry?: () => void;
}) {
  const people = useResource<IntakeIdentityPerson[]>(supplied ? null : '/record-ownership/people');
  const failed = supplied ? suppliedError : !!people.error;
  return (
    <SavedPeopleContext value={supplied ?? (Array.isArray(people.data) ? people.data : [])}>
      {failed && <PeopleLookupRetry onRetry={supplied ? onRetry : people.reload} />}
      {children}
    </SavedPeopleContext>
  );
}

function PeopleLookupRetry({ onRetry }: { onRetry?: () => void }) {
  return (
    <p role="alert">
      Person details could not be loaded.{' '}
      {onRetry && (
        <button type="button" className="text-link" onClick={onRetry}>
          Retry person details
        </button>
      )}
    </p>
  );
}

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

/** Never interpret unloaded receipt history as evidence that no record was saved. */
export async function loadAcceptedRecordsForScope(
  intakeId: string,
  scope: AcceptedRecordScope,
  selected?: IntakePublicRead,
) {
  const intake =
    selected ?? (await api<IntakePublicRead>(`/intakes/${encodeURIComponent(intakeId)}`)).data;
  if (!isIntakeSummary(intake)) return acceptedRecordsForScope(intake, scope);
  const recordIds = [...new Set(scope.recordIds)];
  if (recordIds.length > 100) throw new Error('Choose at most 100 saved records at a time.');
  if (!recordIds.length) return [];
  const query = new URLSearchParams({ groupId: scope.groupId });
  if (scope.proposalId !== null) query.set('proposalId', scope.proposalId);
  for (const id of recordIds) query.append('recordId', id);
  const result = (
    await api<IntakeAcceptedDestinations>(
      `/intakes/${encodeURIComponent(intakeId)}/accepted-destinations?${query}`,
    )
  ).data;
  if (
    result.intakeId !== intakeId ||
    result.version !== intake.version ||
    result.groupId !== scope.groupId ||
    result.proposalId !== scope.proposalId
  )
    throw new Error('Saved record links did not match the selected report.');
  return result.records;
}

function displayTitle(record: IntakeAcceptedRecord, fallback: string) {
  return record.title && !/^[a-f\d]{40,}(?::.*)?$/i.test(record.title) ? record.title : fallback;
}

export function SavedRecordDestinationLink({ record }: { record: IntakeAcceptedRecord }) {
  const owner = useResource<{ personId: string | null }>(
    '/record-owner?' + queryString({ type: record.kind, id: record.entityId }),
  );
  const sharedPeople = useContext(SavedPeopleContext);
  const people = useResource<IntakeIdentityPerson[]>(
    sharedPeople === null ? '/record-ownership/people' : null,
  );
  const resolved = typeof owner.data?.personId === 'string' && !!owner.data.personId;
  const personId = resolved ? owner.data!.personId! : undefined;
  const currentPeople = sharedPeople ?? (Array.isArray(people.data) ? people.data : []);
  const person = currentPeople.find((entry) => entry.personId === personId);
  const personLabel = !resolved
    ? owner.error
      ? 'Person unavailable'
      : 'Checking person'
    : personId === 'patient'
      ? 'Self'
      : person
        ? importPersonLabel(person, currentPeople)
        : 'Person details unavailable';
  const destination = destinationForOwner(record, personId);
  // Receipt entity IDs remain exact. Current ownership is resolved independently
  // because a later coupled ownership correction never rewrites old receipts.
  const contents = (
    <>
      <span>
        <strong>{displayTitle(record, destination.label)}</strong>
        <small>
          {personLabel} · {destination.label} ·{' '}
          {record.outcome === 'matched'
            ? 'Existing record linked'
            : record.outcome === 'updated'
              ? 'New version saved'
              : 'Added to profile'}
        </small>
      </span>
      <ExternalLink size={16} aria-hidden="true" />
    </>
  );
  return resolved ? (
    <>
      <Link
        className="import-detail-record-link"
        to={destination.to}
        data-saved-record-id={record.recordId}
      >
        {contents}
      </Link>
      {sharedPeople === null && people.error && <PeopleLookupRetry onRetry={people.reload} />}
    </>
  ) : (
    <span className="import-detail-record-link" data-saved-record-id={record.recordId}>
      {contents}
      {owner.error && (
        <button type="button" className="text-link" onClick={owner.reload}>
          Retry person
        </button>
      )}
    </span>
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
      <SavedRecordPeople>
        <div className="import-detail-records">
          {records.map((record) => (
            <SavedRecordDestinationLink
              record={record}
              key={`${record.recordId}:${record.entityId}`}
            />
          ))}
        </div>
      </SavedRecordPeople>
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
