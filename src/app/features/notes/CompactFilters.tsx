import type { CollectionFilter, FilterOptions } from '../../../shared/collection-filters';
import { PeopleFilters } from './PeopleFilters';
export { FilterValues } from './FilterValues';

export function CompactFilters({
  rows,
  onChange,
  options,
  search,
  onSearch,
  error,
  visibility = 'visible',
}: {
  rows: CollectionFilter[];
  onChange: (rows: CollectionFilter[], visibility: string) => void;
  options: FilterOptions;
  search: string;
  onSearch: (value: string) => void;
  error?: string;
  visibility?: string;
}) {
  return (
    <PeopleFilters
      view="historical"
      searchLabel="historical notes"
      rows={rows}
      visibility={visibility}
      options={options}
      search={search}
      onSearch={onSearch}
      error={error}
      onChange={onChange}
    />
  );
}
