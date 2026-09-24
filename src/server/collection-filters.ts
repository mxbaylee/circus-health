import { HttpError, type Database } from './database.ts';
import {
  FILTER_FIELDS,
  UNKNOWN_FILTER_VALUE,
  parseCollectionFilters,
  filterIssue,
} from '../shared/collection-filters.ts';
import type { FilterView } from '../shared/collection-filters.ts';
const nullText = (expression: string) => `NULLIF(trim(${expression}),'')`;
const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(',');
const tags = `CASE WHEN person_id='patient' THEN '[]' WHEN json_type(profile_json,'$.tags')='array' THEN json_extract(profile_json,'$.tags') ELSE '[]' END`;
export function collectionPredicates(params: URLSearchParams, view: FilterView) {
  let rows;
  try {
    rows = parseCollectionFilters(params.get('filters'));
  } catch (error) {
    throw new HttpError(
      400,
      'INVALID_FILTER',
      error instanceof Error ? error.message : String(error),
    );
  }
  const conditions: string[] = [],
    args: string[] = [];
  const fields: Record<string, string> =
    view === 'person'
      ? {
          relationship: nullText("json_extract(profile_json,'$.relationship')"),
          lifeStatus:
            "CASE WHEN json_extract(profile_json,'$.lifeStatus') IN ('alive','deceased') THEN json_extract(profile_json,'$.lifeStatus') END",
          text: "COALESCE(CASE WHEN person_id='patient' THEN (SELECT display_name FROM people WHERE id='patient') ELSE title END,'') || ' ' || COALESCE(content,'') || ' ' || COALESCE(profile_json,'')",
        }
      : {
          source: nullText('source_id'),
          acquisitionSource: nullText('acquisition_source_id'),
          type: nullText('type_label'),
          status: 'status',
          date: 'date',
          text: "COALESCE(title,'') || ' ' || COALESCE(content,'') || ' ' || COALESCE(search_extra,'')",
        };
  for (const row of rows) {
    const issue = filterIssue(row, view);
    if (issue?.startsWith('Incomplete')) continue;
    if (issue) throw new HttpError(400, 'INVALID_FILTER', issue);
    const kind = FILTER_FIELDS[view].find((field) => field.value === row.field)!.kind;
    const values = [...new Set(row.values)];
    if (kind === 'tags') {
      const predicates = values.map((value) => {
        if (value === UNKNOWN_FILTER_VALUE)
          return `NOT EXISTS(SELECT 1 FROM json_each(${tags}) WHERE type='text' AND trim(value)<>'')`;
        args.push(value);
        return `EXISTS(SELECT 1 FROM json_each(${tags}) WHERE type='text' AND value=? COLLATE NOCASE)`;
      });
      const expression = `(${predicates.join(row.operator === 'all' ? ' AND ' : ' OR ')})`;
      conditions.push(row.operator === 'none' ? `NOT ${expression}` : expression);
    } else if (kind === 'set') {
      const expression = fields[row.field],
        parts = [];
      // Legacy source=provider links retain their existing meaning.
      if (row.field === 'source' && values.includes('provider')) parts.push("origin='provider'");
      const literal = values.filter(
        (value) =>
          value !== UNKNOWN_FILTER_VALUE && !(row.field === 'source' && value === 'provider'),
      );
      if (literal.length) {
        parts.push(`COALESCE(${expression} COLLATE NOCASE IN (${placeholders(literal)}),0)`);
        args.push(...literal);
      }
      if (values.includes(UNKNOWN_FILTER_VALUE)) parts.push(`${expression} IS NULL`);
      const predicate = `(${parts.join(' OR ')})`;
      conditions.push(row.operator === 'none' ? `NOT ${predicate}` : predicate);
    } else if (kind === 'text') {
      conditions.push(
        `${row.operator === 'notContains' ? 'NOT ' : ''}(instr(lower(${fields[row.field]}),lower(?))>0)`,
      );
      args.push(values[0]);
    } else {
      // Partial dates are retained but cannot participate in exact-date bounds.
      const date = fields[row.field];
      conditions.push(
        `(${date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND date(substr(${date},1,10),'+0 days')=substr(${date},1,10))`,
      );
      if (row.operator === 'between') {
        conditions.push(`substr(${date},1,10) BETWEEN ? AND ?`);
        args.push(...row.values);
      } else {
        conditions.push(`substr(${date},1,10) ${row.operator === 'before' ? '<' : '>'} ?`);
        args.push(values[0]);
      }
    }
  }
  return { conditions, args };
}
export function personFilterOptions(db: Database) {
  const relationships = new Map<string, string>(),
    tagsMap = new Map<string, string>();
  for (const row of db
    .prepare("SELECT person_id,profile_json FROM notes WHERE kind='person' AND archived=0")
    .all()) {
    // People filter choices describe the People collection. The canonical
    // patient is reached through Self and is excluded from that collection.
    if (row.person_id === 'patient') continue;
    const profile = JSON.parse(String(row.profile_json || '{}')) as {
      relationship?: unknown;
      tags?: unknown;
    };
    if (typeof profile.relationship === 'string' && profile.relationship.trim())
      relationships.set(profile.relationship.toLowerCase(), profile.relationship);
    if (Array.isArray(profile.tags))
      for (const tag of profile.tags)
        if (typeof tag === 'string' && tag.trim()) tagsMap.set(tag.toLowerCase(), tag);
  }
  const options = (map: Map<string, string>) =>
    [...map.values()].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
  return {
    tags: options(tagsMap),
    relationship: options(relationships),
    lifeStatus: [
      { value: 'alive', label: 'Alive' },
      { value: 'deceased', label: 'Deceased' },
    ],
  };
}
