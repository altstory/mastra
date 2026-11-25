import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { SpanType } from '@mastra/core/observability';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { ModelHubGateway } from '../src/mastra/modelhub-gateway.ts';
import { modelHubFixture } from './modelhub-fixture.mjs';

test('streaming chat retains input, output and cache usage after switching product models', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  hub.state.usage = {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    prompt_tokens_details: { cached_tokens: 80 },
  };
  const gateway = new ModelHubGateway({ apiKey: 'test', baseURL: hub.baseURL });
  for (const modelId of ['deepseek-v4-pro', 'qwen3.8-max']) {
    const model = await gateway.resolveLanguageModel({ modelId });
    const options = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    };
    const result = await model.doStream(options);
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    const finish = chunks.find(chunk => chunk.type === 'finish');
    assert.equal(finish?.usage.inputTokens.total, 100, `${modelId} streaming input usage`);
    assert.equal(finish.usage.inputTokens.cacheRead, 80);
    assert.equal(finish.usage.inputTokens.noCache, 20);
    assert.equal(finish.usage.outputTokens.total, 5);
    const generated = await model.doGenerate(options);
    assert.deepEqual(generated.usage, finish.usage);
  }
});

test('ModelHub catalog drives listing and real SDK request routing, including cached instances', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  const gateway = new ModelHubGateway({ apiKey: 'server-test-key', baseURL: hub.baseURL });
  const providers = await gateway.fetchProviders();
  assert.deepEqual(Object.keys(providers), ['altflow']);
  assert.deepEqual(providers.altflow.models, ['deepseek-v4-pro', 'qwen3.8-max']);
  assert.equal(JSON.stringify(gateway).includes('server-test-key'), false);
  await assert.rejects(gateway.resolveLanguageModel({ modelId: 'gpt-external' }));
  const model = await gateway.resolveLanguageModel({ modelId: 'qwen3.8-max' });
  const generate = () =>
    model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { altflow: { reasoning_effort: 'wrong', modelhub_thinking_budget: 99 } },
    });
  await generate();
  assert.equal(hub.state.requests[0].authorization, 'Bearer server-test-key');
  assert.equal(hub.state.requests[0].body.model, 'internal-qwen-route');
  assert.equal(hub.state.requests[0].body.modelhub_reasoning_effort, 'high');
  assert.equal(hub.state.requests[0].body.modelhub_thinking_budget, 8000);
  assert.equal('reasoning_effort' in hub.state.requests[0].body, false);
  assert.equal(hub.state.requests[0].body.metadata.modelhub_product_model, 'qwen3.8-max');
  assert.equal(hub.state.catalogs, 1);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.setTime(now + 60001);
  hub.state.catalog.config_version = 2;
  hub.state.catalog.free_chat_models[1].thinking_options[0].target = 'new-qwen-route';
  await generate();
  assert.equal(hub.state.requests[1].body.model, 'new-qwen-route');
  assert.equal(hub.state.requests[1].body.metadata.modelhub_catalog_version, '2');
  t.mock.timers.setTime(Date.now() + 60001);
  hub.state.unavailable = true;
  await generate();
  assert.equal(hub.state.requests[2].body.model, 'new-qwen-route', 'temporary failure retains validated snapshot');
});

test('the inference trace records the effective ModelHub settings sent over HTTP', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  const gateway = new ModelHubGateway({ apiKey: 'trace-test-key', baseURL: hub.baseURL });
  const duck = new DuckDBStore({ path: ':memory:', threads: 1 });
  const storage = new MastraCompositeStore({
    id: 'modelhub-trace',
    default: new LibSQLStore({ id: 'modelhub-trace-default', url: ':memory:' }),
    domains: { observability: duck.observability },
  });
  const exporter = new MastraStorageExporter({ maxBatchWaitMs: 25 });
  t.after(async () => {
    await exporter.shutdown();
    await duck.close();
  });
  const agent = new Agent({
    id: 'modelhub-trace-agent',
    name: 'Trace fixture',
    instructions: 'Reply briefly.',
    model: await gateway.resolveLanguageModel({ modelId: 'qwen3.8-max' }),
  });
  new Mastra({
    agents: { agent },
    storage,
    logger: false,
    observability: new Observability({
      configs: { default: { serviceName: 'modelhub-trace', exporters: [exporter] } },
    }),
  });
  await agent.generate('Hello');
  await exporter.flush();
  const {
    spans: [run],
  } = await duck.observability.listTracesLight({ filters: { spanType: SpanType.AGENT_RUN } });
  assert.ok(run);
  const { spans } = await duck.observability.getTrace({ traceId: run.traceId });
  const inference = spans.find(span => span.spanType === SpanType.MODEL_INFERENCE);
  const sent = hub.state.requests[0].body;
  assert.deepEqual(inference.metadata.modelHubRequest, {
    productModel: sent.metadata.modelhub_product_model,
    targetModel: sent.model,
    reasoningLevel: sent.modelhub_reasoning_effort,
    reasoningBudget: sent.modelhub_thinking_budget,
    maxOutputTokens: sent.max_tokens,
    catalogVersion: Number(sent.metadata.modelhub_catalog_version),
  });
  assert.doesNotMatch(JSON.stringify(inference.metadata), /trace-test-key/);
});

test('invalid or unavailable first catalog fails closed', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  for (const corrupt of [
    catalog => {
      catalog.free_chat_models = [];
    },
    catalog => {
      catalog.free_chat_models.push(catalog.free_chat_models[0]);
    },
    catalog => {
      catalog.free_chat_models[0].default_thinking_level = 'missing';
    },
  ]) {
    const original = structuredClone(hub.state.catalog);
    corrupt(hub.state.catalog);
    await assert.rejects(new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL }).fetchProviders());
    hub.state.catalog = original;
  }
  hub.state.unavailable = true;
  await assert.rejects(new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL }).fetchProviders());
  assert.throws(() => new ModelHubGateway({ apiKey: 'test-key', baseURL: 'http://untrusted.example/v1' }));
});

test('catalog publishes names and supported reasoning; a selected level controls the upstream route', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  hub.state.catalog.free_chat_models[1].thinking_options.push({
    level: 'off',
    target: 'qwen-no-thinking',
    supports_thinking_level: false,
    supports_thinking_budget: false,
  });
  const gateway = new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL });
  const providers = await gateway.fetchProviders();
  assert.equal(providers.altflow.modelNames['qwen3.8-max'], 'Qwen3.8 Max');
  assert.deepEqual(providers.altflow.modelReasoning['qwen3.8-max'], {
    defaultLevel: 'high',
    levels: ['high', 'off'],
    contextWindows: { high: 262144 },
  });
  const model = await gateway.resolveLanguageModel({ modelId: 'qwen3.8-max' });
  const generate = level =>
    model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { altflow: { reasoningLevel: level } },
    });
  await generate('off');
  assert.equal(hub.state.requests[0].body.model, 'qwen-no-thinking');
  assert.equal(hub.state.requests[0].body.metadata.modelhub_thinking_level, 'off');
  assert.equal('modelhub_reasoning_effort' in hub.state.requests[0].body, false);
  assert.equal('modelhub_thinking_budget' in hub.state.requests[0].body, false);
  assert.equal('reasoningLevel' in hub.state.requests[0].body, false);
  await generate('high');
  assert.equal(hub.state.requests[1].body.modelhub_thinking_budget, 8000);
  await assert.rejects(generate('unsupported'), /reasoning level/);
  assert.equal(hub.state.requests.length, 2);
});

test('model/info supplies exact per-reasoning route capacities without guessing output limits as context', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  hub.state.catalog.free_chat_models[1].thinking_options.push({
    level: 'off',
    target: 'qwen-no-thinking',
    supports_thinking_level: false,
    supports_thinking_budget: false,
  });
  hub.state.info.data.push(
    { model_name: 'qwen-no-thinking', model_info: { max_input_tokens: 991808, context_window: 1048576 } },
    { model_name: 'internal-qwen-route', model_info: { max_input_tokens: 1048576 } },
  );
  const gateway = new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL });
  const { altflow } = await gateway.fetchProviders();
  assert.equal(altflow.modelContextWindows['deepseek-v4-pro'], 262144);
  assert.equal(altflow.modelContextWindows['qwen3.8-max'], 262144);
  assert.deepEqual(altflow.modelReasoning['qwen3.8-max'].contextWindows, { high: 262144, off: 262144 });
  await gateway.fetchProviders();
  assert.equal(hub.state.infos, 1);
});

test('missing or unavailable model/info never fabricates a context capacity or blocks chat', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  hub.state.info.data = [{ model_name: 'internal-deepseek-route', model_info: { max_output_tokens: 131072 } }];
  const missing = await new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL }).fetchProviders();
  assert.deepEqual(missing.altflow.modelContextWindows, {});
  hub.state.infoStatus = 403;
  const gateway = new ModelHubGateway({ apiKey: 'test-key', baseURL: hub.baseURL });
  const unavailable = await gateway.fetchProviders();
  assert.deepEqual(unavailable.altflow.modelContextWindows, {});
  assert.equal((await gateway.resolveLanguageModel({ modelId: 'deepseek-v4-pro' })).modelId, 'deepseek-v4-pro');
});

test('gateway caps output for every call while retaining the physical model/info limit', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  const gateway = new ModelHubGateway({ apiKey: 'test', baseURL: hub.baseURL });
  assert.equal((await gateway.modelInfo())['internal-deepseek-route'], 1048576);
  const model = await gateway.resolveLanguageModel({ modelId: 'deepseek-v4-pro' });
  await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxOutputTokens: 64000,
  });
  assert.equal(hub.state.requests.at(-1).body.max_tokens, 8192);
  await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxOutputTokens: 100,
  });
  assert.equal(hub.state.requests.at(-1).body.max_tokens, 100);
});

test('deployment model policy limits listing and execution to Qwen with medium defaults', async t => {
  const hub = await modelHubFixture();
  t.after(hub.close);
  const qwen = hub.state.catalog.free_chat_models[1];
  qwen.thinking_options.push({ ...qwen.thinking_options[0], level: 'medium', target: 'qwen-medium' });
  hub.state.catalog.free_chat_models.push({ ...structuredClone(qwen), id: 'qwen3.8-flash' });
  const gateway = new ModelHubGateway({
    apiKey: 'test',
    baseURL: hub.baseURL,
    allowedModels: ['qwen3.8-flash', 'qwen3.8-max'],
    defaultReasoningLevel: 'medium',
  });
  const provider = (await gateway.fetchProviders()).altflow;
  assert.deepEqual([...provider.models].sort(), ['qwen3.8-flash', 'qwen3.8-max']);
  for (const id of provider.models) {
    assert.equal(provider.modelReasoning[id].defaultLevel, 'medium');
    const model = await gateway.resolveLanguageModel({ modelId: id });
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    assert.equal(hub.state.requests.at(-1).body.model, 'qwen-medium');
  }
  await assert.rejects(gateway.resolveLanguageModel({ modelId: 'deepseek-v4-pro' }));
});
