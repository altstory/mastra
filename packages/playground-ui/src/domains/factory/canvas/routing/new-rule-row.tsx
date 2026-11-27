import { Txt } from '@/ds/components/Txt';
import { IconCircleDashed } from '@/ds/icons/central/IconCircleDashed';
import { t as studioT, useLocale } from '@/lib/i18n';

/** A new rule being made for the board, shown in place until it is saved. */
export function NewRuleRow({
  phase,
}: {
  /** The name of the phase it files into; undefined until one is picked or when the phase is unknown. */
  phase: string | undefined;
}) {
  useLocale();
  return (
    <li className="flex h-5.5 items-center gap-1.5 rounded-md border border-dashed border-border-strong px-1.5">
      <IconCircleDashed className="size-icon-xs shrink-0 text-muted-foreground" aria-hidden />
      <Txt as="span" variant="caption" tone="ink" className="flex-1">
        {studioT('New rule')}
      </Txt>
      <Txt as="span" variant="caption" tone="muted">
        {phase ?? studioT('Pick a phase')}
      </Txt>
    </li>
  );
}
