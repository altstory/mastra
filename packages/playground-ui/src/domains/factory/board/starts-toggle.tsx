import { Muted } from './phase-walkthrough';
import { Switch } from '@/ds/components/Switch';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

/** How a phase starts (`starts`), with a switch to start it on its own when `onChange` is given. */
export function StartsToggle({
  label,
  starts,
  autoStart,
  onChange,
  pending = false,
  failed = false,
}: {
  label: string;
  starts: string;
  autoStart: boolean;
  onChange?: (on: boolean) => void;
  pending?: boolean;
  failed?: boolean;
}) {
  useLocale();
  if (!onChange) return <Muted>{starts}</Muted>;
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <span className="min-w-0 flex-1">
        {failed ? (
          <Txt as="span" variant="caption" className="text-destructive-foreground">
            {studioT('Didn’t save, try again')}
          </Txt>
        ) : (
          <Muted>{starts}</Muted>
        )}
      </span>
      <Switch
        aria-label={studioT('{value0}: start on its own', { value0: label })}
        checked={autoStart}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </label>
  );
}
