import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Sidebar } from '@mastra/playground-ui/components/Sidebar';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useLinkComponent } from '@mastra/playground-ui/lib/framework';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { AppShell } from '@mastra/playground-ui/new/layout/app-shell';
import type { ReactNode } from 'react';
import { SettingsSidebar } from './settings-sidebar';
import { SidebarShortcuts } from '@/domains/navigation/components/sidebar-shortcuts';

export function SettingsWorkspace({ children, title }: { children: ReactNode; title?: ReactNode }) {
  useLocale();
  const { Link } = useLinkComponent();
  return (
    <Sidebar.Provider LinkComponent={Link} storageKey="mastra:settings-sidebar">
      <SidebarShortcuts />
      <AppShell
        edgeToEdge
        className="bg-background"
        sidebar={<SettingsSidebar />}
        mobileHeader={
          <header className="flex h-header-default shrink-0 items-center gap-3 border-b border-border px-3 lg:hidden">
            <Sidebar.MobileTrigger />
            <Txt variant="body-sm" className="font-medium">
              {studioT('Settings')}
            </Txt>
          </header>
        }
      >
        <PageLayout variant="settings" title={title}>
          {children}
        </PageLayout>
      </AppShell>
    </Sidebar.Provider>
  );
}
