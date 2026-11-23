import { MastraClientError } from '@mastra/client-js';
import { useMastraClient } from '@mastra/react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod/v4';

const statusSchema = z.object({ running: z.array(z.string()) });

export function useConversationStatus(scope: string, enabled = true) {
  const client = useMastraClient();
  return useQuery({
    queryKey: ['conversation-status', client.options.baseUrl, scope],
    queryFn: async ({ signal }) => {
      const fetcher = client.options.fetch ?? fetch;
      const response = await fetcher(`${client.options.baseUrl.replace(/\/$/, '')}/altflow/conversations/status`, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal,
        headers: client.options.headers,
      });
      // This projection is optional on standard Mastra deployments.
      if (response.status === 404) return null;
      if (!response.ok)
        throw new MastraClientError(response.status, response.statusText, 'Conversation status unavailable');
      return statusSchema.parse(await response.json());
    },
    refetchInterval: query => (query.state.data === null ? false : 1000),
    enabled,
    retry: false,
  });
}
