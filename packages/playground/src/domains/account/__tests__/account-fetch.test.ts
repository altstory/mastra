import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { createAccountFetch } from '../account-fetch';
import { creatorSession, adminSession } from './fixtures/session';
import { server } from '@/test/msw-server';
const url = 'http://localhost:4111/api/agents/creator-agent/stream';
describe('Account fetch', () => {
  describe('when the API is mounted at a custom prefix', () => {
    it('removes editable settings and binds the resource on that route', async () => {
      const mountedUrl = url.replace('/api/', '/api/mastra/');
      server.use(
        http.post(mountedUrl, async ({ request }) => {
          expect(await request.json()).toEqual({
            messages: [],
            memory: { thread: 'thread-1', resource: creatorSession.resourceId },
          });
          return HttpResponse.json({ ok: true });
        }),
      );
      expect(
        (
          await createAccountFetch(creatorSession, '/api/mastra')(mountedUrl, {
            method: 'POST',
            body: JSON.stringify({ messages: [], model: 'override', memory: { thread: 'thread-1' } }),
          })
        ).status,
      ).toBe(200);
    });
  });
  describe('when a creator sends a Altflow chat request', () => {
    it('sends conversation data with the assigned resource and server configuration', async () => {
      server.use(
        http.post(url, async ({ request }) => {
          expect(request.credentials).toBe('include');
          expect(await request.json()).toEqual({
            messages: [{ role: 'user', content: 'hello' }],
            memory: { thread: 'thread-1', resource: creatorSession.resourceId },
          });
          return HttpResponse.json({ ok: true });
        }),
      );
      const response = await createAccountFetch(creatorSession)(url, {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello' }],
          memory: { thread: 'thread-1', resource: 'creator-agent' },
          modelSettings: { temperature: 0.5 },
          providerOptions: { openai: { reasoningLevel: 'high' } },
          model: 'other/model',
          requestContext: { injected: true },
          clientTools: {},
        }),
      });
      expect(response.status).toBe(200);
    });
  });
  describe('when a creator sends or queues a thread message', () => {
    it.each(['send-message', 'queue-message'])('removes execution overrides from %s', async endpoint => {
      const signalUrl = url.replace('/stream', '/' + endpoint);
      const message = { contents: [{ type: 'text', text: 'Next task' }], metadata: { clientMessageId: 'local-id' } };
      server.use(
        http.post(signalUrl, async ({ request }) => {
          expect(await request.json()).toEqual({
            message,
            threadId: 'thread-1',
            resourceId: creatorSession.resourceId,
          });
          return HttpResponse.json({ accepted: true, runId: 'run-1' });
        }),
      );
      const response = await createAccountFetch(creatorSession)(signalUrl, {
        method: 'POST',
        body: JSON.stringify({
          message,
          threadId: 'thread-1',
          resourceId: 'someone-else',
          runId: 'another-run',
          ifIdle: { streamOptions: { model: 'override', requireToolApproval: true } },
          ifActive: { behavior: 'discard' },
          requestContext: { injected: true },
        }),
      });
      expect(response.status).toBe(200);
    });
  });
  describe('when a managed account changes conversation preferences', () => {
    it.each(['stream', 'send-message', 'queue-message'])(
      'preserves bounded preferences on %s and binds ownership',
      async endpoint => {
        const target = url.replace('/stream', '/' + endpoint);
        const preferences = {
          disableSubAgents: true,
          providerOptions: { altflow: { reasoningLevel: 'high', thinkingBudget: 50 }, openai: {} },
          memory: {
            thread: 'forged-thread',
            resource: 'forged-owner',
            options: {
              lastMessages: 12,
              workingMemory: { enabled: false },
              observationalMemory: false,
            },
          },
          model: 'forged-model',
        };
        let captured: unknown;
        server.use(
          http.post(target, async ({ request }) => {
            captured = await request.json();
            return HttpResponse.json({ ok: true });
          }),
        );
        await createAccountFetch(creatorSession)(target, {
          method: 'POST',
          body: JSON.stringify(
            endpoint === 'stream'
              ? { messages: [], ...preferences }
              : { message: { contents: [] }, threadId: 'owned-thread', ifIdle: { streamOptions: preferences } },
          ),
        });
        const expected = {
          disableSubAgents: true,
          providerOptions: { altflow: { reasoningLevel: 'high' } },
          memory: {
            thread: endpoint === 'stream' ? 'forged-thread' : 'owned-thread',
            resource: creatorSession.resourceId,
            options: preferences.memory.options,
          },
        };
        expect(captured).toEqual(
          endpoint === 'stream'
            ? { messages: [], ...expected }
            : {
                message: { contents: [] },
                threadId: 'owned-thread',
                resourceId: creatorSession.resourceId,
                ifIdle: { streamOptions: expected },
              },
        );
      },
    );
  });
  describe('when an administrator sends a request', () => {
    it('preserves administrator configuration', async () => {
      const body = { messages: [], model: 'provider/model' };
      server.use(
        http.post(url, async ({ request }) => {
          expect(await request.json()).toEqual(body);
          return HttpResponse.json({ ok: true });
        }),
      );
      expect((await createAccountFetch(adminSession)(url, { method: 'POST', body: JSON.stringify(body) })).status).toBe(
        200,
      );
    });
    it('binds the memory resource to the account without touching the rest of the request', async () => {
      const sent = { messages: [], model: 'provider/model', memory: { thread: 'thread-1', resource: 'creator-agent' } };
      server.use(
        http.post(url, async ({ request }) => {
          expect(await request.json()).toEqual({
            ...sent,
            memory: { thread: 'thread-1', resource: adminSession.resourceId },
          });
          return HttpResponse.json({ ok: true });
        }),
      );
      expect((await createAccountFetch(adminSession)(url, { method: 'POST', body: JSON.stringify(sent) })).status).toBe(
        200,
      );
    });
    it('binds the resource on thread messages, including idle stream options', async () => {
      const messageUrl = url.replace('/stream', '/send-message');
      const sent = {
        message: 'hi',
        threadId: 'thread-1',
        resourceId: 'creator-agent',
        ifIdle: {
          streamOptions: { model: 'provider/model', memory: { thread: 'thread-1', resource: 'creator-agent' } },
        },
      };
      server.use(
        http.post(messageUrl, async ({ request }) => {
          expect(await request.json()).toEqual({
            ...sent,
            resourceId: adminSession.resourceId,
            ifIdle: {
              streamOptions: {
                model: 'provider/model',
                memory: { thread: 'thread-1', resource: adminSession.resourceId },
              },
            },
          });
          return HttpResponse.json({ ok: true });
        }),
      );
      expect(
        (await createAccountFetch(adminSession)(messageUrl, { method: 'POST', body: JSON.stringify(sent) })).status,
      ).toBe(200);
    });
  });
});
