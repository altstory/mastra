import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';
import { z } from 'zod';

export const LEDGER_ENTRY_LIMIT = 200;
export const LEDGER_KINDS = ['character', 'relationship', 'event', 'foreshadow', 'fact'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

const entryShape = {
  kind: z.enum(LEDGER_KINDS),
  key: z.string().trim().min(1).max(100).describe('条目名：角色名、伏笔名、事件编号、关系双方或设定名'),
  episode: z.number().int().min(1).describe('该条目建立或最近一次变化所在的集数'),
  content: z.string().trim().min(1).max(600),
  status: z.enum(['alive', 'dead', 'missing']).optional().describe('仅角色使用'),
  plannedRevealEpisode: z.number().int().min(1).optional().describe('仅伏笔使用：计划回收的集数'),
  revealedEpisode: z.number().int().min(1).optional().describe('仅伏笔使用：已回收的集数'),
};
const checkEntry = (
  entry: {
    kind: LedgerKind;
    episode: number;
    status?: string;
    plannedRevealEpisode?: number;
    revealedEpisode?: number;
  },
  ctx: z.RefinementCtx,
) => {
  if (entry.status && entry.kind !== 'character')
    ctx.addIssue({ code: 'custom', path: ['status'], message: '只有角色可以设置 status' });
  if ((entry.plannedRevealEpisode || entry.revealedEpisode) && entry.kind !== 'foreshadow')
    ctx.addIssue({ code: 'custom', path: ['plannedRevealEpisode'], message: '回收集数只用于伏笔' });
  if (entry.plannedRevealEpisode && entry.plannedRevealEpisode < entry.episode)
    ctx.addIssue({ code: 'custom', path: ['plannedRevealEpisode'], message: '计划回收的集数不能早于埋设集数' });
  if (entry.revealedEpisode && entry.revealedEpisode < entry.episode)
    ctx.addIssue({ code: 'custom', path: ['revealedEpisode'], message: '回收集数不能早于埋设集数' });
};
export const ledgerEntrySchema = z.object(entryShape).strict().superRefine(checkEntry);
export const ledgerSaveEntrySchema = z
  .object({
    ...entryShape,
    revision: z.number().int().min(0).describe('新条目为 0；更正已有条目时填读取到的 revision'),
  })
  .strict()
  .superRefine(checkEntry);
export type LedgerEntryInput = z.infer<typeof ledgerEntrySchema>;
export type LedgerEntry = LedgerEntryInput & { revision: number; updatedAt: string };

export interface LedgerRemoval {
  kind: LedgerKind;
  key: string;
  revision: number;
}

export class StoryLedgerConflict extends Error {}

export class StoryLedgerStore {
  private db: Client;
  constructor(url: string) {
    this.db = createClient({ url });
  }
  async init() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS story_ledger (
      owner TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (owner, project, kind, key)
    )`);
    await this.db.execute('PRAGMA busy_timeout = 10000');
  }
  close() {
    this.db.close();
  }
  async read(owner: string, project: string, kind?: LedgerKind): Promise<LedgerEntry[]> {
    const result = await this.db.execute({
      sql: `SELECT value, revision FROM story_ledger WHERE owner = ? AND project = ? ${kind ? 'AND kind = ?' : ''}
        ORDER BY kind, key`,
      args: kind ? [owner, project, kind] : [owner, project],
    });
    return result.rows.map(row => ({ ...JSON.parse(String(row.value)), revision: Number(row.revision) }));
  }
  async apply(
    owner: string,
    project: string,
    changes: { upserts?: Array<LedgerEntryInput & { revision: number }>; removals?: LedgerRemoval[] },
  ) {
    const tx = await this.db.transaction('write');
    try {
      const saved: LedgerEntry[] = [];
      for (const { revision, ...entry } of changes.upserts ?? []) {
        const value = { ...entry, updatedAt: new Date().toISOString() };
        const result = await tx.execute({
          sql: `INSERT INTO story_ledger(owner, project, kind, key, value, revision)
            SELECT :owner, :project, :kind, :key, :value, :expected + 1
            WHERE COALESCE((SELECT revision FROM story_ledger
              WHERE owner = :owner AND project = :project AND kind = :kind AND key = :key), 0) = :expected
            ON CONFLICT(owner, project, kind, key) DO UPDATE SET value = excluded.value, revision = excluded.revision
            RETURNING revision`,
          args: { owner, project, kind: entry.kind, key: entry.key, value: JSON.stringify(value), expected: revision },
        });
        if (!result.rows.length)
          throw new StoryLedgerConflict(`${entry.kind}「${entry.key}」已被更新，请重新读取台账后再保存`);
        saved.push({ ...value, revision: Number(result.rows[0].revision) });
      }
      for (const removal of changes.removals ?? []) {
        const result = await tx.execute({
          sql: 'DELETE FROM story_ledger WHERE owner = ? AND project = ? AND kind = ? AND key = ? AND revision = ?',
          args: [owner, project, removal.kind, removal.key, removal.revision],
        });
        if (!result.rowsAffected)
          throw new StoryLedgerConflict(`${removal.kind}「${removal.key}」不存在或已被更新，请重新读取台账`);
      }
      const total = await tx.execute({
        sql: 'SELECT count(*) AS total FROM story_ledger WHERE owner = ? AND project = ?',
        args: [owner, project],
      });
      if (Number(total.rows[0].total) > LEDGER_ENTRY_LIMIT)
        throw new StoryLedgerConflict(`台账最多 ${LEDGER_ENTRY_LIMIT} 条，请合并或删除已无用的条目`);
      await tx.commit();
      return saved;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
}
