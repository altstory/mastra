'use client';

import { useDatasetMutations } from '@mastra/react/hooks/datasets';
import { AlertDialog } from '@/ds/components/AlertDialog';
import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

export interface DeleteDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  datasetId: string;
  datasetName: string;
  onSuccess?: () => void;
}

export function DeleteDatasetDialog({
  open,
  onOpenChange,
  datasetId,
  datasetName,
  onSuccess,
}: DeleteDatasetDialogProps) {
  useLocale();
  const { deleteDataset } = useDatasetMutations();

  const handleDelete = async () => {
    try {
      await deleteDataset.mutateAsync(datasetId);
      toast.success(studioT('Dataset deleted successfully'));
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        studioT('Failed to delete dataset: {value0}', {
          value0: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{studioT('Delete Dataset')}</AlertDialog.Title>
          <AlertDialog.Description>
            {studioT('Are you sure you want to delete "')}
            {datasetName}
            {studioT(
              '"? This will permanently delete the dataset, all its items, and run history. This action cannot be undone.',
            )}
          </AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{studioT('Cancel')}</AlertDialog.Cancel>
          <AlertDialog.Action onClick={handleDelete} disabled={deleteDataset.isPending}>
            {deleteDataset.isPending ? studioT('Deleting...') : studioT('Delete')}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog>
  );
}
