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

export function createModelHubEmbedder({ apiKey, baseURL }: { apiKey: string; baseURL?: string }) {
  if (!apiKey) throw new Error('ModelHub credential is not configured');
  const root = modelHubBaseURL(baseURL);
  const model = new OpenAICompatibleEmbeddingModel(EMBEDDING_MODEL, {
    provider: 'altflow.embedding',
    maxEmbeddingsPerCall: 20,
    supportsParallelCalls: false,
    headers: () => ({ Authorization: `Bearer ${apiKey}` }),
    url: ({ path }) => root + path,
  });
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    maxEmbeddingsPerCall: model.maxEmbeddingsPerCall,
    supportsParallelCalls: model.supportsParallelCalls,
    async doEmbed(options: Parameters<typeof model.doEmbed>[0]) {
      const result = await model.doEmbed({
        ...options,
        abortSignal: options.abortSignal
          ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        providerOptions: { openaiCompatible: { dimensions: EMBEDDING_DIMENSION } },
      });
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
