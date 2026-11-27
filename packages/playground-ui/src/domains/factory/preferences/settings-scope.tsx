import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/ds/components/Badge';
import type { BadgeVariant } from '@/ds/components/Badge';
import { IconBuildings } from '@/ds/icons/central/IconBuildings';
import { IconServer } from '@/ds/icons/central/IconServer';
import { IconUser } from '@/ds/icons/central/IconUser';
import { IconUserDuo } from '@/ds/icons/central/IconUserDuo';
import { t as studioT, useLocale } from '@/lib/i18n';

export type SettingsScope = 'personal' | 'factory' | 'org' | 'deployment';

const SCOPE_BADGE: Record<SettingsScope, { label: string; variant: BadgeVariant; icon: LucideIcon }> = {
  personal: {
    get label() {
      return studioT('Personal');
    },
    variant: 'neutral',
    icon: IconUser,
  },
  factory: {
    get label() {
      return studioT('Factory-wide');
    },
    variant: 'blue',
    icon: IconBuildings,
  },
  org: {
    get label() {
      return studioT('Org-wide');
    },
    variant: 'blue',
    icon: IconUserDuo,
  },
  deployment: {
    get label() {
      return studioT('Deployment-wide');
    },
    variant: 'blue',
    icon: IconServer,
  },
};

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  useLocale();
  const { label, variant, icon: Icon } = SCOPE_BADGE[scope];
  return (
    <Badge size="sm" variant={variant} icon={<Icon aria-hidden="true" />}>
      {label}
    </Badge>
  );
}
