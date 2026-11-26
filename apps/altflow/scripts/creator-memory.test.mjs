import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Mastra } from '@mastra/core/mastra';
import { MastraServer } from '@mastra/hono';
import { Hono } from 'hono';
import { createAltFlowAuth } from '../src/mastra/altflow-auth.ts';
import { creatorMemoryRoutes } from '../src/mastra/routes/creator-memory.ts';
import { CreativeMemoryStore } from '../src/mastra/services/creative-memory.ts';

const secret = 'creator-memory-secret-'.padEnd(40, 'x');
const prefix = 'altflow-creator-v1.';

async function gateway(t) {
  const dir = await mkdtemp(join(tmpdir(), 'altflow-memory-routes-'));
  const store = new CreativeMemoryStore(`file:${join(dir, 'memory.db')}`);
  await store.init();
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const accounts = createAltFlowAuth({
    backendUrl: 'http://127.0.0.1:1',
    origins: [],
    secureCookies: false,
    creatorGatewaySecret: secret,
  });
  const routes = creatorMemoryRoutes({ accounts, store });
  const app = new Hono();
  const mastra = new Mastra({ server: { auth: accounts.auth, apiRoutes: routes }, logger: false });
  await new MastraServer({ mastra, app, prefix: '/api', customApiRoutes: routes }).init();
  const call = (path, { method = 'GET', body, user = 'alice', signed = true } = {}) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const claims = {
      aud: 'altflow-creator-v1',
      userId: user,
      username: user,
      role: 'user',
      projectId: 'project-a',
      conversationId: 'fc_memory',
      method,
      target: path,
      sha256: createHash('sha256').update(raw ?? '').digest('hex'),
      exp: Math.floor(Date.now() / 1000) + 30,
      nonce: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', secret).update(prefix + payload).digest('base64url');
    return app.request(path, {
      method,
      body: raw,
      headers: {
        ...(raw ? { 'content-type': 'application/json' } : {}),
        ...(signed ? { authorization: 'Bearer ' + prefix + payload + '.' + signature } : {}),
      },
    });
  };
  const entries = async user => (await (await call('/creator-gateway/memory', { user })).json()).entries;
  return { call, entries, store };
}

test('an unsigned request is rejected on every memory route', async t => {
  const { call } = await gateway(t);
  assert.equal((await call('/creator-gateway/memory', { signed: false })).status, 401);
  assert.equal(
    (await call('/creator-gateway/memory/save', { method: 'POST', signed: false, body: { key: 'a', revision: 0, content: 'b' } })).status,
    401,
  );
  assert.equal(
    (await call('/creator-gateway/memory/forget', { method: 'POST', signed: false, body: { key: 'a', revision: 1 } })).status,
    401,
  );
});

test('a preference is created, corrected in place and forgotten with revision checks', async t => {
  const { call, entries, store } = await gateway(t);
  assert.deepEqual(await entries('alice'), []);

  const created = await call('/creator-gateway/memory/save', {
    method: 'POST',
    body: { key: '称呼', revision: 0, content: '叫我「大哥」' },
  });
  assert.equal(created.status, 200);
  const first = (await created.json()).entry;
  assert.equal(first.revision, 1);
  assert.equal((await entries('alice'))[0].content, '叫我「大哥」');

  const corrected = await call('/creator-gateway/memory/save', {
    method: 'POST',
    body: { key: '称呼', revision: 1, content: '叫我「老板」' },
  });
  assert.equal((await corrected.json()).entry.revision, 2);
  const stale = await call('/creator-gateway/memory/save', {
    method: 'POST',
    body: { key: '称呼', revision: 1, content: '过期的修改' },
  });
  assert.equal(stale.status, 409);
  assert.equal((await entries('alice'))[0].content, '叫我「老板」');

  const [record] = await store.read('alice');
  assert.equal(record.kind, 'author_preference');
  assert.equal(record.status, 'confirmed');
  assert.deepEqual(record.source, { threadId: 'settings', messageId: 'settings-ui', quote: '叫我「老板」' });

  assert.equal((await call('/creator-gateway/memory/forget', { method: 'POST', body: { key: '称呼', revision: 1 } })).status, 409);
  const forgotten = await call('/creator-gateway/memory/forget', { method: 'POST', body: { key: '称呼', revision: 2 } });
  assert.equal(forgotten.status, 200);
  assert.deepEqual(await entries('alice'), []);
});

test('each account only sees and changes its own preferences', async t => {
  const { call, entries } = await gateway(t);
  await call('/creator-gateway/memory/save', { method: 'POST', body: { key: '语气', revision: 0, content: '直接' } });
  assert.deepEqual(await entries('bob'), []);
  await call('/creator-gateway/memory/save', { method: 'POST', user: 'bob', body: { key: '语气', revision: 0, content: '温和' } });
  assert.equal((await entries('alice'))[0].content, '直接');
  assert.equal((await entries('bob'))[0].content, '温和');
  assert.equal(
    (await call('/creator-gateway/memory/forget', { method: 'POST', user: 'bob', body: { key: '语气', revision: 1 } })).status,
    200,
  );
  assert.equal((await entries('alice')).length, 1);
});

test('only author preferences are exposed, never project agreements or story facts', async t => {
  const { entries, store } = await gateway(t);
  const source = { threadId: 't', messageId: 'm', quote: 'q' };
  await store.write('alice', undefined, 0, { kind: 'author_preference', key: '偏好', status: 'confirmed', content: '简洁', source });
  await store.write('alice', 'project-a', 0, { kind: 'project_agreement', key: '约定', status: 'confirmed', content: '双主角', source });
  await store.write('alice', 'project-a', 0, { kind: 'story_fact', key: '事实', status: 'confirmed', content: '雨夜', version: '1', source });
  assert.deepEqual((await entries('alice')).map(item => item.key), ['偏好']);
});

test('malformed or oversized input is rejected before it reaches the store', async t => {
  const { call, entries } = await gateway(t);
  const post = body => call('/creator-gateway/memory/save', { method: 'POST', body });
  assert.equal((await post({ key: '', revision: 0, content: 'x' })).status, 400);
  assert.equal((await post({ key: 'k', revision: -1, content: 'x' })).status, 400);
  assert.equal((await post({ key: 'k', revision: 0, content: 'x'.repeat(601) })).status, 400);
  assert.equal((await post({ key: 'k', revision: 0, content: 'x', kind: 'project_agreement' })).status, 400);
  assert.equal((await post({ key: 'k', revision: 0 })).status, 400);
  assert.deepEqual(await entries('alice'), []);
});
