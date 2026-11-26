import { DialogAction } from '@mastra/playground-ui/components/Dialog';
import { t as studioT } from '@mastra/playground-ui/lib/i18n';

export interface RunExperimentActionProps {
  onRun: () => void;
  canRun: boolean;
  isRunning: boolean;
}

export function RunExperimentAction({ onRun, canRun, isRunning }: RunExperimentActionProps) {
  return (
    <DialogAction onConfirm={onRun} disabled={!canRun} loading={isRunning}>
      {studioT('Run experiment')}
    </DialogAction>
  );
}
