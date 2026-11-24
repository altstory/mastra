import { z } from 'zod';
import type { AccountSession } from './account-api';

// These are conversation preferences, not permission to replace an agent's configuration.
const memoryPreferences = z.object({
  lastMessages: z
    .union([z.literal(false), z.number().int().min(0).max(10000), z.literal(Number.MAX_SAFE_INTEGER)])
    .optional(),
  workingMemory: z.object({ enabled: z.boolean() }).optional(),
  observationalMemory: z.boolean().optional(),
  semanticRecall: z.literal(false).optional(),
});
const memoryBody = z.object({
  thread: z.union([z.string(), z.object({ id: z.string() })]).optional(),
  options: memoryPreferences.optional(),
});
const conversationPreferences = z.object({
  model: z
    .string()
    .regex(/^altflow\/[^/\s]+$/)
    .optional()
    .catch(undefined),
  memory: memoryBody.optional(),
  disableSubAgents: z.boolean().optional(),
  providerOptions: z
    .object({ altflow: z.object({ reasoningLevel: z.string().min(1).max(64) }) })
    .optional()
    .catch(undefined),
});
const chatBody = conversationPreferences.extend({
  messages: z.unknown(),
  runId: z.string().optional(),
});
const threadMessageBody = z.object({
  message: z.unknown(),
  threadId: z.string(),
  ifIdle: z.object({ streamOptions: conversationPreferences.optional() }).optional(),
});

// Studio defaults the memory resource to the agent id, but the server scopes every account to its own resource.
function bindResource(body: unknown, resource: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const bound: Record<string, unknown> = { ...body };
  if (isRecord(bound.memory)) bound.memory = { ...bound.memory, resource };
  if ('resourceId' in bound) bound.resourceId = resource;
  if (isRecord(bound.ifIdle) && isRecord(bound.ifIdle.streamOptions)) {
    bound.ifIdle = { ...bound.ifIdle, streamOptions: bindResource(bound.ifIdle.streamOptions, resource) };
  }
  return bound;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Studio normally sends editable run settings. Managed accounts use the preset
// assistant, so send conversation data and bounded preferences; the server independently rejects overrides.
export function createAccountFetch(account: AccountSession, apiPrefix = '/api'): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, { ...init, credentials: 'include' });
    const managed = account.user.role !== 'admin';
    const prefix = '/' + apiPrefix.split('/').filter(Boolean).join('/');
    const pathname = new URL(request.url).pathname;
    const route = prefix === '/' ? pathname : pathname.startsWith(prefix + '/') ? pathname.slice(prefix.length) : '';
    const chat = /^\/agents\/[^/]+\/(stream|generate|stream-until-idle)$/.test(route);
    const threadMessage = /^\/agents\/[^/]+\/(send-message|queue-message)$/.test(route);
    if ((!chat && !threadMessage) || request.method !== 'POST') return fetch(request);
    if (!managed) {
      const body = await request.clone().json();
      return fetch(new Request(request, { body: JSON.stringify(bindResource(body, account.resourceId)) }));
    }
    if (threadMessage) {
      const parsed = threadMessageBody.parse(await request.clone().json());
      const streamOptions = parsed.ifIdle?.streamOptions;
      const hasPreferences = streamOptions && Object.values(streamOptions).some(value => value !== undefined);
      const body = {
        message: parsed.message,
        threadId: parsed.threadId,
        resourceId: account.resourceId,
        ...(hasPreferences
          ? {
              ifIdle: {
                streamOptions: {
                  ...streamOptions,
                  ...(streamOptions.memory
                    ? {
                        memory: {
                          ...streamOptions.memory,
                          thread: parsed.threadId,
                          resource: account.resourceId,
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      };
      return fetch(new Request(request, { body: JSON.stringify(body) }));
    }
    const parsed = chatBody.parse(await request.clone().json());
    const body = { ...parsed, memory: parsed.memory ? { ...parsed.memory, resource: account.resourceId } : undefined };
    return fetch(new Request(request, { body: JSON.stringify(body) }));
  };
}
