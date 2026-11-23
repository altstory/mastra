import { Button } from '@/ds/components/Button';
import { EmptyState } from '@/ds/components/EmptyState';
import { IconPlusMedium } from '@/ds/icons/central/IconPlusMedium';
import { IconSquareArrowTopRight } from '@/ds/icons/central/IconSquareArrowTopRight';
import { useLinkComponent } from '@/lib/framework';
import { t as studioT, useLocale } from '@/lib/i18n';

export const NoPromptBlocksInfo = ({ canCreate }: { canCreate: boolean }) => {
  useLocale();
  const { Link, paths } = useLinkComponent();

  return (
    <EmptyState
      titleSlot={studioT('No Prompts yet')}
      descriptionSlot={
        canCreate ? (
          <>
            {studioT('Create a reusable prompt block and reference it') + ' '}
            <br />
            {studioT('in your agent instructions.')}
          </>
        ) : (
          <>
            {studioT('There are no prompt blocks yet. Prompt blocks are reusable') + ' '}
            <br />
            {studioT('content that can be referenced in your agent instructions.')}
          </>
        )
      }
      actionSlot={
        <div className="flex flex-col items-center gap-2">
          {canCreate && (
            <Button
              render={<Link href={paths.cmsPromptBlockCreateLink()} />}
              variant="primary"
              icon={<IconPlusMedium />}
            >
              {studioT('Create prompt')}
            </Button>
          )}
          <Button
            variant="ghost"
            render={
              <a
                href="https://mastra.ai/docs/editor/overview#prompt-blocks"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
            icon={<IconSquareArrowTopRight />}
          >
            {studioT('Prompts documentation')}
          </Button>
        </div>
      }
      variant="fill"
    />
  );
};
