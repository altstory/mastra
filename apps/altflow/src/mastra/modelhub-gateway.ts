import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway } from '@mastra/core/llm';
import type { ProviderConfig } from '@mastra/core/llm';
import { z } from 'zod';
import { claimCreatorCall, creatorMeterContext, meterCreatorResponse } from './creator-meter';
import { contextPolicy } from './context-policy.ts';

type ChatModel = ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;
type ChatPrompt = Parameters<ChatModel['doGenerate']>[0]['prompt'];

// The OpenAI-compatible adapter stringifies content tool results. Move image
// parts to a native user attachment after the tool results so their bytes never
// become text tokens. Keep tool-call IDs and textual results in their own role.
function nativeToolImages(prompt: ChatPrompt): ChatPrompt {
  return prompt.flatMap((message): ChatPrompt => {
    if (message.role !== 'tool') return [message];
    const images: Extract<ChatPrompt[number], { role: 'user' }>['content'] = [];
    const content = message.content.map(part => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
      const value = part.output.value.filter(item => {
        if (item.type === 'image-data') {
          images.push({ type: 'file', data: item.data, mediaType: item.mediaType });
          return false;
        }
        if (item.type === 'image-url') {
          images.push({ type: 'file', data: new URL(item.url), mediaType: 'image/*' });
          return false;
        }
        return true;
      });
      if (value.length === part.output.value.length) return part;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: value.map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n'),
        },
      };
    });
    return images.length
      ? [
          { ...message, content },
          { role: 'user' as const, content: images },
        ]
      : [message];
  });
}

const optionSchema = z
  .object({
    level: z.string().min(1),
    target: z.string().min(1),
    supports_thinking_level: z.boolean(),
    supports_thinking_budget: z.boolean(),
    agent_budget_tokens: z.number().int().positive().optional(),
  })
  .refine(option => !option.supports_thinking_budget || option.agent_budget_tokens !== undefined);
const catalogSchema = z
  .object({
    config_version: z.number().int().positive(),
    free_chat_models: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
            display_name: z.string().min(1),
            sort_order: z.number(),
            default_thinking_level: z.string().min(1),
            thinking_options: z.array(optionSchema).min(1),
          })
          .refine(
            model =>
              new Set(model.thinking_options.map(option => option.level)).size === model.thinking_options.length &&
              model.thinking_options.some(option => option.level === model.default_thinking_level),
          ),
      )
      .min(1),
  })
  .refine(catalog => new Set(catalog.free_chat_models.map(model => model.id)).size === catalog.free_chat_models.length);
type Catalog = z.infer<typeof catalogSchema>;
const infoSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string(),
      model_info: z
        .object({ context_window: z.unknown().optional(), max_input_tokens: z.unknown().optional() })
        .optional(),
    }),
  ),
});
const capacitySchema = z.number().int().positive().safe();

/** Product catalog and call routing share one validated ModelHub snapshot. */
export class ModelHubGateway extends MastraModelGateway {
  readonly id = 'altflow';
  readonly name = 'AltFlow ModelHub';
  #apiKey: string;
  #allowedModels?: readonly string[];
  #defaultReasoningLevel?: string;
  #baseURL: string;
  #snapshot?: Catalog;
  #expires = 0;
  #pending?: Promise<Catalog>;
  #info: Record<string, number> = {};
  #infoExpires = 0;
  #infoPending?: Promise<Record<string, number>>;
  constructor(options: {
    apiKey: string;
    baseURL?: string;
    allowedModels?: readonly string[];
    defaultReasoningLevel?: string;
  }) {
    super();
    const url = new URL(options.baseURL ?? 'https://modelhub.altflow.cn/v1');
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    ) {
      throw new Error('ModelHub requires HTTPS or an explicit loopback test server');
    }
    if (!options.apiKey) throw new Error('ModelHub credential is not configured');
    this.#apiKey = options.apiKey;
    this.#allowedModels = options.allowedModels;
    this.#defaultReasoningLevel = options.defaultReasoningLevel;
    this.#baseURL = url.href.replace(/\/$/, '');
  }
  handlesModel(id: string) {
    return id.startsWith('altflow/');
  }
  async catalog(): Promise<Catalog> {
    if (this.#snapshot && Date.now() < this.#expires) return this.#snapshot;
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      try {
        const response = await fetch(`${this.#baseURL}/model-catalog`, {
          headers: { Authorization: `Bearer ${this.#apiKey}` },
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('ModelHub catalog is unavailable');
        const catalog = catalogSchema.parse(await response.json());
        // Apply the deployment policy before exposing or resolving models, including direct API overrides.
        this.#snapshot = catalogSchema.parse({
          ...catalog,
          free_chat_models: catalog.free_chat_models
            .filter(model => !this.#allowedModels || this.#allowedModels.includes(model.id))
            .map(model => ({
              ...model,
              default_thinking_level: this.#defaultReasoningLevel ?? model.default_thinking_level,
            })),
        });
      } catch {
        // Keep the last validated catalog; never substitute the public registry.
        if (!this.#snapshot) throw new Error('ModelHub catalog is unavailable or invalid');
      }
      this.#expires = Date.now() + 60000;
      return this.#snapshot;
    })();
    try {
      return await this.#pending;
    } finally {
      this.#pending = undefined;
    }
  }
  async modelInfo(): Promise<Record<string, number>> {
    if (Date.now() < this.#infoExpires) return this.#info;
    if (this.#infoPending) return this.#infoPending;
    this.#infoPending = (async () => {
      const capacities: Record<string, number> = {};
      try {
        const response = await fetch(new URL('/model/info', this.#baseURL), {
          headers: { Authorization: `Bearer ${this.#apiKey}` },
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        if (response.ok) {
          const info = infoSchema.parse(await response.json());
          for (const row of info.data) {
            const capacity = capacitySchema.safeParse(
              row.model_info?.max_input_tokens ?? row.model_info?.context_window,
            );
            if (!capacity.success) continue;
            // Routing pools can publish multiple deployments. Use the smallest declared input limit.
            capacities[row.model_name] = Math.min(capacities[row.model_name] ?? capacity.data, capacity.data);
          }
        }
      } catch {
        // Info is optional metadata. Unknown capacity must not break model routing or become a guessed limit.
      }
      this.#info = capacities;
      this.#infoExpires = Date.now() + 60000;
      return capacities;
    })();
    try {
      return await this.#infoPending;
    } finally {
      this.#infoPending = undefined;
    }
  }
  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const [catalog, info] = await Promise.all([this.catalog(), this.modelInfo()]);
    const contextWindows = (model: Catalog['free_chat_models'][number]) =>
      Object.fromEntries(
        model.thinking_options.flatMap(option => {
          const capacity = info[option.target];
          return capacity === undefined ? [] : [[option.level, contextPolicy(capacity).window]];
        }),
      );
    return {
      altflow: {
        name: this.name,
        gateway: this.id,
        apiKeyEnvVar: 'ALTFLOW_MODELHUB_API_KEY',
        url: this.#baseURL,
        modelContextWindows: Object.fromEntries(
          catalog.free_chat_models.flatMap(model => {
            const capacity = contextWindows(model)[model.default_thinking_level];
            return capacity === undefined ? [] : [[model.id, capacity]];
          }),
        ),
        modelNames: Object.fromEntries(catalog.free_chat_models.map(model => [model.id, model.display_name])),
        modelReasoning: Object.fromEntries(
          catalog.free_chat_models.map(model => [
            model.id,
            {
              defaultLevel: model.default_thinking_level,
              levels: model.thinking_options.map(option => option.level),
              contextWindows: contextWindows(model),
            },
          ]),
        ),
        models: [...catalog.free_chat_models]
          .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
          .map(model => model.id),
      },
    };
  }
  async buildUrl() {
    return this.#baseURL;
  }
  async getApiKey() {
    return this.#apiKey;
  }
  async resolveLanguageModel({ modelId }: { modelId: string }) {
    return this.#languageModel(modelId, false);
  }
  /** Only the server's checkpoint processor uses the auxiliary completion reservation. */
  async resolveSummaryModel(modelId: string) {
    return this.#languageModel(modelId, true);
  }
  async #languageModel(modelId: string, summary: boolean) {
    if (!(await this.catalog()).free_chat_models.some(model => model.id === modelId))
      throw new Error('Model is not in the ModelHub product catalog');
    const provider = createOpenAICompatible({
      name: this.id,
      apiKey: this.#apiKey,
      baseURL: this.#baseURL,
      includeUsage: true,
      supportsStructuredOutputs: true,
      fetch: async (url, init) => {
        if (String(url) !== `${this.#baseURL}/chat/completions` || typeof init?.body !== 'string') {
          throw new Error('Unsupported ModelHub request');
        }
        // Mastra caches model instances. Refresh here, then freeze one snapshot
        // per HTTP call so catalog changes apply to later generations too.
        const catalog = await this.catalog();
        const product = catalog.free_chat_models.find(model => model.id === modelId);
        const body = JSON.parse(init.body);
        if (!product) throw new Error('Model is not in the ModelHub product catalog');
        const level = body.reasoningLevel ?? product.default_thinking_level;
        const option = product.thinking_options.find(option => option.level === level);
        if (!option) throw new Error('Unsupported ModelHub reasoning level; select a level from the current catalog');
        for (const key of [
          'reasoningLevel',
          'reasoning_effort',
          'thinking',
          'thinking_budget',
          'thinking_budget_tokens',
          'enable_thinking',
          'modelhub_reasoning_effort',
          'modelhub_thinking_budget',
        ])
          delete body[key];
        const capacity = (await this.modelInfo())[option.target];
        const policy = contextPolicy(capacity);
        const outputLimit = summary ? 65536 : policy.output;
        body.max_tokens = Math.min(
          typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : outputLimit,
          outputLimit,
        );
        body.model = option.target;
        if (option.supports_thinking_level) body.modelhub_reasoning_effort = option.level;
        if (option.supports_thinking_budget) body.modelhub_thinking_budget = option.agent_budget_tokens;
        body.metadata = {
          ...body.metadata,
          source_host: 'mastra-studio',
          modelhub_product_model: product.id,
          modelhub_catalog_version: String(catalog.config_version),
          modelhub_thinking_level: option.level,
        };
        const meter = creatorMeterContext.getStore();
        if (body.creatorMeterRequired && !meter) throw new Error('Creator model request has no metering context');
        delete body.creatorMeterRequired;
        const serialized = JSON.stringify(body);
        if (meter) {
          const hasImage = body.messages?.some(
            (message: { content?: unknown }) =>
              Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'),
          );
          if (hasImage && !capacity) throw new Error('ModelHub context capacity is unavailable for image input');
          const inputBound = hasImage ? capacity : Buffer.byteLength(serialized) + 1024;
          const upperBound = Math.min(inputBound, capacity ?? inputBound) + body.max_tokens;
          const call = await claimCreatorCall(product.id, summary, upperBound);
          if (!call) throw new Error('Creator model request has no meter');
          try {
            const response = await fetch(url, { ...init, body: serialized, redirect: 'error' });
            return await meterCreatorResponse(response, call);
          } catch (error) {
            await call.finish(null);
            throw error;
          }
        }
        return fetch(url, { ...init, body: serialized, redirect: 'error' });
      },
    });
    const model = provider.chatModel(modelId);
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: (options: Parameters<ChatModel['doGenerate']>[0]) =>
        model.doGenerate({ ...options, prompt: nativeToolImages(options.prompt) }),
      doStream: (options: Parameters<ChatModel['doStream']>[0]) =>
        model.doStream({ ...options, prompt: nativeToolImages(options.prompt) }),
    };
  }
}
