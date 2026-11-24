import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createClient } from '@libsql/client';
import { LibSQLSessionSearch } from '@mastra/altflow-tools';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { createTool, TaskStateProcessor } from '@mastra/core/tools';
import { createWorkspaceTools, createSkillTools } from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { executionPolicy } from '../src/mastra/agents/execution-policy.ts';
import { HistoryMemory } from '../src/mastra/agents/history-memory.ts';
import { SharedSkillSource } from '../src/mastra/services/shared-skills.ts';
import { createAgentTree } from '../src/mastra/subagents/agents.ts';
import { SubagentStore } from '../src/mastra/subagents/store.ts';
import { createCreatorTools } from '../src/mastra/tools/index.ts';

// Only the paid model edge is a fixture. Agent execution, suspension, memory,
// tool schemas, filesystem authorization and SQLite persistence are real.
export async function modelServer(t) {
  let handler;
  const requests = [],
    responses = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const next = (await handler?.(body)) ?? responses.shift() ?? { text: 'Verified.' };
    if (next.status) {
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Fixture provider failure' } }));
      return;
    }
    if (next.block) {
      next.started();
      res.on('close', next.closed);
      return;
    }
    const calls = next.calls?.map((call, index) => ({
      id: `call-${requests.length}-${index}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    const finish = calls ? 'tool_calls' : 'stop';
    const base = {
      id: `response-${requests.length}`,
      created: 1,
      model: 'fixture-model',
    };
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({
        ...base,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: calls
              ? {
                  role: 'assistant',
                  tool_calls: calls.map((call, index) => ({ index, ...call })),
                }
              : { role: 'assistant', content: next.text },
            finish_reason: null,
          },
        ],
      });
      send({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: calls ? null : next.text,
                ...(calls ? { tool_calls: calls } : {}),
              },
              finish_reason: finish,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const provider = createOpenAICompatible({
    name: 'tool-fixture',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'fixture-only',
  });
  return {
    requests,
    responses,
    setHandler: value => {
      handler = value;
    },
    model: provider.chatModel('fixture-model'),
  };
}
export function context(userId) {
  const requestContext = new RequestContext();
  requestContext.setRaw(MASTRA_NORMALIZED_USER_KEY, { id: userId });
  requestContext.set(MASTRA_RESOURCE_ID_KEY, `altflow:${userId}`);
  return requestContext;
}
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'altflow-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = `file:${join(dir, 'memory.db')}`;
  const storage = new LibSQLStore({ id: 'runtime', url });
  await storage.init();
  const client = createClient({ url });
  t.after(() => client.close());
  const edge = await modelServer(t);
  const memory = new HistoryMemory({
    storage,
    options: {
      lastMessages: 100,
      semanticRecall: false,
      observationalMemory: false,
      workingMemory: { enabled: false },
      generateTitle: false,
    },
  });
  const bundle = createCreatorTools({
    env: {},
    countText: createTool({
      id: 'count-text',
      description: 'Count characters',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ count: text.length }),
    }),
    sessionSearch: new LibSQLSessionSearch(client),
    delivery: { present: async () => [] },
    projectFiles: { list: async () => [] },
  });
  const memoryStore = await storage.getStore('memory');
  const treeStore = new SubagentStore(`file:${join(dir, 'subagents.db')}`);
  await treeStore.init();
  let teamEnabled = true;
  const tree = createAgentTree({
    store: treeStore,
    memory: memoryStore,
    childMemory: memory,
    model: edge.model,
    tools: bundle.tools,
    teamEnabled: async () => teamEnabled,
    getMastra: () => mastra,
    getRootAgent: () => agent,
  });
  t.after(async () => {
    await tree.runtime.close();
    treeStore.close();
  });
  const agent = new Agent({
    id: 'creator-agent',
    name: 'Creator',
    instructions: 'Use the requested tool.',
    model: edge.model,
    tools: { ...bundle.tools, ...tree.tools },
    memory,
    inputProcessors: [new TaskStateProcessor(), tree.processor],
    defaultOptions: { maxSteps: 4 },
  });
  const mastra = new Mastra({ agents: { agent }, storage, logger: false });
  return {
    ...edge,
    dir,
    url,
    storage,
    memory,
    bundle,
    mastra,
    tree,
    treeStore,
    memoryStore,
    setTeamEnabled: value => {
      teamEnabled = value;
    },
    agent: mastra.getAgent('agent'),
  };
}
export function runOptions(thread = 'alice-thread') {
  return {
    memory: { thread, resource: 'altflow:alice' },
    requestContext: context('alice'),
  };
}
export function toolResults(result) {
  return result.steps.flatMap(step => step.toolResults ?? []);
}
