import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { Combobox } from '@mastra/playground-ui/components/Combobox';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Field, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { InfoTooltip } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { IconArrowInbox } from '@mastra/playground-ui/icons/central/IconArrowInbox';
import { IconChatBubble7 } from '@mastra/playground-ui/icons/central/IconChatBubble7';
import { IconCheckmark2Medium } from '@mastra/playground-ui/icons/central/IconCheckmark2Medium';
import { IconChevronDownMedium } from '@mastra/playground-ui/icons/central/IconChevronDownMedium';
import { IconFloppyDisk1 } from '@mastra/playground-ui/icons/central/IconFloppyDisk1';
import { IconPullRequest } from '@mastra/playground-ui/icons/central/IconPullRequest';
import { Icon } from '@mastra/playground-ui/icons/Icon';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { formatDate } from '@mastra/playground-ui/utils/date-format';
import { useAgentVersions } from '@mastra/react/hooks/agents';
import { useMemo, useState, useCallback } from 'react';

interface AgentPlaygroundVersionBarProps {
  agentId: string;
  activeVersionId?: string;
  selectedVersionId?: string;
  onVersionSelect: (versionId: string) => void;
  isDirty: boolean;
  isSavingDraft: boolean;
  isPublishing: boolean;
  hasDraft: boolean;
  readOnly: boolean;
  isCodeSourceAgent?: boolean;
  showCodeModeActions?: boolean;
  canOpenPr?: boolean;
  openPrTitle?: string;
  onSaveDraft: (changeMessage?: string) => Promise<void>;
  onPublish: () => Promise<void>;
  onDownloadJson?: () => Promise<void>;
  onOpenPr?: () => Promise<void>;
  /** Whether the user is viewing a previous (non-latest) version that can be published */
  isViewingPreviousVersion?: boolean;
}

export function AgentPlaygroundVersionBar({
  agentId,
  activeVersionId,
  selectedVersionId,
  onVersionSelect,
  isDirty,
  isSavingDraft,
  isPublishing,
  hasDraft,
  readOnly,
  isCodeSourceAgent = false,
  showCodeModeActions = false,
  canOpenPr = false,
  openPrTitle,
  onSaveDraft,
  onPublish,
  onDownloadJson,
  onOpenPr,
  isViewingPreviousVersion = false,
}: AgentPlaygroundVersionBarProps) {
  const studioLocale = useLocale();
  const [showMessageDialog, setShowMessageDialog] = useState(false);
  const [changeMessage, setChangeMessage] = useState('');

  const { data } = useAgentVersions({
    agentId,
    params: { orderBy: { direction: 'DESC' } },
    queryOptions: { enabled: Boolean(agentId) },
  });

  const versions = useMemo(() => data?.versions ?? [], [data?.versions]);
  const latestVersion = versions[0];

  const activeVersion = activeVersionId ? versions.find(v => v.id === activeVersionId) : undefined;
  const activeVersionNumber = activeVersion?.versionNumber;

  const versionOptions = useMemo(
    () =>
      versions.map(v => {
        const isPublished = v.id === activeVersionId;
        const isDraftVersion = activeVersionNumber !== undefined && v.versionNumber > activeVersionNumber;
        const versionName = `${isCodeSourceAgent ? 'Save' : 'v'}${v.versionNumber}`;
        const createdAt = formatDate(v.createdAt, 'date-time');

        return {
          value: v.id,
          label: createdAt ? `${versionName} (${createdAt})` : versionName,
          description: v.changeMessage || undefined,
          end: isCodeSourceAgent ? (
            <Badge variant={isPublished ? 'success' : 'info'}>
              {isPublished ? studioT('Current') : studioT('Saved')}
            </Badge>
          ) : isPublished ? (
            <Badge variant="success">{studioT('Published')}</Badge>
          ) : isDraftVersion ? (
            <Badge variant="info">{studioT('Draft')}</Badge>
          ) : undefined,
        };
      }),
    [versions, activeVersionId, activeVersionNumber, isCodeSourceAgent, studioLocale],
  );

  const currentValue = selectedVersionId ?? latestVersion?.id ?? '';

  const saveDisabled = readOnly || !isDirty || isSavingDraft || isPublishing;
  const codeSaveDisabled = readOnly || (!isDirty && !hasDraft) || isSavingDraft || isPublishing;
  const versionInfoText = isCodeSourceAgent
    ? 'Code mode saves write override JSON to filesystem-backed editor storage. This dropdown shows saved override snapshots for this agent.'
    : "Changes are saved as draft versions. When you're ready, publish a version to make it the active configuration used in production.";

  const handleSaveWithMessage = useCallback(async () => {
    if (isSavingDraft) return;
    const msg = changeMessage.trim();
    await onSaveDraft(msg || undefined);
    setShowMessageDialog(false);
    setChangeMessage('');
  }, [changeMessage, onSaveDraft, isSavingDraft]);

  return {
    versionSelector: (
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        {versions.length > 0 ? (
          <Combobox
            options={versionOptions}
            value={currentValue}
            onValueChange={onVersionSelect}
            placeholder={studioT('Select version')}
            variant="ghost"
            className="min-w-0 flex-1"
          />
        ) : (
          <Txt variant="meta" tone="muted">
            {isCodeSourceAgent ? studioT('No filesystem saves yet') : studioT('No versions yet')}
          </Txt>
        )}

        {currentValue && <CopyButton content={currentValue} tooltip={studioT('Copy version ID')} />}

        <InfoTooltip
          aria-label={studioT('Version information')}
          side="bottom"
          align="start"
          contentClassName="max-w-56"
        >
          {versionInfoText}
        </InfoTooltip>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {readOnly && <Badge variant="warning">{studioT('Read-only')}</Badge>}
          {!readOnly && hasDraft && !isCodeSourceAgent && <Badge variant="info">{studioT('Unpublished')}</Badge>}
        </div>
      </div>
    ),
    actionBar: (
      <div className="flex items-center justify-end border-t border-border bg-card px-3 py-2">
        {showCodeModeActions ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="default" size="md" onClick={() => void onDownloadJson?.()} icon={<IconArrowInbox />}>
              {studioT('Download JSON')}
            </Button>
            {canOpenPr ? (
              <Button
                variant="primary"
                size="md"
                onClick={() => void onOpenPr?.()}
                aria-label={openPrTitle}
                icon={<IconPullRequest />}
              >
                {studioT('Open PR')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={() => void (isDirty ? onSaveDraft() : onPublish())}
                disabled={codeSaveDisabled}
                icon={<IconFloppyDisk1 />}
                loading={isSavingDraft}
              >
                {studioT('Save to filesystem')}
              </Button>
            )}
          </div>
        ) : readOnly && !isViewingPreviousVersion ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ButtonsGroup>
              <Button
                variant="default"
                onClick={() => onSaveDraft()}
                disabled={saveDisabled}
                icon={<IconFloppyDisk1 />}
                loading={isSavingDraft}
              >
                {studioT('Save new version')}
              </Button>
              <DropdownMenu>
                <DropdownMenu.Trigger asChild>
                  <Button
                    size="icon-md"
                    variant="default"
                    disabled={saveDisabled}
                    aria-label={studioT('More save options')}
                  >
                    <IconChevronDownMedium />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item onSelect={() => setShowMessageDialog(true)}>
                    <Icon size="xs">
                      <IconChatBubble7 />
                    </Icon>
                    {studioT('Save with message')}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
            </ButtonsGroup>

            <Button
              variant="primary"
              size="md"
              onClick={onPublish}
              disabled={
                isViewingPreviousVersion
                  ? selectedVersionId === activeVersionId || isPublishing || isSavingDraft
                  : readOnly || !hasDraft || isPublishing || isSavingDraft
              }
              icon={<IconCheckmark2Medium />}
              loading={isPublishing}
            >
              {isViewingPreviousVersion ? studioT('Publish this version') : studioT('Publish')}
            </Button>
          </div>
        )}

        <Dialog open={showMessageDialog} onOpenChange={setShowMessageDialog} pending={isSavingDraft}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{studioT('Save New Version')}</DialogTitle>
              <DialogDescription>{studioT('Add a message to describe the changes in this version.')}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field>
                <FieldLabel>{studioT('Change message')}</FieldLabel>
                <Input
                  placeholder={studioT('Describe what changed')}
                  value={changeMessage}
                  onChange={e => setChangeMessage(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void handleSaveWithMessage();
                    }
                  }}
                  disabled={isSavingDraft}
                  autoFocus
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogCancel>{studioT('Cancel')}</DialogCancel>
              <DialogAction onConfirm={handleSaveWithMessage}>{studioT('Save version')}</DialogAction>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    ),
  };
}
