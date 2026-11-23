'use client';

import type { ClientScoreRowData, DatasetExperimentResult } from '@mastra/client-js';
import type { ExperimentItemUsage } from '@mastra/react/hooks/experiments';
import { useMemo, useCallback } from 'react';
import { useExperimentItemPanel } from '../context/experiment-item-panel-context';
import { getOptionalResultColumns } from '../utils/result-output';
import { ExperimentResultsList } from './experiment-results-list';
import { t as studioT, useLocale } from '@/lib/i18n';

export type ExperimentResultsSectionProps = {
  results: DatasetExperimentResult[];
  isLoading: boolean;
  setEndOfListElement?: (element: HTMLDivElement | null) => void;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (resultId: string) => void;
  onToggleSelectAll: () => void;
  /** Shows the Cost and Tokens columns. */
  supportsMetrics?: boolean;
  /** Scores grouped by item id; adds one column per scorer found. */
  scoresByItemId?: Record<string, Array<Pick<ClientScoreRowData, 'scorerId' | 'score' | 'reason'>>>;
  /** Usage of each result's trace, keyed by trace id. */
  usageByTraceId?: Record<string, ExperimentItemUsage>;
};

/**
 * Results section of an experiment, inside an `ExperimentItemPanelProvider`. Clicking a row opens
 * (or closes) that item's panel and the open item's row is highlighted. Selection is owned by the
 * page so the bulk actions can render in the top area next to the page actions.
 */
export function ExperimentResultsSection({
  results,
  isLoading,
  setEndOfListElement,
  isFetchingNextPage,
  hasNextPage,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  supportsMetrics = false,
  scoresByItemId,
  usageByTraceId,
}: ExperimentResultsSectionProps) {
  useLocale();
  const { currentItemId, openItem, close } = useExperimentItemPanel();

  const featuredResultId = useMemo(
    () => (currentItemId ? (results.find(r => r.itemId === currentItemId)?.id ?? null) : null),
    [results, currentItemId],
  );

  const rows = useMemo(
    () =>
      usageByTraceId
        ? results.map(result => ({
            ...result,
            usage: result.traceId ? usageByTraceId[result.traceId] : undefined,
          }))
        : results,
    [results, usageByTraceId],
  );

  const scorerIds = useMemo(() => {
    if (!scoresByItemId) return [];
    const ids = new Set<string>();
    for (const scores of Object.values(scoresByItemId)) {
      for (const score of scores) {
        ids.add(score.scorerId);
      }
    }
    return [...ids].sort();
  }, [scoresByItemId]);

  const handleResultClick = useCallback(
    (resultId: string) => {
      const result = results.find(r => r.id === resultId);
      if (!result) return;
      if (result.itemId === currentItemId) {
        close();
      } else {
        openItem(result.itemId);
      }
    },
    [results, currentItemId, close, openItem],
  );

  const itemLabel = studioT('Item ID');
  const inputLabel = studioT('Input');
  const costLabel = studioT('Cost');
  const tokensLabel = studioT('Tokens');
  const durationLabel = studioT('Duration');
  const resultsListColumns = useMemo(
    () => [
      { name: 'itemId', label: itemLabel, size: '7rem' },
      { name: 'input', label: inputLabel, size: '20rem' },
      ...getOptionalResultColumns(results),
      ...(supportsMetrics
        ? [
            { name: 'cost', label: costLabel, size: 'auto' },
            { name: 'tokens', label: tokensLabel, size: 'auto' },
          ]
        : []),
      { name: 'duration', label: durationLabel, size: 'auto' },
      ...scorerIds.map(id => ({ name: id, label: id, size: 'auto' })),
    ],
    [results, scorerIds, supportsMetrics, itemLabel, inputLabel, costLabel, tokensLabel, durationLabel],
  );

  return (
    <div className="h-full min-h-0 min-w-0 overflow-y-auto">
      <ExperimentResultsList
        results={rows}
        isLoading={isLoading}
        featuredResultId={featuredResultId}
        onResultClick={handleResultClick}
        columns={resultsListColumns}
        scoresByItemId={scoresByItemId}
        scorerIds={scorerIds}
        setEndOfListElement={setEndOfListElement}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onToggleSelectAll={onToggleSelectAll}
      />
    </div>
  );
}
