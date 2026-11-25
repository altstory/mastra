import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import { conversationModels } from './model-policy';

const maxCalls = 40;
export const creatorProductModels: ReadonlySet<string> = new Set(conversationModels);
type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export const creatorMeterContext = new AsyncLocalStorage<{ db: Client; operationId: string; tokenBudget: number }>();

export async function createCreatorMeter(db: Client) {
  await db.execute(`CREATE TABLE IF NOT EXISTS creator_gateway_calls (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    ceiling INTEGER NOT NULL,
    started_ms INTEGER NOT NULL,
    ended_ms INTEGER,
    usage TEXT
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS creator_gateway_calls_operation ON creator_gateway_calls(operation_id)');
}

export async function claimCreatorCall(modelId: string, summary: boolean, ceiling: number) {
  const context = creatorMeterContext.getStore();
  if (!context) return undefined;
  if (!creatorProductModels.has(modelId)) throw new Error('Creator model is outside billing policy');
  const { db, operationId, tokenBudget } = context;
  const id = randomUUID();
  const admitted = await db.execute({
    sql: `INSERT INTO creator_gateway_calls (id,operation_id,model_id,purpose,ceiling,started_ms)
      SELECT ?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM creator_gateway_receipts WHERE id=? AND state IN ('dispatching','accepted'))
      AND (SELECT count(*) FROM creator_gateway_calls WHERE operation_id=?) < ?
      AND (SELECT COALESCE(sum(CASE WHEN usage IS NULL THEN ceiling
        ELSE json_extract(usage, '$.inputTokens') + json_extract(usage, '$.outputTokens') END), 0)
        FROM creator_gateway_calls WHERE operation_id=?) + ? <= ?`,
    args: [
      id,
      operationId,
      modelId,
      summary ? 'compaction' : 'creator',
      ceiling,
      Date.now(),
      operationId,
      operationId,
      maxCalls,
      operationId,
      ceiling,
      tokenBudget,
    ],
  });
  if (admitted.rowsAffected !== 1) throw new Error('Creator operation has no remaining model budget');
  return {
    async finish(usage: Usage | null) {
      await db.execute({
        sql: 'UPDATE creator_gateway_calls SET ended_ms=?,usage=? WHERE id=? AND ended_ms IS NULL',
        args: [
          Date.now(),
          usage && usage.inputTokens + usage.outputTokens <= ceiling ? JSON.stringify(usage) : null,
          id,
        ],
      });
    },
  };
}

export async function creatorUsage(db: Client, operationId: string) {
  const { rows } = await db.execute({
    sql: 'SELECT id,model_id,purpose,started_ms,ended_ms,usage FROM creator_gateway_calls WHERE operation_id=? ORDER BY started_ms,id',
    args: [operationId],
  });
  if (rows.some(row => !row.ended_ms || !row.usage)) return null;
  return rows.map(row => {
    const usage = JSON.parse(String(row.usage)) as Usage;
    return {
      logicalCallId: row.id,
      attemptId: row.id,
      modelName: row.model_id,
      modelId: 'altflow/' + row.model_id,
      agentName: row.purpose === 'compaction' ? 'creator-compaction' : 'creator-agent',
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      latencyMs: Number(row.ended_ms) - Number(row.started_ms),
    };
  });
}

export async function meterCreatorResponse(
  response: Response,
  call: NonNullable<Awaited<ReturnType<typeof claimCreatorCall>>>,
) {
  function decodeUsage(value: unknown): Usage | null {
    if (!value || typeof value !== 'object' || !('usage' in value) || !value.usage || typeof value.usage !== 'object')
      return null;
    const raw = value.usage as Record<string, unknown>;
    const input = raw.prompt_tokens;
    const output = raw.completion_tokens;
    if (
      typeof input !== 'number' ||
      !Number.isSafeInteger(input) ||
      input < 0 ||
      typeof output !== 'number' ||
      !Number.isSafeInteger(output) ||
      output < 0
    )
      return null;
    const detail = raw.prompt_tokens_details as { cached_tokens?: number } | undefined;
    const cache = detail?.cached_tokens;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens:
        typeof cache === 'number' && Number.isSafeInteger(cache) && cache > 0 ? Math.min(input, cache) : 0,
    };
  }
  if (!response.ok || !response.body) {
    await call.finish(null);
    return response;
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const json: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    await call.finish(decodeUsage(json));
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | null = null;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          buffer += next.done ? decoder.decode() + '\n' : decoder.decode(next.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end).trimEnd();
            buffer = buffer.slice(end + 1);
            if (line.startsWith('data:') && !line.endsWith('[DONE]')) {
              try {
                usage = decodeUsage(JSON.parse(line.slice(5))) ?? usage;
              } catch {}
            }
          }
          if (buffer.length > 2_000_000) throw new Error('ModelHub event exceeds limit');
          if (next.done) {
            await call.finish(usage);
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          await call.finish(usage);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await call.finish(usage);
        }
      },
    }),
    { status: response.status, headers: response.headers },
  );
}
