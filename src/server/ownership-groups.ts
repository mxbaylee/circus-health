import { relatedMappingFields } from './related-records.ts';
import type {
  OwnershipPreview,
  OwnershipRequest,
  OwnershipReceipt,
} from '../shared/record-ownership.ts';
import { appendOwnershipDecision, ownershipHash } from './ownership-journal.ts';
import { json, type Database } from './database.ts';
export function ownershipCommitGroups(
  preview: Pick<OwnershipPreview, 'records' | 'pending' | 'names' | 'relationships'>,
  request: OwnershipRequest,
): OwnershipPreview['commitGroups'] {
  if (request.selection.type === 'report')
    return [
      {
        id: ownershipHash(request.selection),
        recordIds: preview.records.map((r) => r.recordId),
        pendingCount: preview.pending.length,
        atomic: true,
      },
    ];
  const sets = preview.records.map((r) => new Set([r.recordId]));
  const merge = (ids: string[]) => {
    const relevant = sets.filter((s) => ids.some((id) => s.has(id)));
    if (relevant.length < 2) return;
    for (const set of relevant.slice(1)) {
      for (const id of set) relevant[0]!.add(id);
      sets.splice(sets.indexOf(set), 1);
    }
  };
  // A selected record becoming a destination match must not invalidate a later group.
  // Keep potentially matching selected records together using the same discovery fields.
  const candidates = preview.records.map((r) => ({
    record: r,
    match: relatedMappingFields(r.kind, r.mapping),
  }));
  for (let i = 0; i < candidates.length; i++)
    for (const b of candidates.slice(i + 1)) {
      const a = candidates[i]!;
      if (a.record.kind !== b.record.kind) continue;
      const matched =
        (a.match.code &&
          a.match.codeSystem &&
          a.match.code === b.match.code &&
          a.match.codeSystem === b.match.codeSystem) ||
        a.match.label.toLowerCase() === b.match.label.toLowerCase() ||
        a.match.terms.some((t) => b.match.label.toLowerCase().includes(t)) ||
        b.match.terms.some((t) => a.match.label.toLowerCase().includes(t));
      if (matched) merge([a.record.recordId, b.record.recordId]);
    }
  const bySource = new Map<string, string[]>();
  for (const record of preview.records)
    for (const c of record.contributions)
      for (const scope of c.reportScopes.length
        ? c.reportScopes
        : ['occurrence:' + c.sourceRecordId]) {
        const ids = bySource.get(scope) || [];
        ids.push(record.recordId);
        bySource.set(scope, ids);
      }
  for (const ids of bySource.values()) merge(ids);
  for (const name of preview.names)
    merge(
      preview.records
        .filter(
          (r) =>
            r.owner.personId === name.personId &&
            r.contributions.some((c) => name.affectedSourceIds.includes(c.sourceRecordId)),
        )
        .map((r) => r.recordId),
    );
  for (const relationship of preview.relationships)
    merge([relationship.recordId, relationship.otherRecordId]);
  // Explicitly linked targets shared by selected inputs must publish together.
  const byTarget = new Map<string, string[]>();
  for (const d of request.decisions || [])
    if (d.action === 'link' && d.targetRecordId) {
      const ids = byTarget.get(d.targetRecordId) || [];
      ids.push(d.recordId);
      byTarget.set(d.targetRecordId, ids);
    }
  for (const ids of byTarget.values()) merge(ids);
  return sets
    .map((ids) => {
      const recordIds = [...ids].sort();
      return { id: ownershipHash(recordIds), recordIds, pendingCount: 0, atomic: true as const };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
export interface OwnershipGroupPlan {
  parentOperationId: string;
  fingerprint: string;
  groupId: string;
  childOperationId: string;
  recordIds: string[];
  pendingCount: number;
  totalGroups: number;
  destinationPersonId: string;
  at: string;
  revision: number;
}
export function childOwnershipOperation(parent: string, groupId: string) {
  const hex = ownershipHash([parent, groupId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function retainOwnershipPlan(
  db: Database,
  parentOperationId: string,
  fingerprint: string,
  groups: OwnershipPreview['commitGroups'],
  destinationPersonId: string,
) {
  for (const group of groups)
    appendOwnershipDecision(
      db,
      'ownership-plan:' + parentOperationId + ':' + group.id,
      'Ownership correction group',
      {
        parentOperationId,
        fingerprint,
        groupId: group.id,
        childOperationId: childOwnershipOperation(parentOperationId, group.id),
        recordIds: group.recordIds,
        pendingCount: group.pendingCount,
        totalGroups: groups.length,
        destinationPersonId,
      },
    );
}
export function ownershipPlans(db: Database, operationId: string): OwnershipGroupPlan[] {
  return db
    .prepare(
      "SELECT coverage_json FROM manual_batches WHERE title='Ownership correction group' AND json_extract(coverage_json,'$.parentOperationId')=? ORDER BY id",
    )
    .all(operationId)
    .map((r) => json(r.coverage_json) as OwnershipGroupPlan);
}
export function ownershipGroupRequest(
  request: OwnershipRequest,
  group: OwnershipPreview['commitGroups'][number],
  preview: OwnershipPreview,
): OwnershipRequest {
  if (request.selection.type !== 'records') return request;
  const records = preview.records.filter((r) => group.recordIds.includes(r.recordId));
  const nameKeys = new Set(
    preview.names
      .filter((n) =>
        records.some(
          (r) =>
            r.owner.personId === n.personId &&
            r.contributions.some((c) => n.affectedSourceIds.includes(c.sourceRecordId)),
        ),
      )
      .map((n) => n.key),
  );
  const relationshipIds = new Set(
    preview.relationships
      .filter((r) => group.recordIds.includes(r.recordId))
      .map((r) => r.decisionId),
  );
  return {
    ...request,
    selection: {
      type: 'records',
      records: request.selection.records.filter((r) => group.recordIds.includes(r.recordId)),
    },
    decisions: request.decisions?.filter((d) => group.recordIds.includes(d.recordId)),
    nameDecisions: request.nameDecisions?.filter((d) => nameKeys.has(d.key)),
    relationshipDecisions: request.relationshipDecisions?.filter((d) =>
      relationshipIds.has(d.decisionId),
    ),
  };
}
export function combineOwnershipReceipts(
  plans: OwnershipGroupPlan[],
  receipts: OwnershipReceipt[],
): OwnershipReceipt {
  const first = plans[0]!;
  return {
    operationId: first.parentOperationId,
    at: first.at,
    destinationPersonId: first.destinationPersonId,
    moved: receipts.reduce((n, r) => n + r.moved, 0),
    unchanged: receipts.reduce((n, r) => n + r.unchanged, 0),
    pending: receipts.reduce((n, r) => n + r.pending, 0),
    replayed: true,
    groupId: first.parentOperationId,
    outcomes: receipts.flatMap((r) => r.outcomes),
    groups: plans.map((p) => {
      const receipt = receipts.find((r) => r.operationId === p.childOperationId);
      return {
        id: p.groupId,
        recordIds: p.recordIds,
        status: receipt ? 'committed' : 'needs_review',
        operationId: p.childOperationId,
        moved: receipt?.moved || 0,
        pending: receipt?.pending || 0,
      };
    }),
  };
}
