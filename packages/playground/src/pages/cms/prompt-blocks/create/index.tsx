import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { useLinkComponent } from '@mastra/playground-ui/lib/framework';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { PageBreadcrumbs } from '@/components/ui/page-breadcrumbs';
import { navCrumb } from '@/domains/navigation/crumbs';
import { PromptBlockCreateContent } from '@/domains/prompt-blocks';

const crumbs = [
  navCrumb('/prompts'),
  {
    id: 'create-prompt-block',
    get label() {
      return studioT('Create prompt block');
    },
  },
];

function CmsPromptBlocksCreatePage() {
  useLocale();
  const { navigate, paths } = useLinkComponent();

  return (
    <PageLayout variant="page" body="fixed" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
      <h1 className="sr-only">{studioT('Create prompt block')}</h1>
      <PromptBlockCreateContent onSuccess={block => navigate(paths.cmsPromptBlockEditLink(block.id))} />
    </PageLayout>
  );
}

export { CmsPromptBlocksCreatePage };

export default CmsPromptBlocksCreatePage;
