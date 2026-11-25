import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const briefSchema = z.object({
  title: z.string().trim().min(1).max(100).describe('用户作品或本次创作的名称'),
  confirmed: z.array(z.string().trim().min(1).max(500)).max(20).describe('用户明确确认的目标、决定和创作原则'),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(20).describe('为了继续而暂用的假设；不能当成用户确认'),
  undecided: z.array(z.string().trim().min(1).max(500)).max(20).describe('可以留到后续环节决定的事项'),
});

export const creativeBriefTool = createTool({
  id: 'show_creative_brief',
  description:
    '在对话里展示创作要求摘要：区分用户已确认、暂定假设和仍待决定。需求已足够开始或用户纠正重要决定后调用。不能把建议写成已确认；这是展示工具，仍需用文件工具把同一份要求保存到当前项目的 00-需求确认.md。不要求每次展示后再审批。',
  inputSchema: briefSchema,
  outputSchema: briefSchema,
  execute: async input => input,
});
