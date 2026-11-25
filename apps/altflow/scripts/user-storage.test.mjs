import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { UserFilesystem } from '../src/mastra/user-filesystem.ts';
import { setup } from './storage-fixture.mjs';

test('an uploaded document survives reopening and is readable through the agent filesystem, isolated per user', async t => {
  const fixture = await setup(t);
  await fixture.store.write('alice', '/uploads/book.txt', Buffer.from('小说正文'), {
    mimeType: 'text/plain',
    source: 'upload',
  });
  const store = await fixture.reopen();
  const a = new UserFilesystem(store, 'alice');
  const b = new UserFilesystem(store, 'bob');
  assert.equal(await a.readFile('/uploads/book.txt', { encoding: 'utf8' }), '小说正文');
  assert.equal(await b.exists('/uploads/book.txt'), false);
  await assert.rejects(b.readFile('/uploads/book.txt'), { code: 'ENOENT' });
  await a.writeFile('/drafts/大纲.md', '# 大纲');
  assert.deepEqual((await store.list('alice')).map(f => f.source).sort(), ['generated', 'upload']);
  assert.equal((await store.summary('alice')).usedBytes, Buffer.byteLength('小说正文# 大纲'));
});

test('concurrent uploads cannot overrun quota and failed OSS writes release their reservations', async t => {
  const { store, failWrites } = await setup(t, 10);
  const results = await Promise.allSettled([
    store.write('alice', '/a.txt', Buffer.alloc(7)),
    store.write('alice', '/b.txt', Buffer.alloc(7)),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.summary('alice')).usedBytes, 7);
  const file = (await store.list('alice'))[0];
  await store.write('alice', file.path, Buffer.alloc(9));
  assert.equal((await store.summary('alice')).usedBytes, 9);
  await store.remove('alice', file.path);
  assert.equal((await store.summary('alice')).usedBytes, 0);
  failWrites();
  await assert.rejects(store.write('alice', '/failed.txt', Buffer.alloc(8)));
  assert.equal((await store.summary('alice')).reservedBytes, 0);
});

test('independent uploads below quota both succeed', async t => {
  const { store } = await setup(t, 100);
  await Promise.all([
    store.write('alice', '/one.txt', Buffer.alloc(3)),
    store.write('alice', '/two.txt', Buffer.alloc(4)),
  ]);
  assert.equal((await store.summary('alice')).usedBytes, 7);
});

test('empty nested directories count as existing nonempty parents and remain isolated', async t => {
  const { store } = await setup(t);
  const fs = new UserFilesystem(store, 'alice');
  await fs.mkdir('/drafts/chapters');
  assert.equal(await fs.exists('/drafts'), true);
  assert.equal(await new UserFilesystem(store, 'bob').exists('/drafts'), false);
  await assert.rejects(fs.rmdir('/drafts'), /目录不为空/);
  assert.equal(await fs.exists('/drafts/chapters'), true);
  await fs.rmdir('/drafts', { recursive: true });
  assert.equal(await fs.exists('/drafts'), false);
});

test('agent copy, move, append and recursive delete share quota and reject escaping paths', async t => {
  const { store } = await setup(t, 20);
  const fs = new UserFilesystem(store, 'alice');
  await fs.writeFile('/drafts/a.txt', '12345');
  await fs.copyFile('/drafts/a.txt', '/drafts/b.txt');
  await fs.appendFile('/drafts/b.txt', '67890');
  await fs.moveFile('/drafts/a.txt', '/final.txt');
  assert.equal((await store.summary('alice')).usedBytes, 15);
  await assert.rejects(fs.writeFile('../bob/secret.txt', 'bad'), /路径/);
  await assert.rejects(fs.appendFile('/drafts/b.txt', '123456'), /512|空间/);
  await fs.rmdir('/drafts', { recursive: true });
  assert.equal((await store.summary('alice')).usedBytes, 5);
});

test('failed deletes retain the file and quota; overwritten blobs are retried after reopening', async t => {
  const fixture = await setup(t, 100);
  const { store, objects, failDeletes } = fixture;
  await store.write('alice', '/a.txt', Buffer.from('original'));
  failDeletes(true);
  await assert.rejects(store.remove('alice', '/a.txt'));
  assert.equal((await store.summary('alice')).usedBytes, 8);
  assert.equal((await store.list('alice')).length, 1);
  await store.write('alice', '/a.txt', Buffer.from('updated'));
  assert.equal(objects.size, 2);
  failDeletes(false);
  const reopened = await fixture.reopen();
  assert.equal(objects.size, 1);
  assert.equal((await reopened.read('alice', '/a.txt')).toString(), 'updated');
  await reopened.remove('alice', '/a.txt');
  assert.equal(objects.size, 0);
  assert.equal((await reopened.summary('alice')).usedBytes, 0);
});

test('storage HTTP routes enforce Go-backed identity, origin, ownership and actual streamed quota', async t => {
  const { Hono } = await import('hono');
  const { createAltFlowAuth } = await import('../src/mastra/altflow-auth.ts');
  const { userStorageRoutes } = await import('../src/mastra/user-storage-routes.ts');
  // Only the external authentication and OSS HTTP boundaries are fixtures.
  const authServer = createServer((req, res) => {
    const id =
      req.headers.authorization === 'Bearer alice'
        ? 'alice'
        : req.headers.authorization === 'Bearer bob'
          ? 'bob'
          : undefined;
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(id ? 200 : 401);
    res.end(
      JSON.stringify(
        id
          ? { code: 0, message: '', data: { userId: id, username: id, role: 'creator' } }
          : { code: 40100, message: 'expired', data: null },
      ),
    );
  });
  await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => authServer.close(resolve)));
  const accounts = createAltFlowAuth({
    backendUrl: `http://127.0.0.1:${authServer.address().port}`,
    origins: ['http://studio.test'],
    secureCookies: false,
  });
  const { store } = await setup(t, 10);
  const app = new Hono();
  for (const route of userStorageRoutes(store, accounts.authenticate, ['http://studio.test']))
    app.on(route.method, route.path, route.handler);
  assert.equal((await app.request('/storage')).status, 401);
  assert.equal((await app.request('/storage', { headers: { authorization: 'Bearer expired' } })).status, 401);
  const upload = (headers, body = 'hello') =>
    app.request('/storage/upload?id=test1&name=book.txt', { method: 'POST', headers, body });
  assert.equal((await upload({ cookie: 'altflow_studio_token=alice' })).status, 403);
  assert.equal((await upload({ cookie: 'altflow_studio_token=alice', origin: 'http://evil.test' })).status, 403);
  assert.equal((await upload({ cookie: 'altflow_studio_token=alice', origin: 'http://studio.test' })).status, 201);
  assert.equal((await upload({ authorization: 'Bearer alice' })).status, 201); // stable upload id is idempotent
  assert.equal((await store.summary('alice')).usedBytes, 5);
  const bob = { authorization: 'Bearer bob' };
  const alice = { authorization: 'Bearer alice' };
  assert.equal((await (await app.request('/storage', { headers: bob })).json()).files.length, 0);
  const path = encodeURIComponent('/uploads/test1/book.txt');
  assert.equal((await app.request(`/storage/download?path=${path}`, { headers: bob })).status, 404);
  assert.equal((await app.request(`/storage/file?path=${path}`, { method: 'DELETE', headers: bob })).status, 404);
  const downloaded = await app.request(`/storage/download?path=${path}`, { headers: alice });
  assert.equal(await downloaded.text(), 'hello');
  assert.match(downloaded.headers.get('content-disposition'), /attachment/);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.equal(
    (
      await app.request('/storage/upload?id=test2&name=large.txt', {
        method: 'POST',
        headers: alice,
        body: '123456',
      })
    ).status,
    413,
  );
  assert.equal((await store.summary('alice')).usedBytes, 5);
  assert.equal((await app.request(`/storage/file?path=${path}`, { method: 'DELETE', headers: alice })).status, 200);
  assert.equal((await store.summary('alice')).usedBytes, 0);
});

test('legacy attachment recovery preserves text, is idempotent and never imports workspace references', async t => {
  const { restoreLegacyAttachments } = await import('../src/mastra/legacy-files.ts');
  const { store } = await setup(t);
  const parts = [
    { type: 'text', text: '<attachment name="小说.txt">原始正文\n</attachment>' },
    {
      type: 'text',
      text: '<attachment name="new.txt">文件已保存到当前用户工作区：/uploads/a/new.txt</attachment>',
    },
  ];
  assert.equal(await restoreLegacyAttachments(store, 'alice', 'old-message', parts), 1);
  assert.equal(await restoreLegacyAttachments(store, 'alice', 'old-message', parts), 1);
  assert.equal((await store.list('alice')).length, 1);
  assert.equal((await store.read('alice', '/uploads/legacy-old-message-0/小说.txt')).toString(), '原始正文\n');
  assert.equal((await store.list('bob')).length, 0);
});

test('file delivery references the private ledger without duplicating quota and rejects missing or foreign files', async t => {
  const { UserDeliveryService } = await import('../src/mastra/services/delivery.ts');
  const { createPresentTool } = await import('@mastra/altflow-tools');
  const { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_NORMALIZED_USER_KEY } =
    await import('@mastra/core/request-context');
  const fixture = await setup(t);
  await fixture.store.write('alice', '/report.md', Buffer.from('# Final report'), { mimeType: 'text/markdown' });
  const delivery = new UserDeliveryService(fixture.store);
  const tool = createPresentTool({ service: delivery });
  const context = user => {
    const requestContext = new RequestContext();
    requestContext.setRaw(MASTRA_NORMALIZED_USER_KEY, { id: user });
    requestContext.set(MASTRA_RESOURCE_ID_KEY, `altflow:${user}`);
    return { requestContext, agent: { agentId: 'creator-agent' } };
  };
  const before = await fixture.store.summary('alice');
  const output = await tool.execute(
    { files: [{ path: '/report.md', description: 'Final report' }, { path: '/report.md' }] },
    context('alice'),
  );
  assert.equal(output.files.length, 1);
  assert.equal(output.files[0].downloadUrl, '/storage/download?path=%2Freport.md');
  assert.equal((await fixture.store.summary('alice')).usedBytes, before.usedBytes);
  await assert.rejects(tool.execute({ files: [{ path: '/report.md' }] }, context('bob')), /不存在/);
  await assert.rejects(tool.execute({ files: [{ path: '/report.md' }] }, {}), { code: 'AUTHENTICATION_REQUIRED' });
  await fixture.store.remove('alice', '/report.md');
  await assert.rejects(delivery.present({ userId: 'alice' }, [{ path: '/report.md' }]), /不存在/);
});

for (const mode of ['stream', 'generate']) {
  test(`${mode}: workspace tools cannot discover or read another conversation's files`, async t => {
    const { Agent } = await import('@mastra/core/agent');
    const { createAgentTree } = await import('../src/mastra/subagents/agents.ts');
    const { SubagentStore } = await import('../src/mastra/subagents/store.ts');
    const { Mastra } = await import('@mastra/core/mastra');
    const { Memory } = await import('@mastra/memory');
    const { LibSQLStore } = await import('@mastra/libsql');
    const { Workspace } = await import('@mastra/core/workspace');
    const { createPresentTool } = await import('@mastra/altflow-tools');
    const { ConversationFiles } = await import('../src/mastra/services/conversation-files.ts');
    const { createProjectStatusTool } = await import('../src/mastra/tools/project-status.ts');
    const { UserDeliveryService } = await import('../src/mastra/services/delivery.ts');
    const { OfficeReader } = await import('../src/mastra/services/office.ts');
    const { createDocumentTools } = await import('../src/mastra/tools/read-document.ts');
    const { turnFileChangesProcessor } = await import('../src/mastra/services/turn-file-changes.ts');
    const { modelServer, context } = await import('./tool-fixture.mjs');
    const f = await setup(t);
    const edge = await modelServer(t);
    const storage = new LibSQLStore({ id: 'file-isolation', url: ':memory:' });
    await storage.init();
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const treeDir = await mkdtemp(join(tmpdir(), 'conversation-tree-'));
    const treeStore = new SubagentStore(`file:${join(treeDir, 'tree.db')}`);
    await treeStore.init();
    const runtimes = [];
    t.after(async () => {
      for (const runtime of runtimes) await runtime.close();
      treeStore.close();
      await storage.close();
      await rm(treeDir, { recursive: true, force: true });
    });
    let currentTree;
    const memory = await storage.getStore('memory');
    let scoped = new ConversationFiles(f.store);
    const build = () => {
      const documents = createDocumentTools(new OfficeReader(scoped));
      const scope = scoped.processor((ctx, thread) => tree.runtime.actor(ctx, thread));
      const workspace = ({ user }) =>
        new Workspace({ id: `files-${user.id}`, filesystem: new UserFilesystem(scoped, user.id) });
      const tree = createAgentTree({
        store: treeStore,
        memory,
        childMemory: new Memory({ storage, options: { generateTitle: false } }),
        model: edge.model,
        tools: documents.tools,
        teamEnabled: async () => false,
        childConfig: { workspace, inputProcessors: [documents.processor, scope] },
        getMastra: () => mastra,
        getRootAgent: () => agent,
      });
      runtimes.push(tree.runtime);
      currentTree = tree;
      const agent = new Agent({
        id: 'creator-agent',
        name: 'Creator',
        instructions: 'Use the requested tools.',
        model: edge.model,
        memory: new Memory({ storage, options: { lastMessages: 20, generateTitle: false } }),
        workspace,
        tools: {
          project_status: createProjectStatusTool({ files: scoped }),
          present: createPresentTool({ service: new UserDeliveryService(scoped) }),
          ...documents.tools,
        },
        inputProcessors: [tree.processor, documents.processor, turnFileChangesProcessor(), scope],
      });
      const mastra = new Mastra({ agents: { creator: agent }, storage });
      return agent;
    };
    let agent = build();
    const run = async (thread, calls, text = '检查当前会话的文件。', owner = 'alice') => {
      const start = edge.requests.length;
      edge.responses.push({ calls }, { text: 'Done.' });
      const result = await agent[mode](text, {
        memory: { thread, resource: `altflow:${owner}` },
        requestContext: context(owner),
        maxSteps: 2,
      });
      await result.text;
      const request = edge.requests.slice(start).at(-1);
      return request.messages
        .filter(message => message.role === 'tool')
        .map(message => message.content)
        .join('\n');
    };
    const path = '/projects/山猫轩/01-创意构思.md';
    await run('a', [{ name: 'mastra_workspace_write_file', args: { path, content: 'ONLY_CONVERSATION_A' } }]);
    const own = await run('a', [
      { name: 'project_status', args: {} },
      { name: 'mastra_workspace_read_file', args: { path } },
    ]);
    assert.match(own, /山猫轩/);
    assert.match(own, /ONLY_CONVERSATION_A/);
    const [physical] = await f.store.list('alice');
    await f.store.write('alice', '/uploads/other/private.docx', Buffer.from('OTHER_CONVERSATION_DOCUMENT'), {
      source: 'upload',
    });
    assert.ok(physical.path.endsWith(path));
    for (const target of ['b', 'c']) {
      const isolated = await run(target, [
        { name: 'project_status', args: {} },
        { name: 'mastra_workspace_list_files', args: { path: '/', recursive: true } },
        { name: 'mastra_workspace_read_file', args: { path } },
        { name: 'mastra_workspace_read_file', args: { path: physical.path } },
        { name: 'present', args: { files: [{ path }] } },
        { name: 'read_document', args: { path: '/uploads/other/private.docx' } },
      ]);
      assert.doesNotMatch(isolated, /ONLY_CONVERSATION_A|OTHER_CONVERSATION_DOCUMENT|不支持的文档|Office|解析/);
      assert.match(isolated, /"projects":\[\]/);
      assert.doesNotMatch(isolated, /downloadUrl/);
    }
    await run('b', [{ name: 'mastra_workspace_write_file', args: { path, content: 'ONLY_CONVERSATION_B' } }]);
    assert.equal((await f.store.list('alice')).filter(file => file.path.startsWith('/conversations/')).length, 2);
    scoped = new ConversationFiles(await f.reopen());
    agent = build();
    assert.match(await run('a', [{ name: 'mastra_workspace_read_file', args: { path } }]), /ONLY_CONVERSATION_A/);
    assert.match(await run('b', [{ name: 'mastra_workspace_read_file', args: { path } }]), /ONLY_CONVERSATION_B/);
    const foreign = await run('bob', [{ name: 'mastra_workspace_read_file', args: { path } }], '读取文件。', 'bob');
    assert.doesNotMatch(foreign, /ONLY_CONVERSATION_[AB]/);
    await f.store.write('alice', '/uploads/selected/input.txt', Buffer.from('EXPLICIT_ATTACHMENT'), {
      source: 'upload',
    });
    await f.store.write('alice', '/uploads/unselected/input.txt', Buffer.from('UNSELECTED_ATTACHMENT'), {
      source: 'upload',
    });
    const attached = await run(
      'c',
      [{ name: 'mastra_workspace_read_file', args: { path: '/uploads/selected/input.txt' } }],
      '<attachment name="input.txt">文件已保存到当前用户工作区：/uploads/selected/input.txt\n请读取附件。</attachment>',
    );
    assert.match(attached, /EXPLICIT_ATTACHMENT/);
    const hidden = await run('b', [
      { name: 'mastra_workspace_read_file', args: { path: '/uploads/selected/input.txt' } },
      { name: 'mastra_workspace_read_file', args: { path: '/uploads/unselected/input.txt' } },
    ]);
    assert.doesNotMatch(hidden, /EXPLICIT_ATTACHMENT|UNSELECTED_ATTACHMENT/);
    const presented = await run('b', [{ name: 'present', args: { files: [{ path }] } }]);
    assert.match(presented, /downloadUrl/);
    const { Hono } = await import('hono');
    const { serve } = await import('@hono/node-server');
    const { userStorageRoutes } = await import('../src/mastra/user-storage-routes.ts');
    const app = new Hono();
    for (const route of userStorageRoutes(
      f.store,
      async () => ({ id: 'alice', username: 'Alice', role: 'creator' }),
      [],
      async (_, thread) => ['a', 'b', 'c'].includes(thread),
    ))
      app.on(route.method, route.path, route.handler);
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise(resolve => server.once('listening', resolve));
    t.after(
      () =>
        new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/storage?thread=foreign`)).status, 404);
    const ownFiles = await (await fetch(`${base}/storage?thread=b`)).json();
    assert.deepEqual(
      ownFiles.files.map(file => file.path),
      [path],
    );
    const download = await fetch(
      `${base}/storage/download?${new URLSearchParams({ path: ownFiles.files[0].storagePath })}`,
    );
    assert.equal(await download.text(), 'ONLY_CONVERSATION_B');
    const [fileB] = await scoped.run({ owner: 'alice', root: 'b' }, () => scoped.list('alice'));
    assert.equal((await f.store.read('alice', fileB.storagePath)).toString(), 'ONLY_CONVERSATION_B');
    edge.setHandler(body => {
      if (
        !body.messages.some(
          message => message.role === 'system' && String(message.content).includes('Your name is reader.'),
        )
      )
        return { text: 'Done.' };
      return body.messages.some(message => message.role === 'tool')
        ? { text: 'Child finished reading.' }
        : { calls: [{ name: 'mastra_workspace_read_file', args: { path } }] };
    });
    const actor = await currentTree.runtime.actor(context('alice'), 'a');
    await currentTree.runtime.spawn(actor, {
      name: 'reader',
      description: 'Read the parent file',
      prompt: 'Read the current draft.',
    });
    const deadline = Date.now() + 5000;
    while (!(await treeStore.read('alice', 'a')).children.some(child => child.state === 'completed')) {
      assert.ok(Date.now() < deadline, 'child must finish reading the parent conversation file');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const childMessages = edge.requests
      .filter(body =>
        body.messages.some(
          message => message.role === 'system' && String(message.content).includes('Your name is reader.'),
        ),
      )
      .flatMap(body => body.messages);
    assert.match(JSON.stringify(childMessages), /ONLY_CONVERSATION_A/);
    assert.doesNotMatch(JSON.stringify(childMessages), /ONLY_CONVERSATION_B/);
  });
}

test('legacy file recovery requires a unique recorded conversation and concurrent scopes stay independent', async t => {
  const { ConversationFiles } = await import('../src/mastra/services/conversation-files.ts');
  const { trackTurnFiles } = await import('../src/mastra/services/turn-file-changes.ts');
  const f = await setup(t);
  await trackTurnFiles.run({ owner: 'alice', thread: 'a', turn: 'one' }, () =>
    f.store.write('alice', '/projects/旧作/01-创意构思.md', Buffer.from('confirmed old owner')),
  );
  for (const thread of ['a', 'b'])
    await trackTurnFiles.run({ owner: 'alice', thread, turn: 'two' }, () =>
      f.store.write('alice', '/ambiguous.md', Buffer.from(`written by ${thread}`)),
    );
  await f.store.write('alice', '/unassigned.md', Buffer.from('no provenance'));
  await f.store.linkLegacyConversationFiles('alice', 'a');
  await f.store.linkLegacyConversationFiles('alice', 'b');
  const scoped = new ConversationFiles(f.store);
  const a = { owner: 'alice', root: 'a' };
  const b = { owner: 'alice', root: 'b' };
  assert.deepEqual(
    (await scoped.run(a, () => scoped.list('alice'))).map(file => file.path),
    ['/projects/旧作/01-创意构思.md'],
  );
  assert.deepEqual(await scoped.run(b, () => scoped.list('alice')), []);
  await assert.rejects(
    scoped.run(a, () => scoped.read('alice', '/ambiguous.md')),
    /不存在/,
  );
  await assert.rejects(
    scoped.run(a, () => scoped.read('alice', '/unassigned.md')),
    /不存在/,
  );
  for (let round = 0; round < 20; round++) {
    await Promise.all(
      [a, b].map(scope =>
        scoped.run(scope, async () => {
          await scoped.write('alice', '/parallel.md', Buffer.from(scope.root));
          assert.equal((await scoped.read('alice', '/parallel.md')).toString(), scope.root);
        }),
      ),
    );
  }
  assert.equal((await f.store.read('alice', '/unassigned.md')).toString(), 'no provenance');
});

test('missing optional gitignore has the filesystem ENOENT contract', async t => {
  const { store } = await setup(t);
  const fs = new UserFilesystem(store, 'alice');
  await fs.writeFile('/novel.txt', '雨夜来客');
  await assert.rejects(fs.readFile('/.gitignore'), { code: 'ENOENT' });
  assert.equal(await fs.readFile('/novel.txt', { encoding: 'utf8' }), '雨夜来客');
});
