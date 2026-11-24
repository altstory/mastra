import { ComposerAnnotations } from '@mastra/playground-ui/components/ai/annotations';
import { ChatMessagesContext } from '@mastra/playground-ui/domains/chat/context/chat-context';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationWorkspace } from '../conversation-workspace';
import { fileMessages, filesFixture } from './fixtures/files';
import { StudioConfigContext } from '@/domains/configuration/context/studio-config-state';
import { server } from '@/test/msw-server';

const baseUrl = 'http://localhost:4111';
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
});

function show(scope = 'thread-a') {
  server.use(
    http.get(`${baseUrl}/api/memory/threads/:thread/messages`, () =>
      HttpResponse.json({ messages: [], hasMore: false, total: 0, page: 0, perPage: 100 }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace = (
    nextScope: string,
    messages = nextScope === 'new'
      ? []
      : nextScope === 'thread-b'
        ? fileMessages.slice(0, 1)
        : fileMessages.slice(0, 2),
  ) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <StudioConfigContext.Provider value={{ baseUrl, headers: {}, isLoading: false, setConfig: () => {} }}>
          <MastraReactProvider baseUrl={baseUrl}>
            <ChatMessagesContext.Provider
              value={{
                messages,
              }}
            >
              <ConversationWorkspace key={nextScope} scope={nextScope} threadId={nextScope} agentId="creator-agent">
                <a href={`${baseUrl}/storage/download?path=${encodeURIComponent('/outputs/draft.md')}`}>
                  Download draft
                </a>
                <div>Chat content</div>
                <ComposerAnnotations showExcerpt />
              </ConversationWorkspace>
            </ChatMessagesContext.Provider>
          </MastraReactProvider>
        </StudioConfigContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  return { ...render(workspace(scope)), workspace };
}
function handlers() {
  server.use(
    http.get(`${baseUrl}/storage`, () => HttpResponse.json(filesFixture)),
    http.get(
      `${baseUrl}/storage/download`,
      () => new HttpResponse('# Generated draft', { headers: { 'Content-Type': 'text/markdown' } }),
    ),
  );
}

describe('Conversation workspace', () => {
  it('keeps an empty chat closed and opens when conversation files exist', async () => {
    handlers();
    const view = show('new');
    expect(screen.queryByRole('complementary', { name: 'Files and artifacts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Files and artifacts' })).toBeNull();
    view.rerender(view.workspace('saved'));
    expect(await screen.findByRole('button', { name: 'draft.md' })).toBeTruthy();
    expect(screen.getByText('Chat content')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Files and artifacts' })).toHaveLength(1);
  });

  it('opens for uploads and generated files, respects manual closing, and reopens for the next file', async () => {
    handlers();
    const view = show('new');
    view.rerender(view.workspace('new', fileMessages.slice(0, 1)));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Files and artifacts' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    view.rerender(view.workspace('new', fileMessages.slice(0, 1)));
    expect(screen.queryByRole('complementary')).toBeNull();
    view.rerender(view.workspace('new', fileMessages.slice(0, 2)));
    expect(await screen.findByRole('button', { name: 'draft.md' })).toBeTruthy();
  });

  it('opens an assistant file link in the panel and preserves chat content', async () => {
    handlers();
    show();
    await screen.findByRole('button', { name: 'draft.md' });
    fireEvent.click(screen.getByRole('button', { name: 'Files and artifacts' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    const allowedNavigation = fireEvent.click(screen.getByRole('link', { name: 'Download draft' }));
    expect(allowedNavigation).toBe(false);
    expect(await screen.findByRole('heading', { name: 'Generated draft' })).toBeTruthy();
    expect(screen.getByText('Chat content')).toBeTruthy();
  });

  it('restores the open preview and scroll position immediately after visiting another conversation', async () => {
    handlers();
    const download = vi.fn(() => HttpResponse.text('# Generated draft'));
    server.use(http.get(`${baseUrl}/storage/download`, download));
    const view = show();
    fireEvent.click(await screen.findByRole('button', { name: 'draft.md' }));
    const heading = await screen.findByRole('heading', { name: 'Generated draft' });
    const preview = heading.closest('[data-slot="message-content"]')!.parentElement!;
    preview.scrollTop = 160;
    fireEvent.scroll(preview);
    view.rerender(view.workspace('thread-b'));
    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Generated draft' })).toBeNull();
    view.rerender(view.workspace('thread-a'));
    const restored = screen.getByRole('heading', { name: 'Generated draft' });
    expect(restored.closest('[data-slot="message-content"]')!.parentElement!.scrollTop).toBe(160);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cached preview when the file revision changes', async () => {
    const storage = structuredClone(filesFixture);
    const file = storage.files.find(entry => entry.name === 'draft.md')!;
    let title = '# First draft';
    server.use(
      http.get(`${baseUrl}/storage`, () => HttpResponse.json(storage)),
      http.get(`${baseUrl}/storage/download`, () => HttpResponse.text(title)),
    );
    const view = show();
    fireEvent.click(await screen.findByRole('button', { name: 'draft.md' }));
    await screen.findByRole('heading', { name: 'First draft' });
    view.rerender(view.workspace('thread-b'));

    file.updatedAt = '2026-11-18T03:00:00Z';
    title = '# Updated draft';
    view.rerender(view.workspace('thread-a'));
    expect(await screen.findByRole('heading', { name: 'Updated draft' })).toBeTruthy();
  });
});

it('keeps two previews mounted and restores the original preview on switch', async () => {
  server.use(
    http.get('http://localhost:4111/storage', () => HttpResponse.json(filesFixture)),
    http.get('http://localhost:4111/storage/download', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path');
      return HttpResponse.text(path?.endsWith('.md') ? '# Opening scene' : 'Unquoted notes');
    }),
  );
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'draft.md' }));
  const heading = await screen.findByRole('heading', { name: 'Opening scene' });
  fireEvent.click(screen.getByRole('tab', { name: 'Files', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'notes.txt' }));
  expect(await screen.findByText('Unquoted notes')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'draft.md' }));
  expect(await screen.findByRole('heading', { name: 'Opening scene' })).toBe(heading);
});

it('quotes text selected in a file preview and lets the composer remove it', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 640));
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(50, 120, 60, 18)], { item: () => null }),
  );
  handlers();
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'draft.md' }));
  const heading = await screen.findByRole('heading', { name: 'Generated draft' });
  const selected = heading.firstChild;
  if (!(selected instanceof Text)) throw new Error('The preview heading has no text');
  fireEvent.pointerDown(heading);
  const range = document.createRange();
  range.setStart(selected, 0);
  range.setEnd(selected, 'Generated'.length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.pointerUp(heading);
  fireEvent.click(await screen.findByRole('button', { name: 'Add to chat' }));
  const excerpt = await screen.findByRole('button', { name: 'Generated', exact: true });
  fireEvent.click(excerpt);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove annotation 1' }));
  expect(screen.queryByRole('button', { name: 'Generated', exact: true })).toBeNull();
});
