import { EntityType, SpanType, projectRunMetrics } from '@mastra/core/observability';
import type { RunMetrics } from '@mastra/core/observability';
import { registerApiRoute } from '@mastra/core/server';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { AuthUpstreamError } from '../altflow-auth';
import type { createAltFlowAuth } from '../altflow-auth';
import { conversationModelRoutes } from '../model-policy';

function publicModelRoute(route: string | undefined) {
  return conversationModelRoutes.find(model => route === model || route === model.split('/')[1]);
}

export function conversationMetricsRoute(
  storage: MastraCompositeStore,
  accounts: ReturnType<typeof createAltFlowAuth>,
  origins: string[],
) {
  return registerApiRoute('/altflow/conversations/metrics', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      c.header('Cache-Control', 'no-store');
      const origin = c.req.header('origin');
      if (origin && !origins.includes(origin)) return c.json({ error: '不允许的请求来源' }, 403);
      try {
        const user = await accounts.authenticate(c.req.raw);
        if (!user) return c.json({ error: '请先登录' }, 401);
        const threadId = c.req.query('threadId');
        if (!threadId || threadId.length > 256) return c.json({ error: '无效的会话 ID' }, 400);
        const { resourceId } = accounts.session(user);
        const memory = await storage.getStore('memory');
        const traces = await storage.getStore('observability');
        if (!memory || !traces) return c.json({ error: '会话统计暂不可用' }, 503);
        const thread = await memory.getThreadById({ threadId, resourceId });
        if (thread?.resourceId !== resourceId) return c.json({ error: '会话不存在' }, 404);
        const metrics: Omit<RunMetrics, 'outcome'>[] = [];
        let incomplete = false;
        for (let page = 0; ; page++) {
          const listed = await traces.listTracesLight({
            filters: {
              threadId,
              resourceId,
              spanType: SpanType.AGENT_RUN,
              entityId: 'creator-agent',
              entityType: EntityType.AGENT,
            },
            pagination: { page, perPage: 20 },
            orderBy: { field: 'startedAt', direction: 'ASC' },
          });
          const runs = await Promise.all(
            listed.spans.map(async span => {
              if (span.threadId !== threadId || span.resourceId !== resourceId || span.entityId !== 'creator-agent')
                return null;
              const trace = await traces.getTrace({ traceId: span.traceId });
              if (!trace || !trace.spans.some(candidate => candidate.spanId === span.spanId)) return null;
              const { outcome: _outcome, models, context, ...run } = projectRunMetrics(trace);
              return {
                ...run,
                models: models.map(model => ({ ...model, route: publicModelRoute(model.route) })),
                context: context && { ...context, route: publicModelRoute(context.route) },
              };
            }),
          );
          for (const run of runs) {
            if (run) metrics.push(run);
            else incomplete = true;
          }
          if (!listed.pagination?.hasMore || !listed.spans.length) break;
        }
        return c.json({ metrics, incomplete });
      } catch (error) {
        if (error instanceof AuthUpstreamError) return c.json({ error: error.message }, error.status);
        return c.json({ error: '会话统计暂不可用' }, 503);
      }
    },
  });
}
