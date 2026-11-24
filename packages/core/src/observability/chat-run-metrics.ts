interface ChatSpan {
  spanId: string;
  parentSpanId?: string | null;
  spanType: string;
  startedAt?: unknown;
  endedAt?: unknown;
  attributes?: unknown;
  metadata?: unknown;
  status?: string | null;
  outcome?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ModelUsage {
  route?: string;
  input?: number;
  output?: number;
  uncached?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface ContextReading {
  sampledAt: number;
  route?: string;
  usedTokens: number;
  outputTokens?: number;
  breakdown?: { system: number; tools: number; messages: number };
}

export interface RunMetrics {
  traceId: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  steps: number;
  models: ModelUsage[];
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  context?: ContextReading;
  decodeMs: number;
  decodeTokens: number;
}

export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function instant(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== 'string') return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function modelUsage(span: ChatSpan): ModelUsage {
  const attributes = isRecord(span.attributes) ? span.attributes : {};
  const usage = isRecord(attributes.usage) ? attributes.usage : {};
  const inputDetails = isRecord(usage.inputDetails) ? usage.inputDetails : {};
  const outputDetails = isRecord(usage.outputDetails) ? usage.outputDetails : {};
  const model = typeof attributes.model === 'string' ? attributes.model : undefined;
  const provider =
    typeof attributes.provider === 'string'
      ? attributes.provider.replace(/\.(chat|responses|completion)$/, '')
      : undefined;
  return {
    route: provider && model ? `${provider}/${model}` : model,
    input: count(usage.inputTokens),
    output: count(usage.outputTokens),
    uncached: count(inputDetails.text),
    cacheRead: count(inputDetails.cacheRead),
    cacheWrite: count(inputDetails.cacheWrite),
    reasoning: count(outputDetails.reasoning),
  };
}

/** Only leaf provider calls count. Generation/step ancestors repeat their children's usage. */
function usageSpans(spans: ChatSpan[]): ChatSpan[] {
  const parentsWithInference = new Set<string>();
  const byId = new Map(spans.map(span => [span.spanId, span]));
  for (const span of spans) {
    if (span.spanType !== 'model_inference') continue;
    const visited = new Set<string>();
    let parent = span.parentSpanId;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      parentsWithInference.add(parent);
      parent = byId.get(parent)?.parentSpanId;
    }
  }
  return spans.filter(
    span =>
      span.spanType === 'model_inference' ||
      (span.spanType === 'model_generation' && !parentsWithInference.has(span.spanId)),
  );
}

/** Adapt DSH's turn accounting and decode-only throughput to Mastra's durable trace records. */
export function projectRunMetrics(trace: { traceId: string; spans: readonly ChatSpan[] }): RunMetrics {
  const spans = [...new Map(trace.spans.map(span => [span.spanId, span])).values()];
  const root = spans.find(span => span.parentSpanId === null && span.spanType === 'agent_run');
  const calls = usageSpans(spans);
  const main = mainLoopSpans(spans, root);
  const mainCalls = calls.filter(span => main.has(span.spanId));
  const stepSpans = spans.filter(span => main.has(span.spanId) && span.spanType === 'model_step');
  const steps = stepSpans.length
    ? new Set(
        stepSpans
          .filter(span => instant(span.endedAt) !== undefined)
          .map(span => {
            const index = isRecord(span.attributes) ? count(span.attributes.stepIndex) : undefined;
            return index === undefined ? span.spanId : String(index);
          }),
      ).size
    : mainCalls.filter(span => instant(span.endedAt) !== undefined).length;
  let llmMs = 0;
  let toolMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  for (const span of mainCalls) {
    const start = instant(span.startedAt);
    const end = instant(span.endedAt);
    if (start !== undefined && end !== undefined) llmMs += Math.max(0, end - start);
    const attributes = isRecord(span.attributes) ? span.attributes : {};
    const first = instant(attributes.completionStartTime);
    if (start !== undefined && first !== undefined && first >= start) {
      ttftMs += first - start;
      ttftSteps++;
    }
  }
  for (const span of spans) {
    if (span.spanType !== 'tool_call' || !main.has(span.spanId)) continue;
    const start = instant(span.startedAt);
    const end = instant(span.endedAt);
    if (start !== undefined && end !== undefined) toolMs += Math.max(0, end - start);
  }
  let decodeMs = 0;
  let decodeTokens = 0;
  for (const span of mainCalls) {
    if (span.spanType !== 'model_inference') continue;
    const attributes = isRecord(span.attributes) ? span.attributes : {};
    const first = instant(attributes.completionStartTime);
    const end = instant(span.endedAt);
    const output = modelUsage(span).output;
    if (first === undefined || end === undefined || end <= first || output === undefined) continue;
    decodeMs += end - first;
    decodeTokens += output;
  }
  const attributes = isRecord(root?.attributes) ? root.attributes : {};
  return {
    traceId: trace.traceId,
    startedAt: instant(root?.startedAt),
    endedAt: instant(root?.endedAt),
    outcome:
      typeof root?.outcome === 'string'
        ? root.outcome
        : typeof attributes.finishReason === 'string'
          ? attributes.finishReason
          : (root?.status ?? undefined),
    steps,
    models: calls.map(modelUsage),
    llmMs,
    toolMs,
    ttftMs,
    ttftSteps,
    context: contextReading(mainCalls, spans),
    decodeMs,
    decodeTokens,
  };
}

/** Main-loop lifecycle only; sidecars remain billable but cannot create turns or steps. */
function mainLoopSpans(spans: ChatSpan[], root?: ChatSpan): Set<string> {
  const attributes = isRecord(root?.attributes) ? root.attributes : {};
  const firstChunk = instant(attributes.completionStartTime);
  const generations = spans.filter(span => span.spanType === 'model_generation');
  const generation =
    generations.find(
      span => isRecord(span.metadata) && span.metadata.agentMainLoop === true && span.parentSpanId === root?.spanId,
    ) ??
    (firstChunk === undefined
      ? undefined
      : generations.find(
          span => isRecord(span.attributes) && instant(span.attributes.completionStartTime) === firstChunk,
        )) ??
    generations
      .filter(span => span.parentSpanId === root?.spanId)
      .sort((a, b) => (instant(a.startedAt) ?? 0) - (instant(b.startedAt) ?? 0))[0];
  const byId = new Map(spans.map(span => [span.spanId, span]));
  return new Set(
    spans
      .filter(span => {
        const visited = new Set<string>();
        let current: ChatSpan | undefined = span;
        while (current && !visited.has(current.spanId)) {
          visited.add(current.spanId);
          if (isRecord(current.metadata) && current.metadata.auxiliary) return false;
          if (current.spanType === 'model_generation') return current.spanId === generation?.spanId;
          if (current.spanType === 'agent_run') return !generation && current.spanId === root?.spanId;
          current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
        }
        return false;
      })
      .map(span => span.spanId),
  );
}

/** Provider occupancy and separately labelled server estimates for that same request. */
function contextReading(calls: ChatSpan[], spans: ChatSpan[]): ContextReading | undefined {
  const latest = [...calls].sort((a, b) => (instant(b.startedAt) ?? 0) - (instant(a.startedAt) ?? 0))[0];
  if (!latest) return undefined;
  const usage = modelUsage(latest);
  const sampledAt = instant(latest.startedAt);
  if (sampledAt === undefined || usage.input === undefined) return undefined;
  const byId = new Map(spans.map(span => [span.spanId, span]));
  const visited = new Set<string>();
  let current: ChatSpan | undefined = latest;
  let breakdown: ContextReading['breakdown'];
  while (current && !visited.has(current.spanId)) {
    visited.add(current.spanId);
    const value = isRecord(current.metadata) ? current.metadata.contextBreakdown : undefined;
    if (isRecord(value) && value.method === 'mastra-token-counter') {
      const system = count(value.system);
      const tools = count(value.tools);
      const messages = count(value.messages);
      if (system !== undefined && tools !== undefined && messages !== undefined)
        breakdown = { system, tools, messages };
      break;
    }
    // Never borrow estimates from another request in this generation.
    if (current.spanType === 'model_step') break;
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return { sampledAt, route: usage.route, usedTokens: usage.input, outputTokens: usage.output, breakdown };
}
