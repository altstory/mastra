import { SidePanel } from '../canvas-frame';
import { Txt } from '@/ds/components/Txt';
import type { LinkComponent } from '@/ds/types/link-component';
import { t as studioT, useLocale } from '@/lib/i18n';

/** The canvas's side panel when the page names a phase the board doesn't have. */
export function PhaseNotFoundPanel({
  boardTitle,
  boardHref,
  LinkComponent,
}: {
  boardTitle: string;
  /** Where the board opens. */
  boardHref: string;
  LinkComponent: LinkComponent;
}) {
  useLocale();
  return (
    <SidePanel label={studioT('Phase not found')}>
      <Txt variant="body-sm" tone="ink" role="alert">
        {boardTitle} {studioT('has no such phase.')}
      </Txt>
      <LinkComponent href={boardHref} className="text-body-sm text-muted-foreground hover:text-foreground">
        {studioT('Back to the board')}
      </LinkComponent>
    </SidePanel>
  );
}
