import { registerApiRoute } from '@mastra/core/server';
import { z } from 'zod';
import type { createAltFlowAuth } from '../altflow-auth';
import { forgetMemorySchema, rememberSchema } from '../services/creative-memory';
import type { CreativeMemoryEntry, CreativeMemoryStore } from '../services/creative-memory';

const entryFields = {
  key: z.string().trim().min(1).max(100),
  revision: z.number().int().nonnegative(),
};
const saveSchema = z.strictObject({ ...entryFields, content: z.string().trim().min(1).max(600) });
const forgetSchema = z.strictObject(entryFields);

const SETTINGS_SOURCE = { threadId: 'settings', messageId: 'settings-ui' };
const MAX_BODY = 8 * 1024;

function visible(entry: CreativeMemoryEntry) {
  return {
    key: entry.key,
    revision: entry.revision,
    content: entry.content ?? '',
    updatedAt: entry.updatedAt,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt, expired: Date.parse(entry.expiresAt) <= Date.now() } : {}),
  };
}

/**
 * The settings panel edits the author's own preferences, the only kind a gateway conversation reads.
 * Project agreements and story facts stay out until conversations are bound to a trusted project.
 */
export function creatorMemoryRoutes({
  accounts,
  store,
}: {
  accounts: Pick<ReturnType<typeof createAltFlowAuth>, 'verifyCreatorGateway'>;
  store: CreativeMemoryStore;
}) {
  const route = (
    path: string,
    method: 'GET' | 'POST',
    handler: (input: { request: Request; owner: string }) => Promise<Response>,
  ) =>
    registerApiRoute('/creator-gateway/memory' + path, {
      method,
      requiresAuth: false,
      handler: async c => {
        const claims = await accounts.verifyCreatorGateway(c.req.raw);
        if (!claims) return c.json({ error: 'Creator gateway authentication required' }, 401);
        try {
          const response = await handler({ request: c.req.raw, owner: claims.userId });
          response.headers.set('Cache-Control', 'no-store');
          return response;
        } catch {
          return c.json({ error: 'Memory service unavailable' }, 503);
        }
      },
    });
  const body = async (request: Request) => {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  const conflict = () => Response.json({ error: 'Memory changed, reload and retry' }, { status: 409 });

  return [
    route('', 'GET', async ({ owner }) => {
      const entries = (await store.read(owner)).filter(
        entry => entry.kind === 'author_preference' && entry.status !== 'deleted',
      );
      return Response.json({ entries: entries.map(visible) });
    }),
    route('/save', 'POST', async ({ request, owner }) => {
      const input = saveSchema.safeParse(await body(request));
      if (!input.success) return Response.json({ error: 'Invalid memory entry' }, { status: 400 });
      const checked = rememberSchema.safeParse({
        kind: 'author_preference',
        status: 'confirmed',
        key: input.data.key,
        revision: input.data.revision,
        content: input.data.content,
        evidence: input.data.content,
      });
      if (!checked.success) return Response.json({ error: 'Invalid memory entry' }, { status: 400 });
      try {
        const saved = await store.write(owner, undefined, input.data.revision, {
          kind: 'author_preference',
          key: input.data.key,
          status: 'confirmed',
          content: input.data.content,
          source: { ...SETTINGS_SOURCE, quote: input.data.content },
        });
        return Response.json({ entry: visible(saved) });
      } catch {
        return conflict();
      }
    }),
    route('/forget', 'POST', async ({ request, owner }) => {
      const input = forgetSchema.safeParse(await body(request));
      if (!input.success) return Response.json({ error: 'Invalid memory entry' }, { status: 400 });
      const checked = forgetMemorySchema.safeParse({
        kind: 'author_preference',
        key: input.data.key,
        revision: input.data.revision,
        evidence: 'forget',
      });
      if (!checked.success) return Response.json({ error: 'Invalid memory entry' }, { status: 400 });
      try {
        await store.write(owner, undefined, input.data.revision, {
          kind: 'author_preference',
          key: input.data.key,
          status: 'deleted',
          source: { ...SETTINGS_SOURCE, quote: 'forget' },
        });
        return Response.json({ forgotten: true });
      } catch {
        return conflict();
      }
    }),
  ];
}
