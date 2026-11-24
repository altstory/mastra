import type { MemoryConfigInternal } from '@mastra/core/memory';
import { SESSION_MEMORY_TEMPLATE } from './agents/creative-memory-policy';

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
    template: SESSION_MEMORY_TEMPLATE,
  },
} satisfies MemoryConfigInternal;
