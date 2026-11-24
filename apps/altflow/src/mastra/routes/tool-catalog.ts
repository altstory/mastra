import type { Knowledge } from '@mastra/core/knowledge';
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { createWorkspaceTools, createSkillTools } from '@mastra/core/workspace';
import type { Workspace } from '@mastra/core/workspace';
import { standardSchemaToJSONSchema, toStandardSchema } from '@mastra/schema-compat/schema';
import type { HistoryMemory } from '../agents/history-memory';
import { AuthUpstreamError } from '../altflow-auth';
import type { createAltFlowAuth, AltFlowUser } from '../altflow-auth';

type CatalogTool = {
  id: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  requestContextSchema?: unknown;
};
function jsonSchema(schema: unknown, io: 'input' | 'output' = 'input') {
  if (!schema) return undefined;
  return standardSchemaToJSONSchema(toStandardSchema(schema as Parameters<typeof toStandardSchema>[0]), {
    io,
    target: 'draft-2020-12',
  });
}

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  status: 'available' | 'unconfigured' | 'conditional';
  reason?: string;
  agents: string[];
  runtime: boolean;
  inputSchema?: unknown;
  outputSchema?: unknown;
  requestContextSchema?: unknown;
}
export function toolCatalogRoute(options: {
  accounts: ReturnType<typeof createAltFlowAuth>;
  origins: string[];
  tools: Record<string, CatalogTool>;
  memory: HistoryMemory;
  knowledge: Knowledge;
  workspace: (user: AltFlowUser) => Promise<Workspace>;
  providerConfigured: boolean;
}) {
  return registerApiRoute('/altflow/tools/catalog', {
    method: 'GET',
    requiresAuth: false,
    handler: async c => {
      c.header('Cache-Control', 'no-store');
      const origin = c.req.header('origin');
      if (origin && !options.origins.includes(origin)) return c.json({ error: '不允许的请求来源' }, 403);
      let user: AltFlowUser | null;
      try {
        user = await options.accounts.authenticate(c.req.raw);
      } catch (error) {
        return c.json(
          {
            error: error instanceof AuthUpstreamError ? error.message : '认证服务不可用',
          },
          error instanceof AuthUpstreamError ? error.status : 503,
        );
      }
      if (!user) return c.json({ error: '请先登录' }, 401);
      const requestContext = new RequestContext();
      requestContext.setRaw(MASTRA_NORMALIZED_USER_KEY, user);
      requestContext.set(MASTRA_RESOURCE_ID_KEY, options.accounts.session(user).resourceId);
      const workspace = await options.workspace(user);
      const entries = new Map<string, CatalogEntry>();
      const collect = (tools: Record<string, CatalogTool>, source: string, runtime: boolean) => {
        for (const [name, tool] of Object.entries(tools)) {
          entries.set(tool.id, {
            id: tool.id,
            name,
            description: tool.description ?? '',
            source,
            status: 'available',
            agents: ['creator-agent'],
            runtime,
            inputSchema: jsonSchema(tool.inputSchema),
            outputSchema: jsonSchema(tool.outputSchema, 'output'),
            requestContextSchema: jsonSchema(tool.requestContextSchema),
          });
        }
      };
      collect(options.tools, 'Altflow', false);
      for (const entry of entries.values())
        if (!['countText', 'web_fetch', 'web_search'].includes(entry.name)) entry.runtime = true;
      collect(await createWorkspaceTools(workspace, { workspace, requestContext }), '工作区', true);
      collect(options.memory.listTools(), '记忆', true);
      if (user.role === 'admin') collect(options.knowledge.createTools(), '知识库', true);
      if (workspace.skills) collect(createSkillTools(workspace.skills), '技能', true);
      entries.set('workflow-textReview', {
        id: 'workflow-textReview',
        name: 'workflow-textReview',
        description: '文本篇幅检查工作流。',
        source: '工作流',
        status: 'available',
        agents: ['creator-agent'],
        runtime: true,
      });
      for (const entry of entries.values())
        if (entry.name.startsWith('team_task_')) {
          entry.source = '团队协作';
          entry.status = 'conditional';
          entry.reason = '开启智能体团队协作后可用';
        }
      if (!options.providerConfigured)
        entries.set('web_search', {
          id: 'web_search',
          name: 'web_search',
          description: '联网搜索并返回可引用的来源。',
          source: 'Altflow',
          status: 'unconfigured',
          reason: '服务端尚未配置搜索 provider 凭据',
          agents: ['creator-agent'],
          runtime: true,
        });
      return c.json({ entries: [...entries.values()] });
    },
  });
}
