import { ChatMessagesContext } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationFilesPanel } from '../conversation-files-panel';
import { fileMessages, filesFixture } from './fixtures/files';
import { StudioConfigContext } from '@/domains/configuration/context/studio-config-state';
import { server } from '@/test/msw-server';

const baseUrl = 'http://localhost:4111';
afterEach(cleanup);

function Harness({ threadId }: { threadId?: string }) {
  const [selectedPath, onSelect] = useState<string>();
  return (
    <ConversationFilesPanel
      scope="test-conversation"
      selectedPath={selectedPath}
      onSelect={onSelect}
      agentId="creator-agent"
      threadId={threadId}
    />
  );
}
function show(messages = fileMessages, threadId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StudioConfigContext.Provider
        value={{ baseUrl, headers: { 'X-Workspace': 'private' }, isLoading: false, setConfig: () => {} }}
      >
        <MastraReactProvider baseUrl={baseUrl}>
          <ChatMessagesContext.Provider value={{ messages }}>
            <Harness threadId={threadId} />
          </ChatMessagesContext.Provider>
        </MastraReactProvider>
      </StudioConfigContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

describe('Conversation files', () => {
  it('keeps a new conversation empty even when the user has files from other chats', async () => {
    server.use(http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)));
    show([]);
    expect(await screen.findByText('No files found.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'notes.txt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'draft.md' })).toBeNull();
  });
  it('shows only files attached or generated in the active conversation', async () => {
    server.use(http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)));
    show(fileMessages.slice(0, 2));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'draft.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cover.png' })).toBeNull();
  });
  it('includes delivered child artifacts without showing failed deliveries or unrelated files', async () => {
    server.use(http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)));
    show([
      {
        id: 'delivery',
        role: 'assistant',
        createdAt: new Date('2026-11-18'),
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'present-success',
                toolName: 'present',
                state: 'result',
                args: { files: [{ path: '/outputs/draft.md' }] },
                result: { files: [filesFixture.files[1]] },
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'present-failed',
                toolName: 'present',
                state: 'result',
                args: { files: [{ path: filesFixture.files[0].path }] },
                result: { success: false, error: 'Delivery failed' },
              },
            },
          ],
        },
      },
    ]);
    expect(await screen.findByRole('button', { name: 'draft.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'notes.txt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'cover.png' })).toBeNull();
  });
  it('includes older attachments from the full persisted conversation history', async () => {
    const pages: number[] = [];
    server.use(
      http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)),
      http.get(`${baseUrl}/api/memory/threads/long-thread/messages`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        expect(query.get('agentId')).toBe('creator-agent');
        const page = Number(query.get('page'));
        pages.push(page);
        return HttpResponse.json({
          messages: [fileMessages[page === 0 ? 1 : 0]],
          hasMore: page === 0,
          page,
          perPage: 100,
          total: 2,
        });
      }),
    );
    show([], 'long-thread');
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'draft.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cover.png' })).toBeNull();
    expect(pages).toEqual([0, 1]);
  });
  it('does not associate workspace listings or failed writes with a conversation', async () => {
    server.use(http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)));
    show([
      {
        id: 'listing',
        role: 'assistant',
        createdAt: new Date('2026-11-18'),
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'list-1',
                toolName: 'mastra_workspace_list_files',
                state: 'result',
                args: { path: '/' },
                result: filesFixture.files,
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'failed-write',
                toolName: 'mastra_workspace_write_file',
                state: 'result',
                args: { path: '/outputs/draft.md', content: 'Draft' },
                result: { success: false, error: 'Write failed' },
              },
            },
          ],
        },
      },
    ]);
    expect(await screen.findByText('No files found.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'draft.md' })).toBeNull();
  });
  it('lists conversation files directly without folders or redundant panel controls', async () => {
    server.use(
      http.get(`${baseUrl}/storage`, ({ request }) => {
        expect(request.headers.get('X-Workspace')).toBe('private');
        expect(request.credentials).toBe('include');
        return HttpResponse.json(filesFixture);
      }),
    );
    show();
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'draft.md' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Files and artifacts' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText('Agent generated')).toBeNull();
    expect(document.querySelector('summary')).toBeNull();
  });

  it('fetches an authenticated preview, renders Markdown and returns to the file tree', async () => {
    server.use(
      http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)),
      http.get(`${baseUrl}/storage/download`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('path')).toBe('/outputs/draft.md');
        expect(request.credentials).toBe('include');
        expect(request.headers.get('X-Workspace')).toBe('private');
        return new HttpResponse('# Generated draft', { headers: { 'Content-Type': 'text/markdown' } });
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'draft.md' }));
    expect(await screen.findByRole('heading', { name: 'Generated draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download draft.md' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
  });

  it('refreshes the file list when a new artifact is saved', async () => {
    let generated = false;
    server.use(
      http.get(`${baseUrl}/storage`, () =>
        HttpResponse.json({ ...filesFixture, files: generated ? filesFixture.files : filesFixture.files.slice(0, 1) }),
      ),
    );
    show();
    await screen.findByRole('button', { name: 'notes.txt' });
    expect(screen.queryByRole('button', { name: 'draft.md' })).toBeNull();
    generated = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }));
    expect(await screen.findByRole('button', { name: 'draft.md' })).toBeTruthy();
  });

  it('shows a retryable error instead of treating a failed list as empty', async () => {
    let failed = true;
    server.use(
      http.get(`${baseUrl}/storage`, () =>
        failed ? HttpResponse.json({ error: 'Storage offline' }, { status: 503 }) : HttpResponse.json(filesFixture),
      ),
    );
    show();
    expect((await screen.findByRole('alert')).textContent).toContain('Storage offline');
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
  });

  it('does not fetch oversized previews and still offers download', async () => {
    let fetched = false;
    server.use(
      http.get(`${baseUrl}/storage`, () =>
        HttpResponse.json({ ...filesFixture, files: [{ ...filesFixture.files[0], size: 30_000_000 }] }),
      ),
      http.get(`${baseUrl}/storage/download`, () => {
        fetched = true;
        return new HttpResponse('large');
      }),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'notes.txt' }));
    expect(await screen.findByText('This file is too large to preview. Download it to view.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download notes.txt' })).toBeTruthy();
    await waitFor(() => expect(fetched).toBe(false));
  });
});
