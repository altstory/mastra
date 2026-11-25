import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALTFLOW_ACCOUNT_RESOURCE_KEY } from '@mastra/altflow-tools';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { Agent, createSignal } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { CreatorMemory } from '../src/mastra/agents/creator-memory.ts';
import { DisabledRecallMemory } from '../src/mastra/agents/disabled-recall-memory.ts';
import { creativeMemoryProcessor } from '../src/mastra/agents/creative-memory-processor.ts';
import { AccountPreferences } from '../src/mastra/services/account-preferences.ts';
import { accountMemory } from '../src/mastra/services/account-memory.ts';
import { ConversationProjects } from '../src/mastra/services/conversation-projects.ts';
import { CreativeMemoryStore } from '../src/mastra/services/creative-memory.ts';
import { CREATOR_MEMORY_OPTIONS } from '../src/mastra/context-memory.ts';
import { context, modelServer } from './tool-fixture.mjs';
import { setup as fileStorage } from './storage-fixture.mjs';

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
    const memory = new CreatorMemory({
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

  test(`${mode}: confirmed preferences travel with the author, project facts stay in the selected project and candidates stay local`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'altflow-creative-memory-'));
    const storage = new LibSQLStore({ id: 'creative', url: `file:${join(dir, 'messages.db')}` });
    await storage.init();
    const messages = await storage.getStore('memory');
    const projects = new ConversationProjects(`file:${join(dir, 'projects.db')}`, messages);
    const preferences = new AccountPreferences(`file:${join(dir, 'preferences.db')}`, messages);
    const database = `file:${join(dir, 'creative.db')}`;
    let store = new CreativeMemoryStore(database);
    await projects.init();
    await preferences.init();
    await store.init();
    const files = await fileStorage(t);
    const edge = await modelServer(t);
    t.after(async () => {
      store.close();
      projects.close();
      preferences.close();
      await storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    for (const id of ['a', 'b', 'c', 'd', 'bob'])
      await messages.saveThread({
        thread: {
          id,
          resourceId: id === 'bob' ? 'altflow:bob' : 'altflow:alice',
          title: id,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    for (const id of ['lynx', 'other'])
      await projects.command('alice', 'altflow:alice', { type: 'create', id, name: id });
    for (const threadId of ['a', 'c'])
      await projects.command('alice', 'altflow:alice', { type: 'move', threadId, projectId: 'lynx' });
    await projects.command('alice', 'altflow:alice', { type: 'move', threadId: 'd', projectId: 'other' });
    const build = () => {
      const memory = new CreatorMemory({
        storage,
        options: { ...CREATOR_MEMORY_OPTIONS, semanticRecall: false, generateTitle: false },
      });
      const agent = new Agent({
        id: 'creator-agent',
        name: 'Creator',
        instructions: 'Help the author.',
        model: edge.model,
        memory: accountMemory(
          preferences,
          memory,
          new DisabledRecallMemory({ storage, options: { generateTitle: false } }),
        ),
        inputProcessors: [
          creativeMemoryProcessor({ store, memory: messages, projects, preferences, files: files.store }),
        ],
      });
      new Mastra({ agents: { creator: agent }, storage });
      return agent;
    };
    let agent = build();
    const run = async (thread, text, calls = [], owner = 'alice') => {
      const start = edge.requests.length;
      if (calls.length) edge.responses.push({ calls }, { text: 'Done.' });
      const result = await agent[mode](text, {
        memory: { thread, resource: `altflow:${owner}` },
        requestContext: context(owner),
        maxSteps: 3,
      });
      await result.text;
      return edge.requests.slice(start);
    };
    const remember = args => ({ name: 'remember', args: { revision: 0, status: 'confirmed', ...args } });
    const author = '以后给我反馈时先指出问题，再给建议。';
    const agreement = '确认《山猫轩》做十二集互动漫剧。';
    const fact = '设定 v1 中铃木是山田的姐姐。';
    const userText = [author, agreement, fact].join('\n');
    const first = await run('a', userText, [
      remember({ kind: 'author_preference', key: 'feedback', content: '反馈先指出问题再给建议', evidence: author }),
      remember({ kind: 'project_agreement', key: 'format', content: '山猫轩十二集互动漫剧', evidence: agreement }),
      remember({ kind: 'story_fact', key: 'siblings', content: '铃木是山田的姐姐', version: 'v1', evidence: fact }),
    ]);
    assert.equal(
      (await store.read('alice', 'lynx')).filter(entry => entry.status === 'confirmed' && entry.key !== 'user-name')
        .length,
      3,
    );
    assert.ok(!JSON.stringify(first[0].messages).includes('If information might be referenced again - store it!'));
    await run('a', '还没有选方向。', [
      { name: 'updateWorkingMemory', args: { memory: '# 待用户决定\n选择红色结局还是蓝色结局（未确认）' } },
    ]);

    store.close();
    store = new CreativeMemoryStore(database);
    await store.init();
    agent = build();
    const same = JSON.stringify(await run('c', '这个项目有哪些已确认的约定？'));
    assert.ok(same.includes('山猫轩十二集互动漫剧'));
    assert.ok(same.includes('铃木是山田的姐姐'));
    assert.ok(!same.includes('选择红色结局还是蓝色结局'));
    for (const thread of ['b', 'd', 'brand-new-thread']) {
      const other = JSON.stringify(await run(thread, '你好。'));
      assert.ok(other.includes('反馈先指出问题再给建议'));
      assert.ok(!other.includes('山猫轩十二集互动漫剧'));
      assert.ok(!other.includes('铃木是山田的姐姐'));
    }
    const stranger = JSON.stringify(await run('bob', '你好。', [], 'bob'));
    assert.ok(!stranger.includes('反馈先指出问题再给建议'));
    assert.ok(!stranger.includes('山猫轩十二集互动漫剧'));

    await run('c', '我还没决定。', [
      remember({
        kind: 'project_agreement',
        key: 'unconfirmed',
        content: '采用红色结局',
        evidence: '用户已确认采用红色结局',
      }),
      remember({
        kind: 'project_agreement',
        key: 'candidate',
        status: 'candidate',
        content: '采用蓝色结局',
        evidence: '我还没决定。',
      }),
      remember({ kind: 'story_fact', key: 'no-version', content: '角色年龄二十岁', evidence: '我还没决定。' }),
    ]);
    assert.equal((await store.read('alice', 'lynx')).length, 3);
    await run('b', '确认做十集。', [
      remember({ kind: 'project_agreement', key: 'unbound', content: '十集', evidence: '确认做十集。' }),
    ]);
    assert.equal((await store.read('alice')).length, 1);

    await run('c', '更正，山猫轩改为八集。', [
      remember({
        kind: 'project_agreement',
        key: 'format',
        revision: 1,
        content: '山猫轩八集互动漫剧',
        evidence: '更正，山猫轩改为八集。',
      }),
    ]);
    await run('c', '确认做十集。', [
      remember({
        kind: 'project_agreement',
        key: 'format',
        revision: 1,
        content: '山猫轩十集',
        evidence: '确认做十集。',
      }),
    ]);
    assert.equal(
      (await store.read('alice', 'lynx')).find(entry => entry.key === 'format').content,
      '山猫轩八集互动漫剧',
    );
    await projects.command('alice', 'altflow:alice', { type: 'move', threadId: 'c', projectId: 'other' });
    // Check injected state, since the moved conversation still has its own historical messages.
    const moved = await run('c', '当前项目有哪些约定？');
    const system = moved[0].messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n');
    assert.ok(!system.includes('山猫轩八集互动漫剧'));

    await files.store.write('alice', '/constitution.md', Buffer.from('v1 approved rule'));
    await run('a', '确认本项目采用这份宪法的逻辑一致性原则，版本 v1。', [
      remember({
        kind: 'project_agreement',
        key: 'constitution',
        content: '场景因果必须自洽',
        version: 'v1',
        document: '/constitution.md',
        evidence: '确认本项目采用这份宪法的逻辑一致性原则，版本 v1。',
      }),
    ]);
    assert.equal(
      (await store.read('alice', 'lynx')).find(entry => entry.key === 'constitution').document.path,
      '/constitution.md',
    );
    await files.store.write('alice', '/constitution.md', Buffer.from('v2 changed rule'));
    await projects.command('alice', 'altflow:alice', { type: 'move', threadId: 'c', projectId: 'lynx' });
    const changed = (await run('c', '读取现在的项目约定。'))[0].messages.filter(message => message.role === 'system');
    assert.ok(JSON.stringify(changed).includes('source_changed'));
    assert.ok(!JSON.stringify(changed).includes('场景因果必须自洽'));

    await run('a', '这条临时约定现已过期。', [
      remember({
        kind: 'project_agreement',
        key: 'expired',
        content: '过期的试作期约定',
        expiresAt: '2000-01-01T00:00:00Z',
        evidence: '这条临时约定现已过期。',
      }),
    ]);
    const expired = (await run('c', '当前有效约定有哪些？'))[0].messages.filter(message => message.role === 'system');
    assert.ok(expired.some(message => message.content.includes('"status":"expired"')));
    assert.ok(!JSON.stringify(expired).includes('过期的试作期约定'));

    await run('b', '忘记我的反馈顺序偏好。', [
      {
        name: 'forget_memory',
        args: {
          kind: 'author_preference',
          key: 'feedback',
          revision: 1,
          evidence: '忘记我的反馈顺序偏好。',
        },
      },
    ]);
    assert.equal((await store.read('alice')).find(entry => entry.key === 'feedback').content, undefined);
    const webRun = async (owner, thread, text, calls = []) => {
      const start = edge.requests.length;
      const resource = 'altflow-creator:' + owner;
      const requestContext = context(owner);
      requestContext.set(MASTRA_RESOURCE_ID_KEY, resource);
      requestContext.setRaw(ALTFLOW_ACCOUNT_RESOURCE_KEY, resource);
      requestContext.setRaw('altflow.creatorGateway', { userId: owner, conversationId: thread.slice(5) });
      if (calls.length) edge.responses.push({ calls }, { text: 'Done.' });
      const result = await agent[mode](createSignal({ type: 'user-message', contents: text }), {
        memory: { thread, resource },
        requestContext,
        maxSteps: 3,
      });
      await result.text;
      return JSON.stringify(edge.requests.slice(start));
    };
    const declaredName = '我叫青榆';
    await webRun('alice', 'free:one', declaredName, [
      remember({ kind: 'author_preference', key: 'user-name', content: '青榆', evidence: declaredName }),
    ]);
    assert.equal((await store.read('alice')).find(entry => entry.key === 'user-name')?.content, '青榆');
    assert.match(await webRun('alice', 'free:two', '你记得我的姓名吗？'), /青榆/);
    assert.doesNotMatch(await webRun('bob', 'free:other', '你记得我的姓名吗？'), /青榆/);
    await webRun('alice', 'free:one', '这个项目暂定叫松岚。', [
      remember({ kind: 'project_agreement', key: 'work-name', content: '松岚', evidence: '这个项目暂定叫松岚。' }),
    ]);
    assert.doesNotMatch(await webRun('alice', 'free:two', '还记得我在做什么吗？'), /松岚/);

    await preferences.write('alice', 'altflow:alice', {
      kind: 'memory',
      id: 'creator-agent',
      patch: { enabled: false },
    });
    const off = await run('a', '你好。');
    assert.ok(!JSON.stringify(off[0].messages).includes('山猫轩八集互动漫剧'));
    assert.ok(
      !off[0].tools?.some(tool => ['remember', 'forget_memory', 'updateWorkingMemory'].includes(tool.function.name)),
    );
  });
}

test('concurrent corrections cannot silently overwrite another conversation’s confirmed memory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'altflow-memory-conflict-'));
  const url = `file:${join(dir, 'memory.db')}`;
  const stores = [new CreativeMemoryStore(url), new CreativeMemoryStore(url)];
  t.after(async () => {
    stores.forEach(store => store.close());
    await rm(dir, { recursive: true, force: true });
  });
  for (const store of stores) await store.init();
  const entry = {
    kind: 'project_agreement',
    key: 'episodes',
    status: 'confirmed',
    content: '十二集',
    source: { threadId: 'a', messageId: 'm1', quote: '确认十二集' },
  };
  await stores[0].write('alice', 'lynx', 0, entry);
  for (let revision = 1; revision <= 20; revision++) {
    const attempts = await Promise.allSettled(
      stores.map((store, i) => store.write('alice', 'lynx', revision, { ...entry, content: `更正 ${revision}-${i}` })),
    );
    const succeeded = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(succeeded.length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    assert.match(attempts.find(result => result.status === 'rejected').reason.message, /记忆已更新/);
    const [saved] = await stores[1].read('alice', 'lynx');
    assert.equal(saved.revision, revision + 1);
    assert.equal(saved.content, succeeded[0].value.content);
  }
});
