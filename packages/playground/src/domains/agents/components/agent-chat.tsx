import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { t } from '@mastra/playground-ui/lib/i18n';
import { useAgentMessages } from '@mastra/react/hooks/agents';
import { useEffect, useRef } from 'react';
import { useAgentSettings } from '../context/agent-context';
import { ConversationWorkspace } from '@/domains/conversation/files/conversation-workspace';
import { ProjectLandingHeader, ProjectLandingContent } from '@/domains/navigation/components/project-landing';
import type { ConversationProject } from '@/domains/navigation/use-conversation-projects';
import { ChatProvider } from '@/lib/ai-ui/chat/chat-provider';
import { Thread } from '@/lib/ai-ui/thread';

import type { ChatProps } from '@/types';

export const AgentChat = ({
  agentId,
  agentName,
  threadId,
  memory,
  refreshThreadList,
  modelVersion,
  agentVersionId,
  supportsMemory,
  modelList,
  messageId,
  suggestedPrompts,
  isNewThread,
  hideModelSwitcher,
  workspaceScope,
  accountScope,
  project,
}: Omit<ChatProps, 'initialMessages'> & {
  memory?: boolean;
  messageId?: string;
  suggestedPrompts?: string[];
  isNewThread?: boolean;
  hideModelSwitcher?: boolean;
  workspaceScope?: string;
  accountScope?: string;
  project?: ConversationProject;
}) => {
  const { settings } = useAgentSettings();
  const requestContext = useEntityRequestContext('agent', agentId)[0];

  const {
    data,
    isLoading: isMessagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useAgentMessages({
    agentId: agentId,
    threadId: isNewThread ? undefined : threadId,
    memory: memory ?? false,
    requestContext: requestContext,
    // Keep the last transcript on navigation; stale data refetches in the background.
    queryOptions: { gcTime: 5 * 60_000 },
  });

  // Handle scrolling to message after navigation
  useEffect(() => {
    if (messageId && data && !isMessagesLoading) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
          messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          messageElement.classList.add('bg-muted');
          setTimeout(() => {
            messageElement.classList.remove('bg-muted');
          }, 2000);
        }
      }, 100);
    }
  }, [messageId, data, isMessagesLoading]);

  // Stable empty array per thread: stays the same reference across re-renders
  // (preventing useChat from wiping streamed messages), but changes when threadId
  // changes (allowing useChat to reset when switching threads).
  const emptyMessagesRef = useRef<{ threadId: string; messages: never[] }>({ threadId, messages: [] });
  if (emptyMessagesRef.current.threadId !== threadId) {
    emptyMessagesRef.current = { threadId, messages: [] };
  }

  const messages = data?.messages ?? emptyMessagesRef.current.messages;

  const loadOlderMessages = () => {
    if (!isFetchingNextPage) void fetchNextPage();
  };

  const thread = (
    <Thread
      agentName={agentName ?? ''}
      agentId={agentId}
      threadId={threadId}
      suggestedPrompts={suggestedPrompts}
      hasModelList={Boolean(modelList)}
      hideModelSwitcher={hideModelSwitcher}
      summaryOnly
      workspaceFiles={Boolean(workspaceScope)}
      isHistoryLoading={isMessagesLoading}
      onLoadPrevious={hasNextPage ? loadOlderMessages : undefined}
      isLoadingPrevious={isFetchingNextPage}
      landingHeader={project ? <ProjectLandingHeader project={project} agentId={agentId} /> : undefined}
      landingContent={project ? <ProjectLandingContent project={project} /> : undefined}
      composerPlaceholder={project ? t('New chat in {name}', { name: project.name }) : undefined}
    />
  );

  return (
    <ChatProvider
      agentId={agentId}
      agentName={agentName}
      modelVersion={modelVersion}
      agentVersionId={agentVersionId}
      supportsMemory={supportsMemory}
      threadId={threadId}
      initialMessages={messages}
      refreshThreadList={refreshThreadList}
      settings={settings}
      requestContext={requestContext}
      workspaceScope={workspaceScope}
      accountScope={accountScope}
    >
      {workspaceScope ? (
        <ConversationWorkspace
          key={workspaceScope}
          agentId={agentId}
          scope={workspaceScope}
          threadId={isNewThread || !memory ? undefined : threadId}
          requestContext={requestContext}
        >
          {thread}
        </ConversationWorkspace>
      ) : (
        thread
      )}
    </ChatProvider>
  );
};
