import type { RuleRetestInfo } from './types';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

/** Where the item a test opened the rule from goes under the unsaved rules, and where the saved ones put it. */
export function RetestBox({ retest }: { retest: RuleRetestInfo | undefined }) {
  useLocale();
  if (!retest) return null;
  const { title, after, before } = retest;

  return (
    <div role="status" className="flex flex-col gap-0.5 rounded-[10px] bg-fill-subtle px-3 py-2">
      <Txt as="p" variant="body-sm" className="truncate">
        {title} {studioT('now goes to')} {after}
      </Txt>
      {before !== undefined && before !== after && (
        <Txt as="p" variant="caption" tone="muted">
          {studioT('Was')} {before}
        </Txt>
      )}
    </div>
  );
}
