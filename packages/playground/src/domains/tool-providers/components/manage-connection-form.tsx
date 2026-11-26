import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { DialogBody } from '@mastra/playground-ui/components/Dialog';
import { Field, FieldError } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconChainLink3 } from '@mastra/playground-ui/icons/central/IconChainLink3';
import { IconChevronLeftMedium } from '@mastra/playground-ui/icons/central/IconChevronLeftMedium';
import { Icon } from '@mastra/playground-ui/icons/Icon';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';

import { Trans } from '@mastra/playground-ui/lib/i18n/trans';
import { toast } from '@mastra/playground-ui/utils/toast';

import { useDisconnectConnection } from '@mastra/react/hooks/tool-providers';
import { Unplug } from 'lucide-react';
import { useState } from 'react';
import { titleize } from './titleize';
import { useDebouncedConnectionRename } from './use-debounced-connection-rename';

interface ManageConnectionFormProps {
  providerId: string;
  connectionId: string;
  initialLabel: string;
  iconUrl?: string;
  disabled: boolean;
  testIdPrefix: string;
  showBack: boolean;
  onBack: () => void;
  onDisconnected: (connectionId: string) => void;
}

export const ManageConnectionForm = ({
  providerId,
  connectionId,
  initialLabel,
  iconUrl,
  disabled,
  testIdPrefix,
  showBack,
  onBack,
  onDisconnected,
}: ManageConnectionFormProps) => {
  useLocale();
  const rename = useDebouncedConnectionRename({ providerId, connectionId, initialLabel });
  const disconnectConnection = useDisconnectConnection();
  const [draft, setDraft] = useState(initialLabel);
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false);
  const connectionNameField = `${testIdPrefix}-name`;
  const integrationName = titleize(providerId);

  const disconnect = () => {
    disconnectConnection.mutate(
      { providerId, connectionId, force: true },
      {
        onSuccess: () => {
          toast.success(studioT('Connection disconnected'));
          onDisconnected(connectionId);
        },
      },
    );
  };

  return (
    <>
      <DialogBody>
        {showBack && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label={studioT('Back to connections')}
            data-testid={`${testIdPrefix}-back`}
            className="-mt-1 -ml-1.5 w-fit text-muted-foreground"
            icon={<IconChevronLeftMedium />}
          >
            {studioT('Connections')}
          </Button>
        )}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid size-14 place-items-center overflow-hidden rounded-xl bg-muted" aria-hidden>
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-8 object-contain" />
            ) : (
              <Icon size="lg" className="text-muted-foreground">
                <IconChainLink3 />
              </Icon>
            )}
          </div>

          <div className="flex w-full flex-col items-center gap-1.5">
            <Txt variant="meta" tone="muted">
              <Trans id="{part0} connection" values={{ part0: integrationName }} />
            </Txt>
            <Field invalid={Boolean(rename.error)} className="w-full justify-items-center gap-1.5">
              <div className="relative w-full">
                <Input
                  name={connectionNameField}
                  size="sm"
                  value={draft}
                  onChange={event => {
                    setDraft(event.target.value);
                    rename.scheduleRename(event.target.value);
                  }}
                  disabled={disabled || rename.isPending}
                  placeholder={studioT('Unnamed connection')}
                  autoFocus
                  aria-label={studioT('Connection name')}
                  testId={`${testIdPrefix}-input`}
                  className="text-center"
                />
                {rename.isPending && (
                  <span className="absolute top-1/2 right-2 -translate-y-1/2">
                    <Spinner size="sm" aria-label={studioT('Saving')} data-testid={`${testIdPrefix}-saving`} />
                  </span>
                )}
              </div>
              <FieldError>{rename.error ? String(rename.error) : null}</FieldError>
            </Field>
          </div>

          <Button
            icon={<Unplug />}
            type="button"
            variant="ghost"
            onClick={() => setConfirmDisconnectOpen(true)}
            disabled={disabled || disconnectConnection.isPending}
            data-testid={`${testIdPrefix}-disconnect`}
          >
            {studioT('Disconnect')}
          </Button>
        </div>
      </DialogBody>

      <AlertDialog open={confirmDisconnectOpen} onOpenChange={setConfirmDisconnectOpen}>
        <AlertDialog.Content data-testid={`${testIdPrefix}-disconnect-dialog`}>
          <AlertDialog.Header>
            <AlertDialog.Title>{studioT('Disconnect connection?')}</AlertDialog.Title>
            <AlertDialog.Description>
              {studioT(
                'Disconnecting revokes this authorized account and removes it from Altflow. Agents using this connection will lose access. This can’t be undone.',
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          {disconnectConnection.error ? (
            <AlertDialog.Body>
              <div role="alert">
                <Notice variant="destructive">{String(disconnectConnection.error)}</Notice>
              </div>
            </AlertDialog.Body>
          ) : null}
          <AlertDialog.Footer>
            <AlertDialog.Cancel
              data-testid={`${testIdPrefix}-disconnect-cancel`}
              disabled={disconnectConnection.isPending}
            >
              {studioT('Cancel')}
            </AlertDialog.Cancel>
            <Button
              icon={<Unplug />}
              type="button"
              variant="primary"
              onClick={disconnect}
              disabled={disabled}
              data-testid={`${testIdPrefix}-disconnect-confirm`}
              loading={disconnectConnection.isPending}
            >
              {studioT('Disconnect')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
};
