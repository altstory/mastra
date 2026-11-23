import type { Agent } from '@mastra/core/agent';
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import { projectConversation } from '../agents/reference-visibility';
import { AuthUpstreamError } from '../altflow-auth';
import type { createAltFlowAuth } from '../altflow-auth';
import type { Actor, SubagentRuntime } from '../subagents/runtime';
import { SubagentError } from '../subagents/runtime';

const address = z.object({
  root: z.string().min(1).max(500),
  child: z.string().min(1).max(500).optional(),
  page: z.coerce.number().int().min(0).max(10000).default(0),
});
const command = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('prompt'),
      prompt: z.string().trim().min(1).max(32000),
    })
    .strict(),
  z.object({ action: z.literal('interrupt') }).strict(),
]);
export function subagentRoutes(
  runtime: SubagentRuntime,
  accounts: ReturnType<typeof createAltFlowAuth>,
  origins: string[],
  getAgent: () => Agent,
  rootOptions?: (actor: Actor) => Promise<{ model?: string; reasoningLevel?: string }>,
) {
  return (['GET', 'POST'] as const).map(method =>
    registerApiRoute('/altflow/subagents', {
      method,
      requiresAuth: false,
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const user = await accounts.authenticate(c.req.raw);
          if (!user) return c.json({ error: '请先登录' }, 401);
          const origin = c.req.header('origin');
          if ((origin && !origins.includes(origin)) || (method !== 'GET' && !c.req.header('authorization') && !origin))
            return c.json({ error: '不允许的请求来源' }, 403);
          const input = address.parse({
            root: c.req.query('root'),
            child: c.req.query('child'),
            page: c.req.query('page'),
          });
          const context = new RequestContext();
          context.setRaw(MASTRA_NORMALIZED_USER_KEY, user);
          context.set(MASTRA_RESOURCE_ID_KEY, accounts.session(user).resourceId);
          const actor = await runtime.actor(context, input.root);
          // Viewing a saved tree may restore expired work using this freshly verified identity.
          const settings = await rootOptions?.(actor);
          await runtime.attach(actor, getAgent(), settings?.model, settings?.reasoningLevel);
          if (method === 'GET') {
            const snapshot = await runtime.snapshot(actor, input.child, input.page);
            return c.json((user.role === 'admin' ? snapshot : projectConversation(snapshot)) as typeof snapshot);
          }
          if (!input.child) return c.json({ error: '请选择子智能体' }, 400);
          const reader = c.req.raw.body?.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (reader)
            try {
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.length;
                if (size > 128 * 1024) {
                  await reader.cancel();
                  return c.json({ error: '消息过大' }, 413);
                }
                chunks.push(next.value);
              }
            } finally {
              reader.releaseLock();
            }
          const action = command.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (action.action === 'interrupt') return c.json(await runtime.interrupt(actor, input.child));
          return c.json(await runtime.promptChild(actor, input.child, action.prompt));
        } catch (error) {
          if (error instanceof AuthUpstreamError) return c.json({ error: error.message }, error.status);
          if (error instanceof SubagentError)
            return c.json({ error: error.message }, error.code === 'UNAUTHORIZED' ? 404 : 409);
          if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: '参数无效' }, 400);
          return c.json({ error: '子智能体服务暂不可用，请重试' }, 503);
        }
      },
    }),
  );
}
