import { Button } from '@mastra/playground-ui/components/Button';
import { Tabs, Tab, TabList, TabContent } from '@mastra/playground-ui/components/Tabs';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconArrowRotateClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateClockwise';
import { t, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useQuery } from '@tanstack/react-query';
import { File, FileImage, FileSpreadsheet, FileText } from 'lucide-react';
import { ConversationFilePreview } from './conversation-file-preview';
import { ConversationFileTree } from './conversation-file-tree';
import { useConversationFilePaths } from './use-conversation-file-paths';
import { useAccount } from '@/domains/account/account-context';
import { getStorage } from '@/domains/account/storage-api';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';

export function ConversationFilesPanel({
  selectedPath,
  openPaths = [],
  scope,
  onClose,
  onSelect,
  agentId,
  threadId,
  requestContext,
}: {
  selectedPath?: string;
  openPaths?: string[];
  scope: string;
  onClose?: (path: string) => void;
  onSelect: (path: string | undefined) => void;
  agentId?: string;
  threadId?: string;
  requestContext?: Record<string, unknown>;
}) {
  useLocale();
  const target = useStudioConfig();
  const account = useAccount();
  const { history, paths } = useConversationFilePaths({ agentId, threadId, requestContext });
  const storage = useQuery({
    queryKey: ['conversation-storage', target.baseUrl, account?.user.id, target.headers, threadId],
    queryFn: () => getStorage(target, threadId),
    enabled: Boolean(target.baseUrl && threadId),
    refetchInterval: 10_000,
  });
  const files = (storage.data?.files ?? []).filter(
    file => paths.includes(file.path) || (file.storagePath !== undefined && paths.includes(file.storagePath)),
  );
  const tree = 'file-tree';
  const tabs = openPaths.length ? openPaths : selectedPath ? [selectedPath] : [];
  return (
    <aside aria-label={t('Files and artifacts')} className="bg-surface1 flex h-full min-h-0 flex-col">
      <div className="flex justify-end px-3 pt-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('Refresh files')}
          disabled={storage.isFetching}
          onClick={() => {
            void storage.refetch();
            if (threadId) void history.refetch();
          }}
        >
          <IconArrowRotateClockwise />
        </Button>
      </div>
      {(storage.isError && !storage.data) || (!selectedPath && history.isError && !history.data) ? (
        <div className="space-y-3 p-4">
          <Txt role="alert">{storage.error?.message ?? history.error?.message}</Txt>
          <Button
            size="sm"
            onClick={() => {
              void storage.refetch();
              if (threadId) void history.refetch();
            }}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : (storage.isLoading && target.baseUrl) || (!selectedPath && history.isFetching && !history.data) ? (
        <Txt tone="muted" className="p-4">
          {t('Loading...')}
        </Txt>
      ) : (
        <Tabs
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          defaultTab={tree}
          value={selectedPath ?? tree}
          onValueChange={path => onSelect(path === tree ? undefined : path)}
        >
          {tabs.length > 0 && (
            <TabList className="mx-3 shrink-0 gap-2">
              <Tab value={tree}>{t('Files')}</Tab>
              {tabs.map(path => {
                const file = files.find(item => item.path === path || item.storagePath === path);
                const name = file?.name ?? path.split('/').at(-1);
                const FileIcon = file?.mimeType.startsWith('image/')
                  ? FileImage
                  : /\.(xlsx?|ods|csv)$/i.test(name ?? '')
                    ? FileSpreadsheet
                    : /\.(pdf|md|txt|docx?)$/i.test(name ?? '')
                      ? FileText
                      : File;
                return (
                  <Tab key={path} value={path} onClose={() => onClose?.(path)} tooltip={name}>
                    <FileIcon size={14} aria-hidden="true" />
                    <span className="max-w-28 truncate">{name}</span>
                  </Tab>
                );
              })}
            </TabList>
          )}
          <TabContent value={tree} flush keepMounted className="min-h-0 flex-1 px-3 pb-4">
            {files.length ? (
              <ConversationFileTree files={files} onSelect={onSelect} />
            ) : (
              <Txt tone="muted" className="p-2">
                {t('No files found.')}
              </Txt>
            )}
          </TabContent>
          {tabs.map(path => {
            const file = storage.data?.files.find(item => item.path === path || item.storagePath === path);
            return (
              <TabContent
                key={path}
                value={path}
                flush
                keepMounted
                className="min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden"
              >
                {file ? (
                  <ConversationFilePreview file={file} scope={scope} onBack={() => onSelect(undefined)} />
                ) : (
                  <Txt tone="muted" className="p-4">
                    {t('This file is no longer available.')}
                  </Txt>
                )}
              </TabContent>
            );
          })}
        </Tabs>
      )}
    </aside>
  );
}
