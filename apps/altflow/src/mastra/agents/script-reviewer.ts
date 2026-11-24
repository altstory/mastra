import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { REVIEW_DIMENSIONS, reviewIssueSchema } from '../workflows/script-qa';
import type { ReviewFunction } from '../workflows/script-qa';

const MAX_SCRIPT_CHARACTERS = 80_000;

const instructions = `你是互动剧本审查员。只依据给出的剧本判断，指出真实存在的问题，不编造，不重复结构检查已经覆盖的格式问题。
每个问题给出：位置（场景编号，如 1-2-A）、问题、修改建议。严重程度：会让故事无法成立的矛盾为 error，其余为 warn。
没有问题就返回空列表。用中文回答。`;

export function createScriptReviewer(model: ConstructorParameters<typeof Agent>[0]['model']) {
  const agent = new Agent({ id: 'script-reviewer', name: '剧本审查员', instructions, model });
  const review: ReviewFunction = async ({ dimension, script, coreExperience }) => {
    const truncated = script.length > MAX_SCRIPT_CHARACTERS;
    const prompt = [
      `审查维度：${dimension.title}`,
      `关注点：${dimension.focus}`,
      coreExperience ? `核心体验：${coreExperience}` : '',
      truncated ? `（剧本过长，只提供前 ${MAX_SCRIPT_CHARACTERS} 个字符。）` : '',
      '剧本：',
      script.slice(0, MAX_SCRIPT_CHARACTERS),
    ]
      .filter(Boolean)
      .join('\n\n');
    const result = await agent.generate(prompt, {
      structuredOutput: { schema: z.object({ issues: z.array(reviewIssueSchema) }) },
      modelSettings: { temperature: 0 },
    });
    return result.object?.issues ?? [];
  };
  return { agent, review, dimensions: REVIEW_DIMENSIONS };
}
