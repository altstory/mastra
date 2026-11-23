import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { useLinkComponent } from '@mastra/playground-ui/lib/framework';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { PageBreadcrumbs } from '@/components/ui/page-breadcrumbs';
import { navCrumb } from '@/domains/navigation/crumbs';
import { ScorerCreateContent } from '@/domains/scores/components/scorer-create-content';

const crumbs = [
  navCrumb('/scorers'),
  {
    id: 'create-scorer',
    get label() {
      return studioT('Create scorer');
    },
  },
];

function CmsScorersCreatePage() {
  useLocale();
  const { navigate, paths } = useLinkComponent();

  return (
    <PageLayout variant="page" body="fixed" breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
      <h1 className="sr-only">{studioT('Create scorer')}</h1>
      <ScorerCreateContent onSuccess={scorer => navigate(paths.scorerLink(scorer.id))} />
    </PageLayout>
  );
}

export { CmsScorersCreatePage };

export default CmsScorersCreatePage;
