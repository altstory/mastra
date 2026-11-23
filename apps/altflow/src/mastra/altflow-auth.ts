import { ALTFLOW_ACCOUNT_RESOURCE_KEY } from '@mastra/altflow-tools';
import { encodeKnowledgeScopeId } from '@mastra/core/knowledge';
import { MASTRA_RESOURCE_ID_KEY, MASTRA_SCOPES_KEY } from '@mastra/core/request-context';
import { defineAuth, registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';

const userSchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  email: z.string().nullable().optional(),
  role: z.enum(['admin', 'creator', 'user']),
});
export type AltFlowUser = z.infer<typeof userSchema>;
const envelope = z.object({ code: z.number(), message: z.unknown(), data: z.unknown() });
const loginResult = z.object({ token: z.string().min(16), expiresIn: z.number().positive(), user: userSchema });
const loginInput = z.object({ email: z.string().email(), password: z.string().min(1).max(1024) });
const tokenCookie = 'altflow_studio_token';
const instanceCookie = 'huying_login_instance';
export const creatorPermissions = ['agents:read', 'agents:execute', 'memory:read', 'memory:write', 'memory:delete'];
export const userPermissions = (user: AltFlowUser) => (user.role === 'admin' ? ['*'] : creatorPermissions);

export class AuthUpstreamError extends Error {
  constructor(
    public status: 401 | 403 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}
const cookieValue = (request: Request, name: string) =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(name + '='))
    ?.slice(name.length + 1);
function tokenFrom(request: Request) {
  const bearer = request.headers.get('authorization');
  return bearer?.match(/^Bearer\s+(.+)$/i)?.[1] ?? cookieValue(request, tokenCookie);
}
const forbiddenOverrides = new Set([
  'instructions',
  'system',
  'model',
  'modelSettings',
  'providerOptions',
  'apiKey',
  'baseURL',
  'tools',
  'toolsets',
  'toolChoice',
  'requireToolApproval',
  'activeTools',
  'workflows',
  'agents',
  'scopes',
  'memoryConfig',
  'inputProcessors',
  'outputProcessors',
  'agentConfig',
  'agentVersion',
  'agentVersionId',
  'versions',
  'clientTools',
  'clientToolsResolver',
  'maxSteps',
  'structuredOutput',
  'streamOptions',
  'workspace',
  'userPermissions',
  'userRoles',
]);
const conversationMemory = z
  .object({
    thread: z.union([z.string(), z.object({ id: z.string() }).strict()]).optional(),
    resource: z.string().optional(),
    options: z
      .object({
        // History is either disabled by the master switch or budgeted by DSH.
        lastMessages: z.union([z.literal(false), z.literal(Number.MAX_SAFE_INTEGER)]).optional(),
        workingMemory: z.object({ enabled: z.boolean() }).strict().optional(),
        observationalMemory: z.literal(false).optional(),
        semanticRecall: z.literal(false).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const reasoningOptions = z.strictObject({ altflow: z.strictObject({ reasoningLevel: z.string().min(1).max(64) }) });
const conversationStreamOptions = z
  .object({
    memory: conversationMemory.optional(),
    disableSubAgents: z.boolean().optional(),
  })
  .strict();
const messageStreamOptions = conversationStreamOptions.extend({ providerOptions: reasoningOptions.optional() });
function hasOverride(value: unknown, location?: 'direct' | 'message' | 'ifIdle'): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(child => hasOverride(child));
  return Object.entries(value).some(
    ([key, child]) =>
      key.startsWith('mastra__') ||
      (key === 'streamOptions'
        ? !(location === 'ifIdle' ? messageStreamOptions : conversationStreamOptions).safeParse(child).success
        : key === 'providerOptions' && location === 'direct'
          ? !reasoningOptions.safeParse(child).success
          : forbiddenOverrides.has(key)) ||
      (key === 'memory' && !conversationMemory.safeParse(child).success) ||
      (key === 'disableSubAgents' && typeof child !== 'boolean') ||
      ((key === 'requestContext' || key === 'ifIdle') &&
        hasOverride(child, key === 'ifIdle' && location === 'message' ? 'ifIdle' : undefined)),
  );
}
function permitted(user: AltFlowUser, path: string, method: string) {
  if (user.role === 'admin') return true;
  const route = path.replace(/^\/api(?=\/)/, '');
  if (/^\/account\/(session|sign-out)$/.test(route)) return true;
  if (
    method === 'GET' &&
    ['/agents', '/agents/providers', '/system/packages', '/system/features', '/system/status'].includes(route)
  )
    return true;
  if (/^\/memory(?:\/|$)/.test(route) && !route.startsWith('/memory/network/') && !route.endsWith('/transfer'))
    return true;
  if (method === 'GET' && /^\/agents\/(creator-agent|creatorAgent)$/.test(route)) return true;
  return (
    method === 'POST' &&
    /^\/agents\/(creator-agent|creatorAgent)\/(generate|stream|send-message|queue-message|stream-until-idle|threads\/(abort|subscribe|signals\/cancel|queue\/update)|runs\/[^/]+\/abort)$/.test(
      route,
    )
  );
}

export function createAltFlowAuth(options: {
  backendUrl: string;
  identityEndpoint?: 'me' | 'validate';
  origins: string[];
  secureCookies: boolean;
  legacyOwnerId?: string;
}) {
  const backend = new URL(options.backendUrl);
  if (!['http:', 'https:'].includes(backend.protocol) || backend.username || backend.password)
    throw new Error('Invalid AltFlow backend URL');
  if (backend.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname))
    throw new Error('Remote AltFlow authentication requires HTTPS');
  const resourceFor = (user: AltFlowUser) =>
    user.id === options.legacyOwnerId ? 'creator-agent' : `altflow:${user.id}`;
  async function upstream(path: string, request: Request, body?: unknown) {
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Locale': request.headers.get('x-locale') ?? 'zh-CN',
    });
    const token = tokenFrom(request);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const instance = cookieValue(request, instanceCookie);
    if (instance && /^li\.[A-Za-z0-9_-]{24,128}$/.test(instance))
      headers.set('Cookie', `${instanceCookie}=${instance}`);
    // Never forward caller-supplied proxy IPs, identity headers, or arbitrary URLs.
    let response: Response;
    try {
      response = await fetch(new URL(`/api/v1${path}`, backend), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new AuthUpstreamError(503, '本地 AltFlow 认证服务暂不可用');
    }
    const result = envelope.safeParse(await response.json().catch(() => undefined));
    if (!result.success) throw new AuthUpstreamError(503, 'AltFlow 认证服务响应无效');
    if (!response.ok || result.data.code !== 0) {
      // Go preserves legacy business errors inside HTTP 200 responses.
      const category = Math.floor(result.data.code / 100);
      const status =
        response.status === 401 || category === 401
          ? 401
          : response.status === 429 || category === 429
            ? 429
            : response.status >= 500 || result.data.code === 1 || category >= 500
              ? 503
              : 403;
      throw new AuthUpstreamError(status, typeof result.data.message === 'string' ? result.data.message : '认证失败');
    }
    return { data: result.data.data, headers: response.headers };
  }
  async function authenticate(request: Request): Promise<AltFlowUser | null> {
    if (!tokenFrom(request)) return null;
    try {
      const endpoint = options.identityEndpoint ?? 'validate';
      const result = await upstream(`/auth/${endpoint}`, request);
      const parsed =
        endpoint === 'me'
          ? userSchema.safeParse(result.data)
          : userSchema
              .extend({ userId: z.string().min(1), id: z.string().optional() })
              .transform(value => ({ ...value, id: value.userId }))
              .safeParse(result.data);
      if (!parsed.success) throw new AuthUpstreamError(403, '账号角色不支持访问 Studio');
      return parsed.data;
    } catch (error) {
      if (error instanceof AuthUpstreamError && error.status === 401) return null;
      throw error;
    }
  }
  const session = (user: AltFlowUser) => ({
    user: { id: user.id, name: user.username, email: user.email ?? undefined, role: user.role },
    permissions: userPermissions(user),
    resourceId: resourceFor(user),
  });
  const auth = defineAuth<AltFlowUser | null>({
    authenticateToken: async (_token, request) => {
      const raw = request instanceof Request ? request : request.raw;
      return raw ? authenticate(raw) : null;
    },
    mapUserToResourceId: user => (user ? resourceFor(user) : undefined),
    authorize: async (path, method, user, context) => {
      if (!user || !permitted(user, path, method)) return false;
      const request = context.req.raw;
      const origin = request.headers.get('origin');
      if (origin && !options.origins.includes(origin)) return false;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !request.headers.has('authorization') && !origin)
        return false;
      if (user.role !== 'admin' && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const body = await request
          .clone()
          .json()
          .catch(() => undefined);
        const admittingMessage = /\/(send-message|queue-message)$/.test(path);
        const directChat = /\/(generate|stream|stream-until-idle)$/.test(path);
        if (hasOverride(body, admittingMessage ? 'message' : directChat ? 'direct' : undefined)) return false;
        // Message admission must carry a thread so ownership is checked before targeting a run.
        if (admittingMessage && (!body || typeof body.threadId !== 'string' || body.runId !== undefined)) return false;
      }
      const requestContext = context.get('requestContext');
      requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceFor(user));
      requestContext.setRaw(ALTFLOW_ACCOUNT_RESOURCE_KEY, resourceFor(user));
      requestContext.set(MASTRA_SCOPES_KEY, [
        `resource:${resourceFor(user)}`,
        user.role === 'admin' ? 'library:creator' : 'audience:creators',
      ]);
      if (user.role === 'admin') {
        requestContext.set('mastra__knowledgePrincipals', [
          `resource:${encodeKnowledgeScopeId(resourceFor(user))}`,
          'library:creator',
        ]);
      }
      requestContext.set('mastra__userPermissions', userPermissions(user));
      return true;
    },
  });
  const publicRoute = { requiresAuth: false };
  const apiRoutes = [
    registerApiRoute('/account/session', {
      method: 'GET',
      ...publicRoute,
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const user = await authenticate(c.req.raw);
          return user ? c.json(session(user)) : c.json({ error: '请先登录' }, 401);
        } catch (error) {
          return c.json(
            { error: error instanceof AuthUpstreamError ? error.message : '认证服务不可用' },
            error instanceof AuthUpstreamError ? error.status : 503,
          );
        }
      },
    }),
    registerApiRoute('/account/sign-in', {
      method: 'POST',
      ...publicRoute,
      handler: async c => {
        c.header('Cache-Control', 'no-store');
        if (!options.origins.includes(c.req.header('origin') ?? '')) return c.json({ error: '不允许的登录来源' }, 403);
        const input = loginInput.safeParse(await c.req.json().catch(() => undefined));
        if (!input.success) return c.json({ error: '请输入有效的邮箱和密码' }, 400);
        try {
          const result = await upstream('/auth/login', c.req.raw, input.data);
          const parsed = loginResult.safeParse(result.data);
          if (!parsed.success) throw new AuthUpstreamError(503, '登录响应无效');
          const attributes = `Path=/; HttpOnly; SameSite=Lax${options.secureCookies ? '; Secure' : ''}`;
          c.header(
            'Set-Cookie',
            `${tokenCookie}=${parsed.data.token}; ${attributes}; Max-Age=${Math.floor(parsed.data.expiresIn)}`,
            { append: true },
          );
          // Keep Go's login-instance cookie, but apply this app's explicit security policy.
          const returnedInstance = result.headers
            .getSetCookie()
            .map(value => value.split(';')[0])
            .find(value => value.startsWith(instanceCookie + '='));
          if (returnedInstance)
            c.header('Set-Cookie', `${returnedInstance}; ${attributes}; Max-Age=31536000`, { append: true });
          return c.json(session(parsed.data.user));
        } catch (error) {
          return c.json(
            { error: error instanceof AuthUpstreamError ? error.message : '登录失败' },
            error instanceof AuthUpstreamError ? error.status : 503,
          );
        }
      },
    }),
    registerApiRoute('/account/sign-out', {
      method: 'POST',
      ...publicRoute,
      handler: async c => {
        if (!options.origins.includes(c.req.header('origin') ?? '')) return c.json({ error: '不允许的退出来源' }, 403);
        try {
          if (tokenFrom(c.req.raw)) await upstream('/auth/logout', c.req.raw, {});
          c.header(
            'Set-Cookie',
            `${tokenCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.secureCookies ? '; Secure' : ''}`,
          );
          return c.json({ ok: true });
        } catch (error) {
          return c.json(
            { error: error instanceof AuthUpstreamError ? error.message : '退出失败，请重试' },
            error instanceof AuthUpstreamError ? error.status : 503,
          );
        }
      },
    }),
  ];
  return { auth, apiRoutes, authenticate, session };
}
