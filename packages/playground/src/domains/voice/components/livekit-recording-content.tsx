import { Button } from '@mastra/playground-ui/components/Button';
import { IconArrowRotateClockwise } from '@mastra/playground-ui/icons/central/IconArrowRotateClockwise';
import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { useLiveKitRecording } from '../hooks/use-livekit-recording';
import { LiveKitRecordingState } from './livekit-recording-state';

export function LiveKitRecordingContent({ traceId }: { traceId: string }) {
  useLocale();
  const { data, isFetching, isError, refetch, dataUpdatedAt } = useLiveKitRecording(traceId);
  return (
    <div className="flex flex-col gap-4">
      <LiveKitRecordingState data={data} isFetching={isFetching} isError={isError} dataUpdatedAt={dataUpdatedAt} />
      <Button icon={<IconArrowRotateClockwise />} size="sm" loading={isFetching} onClick={() => void refetch()}>
        {studioT('Refresh recording')}
      </Button>
    </div>
  );
}
