import type { DatabaseSync } from 'node:sqlite';
import type { IntakeWorkflow } from '../shared/intake.ts';

/** Called only within the existing source-publication transaction. Curation is the authority. */
export function stampNewReportGroups(
  db: DatabaseSync,
  workflow: IntakeWorkflow,
  previous = new Set<string>(),
): void {
  const additions = (workflow.reportGroups || []).filter(
    (group) => group.discoveryOrder === undefined && !previous.has(group.id),
  );
  if (!additions.length) return;
  let maximum = Number(
    db
      .prepare(
        "SELECT MAX(CAST(json_extract(g.value,'$.discoveryOrder') AS INTEGER)) n FROM source_files f, json_each(f.details_json,'$.intake.workflow.reportGroups') g WHERE f.kind='intake_original'",
      )
      .get()!.n || 0,
  );
  maximum = Math.max(
    maximum,
    ...(workflow.reportGroups || []).map((group) => group.discoveryOrder || 0),
  );
  for (const group of additions) group.discoveryOrder = ++maximum;
}
