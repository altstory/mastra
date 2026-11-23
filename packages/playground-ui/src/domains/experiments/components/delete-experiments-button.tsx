'use client';

import { useState } from 'react';
import { AlertDialog } from '@/ds/components/AlertDialog';
import { Button } from '@/ds/components/Button';
import { TrashIcon } from '@/ds/icons/TrashIcon';
import { t as studioT, useLocale } from '@/lib/i18n';
import { toast } from '@/utils/toast';

export interface DeleteExperimentsButtonProps {
  experimentIds: string[];
  /** Deletes one experiment; called once per selected id. */
  onDeleteExperiment: (experimentId: string) => Promise<void>;
  onDeleted: () => void;
}

const pluralize = (count: number) => `${count} experiment${count === 1 ? '' : 's'}`;

/** Deletes every given experiment after confirmation. On a partial failure the dialog stays open for a retry. */
export function DeleteExperimentsButton({
  experimentIds,
  onDeleteExperiment,
  onDeleted,
}: DeleteExperimentsButtonProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const count = experimentIds.length;

  const handleDelete = async () => {
    setIsDeleting(true);
    const outcomes = await Promise.allSettled(experimentIds.map(id => onDeleteExperiment(id)));
    setIsDeleting(false);

    const failed = outcomes.filter(outcome => outcome.status === 'rejected').length;
    if (failed > 0) {
      toast.error(studioT('Failed to delete {value0} of {value1}', { value0: failed, value1: pluralize(count) }));
      return;
    }
    toast.success(studioT('Deleted {value0}', { value0: pluralize(count) }));
    setOpen(false);
    onDeleted();
  };

  return (
    <>
      <Button
        size="sm"
        variant="destructive-ghost"
        disabled={count === 0}
        icon={<TrashIcon />}
        onClick={() => setOpen(true)}
      >
        {studioT('Delete')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {studioT('Delete') + ' '}
              {pluralize(count)}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {count === 1 ? studioT('Its') : studioT('Their')}{' '}
              {' ' + studioT("results and traces will be deleted too. This can't be undone.")}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{studioT('Cancel')}</AlertDialog.Cancel>
            <Button icon={<TrashIcon />} variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting
                ? studioT('Deleting…')
                : count === 1
                  ? studioT('Delete experiment')
                  : studioT('Delete experiments')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
