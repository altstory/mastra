import type { ReactNode } from 'react';
import type { WorkspaceEntryRef } from './use-workspace-context';
import { Button } from '@/ds/components/Button/Button';
import { TrashIcon } from '@/ds/icons/TrashIcon';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface WorkspaceTreeRowActions {
  onRequestDelete: (entry: WorkspaceEntryRef) => void;
  onRequestCreate: (path: string) => void;
}

/** Trailing row details, revealed on hover or keyboard focus. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
      {children}
    </span>
  );
}

export function DeleteButton({ name, onClick }: { name: string; onClick: () => void }) {
  useLocale();
  return (
    <Button
      variant="destructive-ghost"
      size="icon-sm"
      tooltip={studioT('Delete {value0}', { value0: name })}
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <TrashIcon />
    </Button>
  );
}
