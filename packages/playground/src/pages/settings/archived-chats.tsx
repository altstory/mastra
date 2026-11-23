import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { t, useLocale } from '@mastra/playground-ui/lib/i18n';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { ArchivedChatRow } from './archived-chat-row';
import { SettingsWorkspace } from './settings-workspace';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { useConversationProjects } from '@/domains/navigation/use-conversation-projects';
import { useConversationScope } from '@/domains/navigation/use-conversation-scope';
import { useSidebarThreads } from '@/domains/navigation/use-sidebar-threads';
import { isThreadArchived } from '@/domains/navigation/use-thread-archive';

export function ArchivedChatsSettingsPage() {
  useLocale();
  const { isLoading, hasPermission } = usePermissions();
  const scope = useConversationScope();
  const canRead = hasPermission('agents:read') && hasPermission('memory:read');
  return (
    <SettingsWorkspace title={t('Archived chats')}>
      <Txt tone="muted">{t('Restore archived chats or permanently delete them.')}</Txt>
      {isLoading ? (
        <Txt>{t('Loading...')}</Txt>
      ) : canRead ? (
        <ArchivedChatsList key={scope} scope={scope} />
      ) : (
        <Txt>{t('Permission Denied')}</Txt>
      )}
    </SettingsWorkspace>
  );
}

function ArchivedChatsList({ scope }: { scope: string }) {
  const { threads, isLoading, error, retry } = useSidebarThreads(scope);
  const organization = useConversationProjects(scope);
  const archived = threads.filter(isThreadArchived);
  return (
    <>
      {isLoading && <Txt>{t('Loading...')}</Txt>}
      {error && (
        <div className="space-y-3">
          <Txt role="alert">{t('Failed to load archived chats')}</Txt>
          <Button onClick={retry}>{t('Retry')}</Button>
        </div>
      )}
      {!isLoading && !error && archived.length === 0 && <Txt tone="muted">{t('No archived chats')}</Txt>}
      {archived.length > 0 && (
        <SettingsContainer role="list" aria-label={t('Archived chats')}>
          {archived.map(thread => (
            <ArchivedChatRow key={thread.id} thread={thread} organization={organization} />
          ))}
        </SettingsContainer>
      )}
    </>
  );
}
