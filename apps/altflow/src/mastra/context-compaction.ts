// DSH pressure/retention/checkpoint semantics adapted to Mastra processor hooks.
// Full transcript stays in memory storage; only the provider prompt is projected.
// See THIRD_PARTY_NOTICES.md for attribution and license.
import { createHash } from 'node:crypto';
import { convertMessages } from '@mastra/core/agent/message-list';
import { SpanType } from '@mastra/core/observability';
import type {
  Processor,
  ProcessInputStepArgs,
  ProcessLLMRequestArgs,
  ProcessOutputStepArgs,
  ProcessAPIErrorArgs,
  ProcessLLMResponseArgs,
} from '@mastra/core/processors';
import { isStandardSchemaWithJSON, standardSchemaToJSONSchema } from '@mastra/core/schema';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { TokenCounter } from '@mastra/memory/processors';
import { z } from 'zod';
import { CHECKPOINT_PREAMBLE, COMPACTION_INSTRUCTION } from './compaction-prompt.ts';
import { contextPolicy } from './context-policy.ts';
import type { ModelHubGateway } from './modelhub-gateway.ts';

type ProviderPrompt = Parameters<
  Awaited<ReturnType<ModelHubGateway['resolveLanguageModel']>>['doGenerate']
>[0]['prompt'];
type Prompt = ProcessLLMRequestArgs['prompt'];
type Message = Prompt[number];
type Json = Extract<Extract<Message, { role: 'tool' }>['content'][number]['output'], { type: 'json' }>['value'];
const routeSchema = z.object({
  modelId: z.string(),
  level: z.string().optional(),
});
const checkpointSchema = z.object({
  version: z.number().int().positive(),
  covered: z.number().int().positive(),
  digest: z.string(),
  summary: z.string().min(1),
});
const savedSchema = z.object({
  checkpoint: checkpointSchema.optional(),
  lastRoute: routeSchema.optional(),
  measurement: z
    .object({
      route: z.string(),
      input: z.number().nonnegative(),
      estimate: z.number().nonnegative(),
      epoch: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
const key = 'dshContext';
const recordSchema = z.record(z.string(), z.unknown());
const record = (value: unknown) => recordSchema.safeParse(value).data ?? {};
const fingerprint = (messages: Prompt) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');
const checkpointMessage = (summary: string): Message => ({
  role: 'user',
  content: [
    {
      type: 'text',
      text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary}\n</compacted-summary>`,
    },
  ],
});

// DSH text pricing (4 chars/token, 4 tokens/block and role), with Mastra's
// multimodal estimator for attachments. Encoded bytes are not model text.
// This internal admission estimate is never used for the displayed context occupancy.
function price(message: Message, counter: TokenCounter): number {
  const attachment = (part: Extract<Extract<Message, { role: 'user' }>['content'][number], { type: 'file' }>) =>
    counter.countMessages(convertMessages([{ role: 'user', content: [part] }]).to('Mastra.V2'));
  if (typeof message.content === 'string') return 4 + Math.ceil(message.content.length / 4);
  return (
    4 +
    message.content.reduce((sum, block) => {
      if ('text' in block && typeof block.text === 'string') return sum + 4 + Math.ceil(block.text.length / 4);
      // Provider prompts normalize both image uploads and file uploads to file blocks.
      if (block.type === 'file') return sum + attachment(block);
      // mastra.modelOutput is a stored copy of the mapped result, carried on
      // both tool parts. Provider options are not model-visible text.
      if (block.type === 'tool-call')
        return sum + 4 + Math.ceil(JSON.stringify({ toolName: block.toolName, input: block.input }).length / 4);
      if (block.type === 'tool-result' && block.output.type === 'content') {
        const framing = { toolName: block.toolName, output: { type: block.output.type } };
        return (
          sum +
          4 +
          Math.ceil(JSON.stringify(framing).length / 4) +
          block.output.value.reduce(
            (tokens, part) =>
              tokens +
              (part.type === 'text'
                ? 4 + Math.ceil(part.text.length / 4)
                : attachment({ type: 'file', data: part.data, mediaType: part.mediaType })),
            0,
          )
        );
      }
      if (block.type === 'tool-result')
        return sum + 4 + Math.ceil(JSON.stringify({ toolName: block.toolName, output: block.output }).length / 4);
      return sum + 4 + Math.ceil(JSON.stringify(block).length / 4);
    }, 0)
  );
}
const pricePrompt = (prompt: Prompt, counter: TokenCounter) =>
  prompt.reduce((sum, message) => sum + price(message, counter), 0);

function pruneValue(value: Json): Json {
  if (typeof value === 'string') {
    const chars = Array.from(value);
    return chars.length > 8192
      ? `${chars.slice(0, 4096).join('')}\n\n[... tool result middle pruned ...]\n\n${chars.slice(-1024).join('')}`
      : value;
  }
  if (Array.isArray(value)) return value.map(pruneValue);
  if (value && typeof value === 'object') {
    if (['media', 'image', 'file', 'file-data', 'image-data'].includes(String(value.type))) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        item === undefined || ['data', 'url', 'base64'].includes(name) ? item : pruneValue(item),
      ]),
    );
  }
  return value;
}
function pruneTools(prompt: Prompt): Prompt {
  return prompt.map(message => {
    if (message.role !== 'tool') return message;
    return {
      ...message,
      content: message.content.map(block => {
        if (block.output.type === 'text')
          return {
            ...block,
            output: {
              ...block.output,
              value: String(pruneValue(block.output.value)),
            },
          };
        if (block.output.type === 'content')
          return {
            ...block,
            output: {
              ...block.output,
              value: block.output.value.map(part =>
                part.type === 'text' ? { ...part, text: String(pruneValue(part.text)) } : part,
              ),
            },
          };
        if (block.output.type === 'json')
          return {
            ...block,
            output: { ...block.output, value: pruneValue(block.output.value) },
          };
        return block;
      }),
    };
  });
}

function selectCut(
  messages: Prompt,
  latestUser: Message | undefined,
  syntheticCount: number,
  retain: number,
  force: boolean,
  budget: number,
  counter: TokenCounter,
) {
  const userIndex = latestUser ? messages.lastIndexOf(latestUser) : -1;
  const costs = messages.map(message => price(message, counter));
  let cut = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    cut = i;
    tokens += costs[i];
    if (tokens >= retain || force) break;
  }

  const normalCut = userIndex >= syntheticCount ? Math.min(cut, userIndex) : cut;
  const checkpointReserve = Math.min(retain / 4, 4096);
  const open = new Set<string>();
  let tailCost = costs.reduce((total, cost) => total + cost, 0);
  let beforeUser: number | undefined;
  let relaxed: number | undefined;
  for (let i = 0; i < cut; i++) {
    const message = messages[i];
    tailCost -= costs[i];
    if (typeof message.content !== 'string')
      for (const block of message.content) {
        if (block.type === 'tool-call') open.add(block.toolCallId);
        if (block.type === 'tool-result') open.delete(block.toolCallId);
      }
    const boundary = i + 1;
    if (open.size || boundary <= syntheticCount || boundary === userIndex + 1) continue;
    const carriedUserCost = userIndex >= 0 && userIndex < boundary ? costs[userIndex] : 0;
    if (tailCost + carriedUserCost + checkpointReserve > budget) continue;
    if (boundary <= normalCut) beforeUser = boundary;
    // When a long tool loop uses the remaining budget on its own, compact
    // complete exchanges from this turn and carry the user's request verbatim.
    relaxed = boundary;
  }
  return beforeUser ?? relaxed;
}

function providerPrompt(prompt: Prompt): ProviderPrompt {
  const output = (value: Extract<Message, { role: 'tool' }>['content'][number]['output']) => {
    if (value.type !== 'content') return value;
    return {
      ...value,
      value: value.value.map(block =>
        block.type === 'media'
          ? {
              type: 'file-data' as const,
              data: block.data,
              mediaType: block.mediaType,
            }
          : block,
      ),
    };
  };
  return prompt.map(message => {
    if (message.role === 'tool')
      return {
        ...message,
        content: message.content.map(block => ({
          ...block,
          output: output(block.output),
        })),
      };
    if (message.role === 'assistant')
      return {
        ...message,
        content: message.content.map(block =>
          block.type === 'tool-result' ? { ...block, output: output(block.output) } : block,
        ),
      };
    return message;
  });
}

export class ContextCompaction implements Processor {
  readonly id = 'context-compaction';
  readonly name = 'Context checkpoint compaction';
  #gateway: ModelHubGateway;
  #storage: MastraCompositeStore;
  #contexts = new WeakMap<Record<string, unknown>, ProcessInputStepArgs>();
  constructor(options: { gateway: ModelHubGateway; storage: MastraCompositeStore }) {
    this.#gateway = options.gateway;
    this.#storage = options.storage;
  }
  processInputStep(args: ProcessInputStepArgs) {
    this.#contexts.set(args.state, args);
    return {
      modelSettings: {
        ...args.modelSettings,
        maxOutputTokens: Math.min(args.modelSettings?.maxOutputTokens ?? 8192, 8192),
      },
    };
  }
  async #scope(args: ProcessLLMRequestArgs | ProcessOutputStepArgs | ProcessLLMResponseArgs) {
    const list = 'messageList' in args ? args.messageList : this.#contexts.get(args.state)?.messageList;
    const info = list?.serialize().memoryInfo;
    if (!info?.threadId || !info.resourceId) throw new Error('Context compaction requires an owned memory thread');
    const store = await this.#storage.getStore('memory');
    if (!store) throw new Error('Context checkpoint storage is unavailable');
    const thread = await store.getThreadById({
      threadId: info.threadId,
      resourceId: info.resourceId,
    });
    if (!thread || thread.resourceId !== info.resourceId)
      throw new Error('Context checkpoint thread ownership mismatch');
    const parsed = savedSchema.safeParse(thread.metadata?.[key]);
    return { store, thread, saved: parsed.success ? parsed.data : {} };
  }
  async #route(args: ProcessLLMRequestArgs | ProcessOutputStepArgs | ProcessLLMResponseArgs) {
    const context = this.#contexts.get(args.state);
    const catalog = await this.#gateway.catalog();
    const product = catalog.free_chat_models.find(
      product => product.id === ('model' in args ? args.model : context?.model)?.modelId,
    );
    if (!product) throw new Error('Context model is not in the ModelHub catalog');
    const level = record(context?.providerOptions?.altflow).reasoningLevel;
    const option = product.thinking_options.find(option => option.level === (level ?? product.default_thinking_level));
    if (!option) throw new Error('Unsupported context reasoning route');
    const capacity = (await this.#gateway.modelInfo())[option.target];
    return {
      modelId: product.id,
      level: option.level,
      policy: contextPolicy(capacity),
    };
  }
  #tools(args: ProcessLLMRequestArgs) {
    const context = this.#contexts.get(args.state);
    return Object.entries(context?.tools ?? {}).map(([name, value]) => {
      const tool = record(value);
      const schema = tool.inputSchema ?? tool.parameters;
      const inputSchema = isStandardSchemaWithJSON(schema)
        ? standardSchemaToJSONSchema(schema)
        : (record(schema).jsonSchema ?? schema);
      return {
        type: 'function' as const,
        name,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: record(inputSchema),
      };
    });
  }
  async processLLMRequest(args: ProcessLLMRequestArgs) {
    const { store, thread, saved } = await this.#scope(args);
    const route = await this.#route(args);
    const routeKey = `${route.modelId}/${route.level}`;
    const tools = this.#tools(args);
    const overhead = tools.length ? Math.ceil(JSON.stringify(tools).length / 4) + 4 : 0;
    const system = args.prompt.filter(message => message.role === 'system');
    const original = args.prompt.filter(message => message.role !== 'system');
    const previous = saved.checkpoint;
    const applied =
      previous &&
      original.length >= previous.covered &&
      fingerprint(original.slice(0, previous.covered)) === previous.digest;
    let userIndex = original.length - 1;
    while (userIndex >= 0 && original[userIndex].role !== 'user') userIndex--;
    const latestUser = userIndex >= 0 ? original[userIndex] : undefined;
    const synthetic: Prompt = applied
      ? [checkpointMessage(previous.summary), ...(latestUser && userIndex < previous.covered ? [latestUser] : [])]
      : [];
    let messages = applied ? [...synthetic, ...original.slice(previous.covered)] : original;
    let prompt = [...system, ...messages];
    const inputLimit = route.policy.window - route.policy.output;
    const counter = new TokenCounter({ model: { provider: args.apiProviderId, modelId: route.modelId } });
    const estimate = () => pricePrompt(prompt, counter) + overhead;
    const measurement = saved.measurement;
    const correction =
      measurement?.route === routeKey && measurement.epoch === (applied ? previous.version : 0)
        ? Math.max(0, measurement.input - measurement.estimate)
        : 0;
    const pressure = () => estimate() + correction;
    const force = args.state.forceCompaction === true;
    args.state.forceCompaction = false;
    if (force || pressure() >= route.policy.threshold) {
      prompt = pruneTools(prompt);
      messages = prompt.filter(message => message.role !== 'system');
      if (force || pressure() >= route.policy.threshold) {
        const budget = route.policy.threshold - pricePrompt(system, counter) - overhead;
        // The previous measurement is useful when choosing how much to cut.
        // A large overage may disappear with the history being replaced.
        const cut =
          selectCut(messages, latestUser, synthetic.length, route.policy.retain, force, budget - correction, counter) ??
          selectCut(messages, latestUser, synthetic.length, route.policy.retain, force, budget, counter);
        if (cut !== undefined) {
          const covered = (applied ? previous.covered : 0) + cut - synthetic.length;
          const prefix = messages.slice(0, cut);
          const tail = [...(latestUser && userIndex < covered ? [latestUser] : []), ...messages.slice(cut)];
          const tailBudget = budget - pricePrompt(tail, counter);
          const checkpointFrame = price(checkpointMessage(''), counter);
          const removedCost =
            pricePrompt(prefix, counter) - (latestUser && userIndex < covered ? price(latestUser, counter) : 0);
          const catalog = await this.#gateway.catalog();
          const lastRoute = saved.lastRoute;
          const lastProduct = catalog.free_chat_models.find(product => product.id === lastRoute?.modelId);
          // A persisted conversation can outlive a deployment's model policy.
          const summaryRoute =
            lastRoute &&
            lastProduct &&
            (!lastRoute.level || lastProduct.thinking_options.some(option => option.level === lastRoute.level))
              ? lastRoute
              : route;
          const model = await this.#gateway.resolveSummaryModel(summaryRoute.modelId);
          const summaryProduct = catalog.free_chat_models.find(product => product.id === summaryRoute.modelId);
          const summaryTarget = summaryProduct?.thinking_options.find(
            option => option.level === summaryRoute.level,
          )?.target;
          const summaryCapacity = summaryTarget ? (await this.#gateway.modelInfo())[summaryTarget] : undefined;
          const summaryWindow = contextPolicy(summaryCapacity).window;
          let summary: string | undefined;
          let summaryLimit = Math.max(1, Math.min(tailBudget - checkpointFrame - 1, Math.floor(removedCost / 2), 8192));
          for (let attempt = 0; attempt < 2; attempt++) {
            args.abortSignal?.throwIfAborted();
            const span = args.tracingContext?.currentSpan?.createChildSpan({
              name: 'Context checkpoint summary',
              type: SpanType.MODEL_INFERENCE,
              attributes: { model: summaryRoute.modelId, provider: 'altflow' },
              metadata: { auxiliary: 'compaction' },
            });
            try {
              const summaryPrompt: Prompt = [
                ...system,
                ...prefix,
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: `${COMPACTION_INSTRUCTION}\n- Limit the checkpoint to ${summaryLimit} tokens. Prioritize facts needed for the next step.`,
                    },
                  ],
                },
              ];
              const summaryOutput = Math.min(65536, summaryWindow - pricePrompt(summaryPrompt, counter) - overhead);
              if (summaryOutput <= 0) throw new Error('Summary request exceeds its source model capacity');
              const result = await model.doGenerate({
                prompt: providerPrompt(summaryPrompt),
                tools,
                toolChoice: { type: 'none' },
                maxOutputTokens: summaryOutput,
                providerOptions: {
                  altflow: {
                    reasoningLevel: summaryRoute.level ?? route.level,
                  },
                },
                abortSignal: args.abortSignal,
              });
              span?.end({
                attributes: {
                  usage: {
                    inputTokens: result.usage.inputTokens.total,
                    outputTokens: result.usage.outputTokens.total,
                    inputDetails: {
                      text: result.usage.inputTokens.noCache,
                      cacheRead: result.usage.inputTokens.cacheRead,
                      cacheWrite: result.usage.inputTokens.cacheWrite,
                    },
                    outputDetails: {
                      text: result.usage.outputTokens.text,
                      reasoning: result.usage.outputTokens.reasoning,
                    },
                  },
                },
              });
              const text = result.content
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('')
                .trim();
              const replacement = checkpointMessage(text);
              if (result.finishReason.unified !== 'stop' || !text) continue;
              if (price(replacement, counter) >= Math.min(removedCost, tailBudget)) {
                summaryLimit = Math.max(1, Math.floor(summaryLimit / 2));
                continue;
              }
              summary = text;
              break;
            } catch (error) {
              span?.error({
                error: error instanceof Error ? error : new Error('Checkpoint summary failed'),
              });
              args.abortSignal?.throwIfAborted();
            }
          }
          if (summary) {
            args.abortSignal?.throwIfAborted();
            const checkpoint = {
              version: (previous?.version ?? 0) + 1,
              covered,
              digest: fingerprint(original.slice(0, covered)),
              summary,
            };
            await store.updateThreadMetadata({
              id: thread.id,
              resourceId: thread.resourceId,
              update: current => {
                args.abortSignal?.throwIfAborted();
                const latest = savedSchema.safeParse(current.metadata?.[key]).data;
                if ((latest?.checkpoint?.version ?? 0) !== (previous?.version ?? 0))
                  throw new Error('Context changed while compacting');
                return {
                  ...current.metadata,
                  [key]: { ...latest, checkpoint, measurement: undefined },
                };
              },
            });
            prompt = [...system, checkpointMessage(summary), ...tail];
            await args.sendSignal?.({
              type: 'reactive',
              tagName: 'system-reminder',
              contents: 'Earlier conversation has been compacted into a checkpoint.',
              metadata: {
                type: 'context-compaction',
                message: '已压缩早期上下文',
              },
            });
          } else if (force || pressure() >= inputLimit) {
            throw new Error('Context could not be compacted safely below the pressure threshold');
          }
        } else if (force) throw new Error('Context overflow has no balanced history to compact');
      }
    }
    if (estimate() >= inputLimit) {
      throw new Error('Current request exceeds the context budget; shorten the current message or attachments');
    }
    args.state.contextEstimate = pricePrompt(prompt, counter) + overhead;
    // Count the projected request after pruning/compaction, using Mastra's shared
    // text and multimodal estimator. Keep estimates distinct from provider usage.
    const breakdown = {
      method: 'mastra-token-counter',
      system: prompt
        .filter(message => message.role === 'system')
        .reduce((sum, message) => sum + counter.countString(message.content) + 4, 0),
      tools: tools.length ? counter.countString(JSON.stringify(tools)) : 0,
      messages: counter.countMessages(
        convertMessages(prompt.filter(message => message.role !== 'system')).to('Mastra.V2'),
      ),
    };
    // The processor span is a child of the current model step. Persist there so
    // each inference can recover its own counts without copying prompt contents.
    args.tracingContext?.currentSpan
      ?.findParent(SpanType.MODEL_STEP)
      ?.update({ metadata: { contextBreakdown: breakdown } });
    return { prompt };
  }
  async processOutputStep(args: ProcessOutputStepArgs) {
    const { store, thread } = await this.#scope(args);
    const route = await this.#route(args);
    const input = args.usage?.inputTokens;
    const estimate = args.state.contextEstimate;
    await store.updateThreadMetadata({
      id: thread.id,
      resourceId: thread.resourceId,
      update: current => {
        const previous = savedSchema.safeParse(current.metadata?.[key]).data ?? {};
        return {
          ...current.metadata,
          [key]: {
            ...previous,
            lastRoute: { modelId: route.modelId, level: route.level },
            ...(typeof input === 'number' && typeof estimate === 'number'
              ? {
                  measurement: {
                    route: `${route.modelId}/${route.level}`,
                    input,
                    estimate,
                    epoch: previous.checkpoint?.version ?? 0,
                  },
                }
              : {}),
          },
        };
      },
    });
    return args.messageList;
  }
  processAPIError(args: ProcessAPIErrorArgs) {
    const error = record(args.error);
    const message = `${args.error instanceof Error ? args.error.message : ''} ${typeof error.responseBody === 'string' ? error.responseBody : ''}`;
    if (
      args.state.contextOverflowRetried ||
      !/context_length_exceeded|maximum context length|context window.*exceed|too many tokens/i.test(message)
    )
      return;
    args.state.contextOverflowRetried = true;
    args.state.forceCompaction = true;
    return { retry: true };
  }
}
