import type { MastraClient } from '@mastra/client-js';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { readChatMetricCount as count } from '@mastra/core/observability';
import type { ModelUsage } from '@mastra/core/observability';
import { formatCacheHitPercent } from './cache-hit-percent';

export type ChatTrace = Awaited<ReturnType<MastraClient['getTrace']>>;
export {
  readChatMetricCount as count,
  readChatMetricInstant as instant,
  projectRunMetrics,
} from '@mastra/core/observability';
export type { ContextReading, ModelUsage, RunMetrics } from '@mastra/core/observability';

export function messageTraceId(message: MastraDBMessage): string | undefined {
  const value = message.content.metadata?.traceId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function totalTokens(models: ModelUsage[]): number | undefined {
  if (!models.length || models.some(model => model.input === undefined || model.output === undefined)) return undefined;
  return models.reduce((sum, model) => sum + (model.input ?? 0) + (model.output ?? 0), 0);
}

/** Interrupted calls may never report usage. Keep known counts as a lower bound. */
export function reportedModelUsage(models: ModelUsage[]) {
  const reported = models.filter(model => model.input !== undefined && model.output !== undefined);
  return { models: reported, partial: reported.length !== models.length };
}

export function cacheHit(models: ModelUsage[], decimalPlaces: 0 | 1 = 0): string | undefined {
  if (!models.length || models.some(model => model.input === undefined || model.cacheRead === undefined))
    return undefined;
  const input = models.reduce((sum, model) => sum + (model.input ?? 0), 0);
  const cached = models.reduce((sum, model) => sum + (model.cacheRead ?? 0), 0);
  return input > 0 && cached <= input ? (formatCacheHitPercent(cached, input, decimalPlaces) ?? undefined) : undefined;
}

export function compactTokens(value: number): string {
  // DSH uses integer K/M counts once the scaled value reaches three digits.
  const scaled = (number: number) => (number >= 100 ? Math.round(number) : Math.round(number * 10) / 10);
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${scaled(value / 1000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

export function exactTokens(value: number, minimum = false): string {
  return `${minimum ? '≥ ' : ''}${new Intl.NumberFormat('en').format(value)} tok`;
}

export function uncachedTokens(usage: ModelUsage): number | undefined {
  if (usage.uncached !== undefined) return count(usage.uncached);
  if (usage.input === undefined || usage.cacheRead === undefined || usage.cacheWrite === undefined) return undefined;
  return count(usage.input - usage.cacheRead - usage.cacheWrite);
}

/** Preserve unknown fields when merging repeated calls to the same route. */
export function groupModelUsage(models: ModelUsage[]): ModelUsage[] {
  const groups = new Map<string | undefined, ModelUsage>();
  const fields = ['input', 'output', 'uncached', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
  for (const model of models) {
    const previous = groups.get(model.route);
    if (!previous) {
      groups.set(model.route, { ...model });
      continue;
    }
    for (const key of fields) {
      const a = previous[key];
      const b = model[key];
      previous[key] = a === undefined || b === undefined ? undefined : a + b;
    }
  }
  return [...groups.values()];
}
