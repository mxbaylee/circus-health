import { useEffect, useId, useRef, useState } from 'react';
import { Pencil, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  FILTER_FIELDS,
  FILTER_OPERATORS,
  UNKNOWN_FILTER_VALUE,
  filterIssue,
  type CollectionFilter,
  type FilterOptions,
  type FilterView,
} from '../../../shared/collection-filters';
import { FilterValues } from './FilterValues';
import './people-filters.css';

type PeopleRule = CollectionFilter & { activity: boolean };
const statusOptions = [
  { value: 'visible', label: 'Active' },
  { value: 'archived', label: 'Inactive' },
];
function issue(row: PeopleRule, view: FilterView) {
  return row.activity
    ? row.operator !== 'any' ||
      row.values.length !== 1 ||
      !statusOptions.some((option) => option.value === row.values[0])
      ? 'Choose Active or Inactive.'
      : null
    : filterIssue(row, view);
}
function summary(
  row: PeopleRule,
  options: FilterOptions,
  fields: { value: string; label: string; kind: 'set' | 'tags' | 'text' | 'date' }[],
  view: FilterView,
) {
  if (row.activity && !issue(row, view)) return row.values[0] === 'visible' ? 'Active' : 'Inactive';
  const field = fields.find((item) => item.value === row.field);
  const operator = row.activity
    ? 'is'
    : row.operator === 'any' && field?.kind === 'set'
      ? 'includes'
      : field && FILTER_OPERATORS[field.kind].find((item) => item.value === row.operator)?.label;
  const values = row.values.map((value) =>
    value === UNKNOWN_FILTER_VALUE
      ? 'Unknown'
      : options[row.field]?.find((option) => option.value.toLowerCase() === value.toLowerCase())
          ?.label || value,
  );
  return `${field?.label || row.field} ${issue(row, view) || `${operator} ${values.join(', ')}`}`;
}

function signatureForRule(
  row: CollectionFilter | undefined,
  fields: { value: string; kind: string }[],
) {
  if (!row) return '';
  const kind = fields.find((field) => field.value === row.field)?.kind;
  return JSON.stringify({
    ...row,
    values:
      kind === 'set' || kind === 'tags'
        ? [...new Set(row.values.map((value) => value.toLowerCase()))].sort()
        : row.values,
  });
}

/** Saved repeated-rule editor shared by People and Historical notes. */
export function PeopleFilters({
  view = 'person',
  searchLabel = 'people',
  rows,
  visibility,
  options,
  search,
  onSearch,
  onChange,
  error,
}: {
  view?: FilterView;
  searchLabel?: string;
  rows: CollectionFilter[];
  visibility: string;
  options: FilterOptions;
  search: string;
  onSearch: (value: string) => void;
  onChange: (rows: CollectionFilter[], visibility: string) => void;
  error?: string;
}) {
  const fields = [
    { value: 'visibility', label: 'Active status', kind: 'set' as const },
    ...FILTER_FIELDS[view],
  ];
  const applied = [
    ...(visibility === 'all'
      ? []
      : [{ field: 'visibility', operator: 'any', values: [visibility], activity: true }]),
    ...rows.map((row) => ({ ...row, activity: false })),
  ];
  const allOptions = { ...options, visibility: statusOptions };
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ index: number; row: PeopleRule } | null>(null);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const restoreFocus = useRef(false);
  const signature = JSON.stringify(applied);
  // Back/Forward or an external applied-filter change cancels a stale draft.
  useEffect(() => {
    setEditing(null);
  }, [signature]);
  useEffect(() => {
    if (editing) firstField.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      toggle.current?.focus();
    }
  }, [editing?.index, signature]);
  const finish = () => {
    restoreFocus.current = true;
    setEditing(null);
  };
  const apply = (next: PeopleRule[]) => {
    onChange(
      next
        .filter((row) => !row.activity)
        .map(({ field, operator, values }) => ({ field, operator, values })),
      next.find((row) => row.activity)?.values[0] || 'all',
    );
    finish();
  };
  const begin = (index: number, row: PeopleRule) => {
    setExpanded(true);
    setEditing({ index, row: { ...row, values: [...row.values] } });
  };
  const patch = (value: Partial<PeopleRule>) =>
    setEditing((current) => (current ? { ...current, row: { ...current.row, ...value } } : null));
  const field = fields.find((item) => item.value === editing?.row.field);
  const operators =
    field?.value === 'visibility'
      ? [{ value: 'any', label: 'is' }]
      : field
        ? FILTER_OPERATORS[field.kind]
        : [];
  const warning = editing && issue(editing.row, view);
  const unchanged =
    editing &&
    signatureForRule(editing.row, fields) === signatureForRule(applied[editing.index], fields);
  const hasStatus = applied.some((row) => row.activity);
  return (
    <div className="compact-filters people-filters">
      <div className="compact-search">
        <label className="search-field">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={`Search ${searchLabel}…`}
            aria-label={`Search ${searchLabel}`}
          />
        </label>
        <button
          ref={toggle}
          type="button"
          className="button secondary filter-toggle"
          aria-label={`Filters${applied.length ? `, ${applied.length} active` : ''}`}
          aria-expanded={expanded}
          aria-controls={panelId}
          disabled={!!editing}
          onClick={() => setExpanded((value) => !value)}
        >
          <SlidersHorizontal size={18} />
          <span>Filters</span>
          {applied.length > 0 && <span className="filter-count">{applied.length}</span>}
        </button>
      </div>
      {applied.length > 0 && (
        <ul className="people-filter-pills" aria-label="Saved filters">
          {applied.map((row, index) => {
            const label = summary(row, allOptions, fields, view);
            return (
              <li key={index} className="people-filter-pill">
                <span>{label}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${label}`}
                  disabled={!!editing || !!error}
                  onClick={() => begin(index, row)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Delete ${label}`}
                  disabled={!!editing || !!error}
                  onClick={() => apply(applied.filter((_, i) => i !== index))}
                >
                  <X size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="filter-warning" role="alert">
          {error}{' '}
          <button
            type="button"
            className="text-link"
            disabled={!!editing}
            onClick={() => apply([])}
          >
            Clear filters
          </button>
        </p>
      )}
      {expanded && (
        <section className="filter-panel" id={panelId} aria-label="Filter conditions">
          {editing ? (
            <form
              className="filter-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (warning || unchanged) return;
                const next = [...applied];
                next[editing.index] = editing.row;
                apply(next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  finish();
                }
              }}
            >
              <div className="filter-row-controls">
                <label>
                  <span className="sr-only">Filter field</span>
                  <select
                    ref={firstField}
                    value={editing.row.field}
                    onChange={(event) => {
                      const next = fields.find((item) => item.value === event.target.value)!;
                      patch({
                        field: next.value,
                        activity: next.value === 'visibility',
                        operator: FILTER_OPERATORS[next.kind][0].value,
                        values: next.value === 'visibility' ? ['visible'] : [],
                      });
                    }}
                  >
                    {!field && (
                      <option value={editing.row.field}>Unsupported: {editing.row.field}</option>
                    )}
                    {fields.map((item) => (
                      <option
                        key={item.value}
                        value={item.value}
                        disabled={
                          (item.value === 'visibility' &&
                            hasStatus &&
                            !applied[editing.index]?.activity) ||
                          (rows.length >= 12 &&
                            applied[editing.index]?.activity &&
                            item.value !== 'visibility')
                        }
                      >
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {editing.row.activity ? (
                  <label className="people-boolean-switch">
                    <span>{editing.row.values[0] === 'visible' ? 'Active' : 'Inactive'}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label="Active"
                      checked={editing.row.values[0] === 'visible'}
                      onChange={(event) =>
                        patch({ values: [event.target.checked ? 'visible' : 'archived'] })
                      }
                    />
                  </label>
                ) : (
                  <label>
                    <span className="sr-only">Filter operator</span>
                    <select
                      value={editing.row.operator}
                      onChange={(event) =>
                        patch({
                          operator: event.target.value,
                          ...(field?.kind === 'date' ? { values: [] } : {}),
                        })
                      }
                    >
                      {!operators.some((item) => item.value === editing.row.operator) && (
                        <option value={editing.row.operator}>
                          Unsupported: {editing.row.operator}
                        </option>
                      )}
                      {operators.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {!editing.row.activity && field?.kind === 'date' ? (
                <div className="filter-date-values">
                  {Array.from(
                    { length: editing.row.operator === 'between' ? 2 : 1 },
                    (_, index) => (
                      <input
                        key={index}
                        type="date"
                        aria-label={`${index === 1 ? 'End' : 'Start'} date for filter`}
                        value={editing.row.values[index] || ''}
                        onChange={(event) => {
                          const values = Array.from(
                            { length: editing.row.operator === 'between' ? 2 : 1 },
                            (_, slot) => editing.row.values[slot] || '',
                          );
                          values[index] = event.target.value;
                          patch({ values });
                        }}
                      />
                    ),
                  )}
                </div>
              ) : !editing.row.activity && field?.kind === 'text' ? (
                <input
                  aria-label="Filter text"
                  value={editing.row.values[0] || ''}
                  onChange={(event) => patch({ values: [event.target.value] })}
                />
              ) : (
                !editing.row.activity &&
                field && (
                  <FilterValues
                    key={field.value}
                    row={editing.row}
                    options={allOptions}
                    index={editing.index}
                    onChange={(values) => patch({ values })}
                  />
                )
              )}
              {warning && (
                <p className="filter-warning" role="status">
                  {warning}
                </p>
              )}
              <div className="people-filter-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={!!warning || !!unchanged}
                >
                  Save filter
                </button>
                <button type="button" className="button secondary" onClick={finish}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="filter-warning">
              Add a condition, or edit a saved filter. Conditions apply together.
            </p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={!!editing || !!error || rows.length >= 12}
            onClick={() =>
              begin(applied.length, {
                field: FILTER_FIELDS[view][0].value,
                operator: FILTER_OPERATORS[FILTER_FIELDS[view][0].kind][0].value,
                values: [],
                activity: false,
              })
            }
          >
            <Plus size={16} /> Add filter
          </button>
        </section>
      )}
    </div>
  );
}
