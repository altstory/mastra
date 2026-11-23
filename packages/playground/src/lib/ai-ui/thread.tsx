import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import {
  ChatAnnotationsProvider,
  ComposerAnnotations,
  formatAnnotatedMessage,
  TranscriptAnnotations,
  useChatAnnotations,
  useOptionalChatAnnotations,
} from '@mastra/playground-ui/components/ai/annotations';
import type { ChatAnnotation } from '@mastra/playground-ui/components/ai/annotations';
import { ArrivalScope } from '@mastra/playground-ui/components/Arrival';
import { Button } from '@mastra/playground-ui/components/Button';
import { ChatShell } from '@mastra/playground-ui/components/ChatShell';
import {
  Composer,
  ComposerActions,
  ComposerActionsEnd,
  ComposerActionsStart,
  ComposerBox,
  ComposerInput,
  ComposerRing,
} from '@mastra/playground-ui/components/Composer';
import { MessageScrollerItem } from '@mastra/playground-ui/components/MessageScroller';
import { PendingIndicator } from '@mastra/playground-ui/components/PendingIndicator';
import {
  buildThreadRailTurns,
  getClientMessageKey,
  groupTurns,
  ThreadRail,
} from '@mastra/playground-ui/components/ThreadRail';
import type { ThreadRailTurn } from '@mastra/playground-ui/components/ThreadRail';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ChatMessagesLoadingSkeleton } from '@mastra/playground-ui/domains/agents/chat/agent-loading-skeletons';
import {
  ChatMetricsProvider,
  SaveFullConversationAction,
  useChatPreferences,
  WorkDetails,
  WorkDetailsToggle,
} from '@mastra/playground-ui/domains/chat';
import { useChatMessages, useChatRunning, useChatSend } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { MessageRow } from '@mastra/playground-ui/domains/chat/messages/message-row';
import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { IconArrowUp } from '@mastra/playground-ui/icons/central/IconArrowUp';
import { IconMicrophone } from '@mastra/playground-ui/icons/central/IconMicrophone';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { quietTextHover } from '@mastra/playground-ui/primitives/typography';
import { useSpeechRecognition } from '@mastra/react';
import { useReadAloud } from '@mastra/react/hooks/voice';

import type { MessageFactoryPart } from '@mastra/react/ui';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { toast } from 'sonner';
import { AttachFileMenu } from './attachments/attach-file-menu';
import { ComposerAttachments as ChatComposerAttachments } from './attachments/attachment';
import { ComposerAttachmentsProvider, useComposerAttachments } from './attachments/composer-attachments';
import { ComposerFileDrop } from './attachments/composer-file-drop';
import { BranchMessageAction } from './chat/branch-message-action';
import { ConversationStats } from './chat/conversation-stats';
import { QueuedMessages } from './chat/queued-messages';
import { BracketOverlay } from './components/bracket-overlay';
import { MarkdownComposerInput } from './components/markdown-composer-input';
import { useComposerAutofocus } from './hooks/use-composer-autofocus';
import { SuggestedPromptList } from './suggested-prompt-list';
import { TaskPanel } from './task-panel';
import type { StoredFileReference } from '@/domains/account/storage-api';
import { BrowserThumbnail, useBrowserSession } from '@/domains/agents';
import { AgentChannelsCard } from '@/domains/agents/components/agent-channels/agent-channels-card';
import { ComposerModelSwitcher, ComposerModelWarning } from '@/domains/agents/components/composer-model-switcher';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { useThreadInput } from '@/domains/conversation/context/useThreadInput';
import {
  ComposerFileReferenceList,
  FileReferenceSuggestions,
} from '@/domains/conversation/files/composer-file-references';
import {
  formatFileReferences,
  referenceAt,
  useFileReferenceSuggestions,
} from '@/domains/conversation/files/file-reference-helpers';
import { TurnFileChanges } from '@/domains/conversation/files/turn-file-changes';
import { useTurnFileChanges } from '@/domains/conversation/files/use-turn-file-changes';
import { startViewTransition } from '@/lib/routing';

const EMPTY_SUGGESTED_PROMPTS: string[] = [];
const EMPTY_REFERENCES: StoredFileReference[] = [];

/**
 * Detects whether the last assistant message has a part that is actively
 * streaming output. Completed tool calls are excluded so the pending indicator
 * stays visible during quiet moments (e.g. server-side retries).
 */
const hasStreamingPart = (message: MastraDBMessage | undefined) => {
  if (!message) return false;
  const parts: MessageFactoryPart[] = message.content.parts;
  return parts.some(part => {
    if (part.type === 'reasoning' || part.type === 'text') {
      return 'state' in part && part.state === 'streaming';
    }
    if (part.type === 'tool-invocation') {
      return 'toolInvocation' in part && part.toolInvocation.state !== 'result';
    }
    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      const state = 'state' in part ? part.state : undefined;
      return state !== 'output-available' && state !== 'output-error';
    }
    return false;
  });
};

const ThreadRailLayer = ({ turns }: { turns: ThreadRailTurn[] }) => {
  if (turns.length === 0) return null;

  return (
    // Shown once the viewport fits the 48rem column plus a rail-safe gutter on each side.
    <div
      data-testid="thread-rail-layer"
      className="pointer-events-none absolute inset-y-0 left-4 z-20 hidden @min-[58rem]:block"
    >
      <ThreadRail turns={turns} className="pointer-events-auto sticky top-1/2 -translate-y-1/2" />
    </div>
  );
};

export interface ThreadProps {
  agentName?: string;
  agentId?: string;
  threadId?: string;
  suggestedPrompts?: string[];
  hasModelList?: boolean;
  hideModelSwitcher?: boolean;
  summaryOnly?: boolean;
  workspaceFiles?: boolean;
  /**
   * True while the thread history is being fetched for the first time. The skeleton
   * only replaces the welcome screen; live messages that arrive earlier take precedence.
   */
  isHistoryLoading?: boolean;
  onLoadPrevious?: () => void | Promise<void>;
  isLoadingPrevious?: boolean;
  landingHeader?: ReactNode;
  landingContent?: ReactNode;
  composerPlaceholder?: string;
}

const ThreadContent = ({
  agentName,
  agentId,
  threadId,
  suggestedPrompts,
  hasModelList,
  hideModelSwitcher,
  summaryOnly,
  workspaceFiles = false,
  isHistoryLoading,
  onLoadPrevious,
  isLoadingPrevious,
  landingHeader,
  landingContent,
  composerPlaceholder,
}: ThreadProps) => {
  useLocale();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const { draft, updateDraft } = useThreadInput(threadId);

  const messages = useChatMessages();
  const { isRunning } = useChatRunning();
  const fileChanges = useTurnFileChanges(threadId, workspaceFiles, isRunning);
  const [requestContext] = useEntityRequestContext('agent', agentId ?? '');
  const {
    isSpeaking,
    readAloud,
    stop: stopSpeaking,
  } = useReadAloud(agentId, requestContext, {
    onError: error => toast.error(error instanceof Error ? error.message : studioT('Voice generation failed.')),
  });

  const { hasSession, viewMode } = useBrowserSession();
  const showThumbnailInChat = hasSession && (viewMode === 'collapsed' || viewMode === 'expanded');

  const isEmpty = messages.length === 0;
  const lastMessage = messages[messages.length - 1];
  const showPending = isRunning && (lastMessage?.role !== 'assistant' || !hasStreamingPart(lastMessage));
  const threadRailTurns = useMemo(() => buildThreadRailTurns(messages), [messages]);
  const threadRailAnchorIds = useMemo(() => new Set(threadRailTurns.map(turn => turn.messageId)), [threadRailTurns]);
  // Keyed by the opening message's client key: `data-user-message` reconciliation
  // swaps `message.id` to the server signal id, and a changing key would remount
  // the whole turn.
  const turnGroups = groupTurns(messages, {
    key: getClientMessageKey,
    opensTurn: message => threadRailAnchorIds.has(message.id),
  });

  // Before the first message the dock is unpinned and centered so the greeting,
  // composer and prompts read as one landing. The composer keeps its tree position
  // in both modes so the first send doesn't remount it (focus and attachments stay).
  const showLanding = isEmpty && !isHistoryLoading;
  // The layout follows `showLanding` one commit late so leaving the landing can be
  // wrapped in a view transition: the named composer then glides to the dock
  // instead of snapping. Only the exit caused by a send is animated (the chat is
  // running then); a history load resolving on refresh or thread switch also flips
  // `showLanding` false and must snap, or the composer visibly slides on every load.
  const [landingShown, setLandingShown] = useState(showLanding);
  useEffect(() => {
    if (landingShown === showLanding) return;
    if (showLanding || !isRunning) {
      setLandingShown(showLanding);
      return;
    }
    startViewTransition(() => setLandingShown(false));
  }, [showLanding, landingShown, isRunning]);

  return (
    <ComposerAttachmentsProvider
      controlled={
        draft && updateDraft
          ? {
              value: draft.attachments,
              onChange: value =>
                updateDraft(previous => ({
                  ...previous,
                  attachments: typeof value === 'function' ? value(previous.attachments) : value,
                })),
            }
          : undefined
      }
    >
      <ChatShell
        className="h-full"
        scroller={{
          autoScroll: true,
          defaultScrollPosition: 'last-anchor',
          onReachStart: onLoadPrevious,
          preserveScrollOnPrepend: Boolean(onLoadPrevious),
        }}
        data-testid="thread-wrapper"
      >
        <ChatShell.Stage>
          <ChatShell.Viewport style={{ overflowAnchor: 'none' }}>
            <ThreadRailLayer turns={threadRailTurns} />
            <ChatShell.Content className={landingShown ? 'flex-none' : undefined}>
              {isLoadingPrevious && (
                <ChatShell.Column
                  data-testid="thread-history-older-skeleton"
                  aria-busy="true"
                  aria-label={studioT('Loading older messages')}
                  className="py-3"
                >
                  <ChatMessagesLoadingSkeleton />
                </ChatShell.Column>
              )}
              {isEmpty && isHistoryLoading ? (
                <ChatShell.Column data-testid="thread-history-skeleton" aria-busy="true" className="flex-1 py-4">
                  <ChatMessagesLoadingSkeleton />
                </ChatShell.Column>
              ) : landingShown ? null : (
                <ChatShell.Transcript
                  ref={messagesContainerRef}
                  data-testid="thread-message-column"
                  className="flex-1 gap-4 py-4"
                >
                  <BracketOverlay containerRef={messagesContainerRef} />
                  <TranscriptAnnotations />
                  {/* Everything already here when the reader arrived is theirs; what lands after fades in. */}
                  <ArrivalScope>
                    {turnGroups.map((group, index) => {
                      const isLiveTurn = index === turnGroups.length - 1;
                      const turnId = group.entries.find(entry => entry.role === 'user')?.id;
                      const changes = turnId ? fileChanges.data?.filter(change => change.turn === turnId) : undefined;
                      const firstAssistantIndex = group.entries.findIndex(entry => entry.role === 'assistant');
                      const lastAssistant = [...group.entries].reverse().find(entry => entry.role === 'assistant');
                      // The first turn opens at the top already; room under it would only add empty scroll.
                      const holdsRoom = isLiveTurn && isRunning && group.opensTurn && index > 0;
                      return (
                        <ChatShell.Turn
                          key={group.key}
                          opensTurn={group.opensTurn}
                          holdsRoom={holdsRoom}
                          className="gap-4"
                        >
                          <WorkDetails
                            messages={group.entries}
                            running={isLiveTurn && isRunning}
                            latest={isLiveTurn}
                            summaryOnly={summaryOnly}
                          >
                            {group.entries.map((message, messageIndex) => (
                              <Fragment key={getClientMessageKey(message)}>
                                {messageIndex === firstAssistantIndex && <WorkDetailsToggle />}
                                <MessageScrollerItem
                                  className="has-[[data-work-hidden]]:hidden"
                                  key={getClientMessageKey(message)}
                                  messageId={message.id}
                                  scrollAnchor={threadRailAnchorIds.has(message.id)}
                                >
                                  <MessageRow
                                    message={message}
                                    hasModelList={hasModelList}
                                    isSpeaking={isSpeaking}
                                    onReadAloud={readAloud}
                                    onStopSpeaking={stopSpeaking}
                                    footer={
                                      agentId &&
                                      threadId &&
                                      threadId !== 'new' &&
                                      message.role === 'assistant' &&
                                      message.id === lastAssistant?.id &&
                                      !(isLiveTurn && isRunning) ? (
                                        <BranchMessageAction
                                          agentId={agentId}
                                          threadId={threadId}
                                          messageId={message.id}
                                          messages={group.entries}
                                        />
                                      ) : undefined
                                    }
                                  />
                                </MessageScrollerItem>
                              </Fragment>
                            ))}
                            {isLiveTurn && showPending && (
                              <PendingIndicator className="animate-in delay-300 duration-200 fade-in-0 fill-mode-backwards" />
                            )}
                          </WorkDetails>
                          {threadId && changes?.length ? <TurnFileChanges thread={threadId} changes={changes} /> : null}
                        </ChatShell.Turn>
                      );
                    })}
                  </ArrivalScope>
                  {!isRunning && <SaveFullConversationAction />}
                </ChatShell.Transcript>
              )}
            </ChatShell.Content>
            <ChatShell.Dock
              data-testid={landingShown ? 'thread-landing' : undefined}
              className={
                landingShown
                  ? landingHeader
                    ? 'static flex flex-1 flex-col justify-start py-12 before:hidden'
                    : 'static flex flex-1 flex-col justify-center py-12 before:hidden'
                  : undefined
              }
            >
              {landingShown ? null : <ChatShell.ScrollButton />}
              <ChatShell.Column className={landingShown ? 'gap-6 px-1 md:px-1' : 'gap-2 px-1 md:px-1'}>
                {landingShown ? (
                  <>
                    {landingHeader ?? <ThreadWelcome />}
                    {!landingHeader && agentId ? <AgentChannelsCard agentId={agentId} /> : null}
                  </>
                ) : (
                  <>
                    {showThumbnailInChat && agentId && threadId && <BrowserThumbnail agentName={agentName} />}
                    <TaskPanel />
                  </>
                )}
                <div className={landingShown ? 'starter-prompt' : undefined}>
                  <AgentComposer
                    agentId={agentId}
                    threadId={threadId}
                    hasModelList={hasModelList}
                    hideModelSwitcher={hideModelSwitcher}
                    composerPlaceholder={composerPlaceholder}
                    workspaceFiles={workspaceFiles}
                  />
                </div>
                {!landingShown && <ConversationStats />}
                {landingShown
                  ? (landingContent ?? <SuggestedPromptList prompts={suggestedPrompts ?? EMPTY_SUGGESTED_PROMPTS} />)
                  : null}
              </ChatShell.Column>
            </ChatShell.Dock>
          </ChatShell.Viewport>
        </ChatShell.Stage>
      </ChatShell>
    </ComposerAttachmentsProvider>
  );
};

export const Thread = (props: ThreadProps) => {
  const annotation = useOptionalChatAnnotations();
  const messages = useChatMessages();
  const { isRunning } = useChatRunning();
  return (
    <ChatMetricsProvider messages={messages} running={isRunning} agentId={props.agentId} threadId={props.threadId}>
      {annotation ? (
        <ThreadContent {...props} />
      ) : (
        <ChatAnnotationsProvider>
          <ThreadContent {...props} />
        </ChatAnnotationsProvider>
      )}
    </ChatMetricsProvider>
  );
};

const ThreadWelcome = () => {
  useLocale();
  return (
    <div data-testid="thread-welcome" className="flex w-full flex-col items-center gap-4">
      <Txt
        as="h1"
        variant="display"
        tone="muted"
        className="starter-heading mx-auto max-w-2xl text-center font-normal text-balance"
      >
        {studioT('Your story, your choice.')}
      </Txt>
    </div>
  );
};

interface AgentComposerProps {
  agentId?: string;
  threadId?: string;
  hasModelList?: boolean;
  hideModelSwitcher?: boolean;
  composerPlaceholder?: string;
  workspaceFiles: boolean;
}

const AgentComposer = ({
  agentId,
  threadId,
  hasModelList,
  hideModelSwitcher,
  composerPlaceholder,
  workspaceFiles,
}: AgentComposerProps) => {
  useLocale();
  const { threadInput: text, setThreadInput, updateDraft, draft, draftStatus } = useThreadInput(threadId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const markdownFocus = useRef<(() => void) | undefined>(undefined);
  const setMarkdownFocus = useCallback((next: (() => void) | undefined) => {
    markdownFocus.current = next;
  }, []);
  const [cursor, setCursor] = useState(0);
  const [dismissedToken, setDismissedToken] = useState('');
  const [referenceIndex, setReferenceIndex] = useState(0);
  const refs = workspaceFiles ? (draft?.fileReferences ?? EMPTY_REFERENCES) : EMPTY_REFERENCES;
  const token = workspaceFiles && updateDraft ? referenceAt(text, cursor) : undefined;
  const tokenKey = token ? [token.start, token.query].join(':') : '';
  const showSuggestions = Boolean(token && tokenKey !== dismissedToken && refs.length < 20);
  const suggestions = useFileReferenceSuggestions(showSuggestions ? token?.query : undefined, workspaceFiles);
  const updateCursor = (position: number) => {
    setCursor(position);
    setDismissedToken('');
    setReferenceIndex(0);
  };
  const selectReference = (file: StoredFileReference) => {
    if (!token || !updateDraft) return;
    updateDraft(current => ({
      ...current,
      text: current.text === text ? text.slice(0, token.start) + text.slice(token.end) : current.text,
      fileReferences: current.fileReferences?.some(ref => ref.path === file.path)
        ? current.fileReferences
        : [...(current.fileReferences ?? []), { name: file.name, path: file.path }],
    }));
    setCursor(token.start);
    setDismissedToken(tokenKey);
    if (textareaRef.current) {
      textareaRef.current.focus();
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(token.start, token.start));
    } else markdownFocus.current?.();
  };
  const removeReference = (path: string) =>
    updateDraft?.(current => ({
      ...current,
      fileReferences: current.fileReferences?.filter(file => file.path !== path),
    }));
  const { annotations, takeAnnotations, restoreAnnotations } = useChatAnnotations();
  const preparing = useRef(false);
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );
  const [submitError, setSubmitError] = useState<string>();
  const send = useChatSend();
  const { preferences } = useChatPreferences();
  const { attachments, toCoreUserMessages, clear, restore, isAddingAttachments } = useComposerAttachments();
  const { isRunning, canSendWhileStreaming, cancelRun } = useChatRunning();
  const [sendPulseKey, setSendPulseKey] = useState(0);
  const { canExecute } = usePermissions();
  const canExecuteAgent = canExecute('agents');
  const inputDisabled = !canExecuteAgent || Boolean(draftStatus?.restoring);
  useComposerAutofocus(textareaRef, { threadId, disabled: inputDisabled || !preferences.plainText });

  const isEmpty = text.trim().length === 0 && attachments.length === 0 && annotations.length === 0 && refs.length === 0;
  const sendBlocked = isRunning && !canSendWhileStreaming;
  const showModelSwitcher = Boolean(agentId && !hasModelList && !hideModelSwitcher);
  const shownError = submitError || draftStatus?.error;
  const placeholder = canExecuteAgent
    ? (composerPlaceholder ?? studioT('Enter your message'))
    : studioT("You don't have permission to execute agents");

  const onComposerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (showSuggestions) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedToken(tokenKey);
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.files.length) {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setReferenceIndex(index => (index + delta + suggestions.files.length) % suggestions.files.length);
        return;
      }
      const file = suggestions.files[Math.min(referenceIndex, suggestions.files.length - 1)];
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && file) {
        event.preventDefault();
        event.stopPropagation();
        selectReference(file);
        return;
      }
    }
    if (event.key !== 'Enter' || event.altKey || sendBlocked) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (preferences.sendShortcut === 'enter' ? event.shiftKey : !modifier) return;
    event.preventDefault();
    event.stopPropagation();
    const opposite = preferences.sendShortcut === 'enter' ? modifier : event.shiftKey;
    void submit(opposite);
  };

  const submit = async (accelerated = false) => {
    const deliveryMode =
      isRunning && canSendWhileStreaming
        ? accelerated
          ? preferences.busyEnter === 'queue'
            ? 'steer'
            : 'queue'
          : preferences.busyEnter
        : undefined;
    if (
      isEmpty ||
      sendBlocked ||
      !canExecuteAgent ||
      draftStatus?.restoring ||
      isAddingAttachments ||
      preparing.current
    )
      return;
    preparing.current = true;
    const currentLifetime = lifetime.current;
    const submittedAttachments = attachments;
    const submittedPaths = new Set(refs.map(file => file.path));
    const submittedIds = new Set(submittedAttachments.map(attachment => attachment.id));
    // A message the server can't have stored goes back in the composer, before anything typed since.
    const withSubmittedText = (typed: string) => [text, typed].filter(Boolean).join('\n\n');
    const restoreSubmission = (sentAnnotations: readonly ChatAnnotation[]) => {
      if (lifetime.current !== currentLifetime) return;
      restoreAnnotations(sentAnnotations);
      if (updateDraft)
        updateDraft(previous => ({
          text: withSubmittedText(previous.text),
          attachments: [...submittedAttachments, ...previous.attachments],
          fileReferences: refs.length
            ? [...refs, ...(previous.fileReferences ?? []).filter(file => !submittedPaths.has(file.path))]
            : previous.fileReferences,
        }));
      else {
        setThreadInput(withSubmittedText);
        restore(submittedAttachments);
      }
      setSubmitError('Your message could not be sent. Your draft has been restored.');
    };
    setSubmitError(undefined);
    try {
      const coreUserMessages = attachments.length > 0 ? await toCoreUserMessages() : undefined;
      if (lifetime.current !== currentLifetime) return;
      // Clear only the submitted snapshot; edits made during file conversion belong to the next draft.
      if (updateDraft)
        updateDraft(previous => ({
          text: previous.text === text ? '' : previous.text,
          attachments: previous.attachments.filter(attachment => !submittedIds.has(attachment.id)),
          fileReferences: previous.fileReferences?.filter(file => !submittedPaths.has(file.path)),
        }));
      else {
        setThreadInput('');
        clear();
      }
      const sentAnnotations = takeAnnotations();
      setSendPulseKey(k => k + 1);
      const message = formatFileReferences(formatAnnotatedMessage(text, sentAnnotations), refs);
      void Promise.resolve(send({ message, attachments: coreUserMessages, deliveryMode })).then(delivered => {
        if (delivered === false) restoreSubmission(sentAnnotations);
      });
    } catch (error) {
      if (lifetime.current === currentLifetime)
        setSubmitError(
          error instanceof Error ? error.message : 'Attachments could not be prepared. Your draft has been kept.',
        );
    } finally {
      preparing.current = false;
    }
  };

  return (
    // Named so the chat/settings view transition can slide the composer toward
    // the bottom edge independently of the root crossfade.
    <div className="relative" style={{ viewTransitionName: 'agent-chat-composer' }}>
      {shownError && (
        <Txt variant="caption" role="alert">
          {shownError}
        </Txt>
      )}
      {draftStatus?.restoring && (
        <Txt variant="caption" role="status" className="sr-only">
          {studioT('Restoring draft…')}
        </Txt>
      )}
      <QueuedMessages />
      <ComposerFileDrop disabled={!canExecuteAgent || draftStatus?.restoring}>
        <Composer
          className="relative"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          {showSuggestions && !inputDisabled && (
            <FileReferenceSuggestions
              files={suggestions.files}
              index={referenceIndex}
              pending={suggestions.pending}
              onSelect={selectReference}
            />
          )}
          <ComposerRing busy={isRunning}>
            <ComposerBox sendingPulseKey={sendPulseKey}>
              <ComposerAnnotations showExcerpt={workspaceFiles} />
              <ChatComposerAttachments />
              <ComposerFileReferenceList files={refs} onRemove={removeReference} />
              {preferences.plainText ? (
                <ComposerInput
                  ref={textareaRef}
                  value={text}
                  placeholder={placeholder}
                  onChange={event => {
                    setThreadInput(event.target.value);
                    updateCursor(event.target.selectionEnd);
                  }}
                  onClick={event => updateCursor(event.currentTarget.selectionEnd)}
                  onKeyUp={event => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                      updateCursor(event.currentTarget.selectionEnd);
                  }}
                  onKeyDown={onComposerKeyDown}
                  disabled={inputDisabled}
                />
              ) : (
                <MarkdownComposerInput
                  value={text}
                  onChange={setThreadInput}
                  onCursorChange={updateCursor}
                  focusRef={setMarkdownFocus}
                  placeholder={placeholder}
                  disabled={inputDisabled}
                  threadId={threadId}
                  onKeyDown={onComposerKeyDown}
                />
              )}
              {showModelSwitcher && <ComposerModelWarning />}
              <ComposerActions>
                <ComposerActionRow
                  canExecute={canExecuteAgent}
                  agentId={agentId}
                  showModelSwitcher={showModelSwitcher}
                  isEmpty={isEmpty}
                  isRunning={isRunning}
                  canSendWhileStreaming={canSendWhileStreaming}
                  onCancel={() => void cancelRun()}
                  onSetText={value => {
                    setThreadInput(value);
                  }}
                />
              </ComposerActions>
            </ComposerBox>
          </ComposerRing>
        </Composer>
      </ComposerFileDrop>
    </div>
  );
};

const SpeechInput = ({ agentId, onTranscript }: { agentId?: string; onTranscript: (text: string) => void }) => {
  useLocale();
  const [requestContext] = useEntityRequestContext('agent', agentId ?? '');
  const { start, stop, isListening } = useSpeechRecognition({ agentId, requestContext });

  return (
    <Button
      variant="ghost"
      size="icon-md"
      type="button"
      tooltip={isListening ? studioT('Stop dictation') : studioT('Start dictation')}
      onClick={() => (isListening ? stop() : start(onTranscript))}
    >
      {isListening ? <CircleStopIcon /> : <IconMicrophone />}
    </Button>
  );
};

interface ComposerActionRowProps {
  canExecute?: boolean;
  agentId?: string;
  showModelSwitcher?: boolean;
  isEmpty: boolean;
  isRunning: boolean;
  canSendWhileStreaming: boolean;
  onCancel: () => void;
  onSetText: (text: string) => void;
}

const ComposerActionRow = ({
  canExecute = true,
  agentId,
  showModelSwitcher,
  isEmpty,
  isRunning,
  canSendWhileStreaming,
  onCancel,
  onSetText,
}: ComposerActionRowProps) => {
  return (
    <>
      <ComposerActionsStart>{canExecute && <AttachFileMenu />}</ComposerActionsStart>
      <ComposerActionsEnd>
        {showModelSwitcher && agentId && <ComposerModelSwitcher />}
        {canExecute && <SpeechInput agentId={agentId} onTranscript={onSetText} />}
        <ComposerSendButton
          canExecute={canExecute}
          isEmpty={isEmpty}
          isRunning={isRunning}
          canSendWhileStreaming={canSendWhileStreaming}
          onCancel={onCancel}
        />
      </ComposerActionsEnd>
    </>
  );
};

interface ComposerSendButtonProps {
  canExecute?: boolean;
  isEmpty: boolean;
  isRunning: boolean;
  canSendWhileStreaming: boolean;
  onCancel: () => void;
}

const ComposerSendButton = ({
  canExecute = true,
  isEmpty,
  isRunning,
  canSendWhileStreaming,
  onCancel,
}: ComposerSendButtonProps) => {
  useLocale();
  const { isAddingAttachments } = useComposerAttachments();
  const { preferences } = useChatPreferences();
  const busyLabel = preferences.busyEnter === 'queue' ? studioT('Queue message') : studioT('Steer agent');
  const draftCanSteerRun = canSendWhileStreaming && !isEmpty;
  if (isRunning && !draftCanSteerRun) {
    return (
      <Button
        variant="primary"
        size="icon-md"
        type="button"
        tooltip={studioT('Cancel')}
        onClick={event => {
          // Send turns into Cancel under the pointer: a double-click on Send must not cancel.
          if (event.detail > 1) return;
          onCancel();
        }}
      >
        <CircleStopIcon />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      variant="primary"
      size="icon-md"
      aria-label={canExecute ? (isRunning ? busyLabel : studioT('Send')) : studioT('No permission to execute')}
      disabled={!canExecute || isEmpty || isAddingAttachments}
    >
      <IconArrowUp />
    </Button>
  );
};

const CircleStopIcon = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={quietTextHover}
    >
      <circle cx="12" cy="12" r="10" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
    </svg>
  );
};
