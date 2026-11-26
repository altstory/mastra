import type { LogViewLine } from '../../types';
import { logViewFilterFields, logViewFilterOperators } from './log-view-filter-fields';
import { FilterBar } from '@/ds/components/FilterBar';
import type { FilterBarItem } from '@/ds/components/FilterBar';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface LogViewFiltersProps {
  logs: LogViewLine[];
  value: FilterBarItem[];
  onValueChange: (value: FilterBarItem[]) => void;
  search?: boolean;
  fieldChips?: boolean;
}

function placeholder(search: boolean, fieldChips: boolean) {
  if (!fieldChips) return 'Search logs';
  return search ? 'Search or filter logs' : 'Filter logs';
}

export function LogViewFilters({ logs, value, onValueChange, search = true, fieldChips = true }: LogViewFiltersProps) {
  useLocale();
  return (
    <FilterBar
      fields={logViewFilterFields(logs, value, { search, fieldChips })}
      operators={logViewFilterOperators}
      value={value}
      onValueChange={onValueChange}
      aria-label={studioT('Log filters')}
      className="min-w-48 flex-1"
    >
      <FilterBar.Chips />
      <FilterBar.Input placeholder={placeholder(search, fieldChips)} />
    </FilterBar>
  );
}
