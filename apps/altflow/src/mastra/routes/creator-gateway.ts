import { createHash, randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { createSignal, type Agent } from '@mastra/core/agent';
import {
  MASTRA_NORMALIZED_USER_KEY,
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_SCOPES_KEY,
  RequestContext,
} from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { ALTFLOW_ACCOUNT_RESOURCE_KEY } from '@mastra/altflow-tools';
import { z } from 'zod';
import type { createAltFlowAuth } from '../altflow-auth';
import { creatorGatewayContextKey, creatorResourceId, creatorThreadId } from '../creator-gateway-auth';
import type { ModelHubGateway } from '../modelhub-gateway';
import { createCreatorMeter, creatorMeterContext, creatorProductModels, creatorUsage } from '../creator-meter';
import { defaultConversationModel } from '../model-policy';
import type { ConversationFiles } from '../services/conversation-files';
import { FileStorageError } from '../user-storage';

const attachmentId = z.string().regex(/^[a-f0-9]{64}$/);
const nativeImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const messageSchema = z
  .strictObject({
    resourceId: z.string(),
    threadId: z.string(),
    message: z.strictObject({
      contents: z.string().trim().max(20_000),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    ifIdle: z.strictObject({
      streamOptions: z.strictObject({
        model: z.string(),
        providerOptions: z.strictObject({
          altflow: z.strictObject({ reasoningLevel: z.string(), catalogVersion: z.string() }),
        }),
      }),
    }),
    attachment: attachmentId.optional(),
    attachments: z.array(attachmentId).max(8).optional(),
  })
  .refine(({ message, attachment, attachments }) => {
    const ids = [...(attachment ? [attachment] : []), ...(attachments ?? [])];
    return ids.length <= 8 && new Set(ids).size === ids.length && Boolean(message.contents || ids.length);
  });

export async function creatorGatewayRoutes({
  accounts,
  agent,
  db,
  catalog,
  files,
}: {
  accounts: ReturnType<typeof createAltFlowAuth>;
  agent: Agent;
  db: Client;
  catalog: ModelHubGateway;
  files: ConversationFiles;
}) {
  await db.execute(`CREATE TABLE IF NOT EXISTS creator_gateway_receipts (
    id TEXT PRIMARY KEY, thread TEXT NOT NULL, resource TEXT NOT NULL,
    state TEXT NOT NULL, run_id TEXT, receipt TEXT, boot_id TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT NOT NULL, request_hash TEXT NOT NULL, updated_ms INTEGER NOT NULL
  )`);

  await createCreatorMeter(db);
  await db.execute(`CREATE TABLE IF NOT EXISTS creator_gateway_approvals (
    operation_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, answer_hash TEXT NOT NULL,
    receipt TEXT, PRIMARY KEY(operation_id, tool_call_id)
  )`);
  const bootId = randomUUID();
  const outputWatchers = new Map<string, symbol>();
  const scopedContext = (
    claims: NonNullable<Awaited<ReturnType<typeof accounts.verifyCreatorGateway>>>,
    resource: string,
  ) => {
    const context = new RequestContext();
    context.setRaw(creatorGatewayContextKey, claims);
    context.setRaw(MASTRA_NORMALIZED_USER_KEY, { id: claims.userId, username: claims.username, role: claims.role });
    context.setRaw(ALTFLOW_ACCOUNT_RESOURCE_KEY, resource);
    context.set(MASTRA_RESOURCE_ID_KEY, resource);
    context.set(MASTRA_SCOPES_KEY, [`resource:${resource}`]);
    context.set('mastra__userPermissions', ['agents:execute', 'memory:read', 'memory:write']);
    return context;
  };
  const lookup = async (id: string, thread: string, resource: string) =>
    (
      await db.execute({
        sql: 'SELECT * FROM creator_gateway_receipts WHERE id=? AND thread=? AND resource=?',
        args: [id, thread, resource],
      })
    ).rows[0];
  const setState = (id: string, state: string) =>
    db.execute({
      sql: 'UPDATE creator_gateway_receipts SET state=?,updated_ms=? WHERE id=?',
      args: [state, Date.now(), id],
    });

  const watchOutput = (id: string, finishReason: PromiseLike<string | undefined>) => {
    const watcher = Symbol();
    outputWatchers.set(id, watcher);
    void Promise.resolve(finishReason)
      .then(reason => {
        if (reason === 'suspended' || outputWatchers.get(id) !== watcher) return;
        return setState(
          id,
          reason === 'aborted'
            ? 'cancelled'
            : !reason || reason === 'error' || reason === 'tripwire'
              ? 'interrupted'
              : 'completed',
        );
      })
      .catch(() => {
        if (outputWatchers.get(id) === watcher) return setState(id, 'interrupted');
      })
      .catch(() => {})
      .finally(() => {
        if (outputWatchers.get(id) === watcher) outputWatchers.delete(id);
      });
  };

  const route = (
    path: string,
    method: 'GET' | 'POST',
    handler: (input: {
      request: Request;
      claims: NonNullable<Awaited<ReturnType<typeof accounts.verifyCreatorGateway>>>;
      thread: string;
      resource: string;
    }) => Promise<Response>,
  ) =>
    registerApiRoute('/creator-gateway/' + path, {
      method,
      requiresAuth: false,
      handler: async c => {
        const request = c.req.raw;
        const claims = await accounts.verifyCreatorGateway(request);
        if (!claims) return c.json({ error: 'Creator gateway authentication required' }, 401);
        const resource = creatorResourceId(claims.userId);
        try {
          const response = await handler({ request, claims, thread: creatorThreadId(claims.conversationId), resource });
          response.headers.set('Cache-Control', 'no-store');
          return response;
        } catch (error) {
          if (error instanceof FileStorageError)
            return c.json({ error: 'File unavailable', ...(error.code ? { code: error.code } : {}) }, error.status);
          return c.json({ error: 'Creator service unavailable' }, 503);
        }
      },
    });
  const fileId = (path: string, version: string) =>
    createHash('sha256')
      .update(JSON.stringify([path, version]))
      .digest('hex');

  return [
    route('catalog', 'GET', async () => {
      const snapshot = await catalog.catalog();
      const models = snapshot.free_chat_models.filter(model => creatorProductModels.has(model.id));
      const defaultModelId =
        models.find(model => 'altflow/' + model.id === defaultConversationModel)?.id ?? models[0]?.id;
      if (!defaultModelId) return Response.json({ error: 'Creator model catalog unavailable' }, { status: 503 });
      return Response.json({
        configVersion: String(snapshot.config_version),
        defaultModelId: 'altflow/' + defaultModelId,
        models: models.map(model => ({
          id: 'altflow/' + model.id,
          displayName: model.display_name,
          defaultThinkingLevel: model.default_thinking_level,
          thinkingOptions: model.thinking_options.map(option => ({ level: option.level, label: option.level })),
        })),
      });
    }),
    route('thread', 'POST', async ({ claims, resource, thread }) => {
      const memory = await agent.getMemory({ requestContext: scopedContext(claims, resource) });
      if (!memory) return Response.json({ error: 'Thread memory unavailable' }, { status: 503 });
      const existing = await memory.getThreadById({ threadId: thread });
      if (existing && existing.resourceId !== resource)
        return Response.json({ error: 'Thread unavailable' }, { status: 404 });
      if (!existing) {
        try {
          await memory.createThread({
            threadId: thread,
            resourceId: resource,
            metadata: { creatorProjectId: claims.projectId },
          });
        } catch (error) {
          if ((await memory.getThreadById({ threadId: thread }))?.resourceId !== resource) throw error;
        }
      }
      return Response.json({
        agentId: 'creator-agent',
        threadId: thread,
        resourceId: resource,
        title: existing?.title,
      });
    }),
    route('files', 'GET', async ({ claims, thread }) => {
      const entries = await files.run({ owner: claims.userId, root: thread }, () => files.list(claims.userId));
      return Response.json(
        entries.map(file => ({
          id: fileId(file.path, String(file.updatedAt)),
          name: file.path.split('/').at(-1),
          size: file.size,
        })),
      );
    }),
    route('file', 'GET', async ({ request, claims, thread }) => {
      const id = new URL(request.url).searchParams.get('id');
      if (!id) return new Response(null, { status: 400 });
      return files.run({ owner: claims.userId, root: thread }, async () => {
        const entry = (await files.list(claims.userId)).find(file => fileId(file.path, String(file.updatedAt)) === id);
        if (!entry) return new Response(null, { status: 404 });
        const data = await files.read(claims.userId, entry.path);
        return new Response(new Uint8Array(data), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      });
    }),
    route('file', 'POST', async ({ request, claims, thread }) => {
      const upload = z
        .strictObject({
          name: z
            .string()
            .min(1)
            .max(240)
            .regex(/^[^/\\\u0000-\u001f]+$/),
          id: z.uuid(),
        })
        .safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!upload.success) return new Response(null, { status: 400 });
      const { name, id } = upload.data;
      if (name === '.' || name === '..') return new Response(null, { status: 400 });
      const path = '/uploads/' + id + '/' + name;
      const data = Buffer.from(await request.arrayBuffer());
      if (data.length > 20 * 1024 * 1024) return new Response(null, { status: 413 });
      return files.run({ owner: claims.userId, root: thread }, async () => {
        let stored;
        try {
          stored = await files.write(claims.userId, path, data, { source: 'upload', overwrite: false });
        } catch (error) {
          if (!(error instanceof FileStorageError) || error.status !== 409) throw error;
          const previous = await files.read(claims.userId, path);
          if (!previous.equals(data)) return new Response(null, { status: 409 });
          stored = await files.info(claims.userId, path);
        }
        return Response.json({ id: fileId(stored.path, String(stored.updatedAt)), name });
      });
    }),
    route('operation', 'GET', async ({ claims, thread, resource }) => {
      if (!claims.operationId) return new Response(null, { status: 400 });
      const row = await lookup(claims.operationId, thread, resource);
      if (!row) return new Response(null, { status: 404 });
      let state = String(row.state);
      if (state === 'dispatching' && row.boot_id !== bootId) {
        state = 'interrupted';
        await setState(claims.operationId, state);
      }
      if (
        state === 'accepted' &&
        !outputWatchers.has(claims.operationId) &&
        Number(row.updated_ms) < Date.now() - 5000
      ) {
        const running = agent.getActiveThreadRunId({ threadId: thread, resourceId: resource });
        const { runs } = await agent.listSuspendedRuns({ threadId: thread, resourceId: resource });
        if (running !== row.run_id && !runs.some(run => run.runId === row.run_id)) {
          state = 'interrupted';
          await setState(claims.operationId, state);
        }
      }
      const title =
        state === 'completed'
          ? await (async () => {
              const memory = await agent.getMemory({ requestContext: scopedContext(claims, resource) });
              const stored = await memory?.getThreadById({ threadId: thread });
              return stored?.resourceId === resource ? stored.title : undefined;
            })().catch(() => undefined)
          : undefined;
      return Response.json({
        state,
        title,
        receipt: row.receipt ? JSON.parse(String(row.receipt)) : null,
        usages: ['completed', 'cancelled', 'interrupted'].includes(state)
          ? await creatorUsage(db, claims.operationId)
          : null,
      });
    }),
    route('approval', 'POST', async ({ request, claims, thread, resource }) => {
      const { operationId, tokenBudget } = claims;
      const parsed = z
        .strictObject({
          threadId: z.literal(thread),
          resourceId: z.literal(resource),
          toolCallId: z.string().min(1).max(256),
          approved: z.boolean(),
          resumeData: z.unknown().optional(),
        })
        .safeParse(await request.json());
      if (!operationId || !tokenBudget || !parsed.success) return new Response(null, { status: 400 });
      const row = await lookup(operationId, thread, resource);
      if (!row?.run_id) return new Response(null, { status: 409 });
      const { toolCallId, approved, resumeData } = parsed.data;
      const digest = createHash('sha256')
        .update(JSON.stringify([approved, resumeData]))
        .digest('hex');
      const prior = (
        await db.execute({
          sql: 'SELECT answer_hash,receipt FROM creator_gateway_approvals WHERE operation_id=? AND tool_call_id=?',
          args: [operationId, toolCallId],
        })
      ).rows[0];
      if (prior?.receipt && prior.answer_hash === digest) return Response.json(JSON.parse(String(prior.receipt)));
      if (prior || row.state !== 'accepted') return new Response(null, { status: 409 });
      const runId = String(row.run_id);
      const { runs } = await agent.listSuspendedRuns({ threadId: thread, resourceId: resource });
      const tool = runs.find(run => run.runId === runId)?.toolCalls.find(item => item.toolCallId === toolCallId);
      if (!tool || !['ask_user', 'submit_plan'].includes(tool.toolName ?? ''))
        return new Response(null, { status: 409 });
      let answer = resumeData;
      if (tool.toolName === 'ask_user') {
        const prompt = z
          .object({
            options: z.array(z.object({ label: z.string() })).optional(),
            selectionMode: z.enum(['single_select', 'multi_select']).optional(),
          })
          .safeParse(tool.suspendPayload);
        if (!prompt.success || !approved) return new Response(null, { status: 400 });
        const options = prompt.data.options?.map(item => item.label) ?? [];
        const valid =
          typeof answer === 'string'
            ? answer.trim().length > 0 && answer.length <= 4000
            : prompt.data.selectionMode === 'multi_select' &&
              Array.isArray(answer) &&
              answer.length > 0 &&
              new Set(answer).size === answer.length &&
              answer.every(item => options.includes(item));
        if (typeof answer === 'string') answer = answer.trim();
        if (!valid) return new Response(null, { status: 422 });
      } else {
        if (resumeData !== undefined) return new Response(null, { status: 400 });
        answer = { action: approved ? 'approved' : 'rejected' };
      }
      const claim = await db.execute({
        sql: 'INSERT OR IGNORE INTO creator_gateway_approvals (operation_id,tool_call_id,answer_hash) VALUES (?,?,?)',
        args: [operationId, toolCallId, digest],
      });
      if (claim.rowsAffected !== 1) return new Response(null, { status: 409 });
      const requestContext = scopedContext(claims, resource);
      const output = await creatorMeterContext
        .run({ db, operationId, tokenBudget }, () =>
          agent.resumeStream(answer, {
            runId,
            toolCallId,
            memory: { thread: thread, resource },
            requestContext,
            model: String(row.model) as `altflow/${string}`,
            providerOptions: { altflow: { reasoningLevel: String(row.reasoning), creatorMeterRequired: true } },
          }),
        )
        .catch(async error => {
          const { runs } = await agent.listSuspendedRuns({ threadId: thread, resourceId: resource });
          const stillPending = runs
            .find(run => run.runId === runId)
            ?.toolCalls.some(call => call.toolCallId === toolCallId);
          if (stillPending) {
            await db.execute({
              sql: 'DELETE FROM creator_gateway_approvals WHERE operation_id=? AND tool_call_id=? AND answer_hash=? AND receipt IS NULL',
              args: [operationId, toolCallId, digest],
            });
          }
          throw error;
        });
      watchOutput(operationId, output.finishReason);
      const result = { accepted: true, runId, toolCallId };
      await db.execute({
        sql: 'UPDATE creator_gateway_approvals SET receipt=? WHERE operation_id=? AND tool_call_id=?',
        args: [JSON.stringify(result), operationId, toolCallId],
      });
      return Response.json(result);
    }),
    route('seal', 'POST', async ({ claims, thread, resource }) => {
      if (!claims.operationId) return new Response(null, { status: 400 });
      await db.execute({
        sql: "INSERT OR IGNORE INTO creator_gateway_receipts (id,thread,resource,state,boot_id,model,reasoning,request_hash,updated_ms) VALUES (?,?,?,'rejected',?,'','','',?)",
        args: [claims.operationId, thread, resource, bootId, Date.now()],
      });
      const row = await lookup(claims.operationId, thread, resource);
      return row?.state === 'rejected' ? new Response(null, { status: 204 }) : new Response(null, { status: 409 });
    }),
    route('send', 'POST', async ({ request, claims, thread, resource }) => {
      const { operationId, tokenBudget } = claims;
      const parsed = messageSchema.safeParse(await request.json());
      if (
        !operationId ||
        !tokenBudget ||
        !parsed.success ||
        parsed.data.threadId !== thread ||
        parsed.data.resourceId !== resource
      )
        return Response.json({ error: 'Invalid conversation request' }, { status: 400 });
      const existingResponse = (row: Awaited<ReturnType<typeof lookup>>) => {
        if (row?.state === 'rejected') return Response.json({ error: 'Operation rejected' }, { status: 409 });
        if (row && row.request_hash !== claims.sha256)
          return Response.json({ error: 'Operation conflict' }, { status: 503 });
        if (row?.receipt) return Response.json(JSON.parse(String(row.receipt)));
        return Response.json({ error: 'Operation pending' }, { status: 503 });
      };
      const existing = await lookup(operationId, thread, resource);
      if (existing) return existingResponse(existing);
      const { message, ifIdle, attachment, attachments } = parsed.data;
      const ids = [...(attachment ? [attachment] : []), ...(attachments ?? [])];
      const model = ifIdle.streamOptions.model;
      const reasoningLevel = ifIdle.streamOptions.providerOptions.altflow.reasoningLevel;
      const saved = await db.execute({
        sql: "INSERT OR IGNORE INTO creator_gateway_receipts (id,thread,resource,state,boot_id,model,reasoning,request_hash,updated_ms) VALUES (?,?,?,'dispatching',?,?,?,?,?)",
        args: [operationId, thread, resource, bootId, model, reasoningLevel, claims.sha256, Date.now()],
      });
      if (saved.rowsAffected === 0) {
        return existingResponse(await lookup(operationId, thread, resource));
      }
      const reject = async (status: number, error: string) => {
        await setState(operationId, 'rejected');
        return Response.json({ error }, { status });
      };
      const parts: Array<
        { type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string; filename: string }
      > = [];
      const displayAttachments: { id: string; name: string }[] = [];
      const context = scopedContext(claims, resource);
      if (message.contents) parts.push({ type: 'text', text: message.contents });
      try {
        const snapshot = await catalog.catalog();
        if (String(snapshot.config_version) !== ifIdle.streamOptions.providerOptions.altflow.catalogVersion) {
          return reject(422, 'Model catalog version changed');
        }
        const option = snapshot.free_chat_models.find(item => 'altflow/' + item.id === model);
        if (
          !option ||
          !creatorProductModels.has(option.id) ||
          !option.thinking_options.some(option => option.level === reasoningLevel)
        ) {
          return reject(422, 'Unsupported model or reasoning level');
        }
        if (ids.length) {
          const attachmentError = await files.run({ owner: claims.userId, root: thread }, async () => {
            const entries = new Map(
              (await files.list(claims.userId))
                .filter(file => file.path.startsWith('/uploads/'))
                .map(file => [fileId(file.path, String(file.updatedAt)), file]),
            );
            const attached = ids.map(id => entries.get(id));
            if (attached.some(file => !file)) return reject(404, 'Attachment unavailable');
            let imageBytes = 0;
            for (const file of attached) {
              if (!file) continue;
              displayAttachments.push({ id: fileId(file.path, String(file.updatedAt)), name: file.name });
              parts.push({ type: 'text', text: '<attachment>\n' + file.path + '\n</attachment>' });
              if (!nativeImageTypes.has(file.mimeType)) continue;
              imageBytes += file.size;
              if (imageBytes > 10 * 1024 * 1024) return reject(400, 'Images exceed size limit');
              const data = await files.read(claims.userId, file.path);
              parts.push({
                type: 'file',
                data: data.toString('base64'),
                mediaType: file.mimeType,
                filename: file.name,
              });
            }
          });
          if (attachmentError) return attachmentError;
        }
        const memory = await agent.getMemory({ requestContext: context });
        const stored = await memory?.getThreadById({ threadId: thread });
        if (stored?.resourceId === resource && stored.title === '新会话') {
          await memory?.updateThread({ id: thread, title: '' });
        }
      } catch (error) {
        await db.execute({
          sql: "DELETE FROM creator_gateway_receipts WHERE id=? AND state='dispatching'",
          args: [operationId],
        });
        throw error;
      }
      const scopes = [`resource:${resource}`];
      const signal = createSignal({
        id: operationId,
        type: 'user-message',
        tagName: 'user',
        contents: ids.length ? parts : message.contents,
        metadata: {
          ...Object.fromEntries(
            Object.entries(message.metadata ?? {}).filter(
              ([key, value]) => key === 'clientMessageId' && typeof value === 'string' && value.length <= 100,
            ),
          ),
          ...(displayAttachments.length ? { creatorAttachments: displayAttachments } : {}),
        },
      });
      const admission = await creatorMeterContext
        .run(
          { db, operationId, tokenBudget },
          async () =>
            agent.sendSignal(signal, {
              resourceId: resource,
              threadId: thread,
              scopes,
              ifActive: { behavior: 'discard' },
              ifIdle: {
                streamOptions: {
                  ...ifIdle.streamOptions,
                  requestContext: context,
                  providerOptions: { altflow: { reasoningLevel, creatorMeterRequired: true } },
                },
              },
            }).accepted,
        )
        .catch(async error => {
          await setState(operationId, 'interrupted');
          throw error;
        });
      if (admission.action !== 'wake') {
        return reject(409, 'Conversation busy');
      }
      const receipt = { accepted: true, runId: admission.runId, signal: { id: operationId } };
      await db.execute({
        sql: "UPDATE creator_gateway_receipts SET state='accepted',run_id=?,receipt=?,updated_ms=? WHERE id=?",
        args: [admission.runId, JSON.stringify(receipt), Date.now(), operationId],
      });
      watchOutput(operationId, admission.output.finishReason);
      return Response.json(receipt);
    }),
  ];
}
