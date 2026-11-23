import { ActionRow } from '@mastra/playground-ui/components/ActionRow';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { SearchInput, listSearchProps } from '@mastra/playground-ui/components/SearchInput';
import { PermissionDenied } from '@mastra/playground-ui/domains/auth/components/permission-denied';
import { SessionExpired } from '@mastra/playground-ui/domains/auth/components/session-expired';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { is401UnauthorizedError, is403ForbiddenError } from '@mastra/playground-ui/utils/errors';
import { useAgents } from '@mastra/react/hooks/agents';
import { useTools } from '@mastra/react/hooks/tools';
import { useState } from 'react';
import { PageBreadcrumbs } from '@/components/ui/page-breadcrumbs';
import { navCrumb } from '@/domains/navigation/crumbs';
import { ToolDrawer } from '@/domains/tools/components/tool-drawer/tool-drawer';
import { ToolsPageDrawerBody } from '@/domains/tools/components/tool-drawer/tools-page-tool-drawer-body';
import { NoToolsInfo } from '@/domains/tools/components/tools-list/no-tools-info';
import { ToolsList } from '@/domains/tools/components/tools-list/tools-list';
import type { ToolsSort } from '@/domains/tools/components/tools-list/tools-list';
import { useAltflowToolCatalog } from '@/domains/tools/hooks/use-altflow-tool-catalog';
import { useToolDrawerParam } from '@/domains/tools/hooks/use-tool-drawer-param';

const crumbs = [navCrumb('/tools')];

export default function Tools() {
  useLocale();
  const { data: agentsRecord = {}, isLoading: isLoadingAgents, error: agentsError } = useAgents();
  const { data: tools = {}, isLoading: isLoadingTools, error: toolsError } = useTools();
  const catalog = useAltflowToolCatalog();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ToolsSort>();
  const { toolId: openToolId } = useToolDrawerParam();

  const isLoading = isLoadingAgents || isLoadingTools || catalog.isLoading;
  const error = toolsError || agentsError || catalog.error;

  if (error && is401UnauthorizedError(error)) {
    return (
      <PageLayout variant="page" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
        <h1 className="sr-only">{studioT('Tools')}</h1>
        <SessionExpired variant="fill" />
      </PageLayout>
    );
  }

  if (error && is403ForbiddenError(error)) {
    return (
      <PageLayout variant="page" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
        <h1 className="sr-only">{studioT('Tools')}</h1>
        <PermissionDenied variant="fill" resource="tools" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="page" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
        <h1 className="sr-only">{studioT('Tools')}</h1>
        <EmptyState
          tone="error"
          variant="fill"
          titleSlot={studioT('Failed to load tools')}
          descriptionSlot={error.message}
        />
      </PageLayout>
    );
  }

  if (Object.keys(tools).length === 0 && !catalog.data?.length && !isLoading) {
    return (
      <PageLayout variant="page" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
        <h1 className="sr-only">{studioT('Tools')}</h1>
        <NoToolsInfo />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      variant="page"
      breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}
      actionRow={
        <ActionRow>
          <ActionRow.Start>
            <div className="max-w-120 flex-1">
              <SearchInput
                {...listSearchProps}
                onValueChange={setSearch}
                label={studioT('Search tools')}
                placeholder={studioT('Search by name')}
              />
            </div>
          </ActionRow.Start>
        </ActionRow>
      }
    >
      <h1 className="sr-only">{studioT('Tools')}</h1>
      <ToolsList
        tools={tools}
        catalog={catalog.data ?? undefined}
        agents={agentsRecord}
        isLoading={isLoading}
        search={search}
        sort={sort}
        onSortChange={(direction, key) => setSort({ key, direction })}
        selectedToolId={openToolId}
      />
      <ToolDrawer>
        <ToolsPageDrawerBody />
      </ToolDrawer>
    </PageLayout>
  );
}
