import type { Processor } from '@mastra/core/processors';
import { MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import type { RequestContext } from '@mastra/core/request-context';
import type { Middleware } from '@mastra/core/server';
import type { AltFlowUser } from '../altflow-auth';
import { creatorGatewayContextKey } from '../creator-gateway-auth';

const privateReferenceTool = /^(?:knowledge_|skill(?:_|$))/;
const internalTool = /^(?:read_tool_result|recall|session_search|updateWorkingMemory|remember|forget_memory)$/;
const isInternalTool = (name: string) => privateReferenceTool.test(name) || internalTool.test(name);

export function creatorReferenceScopes({ scopes, user }: { scopes: string[]; user?: { id?: string } }) {
  return user?.id ? [...new Set([...scopes, 'library:creator'])] : scopes;
}

export function mayReadReferences(requestContext?: RequestContext) {
  if (requestContext?.getRaw(creatorGatewayContextKey)) return false;
  return (requestContext?.getRaw(MASTRA_NORMALIZED_USER_KEY) as AltFlowUser | undefined)?.role === 'admin';
}

export const isolateConversationReferences = {
  id: 'altflow-reference-read-policy',
  processInputStep({ tools, activeTools, requestContext }) {
    if (mayReadReferences(requestContext)) return;
    const product = Boolean(requestContext?.getRaw(creatorGatewayContextKey));
    const allowed = (name: string) =>
      (!name.startsWith('knowledge_') || /^(?:knowledge_list|knowledge_search|knowledge_read)$/.test(name)) &&
      (!product || !/^(?:recall|session_search)$/.test(name));
    return {
      tools: Object.fromEntries(Object.entries(tools ?? {}).filter(([name]) => allowed(name))),
      activeTools: activeTools?.filter(allowed),
    };
  },
} satisfies Processor;
const internalPart = /^(?:reasoning(?:-|$)|redacted-reasoning$|tool-call-delta$|raw$)/;
const internalFields = new Set([
  'reasoning',
  'reasoningText',
  'reasoningDetails',
  'request',
  'providerMetadata',
  'responseHeaders',
  'dshContext',
  'creatorOperationId',
]);

export function projectConversation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectConversation).filter(item => item !== undefined);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  const payload = record.payload as Record<string, unknown> | undefined;
  const invocation = record.toolInvocation as Record<string, unknown> | undefined;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const type = record.type;
  if (
    [type, record.tagName, payload?.tagName, metadata?.tagName].some(
      tag => tag === 'pinned-knowledge' || tag === 'pinned-knowledge-update',
    )
  )
    return undefined;
  if (
    typeof type === 'string' &&
    (internalPart.test(type) || (type.startsWith('tool-') && isInternalTool(type.slice(5))))
  )
    return undefined;
  if (
    [record.toolName, payload?.toolName, invocation?.toolName].some(
      name => typeof name === 'string' && isInternalTool(name),
    )
  )
    return undefined;

  return Object.fromEntries(
    Object.entries(record).flatMap(([key, child]) => {
      if (internalFields.has(key)) return [];
      if (key === 'skills' && Array.isArray(child)) return [[key, []]];
      if (key === 'response' && child && typeof child === 'object' && !Array.isArray(child)) {
        const { body: _body, headers: _headers, ...response } = child as Record<string, unknown>;
        return [[key, projectConversation(response)]];
      }
      if (key === 'tools' && Array.isArray(child)) {
        child = child.filter(tool => typeof tool?.name !== 'string' || !isInternalTool(tool.name));
      }
      const projected = projectConversation(child);
      return projected === undefined ? [] : [[key, projected]];
    }),
  );
}

function projectEventStream(body: ReadableStream<Uint8Array>) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (event === 'data: [DONE]' || event === ': connected' || event === ': heartbeat') {
            controller.enqueue(encoder.encode(event + '\n\n'));
          } else if (event.startsWith('data: ')) {
            const projected = projectConversation(JSON.parse(event.slice(6)));
            if (projected !== undefined) controller.enqueue(encoder.encode(`data: ${JSON.stringify(projected)}\n\n`));
          }
        }
      },
    }),
  );
}

export const protectConversationResponses: Middleware = async (c, next) => {
  await next();
  const user = c.get('requestContext')?.get('mastra__user') as AltFlowUser | undefined;
  if (
    !user ||
    (user.role === 'admin' && !c.get('requestContext')?.getRaw(creatorGatewayContextKey)) ||
    !c.res.ok ||
    !c.res.body
  )
    return;
  const path = c.req.path.replace(/^\/api(?=\/)/, '');
  const isAgentMetadata = c.req.method === 'GET' && /^\/agents(?:\/(?:creator-agent|creatorAgent))?$/.test(path);
  const isConversation =
    /^\/(?:agents\/[^/]+\/(?:generate|stream|stream-until-idle|threads\/subscribe)|memory\/(?:threads(?:\/.*)?|search|working-memory))$/.test(
      path,
    );
  if (!isAgentMetadata && !isConversation) return;
  const type = c.res.headers.get('content-type') ?? '';
  const headers = new Headers(c.res.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  if (type.includes('text/event-stream')) {
    c.res = new Response(projectEventStream(c.res.body), { status: c.res.status, headers });
  } else if (type.includes('application/json')) {
    const projected = projectConversation(await c.res.json());
    c.res = new Response(JSON.stringify(projected ?? null), { status: c.res.status, headers });
  }
};
