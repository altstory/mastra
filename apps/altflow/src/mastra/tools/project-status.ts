import { toolIdentity } from '@mastra/altflow-tools';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export interface ProjectFiles {
  list(owner: string): Promise<Array<{ path: string; updatedAt: string }>>;
}

export const PROJECT_STAGES = [
  { id: '00', title: '需求确认', requiredForScript: false },
  { id: '01', title: '创意构思', requiredForScript: true },
  { id: '02', title: '世界观设定', requiredForScript: false },
  { id: '03', title: '人物设计', requiredForScript: true },
  { id: '04', title: '故事架构', requiredForScript: false },
  { id: '05', title: '互动设计', requiredForScript: true },
  { id: '06', title: '分集大纲', requiredForScript: true },
  { id: '07', title: '互动剧本', requiredForScript: false },
  { id: '08', title: '质量检查报告', requiredForScript: false },
  { id: '09', title: '迭代优化记录', requiredForScript: false },
] as const;

const PROJECT_ROOT = '/projects/';

export function describeProjects(files: Array<{ path: string; updatedAt: string }>, project?: string) {
  const projects = new Map<string, Array<{ path: string; updatedAt: string }>>();
  for (const file of files) {
    if (!file.path.startsWith(PROJECT_ROOT)) continue;
    const [name, ...rest] = file.path.slice(PROJECT_ROOT.length).split('/');
    if (!name || rest.length === 0) continue;
    projects.set(name, [...(projects.get(name) ?? []), file]);
  }
  if (!project) return { projects: [...projects.keys()].sort() };
  const own = projects.get(project) ?? [];
  const stages = PROJECT_STAGES.map(stage => {
    const found = own.filter(file => file.path.slice(`${PROJECT_ROOT}${project}/`.length).startsWith(`${stage.id}-`));
    return {
      id: stage.id,
      title: stage.title,
      done: found.length > 0,
      files: found.map(file => ({ path: file.path, updatedAt: file.updatedAt })),
    };
  });
  const missingForScript = stages.filter((stage, i) => PROJECT_STAGES[i].requiredForScript && !stage.done).map(stage => stage.title);
  const nextStage = stages.find((stage, i) => !stage.done && PROJECT_STAGES[i].id !== '00')?.title;
  return { project, exists: own.length > 0, stages, readyForScript: missingForScript.length === 0, missingForScript, nextStage };
}

export function createProjectStatusTool(options: { files: ProjectFiles }) {
  return createTool({
    id: 'project_status',
    description:
      '查看创作项目的进度：各环节的产出文件是否已存在，写剧本前还缺哪些。文件在用户工作区 projects/<项目名>/ 下，文件名以环节序号开头（00 需求确认、01 创意构思、02 世界观设定、03 人物设计、04 故事架构、05 互动设计、06 分集大纲、07 互动剧本、08 质量检查报告、09 迭代优化记录）。不传项目名则列出所有项目。',
    inputSchema: z.object({ project: z.string().min(1).optional().describe('项目名，即 projects 下的目录名') }),
    outputSchema: z.object({
      projects: z.array(z.string()).optional(),
      project: z.string().optional(),
      exists: z.boolean().optional(),
      stages: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            done: z.boolean(),
            files: z.array(z.object({ path: z.string(), updatedAt: z.string() })),
          }),
        )
        .optional(),
      readyForScript: z.boolean().optional(),
      missingForScript: z.array(z.string()).optional(),
      nextStage: z.string().optional(),
    }),
    execute: async ({ project }, context) => {
      const identity = toolIdentity(context);
      return describeProjects(await options.files.list(identity.userId), project);
    },
  });
}
