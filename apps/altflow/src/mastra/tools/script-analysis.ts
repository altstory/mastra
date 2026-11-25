import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeScriptGraph } from './script-graph';
import type { GraphReport } from './script-graph';
import { analyzeScriptState } from './script-state';
import type { StateVariable } from './script-state';

export const stateVariableSchema = z
  .object({
    name: z.string().regex(/^(?:SV|FLAG|ITEM|COUNTER)_\w+$/, '变量名要以 SV_、FLAG_、ITEM_ 或 COUNTER_ 开头'),
    min: z.number().optional().describe('数值变量下限，默认 0'),
    max: z.number().optional().describe('数值变量上限，默认 100'),
    initial: z.union([z.number(), z.boolean()]).optional().describe('初始值'),
  })
  .strict();

export function analyzeScript(script: string, variables?: StateVariable[]): GraphReport {
  const graph = analyzeScriptGraph(script);
  return { ...graph, issues: [...graph.issues, ...analyzeScriptState(script, variables)] };
}

export function createScriptGraphTool() {
  return createTool({
    id: 'analyze_script_graph',
    description:
      '分析互动剧本的场景图和状态标注：孤立场景、死路、选项过多、虚假自由、路径数量膨胀、路径长度失衡；状态变量未定义、类型不符、越界、状态遗忘、状态无差异、条件不可达；选项文字过长。不调用模型，可在写完一场或一集后随时使用。传入剧本全文；有《互动设计文档》的状态变量清单时一并传入 variables，才会检查变量是否已定义。',
    inputSchema: z.object({
      script: z.string().min(1).describe('剧本全文'),
      variables: z.array(stateVariableSchema).max(100).optional().describe('状态变量清单'),
    }),
    outputSchema: z.object({
      issues: z.array(
        z.object({
          severity: z.enum(['error', 'warn']),
          rule: z.string(),
          message: z.string(),
          scenes: z.array(z.string()),
        }),
      ),
      stats: z.object({
        scenes: z.number(),
        endings: z.number(),
        pathCount: z.number(),
        minPathScenes: z.number(),
        maxPathScenes: z.number(),
      }),
    }),
    execute: async ({ script, variables }) => analyzeScript(script, variables),
  });
}
