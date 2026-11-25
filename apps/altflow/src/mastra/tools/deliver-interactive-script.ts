import { toolIdentity } from '@mastra/altflow-tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { creatorFileId } from '../creator-file-id';
import type { WorkspaceFiles } from '../services/conversation-files';
import { buildBranchGraph, branchGraphOutputSchema, branchGraphNodeLimit } from './branch-graph';
import { validateScriptFormat } from './validate-script-format';

export const interactiveScriptFormat = [
  '第1集 雨夜来客',
  '1-1 老宅门口（夜）',
  '△雨声里，门被敲响。',
  '1-1-互动 开不开门？',
  '1-1-A：隔着门问清来意 → 1-2-A',
  '1-1-B：直接拉开门 → 1-2-B',
  '1-2-A 门内',
  '（合流 → 1-3）',
  '1-2-B 门口',
  '（合流 → 1-3）',
  '1-3 堂屋（夜）',
  '△茶已凉。',
  '本集结束',
].join('\n');

export function createDeliverInteractiveScriptTool(files: Pick<WorkspaceFiles, 'write'>) {
  return createTool({
    id: 'deliver_interactive_script',
    description:
      '交付新写或改写的互动剧本。填入使用标准集号、场景、互动选项、跳转、合流和本集结束的正文。工具先校验，再保存文件并把同一稿的分支图展示给用户。校验未通过时按行号修正并重试。',
    inputSchema: z.object({
      path: z
        .string()
        .max(300)
        .regex(/^\/?projects\/[^/]+\/(?:[^/]+\/)*[^/]+\.(?:md|txt)$/i)
        .describe('当前项目下的剧本文件路径'),
      script: z.string().trim().min(1).max(200_000).describe(interactiveScriptFormat),
    }),
    outputSchema: z.discriminatedUnion('delivered', [
      z.object({
        delivered: z.literal(false),
        issues: z.array(z.object({ rule: z.string(), message: z.string(), lineNumber: z.number() })),
      }),
      z.object({
        delivered: z.literal(true),
        file: z.object({ id: z.string(), name: z.string() }),
        graph: branchGraphOutputSchema,
      }),
    ]),
    execute: async ({ path, script }, context) => {
      const { userId } = toolIdentity(context);
      const checked = validateScriptFormat(script);
      if (!checked.valid) return { delivered: false as const, issues: checked.issues };
      if (!checked.stats.interactions || checked.stats.scenes > branchGraphNodeLimit) {
        return {
          delivered: false as const,
          issues: [
            {
              rule: '分支结构',
              message: '剧本需包含互动点，超过 300 个场景请按集交付。',
              lineNumber: -1,
            },
          ],
        };
      }
      const graph = buildBranchGraph(script);
      const stored = await files.write(userId, path, Buffer.from(script + '\n'));
      return {
        delivered: true as const,
        file: { id: creatorFileId(stored.path, stored.updatedAt), name: stored.name },
        graph,
      };
    },
    toModelOutput: output => ({
      type: 'text',
      value: output.delivered ? '剧本已保存，文件和分支图已展示给用户。' : JSON.stringify(output.issues),
    }),
  });
}
