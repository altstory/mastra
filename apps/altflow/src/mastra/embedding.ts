import { setTimeout as delay } from 'node:timers/promises';
import { OpenAICompatibleEmbeddingModel } from '@ai-sdk/openai-compatible';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { z } from 'zod';
import { modelHubBaseURL } from './modelhub-url';

export const EMBEDDING_DIMENSION = 1024;
export const EMBEDDING_MODEL = 'qwen3.7-text-embedding-flash-openai';

const rows = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number()).length(EMBEDDING_DIMENSION),
    }),
  ),
});

export function isTransientEmbeddingError(error: unknown): boolean {
  const failure = error as { statusCode?: number; name?: string } | undefined;
  const status = failure?.statusCode;
  return (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    failure?.name === 'TimeoutError'
  );
}

function retryDelay(error: unknown, attempt: number): number {
  const headers = (error as { responseHeaders?: Record<string, string> }).responseHeaders;
  const header = headers?.['retry-after'];
  const backoff = 1000 * 2 ** attempt;
  if (!header) return backoff;
  const seconds = Number(header);
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Math.min(60_000, Math.max(backoff, Number.isFinite(requested) ? requested : 0));
}

export function createModelHubEmbedder({
  apiKey,
  baseURL,
  retries = 0,
  timeoutMs = 8000,
}: {
  apiKey: string;
  baseURL?: string;
  retries?: number;
  timeoutMs?: number;
}) {
  if (!apiKey) throw new Error('ModelHub credential is not configured');
  const root = modelHubBaseURL(baseURL);
  const model = new OpenAICompatibleEmbeddingModel(EMBEDDING_MODEL, {
    provider: 'altflow.embedding',
    maxEmbeddingsPerCall: 20,
    supportsParallelCalls: false,
    headers: () => ({ Authorization: `Bearer ${apiKey}` }),
    url: ({ path }) => root + path,
  });
  async function request(options: Parameters<typeof model.doEmbed>[0]) {
    for (let attempt = 0; ; attempt++) {
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        return await model.doEmbed({
          ...options,
          abortSignal: options.abortSignal ? AbortSignal.any([options.abortSignal, deadline]) : deadline,
          providerOptions: { openaiCompatible: { dimensions: EMBEDDING_DIMENSION } },
        });
      } catch (error) {
        options.abortSignal?.throwIfAborted();
        const failure = deadline.aborted ? deadline.reason : error;
        if (attempt >= retries || !isTransientEmbeddingError(failure)) throw failure;
        await delay(retryDelay(failure, attempt), undefined, { signal: options.abortSignal });
      }
    }
  }

  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    maxEmbeddingsPerCall: model.maxEmbeddingsPerCall,
    supportsParallelCalls: model.supportsParallelCalls,
    async doEmbed(options: Parameters<typeof model.doEmbed>[0]) {
      const result = await request(options);
      const ordered = rows.parse(result.response?.body).data.sort((a, b) => a.index - b.index);
      if (ordered.length !== options.values.length || ordered.some((row, index) => row.index !== index)) {
        throw new Error('ModelHub returned mismatched embedding indices');
      }
      return { ...result, embeddings: ordered.map(row => row.embedding) };
    },
  } satisfies MastraEmbeddingModel<string>;
}

export async function embedTextBatch(
  embedder: ReturnType<typeof createModelHubEmbedder>,
  values: string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < values.length; offset += embedder.maxEmbeddingsPerCall) {
    const batch = await embedder.doEmbed({ values: values.slice(offset, offset + embedder.maxEmbeddingsPerCall) });
    embeddings.push(...batch.embeddings);
  }
  return embeddings;
}
