import type { GetAgentResponse } from '@mastra/client-js';
import type { StorageThreadType } from '@mastra/core/memory';
import { ThreadInputProvider } from '@mastra/playground-ui/domains/agents/chat/drafts/ThreadInputContext';
import { LinkComponentProvider } from '@mastra/playground-ui/lib/framework';
import type { LinkComponentProviderProps } from '@mastra/playground-ui/lib/framework';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { AnchorHTMLAttributes } from 'react';
import { forwardRef } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readOnlyAuthCapabilities } from '../../__tests__/fixtures/auth';
import { systemPackages } from '../../__tests__/fixtures/channels';
import { v2Agent } from '../../__tests__/fixtures/composer-model-settings';
import { MemorySidebar } from '../memory-sidebar';
import { memoryDisabledStatus, memoryEnabledStatus, semanticRecallConfig } from './fixtures/memory';
import { WorkingMemoryProvider } from '@/domains/agents/context/agent-working-memory-context';
import { MemoryTimelineProvider, useMemoryTimeline } from '@/domains/agents/context/memory-timeline-context';
import { server } from '@/test/msw-server';

const BASE_URL = 'http://localhost:4111';
const AGENT_ID = 'chef-agent';
const THREAD_ID = 'real-thread';

// The capabilities footer always renders, so it fetches the agent details and the
// system packages (CMS availability). Keep CMS disabled so the editor capability
// stays gated and the versions query never fires.
const capabilityAgent: GetAgentResponse = {
  ...v2Agent,
  id: AGENT_ID,
  name: 'Chef Agent',
};

const StubLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }>(
  ({ children, to, href, ...props }, ref) => (
    <a ref={ref} href={to ?? href} {...props}>
      {children}
    </a>
  ),
);

const paths = {
  agentLink: (agentId: string) => `/agents/${agentId}`,
  agentsLink: () => '/agents',
  agentToolLink: (agentId: string, toolId: string) => `/agents/${agentId}/tools/${toolId}`,
  agentSkillLink: (agentId: string, skillName: string) => `/agents/${agentId}/skills/${skillName}`,
  agentThreadLink: (agentId: string, threadId: string) => `/agents/${agentId}/threads/${threadId}`,
  agentNewThreadLink: (agentId: string) => `/agents/${agentId}/threads/new`,
  workflowsLink: () => '/workflows',
  workflowLink: (workflowId: string) => `/workflows/${workflowId}`,
  schedulesLink: () => '/schedules',
  scheduleLink: (scheduleId: string) => `/schedules/${scheduleId}`,
  networkLink: (networkId: string) => `/networks/${networkId}`,
  networkNewThreadLink: (networkId: string) => `/networks/${networkId}/chat/new`,
  networkThreadLink: (networkId: string, threadId: string) => `/networks/${networkId}/chat/${threadId}`,
  scorerLink: (scorerId: string) => `/scorers/${scorerId}`,
  cmsScorersCreateLink: () => '/cms/scorers/create',
  cmsScorerEditLink: (scorerId: string) => `/cms/scorers/${scorerId}`,
  cmsAgentCreateLink: () => '/cms/agents/create',
  cmsAgentEditLink: (agentId: string) => `/cms/agents/${agentId}`,
  promptBlockLink: (promptBlockId: string) => `/prompt-blocks/${promptBlockId}`,
  promptBlocksLink: () => '/prompt-blocks',
  cmsPromptBlockCreateLink: () => '/cms/prompt-blocks/create',
  cmsPromptBlockEditLink: (promptBlockId: string) => `/cms/prompt-blocks/${promptBlockId}`,
  toolLink: (toolId: string) => `/tools/${toolId}`,
  skillLink: (skillName: string) => `/skills/${skillName}`,
  workspacesLink: () => '/workspaces',
  workspaceLink: (workspaceId?: string) => `/workspaces/${workspaceId ?? ''}`,
  workspaceSkillLink: (skillName: string) => `/workspaces/skills/${skillName}`,
  processorsLink: () => '/processors',
  processorLink: (processorId: string) => `/processors/${processorId}`,
  mcpServerLink: (serverId: string) => `/mcp/${serverId}`,
  mcpServerToolLink: (serverId: string, toolId: string) => `/mcp/${serverId}/tools/${toolId}`,
  workflowRunLink: (workflowId: string, runId: string) => `/workflows/${workflowId}/runs/${runId}`,
  datasetLink: (datasetId: string) => `/datasets/${datasetId}`,
  datasetItemLink: (datasetId: string, itemId: string) => `/datasets/${datasetId}/items/${itemId}`,
  experimentLink: (experimentId: string) => `/experiments/${experimentId}`,
} satisfies LinkComponentProviderProps['paths'];

function registerMemoryHandlers() {
  server.use(
    http.get(`${BASE_URL}/api/auth/capabilities`, () => HttpResponse.json(readOnlyAuthCapabilities)),
    http.get(`${BASE_URL}/api/agents/${AGENT_ID}`, () => HttpResponse.json(capabilityAgent)),
    http.get(`${BASE_URL}/api/system/packages`, () => HttpResponse.json(systemPackages)),
    http.get(`${BASE_URL}/api/memory/config`, () => HttpResponse.json(semanticRecallConfig)),
    http.get(`${BASE_URL}/api/memory/status`, () => HttpResponse.json(memoryEnabledStatus)),
    http.get(`${BASE_URL}/api/memory/threads/:threadId`, () =>
      HttpResponse.json({ id: THREAD_ID, resourceId: AGENT_ID, createdAt: new Date().toISOString() }),
    ),
    http.get(`${BASE_URL}/api/memory/threads/:threadId/working-memory`, () =>
      HttpResponse.json({ workingMemory: null, source: 'thread' }),
    ),
  );
}

function renderSidebar(threads: StorageThreadType[], hasMemory = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  // MemorySidebar derives memory state from useMemory, so drive it via the wire.
  server.use(
    http.get(`${BASE_URL}/api/memory/status`, () =>
      HttpResponse.json(hasMemory ? memoryEnabledStatus : memoryDisabledStatus),
    ),
  );

  return render(
    <MastraReactProvider baseUrl={BASE_URL}>
      <QueryClientProvider client={queryClient}>
        <LinkComponentProvider Link={StubLink} navigate={() => {}} paths={paths}>
          <ThreadInputProvider>
            <WorkingMemoryProvider agentId={AGENT_ID} threadId={THREAD_ID} resourceId={AGENT_ID}>
              <MemoryTimelineProvider>
                <MemorySidebar agentId={AGENT_ID} threadId={THREAD_ID} threads={threads} onDelete={vi.fn()} />
              </MemoryTimelineProvider>
            </WorkingMemoryProvider>
          </ThreadInputProvider>
        </LinkComponentProvider>
      </QueryClientProvider>
    </MastraReactProvider>,
  );
}

function thread(overrides: Partial<StorageThreadType>): StorageThreadType {
  const createdAt = new Date(2026, 4, 29, 16, 19, 44);
  return {
    id: 'thread-id',
    resourceId: AGENT_ID,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  registerMemoryHandlers();
});

afterEach(cleanup);

describe('MemorySidebar', () => {
  it('keeps conversation navigation and removes the memory card', async () => {
    renderSidebar([thread({ id: THREAD_ID, title: 'My first chat' })]);
    expect(await screen.findByText('New Thread')).not.toBeNull();
    expect(await screen.findByText('My first chat')).not.toBeNull();
    expect(screen.queryByTestId('memory-sidebar-card')).toBeNull();
    expect(screen.queryByText('Working Memory')).toBeNull();
    expect(screen.queryByText('Observational Memory')).toBeNull();
  });
  it('shows the remaining capabilities without memory or sub-agent rows', async () => {
    renderSidebar([]);
    const footer = await screen.findByTestId('agent-capabilities-footer');
    expect(footer.textContent).toMatch(/\/3/);
    fireEvent.click(footer);
    expect(await screen.findByRole('link', { name: /^Tools:/ })).not.toBeNull();
    expect(screen.queryByRole('link', { name: /^Memory:/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Sub-agents:/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Editor:/ })).toBeNull();
  });
  it('explains missing thread storage when the server has no memory configured', async () => {
    renderSidebar([], false);
    expect(await screen.findByText('Memory not enabled')).not.toBeNull();
    expect(screen.queryByText('New Thread')).toBeNull();
    expect(screen.getByRole('link', { name: /documentation/i }).getAttribute('href')).toBe(
      'https://mastra.ai/docs/memory/overview',
    );
  });
});
