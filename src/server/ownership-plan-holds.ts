import { runClinicalReviewWork } from './clinical-review-work.ts';
import { reviewPreparationStamp } from './clinical-review-maintenance.ts';
import { HttpError } from './database.ts';
/** Complete selected-record report-default holds. Source fan-in stays in the owned SQL plan. */
import type { Database } from './database.ts';
import type { OwnershipPreview } from '../shared/record-ownership.ts';
import type { OwnershipReportPreviewRecord } from '../shared/ownership-report-reference.ts';
import type {
  OwnershipReportAuthority,
  SelectedOwnershipReviewScope,
} from './record-ownership-authority.ts';
import { latestOwnershipDecision, ownershipHash } from './ownership-journal.ts';
import { OwnershipStoredSequence } from './ownership-preview-store.ts';
export async function ownershipPlanHolds(
  db: Database,
  sql: Database,
  records: Iterable<OwnershipReportPreviewRecord>,
  sources: ReadonlySet<string>,
  review: (intakeId: string, sourceId: string) => Promise<SelectedOwnershipReviewScope>,
  assertCurrent: () => void,
) {
  const prepare = <T>(work: Generator<void, T, void>) =>
    runClinicalReviewWork(work, {
      capture() {
        assertCurrent();
        const stamp = reviewPreparationStamp(db);
        if (stamp === undefined)
          throw Error('Ownership holds require outside-transaction preparation');
        return () => {
          assertCurrent();
          if (reviewPreparationStamp(db) !== stamp)
            throw new HttpError(
              409,
              'OWNERSHIP_CHANGED',
              'Ownership evidence changed during preparation',
            );
        };
      },
    });
  sql.exec(
    'CREATE TABLE IF NOT EXISTS preview_holds(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE,value TEXT);DELETE FROM preview_holds;',
  );
  let ordinal = 0;
  for (const record of records) {
    if (record.action === 'unchanged') continue;
    const key = ownershipHash([record.kind, record.recordId]);
    for (const source of sql
      .prepare(
        'SELECT source_id,value FROM preview_contributions WHERE record_key=? AND selected=1 ORDER BY ordinal',
      )
      .iterate(key)) {
      const c = JSON.parse(String(source.value)) as {
        sourceFileId: string;
        sourceRecordId: string;
      };
      for (const scope of sql
        .prepare(
          'SELECT value FROM preview_contribution_scopes WHERE record_key=? AND source_id=? ORDER BY ordinal',
        )
        .iterate(key, source.source_id)) {
        const groupId = String(JSON.parse(String(scope.value))).slice(c.sourceFileId.length + 1),
          complete = await review(c.sourceFileId, c.sourceRecordId);
        if (
          !(complete.remainingWork
            ? await prepare(complete.remainingWork(groupId, sources))
            : complete.remaining(groupId, sources))
        )
          continue;
        const authority = latestOwnershipDecision<OwnershipReportAuthority>(
            db,
            'Report ownership default',
            'groupId',
            groupId,
          ),
          receipt = complete.lastConfirmationWork
            ? await prepare(complete.lastConfirmationWork(groupId, record.owner.personId))
            : complete.lastConfirmation(groupId, record.owner.personId),
          defaultOperationId =
            authority?.personId === record.owner.personId && authority.intakeId === c.sourceFileId
              ? authority.operationId
              : receipt?.operationId;
        if (
          !defaultOperationId ||
          !complete.intakeVersion ||
          latestOwnershipDecision(
            db,
            'Report ownership default hold',
            'defaultOperationId',
            defaultOperationId,
          )
        )
          continue;
        const value = {
          intakeVersion: complete.intakeVersion,
          defaultOperationId,
          intakeId: c.sourceFileId,
          groupId,
        };
        sql
          .prepare(
            'INSERT INTO preview_holds VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(ordinal++, defaultOperationId, JSON.stringify(value));
      }
    }
  }
  return new OwnershipStoredSequence<OwnershipPreview['reportHolds'][number]>(sql, 'preview_holds');
}
