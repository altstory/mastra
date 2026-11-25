import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v4';

const shortText = z.string().trim().min(1).max(500);
const heading = z.string().trim().min(1).max(100);
const common = { title: heading, summary: shortText.optional() };

export const creativeWorkSchema = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('directions'),
    directions: z
      .array(z.object({ title: heading, premise: shortText, appeal: shortText, tradeoff: shortText }))
      .min(2)
      .max(4),
  }),
  z.object({
    ...common,
    kind: z.literal('characters'),
    characters: z
      .array(z.object({ name: heading, role: shortText, desire: shortText, obstacle: shortText, change: shortText }))
      .min(1)
      .max(6),
  }),
  z.object({
    ...common,
    kind: z.literal('outline'),
    beats: z
      .array(z.object({ title: heading, summary: shortText, choice: shortText.optional(), hook: shortText.optional() }))
      .min(1)
      .max(12),
  }),
  z.object({
    ...common,
    kind: z.literal('document'),
    sections: z
      .array(z.object({ title: heading, content: z.string().trim().min(1).max(3000) }))
      .min(1)
      .max(8),
  }),
  z.object({ ...common, kind: z.literal('excerpt'), text: z.string().trim().min(1).max(8000) }),
]);

const displaySchema = z.object({ work: creativeWorkSchema });

export const creativeWorkTool = createTool({
  id: 'show_creative_work',
  description:
    '把刚生成的实际创作成果及时展示在对话里。按内容选择 directions 方案对比、characters 人物、outline 故事情节序列、excerpt 试写片段、document 其他文档的分节摘要（如世界观、受众、创作原则或修订）；每份新创作文档与重要修订都应有实际内容展示，不能只展示其中一份。只放当前可讨论的精简成果，不放执行日志或内部资料。无需用户决定时展示后可继续；需要反馈时改用 ask_user.preview 携带同一结构并等待回答，不重复展示两遍。展示不等于用户确认，也不替代文件保存。',
  inputSchema: displaySchema,
  outputSchema: displaySchema,
  execute: async input => input,
});
