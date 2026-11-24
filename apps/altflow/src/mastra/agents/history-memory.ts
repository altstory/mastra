import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import type { MemoryConfigInternal } from '@mastra/core/memory';
import { Memory } from '@mastra/memory';
import { mayReadReferences, projectConversation } from './reference-visibility';

function redactMessages<T extends { messages: MastraDBMessage[] }>(result: T): T {
  return { ...result, messages: projectConversation(result.messages) as MastraDBMessage[] };
}

/** Expose native history browsing without re-enabling observation-based context compaction. */
export class HistoryMemory extends Memory {
  override listTools(config?: MemoryConfigInternal) {
    const tools = super.listTools(config);
    if (config?.lastMessages === false) return tools;
    const browsing = super.listTools({ ...config, observationalMemory: { retrieval: { scope: 'resource' } } });
    const recall = browsing.recall;
    if (recall?.execute) {
      const execute = recall.execute;
      recall.execute = (input, context) => {
        if (!context || mayReadReferences(context.requestContext)) return execute(input, context);
        const memory = {
          getThreadById: this.getThreadById.bind(this),
          listThreads: this.listThreads.bind(this),
          recall: async (args: Parameters<Memory['recall']>[0]) => redactMessages(await this.recall(args)),
          getMemoryStore: async () => {
            const store = await this.getMemoryStore();
            return {
              listMessagesById: async (args: Parameters<typeof store.listMessagesById>[0]) =>
                redactMessages(await store.listMessagesById(args)),
            };
          },
        };
        const projectedContext = { ...context, memory };
        return execute(input, projectedContext);
      };
      tools.recall = recall;
    }
    return tools;
  }
}
