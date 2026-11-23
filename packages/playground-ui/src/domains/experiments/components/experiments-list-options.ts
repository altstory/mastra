import type { DatasetRecord } from '@mastra/client-js';
import { t as studioT } from '@mastra/playground-ui/lib/i18n';

export const EXPERIMENT_STATUS_OPTIONS = [
  {
    value: 'all',
    get label() {
      return studioT('All statuses');
    },
  },
  {
    value: 'completed',
    get label() {
      return studioT('Completed');
    },
  },
  {
    value: 'running',
    get label() {
      return studioT('Running');
    },
  },
  {
    value: 'failed',
    get label() {
      return studioT('Failed');
    },
  },
  {
    value: 'pending',
    get label() {
      return studioT('Pending');
    },
  },
] as const;

export function getExperimentDatasetOptions(datasets?: DatasetRecord[]) {
  return [
    {
      value: 'all',
      get label() {
        return studioT('All datasets');
      },
    },
    ...(datasets ?? []).map(ds => ({ value: ds.id, label: ds.name })),
  ];
}
