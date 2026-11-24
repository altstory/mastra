import type { MemoryConfigInternal } from '@mastra/core/memory';

/** Load the full transcript so ContextCompaction owns the provider's history budget. */
export const CONTEXT_MEMORY_OPTIONS = {
  lastMessages: Number.MAX_SAFE_INTEGER,
  observationalMemory: false,
} satisfies Pick<MemoryConfigInternal, 'lastMessages' | 'observationalMemory'>;

export const CREATOR_MEMORY_OPTIONS = {
  ...CONTEXT_MEMORY_OPTIONS,
  semanticRecall: { scope: 'thread', topK: 4, messageRange: { before: 1, after: 1 } },
  workingMemory: {
    enabled: true,
    scope: 'thread',
    template: '# 作者偏好\n\n# 当前作品\n\n# 人物与世界观\n\n# 已确认的约束\n\n# 创作进度\n',
  },
} satisfies MemoryConfigInternal;
