import { EntityType, SpanType } from '@mastra/core/observability';
import type { SpanRecord, TraceSpanRecord } from '../types';
import { SpanPayloadJson } from './span-payload';
import { getSpanTools } from './span-payload/span-payload-registry';
import { SpanPromptChanges } from './span-prompt-changes';
import { getPromptChanges } from './span-prompt-impact';
import { PinnedKnowledgeActivity } from '@/domains/chat/knowledge/pinned-knowledge';
import { pinnedKnowledgeFromSignal } from '@/domains/chat/knowledge/pinned-knowledge-data';
import { isRecord, signalContentsToText } from '@/domains/chat/messages/signal-data';
import { KNOWLEDGE_TOOLS, knowledgeCard } from '@/domains/chat/tools/badges/knowledge-tool-badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ds/components/Collapsible';
import { DisclosureChevron } from '@/ds/components/DisclosureChevron';
import { Txt } from '@/ds/components/Txt';
import { t as studioT, useLocale } from '@/lib/i18n';

const inputProcessors = new Set<string>([EntityType.INPUT_PROCESSOR, EntityType.INPUT_STEP_PROCESSOR]);

function isAssemblyStage(span: TraceSpanRecord) {
  return (
    inputProcessors.has(span.entityType ?? '') ||
    (span.spanType === SpanType.MEMORY_OPERATION && span.attributes?.operationType === 'recall') ||
    span.spanType === SpanType.SKILL_ACTION ||
    span.spanType === SpanType.TOOL_CALL ||
    span.spanType === SpanType.MODEL_INFERENCE ||
    span.spanType === SpanType.AGENT_SIGNAL ||
    span.name === 'agent:prepare-tools' ||
    span.name === 'agent:load-thread' ||
    span.name === 'knowledge:pins' ||
    span.name === 'workspace:mount:instructions'
  );
}

function stagesFor(anchor: SpanRecord, spans: TraceSpanRecord[]) {
  const byId = new Map(spans.map(span => [span.spanId, span]));
  const ancestorsOf = (span: { parentSpanId?: string | null }) => {
    const ancestors: TraceSpanRecord[] = [];
    let parent = span.parentSpanId;
    while (parent && ancestors.length < 100) {
      const entry = byId.get(parent);
      if (!entry) break;
      ancestors.push(entry);
      parent = entry.parentSpanId;
    }
    return ancestors;
  };
  const parents = ancestorsOf(anchor);
  const run =
    anchor.spanType === SpanType.AGENT_RUN ? anchor : parents.find(span => span.spanType === SpanType.AGENT_RUN);
  if (!run) return [];
  const step =
    anchor.spanType === SpanType.MODEL_STEP ? anchor : parents.find(span => span.spanType === SpanType.MODEL_STEP);

  const isInference = anchor.spanType === SpanType.MODEL_INFERENCE;
  return spans
    .filter(span => {
      if (span.spanId === anchor.spanId || !isAssemblyStage(span)) return false;
      const ancestors = ancestorsOf(span);
      if (ancestors.find(parent => parent.spanType === SpanType.AGENT_RUN)?.spanId !== run.spanId) return false;
      if (!step) return true;
      const enclosingStep = ancestors.find(parent => parent.spanType === SpanType.MODEL_STEP);
      if (isInference && ancestors.some(parent => parent.spanId === anchor.spanId)) return true;
      if (enclosingStep?.spanId === step.spanId) {
        if (!isInference) return true;
        if (span.spanType === SpanType.MODEL_INFERENCE) return false;
        return +new Date(span.startedAt) <= +new Date(anchor.startedAt);
      }
      if (enclosingStep && span.spanType !== SpanType.TOOL_CALL && span.spanType !== SpanType.SKILL_ACTION)
        return false;
      return span.endedAt != null && +new Date(span.endedAt) <= +new Date(step.startedAt);
    })
    .sort((a, b) => +new Date(a.startedAt) - +new Date(b.startedAt));
}

function AssemblyStage({ span }: { span: TraceSpanRecord }) {
  const hasChanges = getPromptChanges(span).length > 0;
  const details = span.metadata?.semanticRecall ?? span.metadata?.modelHubRequest;
  const tools = span.spanType === SpanType.MODEL_INFERENCE ? getSpanTools(span)?.tools : undefined;
  const showPayload = span.spanType !== SpanType.MODEL_INFERENCE && span.output != null;
  const showInput =
    span.spanType === SpanType.TOOL_CALL ||
    (span.spanType === SpanType.SKILL_ACTION && !hasChanges && !span.entityType);
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left">
          <DisclosureChevron direction="right" className="size-3" />
          <Txt as="span" variant="body-sm" className="min-w-0 break-words">
            {span.name}
          </Txt>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid min-w-0 gap-2 pb-2 pl-5">
          {details != null && <SpanPayloadJson value={details} foldNested />}
          {!!tools?.length && (
            <>
              <Txt variant="label">{studioT('Tools sent to the model')}</Txt>
              <SpanPayloadJson value={tools.map(tool => tool.id)} />
            </>
          )}
          {hasChanges && <SpanPromptChanges span={span} showContext={false} />}
          {showInput && span.input != null && (
            <>
              <Txt variant="label">{studioT('Input')}</Txt>
              <SpanPayloadJson value={span.input} foldNested />
            </>
          )}
          {span.name === 'knowledge:pins' ? (
            <SpanKnowledgeTrace span={span} />
          ) : (
            !hasChanges && showPayload && <SpanPayloadJson value={span.output} foldNested />
          )}
          {!hasChanges && !showPayload && details == null && !showInput && !tools?.length && (
            <Txt variant="body-sm" tone="muted">
              {studioT('No assembly details recorded.')}
            </Txt>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function knowledgeToolName(span: TraceSpanRecord): string | undefined {
  if (span.spanType !== SpanType.TOOL_CALL) return;
  return [span.entityId, span.entityName, span.attributes?.toolId, span.name.replace(/^tool:\s*/, '')].find(
    (name): name is string => typeof name === 'string' && KNOWLEDGE_TOOLS.has(name),
  );
}

function legacyPinnedContent(spans: TraceSpanRecord[]): string[] {
  const inference = spans.find(span => span.spanType === SpanType.MODEL_INFERENCE && Array.isArray(span.input));
  if (!inference || !Array.isArray(inference.input)) return [];
  return inference.input.flatMap(message => {
    if (!isRecord(message) || message.role !== 'user') return [];
    const text = signalContentsToText(message.content).trim();
    return /^<pinned-knowledge(?:-update)?\b[^>]*>/.test(text) && /<\/pinned-knowledge(?:-update)?>$/.test(text)
      ? [text]
      : [];
  });
}

export function SpanKnowledgeTrace({ span, traceSpans }: { span: SpanRecord; traceSpans?: TraceSpanRecord[] }) {
  useLocale();
  const isPins = span.name === 'knowledge:pins';
  if (!isPins && span.entityId !== 'knowledge' && span.name !== 'knowledge') return null;

  const byId = new Map(traceSpans?.map(candidate => [candidate.spanId, candidate]));
  const nearestRun = (candidate: SpanRecord) => {
    for (let current: SpanRecord | undefined = candidate, depth = 0; current && depth < 100; depth++) {
      if (current.spanType === SpanType.AGENT_RUN) return current.spanId;
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
  };
  const run = nearestRun(span);
  const related = run ? (traceSpans ?? []).filter(candidate => nearestRun(candidate) === run) : [];
  const pinChecks = isPins ? [span] : related.filter(candidate => candidate.name === 'knowledge:pins');
  const toolCalls = related.flatMap(candidate => {
    const name = knowledgeToolName(candidate);
    return name ? [{ name, candidate }] : [];
  });
  const legacyContent = !isPins && pinChecks.length === 0 ? legacyPinnedContent(related) : [];

  return (
    <section className="grid min-w-0 gap-2" aria-label={studioT('Knowledge in this run')}>
      <Txt as="h3" variant="label">
        {studioT('Knowledge in this run')}
      </Txt>
      {pinChecks.map(check => {
        if (!isRecord(check.output)) return null;
        const { pins, delivery, stepNumber } = check.output;
        const pinned = pinnedKnowledgeFromSignal({ tagName: 'pinned-knowledge', metadata: { value: { pins } } });
        if (!pinned) return null;
        return (
          <div key={check.spanId} className="min-w-0">
            <div className="flex flex-wrap gap-x-2">
              <Txt as="span" variant="meta" tone="muted">
                {studioT('Step {value0}', { value0: String(stepNumber) })}
              </Txt>
              <Txt as="span" variant="meta" tone="muted">
                {delivery === 'retained'
                  ? studioT('Retained from earlier context')
                  : delivery === 'empty'
                    ? studioT('No pinned pages delivered')
                    : studioT('Pinned pages projected')}
              </Txt>
            </div>
            <PinnedKnowledgeActivity pinned={pinned} defaultOpen />
          </div>
        );
      })}
      {legacyContent.map((text, index) => (
        <details key={index} className="min-w-0">
          <summary className="cursor-pointer">{studioT('Pinned text in the model input')}</summary>
          <pre className="break-words whitespace-pre-wrap">{text}</pre>
        </details>
      ))}
      {toolCalls.map(({ name, candidate }) => {
        const errorMessage =
          isRecord(candidate.error) && typeof candidate.error.message === 'string'
            ? candidate.error.message
            : undefined;
        const card = knowledgeCard(name, candidate.input, candidate.output, errorMessage);
        return (
          <details key={candidate.spanId} className="min-w-0">
            <summary className="cursor-pointer break-words">
              <span className="inline-flex flex-wrap gap-x-2">
                <span>{card?.title ?? name}</span>
                {card?.detail && (
                  <Txt as="span" variant="meta" tone="muted">
                    {card.detail}
                  </Txt>
                )}
              </span>
            </summary>
            {card?.body}
            {candidate.input != null && <SpanPayloadJson value={candidate.input} foldNested />}
            {candidate.output != null && <SpanPayloadJson value={candidate.output} foldNested />}
          </details>
        );
      })}
      {pinChecks.length === 0 && legacyContent.length === 0 && toolCalls.length === 0 && (
        <Txt variant="body-sm" tone="muted">
          {studioT('No knowledge pages recorded for this run.')}
        </Txt>
      )}
    </section>
  );
}

export function SpanPromptAssembly({ anchor, spans }: { anchor: SpanRecord; spans: TraceSpanRecord[] }) {
  useLocale();
  const stages = stagesFor(anchor, spans);
  if (stages.length === 0) return null;
  return (
    <section aria-label={studioT('Prompt assembly')} className="grid min-w-0 gap-2">
      <Txt as="h3" variant="label">
        {studioT('Prompt assembly')}
      </Txt>
      <ol className="min-w-0 list-none divide-y divide-border">
        {stages.map(span => (
          <AssemblyStage key={span.spanId} span={span} />
        ))}
      </ol>
    </section>
  );
}
