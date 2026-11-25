import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@libsql/client';
import { conversationModels } from './model-policy';

export const creatorProductModels: ReadonlySet<string> = new Set(conversationModels);
type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export interface CreatorMeter {
  db: Client;
  operationId: string;
  tokenBudget: number;
  background?: Set<Promise<unknown>>;
  onRootWake?: (runId: string) => Promise<void>;
  rootFinishReason?: string;
  controller?: AbortController;
}
export const creatorMeterContext = new AsyncLocalStorage<CreatorMeter>();

export function trackCreatorBackground(work: Promise<unknown>, controller?: AbortController) {
  const meter = creatorMeterContext.getStore();
  if (!meter?.background) return;
  meter.background.add(work);
  const abort = () => controller?.abort(meter.controller?.signal.reason);
  if (meter.controller?.signal.aborted) abort();
  else meter.controller?.signal.addEventListener('abort', abort, { once: true });
  void work
    .finally(() => {
      meter.background?.delete(work);
      meter.controller?.signal.removeEventListener('abort', abort);
    })
    .catch(() => {});
}

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
  await db.execute(
    `CREATE TABLE IF NOT EXISTS creator_gateway_allowances (operation_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, requested INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0)`,
  );
  await db.execute('CREATE INDEX IF NOT EXISTS creator_gateway_calls_operation ON creator_gateway_calls(operation_id)');
}

class CreatorBudgetError extends Error {}

export async function creatorAllowance(db: Client, operationId: string) {
  const { rows } = await db.execute({
    sql: 'SELECT allowed, requested, denied FROM creator_gateway_allowances WHERE operation_id=?',
    args: [operationId],
  });
  return rows[0];
}

export async function grantCreatorAllowance(db: Client, operationId: string, allowed: number, denied = false) {
  await db.execute({
    sql: `UPDATE creator_gateway_allowances SET allowed=?, requested=CASE WHEN requested<=? THEN 0 ELSE requested END,
      denied=CASE WHEN requested>? THEN ? ELSE 0 END WHERE operation_id=? AND allowed<=?`,
    args: [allowed, allowed, allowed, denied ? 1 : 0, operationId, allowed],
  });
}

async function renewCreatorAllowance(ceiling: number, signal?: AbortSignal) {
  const { db, operationId } = creatorMeterContext.getStore()!;
  await db.execute({
    sql: `UPDATE creator_gateway_allowances SET requested=MAX(requested,
      (SELECT COALESCE(sum(CASE WHEN usage IS NULL THEN ceiling ELSE json_extract(usage, '$.inputTokens') + json_extract(usage, '$.outputTokens') END),0) FROM creator_gateway_calls WHERE operation_id=?) + ?)
      WHERE operation_id=?`,
    args: [operationId, ceiling, operationId],
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    signal?.throwIfAborted();
    const allowance = await creatorAllowance(db, operationId);
    if (allowance?.denied) {
      const error = new Error('余额不足，任务已暂停。充值后可从已有进度继续。');
      error.name = 'CreatorInsufficientCreditsError';
      throw error;
    }
    if (allowance && Number(allowance.allowed) >= Number(allowance.requested)) return;
    if (Date.now() >= deadline) throw new Error('费用预留服务暂不可用，任务已暂停，请稍后继续。');
    await delay(250, undefined, { signal });
  }
}

export async function claimCreatorCall(modelId: string, summary: boolean, ceiling: number) {
  const context = creatorMeterContext.getStore();
  if (!context) return undefined;
  if (!creatorProductModels.has(modelId)) throw new Error('Creator model is outside billing policy');
  const { db, operationId, tokenBudget } = context;
  await db.execute({
    sql: 'INSERT OR IGNORE INTO creator_gateway_allowances (operation_id,allowed) VALUES (?,?)',
    args: [operationId, tokenBudget],
  });
  const id = randomUUID();
  const admitted = await db.execute({
    sql: `INSERT INTO creator_gateway_calls (id,operation_id,model_id,purpose,ceiling,started_ms)
      SELECT ?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM creator_gateway_receipts WHERE id=? AND state IN ('dispatching','accepted'))
      AND (SELECT COALESCE(sum(CASE WHEN usage IS NULL THEN ceiling
        ELSE json_extract(usage, '$.inputTokens') + json_extract(usage, '$.outputTokens') END), 0)
        FROM creator_gateway_calls WHERE operation_id=?) + ? <= (SELECT allowed FROM creator_gateway_allowances WHERE operation_id=?)`,
    args: [
      id,
      operationId,
      modelId,
      summary ? 'compaction' : 'creator',
      ceiling,
      Date.now(),
      operationId,
      operationId,
      ceiling,
      operationId,
    ],
  });
  if (admitted.rowsAffected !== 1) {
    const receipt = await db.execute({
      sql: 'SELECT state FROM creator_gateway_receipts WHERE id=?',
      args: [operationId],
    });
    if (!['accepted', 'dispatching'].includes(String(receipt.rows[0]?.state)))
      throw new Error('Creator operation is no longer active');
    throw new CreatorBudgetError('Creator operation requires an additional reservation');
  }
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

const settlingSteers = new WeakMap<NonNullable<ReturnType<typeof creatorMeterContext.getStore>>, Set<Promise<void>>>();

export async function fetchMeteredCreatorModel(
  url: Parameters<typeof fetch>[0],
  init: RequestInit,
  modelId: string,
  summary: boolean,
  ceiling: number,
) {
  const context = creatorMeterContext.getStore();
  if (!context) throw new Error('Creator model request has no meter');
  const pending = settlingSteers.get(context) ?? new Set<Promise<void>>();
  settlingSteers.set(context, pending);

  let call;
  for (;;) {
    init.signal?.throwIfAborted();
    try {
      call = await claimCreatorCall(modelId, summary, ceiling);
      break;
    } catch (error) {
      if (!(error instanceof CreatorBudgetError)) throw error;
      if (pending.size) {
        await Promise.race([Promise.allSettled(pending), delay(250, undefined, { signal: init.signal ?? undefined })]);
        continue;
      }
      await renewCreatorAllowance(ceiling, init.signal ?? undefined);
    }
  }
  if (!call) throw new Error('Creator model request has no meter');
  if (init.signal?.aborted) {
    await call.finish({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    init.signal.throwIfAborted();
  }

  const upstream = new AbortController();
  let steered = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let markSettled: () => void = () => {};
  const settled = new Promise<void>(resolve => (markSettled = resolve));
  const signal = init.signal;
  const abort = () => {
    const reason: unknown = signal?.reason;
    if (!(reason instanceof Error) || reason.message !== 'Interrupted by a queued signal') {
      upstream.abort(reason);
      return;
    }
    // Mastra drops the interrupted step. Keep its upstream stream only long enough to read its usage.
    steered = true;
    pending.add(settled);
    timeout = setTimeout(() => upstream.abort(), 120_000);
    timeout.unref?.();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const meteredCall = {
    async finish(usage: Usage | null) {
      try {
        await call.finish(usage);
      } finally {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timeout);
        pending.delete(settled);
        markSettled();
      }
    },
  };
  try {
    const response = await fetch(url, { ...init, signal: upstream.signal });
    return await meterCreatorResponse(response, meteredCall, () => steered);
  } catch (error) {
    await meteredCall.finish(null);
    throw error;
  }
}

export async function meterCreatorResponse(
  response: Response,
  call: NonNullable<Awaited<ReturnType<typeof claimCreatorCall>>>,
  keepReading = () => false,
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
  let cancelled = false;
  const read = async () => {
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
    return next;
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await read();
          if (cancelled) return;
          if (next.done) {
            await call.finish(usage);
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          await call.finish(usage);
          if (!cancelled) controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        if (keepReading()) {
          void (async () => {
            try {
              while (!(await read()).done) {}
            } finally {
              await call.finish(usage);
            }
          })().catch(() => {});
          return;
        }
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
