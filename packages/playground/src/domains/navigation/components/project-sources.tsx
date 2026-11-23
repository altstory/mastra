import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { t } from '@mastra/playground-ui/lib/i18n';
import { useMastraClient } from '@mastra/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ConversationProject } from '../use-conversation-projects';
import { useConversationScope } from '../use-conversation-scope';
import { requestContextFor, useSidebarThreads } from '../use-sidebar-threads';
import { useAccount } from '@/domains/account/account-context';
import { getStorage } from '@/domains/account/storage-api';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';
import { loadConversationFilePaths } from '@/domains/conversation/files/conversation-file-paths';
import { ConversationFilePreview } from '@/domains/conversation/files/conversation-file-preview';
import { ConversationFileTree } from '@/domains/conversation/files/conversation-file-tree';

export function ProjectSources({ project }: { project: ConversationProject }) {
  const scope = useConversationScope();
  const history = useSidebarThreads(scope);
  const client = useMastraClient();
  const account = useAccount();
  const target = useStudioConfig();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [search, setSearch] = useState('');
  const sources = useQueries({
    queries: history.threads
      .filter(thread => project.threads.includes(thread.id))
      .map(thread => {
        const requestContext = requestContextFor(thread.agentId, scope);
        return {
          queryKey: [
            'conversation-file-paths',
            target.baseUrl,
            target.headers,
            account?.user.id,
            thread.agentId,
            thread.id,
            requestContext,
          ],
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            loadConversationFilePaths(client, thread.agentId, thread.id, requestContext, signal),
          staleTime: 60_000,
          retry: false,
        };
      }),
  });
  const storage = useQuery({
    queryKey: ['account-storage', target.baseUrl, account?.user.id, target.headers],
    queryFn: () => getStorage(target),
    enabled: Boolean(target.baseUrl) && project.threads.length > 0,
  });
  const paths = new Set(sources.flatMap(source => source.data ?? []));
  const files = (storage.data?.files ?? []).filter(file => paths.has(file.path));
  const shown = files.filter(file => file.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selected = files.find(file => file.path === selectedPath);
  const failed = history.error ?? storage.error ?? sources.find(source => source.error)?.error;
  if (failed)
    return (
      <div className="space-y-3 py-4">
        <Txt role="alert">{failed.message}</Txt>
        <Button
          size="sm"
          onClick={() => {
            history.retry();
            if (project.threads.length) void storage.refetch();
            sources.forEach(source => void source.refetch());
          }}
        >
          {t('Retry')}
        </Button>
      </div>
    );
  if (history.isLoading || sources.some(source => source.isPending) || (storage.isFetching && !storage.data))
    return (
      <Txt tone="muted" className="py-4">
        {t('Loading...')}
      </Txt>
    );
  if (selected)
    return (
      <ConversationFilePreview
        key={selected.path}
        file={selected}
        scope={JSON.stringify([scope, 'project', project.id])}
        onBack={() => setSelectedPath(undefined)}
      />
    );
  return (
    <div className="space-y-4 py-4">
      <Txt tone="muted">{t('Files attached or created in this project’s chats.')}</Txt>
      <Input
        type="search"
        aria-label={t('Search files')}
        placeholder={t('Search files')}
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      <ConversationFileTree files={shown} onSelect={setSelectedPath} />
      {!shown.length && (
        <Txt tone="muted" className="py-8 text-center">
          {t('No files found.')}
        </Txt>
      )}
    </div>
  );
}
