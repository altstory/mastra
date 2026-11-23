import { ActionRow } from '@mastra/playground-ui/components/ActionRow';
import type { FilterBarField } from '@mastra/playground-ui/components/FilterBar';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import type { ReactNode } from 'react';
import { metricsCrumbs } from '../metrics-crumbs';
import { MetricsFilterBar } from './metrics-filter-bar';
import { PageBreadcrumbs } from '@/components/ui/page-breadcrumbs';

type MetricsPageLayoutProps = {
  children: ReactNode;
  filterFields: FilterBarField[];
};

/** URL controls do not need storage access and remain usable on unsupported stores. */
export function MetricsPageLayout({ children, filterFields }: MetricsPageLayoutProps) {
  useLocale();
  return (
    <PageLayout
      variant="page"
      breadcrumbs={<PageBreadcrumbs crumbs={metricsCrumbs} />}
      actionRow={
        <ActionRow>
          <ActionRow.Start>
            <MetricsFilterBar fields={filterFields} />
          </ActionRow.Start>
        </ActionRow>
      }
    >
      <h1 className="sr-only">{studioT('Metrics')}</h1>
      {children}
    </PageLayout>
  );
}
