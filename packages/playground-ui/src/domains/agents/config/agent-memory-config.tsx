import type { GetMemoryConfigResponse } from '@mastra/client-js';
import { useMemoryConfig } from '@mastra/react/hooks/memory';
import { z } from 'zod';
import { useEntityRequestContext } from '@/domains/request-context/hooks/use-entity-request-context';
import { Badge } from '@/ds/components/Badge';
import { Button } from '@/ds/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ds/components/Collapsible';
import { DisclosureChevron } from '@/ds/components/DisclosureChevron';
import { KeyValueList } from '@/ds/components/KeyValueList';
import { Skeleton } from '@/ds/components/Skeleton';
import { Txt } from '@/ds/components/Txt';
import { t as studioT } from '@/lib/i18n';

interface MemoryConfigSection {
  title: string;
  items: Array<{ label: string; value: string | number | boolean }>;
}

const recallDisplayValueSchema = z.union([z.string(), z.number()]).optional().catch('Unavailable');

const semanticRecallDisplaySchema = z.object({
  scope: recallDisplayValueSchema,
  topK: recallDisplayValueSchema,
  messageRange: z.union([
    z.object({ before: recallDisplayValueSchema, after: recallDisplayValueSchema }),
    recallDisplayValueSchema,
  ]),
});

function formatRecallMessageRange(messageRange: z.infer<typeof semanticRecallDisplaySchema>['messageRange']) {
  if (typeof messageRange === 'string') return messageRange;
  const before = typeof messageRange === 'object' ? messageRange.before : messageRange;
  const after = typeof messageRange === 'object' ? messageRange.after : messageRange;
  return `${before ?? 1} before, ${after ?? 1} after`;
}

function formatThreshold(threshold: number | { min: number; max: number } | undefined) {
  if (threshold === undefined) return 'Default';
  if (typeof threshold === 'number') return `${threshold.toLocaleString()} tokens`;
  return `${threshold.min.toLocaleString()}–${threshold.max.toLocaleString()} tokens`;
}

/** Which parts of the memory configuration a host can report; all are shown by default. */
export interface AgentMemoryConfigSupport {
  general?: boolean;
  semanticRecall?: boolean;
  observationalMemoryModels?: boolean;
}

function getMemorySections(
  config: NonNullable<GetMemoryConfigResponse['config']>,
  {
    general = true,
    semanticRecall: showSemanticRecall = true,
    observationalMemoryModels = true,
  }: AgentMemoryConfigSupport,
) {
  const sections: MemoryConfigSection[] = [];
  if (general)
    sections.push({
      title: studioT('General'),
      items: [
        { label: studioT('Status'), value: true },
        { label: studioT('Last Messages'), value: config.lastMessages ?? 'Default' },
        { label: studioT('Auto-generate Titles'), value: 'generateTitle' in config && Boolean(config.generateTitle) },
      ],
    });

  if (showSemanticRecall && config.semanticRecall) {
    const semanticRecall = semanticRecallDisplaySchema.safeParse(
      config.semanticRecall === true ? {} : config.semanticRecall,
    );
    if (semanticRecall.success) {
      sections.push({
        title: studioT('Semantic Recall'),
        items: [
          { label: studioT('Status'), value: true },
          { label: studioT('Scope'), value: semanticRecall.data.scope ?? 'resource' },
          { label: studioT('Top K Results'), value: semanticRecall.data.topK ?? 4 },
          { label: studioT('Message Range'), value: formatRecallMessageRange(semanticRecall.data.messageRange) },
        ],
      });
    } else {
      sections.push({
        title: studioT('Semantic Recall'),
        items: [{ label: studioT('Configuration'), value: 'Unavailable' }],
      });
    }
  }

  const observationalMemory = config.observationalMemory;
  if (observationalMemory?.enabled) {
    sections.push({
      title: studioT('Observational Memory'),
      items: [
        { label: studioT('Status'), value: true },
        { label: studioT('Scope'), value: observationalMemory.scope ?? 'thread' },
        { label: studioT('Message Tokens'), value: formatThreshold(observationalMemory.messageTokens) },
        { label: studioT('Observation Tokens'), value: formatThreshold(observationalMemory.observationTokens) },
        ...(observationalMemoryModels && observationalMemory.observationModel
          ? [{ label: studioT('Observation Model'), value: observationalMemory.observationModel }]
          : []),
        ...(observationalMemoryModels && observationalMemory.reflectionModel
          ? [{ label: studioT('Reflection Model'), value: observationalMemory.reflectionModel }]
          : []),
      ],
    });
  }

  return sections;
}

function formatMemoryValue(value: string | number | boolean) {
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
  return value;
}

function MemoryConfigFields({ items }: Pick<MemoryConfigSection, 'items'>) {
  return (
    <KeyValueList
      className="grid-cols-2"
      data={items.map(item => ({
        key: item.label,
        label: (
          <Txt as="span" variant="body-sm">
            {item.label}
          </Txt>
        ),
        value: (
          <Badge
            variant={item.value === true ? 'success' : 'neutral'}
            indicator={typeof item.value === 'boolean' ? 'dot' : undefined}
            className="h-auto min-h-5 min-w-0 break-words whitespace-normal"
          >
            {formatMemoryValue(item.value)}
          </Badge>
        ),
      }))}
    />
  );
}

export function AgentMemoryConfig({ agentId, support = {} }: { agentId: string; support?: AgentMemoryConfigSupport }) {
  const { data, isLoading, isError, isFetching, refetch } = useMemoryConfig({
    agentId: agentId,
    requestContext: useEntityRequestContext('agent', agentId)[0],
    queryOptions: { enabled: Boolean(agentId) },
  });

  if (isLoading) return <Skeleton className="h-28 w-full" />;

  if (isError && !data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <Txt variant="caption" tone="muted">
          {studioT('Unable to load memory configuration')}
        </Txt>
        <Button size="sm" loading={isFetching} onClick={() => void refetch()}>
          {studioT('Retry')}
        </Button>
      </div>
    );
  }

  if (!data?.config)
    return (
      <Txt variant="caption" tone="muted">
        {studioT('No memory configuration available')}
      </Txt>
    );

  return (
    <div className="flex flex-col gap-3">
      {getMemorySections(data.config, support).map(section =>
        section.title === 'General' ? (
          <MemoryConfigFields key={section.title} items={section.items} />
        ) : (
          <Collapsible
            key={section.title}
            defaultOpen={section.title !== 'Observational Memory' || support.general === false}
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
              <Txt as="span" variant="body-sm">
                {section.title}
              </Txt>
              <DisclosureChevron direction="right" className="size-4" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <MemoryConfigFields items={section.items} />
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </div>
  );
}
