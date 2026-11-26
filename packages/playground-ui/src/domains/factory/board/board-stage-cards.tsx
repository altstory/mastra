import type { ReactNode } from 'react';
import { BoardColumnEmptyState } from './board-column-empty-state';
import type { IntakeSetup } from './board-column-empty-state';

import type { BoardStageId } from './board-icons';
import { BoardItemsSkeleton } from './board-items-skeleton';
import type { BoardLayout } from './board-layout';
import { Button } from '@/ds/components/Button';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

export function BoardStageCards({
  stage,
  isInitialPhase,
  layout,
  loading,
  taskCount,
  intakeSetup,
  intakeFailure,
  filtersExcludeAll,
  composer,
  emptyStateActions,
  children,
}: {
  stage: { id: BoardStageId; label: string };
  isInitialPhase: boolean;
  layout: BoardLayout;
  loading: boolean;
  taskCount: number;
  intakeSetup?: IntakeSetup;
  /** Why the column cannot tell what files onto it, shown instead of its empty state. */
  intakeFailure?: { message: string; retry: () => void };
  filtersExcludeAll: boolean;
  composer?: ReactNode;
  emptyStateActions?: ReactNode;
  children: ReactNode;
}) {
  useLocale();
  const showEmptyState = !loading && !composer && taskCount === 0 && !intakeFailure;
  return (
    <>
      {composer}
      {children}
      {loading && (
        <BoardItemsSkeleton label={studioT('Loading {value0} column', { value0: stage.label })} layout={layout} />
      )}
      {showEmptyState && (
        <BoardColumnEmptyState
          stage={stage}
          isInitialPhase={isInitialPhase}
          intakeSetup={intakeSetup}
          filtersExcludeAll={filtersExcludeAll}
          layout={layout}
          actionSlot={emptyStateActions}
        />
      )}
      {intakeFailure && (
        <div className="flex flex-col items-start gap-2 p-1">
          <Txt as="p" role="alert" variant="meta" className="m-0 text-destructive-foreground">
            {intakeFailure.message}
          </Txt>
          <Button size="sm" onClick={intakeFailure.retry}>
            {studioT('Retry')}
          </Button>
        </div>
      )}
    </>
  );
}
