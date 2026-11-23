import { createContext, useContext, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Txt } from '@/ds/components/Txt';
import { cn } from '@/lib/utils';

// On a settings page (`PageLayout variant="settings"`), section titles and descriptions sit 10px inside the card's edge, in line with
// the inset page title. Anywhere else (forms, other pages) they line up with the page's left edge and field labels.
// The inset is a custom property, so a caller's `ps-*` class still wins. Written out in full so Tailwind finds it.
const settingsInset =
  '[--settings-inset:0px] in-data-[slot=settings-layout]:[--settings-inset:--spacing(2.5)] ps-(--settings-inset)';

const SettingsTitleIdContext = createContext<string | undefined>(undefined);

/** One section of a settings page: a `SettingsTitle` (or `SettingsHeader`) above its `SettingsContainer`. */
export function SettingsGroup({ className, ...props }: ComponentProps<'section'>) {
  const titleId = useId();

  return (
    <SettingsTitleIdContext.Provider value={titleId}>
      <section
        aria-labelledby={titleId}
        className={cn('flex min-w-0 scroll-mt-4 flex-col gap-2', className)}
        {...props}
      />
    </SettingsTitleIdContext.Provider>
  );
}

/** A section title with something beside it. A list's actions go in its card (`SettingsListHeader`), not here. */
export function SettingsHeader({
  action,
  children,
  className,
  ...props
}: ComponentProps<'header'> & { action?: ReactNode }) {
  return (
    <header
      className={cn('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4', className)}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
      {action != null && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function SettingsTitle({
  accessory,
  info: _info,
  className,
  children,
  ...props
}: Omit<ComponentProps<'h2'>, 'id'> & {
  accessory?: ReactNode;
  /** @deprecated Hover explanations are no longer displayed. */
  info?: ReactNode;
}) {
  const titleId = useContext(SettingsTitleIdContext);

  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', settingsInset)}>
      <Txt as="h2" id={titleId} variant="subheading" tone="ink" className={className} {...props}>
        {children}
      </Txt>
      {accessory}
    </div>
  );
}

export function SettingsDescription({ className, ...props }: ComponentProps<'p'>) {
  return <Txt as="p" variant="caption" tone="muted" className={cn(settingsInset, className)} {...props} />;
}
