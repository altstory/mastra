import { Button } from '@mastra/playground-ui/components/Button';
import { CodeEditor } from '@mastra/playground-ui/components/CodeEditor';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { ScrollArea } from '@mastra/playground-ui/components/ScrollArea';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useEntityRequestContext } from '@mastra/playground-ui/domains/request-context/hooks/use-entity-request-context';
import { useCopyToClipboard } from '@mastra/playground-ui/hooks/use-copy-to-clipboard';
import { IconCrossMedium } from '@mastra/playground-ui/icons/central/IconCrossMedium';
import { IconPencil } from '@mastra/playground-ui/icons/central/IconPencil';
import { IconSquareArrowTopRight } from '@mastra/playground-ui/icons/central/IconSquareArrowTopRight';

import { t as studioT, useLocale } from '@mastra/playground-ui/lib/i18n';
import { raisedSurfaceStyle } from '@mastra/playground-ui/primitives/raised-surface';
import { controlStateColorTransition, focusRingInset } from '@mastra/playground-ui/primitives/transitions';
import { cn } from '@mastra/playground-ui/utils/cn';
import { toast } from '@mastra/playground-ui/utils/toast';
import { useMemoryConfig } from '@mastra/react/hooks/memory';
import { useState } from 'react';
import { useWorkingMemory } from '../../context/agent-working-memory-context';
import { CodeDisplay } from './code-display';

interface AgentWorkingMemoryProps {
  agentId: string;
}

export const AgentWorkingMemory = ({ agentId }: AgentWorkingMemoryProps) => {
  useLocale();
  const { threadExists, workingMemoryData, workingMemorySource, isLoading, isUpdating, updateWorkingMemory } =
    useWorkingMemory();

  // Get memory config to check if working memory is enabled
  const { data, isLoading: isConfigLoading } = useMemoryConfig({
    agentId: agentId,
    requestContext: useEntityRequestContext('agent', agentId)[0],
    queryOptions: { enabled: Boolean(agentId) },
  });
  const config = data?.config;
  // Check if working memory is enabled
  const isWorkingMemoryEnabled = Boolean(config?.workingMemory?.enabled);

  // All hooks must be called before any early returns
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: workingMemoryData ?? '',
    copyMessage: studioT('Working memory copied!'),
  });
  const [editState, setEditState] = useState({
    source: workingMemoryData,
    value: workingMemoryData ?? '',
  });
  const [isEditing, setIsEditing] = useState(false);

  // Sync the buffer to fresh data, but not while editing — a background refetch or
  // streamed update would otherwise discard the user's in-progress edits.
  if (!isEditing && editState.source !== workingMemoryData) {
    setEditState({ source: workingMemoryData, value: workingMemoryData ?? '' });
  }

  if (isLoading || isConfigLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Txt as="h3" variant="subheading" tone="ink">
            {studioT('Working Memory')}
          </Txt>
          {isWorkingMemoryEnabled && workingMemorySource && (
            <Txt
              aria-label={
                workingMemorySource === 'resource'
                  ? studioT('Shared across all threads for this agent')
                  : studioT('Specific to this conversation thread')
              }
              as="span"
              variant="column"
              className={cn(
                'rounded px-2 py-0.5',
                workingMemorySource === 'resource'
                  ? 'bg-badge-purple-strong text-badge-purple-foreground'
                  : 'bg-badge-blue-strong text-badge-blue-foreground',
              )}
            >
              {workingMemorySource}
            </Txt>
          )}
        </div>
        {isWorkingMemoryEnabled && !threadExists && (
          <Txt variant="caption" tone="muted">
            {studioT('Send a message to the agent to enable working memory.')}
          </Txt>
        )}
      </div>

      {isWorkingMemoryEnabled ? (
        <>
          {!isEditing ? (
            <>
              {workingMemoryData ? (
                <>
                  {workingMemoryData.trim().startsWith('{') ? (
                    <CodeDisplay
                      content={workingMemoryData || ''}
                      isCopied={isCopied}
                      onCopy={handleCopy}
                      className={cn(raisedSurfaceStyle, 'min-h-[150px] rounded-lg')}
                    />
                  ) : (
                    <>
                      <div className={cn(raisedSurfaceStyle, 'rounded-lg')} style={{ height: '300px' }}>
                        <ScrollArea className="h-full">
                          <div className="group relative cursor-pointer p-3 hover:bg-fill-subtle">
                            <button
                              type="button"
                              onClick={handleCopy}
                              aria-label={studioT('Copy working memory')}
                              className={cn('absolute inset-0 z-10 rounded-lg', focusRingInset)}
                            />
                            <div className="pointer-events-none">
                              <MarkdownRenderer>{workingMemoryData}</MarkdownRenderer>
                            </div>
                            {isCopied && (
                              <Txt
                                as="span"
                                variant="meta"
                                className="pointer-events-none absolute top-2 right-2 z-20 rounded-full bg-success-subtle px-1.5 py-0.5 text-success-subtle-foreground"
                              >
                                {studioT('Copied!')}
                              </Txt>
                            )}
                          </div>
                        </ScrollArea>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <Txt as="p" variant="body" tone="muted">
                  {studioT('No working memory content yet. Click "Edit working memory" to add content.')}
                </Txt>
              )}
            </>
          ) : (
            <CodeEditor
              aria-label={studioT('Working memory content')}
              language={editState.value.trim().startsWith('{') ? 'json' : 'markdown'}
              lineNumbers={false}
              showCopyButton={false}
              placeholder={studioT('Enter working memory content')}
              value={editState.value}
              onChange={value => setEditState(state => ({ ...state, value }))}
              editable={!isUpdating}
              className="min-h-[150px] w-full"
            />
          )}
          <div className="flex gap-2">
            {!isEditing ? (
              <>
                {!threadExists ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        icon={<IconPencil />}
                        type="button"
                        aria-disabled="true"
                        onClick={event => event.preventDefault()}
                        className="cursor-not-allowed opacity-50"
                      >
                        {studioT('Edit working memory')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{studioT('Working memory will be available after the agent calls updateWorkingMemory')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button icon={<IconPencil />} onClick={() => setIsEditing(true)} disabled={isUpdating}>
                    {studioT('Edit working memory')}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button
                  onClick={async () => {
                    try {
                      await updateWorkingMemory(editState.value);
                      setIsEditing(false);
                    } catch (error) {
                      console.error('Failed to update working memory:', error);
                      toast.error(studioT('Failed to update working memory'));
                    }
                  }}
                  loading={isUpdating}
                >
                  {studioT('Save changes')}
                </Button>
                <Button
                  icon={<IconCrossMedium />}
                  onClick={() => {
                    setEditState({ source: workingMemoryData, value: workingMemoryData ?? '' });
                    setIsEditing(false);
                  }}
                  disabled={isUpdating}
                >
                  {studioT('Cancel')}
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <div className={cn(raisedSurfaceStyle, 'rounded-lg p-4')}>
          <Txt tone="muted" className="mb-3">
            {studioT(
              'Working memory is not enabled for this agent. Enable it to maintain context across conversations.',
            )}
          </Txt>
          <a
            href="https://mastra.ai/en/docs/memory/working-memory"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center gap-2 text-info-indicator hover:underline',
              controlStateColorTransition,
            )}
          >
            <Txt as="span" variant="body" className="block">
              {studioT('Learn about working memory')}
            </Txt>
            <IconSquareArrowTopRight className="size-icon-xs" />
          </a>
        </div>
      )}
    </div>
  );
};
