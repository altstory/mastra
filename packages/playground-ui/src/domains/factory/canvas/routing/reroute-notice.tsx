import { useState } from 'react';
import { Button } from '@/ds/components/Button';
import { Notice } from '@/ds/components/Notice';
import { t as studioT, useLocale } from '@/lib/i18n';

/**
 * After rules change, untouched cards (alone in their board's first phase, no session yet) may now belong on another
 * board. Offers to move them to the start of that board.
 */
export function RerouteNotice({
  total,
  where,
  canEdit,
  moving,
  onMove,
}: {
  /** Untouched cards that now belong on another board; with none, nothing shows. */
  total: number;
  /** The board they belong on, or "other boards". */
  where: string;
  canEdit: boolean;
  /** The move is running. */
  moving: boolean;
  onMove: () => void;
}) {
  useLocale();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || total === 0) return null;
  const cards = total === 1 ? '1 untouched card now belongs' : `${total} untouched cards now belong`;

  return (
    <Notice
      variant="info"
      title={studioT('Rules changed')}
      actionPlacement="end"
      action={
        <>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            {studioT('Not now')}
          </Button>
          {canEdit && (
            <Button size="sm" variant="primary" onClick={onMove} loading={moving}>
              {studioT('Move them')}
            </Button>
          )}
        </>
      }
    >
      {cards} {studioT('on')} {where}.
    </Notice>
  );
}
