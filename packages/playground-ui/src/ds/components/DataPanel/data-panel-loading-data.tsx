import type { ReactNode } from 'react';
import { Spinner } from '@/ds/components/Spinner';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface DataPanelLoadingDataProps {
  children?: ReactNode;
}

export function DataPanelLoadingData({ children }: DataPanelLoadingDataProps) {
  useLocale();
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 px-3 py-4 text-caption text-subtle-foreground">
      <Spinner size="sm" variant="pulse" className="text-subtle-foreground" /> {children ?? studioT('Loading...')}
    </div>
  );
}
