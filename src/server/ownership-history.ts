import { json, type Database } from './database.ts';
import type { ClinicalKind } from './clinical-references.ts';
import { DEFAULT_OWNERSHIP_REASON } from './ownership-journal.ts';

export interface OwnershipCorrectionHistory {
  operationId: string;
  action: 'move' | 'split' | 'link' | 'unchanged';
  at: string;
  fromPersonId: string;
  fromNoteId: string;
  fromPersonName: string;
  toPersonId: string;
  sourceReport?: { intakeId: string; groupId: string; groupVersionId: string };
  reason: string | null;
  actor: 'profile-user';
}

/**
 * One compact event per correction; historical packet delivery is not retained.
 * Only the destination record changed owner: a move keeps its ID, a link names
 * the existing target, and a split names its new record. A split's retained
 * record appears as the event's `recordId` but kept its owner, so match on the
 * destination alone. Every event since ownership correction shipped records it.
 */
export function ownershipCorrections(
  db: Database,
  kind: ClinicalKind,
  recordId: string,
): OwnershipCorrectionHistory[] {
  return db
    .prepare(
      "SELECT coverage_json,created_at,notes FROM manual_batches WHERE title='Record ownership event' AND json_extract(coverage_json,'$.kind')=? AND json_extract(coverage_json,'$.destinationRecordId')=? ORDER BY created_at,id",
    )
    .all(kind, recordId)
    .map((row) => {
      const event = json(row.coverage_json) as {
        operationId: string;
        action: OwnershipCorrectionHistory['action'];
        fromPersonId: string;
        fromNoteId?: string;
        fromPersonName?: string;
        toPersonId: string;
        sourceReport?: OwnershipCorrectionHistory['sourceReport'];
      };
      const former =
        event.fromPersonName ||
        (event.fromPersonId === 'patient'
          ? 'Self'
          : String(
              db
                .prepare("SELECT title FROM notes WHERE kind='person' AND person_id=?")
                .get(event.fromPersonId)?.title || 'a prior person',
            ));
      return {
        operationId: event.operationId,
        action: event.action,
        at: String(row.created_at),
        fromPersonId: event.fromPersonId,
        fromNoteId:
          event.fromNoteId ||
          (event.fromPersonId === 'patient'
            ? 'person-note:self'
            : String(
                db
                  .prepare("SELECT id FROM notes WHERE kind='person' AND person_id=?")
                  .get(event.fromPersonId)?.id || '',
              )),
        fromPersonName: former,
        toPersonId: event.toPersonId,
        ...(event.sourceReport ? { sourceReport: event.sourceReport } : {}),
        reason:
          typeof row.notes === 'string' &&
          row.notes.trim() &&
          row.notes.trim() !== DEFAULT_OWNERSHIP_REASON
            ? row.notes
            : null,
        actor: 'profile-user' as const,
      };
    });
}
