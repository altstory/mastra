import { MASTRA_NORMALIZED_USER_KEY } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { LedgerEntry } from '../services/story-ledger';
import { checkAgainstLedger } from '../tools/ledger-check';
import { analyzeScript, stateVariableSchema } from '../tools/script-analysis';
import { validateScriptFormat } from '../tools/validate-script-format';

export const REVIEW_DIMENSIONS = [
  {
    id: 'route',
    title: '路线承接与状态',
    focus:
      '角色是否使用了本路线尚未展示或获知的线索；合流场景是否用到只在某条分支建立的事实；对白、效果说明和状态标签是否一致。',
  },
  {
    id: 'consistency',
    title: '一致性',
    focus: '角色行为、世界规则和时间线是否前后一致；动机是否合理；因果是否成立；结果是否先于依赖它的不可逆行动。',
  },
  {
    id: 'payoff',
    title: '跨集推进与终局兑现',
    focus:
      '已确认的发现是否被当作新发现重复；每条通向某结局的路线是否在正文里演出了关键行动或结果，而不是复述目标或用悬念顶替。',
  },
  {
    id: 'style',
    title: '文笔与核心体验',
    focus: '是否出现「不是A，而是B」「眼中闪过一丝」之类的套话；台词是否有潜台词和人物辨识度；核心体验是否被传达。',
  },
  {
    id: 'principles',
    title: '创作原则对照',
    focus:
      '逐条核对给出的创作原则：每条原则判断剧本是否遵守，违反的指出场景编号和原文，并说明违反了哪一条。只依据给出的原则判断，不自己补充原则。',
  },
] as const;

export const reviewIssueSchema = z.object({
  severity: z.enum(['error', 'warn']),
  location: z.string(),
  problem: z.string(),
  suggestion: z.string(),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;

export type ReviewFunction = (input: {
  dimension: (typeof REVIEW_DIMENSIONS)[number];
  script: string;
  coreExperience?: string;
  principles?: string[];
}) => Promise<ReviewIssue[]>;

const inputSchema = z.object({
  script: z.string().min(1).describe('剧本全文，使用 X-Y 场景编号格式'),
  coreExperience: z.string().optional().describe('项目的核心体验，用于判断体验是否被传达'),
  project: z.string().optional().describe('项目名；提供后会对照该项目的设定与伏笔台账做检查'),
  variables: z
    .array(stateVariableSchema)
    .max(100)
    .optional()
    .describe('状态变量清单，来自《互动设计文档》；提供后会检查剧本里的变量是否已定义'),
  principles: z
    .array(z.string().trim().min(1).max(300))
    .max(10)
    .optional()
    .describe('创作原则，来自《需求确认》；提供后会逐条对照剧本'),
});

const structureSchema = inputSchema.extend({
  valid: z.boolean(),
  formatIssues: z.array(z.object({ rule: z.string(), message: z.string(), lineNumber: z.number() })),
  ledgerStatus: z.enum(['skipped', 'empty', 'checked']),
  ledgerIssues: z.array(z.object({ severity: z.enum(['error', 'warn']), rule: z.string(), message: z.string() })),
  graphIssues: z.array(
    z.object({
      severity: z.enum(['error', 'warn']),
      rule: z.string(),
      message: z.string(),
      scenes: z.array(z.string()),
    }),
  ),
  stats: z.object({
    episodes: z.number(),
    scenes: z.number(),
    interactions: z.number(),
    options: z.number(),
    endings: z.number(),
    pathCount: z.number(),
    minPathScenes: z.number(),
    maxPathScenes: z.number(),
  }),
});

const reviewSchema = z.object({
  dimension: z.string(),
  title: z.string(),
  issues: z.array(reviewIssueSchema),
  skipped: z.boolean().optional(),
});

const reportSchema = z.object({
  passed: z.boolean(),
  errors: z.number(),
  warnings: z.number(),
  report: z.string(),
});

export interface LedgerReader {
  read(owner: string, project: string): Promise<LedgerEntry[]>;
}

const createStructureStep = (ledger?: LedgerReader) =>
  createStep({
    id: 'structure-check',
    description: '校验剧本格式，并分析场景图：孤立场景、死路、虚假自由、选项过多、路径膨胀与失衡。',
    inputSchema,
    outputSchema: structureSchema,
    execute: async ({ inputData, requestContext }) => {
      const format = validateScriptFormat(inputData.script);
      const graph = analyzeScript(inputData.script, inputData.variables);
      const user = requestContext?.getRaw(MASTRA_NORMALIZED_USER_KEY);
      const userId =
        user && typeof user === 'object' && 'id' in user && typeof user.id === 'string' ? user.id : undefined;
      const entries = inputData.project && ledger && userId ? await ledger.read(userId, inputData.project) : undefined;
      return {
        ...inputData,
        ledgerStatus: !entries ? ('skipped' as const) : entries.length ? ('checked' as const) : ('empty' as const),
        ledgerIssues: entries?.length ? checkAgainstLedger(inputData.script, entries) : [],
        valid: format.valid,
        formatIssues: format.issues,
        graphIssues: graph.issues,
        stats: {
          episodes: format.stats.episodes,
          scenes: format.stats.scenes,
          interactions: format.stats.interactions,
          options: format.stats.options,
          endings: graph.stats.endings,
          pathCount: graph.stats.pathCount,
          minPathScenes: graph.stats.minPathScenes,
          maxPathScenes: graph.stats.maxPathScenes,
        },
      };
    },
  });

export function createScriptQaWorkflow(review: ReviewFunction, ledger?: LedgerReader) {
  const reviewSteps = REVIEW_DIMENSIONS.map(dimension =>
    createStep({
      id: `review-${dimension.id}`,
      description: `模型审查：${dimension.title}。`,
      inputSchema: structureSchema,
      outputSchema: reviewSchema,
      execute: async ({ inputData }) => {
        const principles = inputData.principles?.filter(Boolean);
        if (dimension.id === 'principles' && !principles?.length)
          return { dimension: dimension.id, title: dimension.title, issues: [], skipped: true };
        return {
          dimension: dimension.id,
          title: dimension.title,
          issues: await review({
            dimension,
            script: inputData.script,
            coreExperience: inputData.coreExperience,
            principles,
          }),
        };
      },
    }),
  );

  const compose = createStep({
    id: 'compose-report',
    description: '汇总结构检查和模型审查，提供 project 时对照设定与伏笔台账（未回收的伏笔、已死亡角色再出场），生成《质量检查报告》。',
    inputSchema: z.record(z.string(), reviewSchema),
    outputSchema: reportSchema,
    execute: async ({ inputData, getStepResultAsync }) => {
      const checked = await getStepResultAsync<z.infer<typeof structureSchema>>('structure-check');
      const reviews = REVIEW_DIMENSIONS.map(dimension => inputData[`review-${dimension.id}`]).filter(Boolean);
      const structural = [
        ...checked.formatIssues.map(issue => ({
          severity: 'error' as const,
          text: `[${issue.rule}] ${issue.message}${issue.lineNumber > 0 ? `（第 ${issue.lineNumber} 行）` : ''}`,
        })),
        ...checked.graphIssues.map(issue => ({ severity: issue.severity, text: `[${issue.rule}] ${issue.message}` })),
        ...checked.ledgerIssues.map(issue => ({ severity: issue.severity, text: `[${issue.rule}] ${issue.message}` })),
      ];
      const reviewed = reviews.flatMap(item => item.issues.map(issue => ({ ...issue, title: item.title })));
      const errors =
        structural.filter(item => item.severity === 'error').length +
        reviewed.filter(item => item.severity === 'error').length;
      const warnings =
        structural.filter(item => item.severity === 'warn').length +
        reviewed.filter(item => item.severity === 'warn').length;
      const lines = [
        '# 质量检查报告',
        '',
        `共 ${checked.stats.episodes} 集、${checked.stats.scenes} 个场景、${checked.stats.interactions} 个互动、${checked.stats.endings} 个结局；约 ${checked.stats.pathCount} 条路径，长度 ${checked.stats.minPathScenes} 到 ${checked.stats.maxPathScenes} 个场景。`,
        `结论：${errors === 0 ? (warnings === 0 ? '通过' : '通过，有提醒') : '未通过'}（${errors} 个错误，${warnings} 个提醒）。`,
        '',
        '## 结构检查',
        ...(structural.length
          ? structural.map(item => `- ${item.severity === 'error' ? '错误' : '提醒'} ${item.text}`)
          : ['- 未发现问题。']),
      ];
      if (checked.ledgerStatus === 'empty') lines.push('- 该项目的台账还是空的，没有做台账检查。');
      if (checked.ledgerStatus === 'checked' && !checked.ledgerIssues.length) lines.push('- 台账检查：未发现问题。');
      for (const item of reviews) {
        lines.push('', `## 模型审查：${item.title}`);
        lines.push(
          ...(item.issues.length
            ? item.issues.map(
                issue =>
                  `- ${issue.severity === 'error' ? '错误' : '提醒'} ${issue.location}：${issue.problem} 建议：${issue.suggestion}`,
              )
            : [item.skipped ? '- 未提供创作原则，已跳过。' : '- 未发现问题。']),
        );
      }
      return { passed: errors === 0, errors, warnings, report: lines.join('\n') };
    },
  });

  return createWorkflow({
    id: 'script-qa',
    description:
      '互动剧本质量检查：格式与场景图分析，加四项模型审查（路线承接、一致性、终局兑现、文笔与核心体验），提供 project 时对照设定与伏笔台账（未回收的伏笔、已死亡角色再出场），生成《质量检查报告》。',
    inputSchema,
    outputSchema: reportSchema,
  })
    .then(createStructureStep(ledger))
    .parallel(reviewSteps as [(typeof reviewSteps)[number], ...(typeof reviewSteps)[number][]])
    .then(compose)
    .commit();
}
