import { Button } from '@/ds/components/Button';
import { EmptyState } from '@/ds/components/EmptyState';
import { IconPlusMedium } from '@/ds/icons/central/IconPlusMedium';
import { IconSquareArrowTopRight } from '@/ds/icons/central/IconSquareArrowTopRight';
import { t as studioT, useLocale } from '@/lib/i18n';

export const NoExperimentsInfo = ({ onRunExperiment }: { onRunExperiment?: () => void }) => {
  useLocale();
  return (
    <EmptyState
      titleSlot={studioT('No Experiments yet')}
      descriptionSlot={
        <>
          {studioT('Run an experiment from a dataset to evaluate') + ' '}
          <br />
          {studioT('your agents and workflows.')}
        </>
      }
      actionSlot={
        <div className="flex flex-col items-center gap-2">
          {onRunExperiment && (
            <Button variant="primary" onClick={onRunExperiment} icon={<IconPlusMedium />}>
              {studioT('New experiment')}
            </Button>
          )}
          <Button
            variant="ghost"
            render={<a href="https://mastra.ai/docs/evals/experiments" target="_blank" rel="noopener noreferrer" />}

            icon={<IconSquareArrowTopRight />}
          >
            {studioT('Experiments documentation')}
          </Button>
        </div>
      }
      variant="fill"
    />
  );
};
