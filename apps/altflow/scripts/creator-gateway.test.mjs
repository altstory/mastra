import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { Agent } from '@mastra/core/agent';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { creatorQuestionTool } from '../src/mastra/tools/creator-question.ts';
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
  creatorAllowance,
  grantCreatorAllowance,
  fetchMeteredCreatorModel,
} from '../src/mastra/creator-meter.ts';
import { creatorGatewayRoutes } from '../src/mastra/routes/creator-gateway.ts';
import {
  createDeliverInteractiveScriptTool,
  interactiveScriptFormat,
} from '../src/mastra/tools/deliver-interactive-script.ts';
import { ConversationFiles } from '../src/mastra/services/conversation-files.ts';
import { modelHubFixture } from './modelhub-fixture.mjs';
import { setup } from './storage-fixture.mjs';
import { fixture, context } from './tool-fixture.mjs';
import { createAgentTree } from '../src/mastra/subagents/agents.ts';

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
  const { store } = await setup(t, 4096);
  const files = new ConversationFiles(store);
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
      generateTitle: { model: () => catalog.resolveTitleModel('qwen3.8-max'), emitEvent: true },
    },
  });
  const tree = createAgentTree({
    store: f.treeStore,
    memory: f.memoryStore,
    childMemory: f.memory,
    model: 'altflow/qwen3.8-max',
    tools: f.bundle.tools,
    teamEnabled: async () => false,
    getMastra: () => mastra,
    getRootAgent: () => agent,
  });
  t.after(() => tree.runtime.close());
  const agent = new Agent({
    id: 'creator-agent',
    name: 'Creator',
    instructions: 'Write a short response.',
    model: await catalog.resolveLanguageModel({ modelId: 'qwen3.8-max' }),
    memory,
    tools: {
      ...tree.tools,
      ask_user: creatorQuestionTool,
      deliver_interactive_script: createDeliverInteractiveScriptTool(files),
    },
    inputProcessors: [tree.processor, files.processor(async (_context, root) => ({ owner: account, root }))],
  });
  const accounts = createAltFlowAuth({
    backendUrl: 'http://127.0.0.1:1',
    origins: [],
    secureCookies: false,
    creatorGatewaySecret: secret,
  });
  const db = createClient({ url: `file:${f.dir}/creator.db` });
  t.after(() => db.close());
  const routes = await creatorGatewayRoutes({ accounts, agent, db, catalog, files, subagents: f.tree.runtime });
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
  assert.equal(titled.title, 'verified');
  const titleRequests = () => hub.state.requests.filter(request => request.body.max_tokens === 256);
  const chatRequests = () => hub.state.requests.filter(request => request.body.max_tokens !== 256);
  assert.equal(titleRequests().length, 1);
  assert.match(JSON.stringify(titleRequests()[0].body.messages), /Unique current conversation prompt/);
  assert.equal(settled.usages.length, 2);
  assert.equal(settled.usages[0].promptTokens, 1);
  assert.equal(chatRequests().length, 1);
  assert.match(JSON.stringify(hub.state.requests[0].body.messages), /Only A working memory marker/);
  assert.equal(hub.state.requests[0].body.modelhub_reasoning_effort, 'high');
  await until(() => streamed.includes('verified'));
  await reader.cancel();
  await live;
  const history = await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent');
  await assertStatus(history, 200);
  const durableHistory = (await history.json()).messages;
  const userMessage = durableHistory.find(message =>
    JSON.stringify(message).includes('Unique current conversation prompt'),
  );
  assert.equal(userMessage.id, receipt.signal.id);
  const branch = 'fc_' + randomUUID();
  const branchInput = { destination: branch, throughMessageId: userMessage.id };
  await assertStatus(
    await request('/creator-gateway/branch', { method: 'POST', body: branchInput, conversation: other }),
    404,
  );
  const branchResponse = await request('/creator-gateway/branch', { method: 'POST', body: branchInput });
  await assertStatus(branchResponse, 200);
  assert.deepEqual(
    await (await request('/creator-gateway/branch', { method: 'POST', body: branchInput })).json(),
    await branchResponse.json(),
  );
  const forked = await request('/memory/threads/free:' + branch + '/messages?agentId=creator-agent', {
    conversation: branch,
  });
  await assertStatus(forked, 200);
  const forkedMessages = (await forked.json()).messages;
  assert.equal(
    forkedMessages.filter(message => JSON.stringify(message).includes('Unique current conversation prompt')).length,
    1,
  );
  assert.ok(forkedMessages.every(message => message.role !== 'assistant'));
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
  assert.deepEqual(await rejection.json(), {
    state: 'rejected',
    requiredTokenAllowance: 0,
    receipt: null,
    usages: null,
  });
  await assertStatus(await request('/creator-gateway/send', { method: 'POST', body, operation: rejected }), 409);
  assert.equal(chatRequests().length, 1);

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
  const renewal = { allowed: 2097152 };
  await assertStatus(
    await request('/creator-gateway/allowance', { method: 'POST', body: renewal, operation: pause, signed: false }),
    401,
  );
  await assertStatus(
    await request('/creator-gateway/allowance', { method: 'POST', body: renewal, operation: pause, user: 'bob' }),
    409,
  );
  await assertStatus(
    await request('/creator-gateway/allowance', {
      method: 'POST',
      body: renewal,
      operation: pause,
      conversation: other,
    }),
    409,
  );
  await assertStatus(
    await request('/creator-gateway/allowance', { method: 'POST', body: renewal, operation: pause }),
    204,
  );
  assert.equal(Number((await creatorAllowance(db, pause)).allowed), 2097152);

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
  await until(() => chatRequests().length === 4);
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
  const imageUploadId = randomUUID();
  const image = await request('/creator-gateway/file?id=' + imageUploadId + '&name=reference.png', {
    method: 'POST',
    body: Buffer.from(png, 'base64'),
  });
  await assertStatus(image, 200);
  const imageId = (await image.json()).id;
  const listed = await (await request('/creator-gateway/files')).json();
  assert.ok(
    listed.some(file => file.id === imageId && file.uploadId === imageUploadId && file.name === 'reference.png'),
  );
  const otherFiles = await (await request('/creator-gateway/files', { conversation: other })).json();
  assert.ok(!otherFiles.some(file => file.uploadId === imageUploadId));
  const preview = await request('/creator-gateway/file?id=' + imageId);
  await assertStatus(preview, 200);
  assert.equal(Buffer.from(await preview.arrayBuffer()).toString('base64'), png);
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
    body: 'x'.repeat(4096),
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

  hub.state.nextToolCall = undefined;
  const steeringOperation = randomUUID();
  const startIndex = hub.state.requests.length;
  let steering;
  const steer = body => request('/creator-gateway/send', { method: 'POST', body, operation: steeringOperation });
  hub.state.blocked = true;
  try {
    const start = await steer({ ...body, message: { contents: 'Start the original task' } });
    await assertStatus(start, 200);
    const running = await start.json();
    await until(() => hub.state.requests.length > startIndex);
    steering = {
      ...body,
      expectedRunId: running.runId,
      steerId: randomUUID(),
      message: { contents: 'Switch to a first-person narrator' },
    };
    await assertStatus(await steer({ ...steering, expectedRunId: 'different-run' }), 409);
    const delivered = await steer(steering);
    await assertStatus(delivered, 200);
    const original = await delivered.json();
    assert.equal(original.runId, running.runId);
    assert.deepEqual(await (await steer(steering)).json(), original);
    await assertStatus(await steer({ ...steering, message: { contents: 'Changed payload' } }), 409);
  } finally {
    hub.state.blocked = false;
  }
  const steeringUsage = await until(async () => {
    const data = await (await request('/creator-gateway/operation', { operation: steeringOperation })).json();
    return data.state === 'completed' ? data.usages : undefined;
  });
  assert.equal(steeringUsage.length, 2);
  assert.match(JSON.stringify(hub.state.requests[startIndex + 1].body.messages), /Switch to a first-person narrator/);
  const steeredMessages = await until(async () => {
    const history = await (await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent')).json();
    const matches = history.messages.filter(message => message.id === steering.steerId);
    return matches.length ? matches : undefined;
  });
  assert.equal(steeredMessages.length, 1);
  await assertStatus(await steer(steering), 200);
  await assertStatus(await steer({ ...steering, steerId: randomUUID() }), 409);
  hub.state.nextToolCall = modelBody => {
    const lastUser = modelBody.messages.findLastIndex(message => message.role === 'user');
    if (modelBody.messages.slice(lastUser + 1).some(message => message.role === 'tool')) return undefined;
    const content = JSON.stringify(modelBody.messages[lastUser]);
    const path = 'projects/测试/剧本.md';
    if (content.includes('Deliver invalid draft'))
      return { id: 'draft-invalid', name: 'deliver_interactive_script', args: { path, script: '场景1 开门' } };
    if (content.includes('Deliver verified draft'))
      return {
        id: 'draft-verified',
        name: 'deliver_interactive_script',
        args: { path, script: interactiveScriptFormat },
      };
  };
  const deliverDraft = async prompt => {
    const operation = randomUUID();
    await assertStatus(
      await request('/creator-gateway/send', {
        method: 'POST',
        body: { ...body, message: { contents: prompt } },
        operation,
      }),
      200,
    );
    await until(
      async () => (await (await request('/creator-gateway/operation', { operation })).json()).state === 'completed',
    );
  };
  await deliverDraft('Deliver invalid draft');
  const listScripts = async () =>
    (await (await request('/creator-gateway/files')).json()).filter(file => file.name === '剧本.md');
  assert.deepEqual(await listScripts(), []);
  await deliverDraft('Deliver verified draft');
  const [script] = await listScripts();
  const downloaded = await request('/creator-gateway/file?id=' + script.id);
  assert.equal(await downloaded.text(), interactiveScriptFormat + '\n');
  const updated = await request('/memory/threads/' + threadId + '/messages?agentId=creator-agent');
  assert.match(await updated.text(), /"delivered":true.*"pathCount":2/);
  const actorContext = context(account);
  actorContext.set(MASTRA_RESOURCE_ID_KEY, resourceId);
  const actor = await f.tree.runtime.actor(actorContext, threadId);
  f.setHandler(() => ({ text: 'ACTUAL-CREATOR-CHILD-RESULT' }));
  await f.tree.runtime.spawn(actor, { name: 'researcher', description: '整理原著', prompt: 'Read the source.' });
  const child = await until(async () =>
    (await f.treeStore.read(account, threadId)).children.find(child => child.state === 'completed'),
  );
  const childRoute = '/creator-gateway/subagents?child=' + child.id;
  await assertStatus(await request(childRoute, { user: 'bob' }), 404);
  await assertStatus(await request(childRoute, { conversation: other }), 404);
  await assertStatus(await request('/creator-gateway/subagents?page=-1'), 400);
  const beforeReads = f.requests.length;
  for (let index = 0; index < 2; index++) {
    const snapshot = await request(childRoute);
    await assertStatus(snapshot, 200);
    const visible = await snapshot.json();
    assert.equal(visible.children[0].state, 'completed');
    assert.ok(visible.messages.some(message => message.text === 'ACTUAL-CREATOR-CHILD-RESULT'));
    assert.doesNotMatch(JSON.stringify(visible), /totalTokens|elapsedMs|"error"|"prompt"|"role":"user"/);
  }
  assert.equal(f.requests.length, beforeReads, 'reading child status must not start model execution');

  const backgroundConversation = 'fc_' + randomUUID();
  await request('/creator-gateway/thread', { method: 'POST', conversation: backgroundConversation });
  const backgroundOperation = randomUUID();
  let rootSteps = 0,
    childSteps = 0,
    releaseChild;
  const childGate = new Promise(resolve => {
    releaseChild = resolve;
  });
  t.after(() => releaseChild());
  const isChild = body => JSON.stringify(body.messages).includes('Your name is background_worker.');
  hub.state.onRequest = async body => {
    if (isChild(body) && ++childSteps === 1) await childGate;
  };
  hub.state.nextToolCall = body => {
    if (!body.tools?.length) return undefined;
    if (isChild(body)) return childSteps === 1 ? { name: 'countText', args: { text: 'background task' } } : undefined;
    if (++rootSteps === 1)
      return {
        name: 'subagent',
        args: { name: 'background_worker', description: '整理材料', prompt: 'Count then report.' },
      };
    if (rootSteps === 3)
      return {
        name: 'ask_user',
        id: 'background-question',
        args: { title: '下一步', question: '接下来先写哪一段？', options: [{ label: '开场' }, { label: '结尾' }] },
      };
    return undefined;
  };
  const backgroundBody = {
    ...body,
    threadId: 'free:' + backgroundConversation,
    message: { contents: 'Delegate background work.' },
  };
  const backgroundAdmission = await request('/creator-gateway/send', {
    method: 'POST',
    body: backgroundBody,
    operation: backgroundOperation,
    conversation: backgroundConversation,
  });
  await assertStatus(backgroundAdmission, 200);
  const originalRun = (await backgroundAdmission.json()).runId;
  await until(
    () =>
      childSteps === 1 &&
      rootSteps >= 2 &&
      !agent.getActiveThreadRunId({ threadId: backgroundBody.threadId, resourceId }),
  );
  const backgroundReceipt = async () =>
    (
      await request('/creator-gateway/operation', {
        operation: backgroundOperation,
        conversation: backgroundConversation,
      })
    ).json();
  assert.equal(
    (await backgroundReceipt()).state,
    'accepted',
    'background work must retain its reservation after the lead replies',
  );
  releaseChild();
  await until(
    async () => (await agent.listSuspendedRuns({ threadId: backgroundBody.threadId, resourceId })).runs.length > 0,
  );
  const resumed = await until(async () => {
    const value = await backgroundReceipt();
    return value.receipt.runId !== originalRun && value;
  });
  assert.equal(resumed.state, 'accepted');
  await assertStatus(
    await request('/creator-gateway/approval', {
      method: 'POST',
      operation: backgroundOperation,
      conversation: backgroundConversation,
      body: {
        threadId: backgroundBody.threadId,
        resourceId,
        toolCallId: 'background-question',
        approved: true,
        resumeData: '开场',
      },
    }),
    200,
  );
  const finished = await until(async () => {
    const value = await backgroundReceipt();
    return value.state === 'completed' && value;
  });
  assert.ok(finished.usages.length >= 6, 'child steps and the awakened lead must all be billed');
  assert.equal(childSteps, 2);
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
    await assert.rejects(claimCreatorCall('qwen3.8-max', true, 150000), /requires an additional reservation/);
    await first.finish({ inputTokens: 9000, outputTokens: 1000, cacheReadTokens: 0 });
    const second = await claimCreatorCall('qwen3.8-max', true, 150000);
    await second.finish(null);
    await assert.rejects(claimCreatorCall('qwen3.8-max', false, 110000), /requires an additional reservation/);
    assert.equal(await creatorUsage(db, 'turn'), null);
  });
});

test('long free chat renews its reservation and continues past forty model calls', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await db.batch([
    'CREATE TABLE creator_gateway_receipts (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    "INSERT INTO creator_gateway_receipts VALUES ('long', 'accepted')",
  ]);
  await createCreatorMeter(db);
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ usage: { prompt_tokens: 5000, completion_tokens: 1000 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const completion = creatorMeterContext.run({ db, operationId: 'long', tokenBudget: 262144 }, async () => {
    for (let index = 0; index < 45; index++) {
      const response = await fetchMeteredCreatorModel(
        `http://127.0.0.1:${server.address().port}/completion`,
        { method: 'POST', body: '{}' },
        'qwen3.8-max',
        index === 2,
        8000,
      );
      await response.json();
    }
  });
  completion.catch(() => {});
  const required = await until(async () => {
    const allowance = await creatorAllowance(db, 'long');
    return Number(allowance?.requested) > 262144 && allowance;
  });
  assert.equal(requests, 43);
  await grantCreatorAllowance(db, 'long', 524288);
  await grantCreatorAllowance(db, 'long', 262144, true);
  await completion;
  assert.equal(requests, 45);
  const usages = await creatorUsage(db, 'long');
  assert.equal(usages.length, 45);
  assert.equal(
    usages.reduce((sum, usage) => sum + usage.promptTokens + usage.completionTokens, 0),
    270000,
  );
  assert.equal(Number((await creatorAllowance(db, 'long')).requested), 0);
  assert.ok(Number(required.requested) > 262144);
  await db.execute("UPDATE creator_gateway_receipts SET state='completed' WHERE id='long'");
  await creatorMeterContext.run({ db, operationId: 'long', tokenBudget: 262144 }, () =>
    assert.rejects(claimCreatorCall('qwen3.8-max', false, 1), /no longer active/),
  );
});

test('a request cancelled before dispatch leaves no unknown billable call', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await db.batch([
    'CREATE TABLE creator_gateway_receipts (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    "INSERT INTO creator_gateway_receipts VALUES ('cancelled','accepted')",
  ]);
  await createCreatorMeter(db);
  await creatorMeterContext.run({ db, operationId: 'cancelled', tokenBudget: 262144 }, () =>
    assert.rejects(
      fetchMeteredCreatorModel(
        'http://127.0.0.1:1/must-not-dispatch',
        { signal: AbortSignal.abort() },
        'qwen3.8-max',
        false,
        8000,
      ),
      /abort/i,
    ),
  );
  assert.deepEqual(await creatorUsage(db, 'cancelled'), []);
});

test('reservation refusal and cancellation do not dispatch an unreserved model request', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await db.batch([
    'CREATE TABLE creator_gateway_receipts (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    "INSERT INTO creator_gateway_receipts VALUES ('denied','accepted'),('aborted','accepted')",
  ]);
  await createCreatorMeter(db);
  for (const operationId of ['denied', 'aborted']) {
    const controller = new AbortController();
    const pending = creatorMeterContext.run({ db, operationId, tokenBudget: 262144 }, () =>
      fetchMeteredCreatorModel(
        'http://127.0.0.1:1/must-not-dispatch',
        { signal: controller.signal },
        'qwen3.8-max',
        false,
        300000,
      ),
    );
    const result = assert.rejects(pending, operationId === 'denied' ? /余额不足/ : /abort/i);
    await until(async () => Number((await creatorAllowance(db, operationId))?.requested) > 0);
    if (operationId === 'denied') await grantCreatorAllowance(db, operationId, 262144, true);
    else controller.abort();
    await result;
    assert.deepEqual(await creatorUsage(db, operationId), []);
  }
});
