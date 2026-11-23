import { Button } from '@/ds/components/Button';
import { ButtonsGroup } from '@/ds/components/ButtonsGroup';
import { IconLayoutColumn } from '@/ds/icons/central/IconLayoutColumn';
import { IconListBullets } from '@/ds/icons/central/IconListBullets';
import { t as studioT, useLocale } from '@/lib/i18n';

export type AgentsView = 'compact' | 'list';

export interface AgentsViewToggleProps {
  view: AgentsView;
  onViewChange: (view: AgentsView) => void;
}

export function AgentsViewToggle({ view, onViewChange }: AgentsViewToggleProps) {
  useLocale();
  return (
    <ButtonsGroup aria-label={studioT('Agents view')}>
      <Button
        type="button"
        variant={view === 'list' ? 'default' : 'ghost'}
        size="icon-md"
        tooltip={studioT('List view')}
        aria-pressed={view === 'list'}
        onClick={() => onViewChange('list')}
      >
        <IconListBullets />
      </Button>
      <Button
        type="button"
        variant={view === 'compact' ? 'default' : 'ghost'}
        size="icon-md"
        tooltip={studioT('Compact view')}
        aria-pressed={view === 'compact'}
        onClick={() => onViewChange('compact')}
      >
        <IconLayoutColumn />
      </Button>
    </ButtonsGroup>
  );
}
