import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface BoardStats {
  /** Items of the dry run's sample this board would take. */
  takes: number;
  /** Items its rules matched that a board earlier in the order took first. */
  lost: number;
  sampled: number;
}

/** What the board would have taken of the dry run's sample, and lost to boards earlier in the order. */
export function BoardStatsRow({ stats }: { stats: BoardStats }) {
  useLocale();
  return (
    <li className="flex h-5.5 items-center justify-between gap-1.5">
      <Txt as="span" variant="caption" tone="muted">
        {studioT('Last')} {stats.sampled} {studioT('items')}
      </Txt>
      <Txt as="span" variant="caption" tone="muted">
        {stats.takes === 0 ? studioT('None land here') : studioT('{value0} land here', { value0: stats.takes })},{' '}
        {stats.lost === 0
          ? studioT('none lost to earlier boards')
          : studioT('{value0} lost to earlier boards', { value0: stats.lost })}
      </Txt>
    </li>
  );
}
