import { askUserTool, createTool } from '@mastra/core/tools';
import { z } from 'zod/v4';

import { creativeWorkSchema } from './creative-work';

const questionSchema = z.object({
  preview: creativeWorkSchema
    .optional()
    .describe('需要用户评价新生成内容时，附上实际方案、人物、大纲或试写片段，让用户看着成果作决定'),
  question: z.string().trim().min(1).max(1000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).optional(),
        recommended: z.boolean().optional(),
      }),
    )
    .min(2)
    .max(4)
    .optional(),
  selectionMode: z.enum(['single_select', 'multi_select']).optional(),
  title: z.string().trim().min(1).max(60).optional().describe('简短的创作主题，如「悬念方向」；不填步骤编号或技能名称'),
  context: z.string().trim().min(1).max(400).optional().describe('一句话说明已有信息和这个决定会影响什么，不重复问题'),
});

export const creatorQuestionTool = createTool({
  id: 'ask_user',
  description:
    '向用户提出当前最重要的一个创作问题并等待回答。创作过程中需要反馈时，用 preview 展示刚生成的具体成果，再问影响后续创作的取舍；不要只在开头提问。先复用已有答案，只问影响当前任务的决定。用 title 和 context 说明主题和取舍。提供 2 到 4 个选项，description 说明各自影响，有依据时标一个 recommended；界面自带自由输入，不添加「其他」选项。每次只调用一次，收到回答再决定下一题；用户要跳过就继续，不问满固定题数。',
  inputSchema: questionSchema.superRefine((input, ctx) => {
    if (input.selectionMode && !input.options)
      ctx.addIssue({ code: 'custom', path: ['selectionMode'], message: 'Selection mode requires options' });
    if ((input.options?.filter(option => option.recommended).length ?? 0) > 1)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Recommend at most one option' });
  }),
  suspendSchema: questionSchema,
  resumeSchema: askUserTool.resumeSchema,
  execute: async (input, context) => {
    const { title, context: reason, preview, ...question } = input;
    const suspend = context?.agent?.suspend;
    const result = await askUserTool.execute!(question, {
      ...context,
      ...(context?.agent && {
        agent: {
          ...context.agent,
          ...(suspend && {
            suspend: (payload, options) => suspend({ ...payload, title, context: reason, preview }, options),
          }),
        },
      }),
    });
    const response = z.object({ content: z.string(), isError: z.boolean() }).safeParse(result);
    if (response.success && !response.data.isError && context?.agent?.resumeData !== undefined) {
      return { ...response.data, ...input, answer: context.agent.resumeData };
    }
    return result;
  },
});
