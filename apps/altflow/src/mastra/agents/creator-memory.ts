import { parseMemoryRequestContext } from '@mastra/core/memory';
import { CREATIVE_MEMORY_POLICY } from './creative-memory-policy';
import { HistoryMemory } from './history-memory';

export class CreatorMemory extends HistoryMemory {
  override async getInputProcessors(...args: Parameters<HistoryMemory['getInputProcessors']>) {
    const processors = await super.getInputProcessors(...args);
    return processors.map(processor =>
      processor.id !== 'working-memory'
        ? processor
        : {
            id: 'working-memory',
            processInput: async (input: Parameters<NonNullable<typeof processor.processInput>>[0]) => {
              const context = parseMemoryRequestContext(input.requestContext);
              if (!context?.thread?.id) return input.messageList;
              const instruction = await this.getSystemMessage({
                threadId: context.thread.id,
                resourceId: context.resourceId,
                memoryConfig: context.memoryConfig,
                runState: context.runState?.(),
              });
              if (instruction) input.messageList.addSystem(instruction, 'memory');
              return input.messageList;
            },
          },
    );
  }

  protected override getWorkingMemoryToolInstruction({
    template,
    data,
  }: Parameters<HistoryMemory['getWorkingMemoryToolInstruction']>[0]) {
    return `${CREATIVE_MEMORY_POLICY}
当前会话工作状态：
${data || template.content}
仅在当前会话状态变化时调用 updateWorkingMemory，memory 参数传入完整 Markdown 字符串。
不要在这里复制作者长期偏好或其他项目记忆；用户未确认的内容必须放在候选、假设或待决定部分。
旧格式笔记视为当前会话背景，不能视为已确认的长期事实。`;
  }
}
