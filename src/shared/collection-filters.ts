export const UNKNOWN_FILTER_VALUE = '__unknown__';
export type FilterView = 'person' | 'historical';
export type CollectionFilter = { field: string; operator: string; values: string[] };
export type FilterOption = { value: string; label: string };
export type FilterOptions = Record<string, FilterOption[]>;
export const FILTER_FIELDS: Record<
  FilterView,
  { value: string; label: string; kind: 'set' | 'tags' | 'text' | 'date' }[]
> = {
  person: [
    { value: 'tags', label: 'Tags', kind: 'tags' },
    { value: 'relationship', label: 'Relationship', kind: 'set' },
    { value: 'lifeStatus', label: 'Life status', kind: 'set' },
    { value: 'text', label: 'Text', kind: 'text' },
  ],
  historical: [
    { value: 'source', label: 'Issuing source / personal', kind: 'set' },
    { value: 'acquisitionSource', label: 'Acquisition source', kind: 'set' },
    { value: 'type', label: 'Type', kind: 'set' },
    { value: 'status', label: 'Status', kind: 'set' },
    { value: 'date', label: 'Listed date', kind: 'date' },
    { value: 'text', label: 'Text', kind: 'text' },
  ],
};
export const FILTER_OPERATORS = {
  set: [
    { value: 'any', label: 'is any of' },
    { value: 'none', label: 'is none of' },
  ],
  tags: [
    { value: 'any', label: 'includes any' },
    { value: 'all', label: 'includes all' },
    { value: 'none', label: 'excludes' },
  ],
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'notContains', label: 'does not contain' },
  ],
  date: [
    { value: 'before', label: 'before' },
    { value: 'after', label: 'after' },
    { value: 'between', label: 'between (inclusive)' },
  ],
};
export function filterIssue(row: CollectionFilter, view: FilterView): string | null {
  const field = FILTER_FIELDS[view].find((item) => item.value === row.field);
  if (!field) return 'Unsupported field; remove this filter.';
  if (
    !(FILTER_OPERATORS[field.kind] as { value: string }[]).some(
      (item) => item.value === row.operator,
    )
  )
    return 'Unsupported operator; choose another operator.';
  if (!row.values.length || row.values.some((value) => !value.trim()))
    return 'Incomplete — choose a value.';
  if (field.kind === 'text' && row.values.length !== 1) return 'Text filters require one value.';
  if (field.kind === 'date') {
    if (row.values.length !== (row.operator === 'between' ? 2 : 1))
      return 'Incomplete — choose the date bounds.';
    if (
      row.values.some(
        (value) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
          new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value,
      )
    )
      return 'Invalid date — use an exact calendar date.';
    if (row.operator === 'between' && row.values[0] > row.values[1])
      return 'Invalid date range — start must be before end.';
  }
  return null;
}
export function parseCollectionFilters(raw: string | null): CollectionFilter[] {
  if (!raw) return [];
  if (raw.length > 24000) throw new Error('Filters are too long.');
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > 12) throw new Error('Choose up to 12 filters.');
  if (
    rows.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        typeof row.field !== 'string' ||
        typeof row.operator !== 'string' ||
        !Array.isArray(row.values) ||
        row.values.length > 100 ||
        row.values.some((v: unknown) => typeof v !== 'string' || v.length > 500),
    )
  )
    throw new Error('Invalid filter format.');
  return rows as CollectionFilter[];
}
export function filtersFromRoute(params: URLSearchParams, view: FilterView): CollectionFilter[] {
  if (params.has('filters')) return parseCollectionFilters(params.get('filters'));
  const rows: CollectionFilter[] = [];
  for (const [key, field] of view === 'person'
    ? [['tag', 'tags']]
    : [
        ['source', 'source'],
        ['typeLabel', 'type'],
        ['status', 'status'],
      ]) {
    const value = params.get(key);
    if (value && value !== 'all') rows.push({ field, operator: 'any', values: [value] });
  }
  return rows;
}
export function writeFiltersToRoute(params: URLSearchParams, rows: CollectionFilter[]) {
  const next = new URLSearchParams(params);
  for (const key of ['offset', 'tag', 'source', 'typeLabel', 'status']) next.delete(key);
  if (rows.length) next.set('filters', JSON.stringify(rows));
  else next.delete('filters');
  return next;
}
