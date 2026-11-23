import { ScorersIcon } from '@/ds/icons/ScorersIcon';
import { t as studioT } from '@/lib/i18n';

export const DEFAULT_SCORERS_LABEL = (
  <span className="flex items-center gap-1.5 [&>svg]:size-icon-sm [&>svg]:shrink-0">
    <ScorersIcon />
    {studioT('Default scorers')}
  </span>
);
export const DEFAULT_SCORERS_HELPER_TEXT =
  'Pre-selected when running experiments on this dataset. Items can override them.';
