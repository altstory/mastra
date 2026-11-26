import { Button } from '@mastra/playground-ui/components/Button';
import {
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { Trans } from '@mastra/playground-ui/lib/i18n/trans';
import { toast } from '@mastra/playground-ui/utils/toast';
import { useDisconnectChannel } from '@mastra/react/hooks/agents';
import type { ChannelPlatformInfo } from '@mastra/react/hooks/agents';

export interface DisconnectChannelContentProps {
  platform: ChannelPlatformInfo;
  agentId: string;
  onCancel: () => void;
  onClose: () => void;
}

export function DisconnectChannelContent({ platform, agentId, onCancel, onClose }: DisconnectChannelContentProps) {
  useLocale();
  const { mutateAsync: disconnect, isPending } = useDisconnectChannel({ platform: platform.id });

  const handleConfirm = async () => {
    try {
      await disconnect(agentId);
      toast.success(studioT('{value0} disconnected', { value0: platform.name }));
      onClose();
    } catch (err) {
      const e = err as Error & { body?: { error?: string } };
      toast.error(e.body?.error || e.message || studioT('Failed to disconnect channel'));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{studioT('Are you sure?')}</DialogTitle>
        <DialogDescription>
          <Trans
            id="Your agent will be removed from {part0}."
            values={{ part0: <span className="text-foreground">{platform.name}</span> }}
          />
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={onCancel} disabled={isPending}>
          {studioT('Cancel')}
        </Button>
        <DialogAction
          onConfirm={handleConfirm}
          data-testid={`publish-channel-dialog-${platform.id}-disconnect-confirm`}
          loading={isPending}
        >
          {studioT('Confirm')}
        </DialogAction>
      </DialogFooter>
    </>
  );
}
