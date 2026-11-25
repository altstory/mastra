import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v4';

const shortText = z.string().trim().min(1).max(500);
const heading = z.string().trim().min(1).max(100);
const common = { title: heading, summary: shortText.optional() };

export const creativeWorkSchema = z
  .discriminatedUnion('kind', [
    z.object({
      ...common,
      kind: z.literal('directions'),
      directions: z
        .array(
          z.object({
            title: heading.describe(
              '方案名称。保留已有编号。摘要或提问用 A、B 等编号指代方案时，在对应标题开头写同一个编号',
            ),
            premise: shortText,
            appeal: shortText,
            tradeoff: shortText,
          }),
        )
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
      relationships: z
        .array(z.object({ from: heading, to: heading, label: heading, tension: shortText }))
        .max(12)
        .optional()
        .describe('from/to 使用人物的精确 name；label 是关系，tension 是具体矛盾'),
    }),
    z.object({
      ...common,
      kind: z.literal('outline'),
      beats: z
        .array(
          z.object({
            title: heading,
            summary: shortText,
            choice: shortText.optional(),
            hook: shortText.optional(),
            emotion: heading.optional(),
            details: z.string().trim().min(1).max(3000).optional(),
          }),
        )
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
    z
      .object({
        ...common,
        kind: z.literal('script'),
        start: heading,
        scenes: z
          .array(
            z.object({
              id: heading,
              title: heading,
              blocks: z
                .array(
                  z.discriminatedUnion('type', [
                    z.object({ type: z.literal('action'), text: shortText }),
                    z.object({ type: z.literal('dialogue'), speaker: heading, text: shortText }),
                  ]),
                )
                .min(1)
                .max(20),
              choices: z
                .array(z.object({ label: heading, to: heading, consequence: shortText.optional() }))
                .min(1)
                .max(4)
                .optional(),
              ending: shortText.optional(),
            }),
          )
          .min(2)
          .max(20),
      })
      .describe(
        '可试玩的无状态短样段：从 start 出发，每个场景以 choices 或 ending 收束；不能用它冒充支持状态变量的完整剧本运行器',
      ),
    z.object({
      ...common,
      kind: z.literal('revision'),
      before: z.string().max(12000),
      after: z.string().max(12000),
      reason: shortText,
    }),
    z.object({ ...common, kind: z.literal('excerpt'), text: z.string().trim().min(1).max(8000) }),
  ])
  .superRefine((work, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (work.kind === 'characters') {
      const names = new Set(work.characters.map(person => person.name));
      if (names.size !== work.characters.length) issue(['characters'], 'Character names must be unique');
      work.relationships?.forEach((relation, i) => {
        if (!names.has(relation.from) || !names.has(relation.to) || relation.from === relation.to)
          issue(['relationships', i], 'Relationships must connect two existing, different characters');
      });
    }
    if (work.kind === 'revision' && !work.before.trim() && !work.after.trim())
      issue(['after'], 'Provide content to compare');
    if (work.kind !== 'script') return;
    const scenes = new Map(work.scenes.map(scene => [scene.id, scene]));
    if (scenes.size !== work.scenes.length) issue(['scenes'], 'Scene IDs must be unique');
    if (!scenes.has(work.start)) issue(['start'], 'Start must reference an existing scene');
    work.scenes.forEach((scene, i) => {
      if (Boolean(scene.choices?.length) === Boolean(scene.ending))
        issue(['scenes', i], 'Use either choices or an ending');
      scene.choices?.forEach((choice, j) => {
        if (!scenes.has(choice.to)) issue(['scenes', i, 'choices', j, 'to'], 'Choice target does not exist');
      });
      if (new Set(scene.choices?.map(choice => choice.label)).size !== (scene.choices?.length ?? 0))
        issue(['scenes', i, 'choices'], 'Choice labels must be distinct');
    });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        issue(['scenes'], 'Playable excerpts must not contain cycles');
        return;
      }
      if (visited.has(id) || !scenes.has(id)) return;
      visited.add(id);
      visiting.add(id);
      scenes.get(id)?.choices?.forEach(choice => visit(choice.to));
      visiting.delete(id);
    };
    visit(work.start);
    if (visited.size !== scenes.size) issue(['scenes'], 'All scenes must be reachable from start');
  });

const displaySchema = z.object({ work: creativeWorkSchema });

export const creativeWorkTool = createTool({
  id: 'show_creative_work',
  description:
    '把刚生成的实际创作成果及时展示在对话里。按内容选择 directions 方案对比、characters 人物及 relationships 关系图、outline 可展开的情节时间轴（emotion 与 details）、script 可试玩的无状态分支样段、revision 修改前后对照（真实 before/after 与 reason）、excerpt 普通试写片段、document 其他文档的分节摘要（如世界观、受众、创作原则或修订）；每份新创作文档与重要修订都应有实际内容展示，不能只展示其中一份。只放当前可讨论的精简成果，不放执行日志或内部资料。无需用户决定时展示后可继续；需要反馈时改用 ask_user.preview 携带同一结构并等待回答，不重复展示两遍。展示不等于用户确认，也不替代文件保存。',
  inputSchema: displaySchema,
  outputSchema: displaySchema,
  execute: async input => input,
});
