import type { DatasetRecord } from '@mastra/client-js';
import { t as studioT } from '@mastra/playground-ui/lib/i18n';

export const DATASETS_LIST_COLUMNS =
  'minmax(12rem,2fr) minmax(6rem,1fr) minmax(5rem,1fr) minmax(10rem,1fr) minmax(7rem,1fr)';

export const DATASET_EXPERIMENT_OPTIONS = [
  {
    value: 'all',
    get label() {
      return studioT('All datasets');
    },
  },
  {
    value: 'with',
    get label() {
      return studioT('With experiments');
    },
  },
  {
    value: 'without',
    get label() {
      return studioT('Without experiments');
    },
  },
] as const;

/** Distinct tags across all datasets, sorted alphabetically. */
export function getAllDatasetTags(datasets: DatasetRecord[]): string[] {
  const tagSet = new Set<string>();

  for (const dataset of datasets) {
    if (!Array.isArray(dataset.tags)) continue;

    for (const tag of dataset.tags) {
      tagSet.add(tag);
    }
  }

  return Array.from(tagSet).sort();
}

export function getDatasetTagOptions(datasets: DatasetRecord[]) {
  return [
    {
      value: 'all',
      get label() {
        return studioT('All tags');
      },
    },
    ...getAllDatasetTags(datasets).map(tag => ({ value: tag, label: tag })),
  ];
}
