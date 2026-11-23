import { CrumbSkeleton, crumbSwitcherTriggerProps } from '@mastra/playground-ui/components/Breadcrumb';
import { AgentCombobox } from '@mastra/playground-ui/domains/agents/agent-combobox';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useAgents } from '@mastra/react/hooks/agents';
import { useParams } from 'react-router';

export function AgentCrumb() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agents, isLoading } = useAgents();
  if (!agentId) return null;
  if (isLoading) return <CrumbSkeleton />;

  return agents?.[agentId]?.name || agentId;
}

export function AgentSwitcher() {
  useLocale();
  const { agentId } = useParams<{ agentId: string }>();
  if (!agentId) return null;

  return <AgentCombobox value={agentId} {...crumbSwitcherTriggerProps} aria-label={studioT('Switch agent')} />;
}
