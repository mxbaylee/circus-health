/** Group only the bounded explicit record selection; unbounded source/name joins stay on disk. */
import type { Database } from './database.ts';
import type { OwnershipRequest, OwnershipPreview } from '../shared/record-ownership.ts';
import type { OwnershipReportPreviewRecord } from '../shared/ownership-report-reference.ts';
import { relatedMappingFields } from './related-records.ts';
import { ownershipHash } from './ownership-journal.ts';
export function ownershipPlanGroups(
  sql: Database,
  records: Iterable<OwnershipReportPreviewRecord>,
  request: OwnershipRequest,
  names: Iterable<{ personId: string; sourceRecordIds: Iterable<string> }>,
) {
  if (request.selection.type !== 'records')
    throw Error('Only explicit selected records need independent groups');
  const parent = new Map(
    request.selection.records.map((record) => [record.recordId, record.recordId]),
  );
  const root = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const merge = (a: string, b: string) => {
    if (parent.has(a) && parent.has(b)) parent.set(root(b), root(a));
  };
  sql.exec(
    'CREATE TABLE IF NOT EXISTS ownership_group_matches(id TEXT PRIMARY KEY,kind TEXT,value TEXT);CREATE TABLE IF NOT EXISTS ownership_group_sources(scope TEXT,record TEXT,PRIMARY KEY(scope,record));DELETE FROM ownership_group_matches;DELETE FROM ownership_group_sources;',
  );
  for (const record of records) {
    sql
      .prepare('INSERT INTO ownership_group_matches VALUES(?,?,?)')
      .run(
        record.recordId,
        record.kind,
        JSON.stringify(relatedMappingFields(record.kind, record.mapping)),
      );
    const key = ownershipHash([record.kind, record.recordId]);
    for (const c of sql
      .prepare('SELECT source_id FROM preview_contributions WHERE record_key=? ORDER BY ordinal')
      .iterate(key)) {
      let count = 0;
      for (const scope of sql
        .prepare(
          'SELECT value FROM preview_contribution_scopes WHERE record_key=? AND source_id=? ORDER BY ordinal',
        )
        .iterate(key, c.source_id)) {
        count++;
        sql
          .prepare('INSERT OR IGNORE INTO ownership_group_sources VALUES(?,?)')
          .run(JSON.parse(String(scope.value)), record.recordId);
      }
      if (!count)
        sql
          .prepare('INSERT OR IGNORE INTO ownership_group_sources VALUES(?,?)')
          .run('occurrence:' + c.source_id, record.recordId);
    }
  }
  for (const a of sql
    .prepare('SELECT id,kind,value FROM ownership_group_matches ORDER BY id')
    .iterate())
    for (const b of sql
      .prepare('SELECT id,value FROM ownership_group_matches WHERE kind=? AND id>? ORDER BY id')
      .iterate(a.kind, a.id)) {
      const x = JSON.parse(String(a.value)) as ReturnType<typeof relatedMappingFields>,
        y = JSON.parse(String(b.value)) as ReturnType<typeof relatedMappingFields>;
      if (
        (x.code && x.codeSystem && x.code === y.code && x.codeSystem === y.codeSystem) ||
        x.label.toLowerCase() === y.label.toLowerCase() ||
        x.terms.some((term) => y.label.toLowerCase().includes(term)) ||
        y.terms.some((term) => x.label.toLowerCase().includes(term))
      )
        merge(String(a.id), String(b.id));
    }
  let scope: string | undefined, first: string | undefined;
  for (const row of sql
    .prepare('SELECT scope,record FROM ownership_group_sources ORDER BY scope,record')
    .iterate()) {
    if (row.scope !== scope) {
      scope = String(row.scope);
      first = String(row.record);
    } else merge(first!, String(row.record));
  }
  for (const name of names) {
    let first: string | undefined;
    for (const source of name.sourceRecordIds)
      for (const row of sql
        .prepare(
          "SELECT r.id FROM preview_contributions c JOIN preview_records r ON c.record_key=json_extract(r.value,'$.contributions.key') WHERE c.source_id=? AND json_extract(r.value,'$.owner.personId')=?",
        )
        .iterate(source, name.personId)) {
        if (first) merge(first, String(row.id));
        else first = String(row.id);
      }
  }
  for (const row of sql
    .prepare('SELECT value FROM preview_relationships ORDER BY ordinal')
    .iterate()) {
    const relation = JSON.parse(String(row.value));
    merge(relation.recordId, relation.otherRecordId);
  }
  const targets = new Map<string, string>();
  for (const choice of request.decisions || [])
    if (choice.action === 'link' && choice.targetRecordId) {
      const first = targets.get(choice.targetRecordId);
      if (first) merge(first, choice.recordId);
      else targets.set(choice.targetRecordId, choice.recordId);
    }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const key = root(id),
      ids = groups.get(key) || [];
    ids.push(id);
    groups.set(key, ids);
  }
  return [...groups.values()]
    .map((ids) => {
      const recordIds = ids.sort();
      return { id: ownershipHash(recordIds), recordIds, pendingCount: 0, atomic: true as const };
    })
    .sort((a, b) => a.id.localeCompare(b.id)) as OwnershipPreview['commitGroups'];
}
