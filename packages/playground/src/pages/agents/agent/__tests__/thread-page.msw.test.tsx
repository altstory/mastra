// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { readThreadDraft } from '@mastra/playground-ui/domains/agents/chat/drafts/thread-draft-storage';
import { LinkComponentProvider } from '@mastra/playground-ui/lib/framework';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { deleteDB, openDB } from 'idb';
import { http, HttpResponse } from 'msw';
import { createContext, useContext, useEffect, useImperativeHandle, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentSession from '../session';
import AgentThread from '../thread';
import {
  draftFeedback,
  draftMcpServers,
  draftMemoryConfig,
  draftStream,
  draftUser,
  draftWorkingMemory,
} from './fixtures/drafts';
import {
  preferenceModelProviders,
  memoryConfig,
  workingMemory,
  voiceSpeakers,
  mcpServers,
  preferenceThread,
} from './fixtures/thread-preferences';
import { emptyHistory, liveChunks, staleHistory } from './fixtures/thread-recovery';
import { generatedTitleChunk, titleMemoryConfig } from './fixtures/thread-title';
import { emptyThreadTracesList } from './fixtures/thread-traces';
import { installPreferenceFixture } from '@/domains/account/__tests__/fixtures/preferences';
import { AgentLayout } from '@/domains/agents/agent-layout';
import { installOrganizationFixture } from '@/domains/navigation/__tests__/fixtures/conversation-projects';
import { SidebarConversations } from '@/domains/navigation/components/sidebar-conversations';
import { agentIndexLoader, agentThreadsIndexLoader, legacyAgentChatLoader, paths } from '@/lib/app-routing';
import { Link } from '@/lib/link';
import { server } from '@/test/msw-server';

const BASE_URL = 'http://localhost:4111';
const AGENT_ID = 'chef-agent';
const THREAD_ID = 'thread-1';
// Live output travels through a real SSE stream (subscribe → parse → useChat merge)
// and is then paced word by word by the markdown reveal buffer, which replays when
// the message row remounts. Both are far slower than a JSON fetch when the whole
// suite runs in parallel, so those assertions get more than waitFor's 1s default.
const SSE_TIMEOUT = { timeout: 5000 };
// Attachment reads and IndexedDB restores are slow on loaded machines; do not rely on the 1 s default.
const ATTACHMENT_TIMEOUT = { timeout: 10_000 };

// jsdom has no layout, so react-resizable-panels never resizes anything and
// `collapse()`/`expand()` are silently ignored. Replace Group/Panel with a
// deterministic stand-in that keeps sizes in React state, fires `onResize`,
// and reports the layout to the Group so the real `useDefaultLayout` still
// persists it. Everything else (usePanelRef, useDefaultLayout) is the real lib.
vi.mock('react-resizable-panels', async () => {
  const actual = await vi.importActual<typeof import('react-resizable-panels')>('react-resizable-panels');

  type PanelSize = { inPixels: number; asPercentage: number };
  type Handle = {
    collapse: () => void;
    expand: () => void;
    resize: (size: string | number) => void;
    getSize: () => PanelSize;
    isCollapsed: () => boolean;
  };

  const LayoutContext = createContext<{ report: (id: string, size: number) => void }>({ report: () => {} });
  const toNumber = (size: string | number | undefined, fallback: number) =>
    size === undefined ? fallback : typeof size === 'number' ? size : Number.parseFloat(size);

  const Group = ({
    className,
    children,
    onLayoutChange,
  }: {
    className?: string;
    children: ReactNode;
    onLayoutChange?: (layout: Record<string, number>) => void;
  }) => {
    const [layout, setLayout] = useState<Record<string, number>>({});
    const report = (id: string, size: number) =>
      setLayout(prev => (prev[id] === size ? prev : { ...prev, [id]: size }));

    useEffect(() => {
      if (Object.keys(layout).length > 0) onLayoutChange?.(layout);
    }, [layout, onLayoutChange]);

    return (
      <LayoutContext.Provider value={{ report }}>
        <div data-testid="panel-group" className={className}>
          {children}
        </div>
      </LayoutContext.Provider>
    );
  };

  const Panel = ({
    id,
    className,
    children,
    panelRef,
    defaultSize,
    collapsedSize,
    onResize,
    style,
  }: {
    id?: string;
    className?: string;
    children?: ReactNode;
    panelRef?: Ref<Handle>;
    defaultSize?: string | number;
    collapsedSize?: number;
    onResize?: (size: PanelSize, prev: PanelSize | undefined, id: string) => void;
    style?: React.CSSProperties;
  }) => {
    const { report } = useContext(LayoutContext);
    const expandedSize = toNumber(defaultSize, 300);
    const [size, setSize] = useState(expandedSize);

    useImperativeHandle(panelRef, () => ({
      collapse: () => setSize(collapsedSize ?? 0),
      expand: () => setSize(expandedSize),
      resize: next => setSize(toNumber(next, expandedSize)),
      getSize: () => ({ inPixels: size, asPercentage: size }),
      isCollapsed: () => size <= (collapsedSize ?? 0),
    }));

    useEffect(() => {
      onResize?.({ inPixels: size, asPercentage: size }, undefined, id ?? '');
      if (id) report(id, size);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to size changes
    }, [size]);

    return (
      <section data-testid={`panel-${id}`} className={className} style={style}>
        {children}
      </section>
    );
  };

  const Separator = () => <div data-testid="panel-separator" />;

  return { ...actual, Group, Panel, Separator };
});

const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
};

const AppShell = () => (
  <Sidebar.Provider>
    <SidebarConversations />
    <Outlet />
  </Sidebar.Provider>
);

const buildRouter = (initialEntry: string) =>
  createMemoryRouter(
    [
      {
        element: <AppShell />,
        children: [
          { path: '/agents', element: <LocationProbe /> },
          {
            path: '/chat/:agentId/projects/:projectId',
            element: (
              <AgentLayout mode="conversation">
                <AgentThread />
              </AgentLayout>
            ),
          },
          {
            path: '/chat/:agentId/threads/:threadId',
            element: (
              <>
                <LocationProbe />
                <AgentLayout mode="conversation">
                  <AgentThread />
                </AgentLayout>
              </>
            ),
          },
          {
            // Mirrors App.tsx: the thread page is a child of the agent tabs layout.
            path: '/agents/:agentId',
            element: (
              <>
                <LocationProbe />
                <AgentLayout>
                  <Outlet />
                </AgentLayout>
              </>
            ),
            children: [
              { index: true, loader: agentIndexLoader },
              { path: 'traces', element: <div data-testid="agent-management" /> },
              { path: 'chat', loader: legacyAgentChatLoader },
              { path: 'chat/:threadId', loader: legacyAgentChatLoader },
              { path: 'threads', loader: agentThreadsIndexLoader },
              { path: 'threads/:threadId', element: <AgentThread /> },
              { path: 'session/:threadId', element: <AgentSession /> },
            ],
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );

const renderAt = (
  initialEntry: string,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
  baseUrl = BASE_URL,
) => {
  const router = buildRouter(initialEntry);

  render(
    <MastraReactProvider baseUrl={baseUrl}>
      <QueryClientProvider client={queryClient}>
        <LinkComponentProvider Link={Link} navigate={to => void router.navigate(to)} paths={paths}>
          <RouterProvider router={router} />
        </LinkComponentProvider>
      </QueryClientProvider>
    </MastraReactProvider>,
  );

  return router;
};

const agentResponse = {
  id: AGENT_ID,
  name: 'Chef Agent',
  instructions: 'cook things',
  tools: {},
  workflows: {},
  provider: 'openai',
  modelId: 'gpt-5-mini',
  modelVersion: 'v2',
  supportsMemory: true,
  defaultOptions: {},
};

const threadsResponse = {
  threads: [
    {
      id: THREAD_ID,
      resourceId: AGENT_ID,
      title: 'Pasta night',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'thread-2',
      resourceId: AGENT_ID,
      title: 'Sushi ideas',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

const onTracesRequest = vi.fn<(threadId: string | null) => void>();

function installHandlers(baseUrl = BASE_URL) {
  installOrganizationFixture();
  installPreferenceFixture();
  const emptyTraces = ({ request }: { request: Request }) => {
    onTracesRequest(new URL(request.url).searchParams.get('threadId'));
    return HttpResponse.json(emptyThreadTracesList);
  };
  server.use(
    http.get(`${baseUrl}/api/auth/capabilities`, () => HttpResponse.json({ enabled: false })),
    http.get(`${baseUrl}/api/agents`, () => HttpResponse.json({ [AGENT_ID]: agentResponse })),
    http.get(`${baseUrl}/api/channels/platforms`, () => HttpResponse.json([])),
    http.get(`${baseUrl}/api/mcp/v0/servers`, () => HttpResponse.json(draftMcpServers)),
    http.get(`${baseUrl}/api/observability/feedback`, () => HttpResponse.json(draftFeedback)),
    http.get(`${baseUrl}/api/agents/:agentId/voice/speakers`, () => HttpResponse.json([])),
    http.get(`${baseUrl}/api/memory/config`, () => HttpResponse.json(draftMemoryConfig)),
    http.get(`${baseUrl}/api/memory/threads/:threadId/working-memory`, () => HttpResponse.json(draftWorkingMemory)),
    http.get(`${baseUrl}/api/memory/threads/:threadId`, ({ params }) => {
      const thread = threadsResponse.threads.find(thread => thread.id === params.threadId);
      return thread ? HttpResponse.json(thread) : new HttpResponse(undefined, { status: 404 });
    }),
    http.post(`${baseUrl}/api/agents/:agentId/threads/subscribe`, () => new HttpResponse(undefined, { status: 404 })),
    http.get(`${baseUrl}/api/agents/${AGENT_ID}`, () => HttpResponse.json(agentResponse)),
    http.get(`${baseUrl}/api/memory/status`, () => HttpResponse.json({ result: true, memoryType: 'local' })),
    http.get(`${baseUrl}/api/memory/threads`, () => HttpResponse.json(threadsResponse)),
    http.get(`${baseUrl}/api/memory/threads/:threadId/messages`, () =>
      HttpResponse.json({
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            type: 'text',
            createdAt: new Date().toISOString(),
            content: { format: 2, parts: [{ type: 'text', text: 'Tonight we cook carbonara.' }] },
          },
        ],
      }),
    ),
    http.get(`${baseUrl}/api/observability/traces/light`, emptyTraces),
    http.get(`${baseUrl}/api/observability/traces`, emptyTraces),
    http.get(`${baseUrl}/api/agents/providers`, () =>
      HttpResponse.json({
        providers: [
          { id: 'openai', name: 'OpenAI', envVar: 'OPENAI_API_KEY', connected: true, models: ['gpt-5-mini'] },
        ],
      }),
    ),
    http.get(`${baseUrl}/api/editor/builder/settings`, () =>
      HttpResponse.json({ enabled: false, modelPolicy: { active: false } }),
    ),
    http.get(`${baseUrl}/api/editor/builder/models/available`, () => HttpResponse.json({ providers: [] })),
    http.get(`${baseUrl}/api/system/packages`, () => HttpResponse.json({})),
  );
}

afterEach(async () => {
  cleanup();
  await readThreadDraft('__drain__');
  await deleteDB('mastra-composer-drafts');
  onTracesRequest.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function composerInput(placeholder = 'Enter your message') {
  await screen.findByPlaceholderText(placeholder);
  await waitFor(() => expect(screen.queryByText('Restoring draft…')).toBeNull());
  return screen.getByPlaceholderText<HTMLTextAreaElement>(placeholder);
}

describe('Standalone thread page', () => {
  describe('when starting a chat from a project homepage', () => {
    it('sends through the real composer and saves the resulting conversation in that project', async () => {
      installHandlers();
      const scope = JSON.stringify([BASE_URL, undefined, 'local']);
      const storageKey = `mastra:conversation-projects:${scope}`;
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          projects: [{ id: 'writing', name: 'My writing', agentId: AGENT_ID, threads: [] }],
          pinned: [],
          collapsed: [],
        }),
      );
      let createdThreadId: string | undefined;
      server.use(
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          const body = await request.json();
          createdThreadId = body.memory.thread;
          return new HttpResponse('data: {"type":"finish","payload":{}}\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );
      const organization = installOrganizationFixture();
      const router = renderAt(`/chat/${AGENT_ID}/projects/writing`);
      await screen.findByRole('heading', { name: 'My writing' });
      expect(await screen.findByRole('tab', { name: 'Sources' })).toBeTruthy();
      const input = await composerInput('New chat in My writing');
      fireEvent.change(input, { target: { value: 'Write an opening' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(createdThreadId).toBeTruthy());
      await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${AGENT_ID}/threads/${createdThreadId}`));
      expect(organization.state.projects[0].threads).toContain(createdThreadId);
      expect(localStorage.getItem(storageKey)).toBeNull();
    });

    it('keeps unsent drafts separate between projects and regular new chats', async () => {
      installHandlers();
      const scope = JSON.stringify([BASE_URL, undefined, 'local']);
      localStorage.setItem(
        `mastra:conversation-projects:${scope}`,
        JSON.stringify({
          projects: [
            { id: 'writing', name: 'My writing', threads: [] },
            { id: 'research', name: 'Research', threads: [] },
          ],
          pinned: [],
          collapsed: [],
        }),
      );
      installOrganizationFixture();
      const router = renderAt(`/chat/${AGENT_ID}/projects/writing`);
      fireEvent.change(await composerInput('New chat in My writing'), { target: { value: 'Writing draft' } });
      await act(() => router.navigate(`/chat/${AGENT_ID}/projects/research`));
      expect((await composerInput('New chat in Research')).value).toBe('');
      await act(() => router.navigate(`/chat/${AGENT_ID}/threads/new`));
      expect((await composerInput()).value).toBe('');
      await act(() => router.navigate(`/chat/${AGENT_ID}/projects/writing`));
      expect((await composerInput('New chat in My writing')).value).toBe('Writing draft');
    });
  });
  describe('when automatic titles are configured by the agent', () => {
    it('requests the persisted-title event on the reply stream', async () => {
      installHandlers();
      const sent = vi.fn();
      let titleSaved = false;
      server.use(
        http.get(`${BASE_URL}/api/memory/config`, () => HttpResponse.json(titleMemoryConfig)),
        http.get(`${BASE_URL}/api/memory/threads`, () =>
          HttpResponse.json({
            threads: threadsResponse.threads.map(thread =>
              thread.id === THREAD_ID && titleSaved ? { ...thread, title: 'Carbonara tips' } : thread,
            ),
          }),
        ),
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          const body = await request.json();
          sent(body);
          // Like the server, publish only after saving, and only when the request opts in.
          titleSaved = body.memory?.options?.generateTitle?.emitEvent === true;
          const titleEvent = titleSaved ? `data: ${JSON.stringify(generatedTitleChunk)}\n\n` : '';
          return new HttpResponse(`${titleEvent}data: {"type":"finish","payload":{}}\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }),
      );
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      await screen.findByText('Tonight we cook carbonara.');
      const input = await composerInput();
      await waitFor(() => expect(input.disabled).toBe(false));
      fireEvent.change(input, { target: { value: 'How do I cook carbonara?' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledOnce());
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          memory: expect.objectContaining({ options: expect.objectContaining({ generateTitle: { emitEvent: true } }) }),
        }),
      );
      await screen.findByText('Carbonara tips', {}, SSE_TIMEOUT);
    });
  });

  describe('when a generated title arrives on the open thread subscription', () => {
    it('updates the sidebar without leaving the conversation or sending another message', async () => {
      installHandlers();
      let pushTitle = () => {};
      let close = () => {};
      let titleSaved = false;
      server.use(
        http.get(`${BASE_URL}/api/memory/threads`, () =>
          HttpResponse.json({
            threads: threadsResponse.threads.map(thread =>
              thread.id === THREAD_ID && titleSaved ? { ...thread, title: 'Carbonara tips' } : thread,
            ),
          }),
        ),
        http.post(
          `${BASE_URL}/api/agents/${AGENT_ID}/threads/subscribe`,
          () =>
            new HttpResponse(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  close = () => controller.close();
                  pushTitle = () => {
                    titleSaved = true;
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(generatedTitleChunk)}\n\n`));
                  };
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            ),
        ),
      );
      const router = renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      try {
        await screen.findByText('Pasta night');
        await screen.findByRole('button', { name: /GPT-5 Mini/ });
        await act(async () => pushTitle());
        await screen.findByText('Carbonara tips', {}, SSE_TIMEOUT);
        expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
        expect(screen.queryByText('Pasta night')).toBeNull();
      } finally {
        close();
      }
    });
  });

  describe('when a history response arrives after live output', () => {
    it.each([
      { name: 'empty', history: emptyHistory },
      { name: 'stale', history: staleHistory },
    ])('preserves the streamed response with $name history', async ({ history }) => {
      installHandlers();
      let releaseHistory = () => {};
      const gate = new Promise<void>(resolve => {
        releaseHistory = resolve;
      });
      let push: (() => void) | undefined;
      let close = () => {};
      const historyReturned = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}/voice/speakers`, () => HttpResponse.json([])),
        http.get(`${BASE_URL}/api/memory/config`, () => HttpResponse.json({ config: {} })),
        http.get(`${BASE_URL}/api/memory/threads/:threadId/working-memory`, () =>
          HttpResponse.json({ workingMemory: null }),
        ),
        http.get(`${BASE_URL}/api/memory/threads/:threadId`, () => HttpResponse.json(threadsResponse.threads[0])),
        http.get(`${BASE_URL}/api/mcp/v0/servers`, () => HttpResponse.json({ servers: [] })),
        http.get(`${BASE_URL}/api/memory/threads/:threadId/messages`, async () => {
          await gate;
          historyReturned();
          return HttpResponse.json(history);
        }),
        http.post(
          `${BASE_URL}/api/agents/${AGENT_ID}/threads/subscribe`,
          () =>
            new HttpResponse(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  close = () => controller.close();
                  push = () => {
                    for (const chunk of liveChunks)
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  };
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            ),
        ),
      );
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`, queryClient);
      try {
        await screen.findByRole('button', { name: /GPT-5 Mini/ });
        await waitFor(() => expect(push).toBeDefined());
        await act(async () => push?.());
        await waitFor(() => expect(document.body.textContent).toContain('Live response survives'), SSE_TIMEOUT);
        // Live messages take precedence over the history skeleton.
        expect(screen.queryByTestId('thread-history-skeleton')).toBeNull();
        await act(async () => releaseHistory());
        await waitFor(() =>
          expect(
            queryClient.getQueryCache().find({ queryKey: ['memory', 'messages', THREAD_ID, AGENT_ID], exact: false })
              ?.state.status,
          ).toBe('success'),
        );
        expect(historyReturned).toHaveBeenCalledOnce();
        await waitFor(
          () => expect(document.body.textContent?.split('Live response survives')).toHaveLength(2),
          SSE_TIMEOUT,
        );
        expect(document.body.textContent).not.toContain('Old partial output');
        if (history.messages.length) expect(document.body.textContent).toContain('Earlier prompt');
      } finally {
        releaseHistory();
        close();
      }
    });
  });

  describe('when opening an existing thread whose history is still loading', () => {
    it('shows the history skeleton, then the messages once history resolves', async () => {
      installHandlers();
      let releaseHistory = () => {};
      const gate = new Promise<void>(resolve => {
        releaseHistory = resolve;
      });
      server.use(
        http.get(`${BASE_URL}/api/memory/threads/:threadId/messages`, async () => {
          await gate;
          return HttpResponse.json(staleHistory);
        }),
      );
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      try {
        expect(await screen.findByTestId('thread-history-skeleton')).not.toBeNull();
        expect(screen.queryByText('How can I help you today?')).toBeNull();

        await act(async () => releaseHistory());

        expect(await screen.findByText('Earlier prompt')).not.toBeNull();
        expect(screen.queryByTestId('thread-history-skeleton')).toBeNull();
      } finally {
        releaseHistory();
      }
    });
  });

  describe('when opening a new thread', () => {
    it('shows the welcome screen immediately without a skeleton', async () => {
      installHandlers();
      const messagesRequested = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/memory/threads/:threadId/messages`, () => {
          messagesRequested();
          return HttpResponse.json(emptyHistory);
        }),
      );
      renderAt(`/agents/${AGENT_ID}/threads/new`);

      expect(await screen.findByTestId('thread-welcome')).not.toBeNull();
      expect(screen.queryByTestId('thread-history-skeleton')).toBeNull();
      expect(messagesRequested).not.toHaveBeenCalled();
    });
  });

  describe('when the agent has memory disabled', () => {
    it('shows the welcome screen immediately without a skeleton', async () => {
      installHandlers();
      const messagesRequested = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/memory/status`, () => HttpResponse.json({ result: false })),
        http.get(`${BASE_URL}/api/memory/threads/:threadId/messages`, () => {
          messagesRequested();
          return HttpResponse.json(emptyHistory);
        }),
      );
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

      expect(await screen.findByTestId('thread-welcome')).not.toBeNull();
      expect(screen.queryByTestId('thread-history-skeleton')).toBeNull();
      expect(messagesRequested).not.toHaveBeenCalled();
    });
  });

  describe('when a first signal message is accepted', () => {
    it.each(['stay', 'navigate', 'reload', 'new-chat'] as const)(
      'preserves thread identity and navigation when the user chooses to %s',
      async action => {
        installHandlers();
        const sent = vi.fn();
        let release = () => {};
        const gate = new Promise<void>(resolve => {
          release = resolve;
        });
        const acknowledged = vi.fn();
        const refreshedAfterAck = vi.fn();
        const ids: string[] = [];
        let reloading = false;
        const closes: Array<() => void> = [];
        server.use(
          http.get(`${BASE_URL}/api/memory/threads`, () => {
            if (acknowledged.mock.calls.length) refreshedAfterAck();
            return HttpResponse.json(threadsResponse);
          }),
          http.get(`${BASE_URL}/api/agents/${AGENT_ID}/voice/speakers`, () => HttpResponse.json([])),
          http.get(`${BASE_URL}/api/memory/config`, () => HttpResponse.json({ config: {} })),
          http.get(`${BASE_URL}/api/memory/threads/:threadId/working-memory`, () =>
            HttpResponse.json({ workingMemory: null }),
          ),
          http.get(`${BASE_URL}/api/memory/threads/:threadId`, () => HttpResponse.json(threadsResponse.threads[0])),
          http.get(`${BASE_URL}/api/mcp/v0/servers`, () => HttpResponse.json({ servers: [] })),
          http.get(`${BASE_URL}/api/memory/threads/:threadId/messages`, () => HttpResponse.json(emptyHistory)),
          http.post(`${BASE_URL}/api/agents/${AGENT_ID}/send-message`, async ({ request }) => {
            sent(await request.json());
            await gate;
            acknowledged();
            return HttpResponse.json({ accepted: true, runId: 'recovery-run' });
          }),
          http.post(`${BASE_URL}/api/agents/${AGENT_ID}/threads/subscribe`, async ({ request }) => {
            const body: unknown = await request.json();
            if (body && typeof body === 'object' && 'threadId' in body && typeof body.threadId === 'string')
              ids.push(body.threadId);
            let closed = false;
            return new HttpResponse(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  closes.push(() => {
                    if (!closed) {
                      closed = true;
                      controller.close();
                    }
                  });
                  if (reloading) {
                    for (const chunk of liveChunks)
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                },
                cancel() {
                  closed = true;
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          }),
        );
        const router = renderAt(`/agents/${AGENT_ID}/threads/new`);
        try {
          await waitFor(() => expect(ids.length).toBeGreaterThan(0));
          const input = await composerInput();
          // Model-default hydration may remount an unused chat before the composer is ready.
          const subscriptionCount = ids.length;
          const sentThreadId = ids[subscriptionCount - 1];
          fireEvent.change(input, { target: { value: 'Keep this conversation' } });
          fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
          await waitFor(() => expect(sent).toHaveBeenCalledOnce());
          if (action === 'navigate' || action === 'new-chat') {
            await act(() => router.navigate(`/agents/${AGENT_ID}/threads/${THREAD_ID}`));
          }
          if (action === 'new-chat') {
            await act(() => router.navigate(`/agents/${AGENT_ID}/threads/new`));
            fireEvent.change(await composerInput(), { target: { value: 'Draft for new chat B' } });
          }
          await act(async () => release());
          await waitFor(() => expect(refreshedAfterAck).toHaveBeenCalled());
          if (action === 'navigate') {
            expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
          } else if (action === 'new-chat') {
            expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}/threads/new`);
            expect((await composerInput()).value).toBe('Draft for new chat B');
            cleanup();
            renderAt(`/agents/${AGENT_ID}/threads/new`);
            expect((await composerInput()).value).toBe('Draft for new chat B');
          } else {
            await waitFor(() =>
              expect(router.state.location.pathname).toBe(`/agents/${AGENT_ID}/threads/${sentThreadId}`),
            );
            expect(router.state.historyAction).toBe('REPLACE');
            expect(document.body.textContent).toContain('Keep this conversation');
            if (action === 'reload') {
              const savedPath = router.state.location.pathname;
              const subscriptionsBeforeReload = ids.length;
              reloading = true;
              cleanup();
              renderAt(savedPath);
              await waitFor(() => expect(ids.length).toBeGreaterThan(subscriptionsBeforeReload));
              await waitFor(() => expect(document.body.textContent).toContain('Live response survives'), SSE_TIMEOUT);
            }
            expect(new Set(ids.slice(subscriptionCount - 1)).size).toBe(1);
          }
        } finally {
          release();
          for (const close of closes) close();
        }
      },
    );
  });
  describe('when a saved draft cannot be decoded', () => {
    it('starts empty and saves subsequent edits without recovery controls', async () => {
      installHandlers();
      const path = `/agents/${AGENT_ID}/threads/${THREAD_ID}`;
      renderAt(path);
      fireEvent.change(await composerInput(), { target: { value: 'Original' } });
      cleanup();
      await readThreadDraft('__drain__');
      const db = await openDB('mastra-composer-drafts');
      const [key] = await db.getAllKeys('drafts');
      await db.put('drafts', { key, text: 42 });
      db.close();
      renderAt(path);
      const input = await composerInput();
      expect(input.value).toBe('');
      expect(screen.queryByRole('button', { name: 'Discard unreadable saved draft' })).toBeNull();
      fireEvent.change(input, { target: { value: 'Keep my current edits' } });
      expect(screen.queryByText('Saving draft…')).toBeNull();
      cleanup();
      renderAt(path);
      expect((await composerInput()).value).toBe('Keep my current edits');
    });
  });

  describe('when a saved draft is still being restored', () => {
    it('ignores files dragged over the page', async () => {
      installHandlers();
      renderAt(`/agents/${AGENT_ID}/threads/new`);
      await screen.findByText('Restoring draft…');
      const event = new Event('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      act(() => {
        fireEvent(window, event);
      });
      expect(screen.queryByText('Drop to attach')).toBeNull();
    });
  });

  describe('when authentication status cannot be checked', () => {
    it.each([false, true])(
      'blocks fallback composing and restores the saved draft after recovery (retryOnMount=%s)',
      async retryOnMount => {
        installHandlers();
        const path = `/agents/${AGENT_ID}/threads/new`;
        renderAt(path);
        fireEvent.change(await composerInput(), { target: { value: 'Existing safe draft' } });
        cleanup();
        server.use(http.get(`${BASE_URL}/api/auth/capabilities`, () => new HttpResponse(null, { status: 503 })));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount } } });
        renderAt(path, client);
        await screen.findByText('Failed to check authentication');
        expect(screen.queryByPlaceholderText('Enter your message')).toBeNull();
        server.use(http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json({ enabled: false })));
        await act(async () => {
          await client.invalidateQueries({ queryKey: ['auth', 'capabilities'] });
        });
        expect((await composerInput()).value).toBe('Existing safe draft');
      },
    );
  });

  describe('when an unsent draft is entered', () => {
    it('keeps a newer New Chat draft when an earlier legacy stream finishes', async () => {
      installHandlers();
      const response = draftStream();
      const sent = vi.fn();
      const refreshed = vi.fn();
      let finished = false;
      server.use(
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          sent(await request.json());
          return new HttpResponse(response.stream, { headers: { 'content-type': 'text/event-stream' } });
        }),
        http.get(`${BASE_URL}/api/memory/threads`, () => {
          if (finished) refreshed();
          return HttpResponse.json(threadsResponse);
        }),
      );
      const path = `/agents/${AGENT_ID}/threads/new`;
      const router = renderAt(path);
      const input = await composerInput();
      fireEvent.change(input, { target: { value: 'Send from A' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledOnce());
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/${THREAD_ID}`));
      await composerInput();
      await act(() => router.navigate(path));
      fireEvent.change(await composerInput(), { target: { value: 'Draft for new chat B' } });
      finished = true;
      await act(async () => response.finish());
      await waitFor(() => expect(refreshed).toHaveBeenCalled());
      expect(router.state.location.pathname).toBe(path);
      expect((await composerInput()).value).toBe('Draft for new chat B');
      cleanup();
      renderAt(path);
      expect((await composerInput()).value).toBe('Draft for new chat B');
    });
    it.each([false, true])(
      'restores and sends the complete attachment while preserving newer edits: %s',
      async editWhilePreparing => {
        // jsdom Blobs lack native structured-clone support. Native Blob cloning is covered by the storage tests.
        const clone = globalThis.structuredClone;
        const cloneDom = (value: unknown): unknown => {
          if (value instanceof Blob) return value;
          if (Array.isArray(value)) return value.map(cloneDom);
          if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDom(item)]));
          }
          return clone(value);
        };
        vi.stubGlobal('structuredClone', cloneDom);
        const BrowserFile = File;
        vi.stubGlobal(
          'File',
          class extends BrowserFile {
            text() {
              return new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsText(this);
              });
            }
          },
        );
        try {
          installHandlers();
          const sent = vi.fn();
          const response = draftStream();
          server.use(
            http.post(`${BASE_URL}/api/agents/:agentId/stream`, async ({ request }) => {
              sent(await request.json());
              return new HttpResponse(response.stream, { headers: { 'Content-Type': 'text/event-stream' } });
            }),
          );
          const path = `/agents/${AGENT_ID}/threads/${THREAD_ID}`;
          renderAt(path);
          fireEvent.change(await composerInput(), { target: { value: 'Read my attachment' } });
          fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
          fireEvent.click(await screen.findByRole('menuitem', { name: 'Files' }));
          const picker = screen.getByLabelText('Files');
          const contents = 'name,note\r\nZoë,"hello\nworld"\r\n';
          fireEvent.change(picker, { target: { files: [new File([contents], 'leads.csv', { type: 'text/csv' })] } });
          await screen.findByRole('button', { name: 'Preview leads.csv' }, ATTACHMENT_TIMEOUT);
          cleanup();
          renderAt(path);
          const input = await composerInput();
          expect(input.value).toBe('Read my attachment');
          await screen.findByRole('button', { name: 'Preview leads.csv' }, ATTACHMENT_TIMEOUT);
          const originalRead = FileReader.prototype.readAsText;
          let finishReading = () => {};
          const reader = vi
            .spyOn(FileReader.prototype, 'readAsText')
            .mockImplementationOnce(function (this: FileReader, file, encoding) {
              finishReading = () => originalRead.call(this, file, encoding);
            });
          fireEvent.keyDown(input, { key: 'Enter' });
          if (editWhilePreparing) {
            fireEvent.change(input, { target: { value: 'Keep the next question' } });
            fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
            fireEvent.click(await screen.findByRole('menuitem', { name: 'Files' }));
            const nextPicker = screen.getByLabelText('Files');
            fireEvent.change(nextPicker, {
              target: { files: [new File(['Next file'], 'next.txt', { type: 'text/plain' })] },
            });
            await screen.findByRole('button', { name: 'Preview next.txt' }, ATTACHMENT_TIMEOUT);
          }
          finishReading();
          reader.mockRestore();
          await waitFor(() => expect(sent).toHaveBeenCalledOnce());
          expect(JSON.stringify(sent.mock.calls[0][0])).toContain(JSON.stringify(contents).slice(1, -1));
          await act(async () => response.finish());
          await waitFor(() =>
            expect(screen.queryAllByRole('button', { name: 'Remove next.txt' })).toHaveLength(
              editWhilePreparing ? 1 : 0,
            ),
          );
          expect(screen.queryByRole('button', { name: 'Remove leads.csv' })).toBeNull();
          cleanup();
          renderAt(path);
          expect((await composerInput()).value).toBe(editWhilePreparing ? 'Keep the next question' : '');
          expect(screen.queryByRole('button', { name: 'Remove leads.csv' })).toBeNull();
          expect(screen.queryAllByRole('button', { name: 'Remove next.txt' })).toHaveLength(editWhilePreparing ? 1 : 0);
          if (editWhilePreparing) await screen.findByRole('button', { name: 'Preview next.txt' }, ATTACHMENT_TIMEOUT);
        } finally {
          cleanup();
          await readThreadDraft('__drain__');
          vi.unstubAllGlobals();
        }
      },
      20_000,
    );
    it('restores separate drafts after navigating between threads', async () => {
      installHandlers();
      const router = renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      const input = await composerInput();
      fireEvent.change(input, { target: { value: 'Pasta draft' } });
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/thread-2`));
      expect((await composerInput()).value).toBe('');
      fireEvent.change(screen.getByPlaceholderText('Enter your message'), { target: { value: 'Sushi draft' } });
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/${THREAD_ID}`));
      expect((await composerInput()).value).toBe('Pasta draft');
    });

    it.each([THREAD_ID, 'new'])('restores the %s draft after a fresh page mount', async threadId => {
      installHandlers();
      const path = `/agents/${AGENT_ID}/threads/${threadId}`;
      renderAt(path);
      fireEvent.change(await composerInput(), {
        target: { value: 'Unsent question about dinner' },
      });
      cleanup();
      renderAt(path);
      expect((await composerInput()).value).toBe('Unsent question about dinner');
    });

    it('keeps a New Chat draft separate from existing threads', async () => {
      installHandlers();
      const router = renderAt(`/agents/${AGENT_ID}/threads/new`);
      fireEvent.change(await composerInput(), {
        target: { value: 'A new dinner idea' },
      });
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/${THREAD_ID}`));
      expect((await composerInput()).value).toBe('');
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/new`));
      expect((await composerInput()).value).toBe('A new dinner idea');
    });

    it('does not expose anonymous drafts when authentication becomes required', async () => {
      installHandlers();
      const path = `/agents/${AGENT_ID}/threads/new`;
      renderAt(path);
      fireEvent.change(await composerInput(), { target: { value: 'Anonymous draft' } });
      cleanup();
      server.use(
        http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json({ enabled: true, login: null })),
      );
      renderAt(path);
      const input = await composerInput();
      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: 'Not authenticated' } });
      cleanup();
      installHandlers();
      renderAt(path);
      expect((await composerInput()).value).toBe('Anonymous draft');
    });

    it('isolates drafts belonging to different signed-in users', async () => {
      installHandlers();
      server.use(http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json(draftUser)));
      const path = `/agents/${AGENT_ID}/threads/new`;
      renderAt(path);
      fireEvent.change(await composerInput(), { target: { value: 'Private draft' } });
      cleanup();
      server.use(
        http.get(`${BASE_URL}/api/auth/capabilities`, () =>
          HttpResponse.json({ ...draftUser, user: { id: 'draft-user-2' } }),
        ),
      );
      renderAt(path);
      expect((await composerInput()).value).toBe('');
      cleanup();
      server.use(http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json(draftUser)));
      renderAt(path);
      expect((await composerInput()).value).toBe('Private draft');
    });

    it('isolates drafts belonging to different backends', async () => {
      const otherBackend = 'http://localhost:4222';
      installHandlers();
      installHandlers(otherBackend);
      const path = `/agents/${AGENT_ID}/threads/new`;
      renderAt(path);
      fireEvent.change(await composerInput(), { target: { value: 'Server one' } });
      cleanup();
      renderAt(path, undefined, otherBackend);
      expect((await composerInput()).value).toBe('');
      cleanup();
      renderAt(path);
      expect((await composerInput()).value).toBe('Server one');
    });

    it('isolates New Chat drafts belonging to different agents', async () => {
      installHandlers();
      server.use(
        http.get(`${BASE_URL}/api/agents/other-agent`, () =>
          HttpResponse.json({ ...agentResponse, id: 'other-agent' }),
        ),
      );
      const router = renderAt(`/agents/${AGENT_ID}/threads/new`);
      fireEvent.change(await composerInput(), { target: { value: 'Chef draft' } });
      await act(() => router.navigate('/agents/other-agent/threads/new'));
      expect((await composerInput()).value).toBe('');
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/new`));
      expect((await composerInput()).value).toBe('Chef draft');
    });

    it('moves follow-up typing to the real thread without resurrecting the sent draft', async () => {
      installHandlers();
      const response = draftStream();
      const sent = vi.fn();
      server.use(
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          sent(await request.json());
          return new HttpResponse(response.stream, { headers: { 'content-type': 'text/event-stream' } });
        }),
      );
      const router = renderAt(`/agents/${AGENT_ID}/threads/new`);
      const input = await composerInput();
      fireEvent.change(input, { target: { value: 'Send this question' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledOnce());
      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: 'Keep this follow-up' } });
      await act(async () => response.finish());
      // The router commits navigations in a transition, so wait for the created thread to render,
      // not just for the router state, before reading its composer or leaving it.
      await waitFor(() => expect(screen.getByTestId('location-probe').textContent).not.toContain('/threads/new'));
      const createdPath = router.state.location.pathname;
      expect((await composerInput()).value).toBe('Keep this follow-up');
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/new`));
      expect((await composerInput()).value).toBe('');
      cleanup();
      renderAt(createdPath);
      expect((await composerInput()).value).toBe('Keep this follow-up');
    });

    it('does not restore a draft that was erased', async () => {
      installHandlers();
      const path = `/agents/${AGENT_ID}/threads/${THREAD_ID}`;
      renderAt(path);
      const input = await composerInput();
      fireEvent.change(input, { target: { value: 'Discard this draft' } });
      fireEvent.change(input, { target: { value: '' } });
      cleanup();
      renderAt(path);
      expect((await composerInput()).value).toBe('');
    });
  });

  it('shows the thread conversation at /agents/:agentId/threads/:threadId', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    expect(await screen.findByText('Tonight we cook carbonara.')).not.toBeNull();
  });

  it('renders the composer model switcher with the agent model', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    await screen.findByText('Tonight we cook carbonara.');
    // Provider + model pill (needs PlaygroundModelProvider, which this page must supply itself).
    expect(await screen.findByRole('button', { name: /^Model:.*GPT-5 Mini$/ })).not.toBeNull();
    expect(await screen.findByText('GPT-5 Mini')).not.toBeNull();
    expect(screen.queryByTestId('composer-model-settings-trigger')).toBeNull();
  });

  it('shows the thread list next to the chat', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    await screen.findByText('Tonight we cook carbonara.');
    expect(await screen.findByText('Sushi ideas')).not.toBeNull();
  });

  it('does not add a second threads panel or capability footer to conversations', async () => {
    installHandlers();
    renderAt(`/chat/${AGENT_ID}/threads/${THREAD_ID}`);
    await screen.findByText('Sushi ideas');
    expect(screen.getAllByRole('region', { name: 'Recent' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Hide threads panel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show capability details' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  describe('when the thread list is still loading', () => {
    it('keeps the sidebar header in place without a skeleton, then fills in the threads', async () => {
      installHandlers();
      let releaseThreads!: () => void;
      const gate = new Promise<void>(resolve => (releaseThreads = resolve));
      server.use(
        http.get(`${BASE_URL}/api/memory/threads`, async () => {
          await gate;
          return HttpResponse.json(threadsResponse);
        }),
      );

      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

      expect(await screen.findByRole('link', { name: /New Thread/ })).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Hide threads panel' })).toBeNull();
      expect(screen.queryByTestId('agent-route-sidebar-skeleton')).toBeNull();
      expect(screen.queryByText(/Your conversations will appear here/)).toBeNull();

      releaseThreads();
      expect(await screen.findByText('Sushi ideas')).not.toBeNull();
    });
  });

  describe('when the agent is still loading', () => {
    it('keeps global recent conversations available next to the chat skeleton', async () => {
      installHandlers();
      let releaseAgent!: () => void;
      const gate = new Promise<void>(resolve => (releaseAgent = resolve));
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, async () => {
          await gate;
          return HttpResponse.json(agentResponse);
        }),
      );

      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

      expect(await screen.findByTestId('agent-thread-skeleton')).not.toBeNull();
      expect(await screen.findByRole('link', { name: /New Thread/ })).not.toBeNull();

      releaseAgent();
      expect(await screen.findByText('Sushi ideas')).not.toBeNull();
    });
  });

  describe('when the user reloads an agent without threads with a legacy panel preference', () => {
    it('shows global recent conversations without restoring an extra panel', async () => {
      installHandlers();
      server.use(
        http.get(`${BASE_URL}/api/memory/threads`, () =>
          HttpResponse.json({ ...threadsResponse, threads: [], total: 0 }),
        ),
      );
      window.localStorage.setItem(
        `react-resizable-panels:agent-layout-v6-${AGENT_ID}`,
        JSON.stringify({ 'left-slot': 300 }),
      );

      renderAt(`/agents/${AGENT_ID}/threads/new`);

      expect(await screen.findByText('No recent conversations')).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Hide threads panel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Expand panel' })).toBeNull();
    });
  });

  it('keeps the Chat tab out of the agent management bar', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    await screen.findByText('Tonight we cook carbonara.');
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull();
  });

  it('keeps the Chat tab out of legacy /threads/new', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/new`);

    await screen.findByText('Sushi ideas');
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
  });

  it('navigates to another thread when clicked in the list', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    const otherThread = await screen.findByText('Sushi ideas');
    fireEvent.click(otherThread);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe(`/chat/${AGENT_ID}/threads/thread-2`),
    );
  });

  it('redirects /agents/:agentId/threads to /threads/new', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/threads`);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe(`/agents/${AGENT_ID}/threads/new`),
    );
  });

  it('redirects bare /agents/:agentId to management', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}`);

    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe(`/agents/${AGENT_ID}/traces`));
  });

  it('redirects the legacy chat URL to /threads/:threadId preserving ?messageId=', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/chat/${THREAD_ID}?messageId=msg-1`);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe(
        `/agents/${AGENT_ID}/threads/${THREAD_ID}?messageId=msg-1`,
      ),
    );
  });

  it('redirects the legacy /chat URL to /threads/new', async () => {
    installHandlers();
    renderAt(`/agents/${AGENT_ID}/chat`);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe(`/agents/${AGENT_ID}/threads/new`),
    );
  });

  it.each([THREAD_ID, 'new'])('shows chat %s without management controls or global trace queries', async threadId => {
    installHandlers();
    renderAt(`/chat/${AGENT_ID}/threads/${threadId}`);
    await composerInput();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Config')).toBeNull();
    expect(onTracesRequest).not.toHaveBeenCalledWith(null);
  });

  it('shows the session expired screen on a 401', async () => {
    installHandlers();
    server.use(
      http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    expect((await screen.findAllByText(/session.*expired/i)).length).toBeGreaterThan(0);
  });

  it('shows the permission denied screen on a 403', async () => {
    installHandlers();
    server.use(
      http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })),
    );
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    expect(await screen.findByText('Permission Denied')).not.toBeNull();
  });

  describe('thread deletion', () => {
    // Regression for #22763: the standalone sidebar shipped without any delete
    // affordance on thread rows, so persisted threads could not be removed.
    it('deletes a thread from the sidebar after confirmation and refreshes the list', async () => {
      installHandlers();
      const onDelete = vi.fn<() => void>();
      let deleted = false;
      server.use(
        http.get(`${BASE_URL}/api/memory/threads`, () =>
          HttpResponse.json(
            deleted ? { threads: threadsResponse.threads.filter(t => t.id !== 'thread-2') } : threadsResponse,
          ),
        ),
        http.delete(`${BASE_URL}/api/memory/threads/thread-2`, ({ request }) => {
          onDelete();
          expect(new URL(request.url).searchParams.get('agentId')).toBe(AGENT_ID);
          deleted = true;
          return HttpResponse.json({ result: 'deleted' });
        }),
      );

      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      await screen.findByText('Sushi ideas');

      const menus = screen.getAllByRole('button', { name: 'Thread actions' });
      expect(menus).toHaveLength(2);
      fireEvent.click(menus[1]);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

      // Confirmation dialog gates the deletion.
      expect(await screen.findByText('Are you absolutely sure?')).not.toBeNull();
      expect(onDelete).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText('Sushi ideas')).toBeNull());
      // The non-active thread was deleted: no redirect away from the current thread.
      expect(screen.getByTestId('location-probe').textContent).toBe(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
    });

    it('redirects to /threads/new when the active thread is deleted', async () => {
      installHandlers();
      server.use(
        http.delete(`${BASE_URL}/api/memory/threads/${THREAD_ID}`, () => HttpResponse.json({ result: 'deleted' })),
      );

      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      await screen.findByText('Pasta night');

      fireEvent.click(screen.getAllByRole('button', { name: 'Thread actions' })[0]);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

      await waitFor(() =>
        expect(screen.getByTestId('location-probe').textContent).toBe(`/chat/${AGENT_ID}/threads/new`),
      );
    });

    it('hides the delete control when the user lacks the memory:delete permission', async () => {
      installHandlers();
      server.use(
        http.get(`${BASE_URL}/api/auth/capabilities`, () =>
          HttpResponse.json({
            enabled: true,
            login: { type: 'credentials' },
            user: { id: 'user-1', email: 'user@example.com' },
            capabilities: { user: true, session: true, sso: false, rbac: true, acl: false },
            access: { roles: ['member'], permissions: ['agents:read', 'memory:read'] },
          }),
        ),
      );

      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      await screen.findByText('Sushi ideas');

      fireEvent.click(screen.getAllByRole('button', { name: 'Thread actions' })[1]);
      expect(await screen.findByRole('menuitem', { name: 'Pin' })).not.toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    });
  });

  describe('thread rename', () => {
    async function renameSushiThread(title: string) {
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      await screen.findByText('Sushi ideas');
      fireEvent.click(screen.getAllByRole('button', { name: 'Thread actions' })[1]);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: title } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    }

    describe('when the server accepts the rename', () => {
      it('shows the new title in the thread list', async () => {
        installHandlers();
        let renamed = false;
        server.use(
          http.get(`${BASE_URL}/api/memory/threads`, () =>
            HttpResponse.json(
              renamed
                ? {
                    ...threadsResponse,
                    threads: threadsResponse.threads.map(t => (t.id === 'thread-2' ? { ...t, title: 'Omakase' } : t)),
                  }
                : threadsResponse,
            ),
          ),
          http.patch(`${BASE_URL}/api/memory/threads/thread-2`, async ({ request }) => {
            expect(await request.json()).toMatchObject({ title: 'Omakase' });
            renamed = true;
            const thread = threadsResponse.threads.find(t => t.id === 'thread-2');
            return HttpResponse.json({ ...thread, title: 'Omakase' });
          }),
        );

        await renameSushiThread('Omakase');

        expect(await screen.findByText('Omakase')).not.toBeNull();
        expect(screen.queryByText('Sushi ideas')).toBeNull();
      });
    });

    describe('when the server rejects the rename', () => {
      it('keeps the previous title', async () => {
        installHandlers();
        const rejected = vi.fn();
        server.use(
          http.patch(`${BASE_URL}/api/memory/threads/thread-2`, () => {
            rejected();
            return HttpResponse.json({ error: 'boom' }, { status: 500 });
          }),
        );

        await renameSushiThread('Omakase');

        await waitFor(() => expect(rejected).toHaveBeenCalled(), { timeout: 5000 });
        await waitFor(
          () => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false),
          { timeout: 5000 },
        );
        expect(screen.getByRole('dialog')).not.toBeNull();
        expect(screen.getAllByText('Sushi ideas').length).toBeGreaterThan(0);
      });
    });
  });

  describe('when the removed settings panel left saved overrides', () => {
    it.each(['threads', 'session'])('streams with agent defaults on the %s page', async route => {
      installHandlers();
      const stored = {
        modelSettings: {
          chatWithGenerate: true,
          chatWithNetwork: true,
          chatWithLegacyStream: true,
          temperature: 0.2,
          topP: 0.4,
          maxSteps: 99,
          requireToolApproval: false,
        },
      };
      localStorage.setItem(
        `mastra-thread-preferences-${JSON.stringify([AGENT_ID, THREAD_ID])}`,
        JSON.stringify(stored),
      );
      localStorage.setItem(`mastra-agent-store-${AGENT_ID}`, JSON.stringify(stored));
      const sent = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () =>
          HttpResponse.json({
            ...agentResponse,
            defaultOptions: { maxSteps: 9, modelSettings: { temperature: 0.7 }, requireToolApproval: true },
          }),
        ),
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          sent(await request.json());
          return new HttpResponse('data: {"type":"finish","payload":{}}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }),
      );
      renderAt(`/agents/${AGENT_ID}/${route}/${THREAD_ID}`);
      await screen.findByText('Tonight we cook carbonara.');
      expect(screen.queryByTestId('composer-model-settings-trigger')).toBeNull();
      const input = await screen.findByRole('textbox');
      await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
      fireEvent.change(input, { target: { value: 'Use the agent defaults' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledOnce());
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          maxSteps: 9,
          modelSettings: expect.objectContaining({ temperature: 0.7 }),
        }),
      );
      expect(sent.mock.calls[0][0].modelSettings).not.toHaveProperty('topP');
      expect(sent.mock.calls[0][0]).toHaveProperty('requireToolApproval', true);
    });
  });

  describe('when a thread has saved model preferences', () => {
    it('retains real composer edits through the first send, navigation, and reload', async () => {
      installHandlers();
      const sent = vi.fn();
      const providersServed = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/agents/providers`, () => {
          providersServed();
          return HttpResponse.json(preferenceModelProviders);
        }),
        http.get(`${BASE_URL}/api/memory/config`, () => HttpResponse.json(memoryConfig)),
        http.get(`${BASE_URL}/api/memory/threads/:threadId/working-memory`, () => HttpResponse.json(workingMemory)),
        http.get(`${BASE_URL}/api/memory/threads/:threadId`, ({ params }) =>
          HttpResponse.json({ ...preferenceThread, id: params.threadId }),
        ),
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}/voice/speakers`, () => HttpResponse.json(voiceSpeakers)),
        http.get(`${BASE_URL}/api/mcp/v0/servers`, () => HttpResponse.json(mcpServers)),
        // Older servers automatically fall back to the direct streaming route.
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/threads/subscribe`, () =>
          HttpResponse.json({ error: 'Not found' }, { status: 404 }),
        ),
      );
      server.use(
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/stream`, async ({ request }) => {
          sent(await request.json());
          return new HttpResponse('data: {"type":"finish","payload":{}}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }),
      );
      const router = renderAt(`/agents/${AGENT_ID}/threads/new`);
      // The switcher lists only the agent's own model until the providers query resolves.
      await waitFor(() => expect(providersServed).toHaveBeenCalled());
      fireEvent.click(await screen.findByRole('button', { name: /^Model:.*GPT-5 Mini$/ }));
      fireEvent.click(await screen.findByRole('button', { name: /^Model (?!settings)/ }));
      fireEvent.click(await screen.findByRole('option', { name: /GPT-4o Mini/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Model:.*GPT-4o Mini/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Reasoning level/ }));
      fireEvent.click(await screen.findByRole('option', { name: 'High' }));
      const firstInput = await screen.findByRole('textbox');
      await waitFor(() => expect(firstInput.hasAttribute('disabled')).toBe(false));
      fireEvent.change(firstInput, { target: { value: 'Save my preferences' } });
      fireEvent.keyDown(firstInput, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledOnce());
      await waitFor(() => expect(router.state.location.pathname).not.toBe(`/agents/${AGENT_ID}/threads/new`));
      const savedPath = router.state.location.pathname;
      expect(sent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'openai/gpt-4o-mini',
          maxSteps: 15,
          providerOptions: { openai: { reasoningLevel: 'high' } },
          modelSettings: expect.not.objectContaining({ temperature: expect.anything() }),
        }),
      );
      expect(await screen.findByText('GPT-4o Mini')).toBeTruthy();
      await act(() => router.navigate(`/agents/${AGENT_ID}/threads/thread-2`));
      expect(await screen.findByText('GPT-5 Mini')).toBeTruthy();
      await act(() => router.navigate(savedPath));
      expect(await screen.findByText('GPT-4o Mini')).toBeTruthy();
      cleanup();
      renderAt(savedPath);
      expect(await screen.findByText('GPT-4o Mini')).toBeTruthy();
      const input = await screen.findByRole('textbox');
      await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
      fireEvent.change(input, { target: { value: 'Use my saved settings' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
      expect(sent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          model: 'openai/gpt-4o-mini',
          maxSteps: 15,
          providerOptions: { openai: { reasoningLevel: 'high' } },
          modelSettings: expect.not.objectContaining({ temperature: expect.anything() }),
        }),
      );
    }, 15_000);
  });

  describe('when the current agent no longer exists', () => {
    beforeEach(() => {
      const missingAgent = () => HttpResponse.json({ error: 'Agent not found' }, { status: 404 });
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}/voice/speakers`, missingAgent),
        http.get(`${BASE_URL}/api/memory/config`, missingAgent),
        http.get(`${BASE_URL}/api/memory/threads/:threadId/working-memory`, missingAgent),
        http.get(`${BASE_URL}/api/memory/threads/:threadId`, missingAgent),
        http.post(`${BASE_URL}/api/agents/${AGENT_ID}/threads/subscribe`, missingAgent),
      );
    });

    it.each(['threads', 'session'])('replaces cached %s chat data with actionable recovery', async route => {
      installHandlers();
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () =>
          HttpResponse.json({ error: 'Agent not found' }, { status: 404 }),
        ),
      );
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(['agent', AGENT_ID, {}], agentResponse);
      renderAt(`/agents/${AGENT_ID}/${route}/${THREAD_ID}`, queryClient);

      expect(await screen.findByText('Agent not found')).not.toBeNull();
      expect(screen.getByText(/may have been renamed or removed/)).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull();
      expect(screen.getByRole('link', { name: 'Choose agent' })).not.toBeNull();
      expect(screen.queryByPlaceholderText('Enter your message')).toBeNull();
    });

    it('lets the user leave the dead chat and choose an agent', async () => {
      installHandlers();
      server.use(
        http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () =>
          HttpResponse.json({ error: 'Agent not found' }, { status: 404 }),
        ),
      );
      renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);
      fireEvent.click(await screen.findByRole('link', { name: 'Choose agent' }));
      await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe('/agents'));
    });
  });

  it('shows "Agent not found" for an unknown agent', async () => {
    installHandlers();
    server.use(http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () => HttpResponse.json(null)));
    renderAt(`/agents/${AGENT_ID}/threads/${THREAD_ID}`);

    expect(await screen.findByText('Agent not found')).not.toBeNull();
  });
});

describe('thread link builders', () => {
  it('point to the standalone thread routes', () => {
    expect(paths.agentLink(AGENT_ID)).toBe(`/agents/${AGENT_ID}/traces`);
    expect(paths.agentNewThreadLink(AGENT_ID)).toBe(`/chat/${AGENT_ID}/threads/new`);
    expect(paths.agentThreadLink(AGENT_ID, THREAD_ID)).toBe(`/chat/${AGENT_ID}/threads/${THREAD_ID}`);
    expect(paths.agentThreadLink(AGENT_ID, THREAD_ID, 'msg-1')).toBe(
      `/chat/${AGENT_ID}/threads/${THREAD_ID}?messageId=msg-1`,
    );
  });
});

describe('Standalone conversation navigation', () => {
  describe('when sending the first message', () => {
    it('stays in the clean chat route after persistence and reload', async () => {
      installHandlers();
      const response = draftStream();
      server.use(
        http.post(
          `${BASE_URL}/api/agents/${AGENT_ID}/stream`,
          () => new HttpResponse(response.stream, { headers: { 'content-type': 'text/event-stream' } }),
        ),
      );
      const router = renderAt(`/chat/${AGENT_ID}/threads/new`);
      const input = await composerInput();
      fireEvent.change(input, { target: { value: 'Standalone chat question' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await act(async () => response.finish());
      await waitFor(() => expect(router.state.location.pathname).not.toContain('/threads/new'));
      const path = router.state.location.pathname;
      expect(path).toMatch(/^\/chat\//);
      expect(screen.queryByRole('tablist')).toBeNull();
      cleanup();
      renderAt(path);
      await composerInput();
      expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
    });
  });
});
