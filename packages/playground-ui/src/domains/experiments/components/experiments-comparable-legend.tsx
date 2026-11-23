import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface ExperimentsComparableLegendProps {
  /** Dataset of the first selected experiment. Omitted before any selection. */
  dataset?: { id: string; name: string };
}

/** Names the dataset the current selection locks the experiments list to. */
export function ExperimentsComparableLegend({ dataset }: ExperimentsComparableLegendProps) {
  useLocale();
  return (
    <Txt
      as="p"
      variant="body-sm"
      tone="muted"
      role="note"
      aria-label={studioT('Comparable experiments')}
      className="min-w-0 truncate"
    >
      {dataset ? (
        <>
          {studioT('Comparable experiments share dataset')}{' '}
          <Txt aria-label={dataset.id} as="span" variant="body-sm" tone="ink">
            {dataset.name}
          </Txt>
        </>
      ) : (
        studioT('Select an experiment to pick the dataset to compare')
      )}
    </Txt>
  );
}
