import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Pencil, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import '../features/notes/compact-filters.css';
import '../features/notes/people-filters.css';

export type FilterDefinition = {
  key: string;
  label: string;
  value: string;
  initial: string;
  clear: string;
  applied: (value: string) => boolean;
  valid: (value: string) => boolean;
  summary: (value: string) => string;
  editor: (value: string, onChange: (value: string) => void) => ReactNode;
};

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function visibilityFilter(
  value: string,
  {
    key = 'visibility',
    activeValue = 'visible',
    inactiveValue = 'archived',
  }: { key?: string; activeValue?: string; inactiveValue?: string } = {},
): FilterDefinition {
  return {
    key,
    label: 'Active status',
    value,
    initial: activeValue,
    clear: 'all',
    applied: (next) => next !== 'all',
    valid: (next) => next === activeValue || next === inactiveValue,
    summary: (next) => (next === activeValue ? 'Active' : 'Inactive'),
    editor: (next, onChange) => (
      <label className="people-boolean-switch">
        <span>{next === activeValue ? 'Active' : 'Inactive'}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Active"
          checked={next === activeValue}
          onChange={(event) => onChange(event.target.checked ? activeValue : inactiveValue)}
        />
      </label>
    ),
  };
}

export function selectFilter({
  key,
  label,
  value,
  options,
  initial = '',
  clear = '',
}: {
  key: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  initial?: string;
  clear?: string;
}): FilterDefinition {
  return {
    key,
    label,
    value,
    initial,
    clear,
    applied: (next) => next !== clear,
    valid: (next) => options.some((option) => option.value === next),
    summary: (next) =>
      `${label} is ${options.find((option) => option.value === next)?.label || next}`,
    editor: (next, onChange) => (
      <label>
        <span className="sr-only">{label}</span>
        <select aria-label={label} value={next} onChange={(event) => onChange(event.target.value)}>
          {initial === '' && <option value="">Choose {label.toLowerCase()}…</option>}
          {next && !options.some((option) => option.value === next) && (
            <option value={next}>Unsupported: {next}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    ),
  };
}

export function dateRangeFilter(from: string, to: string): FilterDefinition {
  const encode = (start: string, end: string) => `${start}|${end}`;
  return {
    key: 'date',
    label: 'Listed date',
    value: encode(from, to),
    initial: '|',
    clear: '|',
    applied: (value) => value !== '|',
    valid: (value) => {
      const [start, end] = value.split('|');
      return (
        !!(start || end) &&
        (!start || isIsoDate(start)) &&
        (!end || isIsoDate(end)) &&
        !(start && end && start > end)
      );
    },
    summary: (value) => {
      const [start, end] = value.split('|');
      return start && end
        ? `Listed date ${start} to ${end}`
        : start
          ? `Listed date from ${start}`
          : `Listed date through ${end}`;
    },
    editor: (value, onChange) => {
      const [start, end] = value.split('|');
      return (
        <div className="filter-date-values">
          <input
            type="date"
            aria-label="Start date"
            value={start}
            max={end || undefined}
            onChange={(event) => onChange(encode(event.target.value, end))}
          />
          <input
            type="date"
            aria-label="End date"
            value={end}
            min={start || undefined}
            onChange={(event) => onChange(encode(start, event.target.value))}
          />
        </div>
      );
    },
  };
}

export function CollectionFilters({
  search,
  onSearch,
  searchLabel,
  definitions,
  onApply,
}: {
  search: string;
  onSearch: (value: string) => void;
  searchLabel: string;
  definitions: FilterDefinition[];
  onApply: (key: string, value: string) => void;
}) {
  const applied = definitions.filter((definition) => definition.applied(definition.value));
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{
    key: string;
    value: string;
    existing: boolean;
  } | null>(null);
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const signature = definitions.map(({ key, value }) => `${key}:${value}`).join('|');
  useEffect(() => setEditing(null), [signature]);
  useEffect(() => {
    if (editing) firstField.current?.focus();
  }, [editing?.key]);
  const finish = () => {
    setEditing(null);
    toggle.current?.focus();
  };
  const begin = (definition: FilterDefinition, existing: boolean) => {
    setExpanded(true);
    setEditing({
      key: definition.key,
      value: definition.applied(definition.value) ? definition.value : definition.initial,
      existing,
    });
  };
  const definition = definitions.find((item) => item.key === editing?.key);
  const unchanged = !!definition && editing?.value === definition.value;
  const available = definitions.filter((item) =>
    editing?.existing ? item.key === editing.key : !item.applied(item.value),
  );
  return (
    <div className="compact-filters people-filters collection-filters">
      <div className="compact-search">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
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
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span>Filters</span>
          {applied.length > 0 && <span className="filter-count">{applied.length}</span>}
        </button>
      </div>
      {applied.length > 0 && (
        <ul className="people-filter-pills" aria-label="Saved filters">
          {applied.map((item) => {
            const label = item.valid(item.value)
              ? item.summary(item.value)
              : `${item.label} has unsupported value ${item.value || 'blank'}`;
            return (
              <li className="people-filter-pill" key={item.key}>
                <span>{label}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${label}`}
                  disabled={!!editing}
                  onClick={() => begin(item, true)}
                >
                  <Pencil size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Delete ${label}`}
                  disabled={!!editing}
                  onClick={() => onApply(item.key, item.clear)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {expanded && (
        <section className="filter-panel" id={panelId} aria-label="Filter conditions">
          {editing && definition ? (
            <form
              className="filter-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!definition.valid(editing.value) || unchanged) return;
                onApply(editing.key, editing.value);
                finish();
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
                    aria-label="Filter field"
                    value={editing.key}
                    onChange={(event) => {
                      const next = definitions.find((item) => item.key === event.target.value)!;
                      setEditing({
                        key: next.key,
                        value: next.applied(next.value) ? next.value : next.initial,
                        existing: false,
                      });
                    }}
                  >
                    {available.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  {definition.editor(editing.value, (value) => setEditing({ ...editing, value }))}
                </div>
              </div>
              <div className="people-filter-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={!definition.valid(editing.value) || unchanged}
                >
                  Save filter
                </button>
                <button type="button" className="button secondary" onClick={finish}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="filter-warning">Add a condition, or edit a saved filter.</p>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={!!editing || !available.length}
            onClick={() => {
              const next = definitions.find((item) => !item.applied(item.value));
              if (next) begin(next, false);
            }}
          >
            <Plus size={16} aria-hidden="true" /> Add filter
          </button>
        </section>
      )}
    </div>
  );
}
