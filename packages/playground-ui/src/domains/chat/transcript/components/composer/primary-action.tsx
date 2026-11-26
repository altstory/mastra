import { Button } from '@/ds/components/Button';
import { IconArrowUp } from '@/ds/icons/central/IconArrowUp';
import { IconStop } from '@/ds/icons/central/IconStop';
import { t as studioT, useLocale } from '@/lib/i18n';

interface ComposerPrimaryActionProps {
  showAbort: boolean;
  sendDisabled: boolean;
  sendTitle?: string;
  onAbort: () => void;
}

export function ComposerPrimaryAction({ showAbort, sendDisabled, sendTitle, onAbort }: ComposerPrimaryActionProps) {
  useLocale();
  if (showAbort) {
    return (
      <Button
        type="button"
        variant="primary"
        size="icon-sm"
        onClick={event => {
          // Send turns into Abort under the pointer: a double-click on Send must not abort.
          if (event.detail > 1) return;
          onAbort();
        }}
        aria-label={studioT('Abort')}
      >
        <IconStop />
      </Button>
    );
  }

  return (
    <Button
      type="submit"
      variant="primary"
      size="icon-sm"
      disabled={sendDisabled}
      aria-label={studioT('Send message')}
      title={sendTitle}
    >
      <IconArrowUp />
    </Button>
  );
}
