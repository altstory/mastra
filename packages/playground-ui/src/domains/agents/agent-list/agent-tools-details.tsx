import type { GetAgentResponse } from '@mastra/client-js';
import { useId } from 'react';
import { Button } from '@/ds/components/Button';
import { CardDescription, CardTitle } from '@/ds/components/Card';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ds/components/HoverCard';
import { Txt } from '@/ds/components/Txt';
import { ToolsIcon } from '@/ds/icons/ToolsIcon';
import { t as studioT, useLocale } from '@/lib/i18n';

export interface AgentToolsDetailsProps {
  agentName: string;
  tools?: GetAgentResponse['tools'];
}

function formatToolCount(count: number) {
  return `${count} tool${count === 1 ? '' : 's'}`;
}

export function AgentToolsDetails({ agentName, tools }: AgentToolsDetailsProps) {
  useLocale();
  const titleId = useId();
  const toolEntries = Object.entries(tools ?? {});

  if (toolEntries.length === 0) return null;

  const toolCount = formatToolCount(toolEntries.length);

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={0}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto"
            aria-label={studioT('Show {value0} for {value1}', { value0: toolCount, value1: agentName })}
            icon={<ToolsIcon aria-hidden="true" />}
          >
            <span>{toolEntries.length}</span>
          </Button>
        }
      />
      <HoverCardContent
        role="dialog"
        aria-labelledby={titleId}
        side="top"
        align="center"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <div className="grid gap-3">
          <CardTitle id={titleId}>{studioT('Tools')}</CardTitle>
          <ul
            aria-label={studioT('Configured tools for {value0}', { value0: agentName })}
            className="grid max-h-64 gap-3 overflow-y-auto"
            tabIndex={0}
          >
            {toolEntries.map(([toolKey, tool]) => (
              <li key={toolKey} className="grid gap-1">
                <Txt as="span" variant="column" tone="ink" className="overflow-wrap-anywhere">
                  {tool.id || toolKey}
                </Txt>
                {tool.description ? (
                  <CardDescription className="overflow-wrap-anywhere">{tool.description}</CardDescription>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
