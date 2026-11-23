import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { SpanType, TracingEventType } from '@mastra/core/observability';
import { RequestContext, MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { MastraCompositeStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { Observability } from '@mastra/observability';
import { z } from 'zod';
import { DisabledRecallMemory } from '../src/mastra/agents/disabled-recall-memory.ts';
import { ContextCompaction } from '../src/mastra/context-compaction.ts';
import { CONTEXT_MEMORY_OPTIONS } from '../src/mastra/context-memory.ts';
import { contextPolicy } from '../src/mastra/context-policy.ts';
import { ModelHubGateway } from '../src/mastra/modelhub-gateway.ts';
import { accountMemory } from '../src/mastra/services/account-memory.ts';
import { AccountPreferences } from '../src/mastra/services/account-preferences.ts';
import { modelHubFixture } from './modelhub-fixture.mjs';

const isSummary = request =>
  request.body.messages.at(-1)?.content?.includes('You are now acting as a compaction engine');
async function setup(t, trace = false, persistedOptOut = false, gatewayOptions = {}) {
  const events = [];
  const observability = trace
    ? new Observability({
        configs: {
          default: {
            serviceName: 'context-test',
            exporters: [
              {
                name: 'capture',
                exportTracingEvent: async event => {
                  events.push(event);
                },
                flush: async () => {},
                shutdown: async () => {},
              },
            ],
          },
        },
      })
    : undefined;
  const hub = await modelHubFixture();
  const dir = await mkdtemp(join(tmpdir(), 'context-checkpoint-'));
  const db = new LibSQLStore({
    id: 'isolated',
    url: `file:${join(dir, 'test.db')}`,
  });
  const storage = new MastraCompositeStore({ id: 'test', default: db });
  await storage.init();
  const store = await storage.getStore('memory');
  await store.saveThread({
    thread: {
      id: 'thread',
      resourceId: 'owner',
      title: 'test',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { unrelated: 'keep' },
    },
  });
  const preferences = new AccountPreferences(`file:${join(dir, 'preferences.db')}`, store);
  await preferences.init();
  if (persistedOptOut)
    await preferences.write('owner', 'owner', { kind: 'memory', id: 'creator-agent', patch: { enabled: false } });
  t.after(() => preferences.close());
  const gateway = new ModelHubGateway({ apiKey: 'test', baseURL: hub.baseURL, ...gatewayOptions });
  t.after(async () => {
    await hub.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  const agent = async (tools = {}, modelId = 'deepseek-v4-pro', memoryOptions = {}, agentOptions = {}) => {
    const compaction = new ContextCompaction({ gateway, storage });
    const instance = new Agent({
      id: 'test',
      name: 'test',
      instructions: 'Preserve the original system instructions.',
      model: await gateway.resolveLanguageModel({ modelId }),
      memory: accountMemory(
        preferences,
        new Memory({
          storage,
          options: {
            ...CONTEXT_MEMORY_OPTIONS,
            semanticRecall: false,
            generateTitle: false,
            ...memoryOptions,
          },
        }),
        new DisabledRecallMemory({ storage, options: { generateTitle: false } }),
      ),
      inputProcessors: [compaction],
      outputProcessors: [compaction],
      errorProcessors: [compaction],
      tools,
      ...agentOptions,
    });
    new Mastra({
      agents: { test: instance },
      storage,
      gateways: { altflow: gateway },
      ...(observability ? { observability } : {}),
    });
    return instance;
  };
  const seed = async (count = 18, size = 18000) => {
    await store.saveMessages({
      messages: Array.from({ length: count }, (_, i) => ({
        id: `old-${i}`,
        threadId: 'thread',
        resourceId: 'owner',
        role: i % 2 ? 'assistant' : 'user',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        content: {
          format: 2,
          parts: [
            {
              type: 'text',
              text: `old-${i}: original fact ${'abcd'.repeat(size / 4)}`,
            },
          ],
        },
      })),
    });
  };
  return { hub, store, agent, seed, storage, gateway, events, dir };
}
const options = {
  memory: { thread: 'thread', resource: 'owner' },
  maxSteps: 4,
};

// Real PNG bytes: a noisy image exceeds the old text-based pressure threshold.
function imageFixture() {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512, 0);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(512 * (512 * 3 + 1));
  let random = 123456789;
  for (let i = 0; i < pixels.length; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    if (i % (512 * 3 + 1)) pixels[i] = random >>> 24;
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const mode of ['generate', 'stream'])
  test(`${mode}: reads a workspace image and continues answering after reopening the conversation`, async t => {
    const { hub, agent, dir } = await setup(t);
    const bytes = imageFixture();
    await writeFile(join(dir, 'office.png'), bytes);
    const workspace = new Workspace({ filesystem: new LocalFilesystem({ basePath: dir }) });
    hub.state.toolCall = { name: 'mastra_workspace_read_file', args: { path: 'office.png' } };
    for (const prompt of ['Read office.png and describe it.', 'Describe the image from the previous turn.']) {
      const result = await (await agent({}, 'qwen3.8-max', {}, { workspace }))[mode](prompt, options);
      if (mode === 'stream') await result.consumeStream();
      assert.equal(await result.text, 'verified');
      const main = hub.state.requests.filter(request => !isSummary(request)).at(-1).body;
      const content = main.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
      assert.ok(
        content.some(part => part.type === 'image_url' && part.image_url.url.endsWith(bytes.toString('base64'))),
        'the complete workspace image reaches the provider as native media',
      );
      assert.doesNotMatch(
        JSON.stringify(main.messages.filter(message => typeof message.content === 'string')),
        /__workspaceMedia/,
      );
    }
  });

for (const mode of ['generate', 'stream'])
  for (const type of ['image', 'file'])
    for (const longHistory of [false, true])
      test(`${mode}: answers a ${type} upload with ${longHistory ? 'compacted' : 'short'} history`, async t => {
        const { hub, agent, seed } = await setup(t);
        await seed(longHistory ? 40 : 4, longHistory ? 9000 : 64);
        const data = `data:image/png;base64,${imageFixture().toString('base64')}`;
        const attachment =
          type === 'image'
            ? { type, image: data, mediaType: 'image/png' }
            : { type, data, mediaType: 'image/png', filename: 'upload.png' };
        const result = await (
          await agent({}, 'qwen3.8-max')
        )[mode]([{ role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, attachment] }], options);
        if (mode === 'stream') await result.consumeStream();
        assert.equal(await result.text, 'verified');
        assert.equal(hub.state.requests.filter(isSummary).length, longHistory ? 1 : 0);
        const main = hub.state.requests.filter(request => !isSummary(request)).at(-1).body;
        const received = main.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
        assert.ok(received.some(part => part.type === 'image_url' && part.image_url.url === data));
        assert.match(JSON.stringify(main.messages), /Describe this image/);
        if (longHistory) assert.match(JSON.stringify(main.messages), /<compacted-summary>/);
      });

test('DSH pressure policy reserves output, headroom and recent verbatim history', () => {
  assert.deepEqual(contextPolicy(1000000), {
    window: 131072,
    output: 8192,
    threshold: 57344,
    retain: 19660,
  });
});

test('old conversations compact with the current model when their last model was retired', async t => {
  const { hub, store, agent, seed } = await setup(t, false, false, { allowedModels: ['qwen3.8-max'] });
  await seed(40, 9000);
  await store.updateThreadMetadata({
    id: 'thread',
    resourceId: 'owner',
    update: current => ({
      ...current.metadata,
      dshContext: { lastRoute: { modelId: 'deepseek-v4-pro', level: 'off' } },
    }),
  });
  const result = await (await agent({}, 'qwen3.8-max')).generate('Continue this conversation.', options);
  assert.equal(result.text, 'verified');
  assert.ok(hub.state.requests.some(isSummary));
  assert.ok(hub.state.requests.every(request => request.body.model === 'internal-qwen-route'));
});

for (const mode of ['generate', 'stream'])
  test(`${mode}: resumes more than twenty original messages without using retired observations`, async t => {
    const { hub, store, agent, seed } = await setup(t);
    await seed(40, 64);
    const observation = await store.initializeObservationalMemory({
      threadId: 'thread',
      resourceId: 'owner',
      scope: 'thread',
      config: {},
    });
    await store.updateActiveObservations({
      id: observation.id,
      observations: 'RETIRED_OBSERVATION_SUMMARY',
      tokenCount: 10,
      lastObservedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 30)),
    });
    for (const prompt of ['Continue the original conversation', 'Continue after rebuilding the Agent']) {
      const result = await (await agent())[mode](prompt, options);
      if (mode === 'stream') await result.consumeStream();
      assert.equal(await result.text, 'verified');
      const request = JSON.stringify(hub.state.requests.at(-1).body);
      assert.doesNotMatch(request, /RETIRED_OBSERVATION_SUMMARY/);
      for (let i = 0; i < 40; i++)
        assert.ok(request.includes(`old-${i}: original fact`), `original message ${i} reaches the model`);
    }
    assert.equal(hub.state.requests.filter(isSummary).length, 0, 'short history stays verbatim');
    assert.equal(
      (await store.getObservationalMemory('thread', 'owner')).activeObservations,
      'RETIRED_OBSERVATION_SUMMARY',
    );
  });

for (const mode of ['generate', 'stream'])
  test(`${mode}: compacts old history and reloads its durable checkpoint`, async t => {
    const { hub, store, agent, seed } = await setup(t);
    await seed(40, 9000);
    const first = await (await agent())[mode]('CURRENT TASK: finish the original work', options);
    if (mode === 'stream') await first.consumeStream();
    assert.equal(await first.text, 'verified');
    assert.equal(hub.state.requests.filter(isSummary).length, 1);
    const main = hub.state.requests.filter(request => !isSummary(request)).at(-1).body;
    assert.match(JSON.stringify(main.messages), /<compacted-summary>/);
    assert.match(JSON.stringify(main.messages), /CURRENT TASK: finish the original work/);
    assert.match(JSON.stringify(main.messages), /old-39: original fact/);
    assert.doesNotMatch(JSON.stringify(main.messages), /old-0: original fact/);
    assert.match(JSON.stringify(main.messages), /Preserve the original system instructions/);
    const saved = await store.getThreadById({
      threadId: 'thread',
      resourceId: 'owner',
    });
    assert.equal(saved.metadata.unrelated, 'keep');
    assert.ok(saved.metadata.dshContext.checkpoint.covered > 0);
    assert.ok(saved.metadata.dshContext.measurement.input >= 0);
    const original = await store.listMessages({
      threadId: 'thread',
      resourceId: 'owner',
      perPage: 100,
    });
    assert.ok(original.messages.some(message => message.id === 'old-0'));
    const next = await (await agent())[mode]('NEXT TASK: continue', options);
    if (mode === 'stream') await next.consumeStream();
    assert.equal(
      hub.state.requests.filter(isSummary).length,
      1,
      'fresh processor reloads, rather than re-summarizing old messages',
    );
    assert.match(JSON.stringify(hub.state.requests.at(-1).body.messages), /<compacted-summary>/);
  });

test('compaction stays billable but is explicitly separated from the main model lifecycle', async t => {
  const { agent, seed, events } = await setup(t, true);
  await seed();
  const result = await (await agent()).generate('Continue working', options);
  assert.equal(result.text, 'verified');
  const spans = events.filter(event => event.type === TracingEventType.SPAN_ENDED).map(event => event.exportedSpan);
  const main = spans.find(span => span.type === SpanType.MODEL_GENERATION && span.metadata?.agentMainLoop);
  assert.ok(main, 'durable main-loop attribution is exported for UI accounting');
  const auxiliary = spans.find(
    span => span.type === SpanType.MODEL_INFERENCE && span.metadata?.auxiliary === 'compaction',
  );
  assert.ok(auxiliary);
  assert.equal(auxiliary.attributes.usage.inputTokens, 100);
  assert.equal(auxiliary.attributes.usage.inputDetails.cacheRead, 80);
  assert.equal(auxiliary.attributes.usage.outputTokens, 1);
  const step = spans.find(span => span.type === SpanType.MODEL_STEP);
  assert.equal(step.metadata.contextBreakdown.method, 'mastra-token-counter');
  assert.ok(
    step.metadata.contextBreakdown.messages < 57344,
    'counts the compacted projection, not the stored original history',
  );
});

test('long tool output is pruned only on the model projection and retains its complete tool pair', async t => {
  const { hub, store, agent } = await setup(t);
  hub.state.toolCallText = 'read';
  const large = '头'.repeat(4096) + '中'.repeat(250000) + '尾'.repeat(1024);
  const tool = createTool({
    id: 'countText',
    description: 'Read a large file',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    execute: async () => ({ text: large }),
  });
  const result = await (await agent({ countText: tool })).generate('Read the file', options);
  assert.equal(result.text, 'verified');
  assert.equal(hub.state.requests.filter(isSummary).length, 0);
  const main = hub.state.requests.at(-1).body;
  const toolMessage = main.messages.find(message => message.role === 'tool');
  assert.match(toolMessage.content, /tool result middle pruned/);
  assert.match(toolMessage.content, /头/);
  assert.match(toolMessage.content, /尾/);
  assert.ok(main.messages.some(message => message.tool_calls?.some(call => call.id === toolMessage.tool_call_id)));
  const saved = await store.listMessages({
    threadId: 'thread',
    resourceId: 'owner',
    perPage: 100,
  });
  assert.ok(JSON.stringify(saved.messages).includes(large), 'stored transcript retains the full tool output');
});

test('Qwen streams past the pressure threshold during a single turn with many document reads', async t => {
  const { hub, agent, store, seed } = await setup(t);
  await seed(4, 8000);
  const slices = Array.from({ length: 64 }, (_, index) => `page-${index}: ${'abcd'.repeat(1950)}`);
  const readPage = createTool({
    id: 'readPage',
    description: 'Read one page of the supplied manuscript.',
    inputSchema: z.object({ index: z.number().int() }),
    execute: async ({ index }) => slices[index],
  });
  let nextPage = 0;
  hub.state.nextToolCall = () => {
    if (nextPage >= slices.length) return;
    const index = nextPage++;
    return { id: `read-${index}`, name: 'readPage', args: { index } };
  };
  const request = 'Read all pages of the manuscript, then propose an adaptation.';
  const result = await (
    await agent({ readPage }, 'qwen3.8-max')
  ).stream(request, {
    ...options,
    maxSteps: slices.length + 2,
  });
  await result.consumeStream();
  assert.equal(await result.text, 'verified');
  assert.equal(nextPage, slices.length);

  const requests = hub.state.requests;
  const summaryIndex = requests.findIndex(
    entry => isSummary(entry) && JSON.stringify(entry.body.messages).includes('page-0:'),
  );
  assert.ok(summaryIndex > 0, 'at least one checkpoint summarizes early reads from the same turn');
  for (const entry of requests.slice(summaryIndex + 1).filter(entry => !isSummary(entry))) {
    const messages = entry.body.messages;
    assert.ok(messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(request)));
    assert.ok(messages.some(message => JSON.stringify(message.content).includes('<compacted-summary>')));
    const toolCalls = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id)));
    const toolResults = new Set(
      messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    );
    assert.deepEqual(toolResults, toolCalls);
    assert.ok(!JSON.stringify(messages).includes('page-0:'));
  }
  const last = requests.at(-1).body.messages;
  assert.ok(last.some(message => message.role === 'tool' && message.tool_call_id === `read-${slices.length - 1}`));
  const { messages } = await store.listMessages({ threadId: 'thread', resourceId: 'owner', perPage: false });
  assert.ok(JSON.stringify(messages).includes(slices[0]), 'the full document read is still in memory');

  const followUp = 'Give me the first scene from your adaptation.';
  const reopened = await (await agent({ readPage }, 'qwen3.8-max')).generate(followUp, options);
  assert.equal(reopened.text, 'verified');
  const resumed = JSON.stringify(requests.at(-1).body.messages);
  assert.ok(resumed.includes(followUp));
  assert.ok(resumed.includes('<compacted-summary>'));
  assert.ok(!resumed.includes('page-0:'));
});

for (const failure of ['empty', 'truncated'])
  test(`${failure} summaries never overwrite history or land a checkpoint`, async t => {
    const { hub, store, agent, seed } = await setup(t);
    await seed();
    if (failure === 'empty') hub.state.summaryText = '';
    else hub.state.summaryFinish = 'length';
    await assert.rejects((await agent()).generate('Keep working', options), /Context could not be compacted safely/);
    assert.equal(hub.state.requests.filter(isSummary).length, 2);
    const saved = await store.getThreadById({
      threadId: 'thread',
      resourceId: 'owner',
    });
    assert.equal(saved.metadata.dshContext?.checkpoint, undefined);
    const history = await store.listMessages({
      threadId: 'thread',
      resourceId: 'owner',
      perPage: 100,
    });
    assert.ok(history.messages.some(message => message.id === 'old-0'));
  });

test('confirmed upstream overflow gets one compaction retry with a changed request', async t => {
  const { hub, agent, seed } = await setup(t);
  await seed(6, 8000);
  hub.state.rejectContextOnce = true;
  const result = await (await agent()).generate('Continue after overflow', options);
  assert.equal(result.text, 'verified');
  assert.equal(hub.state.requests.filter(isSummary).length, 1);
  assert.match(JSON.stringify(hub.state.requests.at(-1).body.messages), /<compacted-summary>/);
  assert.doesNotMatch(JSON.stringify(hub.state.requests[0].body.messages), /<compacted-summary>/);
});

test('switching model uses the destination budget and summarizes with the last answered route', async t => {
  const { hub, agent, seed } = await setup(t);
  await (await agent()).generate('Initial task', options);
  await seed(10, 18000);
  hub.state.info.data.find(row => row.model_name === 'internal-qwen-route').model_info.max_input_tokens = 100000;
  // A fresh gateway snapshots the updated model/info, as it does after its cache expires.
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 60001);
  const result = await (await agent({}, 'qwen3.8-max')).generate('Switch and continue', options);
  assert.equal(result.text, 'verified');
  const summary = hub.state.requests.find(isSummary).body;
  assert.equal(summary.model, 'internal-deepseek-route');
  assert.equal(hub.state.requests.at(-1).body.model, 'internal-qwen-route');
  assert.match(JSON.stringify(hub.state.requests.at(-1).body.messages), /<compacted-summary>/);
});

test('cancelled summarization never commits a checkpoint or sends a continuation', async t => {
  const { hub, store, agent, seed } = await setup(t);
  await seed();
  const controller = new AbortController();
  let reached;
  const started = new Promise(resolve => {
    reached = resolve;
  });
  hub.state.onRequest = body => {
    if (body.messages.at(-1)?.content?.includes('You are now acting as a compaction engine')) reached();
  };
  hub.state.blocked = true;
  const pending = (await agent()).generate('Cancel this compaction', {
    ...options,
    abortSignal: controller.signal,
  });
  await started;
  controller.abort();
  hub.state.blocked = false;
  await pending.catch(() => {});
  const saved = await store.getThreadById({
    threadId: 'thread',
    resourceId: 'owner',
  });
  assert.equal(saved.metadata.dshContext?.checkpoint, undefined);
  assert.equal(hub.state.requests.filter(request => !isSummary(request)).length, 0);
});

test('memory off excludes stored history, working notes and observations while retaining stored records', async t => {
  const { hub, store, agent, seed, gateway } = await setup(t);
  await seed(4, 64);
  await store.saveResource({
    resource: { id: 'owner', workingMemory: 'PRIVATE_WORKING_NOTE', createdAt: new Date(), updatedAt: new Date() },
  });
  const instance = await agent({}, 'deepseek-v4-pro', {
    workingMemory: { enabled: true, scope: 'resource' },
    observationalMemory: { model: await gateway.resolveLanguageModel({ modelId: 'deepseek-v4-pro' }) },
  });
  const result = await instance.generate('CURRENT TASK ONLY', {
    ...options,
    memory: {
      ...options.memory,
      options: {
        lastMessages: false,
        semanticRecall: false,
        workingMemory: { enabled: false },
        observationalMemory: false,
      },
    },
  });
  assert.equal(result.text, 'verified');
  const main = hub.state.requests.filter(request => !isSummary(request)).at(-1).body;
  assert.doesNotMatch(JSON.stringify(main), /PRIVATE_WORKING_NOTE|old-0: original fact|updateWorkingMemory/);
  assert.match(JSON.stringify(main.messages), /CURRENT TASK ONLY/);
  const stored = await store.listMessages({ threadId: 'thread', resourceId: 'owner', perPage: 100 });
  assert.ok(stored.messages.some(message => message.id === 'old-0'));
});

for (const mode of ['generate', 'stream'])
  test(`${mode}: persists Mastra context estimates alongside the main model step`, async t => {
    const { agent, events } = await setup(t, true);
    const tool = createTool({
      id: 'countText',
      description: 'Count supplied text',
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ count: 1 }),
    });
    const result = await (await agent({ countText: tool }))[mode]('Count this Chinese text: 你好世界', options);
    if (mode === 'stream') await result.consumeStream();
    const steps = events
      .filter(event => event.type === TracingEventType.SPAN_ENDED)
      .map(event => event.exportedSpan)
      .filter(span => span.type === SpanType.MODEL_STEP);
    assert.ok(steps.length);
    const breakdown = steps.at(-1).metadata?.contextBreakdown;
    assert.equal(breakdown?.method, 'mastra-token-counter');
    assert.ok(breakdown.system > 0);
    assert.ok(breakdown.tools > 0);
    assert.ok(breakdown.messages > 0);
    const call = events
      .filter(event => event.type === TracingEventType.SPAN_ENDED)
      .map(event => event.exportedSpan)
      .find(span => span.type === SpanType.MODEL_INFERENCE);
    assert.equal(call.attributes.usage.inputDetails.text, 1);
  });

for (const mode of ['generate', 'stream'])
  test(`${mode}: persisted memory opt-out excludes history without frontend overrides`, async t => {
    const { hub, store, agent, seed } = await setup(t, false, true);
    await seed(4, 64);
    await store.saveResource({
      resource: { id: 'owner', workingMemory: 'PRIVATE_WORKING_NOTE', createdAt: new Date(), updatedAt: new Date() },
    });
    const instance = await agent({}, 'deepseek-v4-pro', { workingMemory: { enabled: true, scope: 'resource' } });
    const result = await instance[mode]('CURRENT TASK ONLY', {
      ...options,
      requestContext: new RequestContext([[MASTRA_NORMALIZED_USER_KEY, { id: 'owner' }]]),
      // Even a stale client requesting recall cannot override the saved opt-out.
      memory: { ...options.memory, options: { lastMessages: 20, workingMemory: { enabled: true } } },
    });
    if (mode === 'stream') await result.consumeStream();
    const request = hub.state.requests.filter(request => !isSummary(request)).at(-1).body;
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE_WORKING_NOTE|old-0: original fact|updateWorkingMemory/);
    assert.match(JSON.stringify(request.messages), /CURRENT TASK ONLY/);
    assert.ok(
      (await store.listMessages({ threadId: 'thread', resourceId: 'owner', perPage: 100 })).messages.some(
        message => message.id === 'old-0',
      ),
    );
  });
