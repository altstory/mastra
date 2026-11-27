import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBStore } from '@mastra/duckdb';
import { day, type Artifact, type BackupObjects } from './objects';

const tables = ['span_events', 'metric_events', 'log_events', 'score_events', 'feedback_events'] as const;
type Connection = Awaited<ReturnType<DuckDBStore['db']['getConnection']>>;
const ownerTable = 'altflow_archived_traces';
const hotShardRows = 512;

function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function inTransaction<T>(conn: Connection, run: () => Promise<T>) {
  await conn.run('BEGIN TRANSACTION');
  try {
    const result = await run();
    await conn.run('COMMIT');
    return result;
  } catch (error) {
    await conn.run('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function backupTraces({
  db,
  objects,
  directory,
  database,
  now,
  cleanup,
  archiveDays,
}: {
  db: DuckDBStore['db'];
  objects: BackupObjects;
  directory: string;
  database: string;
  now: number;
  cleanup: boolean;
  archiveDays: number;
}) {
  const cutoff = 'TIMESTAMP ' + literal(new Date(now - 7 * day).toISOString());
  const conn = await db.getConnection();
  try {
    await conn.run('CREATE TABLE IF NOT EXISTS ' + ownerTable + ' (traceId VARCHAR PRIMARY KEY, archivedAt TIMESTAMP)');
    const before = (await stat(database)).blocks * 512;
    let rows = 0;
    // Spans, metrics and logs are append-only. Keep the checks small for large tool payloads.
    const fingerprints = {
      span_events: 'sha256(to_json(row(t.cursorId, t.timestamp, t.traceId, t.spanId, t.eventType)))',
      metric_events: 'sha256(to_json(row(t.cursorId, t.timestamp, t.metricId)))',
      log_events: 'sha256(to_json(row(t.cursorId, t.timestamp, t.logId)))',
      score_events: 'sha256(to_json(t))',
      feedback_events: 'sha256(to_json(t))',
    };
    // Limit each pass so the initial backfill leaves time for the online workload.
    for (let batch = 0; batch < 8; batch++) {
      const selected = await inTransaction(conn, async () => {
        await conn.run(`CREATE OR REPLACE TEMP TABLE selected_traces AS
          SELECT s.traceId FROM span_events s
          GROUP BY s.traceId
          HAVING MAX(s.timestamp) < ${cutoff}
            AND (MAX(s.endedAt) FILTER (WHERE s.parentSpanId IS NULL AND s.eventType = 'end') < ${cutoff}
              OR s.traceId IN (SELECT traceId FROM ${ownerTable}))
            AND (s.traceId IN (SELECT traceId FROM ${ownerTable}) OR s.traceId NOT IN (
              SELECT started.traceId FROM span_events started
              WHERE started.parentSpanId IS NULL AND started.eventType = 'start'
                AND NOT EXISTS (
                  SELECT 1 FROM span_events ended WHERE ended.traceId = started.traceId
                    AND ended.spanId = started.spanId AND ended.eventType = 'end'
                )
            )
          ) ORDER BY MIN(s.timestamp), s.traceId LIMIT 64`);
        const selected: { table: (typeof tables)[number]; file: string; count: number }[] = [];
        for (const table of tables) {
          const temp = 'archiving_' + table;
          const orphan =
            table === 'span_events'
              ? ''
              : `OR ((t.traceId IS NULL OR NOT EXISTS (SELECT 1 FROM span_events s WHERE s.traceId = t.traceId))
                 AND t.timestamp < ${cutoff})`;
          await conn.run(`CREATE OR REPLACE TEMP TABLE ${temp} AS
            SELECT t.rowid AS backup_rowid, ${fingerprints[table]} AS digest FROM ${table} t
            WHERE t.timestamp < ${cutoff}
              AND (t.traceId IN (SELECT traceId FROM selected_traces) ${orphan})
            ORDER BY t.timestamp, t.rowid ${table === 'span_events' ? '' : 'LIMIT 10000'}`);
          const [[count]] = await (await conn.run('SELECT COUNT(*) FROM ' + temp)).getRows();
          if (count === 0n) {
            await conn.run('DROP TABLE ' + temp);
            continue;
          }
          const file = join(directory, table + '.parquet');
          await conn.run(`COPY (SELECT t.* FROM ${table} t SEMI JOIN ${temp} a ON t.rowid = a.backup_rowid ORDER BY t.rowid)
            TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)`);
          selected.push({ table, file, count: Number(count) });
        }
        return selected;
      });
      if (!selected.length) break;
      const artifacts = [];
      for (const { table, file, count } of selected) {
        artifacts.push({ ...(await objects.store(table + '.parquet', file)), rows: count });
      }
      await objects.archive({ version: 1, kind: 'trace-archive', artifacts }, now);
      if (!cleanup) break;
      await conn.run(`INSERT INTO ${ownerTable} SELECT traceId, current_timestamp FROM selected_traces
        ON CONFLICT (traceId) DO UPDATE SET archivedAt = excluded.archivedAt`);
      for (const { table } of selected) {
        const temp = 'archiving_' + table;
        const rowIds = await (await conn.run(`SELECT backup_rowid FROM ${temp} ORDER BY backup_rowid`)).getRows();
        for (let offset = 0; offset < rowIds.length; offset += 128) {
          const batchIds = rowIds
            .slice(offset, offset + 128)
            .map(([id]) => BigInt(String(id)))
            .join(',');
          const deleted = await conn.run(`DELETE FROM ${table} WHERE rowid IN (
            WITH current_rows AS MATERIALIZED (
              SELECT t.rowid AS backup_rowid, ${fingerprints[table]} AS digest
              FROM ${table} t WHERE t.rowid IN (${batchIds})
            )
            SELECT c.backup_rowid FROM current_rows c SEMI JOIN ${temp} a
              ON c.backup_rowid = a.backup_rowid AND c.digest = a.digest
          )`);
          const [[count]] = await deleted.getRows();
          rows += Number(count);
        }
        await conn.run('DROP TABLE ' + temp);
      }
    }

    if (cleanup) {
      await conn.run(
        `DELETE FROM ${ownerTable} WHERE archivedAt < TIMESTAMP ${literal(new Date(now - archiveDays * day).toISOString())}`,
      );
      if (rows) await conn.run('CHECKPOINT').catch(() => undefined);
    }
    const parts = await inTransaction(conn, async () => {
      const parts: { path: string; file: string }[] = [];
      for (const table of [...tables, ownerTable] as const) {
        const dateColumn = table === ownerTable ? 'archivedAt' : 'timestamp';
        const result = await conn.run(`SELECT DISTINCT
          CAST(${dateColumn} AS DATE)::VARCHAR AS date, rowid // ${hotShardRows} AS shard FROM ${table} ORDER BY 1, 2`);
        for (const [date, shard] of await result.getRows()) {
          if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof shard !== 'bigint' || shard < 0n)
            throw new Error('Invalid Trace partition');
          const path = table + '-' + date + '-' + shard + '.parquet';
          const file = join(directory, path);
          const first = shard * BigInt(hotShardRows);
          await conn.run(`COPY (SELECT * FROM ${table}
            WHERE CAST(${dateColumn} AS DATE) = DATE ${literal(date)}
              AND rowid >= ${first} AND rowid < ${first + BigInt(hotShardRows)}
            ORDER BY rowid) TO ${literal(file)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)`);
          parts.push({ path, file });
        }
      }
      return parts;
    });
    const artifacts: Artifact[] = [];
    for (const { path, file } of parts) {
      artifacts.push(await objects.store(path, file));
      await rm(file);
    }
    await objects.publish('hot.json', { version: 1, kind: 'trace-hot', artifacts }, true);
    return { archivedRows: rows, before, after: (await stat(database)).blocks * 512 };
  } finally {
    conn.closeSync();
  }
}

export async function compactTraces(db: DuckDBStore['db'], target: string) {
  const conn = await db.getConnection();
  try {
    const [[name]] = await (await conn.run('SELECT current_database()')).getRows();
    const database = '"' + String(name).replaceAll('"', '""') + '"';
    await conn.run(`ATTACH ${literal(target)} AS compacted`);
    await conn.run(`COPY FROM DATABASE ${database} TO compacted`);
    await conn.run('CHECKPOINT compacted');
    await conn.run('DETACH compacted');
  } finally {
    conn.closeSync();
  }
}

export async function restoreHotTraces(store: DuckDBStore, directory: string, artifacts: Artifact[]) {
  await store.observability.init();
  const conn = await store.db.getConnection();
  try {
    await inTransaction(conn, async () => {
      await conn.run('CREATE TABLE ' + ownerTable + ' (traceId VARCHAR PRIMARY KEY, archivedAt TIMESTAMP)');
      for (const { path } of artifacts) {
        const table = [...tables, ownerTable].find(name => path.startsWith(name + '-'));
        if (!table || !/^[a-z_]+-\d{4}-\d{2}-\d{2}(?:-\d+)?\.parquet$/.test(path))
          throw new Error('Invalid Trace artifact name');
        await conn.run(`INSERT INTO ${table} BY NAME SELECT * FROM read_parquet(${literal(join(directory, path))})`);
      }
      for (const table of tables) {
        const [[last]] = await (await conn.run(`SELECT COALESCE(MAX(cursorId), 0) FROM ${table}`)).getRows();
        const sequence = table + '_cursor_id_seq';
        await conn.run('DROP SEQUENCE ' + sequence);
        await conn.run(`CREATE SEQUENCE ${sequence} START ${BigInt(String(last)) + 1n}`);
      }
    });
    await conn.run('CHECKPOINT');
  } finally {
    conn.closeSync();
  }
}
