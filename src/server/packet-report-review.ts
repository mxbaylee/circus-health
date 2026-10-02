import { readStoredIntakeDetails } from './intake-state-access.ts';
import type { Database } from './database.ts';

export interface PacketReportReview {
  intakeId: string;
  groupId: string;
  title: string;
  savedCount: number;
  totalCount: number;
}

/** Count current clinical candidates, never historical versions or context rows.
 * Only reports represented by included source evidence belong in this disclosure.
 */
export function packetReportReview(db: Database, sourceIds: string[]): PacketReportReview[] {
  const byIntake = new Map<string, Set<string>>();
  const source = db.prepare('SELECT source_file_id, locator_json FROM source_records WHERE id=?');
  for (const id of new Set(sourceIds)) {
    const row = source.get(id);
    if (!row) continue;
    const locator = JSON.parse(String(row.locator_json || '{}'));
    const intakeId = String(locator?.originalSourceFileId || row.source_file_id);
    const ids = byIntake.get(intakeId) || new Set<string>();
    ids.add(id);
    byIntake.set(intakeId, ids);
  }
  const reports: PacketReportReview[] = [];
  for (const [intakeId, included] of byIntake) {
    const workflow = readStoredIntakeDetails(db, intakeId)?.workflow;
    if (!workflow) continue;
    // Older retained workflows and source-only reading plans may not have
    // clinical candidates. They cannot establish report completion counts.
    const candidates = new Map(
      (workflow.candidates || []).map((candidate) => [candidate.id, candidate]),
    );
    for (const group of workflow.reportGroups || []) {
      if (group.basis !== 'report_anchor') continue;
      const latest = group.versions.at(-1);
      if (
        !latest ||
        !latest.members.some((member) =>
          member.occurrences.some((occurrence) => included.has(occurrence.recordId)),
        )
      )
        continue;
      const current = new Map(
        latest.members.flatMap((member) => {
          const version = candidates.get(member.candidateId)?.versions.at(-1);
          return version &&
            version.id === member.candidateVersionId &&
            !version.sourceContext &&
            !version.peopleOnly
            ? [[member.candidateId, version] as const]
            : [];
        }),
      );
      if (!current.size) continue;
      reports.push({
        intakeId,
        groupId: group.id,
        title: latest.title.slice(0, 500),
        savedCount: [...current.values()].filter((version) => version.status === 'accepted').length,
        totalCount: current.size,
      });
    }
  }
  return reports.sort(
    (a, b) => a.intakeId.localeCompare(b.intakeId) || a.groupId.localeCompare(b.groupId),
  );
}
