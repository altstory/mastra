import { LogoWithoutText } from '@mastra/playground-ui/components/Logo';
import { Sidebar, useSidebar } from '@mastra/playground-ui/components/Sidebar';
import type { SidebarLink } from '@mastra/playground-ui/components/Sidebar';
import { useConnectSurface } from '@mastra/playground-ui/domains/connect';
import { useKeyboardShortcutLabel } from '@mastra/playground-ui/hooks/use-keyboard-shortcut-label';
import { IconMaintenance } from '@mastra/playground-ui/icons/central/IconMaintenance';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useAuthCapabilities, isAuthenticated } from '@mastra/react/hooks/auth';

import { useMCPServers } from '@mastra/react/hooks/mcps';
import { useWorkspaces } from '@mastra/react/hooks/workspace';
import { Link, useLocation } from 'react-router';
import { useAccount } from '@/domains/account/account-context';
import { AccountMenu } from '@/domains/account/account-menu';
import { useAgentBuilderSidebarVisibility } from '@/domains/agent-builder/hooks/use-agent-builder-sidebar-visibility';
import { AuthStatus } from '@/domains/auth/components/auth-status';
import { ImpersonationBanner } from '@/domains/auth/components/impersonation-banner';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';
import { getPermissionForRoute, hasRoutePermission } from '@/domains/auth/route-permissions';
import { useIsCmsAvailable } from '@/domains/cms/hooks/use-is-cms-available';
import { SidebarConversations } from '@/domains/navigation/components/sidebar-conversations';
import { useNavigationCommand } from '@/lib/command';
import { useMastraPlatform } from '@/lib/mastra-platform/hooks/use-mastra-platform';
import { getIsLinkActive } from '@/lib/nav/get-is-link-active';
import { bottomNav, mainNav } from '@/lib/nav/nav-items';
import type { NavItem } from '@/lib/nav/nav-items';

declare global {
  interface Window {
    MASTRA_HIDE_CLOUD_CTA: string;
    MASTRA_TEMPLATES?: string;
  }
}

function toSidebarLink(item: NavItem): SidebarLink {
  const { Icon } = item;
  return { id: item.url, name: item.name, url: item.url, icon: <Icon /> };
}

export function AppSidebar() {
  const account = useAccount();
  useLocale();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const { setOpen: setNavigationCommandOpen } = useNavigationCommand({ enableShortcut: false });
  const commandShortcutLabel = useKeyboardShortcutLabel('K');

  const location = useLocation();
  const pathname = location.pathname;

  const { isMastraPlatform } = useMastraPlatform();
  const { data: authCapabilities } = useAuthCapabilities();
  const { isCmsAvailable, isLoading: isCmsLoading } = useIsCmsAvailable();
  const { hasPermission, hasAnyPermission, isLoading: isPermissionsLoading } = usePermissions();
  // The Connections entry only shows once the connect-surface probe confirms
  // userConnectRoutes() is mounted (a 401 still means mounted). The page stays
  // reachable at /connections, where the empty states explain the setup.
  const { data: connectSurface } = useConnectSurface();
  const isConnectSurfaceMounted = connectSurface !== undefined && connectSurface.status !== 'not-mounted';

  const isUserAuthenticated = authCapabilities && isAuthenticated(authCapabilities);
  const cmsOnlyLinks = new Set(['/prompts']);
  const { isVisible: isAgentBuilderVisible } = useAgentBuilderSidebarVisibility();
  const isAgentBuilderActive = pathname === '/agent-builder' || pathname.startsWith('/agent-builder/');

  const openNavigationCommand = () => {
    if (isMobile) setOpenMobile(false);
    setNavigationCommandOpen(true);
  };

  const filterItem = (item: NavItem) => {
    if (item.hidden) return false;
    if (account && account.user.role !== 'admin' && (item.url === '/agents' || item.url === '/knowledge')) return false;
    if (item.url === '/connections' && !isConnectSurfaceMounted) return false;
    if (cmsOnlyLinks.has(item.url) && !isCmsAvailable && !isCmsLoading) return false;
    if (isMastraPlatform && !item.isOnMastraPlatform) return false;
    if (isPermissionsLoading) {
      const pending = getPermissionForRoute(item.url);
      if (pending && pending !== 'public') return false;
    }
    const requiredPermission = getPermissionForRoute(item.url);
    if (!hasRoutePermission(requiredPermission, hasPermission, hasAnyPermission)) {
      return false;
    }
    return true;
  };

  const { data: mcpServers } = useMCPServers();
  const { data: workspaces } = useWorkspaces();
  const filteredBottom = bottomNav.filter(filterItem);
  const sections = mainNav
    .map(section => {
      const items = section.items.filter(filterItem);
      const linkForItem = (item: NavItem) => ({
        ...toSidebarLink(item),
        isActive: getIsLinkActive(item, pathname, items),
      });
      return {
        key: section.key,
        title: section.title,
        href: section.href,
        isHeaderActive: !!(
          section.href &&
          pathname === section.href &&
          !items.some(item => getIsLinkActive(item, pathname, items))
        ),
        links: items.filter(item => !item.foldable).map(linkForItem),
        moreLinks: items
          .filter(item => item.foldable)
          .map(item => ({
            ...linkForItem(item),
            defaultVisible:
              (item.url === '/mcps' && !!mcpServers?.length) ||
              (item.url === '/workspaces' && !!workspaces?.workspaces.length),
          })),
      };
    })
    .filter(section => section.links.length > 0 || section.moreLinks.length > 0);

  return (
    <Sidebar aria-label={studioT('Sidebar')}>
      <Sidebar.Header
        collapsedLogo={<LogoWithoutText className="size-6" />}
        actions={!account && isUserAuthenticated && <AuthStatus />}
      >
        <Sidebar.Brand logo={<LogoWithoutText className="size-6" />} title="Altflow" />
        {!isMobile && (
          <Sidebar.SearchTrigger
            aria-label={studioT('Search and navigate')}
            shortcut={commandShortcutLabel}
            onClick={openNavigationCommand}
          />
        )}
        <Sidebar.Trigger />
      </Sidebar.Header>

      {isAgentBuilderVisible && (
        <Sidebar.NavList className="mb-1">
          <Sidebar.NavLink
            state={state}
            link={{
              name: 'Agent Builder',
              url: '/agent-builder',
              icon: <IconMaintenance />,
            }}
            isActive={isAgentBuilderActive}
          />
        </Sidebar.NavList>
      )}

      {!account && <ImpersonationBanner />}

      <SidebarConversations newChatOnly />

      <Sidebar.Nav>
        <Sidebar.Sections sections={sections} visibilityStorageKey="mastra:studio:sidebar-visibility" />
        <SidebarConversations hideNewChat />
      </Sidebar.Nav>

      <Sidebar.Footer>
        {account ? (
          <AccountMenu />
        ) : (
          <Sidebar.NavList>
            {filteredBottom.map(item => (
              <Sidebar.NavLink
                key={item.name}
                state={state}
                link={toSidebarLink(item)}
                isActive={getIsLinkActive(item, pathname)}
                render={
                  item.url === '/settings' ? (
                    <Link to={item.url} state={{ returnTo: location.pathname + location.search + location.hash }}>
                      <item.Icon />
                      <Sidebar.NavLabel>{item.name}</Sidebar.NavLabel>
                    </Link>
                  ) : undefined
                }
              />
            ))}
          </Sidebar.NavList>
        )}
      </Sidebar.Footer>
    </Sidebar>
  );
}
