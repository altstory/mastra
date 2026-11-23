import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountGate } from '../account-gate';
import { adminSession, creatorSession } from './fixtures/session';
import { AuthRequired } from '@/domains/auth/components/auth-required';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { server } from '@/test/msw-server';
const endpoint = 'http://localhost:4111';
function Actions() {
  const { hasPermission } = usePermissions();
  return (
    <AuthRequired>
      {hasPermission('agents:execute') && <button>对话</button>}
      {hasPermission('knowledge:read') && <button>知识库</button>}
      {hasPermission('agents:write') && <button>编辑助手</button>}
    </AuthRequired>
  );
}
function renderActions() {
  server.use(http.get(`${endpoint}/api/auth/capabilities`, () => HttpResponse.json({ enabled: true, login: null })));
  return render(
    <MastraReactProvider baseUrl={endpoint}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AccountGate endpoint={endpoint} apiPrefix="/api">
          <Actions />
        </AccountGate>
      </QueryClientProvider>
    </MastraReactProvider>,
  );
}
afterEach(cleanup);
describe('Go account permissions', () => {
  describe('when Go returns a creator', () => {
    it('offers chat and keeps knowledge and assistant management restricted', async () => {
      server.use(http.get(`${endpoint}/account/session`, () => HttpResponse.json(creatorSession)));
      renderActions();
      expect(await screen.findByRole('button', { name: '对话' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '知识库' })).toBeNull();
      expect(screen.queryByRole('button', { name: '编辑助手' })).toBeNull();
    });
  });
  describe('when Go returns an administrator', () => {
    it('allows managing the assistant without native Altflow RBAC', async () => {
      server.use(http.get(`${endpoint}/account/session`, () => HttpResponse.json(adminSession)));
      renderActions();
      expect(await screen.findByRole('button', { name: '编辑助手' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '知识库' })).toBeTruthy();
    });
  });
});
