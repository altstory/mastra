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
import {
  LocalFilesystem,
  Workspace,
  createWorkspaceTools,
  createSkillTools,
  publishSkillFromSource,
} from '@mastra/core/workspace';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { serve } from '@hono/node-server';
import { createHonoServer } from '../../../packages/deployer/dist/server/index.js';
import { executionPolicy } from '../src/mastra/agents/execution-policy.ts';
import { HistoryMemory } from '../src/mastra/agents/history-memory.ts';
import { createPrivateWorkspace } from '../src/mastra/agents/private-workspace.ts';
import { protectConversationResponses } from '../src/mastra/agents/reference-visibility.ts';
import { createAltFlowAuth } from '../src/mastra/altflow-auth.ts';
import { SharedSkillSource } from '../src/mastra/services/shared-skills.ts';
import { createCreatorTools } from '../src/mastra/tools/index.ts';
import { UserStorage } from '../src/mastra/user-storage.ts';

import { fixture, context, modelServer, runOptions, toolResults } from './tool-fixture.mjs';

test('internal knowledge and skill tool results reach the Agent but stay out of chat responses and reopened history', async t => {
  const { Knowledge, knowledgeMemoryScopes } = await import('@mastra/core/knowledge');
  const { KNOWLEDGE_ROUTES } = await import('@mastra/server/server-adapter');
  const storage = new LibSQLStore({ id: 'reference-visibility', url: ':memory:' });
  const knowledge = new Knowledge({
    id: 'fixture-knowledge',
    storage,
    tools: true,
    scopes: {
      ...knowledgeMemoryScopes({ org: false }),
      'audience:$audience': { access: [{ principal: 'self', role: 'viewer' }] },
      'library:$libraryId': {
        access: [
          { principal: 'self', role: 'owner' },
          { principal: 'audience:creators', role: 'viewer' },
        ],
      },
    },
  });
  const secret = 'FIXTURE_REFERENCE_PRIVATE_MARKER';
  const { page } = await knowledge.upsertPage({
    scope: 'library:creator',
    path: 'internal',
    name: 'Private guide',
    body: secret,
  });
  const skillSecret = 'FIXTURE_SKILL_PRIVATE_MARKER';
  const dir = await mkdtemp(join(tmpdir(), 'altflow-reference-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'skills', 'private-style'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'private-style', 'SKILL.md'),
    `---\nname: private-style\ndescription: Style fixture\n---\n${skillSecret}\n`,
  );
  const workspace = new Workspace({
    id: 'reference-fixture',
    filesystem: new LocalFilesystem({ basePath: dir }),
    skills: ['skills'],
  });
  const edge = await modelServer(t);
  const backend = createServer((req, res) => {
    const role = req.headers.authorization === 'Bearer admin' ? 'admin' : 'creator';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, message: 'OK', data: { userId: role, username: role, role } }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    backend.closeAllConnections();
    return new Promise(resolve => backend.close(resolve));
  });
  const accounts = createAltFlowAuth({
    backendUrl: `http://127.0.0.1:${backend.address().port}`,
    origins: [],
    secureCookies: false,
  });
  const agent = new Agent({
    id: 'creator-agent',
    name: 'Creator',
    instructions: 'Use the requested tool.',
    model: edge.model,
    memory: new Memory({ storage, options: { lastMessages: 10, generateTitle: false } }),
    scopes: ({ scopes }) => scopes,
    knowledge,
    workspace,
  });
  const mastra = new Mastra({
    agents: { 'creator-agent': agent },
    knowledge: { fixture: knowledge },
    logger: false,
    storage,
    server: {
      apiRoutes: [...KNOWLEDGE_ROUTES],
      auth: accounts.auth,
      middleware: protectConversationResponses,
    },
  });
  const app = await createHonoServer(mastra);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const request = (path, role, body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  assert.equal((await request('/knowledge', 'creator')).status, 403);
  assert.equal((await request('/knowledge', 'admin')).status, 200);
  for (const path of ['/agents', '/agents/creator-agent']) {
    const admin = await request(path, 'admin');
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /private-style/);
    const ordinary = await request(path, 'creator');
    assert.equal(ordinary.status, 200);
    assert.doesNotMatch(await ordinary.text(), /private-style|Style fixture/);
  }
  const protectedContent = /FIXTURE_(REFERENCE|SKILL)_PRIVATE_MARKER|knowledge_read|Private guide|private-style/;
  for (const method of ['stream', 'generate']) {
    const thread = `private-reference-${method}`;
    edge.responses.push(
      {
        calls: [
          { name: 'knowledge_read', args: { page: page.id } },
          { name: 'skill', args: { name: 'private-style' } },
        ],
      },
      { text: 'Original work.' },
    );
    const response = await request(`/agents/creator-agent/${method}`, 'creator', {
      messages: 'Help with my draft.',
      memory: { thread },
    });
    assert.equal(response.status, 200);
    const wire = await response.text();
    const modelMessages = JSON.stringify(edge.requests.at(-1)?.messages);
    assert.ok(modelMessages.includes(secret));
    assert.ok(modelMessages.includes(skillSecret));
    assert.match(wire, /Original work/);
    assert.doesNotMatch(wire, protectedContent);
    const history = await request(`/memory/threads/${thread}/messages?agentId=creator-agent`, 'creator');
    assert.equal(history.status, 200);
    const saved = await history.text();
    assert.match(saved, /Original work/);
    assert.doesNotMatch(saved, protectedContent);
  }
  const subscription = await request('/agents/creator-agent/threads/subscribe', 'creator', {
    threadId: 'private-reference-stream',
    withInitialHistory: true,
  });
  assert.equal(subscription.status, 200);
  const reader = subscription.body.getReader();
  try {
    const decoder = new TextDecoder();
    let wire = '';
    while (!wire.includes('Original work')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      wire += decoder.decode(value, { stream: true });
    }
    assert.match(wire, /thread-history/);
    assert.doesNotMatch(wire, protectedContent);
  } finally {
    await reader.cancel();
  }
});

test('native task tools persist through a real Agent run and a reopened LibSQL store', async t => {
  const f = await fixture(t);
  assert.equal(Object.keys(f.bundle.tools).length, 11);
  assert.ok('validate_script_format' in f.bundle.tools);
  assert.equal('web_search' in f.bundle.tools, false);
  assert.equal(
    Object.keys(f.bundle.tools).some(name => name.startsWith('schedule')),
    false,
  );
  f.responses.push(
    {
      calls: [
        {
          name: 'task_write',
          args: {
            tasks: [
              {
                id: 'draft',
                content: 'Write report',
                activeForm: 'Writing report',
                status: 'in_progress',
              },
            ],
          },
        },
      ],
    },
    { text: 'Tracked.' },
  );
  const first = await f.agent.generate('Track a report task.', runOptions());
  assert.equal(toolResults(first)[0]?.payload?.result?.isError, false);
  const reopened = new LibSQLStore({ id: 'reopened', url: f.url });
  await reopened.init();
  const threadState = await reopened.getStore('threadState');
  const state = await threadState.getState({
    threadId: 'alice-thread',
    type: 'task',
  });
  assert.equal(state.length, 1);
  f.responses.push({ calls: [{ name: 'task_complete', args: { id: 'draft' } }] }, { text: 'Done.' });
  const completed = await f.agent.generate('Complete draft.', runOptions());
  assert.equal(toolResults(completed)[0]?.payload?.result?.tasks?.[0]?.status, 'completed');
  const catalog = f.requests[0].tools.map(tool => tool.function.name);
  assert.ok(catalog.includes('recall'));
  assert.ok(catalog.includes('task_write'));
  assert.equal(Object.keys(f.memory.listTools({ lastMessages: false })).includes('recall'), false);
  const found = await f.bundle.tools.session_search.execute(
    { query: 'Track a report' },
    { requestContext: context('alice'), agent: { agentId: 'creator-agent' } },
  );
  assert.equal(found.results[0]?.threadId, 'alice-thread');
  const hidden = await f.bundle.tools.session_search.execute(
    { query: 'Track a report' },
    { requestContext: context('bob'), agent: { agentId: 'creator-agent' } },
  );
  assert.equal(hidden.results.length, 0);
});

for (const choice of [
  {
    name: 'ask_user',
    args: {
      question: 'Which topic?',
      options: [{ label: 'A' }, { label: 'B' }],
    },
    answer: 'A',
    expected: /User answered: A/,
  },
  {
    name: 'submit_plan',
    args: { path: '.mastracode/plans/report.md' },
    answer: { action: 'approved' },
    expected: /approved/i,
  },
])
  test(`${choice.name} suspends and resumes the real Agent workflow`, async t => {
    const f = await fixture(t);
    f.responses.push({ calls: [{ name: choice.name, args: choice.args }] });
    const stream = await f.agent.stream('Confirm the next step.', runOptions());
    const events = [];
    for await (const event of stream.fullStream) events.push(event);
    assert.equal(stream.status, 'suspended');
    const suspended = events.find(event => event.type === 'tool-call-suspended');
    assert.ok(suspended, 'native suspended event is emitted');
    f.responses.push({ text: 'Continued after user confirmation.' });
    const resumed = await f.agent.resumeGenerate(choice.answer, {
      ...runOptions(),
      runId: stream.runId,
      toolCallId: suspended.payload.toolCallId,
    });
    assert.equal(resumed.text, 'Continued after user confirmation.');
    assert.match(JSON.stringify(f.requests.at(-1).messages), choice.expected);
  });

test('shared skill sources cannot read host paths or escaping symlinks', async t => {
  const f = await fixture(t);
  const skillsPath = join(f.dir, 'skills');
  await mkdir(skillsPath);
  await writeFile(join(f.dir, 'outside'), 'private host data');
  await symlink(join(f.dir, 'outside'), join(skillsPath, 'escape'));
  const source = new SharedSkillSource(skillsPath);
  await assert.rejects(source.readFile('../outside'), /outside/);
  await assert.rejects(source.readFile('escape'), /outside/);
});

test('private workspaces load the active public skill snapshot from LibSQL', async t => {
  const f = await fixture(t);
  const skillsPath = join(f.dir, 'shared');
  const markdown = join(skillsPath, 'style-guide', 'SKILL.md');
  await mkdir(join(skillsPath, 'style-guide'), { recursive: true });
  const writeSkill = body =>
    writeFile(markdown, `---\nname: style-guide\ndescription: Editorial guide\n---\n${body}\n`);
  await writeSkill('First published instruction');
  const source = new SharedSkillSource(skillsPath);
  const [skills, blobs] = await Promise.all([f.storage.getStore('skills'), f.storage.getStore('blobs')]);
  const snapshot = async () => {
    const { snapshot, tree, files } = await publishSkillFromSource(source, 'style-guide', blobs);
    return { ...snapshot, tree, files };
  };
  const first = await snapshot();
  await skills.create({ skill: { id: 'style-guide', visibility: 'public', ...first } });
  const published = await skills.getLatestVersion('style-guide');
  await skills.update({ id: 'style-guide', activeVersionId: published.id });

  await writeSkill('Unpublished instruction');
  const draft = await snapshot();
  await skills.update({ id: 'style-guide', tree: draft.tree, files: draft.files });
  const latest = await skills.getLatestVersion('style-guide');
  await skills.create({ skill: { ...draft, id: 'draft-only', name: 'draft-only', visibility: 'public' } });
  await skills.create({ skill: { ...draft, id: 'private-only', name: 'private-only', visibility: 'private' } });
  const privateVersion = await skills.getLatestVersion('private-only');
  await skills.update({ id: 'private-only', activeVersionId: privateVersion.id });
  await rm(skillsPath, { recursive: true });

  const files = new UserStorage({ client: {}, databaseUrl: `file:${join(f.dir, 'skills-user-files.db')}` });
  await files.init();
  t.after(() => files.close());
  const resolveWorkspace = createPrivateWorkspace(files, f.storage);
  const alice = await resolveWorkspace('alice');
  assert.deepEqual(
    (await alice.skills.list()).map(skill => skill.name),
    ['style-guide'],
  );
  assert.match((await alice.skills.get('style-guide')).instructions, /First published instruction/);
  await skills.update({ id: 'style-guide', activeVersionId: latest.id });
  const bob = await resolveWorkspace('bob');
  assert.match((await bob.skills.get('style-guide')).instructions, /Unpublished instruction/);
  assert.match((await alice.skills.get('style-guide')).instructions, /First published instruction/);
});

test('authenticated tool catalog exposes real runtime capabilities, not scheduled tools or an execution bypass', async t => {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const { Knowledge } = await import('@mastra/core/knowledge');
  const { createAltFlowAuth } = await import('../src/mastra/altflow-auth.ts');
  const { toolCatalogRoute } = await import('../src/mastra/routes/tool-catalog.ts');
  const f = await fixture(t);
  const backend = createServer((req, res) => {
    const id = req.headers.authorization?.replace('Bearer ', '');
    res.setHeader('content-type', 'application/json');
    if (!['alice', 'bob'].includes(id)) {
      res.writeHead(401);
      res.end(JSON.stringify({ code: 40100, message: 'Invalid login' }));
      return;
    }
    res.end(
      JSON.stringify({
        code: 0,
        message: 'OK',
        data: { userId: id, username: id, role: 'creator' },
      }),
    );
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
  });
  const accounts = createAltFlowAuth({
    backendUrl: `http://127.0.0.1:${backend.address().port}`,
    origins: ['http://localhost:5174'],
    secureCookies: false,
  });
  const knowledge = new Knowledge({
    id: 'test-knowledge',
    name: 'Reference',
    storage: f.storage,
    scopes: {},
    tools: true,
  });
  const files = new UserStorage({
    client: {},
    databaseUrl: `file:${join(f.dir, 'catalog-files.db')}`,
  });
  await files.init();
  t.after(() => files.close());
  const privateWorkspace = createPrivateWorkspace(files, f.storage);
  const route = toolCatalogRoute({
    accounts,
    origins: ['http://localhost:5174'],
    tools: { ...f.bundle.tools, ...f.tree.tools },
    memory: f.memory,
    knowledge,
    workspace: privateWorkspace,
    providerConfigured: false,
  });
  const app = new Hono();
  app.get(route.path, route.handler);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/altflow/tools/catalog`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (
      await fetch(url, {
        headers: {
          Authorization: 'Bearer alice',
          Origin: 'http://untrusted.test',
        },
      })
    ).status,
    403,
  );
  for (const id of ['alice', 'bob']) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${id}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { entries } = await response.json();
    assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
    for (const name of [
      'countText',
      'present',
      'session_search',
      'recall',
      'mastra_workspace_read_file',
      'subagent',
      'subagent_fork',
      'send_message',
    ])
      assert.ok(
        entries.some(entry => entry.name === name),
        name,
      );
    assert.equal(entries.find(entry => entry.id === 'web_search').status, 'unconfigured');
    assert.equal(entries.find(entry => entry.id === 'team_task_create').status, 'conditional');
    for (const name of ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent'])
      assert.equal(entries.find(entry => entry.id === name).status, 'available');
    assert.equal(
      entries.some(entry => entry.id.startsWith('schedule')),
      false,
    );
    assert.equal(entries.find(entry => entry.id === 'present').runtime, true);
  }
});
