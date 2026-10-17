import { HttpError, type Database } from './database.ts';
import { clinicalTables } from './clinical-references.ts';
import { recordOwner } from './record-owner.ts';
import { reviewIntake } from './intake.ts';
import { prepareCollectionClinicalReview } from './intake-review-collection-host.ts';
import type { CollectionClinicalReviewSession } from './intake-review-collection-session.ts';
import type { IntakeReview } from '../shared/intake.ts';

/** Host-selected installation context, never supplied by packet input. */
export interface PacketReportReviewContext {
  root: string;
  profileId: string;
}
export type PendingPacketReportReview = (intakeId: string, proposalId: string | null) => void;
export function packetReportPersonScope(
  db: Database,
  intakeId: string,
  native: boolean,
  context?: PacketReportReviewContext,
  preparePending?: PendingPacketReportReview,
) {
  let selected:
    | { proposalId: string | null; review: IntakeReview | CollectionClinicalReviewSession }
    | undefined;
  return {
    accepted(occurrences: Iterable<{ recordId: string }>, personId: string): boolean {
      let found = false;
      for (const occurrence of occurrences)
        for (const [kind, table] of Object.entries(clinicalTables))
          for (const row of db
            .prepare(
              `SELECT id FROM ${table} WHERE source_record_id=? UNION SELECT entity_id id FROM evidence WHERE entity_type=? AND source_record_id=?`,
            )
            .iterate(occurrence.recordId, kind, occurrence.recordId)) {
            if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(row.id)) continue;
            const owner = recordOwner(db, kind, String(row.id));
            if (owner !== personId) return false;
            found = true;
          }
      return found;
    },
    pending(
      occurrences: Iterable<{ recordId: string; proposalId: string | null }>,
      candidateId: string,
      versionId: string,
      personId: string,
    ): boolean {
      if (preparePending) {
        for (const occurrence of occurrences) preparePending(intakeId, occurrence.proposalId);
        return false;
      }
      if (!context)
        throw new HttpError(
          409,
          'PACKET_REPORT_REVIEW_CONTEXT',
          'Current report review requires the authorized profile storage context.',
        );
      let found = false;
      for (const occurrence of occurrences) {
        let review = selected?.proposalId === occurrence.proposalId ? selected.review : undefined;
        if (!review) {
          if (selected && 'close' in selected.review) selected.review.close();
          selected = undefined;
          if (native) {
            const result = prepareCollectionClinicalReview(
              db,
              context.root,
              context.profileId,
              intakeId,
              occurrence.proposalId,
            );
            if (result.status !== 'ready')
              throw new HttpError(
                409,
                'PACKET_REPORT_REVIEW_PENDING',
                'Prepare the current report identity review before exporting.',
              );
            review = result.session;
          } else
            review = reviewIntake(
              db,
              context.root,
              context.profileId,
              intakeId,
              occurrence.proposalId,
            );
          selected = { proposalId: occurrence.proposalId, review };
        }
        const record =
          'record' in review
            ? review.record(occurrence.recordId, candidateId, versionId)
            : review.records.find(
                (record) =>
                  record.id === occurrence.recordId &&
                  record.candidateId === candidateId &&
                  record.candidateVersionId === versionId,
              );
        if (!record || record.identityReview?.blocking) return false;
        const owner =
          record.mapping.personId || (record.mapping.subject === 'self' ? 'patient' : null);
        if (owner !== personId) return false;
        found = true;
      }
      return found;
    },
    close() {
      if (selected && 'close' in selected.review) selected.review.close();
      selected = undefined;
    },
  };
}
