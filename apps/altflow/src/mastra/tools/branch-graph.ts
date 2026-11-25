import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { analyzeScriptGraph, parseScenes, sceneEdges } from './script-graph';

export const branchGraphNodeLimit = 300;
const SUMMARY_LENGTH = 60;
const NON_NARRATIVE = /^[（(]\s*(?:状态|若)[\s：:]/;

const nodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['story', 'interaction', 'convergence', 'dead_end', 'ending']),
  episode: z.number(),
  title: z.string(),
  summary: z.string().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string(), toNode: z.string().optional() })).optional(),
});
const edgeSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() });

export function buildBranchGraph(script: string) {
  const scenes = parseScenes(script);
  const edges = sceneEdges(scenes);
  const incoming = new Map<string, number>();
  for (const targets of edges.values())
    for (const target of targets) incoming.set(target, (incoming.get(target) ?? 0) + 1);
  const last = scenes.at(-1)?.key;

  const nodes = scenes.map(scene => {
    const out = edges.get(scene.key) ?? [];
    const kind = scene.options.length
      ? ('interaction' as const)
      : scene.ending !== undefined
        ? ('ending' as const)
        : out.length === 0 && !scene.closed && scene.key !== last
          ? ('dead_end' as const)
          : (incoming.get(scene.key) ?? 0) > 1
            ? ('convergence' as const)
            : ('story' as const);
    const summary = scene.body.find(line => !NON_NARRATIVE.test(line));
    return {
      id: scene.key,
      kind,
      episode: scene.episode,
      title: scene.ending ?? scene.title,
      ...(summary ? { summary: [...summary].slice(0, SUMMARY_LENGTH).join('') } : {}),
      ...(scene.options.length
        ? { options: scene.options.map(option => ({ id: option.id, label: option.label, toNode: option.target })) }
        : {}),
    };
  });

  const labels = new Map(
    scenes.flatMap(scene => scene.options.map(option => [`${scene.key}>${option.target}`, option.label])),
  );
  const links = scenes.flatMap(scene =>
    (edges.get(scene.key) ?? []).map(to => {
      const label = labels.get(`${scene.key}>${to}`);
      return { from: scene.key, to, ...(label ? { label } : {}) };
    }),
  );
  return { nodes, edges: links, stats: analyzeScriptGraph(script).stats };
}

export const branchGraphOutputSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  stats: z.object({
    scenes: z.number(),
    endings: z.number(),
    pathCount: z.number(),
    minPathScenes: z.number(),
    maxPathScenes: z.number(),
  }),
});

export function createBranchGraphTool() {
  return createTool({
    id: 'show_branch_graph',
    description:
      '把互动剧本的分支结构画成图展示给用户：场景、互动点、选项、合流和结局，以及它们之间的跳转。传入剧本全文，使用 X-Y 场景编号格式。图由界面绘制，你不需要复述节点内容，只需简要说明结构特点。需要列出具体问题时用 analyze_script_graph。',
    inputSchema: z.object({ script: z.string().min(1).describe('剧本全文') }),
    outputSchema: branchGraphOutputSchema,
    execute: async ({ script }) => {
      const graph = buildBranchGraph(script);
      if (graph.nodes.length > branchGraphNodeLimit)
        throw new Error(`剧本有 ${graph.nodes.length} 个场景，超过 ${branchGraphNodeLimit} 个，请按集分别展示。`);
      return graph;
    },
    toModelOutput: output => {
      const { stats } = output;
      return {
        type: 'text',
        value: `分支图已展示给用户：${stats.scenes} 个场景，${stats.endings} 个结局，约 ${stats.pathCount} 条路径，长度 ${stats.minPathScenes} 到 ${stats.maxPathScenes} 个场景。`,
      };
    },
  });
}
