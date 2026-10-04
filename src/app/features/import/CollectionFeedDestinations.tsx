import { useEffect, useState } from 'react';
import type { CollectionFeedRecord } from '../../../shared/intake-clinical-pages';
import type { IntakeAcceptedRecord } from '../../../shared/intake';
import { useProfile } from '../../data/profile';
import { loadAcceptedRecordsForScope, SavedRecordDestinationLink } from './SavedRecordDestinations';
/** A displayed saved row resolves its durable destination without loading other receipt history. */
export function CollectionFeedDestination({ row }: { row: CollectionFeedRecord }) {
  const recordId =
    row.detail.kind === 'record' ? row.detail.record.id : row.detail.selection.recordId;
  return (
    <CollectionRecordDestination
      intakeId={row.intakeId}
      groupId={row.groupId}
      proposalId={row.proposalId}
      recordId={recordId}
      intakeVersion={row.intakeVersion}
    />
  );
}
export function CollectionRecordDestination({
  intakeId,
  groupId,
  proposalId,
  recordId,
  intakeVersion,
}: {
  intakeId: string;
  groupId: string;
  proposalId: string | null;
  recordId: string;
  intakeVersion: number;
}) {
  const profile = useProfile();
  const key = JSON.stringify([profile?.id, intakeId, groupId, proposalId, recordId, intakeVersion]);
  const [state, setState] = useState<{
    key: string;
    records?: IntakeAcceptedRecord[];
    error?: string;
  }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ key });
    void loadAcceptedRecordsForScope(intakeId, {
      groupId,
      proposalId,
      recordIds: [recordId],
    })
      .then((records) => {
        if (active) setState({ key, records });
      })
      .catch((cause) => {
        if (active)
          setState({
            key,
            error: cause instanceof Error ? cause.message : 'Saved destination could not load.',
          });
      });
    return () => {
      active = false;
    };
  }, [key, revision]);
  const current = state?.key === key ? state : undefined;
  return (
    <div className="import-record-destination">
      {current?.error ? (
        <p role="alert">
          {current.error}
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Retry saved destination
          </button>
        </p>
      ) : !current?.records ? (
        <p role="status">Opening saved destination…</p>
      ) : current.records.length ? (
        current.records.map((record) => (
          <SavedRecordDestinationLink key={record.entityId} record={record} />
        ))
      ) : (
        <p>No saved destination is available for this exact record.</p>
      )}
    </div>
  );
}
