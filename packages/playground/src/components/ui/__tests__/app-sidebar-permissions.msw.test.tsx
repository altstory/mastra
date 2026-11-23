import { cleanup, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noMcpServers, noWorkspaces } from './fixtures/nav-more';
import {
  adminSidebarCapabilities,
  memberSidebarCapabilities,
  rbacDisabledSidebarCapabilities,
  viewerSidebarCapabilities,
} from './fixtures/sidebar-permissions';
import { authHandler, BASE_URL, builderHandler, renderSidebar, systemPackagesHandler } from './render-sidebar';
import { adminSession, creatorSession } from '@/domains/account/__tests__/fixtures/session';
import { providersResponse } from '@/pages/connections/__tests__/fixtures/user-connect';
import { server } from '@/test/msw-server';

beforeEach(() => {
  window.MASTRA_CLOUD_API_ENDPOINT = '';
  localStorage.clear();
  server.use(
    builderHandler({ enabled: false }),
    systemPackagesHandler(),
    http.get(`${BASE_URL}/api/mcp/v0/servers`, () => HttpResponse.json(noMcpServers)),
    http.get(`${BASE_URL}/api/workspaces`, () => HttpResponse.json(noWorkspaces)),
    // Mounted connect surface, so the Connections entry is available and these
    // tests exercise RBAC gating alone.
    http.get(`${BASE_URL}/connect/providers`, () => HttpResponse.json(providersResponse)),
  );
});

afterEach(() => cleanup());

describe('AppSidebar permissions', () => {
  describe('when a Go account is a regular user', () => {
    it.each(['user', 'creator'] as const)('hides management navigation for the %s role', async role => {
      server.use(authHandler({ enabled: true, login: null }));
      renderSidebar('/chat/creator-agent/threads/new', { ...creatorSession, user: { ...creatorSession.user, role } });

      expect(await screen.findByRole('link', { name: 'New Thread' })).toBeTruthy();
      expect(screen.queryByText('Evaluation')).toBeNull();
      expect(screen.queryByText('Observability')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Knowledge' })).toBeNull();
      for (const name of ['Scorers', 'Datasets', 'Experiments', 'Review Queue', 'Metrics', 'Traces', 'Logs']) {
        expect(screen.queryByRole('link', { name })).toBeNull();
      }
    });
  });

  describe('when a Go account is an administrator', () => {
    it('keeps management groups and their destinations', async () => {
      server.use(authHandler({ enabled: true, login: null }));
      renderSidebar('/knowledge', adminSession);

      await screen.findByRole('link', { name: 'Knowledge' });
      expect(screen.getByRole('link', { name: 'Agents' })).toBeTruthy();
      expect(screen.getByText('Evaluation')).toBeTruthy();
      expect(screen.getByText('Observability')).toBeTruthy();
      for (const name of ['Scorers', 'Datasets', 'Experiments', 'Review Queue', 'Metrics', 'Traces', 'Logs']) {
        expect(screen.getByRole('link', { name })).toBeTruthy();
      }
    });
  });

  describe('when an admin has wildcard permissions', () => {
    it('provides the main links and optional destinations', async () => {
      server.use(authHandler(adminSidebarCapabilities));
      renderSidebar();

      expect((await screen.findByRole('link', { name: 'Agents' })).getAttribute('href')).toBe('/agents');
      expect(screen.getByRole('link', { name: 'Workflows' }).getAttribute('href')).toBe('/workflows');
      fireEvent.click(await screen.findByRole('button', { name: 'More' }));
      expect((await screen.findByRole('menuitem', { name: 'Tools' })).getAttribute('href')).toBe('/tools');
      expect(screen.getByRole('menuitem', { name: 'MCP Servers' }).getAttribute('href')).toBe('/mcps');
    });
  });

  describe('when a member can read agents and tools and use workflows', () => {
    it('provides permitted destinations and excludes MCP Servers', async () => {
      server.use(authHandler(memberSidebarCapabilities));
      renderSidebar();

      expect((await screen.findByRole('link', { name: 'Agents' })).getAttribute('href')).toBe('/agents');
      expect(screen.getByRole('link', { name: 'Workflows' }).getAttribute('href')).toBe('/workflows');
      fireEvent.click(await screen.findByRole('button', { name: 'More' }));
      expect((await screen.findByRole('menuitem', { name: 'Tools' })).getAttribute('href')).toBe('/tools');
      expect(screen.queryByRole('link', { name: 'MCP Servers' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'MCP Servers' })).toBeNull();
    });
  });

  describe('when a viewer can only read agents and workflows', () => {
    it('excludes Tools and MCP Servers from navigation', async () => {
      server.use(authHandler(viewerSidebarCapabilities));
      renderSidebar();

      await screen.findByRole('link', { name: 'Agents' });
      expect(screen.queryByRole('link', { name: 'Tools' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'MCP Servers' })).toBeNull();
      // Connections is not RBAC-gated (the connect surface gates on the
      // caller's own identity), so the More menu holds only that entry.
      fireEvent.click(await screen.findByRole('button', { name: 'More' }));
      expect((await screen.findByRole('menuitem', { name: 'Connections' })).getAttribute('href')).toBe('/connections');
      expect(screen.queryByRole('menuitem', { name: 'Tools' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'MCP Servers' })).toBeNull();
    });
  });

  describe('when RBAC is disabled for a viewer', () => {
    it('provides optional destinations that RBAC would otherwise hide', async () => {
      server.use(authHandler(rbacDisabledSidebarCapabilities));
      renderSidebar();

      expect((await screen.findByRole('link', { name: 'Agents' })).getAttribute('href')).toBe('/agents');
      fireEvent.click(await screen.findByRole('button', { name: 'More' }));
      expect((await screen.findByRole('menuitem', { name: 'Tools' })).getAttribute('href')).toBe('/tools');
      expect(screen.getByRole('menuitem', { name: 'MCP Servers' }).getAttribute('href')).toBe('/mcps');
    });
  });
});
