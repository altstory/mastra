import { ChatAnnotationsProvider } from '@mastra/playground-ui/components/ai/annotations';
import { Button } from '@mastra/playground-ui/components/Button';
import { ChatFilePathsContext, ChatOpenFileContext } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { useIsMobile } from '@mastra/playground-ui/hooks/use-is-mobile';
import { IconSidebarSimpleRightWide } from '@mastra/playground-ui/icons/central/IconSidebarSimpleRightWide';
import { t, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useQuery } from '@tanstack/react-query';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ConversationTree } from '../subagents/conversation-tree';
import { ConversationFilesPanel } from './conversation-files-panel';
import { useConversationFilePaths } from './use-conversation-file-paths';
import { useAccount } from '@/domains/account/account-context';
import { getStorage, storageUrl } from '@/domains/account/storage-api';
import { AgentLayout } from '@/domains/agents/components/agent-layout';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';

const viewSchema = z.object({
  open: z.boolean(),
  path: z.string().optional(),
  tabs: z.array(z.string()).max(12).default([]),
  version: z.literal(2).optional(),
  seenPaths: z.array(z.string()).default([]),
});

/** The parent keys this component by server, user, agent and conversation. */
export function ConversationWorkspace({
  agentId,
  threadId,
  requestContext,
  scope,
  children,
}: {
  agentId: string;
  scope: string;
  threadId?: string;
  requestContext?: Record<string, unknown>;
  children: ReactNode;
}) {
  useLocale();
  const target = useStudioConfig();
  const account = useAccount();
  const { paths: knownPaths } = useConversationFilePaths({ agentId, threadId, requestContext });
  const storage = useQuery({
    queryKey: ['account-storage', target.baseUrl, account?.user.id, target.headers],
    queryFn: () => getStorage(target),
    enabled: Boolean(target.baseUrl && knownPaths.length),
    refetchInterval: 10_000,
  });
  const signature = JSON.stringify(knownPaths);
  const previousSignature = useRef(signature);
  const { refetch } = storage;
  useEffect(() => {
    if (signature === previousSignature.current) return;
    previousSignature.current = signature;
    if (target.baseUrl && signature !== '[]') void refetch({ cancelRefetch: false });
  }, [refetch, signature, target.baseUrl]);
  const available = new Set(storage.data?.files.map(file => file.path));
  const paths = knownPaths.filter(path => available.has(path));
  const isMobile = useIsMobile();
  const storageKey = `altflow:conversation-files:${scope}`;
  const [view, setView] = useState(() => {
    try {
      const saved = viewSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
      if (saved.success) return { ...saved.data, open: saved.data.version === 2 && saved.data.open };
    } catch {
      /* Storage can be disabled in private browsing. */
    }
    return { open: false, path: undefined, seenPaths: [] as string[], tabs: [] as string[] };
  });
  const hasFiles = paths.length > 0 || view.tabs.length > 0 || Boolean(view.path);
  const open = hasFiles && (view.open || paths.some(path => !view.seenPaths.includes(path)));
  const update = (change: { open: boolean; path?: string; tabs?: string[] }) => {
    const next = {
      ...change,
      tabs: change.tabs ?? view.tabs,
      version: 2 as const,
      seenPaths: [...new Set([...view.seenPaths, ...paths])],
    };
    setView(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* In-memory state still works. */
    }
  };
  const tabs = view.path && !view.tabs.includes(view.path) ? [...view.tabs, view.path] : view.tabs;
  const openFile = (path: string) =>
    update({ open: true, path, tabs: tabs.includes(path) ? tabs : [...tabs.slice(-11), path] });
  const closeFile = (path: string) => {
    const remaining = tabs.filter(tab => tab !== path);
    update({ open: true, path: view.path === path ? remaining.at(-1) : view.path, tabs: remaining });
  };
  const openFileLink = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !target.baseUrl)
      return;
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.href);
    const endpoint = new URL(storageUrl(target, '/download'));
    // Accept both absolute runtime links and same-origin relative storage links.
    const storageOrigin = url.origin === endpoint.origin || url.origin === window.location.origin;
    if (!storageOrigin || url.pathname !== endpoint.pathname) return;
    const path = url.searchParams.get('path');
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    openFile(path);
  };
  return (
    <ChatAnnotationsProvider>
      <ChatOpenFileContext.Provider value={openFile}>
        <AgentLayout
          agentId={agentId}
          rightDrawerLabel={t('Files and artifacts')}
          rightSlot={
            hasFiles && (isMobile || open) ? (
              <ConversationFilesPanel
                agentId={agentId}
                threadId={threadId}
                requestContext={requestContext}
                selectedPath={view.path}
                openPaths={tabs}
                scope={scope}
                onSelect={path => (path ? openFile(path) : update({ open: true }))}
                onClose={closeFile}
              />
            ) : undefined
          }
        >
          <div className="flex h-full min-h-0 flex-col" onClickCapture={openFileLink}>
            <ChatFilePathsContext.Provider value={paths}>
              <ConversationTree
                root={threadId}
                isNew={!threadId}
                actions={
                  !isMobile &&
                  hasFiles && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Files and artifacts')}
                      aria-expanded={open}
                      onClick={() => update({ ...view, open: !open })}
                    >
                      <IconSidebarSimpleRightWide />
                    </Button>
                  )
                }
              >
                {children}
              </ConversationTree>
            </ChatFilePathsContext.Provider>
          </div>
        </AgentLayout>
      </ChatOpenFileContext.Provider>
    </ChatAnnotationsProvider>
  );
}
