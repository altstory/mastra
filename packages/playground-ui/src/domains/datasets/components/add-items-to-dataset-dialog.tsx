'use client';

import type { DatasetItem } from '@mastra/client-js';
import { useDatasetMutations, useDatasets } from '@mastra/react/hooks/datasets';
import { useState } from 'react';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ds/components/Dialog';
import { Field, FieldLabel } from '@/ds/components/Field';
import { Form } from '@/ds/components/Form';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/ds/components/Select';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';
import { Trans } from '@/lib/i18n/trans';
import { toast } from '@/utils/toast';

export interface AddItemsToDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: DatasetItem[];
  currentDatasetId: string;
  onSuccess?: (datasetId: string) => void;
}

export function AddItemsToDatasetDialog({
  open,
  onOpenChange,
  items,
  currentDatasetId,
  onSuccess,
}: AddItemsToDatasetDialogProps) {
  useLocale();
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>('');
  const [isAdding, setIsAdding] = useState(false);
  const [progress, setProgress] = useState(0);

  const { data, isLoading: isDatasetsLoading } = useDatasets();
  const { addItem } = useDatasetMutations();

  const datasets = data?.datasets ?? [];

  const availableDatasets = datasets.filter(dataset => dataset.id !== currentDatasetId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedDatasetId) {
      toast.error(studioT('Please select a dataset'));
      return;
    }

    setIsAdding(true);
    setProgress(0);

    try {
      for (const [i, item] of items.entries()) {
        await addItem.mutateAsync({
          datasetId: selectedDatasetId,
          input: item.input,
          groundTruth: item.groundTruth,
          metadata: item.metadata as Record<string, unknown> | undefined,
        });
        setProgress(i + 1);
      }

      const targetDataset = datasets.find(dataset => dataset.id === selectedDatasetId);
      toast.success(
        studioT('Added {value0} item{value1} to "{value2}"', {
          value0: items.length,
          value1: items.length !== 1 ? studioT('English plural suffix') : '',
          value2: targetDataset?.name,
        }),
      );

      setSelectedDatasetId('');
      setIsAdding(false);
      setProgress(0);
      onOpenChange(false);

      onSuccess?.(selectedDatasetId);
    } catch (error) {
      toast.error(
        studioT('Failed to add items: {value0}', { value0: error instanceof Error ? error.message : 'Unknown error' }),
      );
      setIsAdding(false);
      setProgress(0);
    }
  };

  const progressPercent = items.length > 0 ? (progress / items.length) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} pending={isAdding}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{studioT('Add Items to Dataset')}</DialogTitle>
        </DialogHeader>
        <Form onSubmit={handleSubmit}>
          <DialogBody>
            <Field>
              <FieldLabel required>{studioT('Target Dataset')}</FieldLabel>
              <Select
                value={selectedDatasetId}
                onValueChange={setSelectedDatasetId}
                disabled={isAdding || isDatasetsLoading}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={isDatasetsLoading ? studioT('Loading datasets...') : studioT('Select a dataset')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableDatasets.length === 0 ? (
                    <Txt as="p" variant="body" tone="muted" className="px-2 py-4 text-center">
                      {studioT('No other datasets available')}
                    </Txt>
                  ) : (
                    availableDatasets.map(dataset => (
                      <SelectItem key={dataset.id} value={dataset.id}>
                        {dataset.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </Field>

            <Txt tone="muted">
              <Trans
                id="{part0} item {part1} will be copied to the selected dataset"
                values={{ part0: items.length, part1: items.length !== 1 ? studioT('English plural suffix') : '' }}
              />
            </Txt>

            {isAdding && (
              <div className="space-y-2">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-success-indicator transition-all duration-200"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <Txt tone="muted">
                  <Trans id="Adding items: {part0} / {part1}" values={{ part0: progress, part1: items.length }} />
                </Txt>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogCancel onClick={() => setSelectedDatasetId('')}>{studioT('Cancel')}</DialogCancel>
            <DialogAction type="submit" disabled={!selectedDatasetId || availableDatasets.length === 0}>
              {studioT('Add items')}
            </DialogAction>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
