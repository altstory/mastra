import { IconChevronDownMedium } from '@/ds/icons/central/IconChevronDownMedium';
import { IconChevronTopMedium } from '@/ds/icons/central/IconChevronTopMedium';
import { t as studioT, useLocale } from '@/lib/i18n';
import { Trans } from '@/lib/i18n/trans';

/** The list's last row: pages more rows in, or collapses back to the top rows. */
export function ShowMore({
  shown,
  total,
  limit,
  pageSize,
  onMore,
  onLess,
}: {
  shown: number;
  total: number;
  limit: number;
  pageSize: number;
  onMore: () => void;
  onLess: () => void;
}) {
  useLocale();
  if (total <= limit) return null;
  const left = total - shown;
  const button =
    'flex items-center gap-1.5 rounded-md px-2 py-1 text-label text-muted-foreground transition-colors duration-150 hover:bg-fill-subtle hover:text-foreground';
  const n = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  return (
    <li className="-mx-2 flex items-center gap-1">
      {left > 0 && (
        <button type="button" onClick={onMore} className={button}>
          <IconChevronDownMedium className="size-icon-sm shrink-0" />
          {studioT('Show') + ' '}
          {Math.min(left, pageSize)} {' ' + studioT('more')}
        </button>
      )}
      {shown > limit && (
        <button type="button" onClick={onLess} className={button}>
          <IconChevronTopMedium className="size-icon-sm shrink-0" />
          {studioT('Show top') + ' '}
          {limit}
        </button>
      )}
      {left > 0 && (
        <span className="ml-auto pr-2 text-body-sm text-subtle-foreground tabular-nums">
          <Trans id="{part0} of {part1}" values={{ part0: n.format(shown), part1: n.format(total) }} />
        </span>
      )}
    </li>
  );
}
