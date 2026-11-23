import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { InfrastructureOverview } from '@/domains/agent-builder/components/infrastructure/infrastructure-overview';

export const AgentBuilderInfrastructure = () => {
  useLocale();
  return (
    <PageLayout
      variant="settings"
      header={
        <PageHeader>
          <PageHeader.Title>{studioT('Infrastructure')}</PageHeader.Title>
          <PageHeader.Description>
            {studioT('Deployment-level defaults Agent Builder applies when users create or run builder agents.')}
          </PageHeader.Description>
        </PageHeader>
      }
    >
      <InfrastructureOverview />
    </PageLayout>
  );
};

export default AgentBuilderInfrastructure;
