import { useEffect, useState } from 'react';
import { useResource } from '../data/api';
import type { CorrectableClinicalKind } from '../../shared/record-correction';
import { RecordOwnershipAction } from '../features/clinical-review/RecordOwnershipAction';

interface OwnershipEvent {
  operationId: string;
  at: string;
  fromPersonName: string;
  fromNoteId: string;
  action: string;
  sourceReport?: { intakeId: string; groupId: string; groupVersionId: string };
  reason: string | null;
  actor: 'profile-user';
}

/** Show the patient-side correction on the current record, including same-ID moves. */
export function OwnershipHistory({
  kind,
  recordId,
}: {
  kind: CorrectableClinicalKind;
  recordId: string;
}) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [versions, setVersions] = useState<
    { versionId: string; sequence: number; recordedAt: string; changes: { field: string }[] }[]
  >([]);
  const history = useResource<{
    ownershipCorrections: OwnershipEvent[];
    earlierPacketInclusion: 'not_recorded';
    entries: {
      versionId: string;
      sequence: number;
      recordedAt: string;
      changes: { field: string }[];
    }[];
    nextSequence: number | null;
  }>(
    `/record-history?${new URLSearchParams({
      kind,
      recordId,
      ...(beforeSequence ? { beforeSequence: String(beforeSequence) } : {}),
    })}`,
  );
  useEffect(() => {
    setBeforeSequence(null);
    setVersions([]);
    setVersionsOpen(false);
  }, [kind, recordId]);
  useEffect(() => {
    if (!history.data) return;
    const entries = Array.isArray(history.data.entries) ? history.data.entries : [];
    if (!entries.length) return;
    setVersions((old) => {
      const added = entries.filter(
        (entry) => !old.some((prior) => prior.versionId === entry.versionId),
      );
      return added.length ? [...old, ...added] : old;
    });
  }, [history.data]);
  if (
    !Array.isArray(history.data?.ownershipCorrections) ||
    !history.data.ownershipCorrections.length
  )
    return null;
  return (
    <section className="panel" aria-label="Person attribution history">
      <h3>Person attribution history</h3>
      <ol>
        {history.data.ownershipCorrections.map((event) => (
          <li key={event.operationId}>
            Previously attributed to {event.fromPersonName}; corrected on {event.at.slice(0, 10)} by
            the profile user as a patient-side assertion.
            {event.reason && <> Reason: {event.reason}</>}
            {event.fromNoteId && (
              <RecordOwnershipAction
                label="Review undo"
                selection={
                  (event.action === 'link' || event.action === 'split') && event.sourceReport
                    ? { type: 'report', ...event.sourceReport }
                    : { type: 'records', records: [{ kind, recordId }] }
                }
                initialDestinationNoteId={event.fromNoteId}
                previewOnOpen
              />
            )}
          </li>
        ))}
      </ol>
      <button
        className="text-link"
        type="button"
        aria-controls={`accepted-history-${recordId}`}
        onClick={() => setVersionsOpen(true)}
      >
        View accepted record history
      </button>
      <details
        id={`accepted-history-${recordId}`}
        open={versionsOpen}
        onToggle={(event) => setVersionsOpen(event.currentTarget.open)}
      >
        <summary>Accepted versions and earlier packets</summary>
        <ol>
          {versions.map((entry) => (
            <li key={entry.versionId}>
              Accepted version {entry.sequence} on {entry.recordedAt.slice(0, 10)}.
              {entry.changes.length > 0 &&
                ` Changed fields: ${entry.changes.map((change) => change.field).join(', ')}.`}
            </li>
          ))}
        </ol>
        {history.data.nextSequence != null && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setBeforeSequence(history.data!.nextSequence)}
          >
            Load older accepted versions
          </button>
        )}
        <p>
          The app does not record whether this record was included in a packet generated before the
          correction. Review copies you shared and send a corrected packet where needed.
        </p>
      </details>
    </section>
  );
}
