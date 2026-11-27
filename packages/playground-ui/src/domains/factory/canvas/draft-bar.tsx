import { UnsavedPill } from './unsaved-pill';
import { AlertDialog } from '@/ds/components/AlertDialog';
import { Button } from '@/ds/components/Button';
import { Notice } from '@/ds/components/Notice';
import { t as studioT, useLocale } from '@/lib/i18n';

/**
 * The pill over the toolbar while the board has unsaved edits. A phase with a problem, or a board without a name,
 * holds the save and says which one to fix.
 */
export function DraftBar({
  hold,
  stale,
  error,
  saving,
  onSave,
  onDiscard,
  onReload,
}: {
  /** Why the board can't be saved yet. */
  hold: string | undefined;
  /** Someone else saved the board since this draft started. */
  stale: boolean;
  error: string | undefined;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  useLocale();
  return (
    <div className="flex w-full max-w-130 flex-col items-center gap-2">
      {stale && (
        <Notice
          variant="warning"
          title={studioT('Someone else changed this board')}
          action={<Notice.Button onClick={onReload}>{studioT('Reload')}</Notice.Button>}
          className="w-full bg-card shadow-overlay"
        >
          <Notice.Message>{studioT('Reload to see their version. Your unsaved changes will be lost.')}</Notice.Message>
        </Notice>
      )}
      {error && !stale && (
        <Notice variant="destructive" role="alert" className="w-full bg-card shadow-overlay">
          <Notice.Message>
            {studioT('The board was not saved.')} {error}
          </Notice.Message>
        </Notice>
      )}
      <UnsavedPill
        label={hold ?? studioT('Unsaved changes')}
        held={hold !== undefined}
        saveLabel="Save"
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </div>
  );
}

/** Asks before leaving the board's settings with unsaved edits. */
export function LeaveDialog({
  boardName,
  open,
  onStay,
  onLeave,
}: {
  boardName: string;
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  useLocale();
  return (
    <AlertDialog open={open} onOpenChange={next => !next && onStay()}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{studioT('Discard changes to {boardName}?', { boardName })}</AlertDialog.Title>
          <AlertDialog.Description>
            {studioT('Your unsaved changes to this board will be lost.')}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{studioT('Keep editing')}</AlertDialog.Cancel>
          <Button variant="destructive" size="md" onClick={onLeave}>
            {studioT('Discard')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
