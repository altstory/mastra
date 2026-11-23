import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { createAltFlowAuth } from '../src/mastra/altflow-auth.ts';

const origin = 'http://localhost:5174';
const { auth } = createAltFlowAuth({
  backendUrl: 'http://127.0.0.1:8080',
  origins: [origin],
  secureCookies: false,
});
const user = { id: 'test-owner', username: 'Test', role: 'creator' };

test('the local Go identity endpoint resolves the account ID and role and rejects invalid sessions', async t => {
  const backend = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || req.url !== '/api/v1/auth/me') {
      res.end(JSON.stringify({ code: 1, message: '接口不存在', data: null }));
    } else if (req.headers.authorization !== 'Bearer local-test-token') {
      res.end(JSON.stringify({ code: 40100, message: '未登录或 token 失效', data: null }));
    } else {
      res.end(
        JSON.stringify({ code: 0, message: 'OK', data: { ...user, email: null, credits: 0, hasPassword: true } }),
      );
    }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const accounts = createAltFlowAuth({
    backendUrl: `http://127.0.0.1:${backend.address().port}`,
    identityEndpoint: 'me',
    origins: [origin],
    secureCookies: false,
  });
  const request = token => new Request(origin + '/account/session', { headers: { Authorization: `Bearer ${token}` } });
  const current = await accounts.authenticate(request('local-test-token'));
  assert.deepEqual(current, { ...user, email: null });
  assert.equal(accounts.session(current).resourceId, 'altflow:test-owner');
  assert.equal(await accounts.authenticate(request('expired-token')), null);
});

test('only administrators can open the knowledge browser and read skill files', async () => {
  for (const path of [
    '/api/knowledge',
    '/api/knowledge/creatorKnowledge/tree',
    '/api/knowledge/creatorKnowledge/pages/example',
    '/api/knowledge/creatorKnowledge/search',
    '/api/knowledge/creatorKnowledge/events',
    '/api/agents/creator-agent/skills/example',
  ]) {
    for (const role of ['creator', 'user', 'admin']) {
      const requestContext = new RequestContext();
      assert.equal(
        await auth.authorize(
          path,
          'GET',
          { ...user, role },
          {
            req: { raw: new Request(origin + path) },
            get: () => requestContext,
          },
        ),
        role === 'admin',
        `${role} GET ${path}`,
      );
    }
  }
});
async function authorized(body, endpoint = 'send-message') {
  const requestContext = new RequestContext();
  return auth.authorize('/api/agents/creator-agent/' + endpoint, 'POST', user, {
    req: {
      raw: new Request(origin + '/api', {
        method: 'POST',
        headers: { Origin: origin },
        body: JSON.stringify(body),
      }),
    },
    get: () => requestContext,
  });
}
test('managed users can disable memory and choose teamwork through message admission', async () => {
  const memory = {
    thread: 'owned-thread',
    resource: 'altflow:test-owner',
    options: {
      lastMessages: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  };
  assert.equal(
    await authorized({
      threadId: 'owned-thread',
      message: {},
      ifIdle: { streamOptions: { memory, disableSubAgents: true } },
    }),
    true,
  );
  assert.equal(await authorized({ messages: [], memory, disableSubAgents: false }, 'stream'), true);
});
test('managed users cannot smuggle agent configuration through conversation preferences', async () => {
  for (const override of [
    { model: 'other/model' },
    { instructions: 'replace' },
    { tools: {} },
    { providerOptions: { other: { reasoningLevel: 'high' } } },
    { providerOptions: { altflow: { reasoningLevel: 'high', modelhub_thinking_budget: 99999 } } },
    { requestContext: { providerOptions: { altflow: { reasoningLevel: 'high' } } } },
    {
      memory: {
        options: { workingMemory: { enabled: true, template: 'replace' } },
      },
    },
    { memory: { options: { observationalMemory: { model: 'other/model' } } } },
    { memory: { options: { lastMessages: -1 } } },
    { memory: { options: { lastMessages: 20 } } },
    { memory: { options: { observationalMemory: true } } },
  ]) {
    for (const endpoint of ['send-message', 'stream']) {
      assert.equal(
        await authorized(
          endpoint === 'send-message'
            ? { threadId: 'owned-thread', message: {}, ifIdle: { streamOptions: override } }
            : { messages: [], ...override },
          endpoint,
        ),
        false,
      );
    }
  }
});

test('managed users can choose the preset model reasoning for direct and queued chat', async () => {
  const providerOptions = { altflow: { reasoningLevel: 'high' } };
  for (const endpoint of ['generate', 'stream', 'stream-until-idle']) {
    assert.equal(await authorized({ messages: [], providerOptions }, endpoint), true);
  }
  for (const endpoint of ['send-message', 'queue-message']) {
    assert.equal(
      await authorized(
        { threadId: 'owned-thread', message: {}, ifIdle: { streamOptions: { providerOptions } } },
        endpoint,
      ),
      true,
    );
    assert.equal(await authorized({ threadId: 'owned-thread', message: {}, providerOptions }, endpoint), false);
  }
});
