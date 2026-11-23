import { useStoredPromptBlockMutations } from '@mastra/react/hooks/prompt-blocks';
import { useState } from 'react';
import { AlertDialog } from '@/ds/components/AlertDialog';
import { Button } from '@/ds/components/Button';
import { TrashIcon } from '@/ds/icons/TrashIcon';
import { useLinkComponent } from '@/lib/framework';
import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

interface DeletePromptBlockActionProps {
  blockId: string;
  blockName: string;
  disabled?: boolean;
}

export function DeletePromptBlockAction({ blockId, blockName, disabled = false }: DeletePromptBlockActionProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const { navigate, paths } = useLinkComponent();
  const { deleteStoredPromptBlock } = useStoredPromptBlockMutations({ blockId: blockId });

  const isPending = deleteStoredPromptBlock.isPending;

  const confirm = async () => {
    try {
      await deleteStoredPromptBlock.mutateAsync();
      toast.success(studioT('Prompt block deleted'));
      setOpen(false);
      navigate(paths.promptBlocksLink());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : studioT('Failed to delete prompt block'));
    }
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={disabled || isPending}
        data-testid="prompt-block-delete"
        variant="ghost"
        size="sm"
      >
        <TrashIcon />
        {studioT('Delete')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialog.Content data-testid="prompt-block-delete-dialog">
          <AlertDialog.Header>
            <AlertDialog.Title>{studioT('Delete prompt block?')}</AlertDialog.Title>
            <AlertDialog.Description>
              {studioT('This permanently deletes "')}
              {blockName}
              {studioT('". This cannot be undone.')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel data-testid="prompt-block-delete-cancel" disabled={isPending}>
              {studioT('Cancel')}
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              data-testid="prompt-block-delete-confirm"
              disabled={isPending}
              onClick={() => {
                // Use a plain button (not AlertDialog.Close) so the dialog stays
                // open while the request is in flight and on error.
                void confirm();
              }}
            >
              {isPending ? studioT('Deleting…') : studioT('Delete prompt block')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
