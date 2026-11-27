import { MountIcon } from './mount-icon';
import { useWorkspaceContext } from './use-workspace-context';
import type { WorkspaceTreeRowActions } from './workspace-tree-row-actions';
import { DeleteButton, RowActions } from './workspace-tree-row-actions';
import type { WorkspaceEntryRow } from './workspace-tree-rows';
import { Button } from '@/ds/components/Button/Button';
import { Spinner } from '@/ds/components/Spinner/spinner';
import { TreeIcon } from '@/ds/components/Tree/tree-icon';
import { TreeLabel } from '@/ds/components/Tree/tree-label';
import { IconExclamationCircle } from '@/ds/icons/central/IconExclamationCircle';
import { IconFolderAddRight } from '@/ds/icons/central/IconFolderAddRight';
import { IconLock } from '@/ds/icons/central/IconLock';
import { FolderIcon } from '@/ds/icons/FolderIcon';
import { t as studioT, useLocale } from '@/lib/i18n';

export function FolderRow({ row, actions }: { row: WorkspaceEntryRow; actions: WorkspaceTreeRowActions }) {
  useLocale();
  const { onDelete, onCreateDirectory, isReadOnly } = useWorkspaceContext();
  const { name, mount } = row.entry;
  const canDelete = onDelete && !isReadOnly(row.path);
  const canCreate = onCreateDirectory && !isReadOnly(row.path);

  return (
    <>
      <TreeIcon>
        {mount ? (
          <span
            role="img"
            aria-label={studioT('Mount: {value0}', { value0: mount.displayName ?? mount.provider })}
            className="flex"
          >
            <MountIcon mount={mount} />
          </span>
        ) : (
          <FolderIcon />
        )}
      </TreeIcon>
      <TreeLabel>{name}</TreeLabel>
      {mount?.status === 'error' ? (
        <span
          role="img"
          aria-label={studioT('Mount error: {value0}', { value0: mount.error ?? 'unavailable' })}
          className="flex shrink-0"
        >
          <IconExclamationCircle className="size-icon-xs text-destructive-foreground" />
        </span>
      ) : null}
      {mount && isReadOnly(row.path) ? (
        <span role="img" aria-label={studioT('Read-only')} className="flex shrink-0">
          <IconLock className="size-icon-xs text-muted-foreground" />
        </span>
      ) : null}
      {row.loading ? (
        <span className="flex shrink-0 animate-in delay-200 fill-mode-backwards fade-in">
          <Spinner size="sm" aria-label={studioT('Loading {value0}', { value0: name })} className="size-3 text-muted-foreground" />
        </span>
      ) : null}
      {canDelete || canCreate ? (
        <RowActions>
          {canCreate ? (
            <Button
              variant="ghost"
              size="icon-sm"
              tooltip={studioT('New folder in {value0}', { value0: name })}
              onClick={event => {
                event.stopPropagation();
                actions.onRequestCreate(row.path);
              }}
              onKeyDown={event => event.stopPropagation()}
            >
              <IconFolderAddRight />
            </Button>
          ) : null}
          {canDelete ? (
            <DeleteButton name={name} onClick={() => actions.onRequestDelete({ path: row.path, type: 'directory' })} />
          ) : null}
        </RowActions>
      ) : null}
    </>
  );
}
