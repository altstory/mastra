import { ChatFilePathsContext } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { useAccount } from '@/domains/account/account-context';
import { getStorage } from '@/domains/account/storage-api';
import type { StoredFileReference } from '@/domains/account/storage-api';
import { useStudioConfig } from '@/domains/configuration/context/studio-config-state';

export function referenceAt(text: string, cursor: number) {
  const match = /(?:^|\s)@([^\s@]{0,100})$/u.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : undefined;
}

export function formatFileReferences(text: string, files: readonly StoredFileReference[]) {
  if (!files.length) return text;
  const links = files.map(file => {
    const label = file.name.replace(/[\[\]\\]/g, '\\$&').replace(/[\r\n]/g, ' ');
    const path = encodeURIComponent(file.path).replace(/[()']/g, char => '%' + char.charCodeAt(0).toString(16));
    return '[@' + label + '](/storage/download?path=' + path + ')';
  });
  return [...links, text].filter(Boolean).join('\n\n');
}

export function useFileReferenceSuggestions(query: string | undefined, enabled: boolean) {
  const target = useStudioConfig();
  const account = useAccount();
  const currentFiles = useContext(ChatFilePathsContext);
  const storage = useQuery({
    queryKey: ['account-storage', target.baseUrl, account?.user.id, target.headers],
    queryFn: () => getStorage(target),
    enabled: Boolean(enabled && query !== undefined && account && target.baseUrl),
    staleTime: 10_000,
    retry: false,
  });
  return {
    files: (storage.data?.files ?? [])
      .filter(
        file =>
          currentFiles.includes(file.path) && file.name.toLocaleLowerCase().includes(query?.toLocaleLowerCase() ?? ''),
      )
      .slice(0, 8),
    pending: storage.isFetching,
  };
}
