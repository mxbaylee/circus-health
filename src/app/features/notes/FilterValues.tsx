import { useState } from 'react';
import {
  UNKNOWN_FILTER_VALUE,
  type CollectionFilter,
  type FilterOptions,
} from '../../../shared/collection-filters';
import './compact-filters.css';

export function FilterValues({
  row,
  options,
  onChange,
  index,
}: {
  row: CollectionFilter;
  options: FilterOptions;
  onChange: (values: string[]) => void;
  index: number;
}) {
  const [search, setSearch] = useState('');
  const values = [
    ...(options[row.field] || []),
    {
      value: UNKNOWN_FILTER_VALUE,
      label: row.field === 'tags' ? 'Unknown / untagged' : 'Unknown / unspecified',
    },
  ];
  const missing = row.values.filter(
    (value) => !values.some((option) => option.value.toLowerCase() === value.toLowerCase()),
  );
  const available = [
    ...values,
    ...missing.map((value) => ({ value, label: `${value} (not in current options)` })),
  ];
  return (
    <fieldset className="filter-values">
      <legend className="sr-only">Values for filter {index + 1}</legend>
      <input
        type="search"
        aria-label={`Search values for filter ${index + 1}`}
        placeholder="Find values…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="filter-checklist">
        {available
          .filter((option) => option.label.toLowerCase().includes(search.toLowerCase()))
          .map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={row.values.some(
                  (value) => value.toLowerCase() === option.value.toLowerCase(),
                )}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...row.values, option.value]
                      : row.values.filter(
                          (value) => value.toLowerCase() !== option.value.toLowerCase(),
                        ),
                  )
                }
              />{' '}
              <span>{option.label}</span>
            </label>
          ))}
      </div>
      {missing.length > 0 && (
        <p className="filter-warning">
          Some saved values are absent from current options. They remain exact filters until
          removed.
        </p>
      )}
    </fieldset>
  );
}
