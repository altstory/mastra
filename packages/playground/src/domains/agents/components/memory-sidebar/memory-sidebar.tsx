import type { StorageThreadType } from '@mastra/core/memory';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { SidebarPanel } from '@mastra/playground-ui/domains/agents/chat/sidebar-panel';
import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useMemory } from '@mastra/react/hooks/memory';
import './memory-sidebar.css';
import { ChatThreads } from '@/domains/agents/components/chat-threads';

export interface MemorySidebarProps {
  agentId: string;
  threadId: string;
  threads?: StorageThreadType[];
  onDelete?: (threadId: string) => void;
  /** When provided, rendered as the thread layer instead of the built-in ChatThreads list. */
  threadsSlot?: React.ReactNode;
  /** Forwarded to ChatThreads; keeps its header in place while the list loads. */
  isThreadsLoading?: boolean;
}

export function MemorySidebar(props: MemorySidebarProps) {
  return (
    <SidebarPanel>
      <MemorySidebarBody {...props} />
    </SidebarPanel>
  );
}

export function MemorySidebarBody({
  agentId,
  threadId,
  threads,
  onDelete,
  threadsSlot,
  isThreadsLoading,
}: MemorySidebarProps) {
  useLocale();
  const { data: memory, isLoading } = useMemory({
    agentId,
    requestContext: useEntityRequestContext('agent', agentId)[0],
    queryOptions: { enabled: Boolean(agentId) },
  });
  if (isLoading)
    return (
      <div data-testid="memory-sidebar-skeleton" className="space-y-3 p-3">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-24" />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        {threadsSlot ??
          (memory?.result ? (
            <ChatThreads
              key={agentId}
              resourceId={agentId}
              resourceType="agent"
              threads={threads ?? []}
              threadId={threadId}
              onDelete={onDelete ?? (() => {})}
              embedded
              isLoading={isThreadsLoading}
            />
          ) : (
            <EmptyState
              titleSlot={studioT('Memory not enabled')}
              descriptionSlot={studioT('Conversations are only saved as threads when the agent has memory configured.')}
              actionSlot={
                <Button
                  render={<a href="https://mastra.ai/docs/memory/overview" target="_blank" rel="noopener noreferrer" />}
                >
                  {studioT('View documentation')}
                </Button>
              }
            />
          ))}
      </div>
    </div>
  );
}
