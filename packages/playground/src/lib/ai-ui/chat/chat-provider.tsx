import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { RequestContext } from '@mastra/core/di';
import {
  ChatAgentContext,
  ChatMessagesContext,
  ChatQueueContext,
  ChatRunningContext,
  ChatSendContext,
  ChatTasksContext,
} from '@mastra/playground-ui/domains/chat/context/chat-context';
import type {
  AgentContextValue,
  ChatQueueAction,
  MessagesContextValue,
  RunningContextValue,
  SendContextValue,
  TasksContextValue,
} from '@mastra/playground-ui/domains/chat/context/chat-context';
import { ToolCallProvider } from '@mastra/playground-ui/domains/chat/context/tool-call-context';
import {
  buildGlobalOmPartsByCycleId,
  convertOmPartsInMastraMessage,
  hasInProgressBufferingMarkers,
  injectBufferingEnds,
  markOmMarkersAsDisconnected,
  scanOmInitialState,
} from '@mastra/playground-ui/domains/chat/om/om-parts-converter';
import type { OmTerminalExtractionCache } from '@mastra/playground-ui/domains/chat/om/om-parts-converter';
import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { useEntityTracingOptions } from '@mastra/playground-ui/domains/run-options/hooks/use-entity-tracing-options';
import { useMastraClient } from '@mastra/react';
import { useChat } from '@mastra/react/chat';
import {
  memoryStatusQueryKey,
  memoryThreadMessagesQueryKey,
  observationalMemoryQueryKey,
  useMemoryConfig,
} from '@mastra/react/hooks/memory';
import { useQueryClient } from '@tanstack/react-query';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useChatSendHandler } from './use-chat-send-handler';
import { useLiveTranscript } from './use-live-transcript';
import { useObservationalMemoryContext } from '@/domains/agents/context';
import { resolveMemoryOptions, useAgentMemoryPreferences } from '@/domains/agents/context/agent-memory-preferences';
import { useWorkingMemory } from '@/domains/agents/context/agent-working-memory-context';
import { usePlaygroundModelOptional } from '@/domains/agents/context/playground-model-context';
import { getCanSendWhileStreaming } from '@/services/mastra-runtime-state';
import type { ChatProps } from '@/types';

/**
 * Runtime + dispatch context for the main agent chat.
 *
 * Replaces the assistant-ui `MastraRuntimeProvider` (`useExternalStoreRuntime`)
 * and `ToolCallProvider`. It drives `useChat` from `@mastra/react`, preserves the
 * full streaming / generate / network behaviour (OM lifecycle, working-memory
 * refresh, thread-list refresh, stream errors, approvals, cancel), and exposes a
 * plain-prop context consumed by `MessageRow`/`MessageFactory` and the composer.
 */
export function ChatProvider({
  children,
  agentId,
  initialMessages,
  threadId,
  refreshThreadList,
  settings,
  requestContext,
  modelVersion,
  agentVersionId,
  supportsMemory,
  workspaceScope,
  accountScope,
}: Readonly<{ children: ReactNode; workspaceScope?: string; accountScope?: string }> & ChatProps) {
  const [tracingOptions] = useEntityTracingOptions('agent', agentId);
  const modelOverride = usePlaygroundModelOptional()?.modelOverride;

  // Errors emitted as `error` chunks (or thrown by sendMessage) are not persisted
  // to server memory, so they get wiped from useChat's `messages` state when
  // `initialMessages` refreshes after a stream ends. Track them in a parallel
  // state that survives those resets so the chat still surfaces the failure.
  const [streamErrors, setStreamErrors] = useState<MastraDBMessage[]>([]);
  const [threadSignalsUnsupported, setThreadSignalsUnsupported] = useState(false);
  const threadSignalsUnsupportedRef = useRef(false);
  const modelSettings = settings?.modelSettings ?? {};
  const [memoryPreferences] = useAgentMemoryPreferences(agentId);
  const threadSignalsEnabled =
    window.MASTRA_AGENT_SIGNALS !== 'false' && supportsMemory !== false && !modelSettings.chatWithLegacyStream;

  // Clear persisted stream errors when switching threads/agents so they don't
  // leak across conversations.
  useEffect(() => {
    setStreamErrors([]);
    threadSignalsUnsupportedRef.current = false;
    setThreadSignalsUnsupported(false);
  }, [agentId, threadId]);

  const chatRequestContext = useMemo(() => {
    if (!agentVersionId && !requestContext) return undefined;
    const ctx = new RequestContext();
    Object.entries(requestContext ?? {}).forEach(([key, value]) => {
      ctx.set(key, value);
    });
    if (agentVersionId) {
      ctx.set('agentVersionId', agentVersionId);
    }
    return ctx;
  }, [agentVersionId, requestContext]);

  const {
    messages,
    tasks,
    sendMessage,
    cancelRun,
    isRunning: isRunningStream,
    activeRunId,
    isAwaitingToolApproval,
    setMessages,
    approveToolCall,
    declineToolCall,
    approveToolCallGenerate,
    declineToolCallGenerate,
    toolCallApprovals,
    approveNetworkToolCall,
    declineNetworkToolCall,
    networkToolCallApprovals,
  } = useChat({
    agentId,
    threadId,
    initialMessages,
    requestContext: chatRequestContext,
    enableThreadSignals: threadSignalsEnabled,
    onSignalSent: () => {
      refreshThreadList?.();
    },
    onThreadTitleGenerated: () => {
      refreshThreadList?.();
    },
    onThreadSignalsUnsupported: () => {
      threadSignalsUnsupportedRef.current = true;
      setThreadSignalsUnsupported(true);
    },
  });

  // Keep the last view while the new connection replays into its own empty accumulator.
  const { replaying, revealedIds } = useLiveTranscript(workspaceScope, accountScope, threadId, {
    messages,
    tasks,
    runId: activeRunId,
    running: isRunningStream,
  });
  const visibleMessages = replaying?.messages ?? messages;

  const { refetch: refreshWorkingMemory } = useWorkingMemory();
  const queryClient = useQueryClient();
  const baseClient = useMastraClient();

  const { data: memoryConfigData } = useMemoryConfig({
    agentId: agentId,
    requestContext: useEntityRequestContext('agent', agentId)[0],
    queryOptions: { enabled: Boolean(agentId) },
  });
  const configuredMemoryOptions = resolveMemoryOptions(memoryPreferences);
  // Request a notification after persistence instead of racing background title generation at finish.
  // The server merges this override with its existing title model, instructions, and message threshold.
  const memoryOptions = memoryConfigData?.config?.generateTitle
    ? { ...configuredMemoryOptions, generateTitle: { emitEvent: true } }
    : configuredMemoryOptions;
  const omConfig = memoryConfigData?.config?.observationalMemory as unknown;
  const isOMEnabled =
    memoryPreferences.enabled !== false &&
    (omConfig === true ||
      (typeof omConfig === 'object' && omConfig !== null && (!('enabled' in omConfig) || omConfig.enabled !== false)));
  const {
    setIsObservingFromStream,
    setIsReflectingFromStream,
    signalObservationsUpdated,
    setStreamProgress,
    markCycleIdActivated,
  } = useObservationalMemoryContext();

  const handleObservationStart = useCallback(
    (operationType?: string) => {
      if (operationType === 'reflection') {
        setIsReflectingFromStream(true);
      } else {
        setIsObservingFromStream(true);
      }
    },
    [setIsObservingFromStream, setIsReflectingFromStream],
  );

  const handleProgressUpdate = useCallback(
    (data: any) => {
      if (data.threadId && data.threadId !== threadId) {
        return;
      }
      setStreamProgress({
        windows: data.windows,
        recordId: data.recordId,
        threadId: data.threadId,
        stepNumber: data.stepNumber,
        generationCount: data.generationCount,
      });
    },
    [setStreamProgress, threadId],
  );

  const refreshObservationalMemory = useCallback(
    (operationType?: string) => {
      if (operationType === 'reflection') {
        setIsReflectingFromStream(false);
      } else {
        setIsObservingFromStream(false);
      }
      signalObservationsUpdated();
      void queryClient.invalidateQueries({ queryKey: ['observational-memory', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['memory-status', agentId] });
      // Force an immediate refetch of the memory timeline panel, which uses the
      // playground-ui hooks keyed under the ['memory', ...] prefix. Scope to the
      // active thread so unrelated memory caches and other threads are untouched,
      // and refetch (not just invalidate) so the panel shows live data right away.
      void queryClient.refetchQueries({ queryKey: observationalMemoryQueryKey(agentId, threadId) });
      void queryClient.refetchQueries({ queryKey: memoryThreadMessagesQueryKey(threadId) });
      void queryClient.refetchQueries({ queryKey: memoryStatusQueryKey(agentId, threadId) });
    },
    [agentId, queryClient, setIsObservingFromStream, setIsReflectingFromStream, signalObservationsUpdated, threadId],
  );

  const handleActivation = useCallback(
    (data: any) => {
      const cycleId = data?.cycleId;
      if (cycleId) {
        markCycleIdActivated(cycleId);
      }
    },
    [markCycleIdActivated],
  );

  const resetObservationalMemoryStreamState = useCallback(() => {
    setIsObservingFromStream(false);
    setIsReflectingFromStream(false);
    setMessages(prev => markOmMarkersAsDisconnected(prev));
    void queryClient.invalidateQueries({ queryKey: ['observational-memory', agentId] });
    void queryClient.invalidateQueries({ queryKey: ['memory-status', agentId] });
    // Force an immediate refetch of the memory timeline panel on stream reset (see refreshObservationalMemory).
    void queryClient.refetchQueries({ queryKey: observationalMemoryQueryKey(agentId, threadId) });
    void queryClient.refetchQueries({ queryKey: memoryThreadMessagesQueryKey(threadId) });
    void queryClient.refetchQueries({ queryKey: memoryStatusQueryKey(agentId, threadId) });
  }, [agentId, queryClient, setIsObservingFromStream, setIsReflectingFromStream, setMessages, threadId]);

  // On initial load, scan messages for activation markers + last progress so
  // buffering badges show as activated and token counts are accurate on reload.
  useEffect(() => {
    const { activatedCycleIds, lastProgress } = scanOmInitialState(initialMessages || []);
    for (const cycleId of activatedCycleIds) {
      markCycleIdActivated(cycleId);
    }
    if (lastProgress) {
      handleProgressUpdate(lastProgress);
    }
  }, [handleProgressUpdate, initialMessages, markCycleIdActivated]);

  useEffect(() => {
    if (!threadId || !hasInProgressBufferingMarkers(initialMessages || [])) return;

    let cancelled = false;
    baseClient
      .awaitBufferStatus({ agentId, resourceId: agentId, threadId })
      .then(result => {
        if (cancelled) return;
        setMessages(prev => injectBufferingEnds(prev, result?.record));
      })
      .catch(() => {
        if (cancelled) return;
        setMessages(prev => markOmMarkersAsDisconnected(prev));
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, baseClient, initialMessages, setMessages, threadId]);

  const {
    frequencyPenalty,
    presencePenalty,
    maxRetries,
    maxSteps,
    maxTokens,
    temperature,
    topK,
    topP,
    seed,
    chatWithGenerate,
    chatWithNetwork,
    chatWithLegacyStream,
    providerOptions,
    requireToolApproval = false,
  } = modelSettings;

  const modelSettingsArgs = {
    frequencyPenalty,
    presencePenalty,
    maxRetries,
    temperature,
    topK,
    topP,
    seed,
    maxTokens,
    providerOptions,
    maxSteps,
    requireToolApproval,
  };

  const { send, cancel, setModelContext } = useChatSendHandler({
    agentId,
    requestContext,
    agentVersionId,
    threadId,
    modelSettingsArgs,
    memoryOptions,
    model: modelOverride,
    chatWithNetwork,
    chatWithGenerate,
    maxSteps,
    isOMEnabled,
    tracingOptions,
    threadSignalsUnsupportedRef,
    isRunningStream,
    sendMessage,
    cancelRun,
    setMessages,
    setStreamErrors,
    refreshThreadList,
    refreshWorkingMemory,
    handleObservationStart,
    handleProgressUpdate,
    refreshObservationalMemory,
    handleActivation,
    resetObservationalMemoryStreamState,
    signalTimelineRefresh: signalObservationsUpdated,
  });

  const isSupportedModel = modelVersion === 'v2' || modelVersion === 'v3';

  // Build a global OM cycle index then convert OM parts to dynamic-tool form so
  // OM badges render. Strip transient error messages from `messages` (the same
  // errors live in `streamErrors`, which survives the post-stream refresh).
  const omTerminalExtractionCacheRef = useRef<OmTerminalExtractionCache>(new Map());
  const globalOmParts = useMemo(
    () => buildGlobalOmPartsByCycleId(visibleMessages, omTerminalExtractionCacheRef.current),
    [visibleMessages],
  );

  const renderMessages = useMemo<MastraDBMessage[]>(
    () =>
      [
        ...visibleMessages.filter(
          msg => msg.content?.metadata?.status !== 'error' && msg.content?.metadata?.queued !== true,
        ),
        ...streamErrors,
      ].map(msg => convertOmPartsInMastraMessage(msg, globalOmParts)),
    [visibleMessages, streamErrors, globalOmParts],
  );

  const isRunning = isRunningStream || isAwaitingToolApproval || Boolean(replaying);
  const visibleRunId = activeRunId ?? replaying?.runId;
  const cancelVisibleRun = useCallback(async () => {
    if (!activeRunId && visibleRunId) {
      await baseClient.getAgent(agentId).abortThread({ resourceId: agentId, threadId, expectedRunId: visibleRunId });
    } else {
      await cancel();
    }
  }, [activeRunId, agentId, baseClient, cancel, threadId, visibleRunId]);
  const usesSignalStreamTransport = !chatWithGenerate && !chatWithNetwork && !chatWithLegacyStream;
  const canSendWhileStreaming = getCanSendWhileStreaming({
    isSupportedModel,
    threadSignalsEnabled: threadSignalsEnabled && usesSignalStreamTransport,
    threadId,
    threadSignalsUnsupported,
  });

  const queuedMessages = messages
    .filter(message => message.role === 'user' && message.content.metadata?.queued === true)
    .sort((a, b) => {
      const left = a.content.metadata?.queuePosition;
      const right = b.content.metadata?.queuePosition;
      return (typeof left === 'number' ? left : Infinity) - (typeof right === 'number' ? right : Infinity);
    });
  const updateQueuedMessage = async (signalId: string, action: ChatQueueAction) => {
    if (!threadId || signalId.startsWith('client-set-')) return;
    const agent = baseClient.getAgent(agentId);
    const target = { resourceId: agentId, threadId, signalId };
    if (action === 'remove') {
      await agent.cancelQueuedMessages({ resourceId: agentId, threadId, signalIds: [signalId] });
    } else {
      await agent.updateQueuedMessage({ ...target, action });
    }
    // The subscription owns convergence. A race with consumption must never remove a sent turn.
  };

  const messagesValue = useMemo<MessagesContextValue>(
    () => ({ messages: renderMessages, revealedIds }),
    [renderMessages, revealedIds],
  );
  const runningValue = useMemo<RunningContextValue>(
    () => ({ isRunning, activeRunId: visibleRunId, cancelRun: cancelVisibleRun, canSendWhileStreaming }),
    [isRunning, visibleRunId, cancelVisibleRun, canSendWhileStreaming],
  );
  const sendValue = useMemo<SendContextValue>(() => ({ send, setModelContext }), [send, setModelContext]);
  const visibleTasks = replaying?.tasks ?? tasks;
  const tasksValue = useMemo<TasksContextValue>(() => ({ tasks: visibleTasks }), [visibleTasks]);
  const agentValue = useMemo<AgentContextValue>(
    () => ({ agentId, agentVersionId, requestContext }),
    [agentId, agentVersionId, requestContext],
  );

  return (
    <ChatAgentContext.Provider value={agentValue}>
      <ChatRunningContext.Provider value={runningValue}>
        <ChatQueueContext.Provider value={{ messages: queuedMessages, update: updateQueuedMessage }}>
          <ChatMessagesContext.Provider value={messagesValue}>
            <ChatTasksContext.Provider value={tasksValue}>
              <ChatSendContext.Provider value={sendValue}>
                <ToolCallProvider
                  approveToolcall={approveToolCall}
                  declineToolcall={declineToolCall}
                  approveToolcallGenerate={approveToolCallGenerate}
                  declineToolcallGenerate={declineToolCallGenerate}
                  approveNetworkToolcall={approveNetworkToolCall}
                  declineNetworkToolcall={declineNetworkToolCall}
                  isRunning={isRunningStream}
                  toolCallApprovals={toolCallApprovals}
                  networkToolCallApprovals={networkToolCallApprovals}
                >
                  {children}
                </ToolCallProvider>
              </ChatSendContext.Provider>
            </ChatTasksContext.Provider>
          </ChatMessagesContext.Provider>
        </ChatQueueContext.Provider>
      </ChatRunningContext.Provider>
    </ChatAgentContext.Provider>
  );
}
