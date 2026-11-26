import { formatJson } from '../format-json';
import { WorkspaceJsonCode } from './workspace-json-code';
import { TabContent } from '@/ds/components/Tabs/tabs-content';
import { TabList } from '@/ds/components/Tabs/tabs-list';
import { Tabs } from '@/ds/components/Tabs/tabs-root';
import { Tab } from '@/ds/components/Tabs/tabs-tab';
import { t as studioT, useLocale } from '@/lib/i18n';

export function WorkspaceJsonPreview({ path, content }: { path: string; content: string }) {
  useLocale();
  const formatted = formatJson(content);
  if (formatted === undefined || formatted === content) return <WorkspaceJsonCode path={path} code={content} />;
  return (
    <Tabs defaultTab="formatted">
      <div className="pt-2 pl-2">
        <TabList>
          <Tab value="formatted">{studioT('Formatted')}</Tab>
          <Tab value="raw">{studioT('Raw')}</Tab>
        </TabList>
      </div>
      <TabContent value="formatted" flush>
        <WorkspaceJsonCode path={path} code={formatted} />
      </TabContent>
      <TabContent value="raw" flush>
        <WorkspaceJsonCode path={path} code={content} />
      </TabContent>
    </Tabs>
  );
}
