import { t as studioT } from '@/lib/i18n';
export type EnvironmentBuildState = 'pending' | 'building' | 'ready' | 'failed' | 'unknown';

export interface EnvironmentLastBuild {
  buildId: string;
  attemptedAt: string | null;
}

export interface EnvironmentBuild {
  buildId: string;
  status: EnvironmentBuildState;
  templateId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Log lines, as the provider streams them. */
  logs?: string[];
}

export const ENVIRONMENT_BUILD_STATUS: Record<
  EnvironmentBuildState,
  { label: string; variant: 'neutral' | 'success' | 'destructive' | 'warning' | 'info' }
> = {
  pending: {
    get label() {
      return studioT('Pending');
    },
    variant: 'info',
  },
  building: {
    get label() {
      return studioT('Building');
    },
    variant: 'info',
  },
  ready: {
    get label() {
      return studioT('Ready');
    },
    variant: 'success',
  },
  failed: {
    get label() {
      return studioT('Failed');
    },
    variant: 'destructive',
  },
  unknown: {
    get label() {
      return studioT('Unknown');
    },
    variant: 'warning',
  },
};

export function formatEnvironmentBuildTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
