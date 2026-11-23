import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconArrowLeft } from '@mastra/playground-ui/icons/central/IconArrowLeft';
import { IconChevronRightMedium } from '@mastra/playground-ui/icons/central/IconChevronRightMedium';
import { IconFolder1 } from '@mastra/playground-ui/icons/central/IconFolder1';
import { IconImages1 } from '@mastra/playground-ui/icons/central/IconImages1';
import { t, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SettingsWorkspace } from './settings-workspace';
import { useAccount } from '@/domains/account/account-context';
import { deleteStoredFile, downloadStoredFile, getStorage } from '@/domains/account/storage-api';
import type { StoredFile } from '@/domains/account/storage-api';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';

function formatStorageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
}

export function StorageSettingsPage() {
  useLocale();
  const target = useStudioConfig();
  const account = useAccount();
  const queryClient = useQueryClient();
  const queryKey = ['account-storage', target.baseUrl, account?.user.id];
  const storage = useQuery({
    queryKey,
    queryFn: () => getStorage(target),
    enabled: Boolean(target.baseUrl),
    refetchInterval: 30_000,
  });
  const [category, setCategory] = useState<'files' | 'images'>();
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const deletion = useMutation({
    mutationFn: (path: string) => deleteStoredFile(target, path),
    onSuccess: async () => {
      setConfirm(undefined);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const data = storage.data;
  const files = data?.files ?? [];
  const images = files.filter(file => file.mimeType.startsWith('image/'));
  const documents = files.filter(file => !file.mimeType.startsWith('image/'));
  const shown = (category === 'images' ? images : documents).filter(file =>
    file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const percent = data ? Math.min(100, (data.usedBytes / data.quotaBytes) * 100) : 0;
  const error = deletion.error?.message ?? downloadError;
  const download = async (file: StoredFile) => {
    setDownloadError(undefined);
    try {
      await downloadStoredFile(target, file);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : t('File storage is unavailable. Please retry.'));
    }
  };
  return (
    <SettingsWorkspace title={t('Storage')}>
      <section className="space-y-10">
        <Txt tone="muted">{t('See how much storage you are using and manage your files.')}</Txt>
        {storage.isPending ? (
          <Txt>{t('Loading...')}</Txt>
        ) : storage.isError ? (
          <div className="space-y-3">
            <Txt role="alert">{storage.error.message}</Txt>
            <Button onClick={() => void storage.refetch()}>{t('Retry')}</Button>
          </div>
        ) : (
          data && (
            <>
              <div className="space-y-4">
                <Txt className="font-medium tabular-nums">
                  {t('{used} used of {total}', {
                    used: formatStorageBytes(data.usedBytes),
                    total: formatStorageBytes(data.quotaBytes),
                  })}
                </Txt>
                <div
                  role="progressbar"
                  aria-label={t('Storage used')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                  className="h-3 overflow-hidden rounded-full bg-fill-active"
                >
                  <div className="h-full rounded-full bg-foreground" style={{ width: `${percent}%` }} />
                </div>
                {data.reservedBytes > 0 && (
                  <Txt tone="muted">{t('{size} uploading', { size: formatStorageBytes(data.reservedBytes) })}</Txt>
                )}
              </div>
              <div className="space-y-3">
                <Txt as="h2" variant="subheading">
                  {t('Manage storage')}
                </Txt>
                <Txt tone="muted">{t('Manage stored content to free up space.')}</Txt>
                <div className="divide-y divide-border border-y border-border">
                  {(
                    [
                      { id: 'files', label: t('Files'), list: documents, Icon: IconFolder1 },
                      { id: 'images', label: t('Images'), list: images, Icon: IconImages1 },
                    ] as const
                  ).map(group => (
                    <button
                      key={group.id}
                      onClick={() => {
                        setCategory(group.id);
                        setSearch('');
                        setConfirm(undefined);
                        deletion.reset();
                      }}
                      aria-expanded={category === group.id}
                      className="focus-visible:outline-ring flex w-full items-center gap-4 rounded-md px-1 py-5 text-left transition-colors hover:bg-fill-subtle focus-visible:outline focus-visible:outline-2"
                    >
                      <group.Icon className="size-5 shrink-0" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <Txt className="font-medium">{group.label}</Txt>
                        <Txt tone="muted" className="flex gap-2 tabular-nums">
                          <span>{formatStorageBytes(group.list.reduce((sum, file) => sum + file.size, 0))}</span>
                          <span>
                            {t(group.id === 'images' ? '{count} images' : '{count} files', {
                              count: group.list.length,
                            })}
                          </span>
                        </Txt>
                      </div>
                      <IconChevronRightMedium className="size-icon-sm" />
                    </button>
                  ))}
                </div>
              </div>
              {category && (
                <section
                  aria-label={category === 'images' ? t('Manage images') : t('Manage files')}
                  className="space-y-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setCategory(undefined)}>
                      <IconArrowLeft />
                      {t('Back')}
                    </Button>
                    <Txt as="h2" variant="subheading" className="flex-1">
                      {category === 'images' ? t('Images') : t('Files')}
                    </Txt>
                    <Input
                      aria-label={t('Search files')}
                      placeholder={t('Search files')}
                      value={search}
                      onChange={event => setSearch(event.target.value)}
                      className="w-full sm:w-64"
                    />
                  </div>
                  {error && <Txt role="alert">{error}</Txt>}
                  {shown.length === 0 ? (
                    <Txt tone="muted">{t('No files found.')}</Txt>
                  ) : (
                    <ul className="divide-y divide-border border-y border-border">
                      {shown.map(file => (
                        <li key={file.path} className="flex flex-wrap items-center gap-3 py-4">
                          <div className="min-w-0 flex-1">
                            <Txt className="font-medium break-all">{file.name}</Txt>
                            <Txt tone="muted" variant="body-sm" className="flex flex-wrap gap-x-3 gap-y-1">
                              <span>{formatStorageBytes(file.size)}</span>
                              <span>{file.source === 'upload' ? t('Uploaded') : t('Agent generated')}</span>
                              <span>{new Date(file.updatedAt).toLocaleDateString()}</span>
                            </Txt>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('Download {name}', { name: file.name })}
                            onClick={() => void download(file)}
                          >
                            {t('Download')}
                          </Button>
                          {confirm === file.path ? (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={deletion.isPending}
                                onClick={() => deletion.mutate(file.path)}
                              >
                                {t('Confirm delete')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={deletion.isPending}
                                onClick={() => setConfirm(undefined)}
                              >
                                {t('Cancel')}
                              </Button>
                            </div>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={deletion.isPending}
                              aria-label={t('Delete {name}', { name: file.name })}
                              onClick={() => {
                                setConfirm(file.path);
                                deletion.reset();
                              }}
                            >
                              {t('Delete')}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )
        )}
      </section>
    </SettingsWorkspace>
  );
}
