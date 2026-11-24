import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { useMastraClient } from '@mastra/react';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { messageTraceId, projectRunMetrics } from './chat-metrics';
import type { RunMetrics } from './chat-metrics';
import { ChatMetricsContext } from './chat-metrics-context';

export function ChatMetricsProvider({
  messages,
  running,
  agentId,
  threadId,
  accountId,
  loadMetrics,
  children,
}: {
  messages: MastraDBMessage[];
  running: boolean;
  agentId?: string;
  threadId?: string;
  accountId?: string;
  loadMetrics?: (threadId: string, signal: AbortSignal) => Promise<{ metrics: RunMetrics[]; incomplete: boolean }>;
  children: ReactNode;
}) {
  const client = useMastraClient();
  const queryClient = useQueryClient();
  const owners = new Map<string, string>();
  for (const message of messages) {
    const id = messageTraceId(message);
    if (id && message.role === 'assistant') owners.set(id, message.id);
  }
  const liveTraceId = [...owners.keys()].at(-1);
  const scope = ['chat-run-metrics', client.options.baseUrl, client.options.apiPrefix];
  const historyKey = [...scope, 'history', agentId, threadId];
  const accountKey = [...scope, 'account', accountId, agentId, threadId];
  const hasThread = Boolean(agentId && threadId && threadId !== 'new');
  const live = useRef<{ id?: string; running: boolean; settleUntil: number }>({ running: false, settleUntil: 0 });
  const accountMetrics = useQuery({
    queryKey: accountKey,
    queryFn: hasThread && loadMetrics && threadId ? ({ signal }) => loadMetrics(threadId, signal) : skipToken,
    staleTime: 30_000,
    refetchInterval: () => (running || Date.now() < live.current.settleUntil ? 2_000 : false),
    retry: false,
  });
  const history = useQuery({
    queryKey: historyKey,
    enabled: hasThread && !loadMetrics,
    queryFn: async () => {
      const ids = new Set<string>();
      for (let page = 0; ; page++) {
        const result = await client.listTraces({
          filters: { threadId, entityId: agentId, entityType: 'agent' },
          pagination: { page, perPage: 100 },
          orderBy: { field: 'startedAt', direction: 'ASC' },
        });
        for (const span of result.spans) ids.add(span.traceId);
        if (!result.pagination?.hasMore || !result.spans.length) return [...ids];
      }
    },
    staleTime: 30_000,
    retry: false,
  });
  const traceIds = loadMetrics ? [] : [...new Set([...(history.data ?? []), ...owners.keys()])];
  useEffect(() => {
    const previous = live.current;
    if (running) live.current = { id: liveTraceId, running: true, settleUntil: 0 };
    else if (previous.running) {
      const id = liveTraceId ?? previous.id;
      live.current = { id, running: false, settleUntil: Date.now() + 15_000 };
      const key = ['chat-run-metrics', client.options.baseUrl, client.options.apiPrefix];
      if (loadMetrics) {
        void queryClient.invalidateQueries({
          queryKey: [...key, 'account', accountId, agentId, threadId],
          exact: true,
        });
        return;
      }
      if (id)
        void queryClient.invalidateQueries({
          queryKey: ['chat-run-metrics', client.options.baseUrl, client.options.apiPrefix, id],
          exact: true,
        });
      void queryClient.invalidateQueries({
        queryKey: ['chat-run-metrics', client.options.baseUrl, client.options.apiPrefix, 'history', agentId, threadId],
        exact: true,
      });
    }
  }, [running, liveTraceId, client, queryClient, agentId, threadId, loadMetrics, accountId]);
  const queries = useQueries({
    queries: traceIds.map(traceId => ({
      queryKey: [...scope, traceId],
      queryFn: async () => projectRunMetrics(await client.getTrace(traceId)),
      staleTime: 30_000,
      refetchInterval: () =>
        (running && traceId === liveTraceId) || (traceId === live.current.id && Date.now() < live.current.settleUntil)
          ? 2_000
          : false,
      retry: false,
    })),
  });
  const metrics = (loadMetrics ? (accountMetrics.data?.metrics ?? []) : queries.flatMap(query => query.data ?? []))
    .filter(run => run.startedAt !== undefined)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return (
    <ChatMetricsContext.Provider
      value={{
        metrics,
        owners,
        incomplete: loadMetrics
          ? accountMetrics.isError || accountMetrics.data?.incomplete === true
          : history.isError || queries.some(query => query.isError),
      }}
    >
      {children}
    </ChatMetricsContext.Provider>
  );
}
