import type { MastraClient } from '@mastra/client-js';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { IconVoiceSimple } from '@mastra/playground-ui/icons/central/IconVoiceSimple';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { useMastraPackages } from '@mastra/react/hooks/configuration';
import { useState } from 'react';
import { LiveKitRecordingContent } from './livekit-recording-content';

type TraceSpans = Awaited<ReturnType<MastraClient['getTraceLight']>>['spans'];

/** Owns the review dialog for one trace. Callers key this component by traceId. */
export function LiveKitRecordingReview({ traceId, spans }: { traceId: string; spans?: TraceSpans }) {
  useLocale();
  const { data: packages } = useMastraPackages();
  const [open, setOpen] = useState(false);
  const calls = spans?.filter(
    span =>
      span.name === 'voice call' && typeof span.metadata?.roomName === 'string' && span.metadata.roomName.length > 0,
  );
  if (!packages?.liveKitRecordingRouteEnabled || calls?.length !== 1) return undefined;

  return (
    <>
      <Button icon={<IconVoiceSimple />} size="sm" onClick={() => setOpen(true)}>
        {studioT('Review audio')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{studioT('Review Audio')}</DialogTitle>
            <DialogDescription>{studioT('Listen to the call associated with this trace.')}</DialogDescription>
          </DialogHeader>
          <DialogBody>{open && <LiveKitRecordingContent traceId={traceId} />}</DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
