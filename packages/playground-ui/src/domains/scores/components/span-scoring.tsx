import type { GetScorerResponse } from '@mastra/client-js';
import type { useTriggerScorer } from '@mastra/react/hooks/scores';
import { useState } from 'react';
import { Combobox } from '@/ds/components/Combobox';
import { DialogAction, DialogBody, DialogCancel, DialogDescription, DialogFooter } from '@/ds/components/Dialog';
import { Notice } from '@/ds/components/Notice';
import { TextAndIcon } from '@/ds/components/Text';
import { IconCircleInfo } from '@/ds/icons/central/IconCircleInfo';

import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

/** What starts a scorer on a span: the variables of `useTriggerScorer`, so hosts keep the same fetch contract. */
export type TriggerScorerArgs = Parameters<ReturnType<typeof useTriggerScorer>['mutateAsync']>[0];

export interface SpanScoringProps {
  traceId?: string;
  spanId?: string;
  entityType?: string;
  isTopLevelSpan?: boolean;
  /** The scorers a host lists (`listScorers`); `undefined` once loaded means they failed to load. */
  scorers?: Record<string, GetScorerResponse>;
  isLoadingScorers?: boolean;
  /** Starts the picked scorer; resolve once it started, reject when it could not. */
  onTriggerScorer: (args: TriggerScorerArgs) => Promise<unknown>;
  onSuccess?: () => void;
}

/** Picks a scorer and starts it on the span through `onTriggerScorer`. Never fetches. */
export function SpanScoring({
  traceId,
  spanId,
  entityType,
  isTopLevelSpan,
  scorers,
  isLoadingScorers,
  onTriggerScorer,
  onSuccess,
}: SpanScoringProps) {
  useLocale();
  const [selectedScorer, setSelectedScorer] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  let scorerList = Object.entries(scorers || {}).flatMap(([key, scorer]) =>
    scorer
      ? [
          {
            id: key,
            name: scorer.scorer.config.name,
            description: scorer.scorer.config.description,
            isRegistered: scorer.isRegistered,
            type: scorer.scorer.config.type,
          },
        ]
      : [],
  );
  scorerList = scorerList.filter(scorer => scorer.isRegistered);

  // Filter out Scorers with type agent if we are not scoring on a top level agent generated span
  if (entityType !== 'Agent' || !isTopLevelSpan) {
    scorerList = scorerList.filter(scorer => scorer.type !== 'agent');
  }

  const isWaiting = isPending || isLoadingScorers;

  const handleStartScoring = async () => {
    if (!selectedScorer || !traceId) return;
    setIsPending(true);
    try {
      await onTriggerScorer({ scorerName: selectedScorer, traceId, spanId });
    } catch {
      toast.error(studioT('Could not start the scorer. Please try again.'));
      return;
    } finally {
      setIsPending(false);
    }
    toast.info(studioT('Scorer triggered'), {
      description: studioT('Results will appear once scoring completes.'),
    });
    onSuccess?.();
  };

  const selectedScorerDescription = scorerList.find(s => s.id === selectedScorer)?.description || '';

  if (scorers === undefined && !isLoadingScorers) {
    return (
      <>
        <DialogBody>
          <Notice variant="destructive">{studioT('Failed to load scorers.')}</Notice>
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{studioT('Cancel')}</DialogCancel>
        </DialogFooter>
      </>
    );
  }

  if (!isLoadingScorers && scorerList.length === 0) {
    return (
      <>
        <DialogBody>
          <Notice variant="info">{studioT('No eligible scorers have been defined to run.')}</Notice>
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{studioT('Cancel')}</DialogCancel>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogBody>
        <DialogDescription>{studioT('Select a scorer to evaluate this trace.')}</DialogDescription>
        <Combobox
          aria-label={studioT('Select scorer')}
          searchPlaceholder={studioT('Search scorers')}
          placeholder={studioT('Select a scorer')}
          options={scorerList.map(scorer => ({
            label: scorer.name || scorer.id,
            value: scorer.id || scorer.name || '',
          }))}
          onValueChange={setSelectedScorer}
          value={selectedScorer || ''}
          className="w-full"
          disabled={isWaiting}
        />
        {selectedScorerDescription && (
          <TextAndIcon>
            <IconCircleInfo /> {selectedScorerDescription}
          </TextAndIcon>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogCancel disabled={isPending}>{studioT('Cancel')}</DialogCancel>
        <DialogAction disabled={!selectedScorer || isWaiting} onConfirm={handleStartScoring} loading={isPending}>
          {studioT('Start scoring')}
        </DialogAction>
      </DialogFooter>
    </>
  );
}
