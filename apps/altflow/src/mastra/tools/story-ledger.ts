import { toolIdentity } from '@mastra/altflow-tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { LEDGER_KINDS, ledgerSaveEntrySchema } from '../services/story-ledger';
import type { LedgerEntry, StoryLedgerStore } from '../services/story-ledger';

const project = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/]+$/, '项目名不能包含 /')
  .describe('项目名，即 projects 下的目录名');

const entryOutput = z.object({
  kind: z.enum(LEDGER_KINDS),
  key: z.string(),
  episode: z.number(),
  content: z.string(),
  status: z.enum(['alive', 'dead', 'missing']).optional(),
  plannedRevealEpisode: z.number().optional(),
  revealedEpisode: z.number().optional(),
  revision: z.number(),
  updatedAt: z.string(),
});

export function openForeshadows(entries: LedgerEntry[]) {
  return entries
    .filter(entry => entry.kind === 'foreshadow' && !entry.revealedEpisode)
    .map(entry => ({
      key: entry.key,
      plantedEpisode: entry.episode,
      plannedRevealEpisode: entry.plannedRevealEpisode,
    }));
}

export function createStoryLedgerTools(options: { store: StoryLedgerStore }) {
  const story_ledger_read = createTool({
    id: 'story_ledger_read',
    description:
      '读取创作项目的设定与伏笔台账：角色当前状态、关系、时间线事件、伏笔（埋设与回收）和已确认设定。写某一集之前先读，保证与前面各集一致。返回每条的 revision，更正时需要带上。',
    inputSchema: z.object({ project, kind: z.enum(LEDGER_KINDS).optional().describe('只读某一类；不传则读全部') }),
    outputSchema: z.object({
      project: z.string(),
      entries: z.array(entryOutput),
      openForeshadows: z.array(
        z.object({ key: z.string(), plantedEpisode: z.number(), plannedRevealEpisode: z.number().optional() }),
      ),
    }),
    execute: async (input, context) => {
      const entries = await options.store.read(toolIdentity(context).userId, input.project, input.kind);
      return { project: input.project, entries, openForeshadows: openForeshadows(entries) };
    },
  });

  const story_ledger_save = createTool({
    id: 'story_ledger_save',
    description:
      '把用户已认可的一集的设定变化写入台账：新增或更正条目，或删除已无用的条目。只记录已经写进被用户认可的剧本里的内容，不记录计划、候选或未确认的想法。先把要写入的条目告诉用户，用户同意后再调用。同一次调用要么全部成功，要么全部失败。',
    inputSchema: z
      .object({
        project,
        entries: z.array(ledgerSaveEntrySchema).max(30).optional(),
        remove: z
          .array(
            z
              .object({ kind: z.enum(LEDGER_KINDS), key: z.string().trim().min(1), revision: z.number().int().min(0) })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict()
      .refine(input => (input.entries?.length ?? 0) + (input.remove?.length ?? 0) > 0, '没有要保存或删除的条目'),
    outputSchema: z.object({ saved: z.array(entryOutput), removed: z.number() }),
    execute: async (input, context) => {
      const saved = await options.store.apply(toolIdentity(context).userId, input.project, {
        upserts: input.entries,
        removals: input.remove,
      });
      return { saved, removed: input.remove?.length ?? 0 };
    },
  });

  return { story_ledger_read, story_ledger_save };
}
