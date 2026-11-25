import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { Agent } from '@mastra/core/agent';
import { askUserTool } from '@mastra/core/tools';
import { Mastra } from '@mastra/core/mastra';
import { Hono } from 'hono';
import { MastraServer } from '@mastra/hono';
import { CreatorMemory } from '../src/mastra/agents/creator-memory.ts';
import { CREATOR_MEMORY_OPTIONS } from '../src/mastra/context-memory.ts';
import { createAltFlowAuth } from '../src/mastra/altflow-auth.ts';
import { protectConversationResponses } from '../src/mastra/agents/reference-visibility.ts';
import { ModelHubGateway } from '../src/mastra/modelhub-gateway.ts';
import {
  claimCreatorCall,
  createCreatorMeter,
  creatorMeterContext,
  creatorUsage,
} from '../src/mastra/creator-meter.ts';
import { creatorGatewayRoutes } from '../src/mastra/routes/creator-gateway.ts';
import { ConversationFiles } from '../src/mastra/services/conversation-files.ts';
import { modelHubFixture } from './modelhub-fixture.mjs';
import { setup } from './storage-fixture.mjs';
import { fixture, modelServer } from './tool-fixture.mjs';

const secret = 'test-only-creator-gateway-secret';
const account = 'alice';
const resourceId = 'altflow-creator:' + account;
const prefix = 'altflow-creator-v1.';

async function until(check) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, 'timed out waiting for Agent');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('signed creator admission, native thread delivery and billed model usage share one thread', async t => {
  const f = await fixture(t);
  const hub = await modelHubFixture();
  t.after(hub.close);
  const { store } = await setup(t, 128);
  const titles = await modelServer(t);
  const catalog = new ModelHubGateway({ apiKey: 'fixture', baseURL: hub.baseURL });
  hub.state.catalog.free_chat_models.push({
    id: 'qwen3.8-flash',
    display_name: 'Qwen3.8 Flash',
    sort_order: 3,
    default_thinking_level: 'low',
    thinking_options: [
      { level: 'low', target: 'internal-flash-route', supports_thinking_level: true, supports_thinking_budget: false },
    ],
  });
  hub.state.info.data.push({ model_name: 'internal-flash-route', model_info: { max_input_tokens: 983616 } });
  const memory = new CreatorMemory({
    storage: f.storage,
    options: {
      ...CREATOR_MEMORY_OPTIONS,
      semanticRecall: false,
      generateTitle: { model: titles.model, emitEvent: true },
    },
  });
  const agent = new Agent({
    id: 'creator-agent',
    name: 'Creator',
    instructions: 'Write a short response.',
    model: await catalog.resolveLanguageModel({ modelId: 'qwen3.8-max' }),
    memory,
    tools: { ask_user: askUserTool },
  });
  const accounts = createAltFlowAuth({
    backendUrl: 'http://127.0.0.1:1',
    origins: [],
    secureCookies: false,
    creatorGatewaySecret: secret,
  });
  const db = createClient({ url: `file:${f.dir}/creator.db` });
  t.after(() => db.close());
  const routes = await creatorGatewayRoutes({ accounts, agent, db, catalog, files: new ConversationFiles(store) });
  const app = new Hono();
  const mastra = new Mastra({
    agents: { 'creator-agent': agent },
    storage: f.storage,
    gateways: { altflow: catalog },
    server: { auth: accounts.auth, apiRoutes: routes, middleware: protectConversationResponses },
  });
  await new MastraServer({ mastra, app, prefix: '/api', customApiRoutes: routes }).init();
  const conversationId = 'fc_' + randomUUID();
  const threadId = 'free:' + conversationId;
  const other = 'fc_' + randomUUID();
  const operationId = randomUUID();
  const request = (
    path,
    { method = 'GET', body, operation, conversation = conversationId, user = account, signed = true, signal } = {},
  ) => {
    const target = path.startsWith('/creator-gateway/') ? path : '/api' + path;
    const binary = Buffer.isBuffer(body) || typeof body === 'string';
    const raw = binary ? body : body && JSON.stringify(body);
    const claims = {
      aud: 'altflow-creator-v1',
      userId: user,
      username: user,
      role: 'user',
      projectId: 'project-a',
      conversationId: conversation,
      method,
      target,
      sha256: createHash('sha256')
        .update(raw ?? '')
        .digest('hex'),
      exp: Math.floor(Date.now() / 1000) + 30,
      nonce: randomUUID(),
      ...(operation ? { operationId: operation, tokenBudget: 1048576 } : {}),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(prefix + payload)
      .digest('base64url');
    return app.request(target, {
      method,
      body: raw,
      signal,
      headers: {
        ...(binary
          ? { 'content-type': 'application/octet-stream' }
          : body
            ? { 'content-type': 'application/json' }
            : {}),
        ...(signed ? { authorization: 'Bearer ' + prefix + payload + '.' + signature } : {}),
      },
    });
  };
  const assertStatus = async (response, status) =>
    assert.equal(response.status, status, response.status === status ? undefined : await response.clone().text());
  await assertStatus(await request('/creator-gateway/catalog', { signed: false }), 401);
  const productCatalog = await request('/creator-gateway/catalog');
  await assertStatus(productCatalog, 200);
  const { defaultModelId, models } = await productCatalog.json();
  assert.equal(defaultModelId, 'altflow/qwen3.8-max');
  assert.deepEqual(
    models.map(model => model.id),
    ['altflow/qwen3.8-max', 'altflow/qwen3.8-flash'],
  );
  await assertStatus(await request('/creator-gateway/thread', { method: 'POST' }), 200);
  await assertStatus(await request('/creator-gateway/thread', { method: 'POST', conversation: other }), 200);
  await assertStatus(await request('/creator-gateway/thread', { method: 'POST', user: 'bob' }), 404);
  await memory.updateWorkingMemory({ threadId, resourceId, workingMemory: 'Only A working memory marker' });
  const native = '/agents/creator-agent/threads/subscribe';
  const subscribe = new AbortController();
  t.after(() => subscribe.abort());
  const stream = await request(native, {
    method: 'POST',
    body: { threadId, resourceId, withInitialHistory: true, withRunStatus: true },
    signal: subscribe.signal,
  });
  assert.equal(stream.status, 200, stream.ok ? undefined : await stream.text());
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  let streamed = '';
  const live = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      streamed += new TextDecoder().decode(next.value);
      if (streamed.includes('verified')) return;
    }
  })();
  live.catch(() => {});
  const body = {
    threadId,
    resourceId,
    message: { contents: 'Unique current conversation prompt' },
    ifIdle: {
      streamOptions: {
        model: 'altflow/qwen3.8-max',
        providerOptions: { altflow: { reasoningLevel: 'high', catalogVersion: '1' } },
      },
    },
  };
  const send = () => request('/creator-gateway/send', { method: 'POST', body, operation: operationId });
  const accepted = await send();
  await assertStatus(accepted, 200);
  const receipt = await accepted.json();
  assert.ok(receipt.runId);
  assert.deepEqual(await (await send()).json(), receipt);
  const settled = await until(async () => {
    const data = await (await request('/creator-gateway/operation', { operation: operationId })).json();
    return ['completed', 'interrupted'].includes(data.state) ? data : undefined;
  });
  assert.equal(settled.state, 'completed');
  const titled = await until(async () => {
    const current = await (await request('/creator-gateway/operation', { operation: operationId })).json();
    return current.title && current;
  });
  assert.notEqual(titled.title, '新会话');
  assert.match(JSON.stringify(titles.requests[0].messages), /Only A|hello|first|message/i);
  assert.equal(settled.usages.length, 1);
  assert.equal(settled.usages[0].promptTokens, 1);
  assert.equal(hub.state.requests.length, 1);
  assert.match(JSON.stringify(hub.state.requests[0].body.messages), /Only A working memory marker/);
  assert.equal(hub.state.requests[0].body.modelhub_reasoning_effort, 'high');
  await until(() => streamed.includes('verified'));
  await reader.cancel();
  await live;
  const history = await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent');
  await assertStatus(history, 200);
  assert.match(await history.text(), /Unique current conversation prompt/);
  const foreign = await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent', {
    conversation: other,
  });
  assert.ok([401, 403, 404].includes(foreign.status));
  const sameOwnerOther = await request('/memory/threads/free:' + other + '/messages?agentId=creator-agent', {
    conversation: other,
  });
  await assertStatus(sameOwnerOther, 200);
  assert.doesNotMatch(await sameOwnerOther.text(), /Unique current conversation prompt/);

  const sealed = randomUUID();
  await assertStatus(await request('/creator-gateway/seal', { method: 'POST', operation: sealed }), 204);
  await assertStatus(await request('/creator-gateway/send', { method: 'POST', body, operation: sealed }), 409);
  const rejected = randomUUID();
  const staleSelection = structuredClone(body);
  staleSelection.ifIdle.streamOptions.providerOptions.altflow.catalogVersion = '0';
  await assertStatus(
    await request('/creator-gateway/send', { method: 'POST', body: staleSelection, operation: rejected }),
    422,
  );
  const rejection = await request('/creator-gateway/operation', { operation: rejected });
  assert.deepEqual(await rejection.json(), { state: 'rejected', receipt: null, usages: null });
  await assertStatus(await request('/creator-gateway/send', { method: 'POST', body, operation: rejected }), 409);
  assert.equal(hub.state.requests.length, 1);

  hub.state.nextToolCall = body =>
    body.messages.some(message => message.role === 'user' && String(message.content).includes('Pending only here')) &&
    !body.messages.some(message => message.role === 'tool')
      ? {
          name: 'ask_user',
          args: { question: 'Secret choice for A', options: [{ label: 'First' }, { label: 'Second' }] },
        }
      : undefined;
  const pause = randomUUID();
  const paused = await request('/creator-gateway/send', {
    method: 'POST',
    operation: pause,
    body: {
      ...body,
      message: { contents: 'Pending only here' },
      ifIdle: {
        streamOptions: {
          model: 'altflow/qwen3.8-flash',
          providerOptions: { altflow: { reasoningLevel: 'low', catalogVersion: '1' } },
        },
      },
    },
  });
  await assertStatus(paused, 200);
  const { runId } = await paused.json();
  const tool = await until(
    async () =>
      (await agent.listSuspendedRuns({ threadId, resourceId })).runs.find(run => run.runId === runId)?.toolCalls[0],
  );
  assert.equal(tool.suspendPayload.question, 'Secret choice for A');
  const secondary = randomUUID();
  const distinct = await request('/creator-gateway/send', {
    method: 'POST',
    operation: secondary,
    conversation: other,
    body: { ...body, threadId: 'free:' + other, message: { contents: 'Independent conversation' } },
  });
  await assertStatus(distinct, 200);
  await until(
    async () =>
      (await (await request('/creator-gateway/operation', { operation: secondary, conversation: other })).json())
        .state === 'completed',
  );
  const secondPrompt = hub.state.requests.at(-1).body.messages;
  assert.doesNotMatch(
    JSON.stringify(secondPrompt),
    /Secret choice for A|Pending only here|Only A working memory marker/,
  );
  const approval = {
    threadId,
    resourceId,
    approved: true,
    toolCallId: tool.toolCallId,
    resumeData: 'Use a different ending.',
  };
  await assertStatus(
    await request('/creator-gateway/approval', {
      method: 'POST',
      operation: pause,
      conversation: other,
      body: { ...approval, threadId: 'free:' + other },
    }),
    409,
  );
  const decide = () => request('/creator-gateway/approval', { method: 'POST', operation: pause, body: approval });
  await assertStatus(await decide(), 200);
  await until(() => hub.state.requests.length === 4);
  const afterApproval = await until(async () => {
    const data = await (await request('/creator-gateway/operation', { operation: pause })).json();
    return data.state === 'completed' ? data : undefined;
  });
  await assertStatus(await decide(), 200);
  assert.deepEqual(
    afterApproval.usages.map(call => call.modelId),
    ['altflow/qwen3.8-flash', 'altflow/qwen3.8-flash'],
  );
  assert.equal(hub.state.requests.at(-1).body.modelhub_reasoning_effort, 'low');
  assert.match(JSON.stringify(hub.state.requests.at(-1).body.messages), /User answered: Use a different ending/);

  const upload = await request('/creator-gateway/file?id=' + randomUUID() + '&name=notes.txt', {
    method: 'POST',
    body: 'Private notes',
  });
  await assertStatus(upload, 200);
  const { id } = await upload.json();
  assert.equal(await (await request('/creator-gateway/file?id=' + id)).text(), 'Private notes');
  await assertStatus(await request('/creator-gateway/file?id=' + id, { conversation: other }), 404);

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a19sAAAAASUVORK5CYII=';
  const image = await request('/creator-gateway/file?id=' + randomUUID() + '&name=reference.png', {
    method: 'POST',
    body: Buffer.from(png, 'base64'),
  });
  await assertStatus(image, 200);
  const imageId = (await image.json()).id;
  const withAttachments = { ...body, message: { contents: '' }, attachments: [id, imageId] };
  await assertStatus(
    await request('/creator-gateway/send', {
      method: 'POST',
      operation: randomUUID(),
      conversation: other,
      body: { ...withAttachments, threadId: 'free:' + other },
    }),
    404,
  );
  const attachmentTurn = randomUUID();
  await assertStatus(
    await request('/creator-gateway/send', { method: 'POST', operation: attachmentTurn, body: withAttachments }),
    200,
  );
  const attached = await until(async () => {
    const data = await (await request('/creator-gateway/operation', { operation: attachmentTurn })).json();
    return ['completed', 'interrupted'].includes(data.state) ? data : undefined;
  });
  const oversized = await request('/creator-gateway/file?id=' + randomUUID() + '&name=large.txt', {
    method: 'POST',
    body: 'x'.repeat(128),
  });
  await assertStatus(oversized.clone(), 413);
  assert.equal((await oversized.json()).code, 'STORAGE_QUOTA_EXCEEDED');
  const storedHistory = await (await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent')).json();
  assert.ok(
    storedHistory.messages.some(message => {
      const files = message.content.metadata?.signal?.metadata?.creatorAttachments;
      return files?.some(file => file.id === id && file.name === 'notes.txt');
    }),
  );
  assert.equal(attached.state, 'completed');
  const attachedParts = hub.state.requests
    .at(-1)
    .body.messages.filter(item => item.role === 'user')
    .at(-1).content;
  assert.ok(attachedParts.some(part => part.type === 'text' && part.text.includes('/notes.txt')));
  assert.ok(
    attachedParts.some(part => part.type === 'image_url' && part.image_url.url === 'data:image/png;base64,' + png),
  );
});

test('creator budget reuses verified surplus and reserves the full amount for in-flight calls', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await db.batch([
    'CREATE TABLE creator_gateway_receipts (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    "INSERT INTO creator_gateway_receipts VALUES ('turn', 'accepted')",
  ]);
  await createCreatorMeter(db);
  await creatorMeterContext.run({ db, operationId: 'turn', tokenBudget: 262144 }, async () => {
    const first = await claimCreatorCall('qwen3.8-max', false, 150000);
    await assert.rejects(claimCreatorCall('qwen3.8-max', true, 150000), /no remaining model budget/);
    await first.finish({ inputTokens: 9000, outputTokens: 1000, cacheReadTokens: 0 });
    const second = await claimCreatorCall('qwen3.8-max', true, 150000);
    await second.finish(null);
    await assert.rejects(claimCreatorCall('qwen3.8-max', false, 110000), /no remaining model budget/);
    assert.equal(await creatorUsage(db, 'turn'), null);
  });
});
