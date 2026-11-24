import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { HistoryMemory } from '../src/mastra/agents/history-memory.ts';
import { CREATOR_MEMORY_OPTIONS } from '../src/mastra/context-memory.ts';
import { modelServer } from './tool-fixture.mjs';

const embedder = {
  specificationVersion: 'v2',
  provider: 'fixture',
  modelId: 'constant',
  maxEmbeddingsPerCall: 16,
  supportsParallelCalls: true,
  doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0, 0, 0]) }),
};

for (const mode of ['stream', 'generate']) {
  test(`${mode}: a new conversation starts without the old conversation's pending choices`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'altflow-recall-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const storage = new LibSQLStore({ id: 'recall', url: `file:${join(dir, 'memory.db')}` });
    const vector = new LibSQLVector({ id: 'recall-vectors', url: `file:${join(dir, 'vectors.db')}` });
    const edge = await modelServer(t);
    const memory = new HistoryMemory({
      storage,
      vector,
      embedder,
      options: { ...CREATOR_MEMORY_OPTIONS, generateTitle: false },
    });
    const agent = new Agent({
      id: 'creator-agent',
      name: 'Creator',
      instructions: 'Reply briefly.',
      model: edge.model,
      memory,
    });
    const resource = 'altflow:alice';
    const transcript = '请在甲和乙之间选一个，我等你回复。';
    const notes = '工作记忆：待确认制作预算';
    const legacyNotes = '旧账号记忆：待确定另一部作品的结局';
    const ask = async (thread, messages) => {
      const start = edge.requests.length;
      const response = await agent[mode](messages, { memory: { thread, resource }, maxSteps: 3 });
      await response.text;
      return JSON.stringify(edge.requests.slice(start).flatMap(call => call.messages));
    };

    await storage.init();
    const store = await storage.getStore('memory');
    const now = new Date();
    await store.saveResource({
      resource: { id: resource, workingMemory: legacyNotes, createdAt: now, updatedAt: now },
    });
    edge.responses.push(
      { calls: [{ name: 'updateWorkingMemory', args: { memory: `# 创作进度\n${notes}` } }] },
      { text: transcript },
    );
    await ask('thread-a', '帮我定一个故事方案，制作预算还没有定。');
    assert.match(await memory.getWorkingMemory({ threadId: 'thread-a', resourceId: resource }), /待确认制作预算/);
    await memory.settled({ threadId: 'thread-a', resourceId: resource });

    const fresh = await ask('thread-b', '你好，你是什么模型？');
    assert.deepEqual(
      [transcript, notes, legacyNotes].filter(text => fresh.includes(text)),
      [],
      'the new conversation must not receive any of the old transcript or working notes',
    );
    const continued = await ask('thread-a', '我们继续。');
    assert.ok(continued.includes(transcript));
    assert.ok(continued.includes(notes));
    assert.ok(!continued.includes(legacyNotes));
  });
}
