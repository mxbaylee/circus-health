import { PacketOutputBudget } from './packet-output-budget.ts';
import type { Database } from './database.ts';
import {
  openIntakeCollectionEnvelope,
  type IntakeCollectionEnvelopeReader,
  type IntakeEnvelopeRecord,
} from './intake-collection-envelope.ts';
import { intakeReviewChildren } from './intake-review-collection.ts';
import { createReportSnapshotCatalog } from './intake-report-snapshot-catalog.ts';
import { openReportMemberSnapshot } from './intake-report-member-state.ts';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';
import { disposableSqlite } from './disposable-sqlite.ts';
import type { IntakeReportMembersReference } from '../shared/intake-report-version.ts';
import type { PacketReportReview } from './packet-report-review.ts';

function field<T>(
  view: IntakeCollectionEnvelopeReader,
  record: IntakeEnvelopeRecord,
  name: string,
): T | undefined {
  const selected = view.field(record, name, { bytes: 8192 });
  if (selected.kind === 'fragmented') throw Error('Packet report identity is unavailable');
  return selected.kind === 'value' ? (selected.value as T) : undefined;
}

/** Counts the complete latest member scope while keeping duplicate membership on disk.
 * The disclosure joins current candidate versions, not historical accepted rows. */
export function* iterateNativePacketReportReview(
  db: Database,
  intakeId: string,
  included: ReadonlySet<string>,
): Generator<PacketReportReview> {
  const view = openIntakeCollectionEnvelope(db, { id: intakeId }),
    intake = view.child(view.root(), 'intake'),
    workflow = intake && view.child(intake, 'workflow');
  if (!workflow) return;
  const catalog = createReportSnapshotCatalog(db, { id: intakeId }),
    scratch = disposableSqlite('circus-packet-report-');
  try {
    scratch.db.exec('CREATE TABLE current(candidate TEXT PRIMARY KEY,accepted INTEGER NOT NULL)');
    const insert = scratch.db.prepare('INSERT OR IGNORE INTO current VALUES(?,?)');
    for (const group of intakeReviewChildren(view, workflow, 'reportGroups')) {
      if (field(view, group, 'basis') !== 'report_anchor') continue;
      const count = view.childCount(group, 'versions'),
        latest = count ? view.childAt(group, 'versions', count - 1) : undefined;
      if (!latest) continue;
      scratch.db.exec('DELETE FROM current');
      let represented = false;
      const current = (candidateId: string, candidateVersionId: string) => {
        const candidate = view.find('candidate', workflow, candidateId, { match: 'last' }),
          size = candidate && view.childCount(candidate, 'versions'),
          version = candidate && size ? view.childAt(candidate, 'versions', size - 1) : undefined;
        if (
          version &&
          field(view, version, 'id') === candidateVersionId &&
          !field(view, version, 'sourceContext') &&
          !field(view, version, 'peopleOnly')
        )
          insert.run(candidateId, field(view, version, 'status') === 'accepted' ? 1 : 0);
      };
      if (field(view, latest, 'format') === 'health-intake-report-group-version-v2') {
        const snapshot = openReportMemberSnapshot(
          catalog,
          field<IntakeReportMembersReference>(view, latest, 'members')!,
        );
        for (let ordinal = 0; ordinal < snapshot.reference.memberCount; ordinal++) {
          const member = snapshot.memberAt(ordinal)!;
          if (!represented)
            for (let occurrence = 0; occurrence < member.occurrenceCount; occurrence++) {
              const id = snapshot.occurrenceRecordId(member, occurrence);
              if (id && included.has(id)) {
                represented = true;
                break;
              }
            }
          current(member.candidateId, member.candidateVersionId);
        }
      } else
        for (const member of intakeReviewChildren(view, latest, 'members')) {
          if (!represented)
            for (const occurrence of intakeReviewChildren(view, member, 'occurrences'))
              if (included.has(field<string>(view, occurrence, 'recordId')!)) {
                represented = true;
                break;
              }
          current(
            field<string>(view, member, 'candidateId')!,
            field<string>(view, member, 'candidateVersionId')!,
          );
        }
      const totals = scratch.db
        .prepare('SELECT count(*) total,coalesce(sum(accepted),0) saved FROM current')
        .get()!;
      if (!represented || !totals.total) continue;
      let title = '';
      const scalar = hashIntakeJsonScalar(view.fieldChunks(latest, 'title'), [], (unit) => {
        if (title.length < 500) title += unit;
      });
      if (scalar.kind !== 'string') throw Error('Invalid packet report title');
      yield {
        intakeId,
        groupId: field<string>(view, group, 'id')!,
        title,
        savedCount: Number(totals.saved),
        totalCount: Number(totals.total),
      };
    }
  } finally {
    scratch.close();
  }
}

export function nativePacketReportReview(
  db: Database,
  intakeId: string,
  included: ReadonlySet<string>,
  budget = new PacketOutputBudget(),
): PacketReportReview[] {
  const reports: PacketReportReview[] = [];
  for (const report of iterateNativePacketReportReview(db, intakeId, included)) {
    budget.add(report, reports.length ? 1 : 0);
    reports.push(report);
  }
  return reports;
}
